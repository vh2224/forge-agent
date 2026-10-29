#!/usr/bin/env node
'use strict';

// Hermetic provider fixtures only. No account store, real provider, user prefs,
// installation or WDMA path is read by this suite.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
function stageProcedures(destination) {
  const source = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
  fs.mkdirSync(path.join(destination, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(source, 'shared/forge-procedures.json'), path.join(destination, 'shared/forge-procedures.json'));
  for (const module of manifest.modules.filter(item => item.status === 'ready')) fs.copyFileSync(path.join(source, module.path), path.join(destination, module.path));
}

const crypto = require('crypto');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-task-preparation-')));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
const isolatedHome = path.join(root, 'home');
fs.mkdirSync(isolatedHome);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const prep = require('./forge-task-preparation');
const unit = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const { resolveDispatch } = require('./forge-dispatch-resolve');
let sequence = 0;
let passed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    process.stdout.write(`ok - ${name}\n`);
  }, error => {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

function fixture(options = {}) {
  const caseRoot = path.join(root, `case-${++sequence}`);
  const cwd = path.join(caseRoot, 'code');
  const contextRoot = path.join(caseRoot, 'owner');
  const results = path.join(caseRoot, 'results');
  fs.mkdirSync(cwd, { recursive: true });
  stageProcedures(cwd);
  const fixtureCommand = require('./forge-code-roots.test').command;
  fixtureCommand('git', ['init', '-q'], cwd);
  fixtureCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
  fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true });
  fs.mkdirSync(results, { recursive: true });
  const model = options.model || 'claude-sonnet-5';
  const effort = options.effort || 'medium';
  fs.writeFileSync(path.join(contextRoot, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: {
      'plan-slice': effort, 'discuss-milestone': effort,
      'research-milestone': effort, 'plan-milestone': effort,
    },
  }));
  const taskId = options.taskId || `T-20260928${String(sequence).padStart(6, '0')}-fixture`;
  return { schema_version: 1, scope: 'standalone-task', phase: options.phase || 'brainstorm',
    taskId, cwd, contextRoot, hostRuntime: options.hostRuntime || 'codex',
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}`,
    resultFile: path.join(results, `result-${sequence}.json`),
    constraints: { auto_commit: false, deploy: false },
    inputs: { brief: `Fixture ${sequence}` },
  };
}

function artifactPath(request) {
  return path.join(request.contextRoot, prep.requiredArtifact(request).replace(/\//g, path.sep));
}

function content(phase, taskId) {
  if (phase === 'brainstorm') return '# Brainstorm\n\n## Recommended Approach\n\nUse one caller.\n\n## Alternatives Considered\n\nKeep resolver.\n\n## Top Risks\n\nRoute drift.\n\n## Out of Scope\n\nReal providers.\n';
  if (phase === 'discuss') return '# Context\n\n## Decisions\n\nUse receipts.\n\n## Open Questions\n\nNone.\n\n## Out of Scope\n\nInstall.\n';
  if (phase === 'research') return "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
  return `---\ntier: standard\neffort: medium\ndepends: []\nexpected_output: [scripts/x.js]\nmust_haves:\n  truths: [Observable output]\n  artifacts: []\n  key_links: []\nwrites:\n  - scripts/x.js\n---\n\n# Plan\n\n## Steps\n\n1. Implement.\n\n## Must-Haves\n\n- The command passes.\n\n## Standards\n\n- Reuse existing helpers.\n\n## Files to Change\n\n- scripts/x.js — implementation.\n`;
}

function envelope(request, overrides = {}) {
  return { status: 'done', summary: `${request.phase} complete`, questions: [],
    artifacts: [{ path: prep.requiredArtifact(request), content: content(request.phase, request.taskId) }],
    ...overrides };
}

function framed(value, status = value.status) {
  return `---GSD-WORKER-RESULT---\nstatus: ${status}\nresult_json: ${JSON.stringify(value)}\n---END-RESULT---`;
}

function codexCapabilities() {
  return { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
    models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] };
}

async function main() {
  await test('invalid plan diagnostics survive actual native acceptance, receipt and replay for object and framed results', async () => {
    for (const asText of [false, true]) {
      const request = fixture({ phase: 'plan', model: 'gpt-5.6-sol' });
      request.activeCapabilities = codexCapabilities();
      const started = await prep.startStandaloneTaskPreparation(request);
      assert.equal(started.action, 'invoke-native');
      const value = envelope(request);
      value.artifacts[0].content = value.artifacts[0].content.replace('tier: standard', 'tier: private-sentinel');
      const result = await prep.acceptStandaloneTaskPreparation(request, { route: started.route,
        rawResult: asText ? framed(value) : value, invocationTelemetry: started.invocation.telemetry,
        providerCalled: true });
      assert.equal(result.ok, false);
      assert.equal(result.diagnostic.reason, 'typed-standalone-preparation-tier');
      assert.equal(result.diagnostic.stage, 'validation');
      const receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json', 'utf8'));
      assert.equal(receipt.phase, 'failed');
      assert.equal(receipt.failure.diagnostic.reason, 'typed-standalone-preparation-tier');
      assert(!fs.existsSync(artifactPath(request)));
      assert(!JSON.stringify([result, receipt]).includes('private-sentinel'));
      const replay = await prep.startStandaloneTaskPreparation(request, {
        resolveDispatch() { throw Error('failed replay must not resolve'); },
        invokeNative() { throw Error('failed replay must not invoke'); },
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.original_diagnostic.reason, 'typed-standalone-preparation-tier');
    }
  });
  await test('external native bridge observes ack until terminal without early artifact publication', async () => {
    const request = fixture({ model: 'gpt-5.6-sol' }); request.activeCapabilities = codexCapabilities();
    let emit, identity, ready; const subscribed = new Promise(resolve => { ready = resolve; });
    const nativeLifecycle = { adapter: { capabilities: { result: true }, acknowledge: value => value?.agent_id,
      subscribe(handle, callback, context) { assert.equal(handle, 'worker'); emit = callback; identity = context.identity;
        ready(); return () => {}; } } };
    const handoff = await prep.startStandaloneTaskPreparation(request, { nativeLifecycle });
    assert.equal(typeof handoff.invoke, 'function');
    const pending = handoff.invoke(async () => ({ agent_id: 'worker' }));
    await Promise.race([subscribed, pending.then(value => { throw Error('bridge returned before subscription: ' + JSON.stringify(value)); })]);
    assert(!fs.existsSync(artifactPath(request)), 'ack cannot publish an artifact');
    emit({ identity, sequence: 1, kind: 'terminal', result: envelope(request) });
    const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
    assert(fs.existsSync(artifactPath(request)));
  });
  await test('deferred native handoff ignores route mutation made after preparation', async () => {
    const request = fixture({ model: 'gpt-5.6-sol' });
    // Both models are admitted, so a mutated route would be dispatchable if it leaked.
    request.activeCapabilities = { ...codexCapabilities(), models: ['gpt-5.6-sol', 'gpt-5.6-other'] };
    const handoff = await prep.startStandaloneTaskPreparation(request, {});
    assert.equal(typeof handoff.invoke, 'function');
    const original = { model: handoff.route.model, resolved: handoff.route.model_resolved };
    assert.equal(original.resolved, 'gpt-5.6-sol');
    handoff.route.model_resolved = 'gpt-5.6-other'; handoff.route.model = 'gpt-5.6-other';
    if (handoff.request) handoff.request.model = 'gpt-5.6-other';
    const calls = [];
    const result = await handoff.invoke(async (...args) => { calls.push(args);
      return framed(envelope(request)); });
    assert.equal(calls.length, 1, 'exactly one provider callback with the original route');
    const seen = JSON.stringify(calls[0]);
    assert(!seen.includes('gpt-5.6-other'), 'mutated model must not be dispatched');
    assert.equal(calls[0][0].model, 'gpt-5.6-sol');
    assert.equal(calls[0][0].reasoning_effort, 'medium');
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  await test('mandatory preparation procedures fail closed before either transport', async () => {
    for (const failure of ['pending', 'missing', 'hash']) {
      const request = fixture({ model: 'gpt-5.6-sol' });
      request.activeCapabilities = codexCapabilities();
      const manifestPath = path.join(request.cwd, 'shared/forge-procedures.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath));
      const module = manifest.modules.find(item => item.id === 'task-preparation');
      if (failure === 'pending') { module.status = 'pending'; fs.writeFileSync(manifestPath, JSON.stringify(manifest)); }
      if (failure === 'missing') fs.unlinkSync(path.join(request.cwd, module.path));
      if (failure === 'hash') fs.appendFileSync(path.join(request.cwd, module.path), '\nchanged');
      let calls = 0;
      const result = await prep.prepareStandaloneTask(request, {
        invokeNative: async () => { calls++; throw Error('must not invoke'); },
        invokeSidecar: async () => { calls++; throw Error('must not invoke'); },
      });
      assert.equal(result.ok, false, failure);
      assert.equal(result.provider_called, false, failure);
      assert.match(result.reason_code, /^procedure-/);
      assert.equal(calls, 0);
      assert(!fs.existsSync(artifactPath(request)));
    }
  });
  await test('caller repair compares equivalent requests and measures final native arguments before reserving', async () => {
    const request = fixture({ model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    request.prompt = 'before repair';
    const failed = await prep.prepareStandaloneTask(request, { invokeNative: async () => {
      throw Object.assign(Error('fixture caller error'), { code: 'context-budget-exceeded', provider_called: false });
    } });
    assert.equal(failed.ok, false);
    const recovery = { receiptFile: request.resultFile + '.receipt.json', stateFile: request.resultFile + '.recovery.json', correction: true };
    let calls = 0;
    const deps = { processProbe: () => 'stopped', invokeNative: async () => { calls++; return framed(envelope(request)); } };
    await assert.rejects(() => prep.recoverStandaloneTask(Object.fromEntries(Object.entries(request).reverse()), recovery, deps), /correction-required/);
    request.prompt = 'after offline repair';
    const recovered = await prep.recoverStandaloneTask(request, recovery, deps);
    assert.equal(recovered.corrected, true);
    assert.equal(recovered.result.status, 'done');
    assert.equal(calls, 1);
    const state = JSON.parse(fs.readFileSync(recovery.stateFile));
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].correction.evidence_reference, 'preparation-preflight:native-arguments');
  });
  await test('S03/T02 recovery wrapper passes the host identity observer to the native callback; two-argument callbacks unchanged', async () => {
    for (const arity of ['observer', 'legacy']) {
      const request = fixture({ model: 'gpt-5.6-sol' });
      request.activeCapabilities = codexCapabilities();
      const failed = await prep.prepareStandaloneTask(request, { invokeNative: async () => {
        throw Object.assign(Error('fixture caller error'), { code: 'context-budget-exceeded', provider_called: false });
      } });
      assert.equal(failed.ok, false);
      request.prompt = 'after offline repair';
      const recovery = { receiptFile: request.resultFile + '.receipt.json', stateFile: request.resultFile + '.recovery.json', correction: true };
      const seen = [];
      const invokeNative = arity === 'observer'
        ? async (args, binding, observer) => { seen.push({ args, binding, observer, recorded: observer.hostIdentity('/root/recovery_fixture') });
          return framed(envelope(request)); }
        : async (args, binding) => { seen.push({ args, binding }); return framed(envelope(request)); };
      const recovered = await prep.recoverStandaloneTask(request, recovery, { processProbe: () => 'stopped', invokeNative });
      assert.equal(recovered.corrected, true, JSON.stringify(recovered));
      assert.equal(recovered.result.status, 'done');
      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0].args), ['task_name', 'message', 'agent_type', 'model', 'reasoning_effort', 'fork_turns']);
      assert.equal(seen[0].binding.args, seen[0].args);
      if (arity === 'observer') {
        assert(Object.isFrozen(seen[0].observer));
        assert.deepEqual(Object.keys(seen[0].observer), ['hostIdentity']);
        assert.deepEqual(seen[0].recorded, { ok: true });
      }
      assert(!JSON.stringify(seen[0].args).includes('hostIdentity'), 'the observer is never a tool argument');
    }
    const source = fs.readFileSync(path.join(__dirname, 'forge-task-preparation.js'), 'utf8');
    assert(source.includes('terminalResult:'), 'release-impact literal remains');
  });
  await test('trusted caller authority survives restart and routes a timed-out standalone phase to the explicit native candidate', async () => {
    const request = fixture({ phase: 'brainstorm' });
    const prefs = path.join(request.contextRoot, '.gsd/forge-prefs.jsonc');
    fs.writeFileSync(prefs, JSON.stringify({ tier_models: {
      light: ['claude-sonnet-5', 'gpt-5.6-sol'], standard: ['claude-sonnet-5', 'gpt-5.6-sol'],
      heavy: ['claude-sonnet-5', 'gpt-5.6-sol'], max: ['claude-sonnet-5', 'gpt-5.6-sol'] }, effort: { 'plan-slice': 'medium' } }));
    const profile = path.join(path.dirname(request.cwd), 'profile');
    fs.mkdirSync(path.join(profile, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(profile, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture standing permission.\n<!-- user:forge-routing-continuity:end -->');
    let now = Date.now();
    const reference = 'conversation:caller-restart';
    const authority = require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
      received: true, answer: 'authorize', resolved_at: now }), { resolveProfile: () => profile, clock: () => now });
    const failed = await prep.prepareStandaloneTask(request, { recoveryAuthorization: { adapter: authority, reference,
      registration: { host: 'codex', section: 'user:forge-routing-continuity' } }, invokeSidecar: async () => {
      throw Object.assign(Error('fixture timeout'), { code: 'claude-timeout', provider_called: true });
    } });
    assert.equal(failed.ok, false);
    const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
    assert.equal(JSON.parse(fs.readFileSync(receiptFile)).authorization_reference, reference);
    const initial = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(initial.authorization_reference, reference);
    // v2 has no cumulative clock: recover past the former 60000 ms window (old deadline_at + 1).
    assert.equal(initial.schema_version, 2); assert.equal(initial.deadline_at, undefined);
    now = initial.started_at + 60001;
    const restarted = require('./forge-recovery-authority').createRecoveryAuthority({ resolveProfile: () => profile, clock: () => now });
    let calls = 0, optionsObserved;
    request.activeCapabilities = codexCapabilities();
    const recovered = await prep.recoverStandaloneTask(request, { receiptFile, stateFile, clock: () => now }, {
      processProbe: () => 'stopped', recoveryAuthorization: { adapter: restarted, reference },
      resolveDispatch: options => { optionsObserved = options; return resolveDispatch(options); },
      invokeNative: async args => { calls++; assert.equal(args.model, 'gpt-5.6-sol');
        assert.equal(args.reasoning_effort, 'medium'); return framed(envelope(request)); },
    });
    assert.equal(recovered.route.worker_mode, 'native');
    assert.equal(recovered.sidecar_ceiling, null, 'native candidate carries no sidecar ceiling');
    assert.equal(recovered.sidecar_remaining_ms, undefined); assert.equal(recovered.remaining_ms, undefined);
    assert.equal(recovered.result.status, 'done');
    assert.equal(calls, 1);
    assert.equal(optionsObserved.scope, 'standalone-task'); assert.equal(optionsObserved.phase, 'brainstorm');
    assert.equal(optionsObserved.unitType, 'plan-slice'); assert.equal(optionsObserved.unitId, request.taskId);
    assert.equal(optionsObserved.cwd, request.contextRoot); assert.equal(optionsObserved.workerMode, undefined);
    const savedState = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(savedState.started_at, initial.started_at); assert.equal(savedState.budget, 'tier-ceiling');
    assert.equal(savedState.deadline_at, undefined, 'recovery writes no cumulative clock');
    assert.equal(fs.readFileSync(artifactPath(request), 'utf8'), content(request.phase, request.taskId));
    fs.writeFileSync(path.join(profile, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nChanged permission.\n<!-- user:forge-routing-continuity:end -->');
    assert.throws(() => restarted.readStandingAuthorization(reference), /source-changed/);
  });
  await test('research recovery from a migrated v1 state with ~21s left on the old clock gives the sidecar the full tier ceiling', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'codex', model: 'claude-sonnet-5' });
    request.prompt = 'UNIQUE-research-recovery-instructions';
    request.dispatchId = 'p'.repeat(128);
    // Two sidecar destinations: the timed-out one and an untried one, so recovery
    // reaches a second sidecar instead of exhausting the chain.
    const prefsFile = path.join(request.contextRoot, '.gsd/forge-prefs.jsonc');
    const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    fs.writeFileSync(prefsFile, JSON.stringify({ ...prefs, tier_models: Object.fromEntries(['light', 'standard', 'heavy', 'max']
      .map(tier => [tier, ['claude-sonnet-5', 'claude-opus-5']])) }));
    const profile = path.join(path.dirname(request.cwd), 'profile');
    fs.mkdirSync(path.join(profile, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(profile, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture standing permission.\n<!-- user:forge-routing-continuity:end -->');
    let now = Date.now();
    const reference = 'conversation:research-recovery';
    const authority = require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
      received: true, answer: 'authorize', resolved_at: now }), { resolveProfile: () => profile, clock: () => now });
    const failed = await prep.prepareStandaloneTask(request, { recoveryAuthorization: { adapter: authority, reference,
      registration: { host: 'codex', section: 'user:forge-routing-continuity' } }, invokeSidecar: async () => {
      throw Object.assign(Error('fixture timeout'), { code: 'claude-timeout', provider_called: true });
    } });
    assert.equal(failed.ok, false);
    const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
    // Rewrite the recorded state as a legacy v1 file whose old cumulative clock
    // would leave ~21000 ms (started 39 s ago, deadline_at = started_at + 60000).
    const { budget, ...current } = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(budget, 'tier-ceiling');
    const legacyStarted = now - 39000;
    fs.writeFileSync(stateFile, JSON.stringify({ ...current, schema_version: 1, started_at: legacyStarted, deadline_at: legacyStarted + 60000 }));
    const restarted = require('./forge-recovery-authority').createRecoveryAuthority({ resolveProfile: () => profile, clock: () => now });
    const { ceilingFromRoute, resolveWorkerCeiling } = require('./forge-worker-timeout');
    let resolved, delivered = 0, handed;
    const recovered = await prep.recoverStandaloneTask(request, { receiptFile, stateFile, clock: () => now }, {
      processProbe: () => 'stopped', recoveryAuthorization: { adapter: restarted, reference },
      resolveDispatch: options => (resolved = resolveDispatch(options)),
      invokeSidecar: async delivery => { delivered++; handed = delivery.route; assert(delivery.dispatchId.length <= 128); assert.notEqual(delivery.dispatchId, request.dispatchId); return envelope(request); },
    });
    assert.equal(recovered.route.worker_mode, 'sidecar', JSON.stringify(recovered));
    assert.equal(recovered.state_migration && recovered.state_migration.from, 1);
    assert.equal(recovered.result.status, 'done', JSON.stringify(recovered.result));
    assert.equal(delivered, 1, 'recovery is not stopped by the old clock');
    const tierCeiling = resolveWorkerCeiling({ tier: resolved.tier }).seconds;
    assert.equal(handed.workers_timeout, tierCeiling);
    assert.equal(handed.workers_timeout, ceilingFromRoute(resolved).seconds);
    assert.equal(handed.workers_timeout_source, ceilingFromRoute(resolved).source);
    assert(handed.workers_timeout >= 1800, `tier ceiling, never the ~21 s remainder: ${handed.workers_timeout}`);
    assert.deepEqual(recovered.sidecar_ceiling && recovered.sidecar_ceiling.seconds, tierCeiling);
    const saved = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(saved.schema_version, 2); assert.equal(saved.budget, 'tier-ceiling');
    assert.equal(saved.migrated_from.schema_version, 1);
    assert.equal(saved.started_at, legacyStarted); assert.equal(saved.deadline_at, legacyStarted + 60000, 'inert historical deadline_at preserved');
  });
  // S05/T06: a standalone plan preparation stopped at the tier ceiling with a
  // live stream resumes its own session once, on the same route and full ceiling.
  async function activeBudgetPreparation(phase, withRef) {
    const request = fixture({ phase, hostRuntime: 'codex', model: 'claude-sonnet-5' });
    const failed = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => {
      throw Object.assign(Error('fixture ceiling'), { code: 'budget-exceeded-while-active', provider_called: true });
    } });
    assert.equal(failed.ok, false);
    const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
    const sessions = require('./forge-claude-session');
    const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null,
      configDir: path.join(path.dirname(request.cwd), 'lab-claude'), cwd: request.cwd });
    // The production core records the ref from error.session; the injected
    // transport cannot, so the saved attempt is completed with the same shape.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const last = state.attempts.at(-1);
    assert.equal(last.failure_class, 'active-budget');
    last.session = withRef ? JSON.parse(JSON.stringify(ref)) : null;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return { request, receiptFile, stateFile, ref, route: last.route };
  }
  await test('standalone plan recovery after active-budget hands the transport claudeResume and the tier ceiling of the previous route', async () => {
    const { request, receiptFile, stateFile, ref, route } = await activeBudgetPreparation('plan', true);
    const receiptSha = crypto.createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex');
    const { ceilingFromRoute } = require('./forge-worker-timeout');
    let resolverCalls = 0, delivered = 0, handed;
    const recovered = await prep.recoverStandaloneTask(request, { receiptFile, stateFile }, {
      processProbe: () => 'stopped',
      resolveDispatch: () => { resolverCalls++; throw new Error('the resume never re-resolves a candidate'); },
      invokeSidecar: async delivery => { delivered++; handed = delivery; return envelope(request); },
    });
    assert.equal(recovered.result && recovered.result.status, 'done', JSON.stringify(recovered));
    assert.equal(delivered, 1);
    assert.equal(resolverCalls, 0);
    assert.deepEqual(handed.claudeResume, JSON.parse(JSON.stringify(ref)));
    assert.equal(handed.resumedFrom.receipt_sha256, receiptSha);
    assert.equal(handed.resumedFrom.dispatch_id, request.dispatchId);
    assert.equal(handed.route.resolved_worker_engine, 'claude');
    assert.equal(handed.route.model_resolved || handed.route.model, route.model_resolved || route.model);
    assert.equal(handed.route.workers_timeout, ceilingFromRoute(route).seconds);
    assert.equal(handed.route.workers_timeout_source, ceilingFromRoute(route).source);
    assert.notEqual(handed.dispatchId, request.dispatchId);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const reservation = saved.reservations.at(-1);
    assert.equal(reservation.reason, 'same-session-resume');
    assert(!JSON.stringify(saved.reservations).includes(ref.id), 'reservations carry only the digest');
  });
  await test('standalone research recovery after active-budget without a ref stops as resume-unavailable without a spawn', async () => {
    const { request, receiptFile, stateFile } = await activeBudgetPreparation('research', false);
    let delivered = 0;
    const recovered = await prep.recoverStandaloneTask(request, { receiptFile, stateFile }, {
      processProbe: () => 'stopped', invokeSidecar: async () => { delivered++; return envelope(request); } });
    assert.equal(recovered.action, 'stop', JSON.stringify(recovered));
    assert.equal(recovered.reason_code, 'budget-exceeded-resume-unavailable');
    assert.equal(delivered, 0);
  });
  await test('a resume on an ineligible phase or route, or with a malformed resumedFrom, is refused before any transport', async () => {
    const sessions = require('./forge-claude-session');
    const base = fixture({ phase: 'research', hostRuntime: 'codex' });
    const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null, configDir: base.cwd, cwd: base.cwd });
    const from = { receipt_sha256: 'a'.repeat(64), dispatch_id: 'dispatch-x' };
    assert.throws(() => prep.validateRequest({ ...base, claudeResume: ref, resumedFrom: from }), error => error.code === 'recovery-resume-phase-ineligible');
    const plan = { ...base, phase: 'plan' };
    assert.equal(prep.validateRequest({ ...plan, claudeResume: ref, resumedFrom: from }).claudeResume, ref);
    assert.throws(() => prep.validateRequest({ ...plan, claudeResume: { ...ref, id: 'not-a-uuid' }, resumedFrom: from }), error => error.code === 'claude-session-invalid');
    for (const bad of [undefined, { receipt_sha256: 'x', dispatch_id: 'd' }, { ...from, extra: 1 }, { ...from, dispatch_id: '' }]) {
      assert.throws(() => prep.validateRequest({ ...plan, claudeResume: ref, resumedFrom: bad }), error => error.code === 'invalid-preparation-resume');
    }
    // The recovery adapter itself: non-Claude/native route or non-plan phase is a named refusal before any transport.
    const recoveryApi = require('./forge-attempt-recovery'), realRecover = recoveryApi.recoverAttempt;
    const failedPlan = fixture({ phase: 'plan', hostRuntime: 'codex', model: 'claude-sonnet-5' });
    await prep.prepareStandaloneTask(failedPlan, { invokeSidecar: async () => {
      throw Object.assign(Error('fixture ceiling'), { code: 'budget-exceeded-while-active', provider_called: true }); } });
    const receipt = JSON.parse(fs.readFileSync(failedPlan.resultFile + '.receipt.json', 'utf8'));
    const resume = { session: ref, resumed_from: from };
    let delivered = 0;
    try {
      for (const [request, route, code] of [
        [failedPlan, { ...receipt.route, resolved_worker_engine: 'codex' }, 'recovery-resume-route-invalid'],
        [failedPlan, { ...receipt.route, worker_mode: 'native' }, 'recovery-resume-route-invalid'],
        [{ ...failedPlan, phase: 'research' }, receipt.route, 'recovery-resume-phase-ineligible']]) {
        recoveryApi.recoverAttempt = async options => options.invoke(route, { ok: true }, null, undefined, 'fixture-reservation', resume);
        await assert.rejects(() => prep.recoverStandaloneTask(request, { receiptFile: failedPlan.resultFile + '.receipt.json',
          stateFile: failedPlan.resultFile + '.recovery.json' }, { invokeSidecar: async () => { delivered++; return envelope(request); } }),
        error => error.code === code);
      }
    } finally { recoveryApi.recoverAttempt = realRecover; }
    assert.equal(delivered, 0);
  });
  await test('external native recovery revalidates live authority at callback boundary', async () => {
    const request=fixture({model:'gpt-5.6-sol'}); request.activeCapabilities=codexCapabilities();
    request.prompt='before repair';
    await prep.prepareStandaloneTask(request,{invokeNative:async()=>{throw Object.assign(Error('fixture'),{code:'context-budget-exceeded',provider_called:false});}});
    request.prompt='after repair';
    const receiptFile=request.resultFile+'.receipt.json', stateFile=request.resultFile+'.recovery.json';
    const route=JSON.parse(fs.readFileSync(receiptFile)).route;
    const recoveryApi=require('./forge-attempt-recovery'), originalRecover=recoveryApi.recoverAttempt;
    let valid=true,calls=0,checks=0;
    try {
      recoveryApi.recoverAttempt=async options=>options.invoke(route,{ok:true},null,()=>{
        checks++; if(!valid)throw Object.assign(Error('revoked fixture authority'),{code:'fixture-authority-revoked'});
      },'fixture-reservation');
      const handoff=await prep.recoverStandaloneTask(request,{receiptFile,stateFile,correction:true},{processProbe:()=> 'stopped'});
      assert.equal(typeof handoff.invoke,'function'); valid=false;
      const outcome=await handoff.invoke(async()=>{calls++;return framed(envelope(request));});
      assert.equal(calls,0,'revoked handoff cannot invoke callback');
      assert.equal(outcome.ok,false); assert.equal(outcome.reason_code,'fixture-authority-revoked');
      assert(checks>0); assert(!fs.existsSync(artifactPath(request)));
    } finally { recoveryApi.recoverAttempt=originalRecover; }
  });
  await test('standalone native recovery route carries no synthetic workers_timeout', async () => {
    const request = fixture({ model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    request.prompt = 'before repair';
    const failed = await prep.prepareStandaloneTask(request, { invokeNative: async () => {
      throw Object.assign(Error('fixture caller error'), { code: 'context-budget-exceeded', provider_called: false });
    } });
    assert.equal(failed.ok, false);
    request.prompt = 'after offline repair';
    const receiptRoute = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json', 'utf8')).route;
    let handedRoute;
    const recovered = await prep.recoverStandaloneTask(request, { receiptFile: request.resultFile + '.receipt.json',
      stateFile: request.resultFile + '.recovery.json', correction: true }, { processProbe: () => 'stopped',
      invokeNative: async () => framed(envelope(request)), resolveDispatch: options => (handedRoute = resolveDispatch(options)) });
    assert.equal(recovered.corrected, true);
    assert.equal(recovered.route.worker_mode, 'native');
    // The native route is passed through unchanged: no ceiling is synthesized onto it.
    const origin = handedRoute || receiptRoute;
    assert.equal(recovered.route.workers_timeout, origin.workers_timeout);
    assert.equal(recovered.route.workers_timeout_source, origin.workers_timeout_source);
    console.log(`  native route workers_timeout=${recovered.route.workers_timeout} source=${recovered.route.workers_timeout_source} (origin ${handedRoute ? 'resolver' : 'receipt'})`);
    assert.equal(recovered.sidecar_ceiling, null);
  });
  await test('four phases use the actual caller, configured Claude sidecar and exact task-local formats', async () => {
    for (const phase of Object.keys(prep.PHASE_CONTRACTS)) {
      const request = fixture({ phase, hostRuntime: 'codex', model: 'claude-sonnet-5' });
      const phasePrompt = `UNIQUE-${phase}-PHASE-INSTRUCTIONS`;
      if (phase === 'research') {
        request.promptFile = path.join(request.contextRoot, 'research-prompt.md');
        fs.writeFileSync(request.promptFile, phasePrompt);
      } else request.prompt = phasePrompt;
      let calls = 0;
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async delivery => {
        calls++;
        assert.equal(delivery.route.model_resolved, 'claude-sonnet-5');
        assert.equal(delivery.route.effort, 'medium');
        assert.equal(delivery.route.worker_mode, 'sidecar');
        assert.equal(delivery.route.unit_type, prep.PHASE_CONTRACTS[phase].unitType);
        assert(delivery.prompt.includes(phasePrompt));
        const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd, phase: 'task-' + phase });
        assert(delivery.prompt.includes(procedure.content));
        for (const module of procedure.modules) assert.equal(delivery.prompt.split('<!-- forge-procedure:' + module.id + ' -->').length - 1, 1);
        return envelope(request);
      } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.transport, 'sidecar');
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(artifactPath(request), 'utf8'), content(phase, request.taskId));
      assert(!fs.existsSync(path.join(request.contextRoot, '.gsd', 'milestones')));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.route_identity.model_resolved, 'claude-sonnet-5');
      assert.equal(receipt.route_identity.effort, 'medium');
      assert.equal(receipt.provider_called, true);
    }
  });

  await test('real preparation caller preserves all four task phases and verified procedure provenance', async () => {
    const original = xllm.invokeCodexAppServer;
    try {
      for (const phase of ['brainstorm', 'discuss', 'research', 'plan']) {
        const request = fixture({ phase, hostRuntime: 'claude', model: 'gpt-5.6-sol' });
        const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd, phase: `task-${phase}` });
        let calls = 0;
        xllm.invokeCodexAppServer = async options => {
          calls++;
          for (const module of procedure.modules) assert.equal(options.prompt.split(`<!-- forge-procedure:${module.id} -->`).length - 1, 1);
          assert(options.prompt.includes(procedure.content));
          return { finalText: JSON.stringify({ status: 'partial', summary: 'Fixture reached provider', questions: [], artifacts: [] }) };
        };
        const result = await prep.prepareStandaloneTask(request);
        assert.equal(result.status, 'partial', `${phase}: ${JSON.stringify(result)}`);
        assert.equal(result.provider_called, true);
        assert.equal(calls, 1);
      }
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('production Codex sidecar receives the complete prompt and persists continuation dispatch identity', async () => {
    const request = fixture({ phase: 'discuss', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    request.prompt = 'UNIQUE-PRODUCTION-SIDECAR-PROMPT';
    const partial = { status: 'partial', summary: 'Need a choice', questions: ['Choose the source'], artifacts: [] };
    const original = xllm.invokeCodexAppServer;
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    let calls = 0;
    xllm.invokeCodexAppServer = async options => {
      calls++;
      assert(options.prompt.includes(request.prompt));
      assert.equal(options.sandbox, 'read-only');
      options.onHeartbeat(43210);
      return { finalText: JSON.stringify(calls === 1 ? partial : envelope(request)) };
    };
    try {
      const first = await prep.prepareStandaloneTask(request, { announce });
      assert.equal(first.status, 'partial', JSON.stringify(first));
      assert.equal(first.provider_called, true);
      assert.deepStrictEqual(identityLines.map(line => line.match(/^\[forge-sidecar\] (\w+)/)[1]), ['solicitado', 'iniciado']);
      assert(identityLines.every(line => line.includes('fase=discuss')));
      assert(identityLines[1].includes('pid=43210'));
      assert(!identityLines.join('').includes(request.prompt));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.dispatch_id, request.dispatchId);
      assert.equal(receipt.provider_called, true);
      const firstEvents = fs.readFileSync(path.join(request.contextRoot, '.gsd', 'forge', 'events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(firstEvents.filter(event => event.event === 'sidecar-unit').at(-1).provider_called, true);
      const replay = await prep.startStandaloneTaskPreparation(request, { resolveDispatch() { throw Error('partial replay must not resolve'); } });
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.equal(calls, 1);
      const continuation = { ...request, prompt: 'UNIQUE-PRODUCTION-SIDECAR-PROMPT-CONTINUED',
        dispatchId: `${request.dispatchId}-continued`, resultFile: request.resultFile.replace('.json', '-continued.json'),
        continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile,
          answers: [{ id: require('./forge-interaction').mergePendingQuestions([], ['Choose the source'])[0].id, answer: 'Use the checked-in source.' }] } };
      const second = await prep.prepareStandaloneTask(continuation);
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(calls, 2);
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('GPT configured on Claude selects Codex sidecar without changing identity', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async delivery => {
      assert.equal(delivery.route.resolved_worker_engine, 'codex');
      assert.equal(delivery.route.worker_mode, 'sidecar');
      assert.equal(delivery.route.model_resolved, 'gpt-5.6-sol');
      return envelope(request);
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.route.model_requested, 'gpt-5.6-sol');
  });

  await test('Codex native start, framed accept and ready replay resolve once and invoke once', async () => {
    const request = fixture({ phase: 'brainstorm', hostRuntime: 'codex', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    let resolverCalls = 0;
    const started = await prep.startStandaloneTaskPreparation(request, {
      resolveDispatch: options => { resolverCalls++; return resolveDispatch(options); },
    });
    assert.equal(started.action, 'invoke-native', JSON.stringify(started));
    assert.equal(started.invocation.args.model, 'gpt-5.6-sol');
    assert.equal(started.invocation.args.reasoning_effort, 'medium');
    const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd, phase: 'task-brainstorm' });
    assert(started.invocation.args.message.includes(procedure.content));
    const accepted = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(resolverCalls, 1);
    const replay = await prep.startStandaloneTaskPreparation(request, {
      resolveDispatch: () => { throw Error('ready replay must not resolve'); },
    });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
    assert.equal(replay.provider_called, false);
    assert.equal(resolverCalls, 1);
  });

  await test('Codex native names are distinct per dispatch, stable per attempt and keep model/effort', async () => {
    const nativeApi = require('./forge-native-invocation');
    const base = fixture({ phase: 'research', hostRuntime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    base.activeCapabilities = codexCapabilities();
    // Distinct dispatch ids whose sanitized text is identical.
    const ids = ['attempt-Retry-1', 'attempt_retry_1', 'attempt.retry.1'];
    assert.equal(new Set(ids.map(id => nativeApi.codexTaskName(id))).size, 1);
    const requests = ids.map((dispatchId, index) => ({ ...base, dispatchId,
      resultFile: path.join(path.dirname(base.resultFile), `attempt-${index}.json`) }));
    // Codex keeps a completed agent registered and refuses a reused name before the provider.
    function spawnRegistry() {
      const names = new Set();
      return name => {
        if (names.has(name)) throw Object.assign(Error(`agent name already exists: ${name}`), { code: 'agent-name-exists' });
        names.add(name);
      };
    }
    const spawn = spawnRegistry();
    const spawned = [];
    for (const request of requests) {
      const result = await prep.prepareStandaloneTask(request, { invokeNative: async args => {
        spawn(args.task_name);
        spawned.push(args);
        return framed(envelope(request));
      } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.transport, 'native');
      assert.equal(result.route.model_resolved, 'gpt-5.6-sol');
      assert.equal(result.route.effort, 'high');
    }
    assert.equal(spawned.length, 3);
    assert.equal(new Set(spawned.map(args => args.task_name)).size, 3);
    const readable = `${nativeApi.codexTaskName(`preparation_research_${base.taskId}`)}_`;
    const unnamed = args => { const rest = { ...args }; delete rest.task_name; return rest; };
    for (const args of spawned) {
      assert(args.task_name.startsWith(readable), args.task_name);
      assert.match(args.task_name, /_[0-9a-f]{16}$/);
      assert.deepEqual(unnamed(args), unnamed(spawned[0]));
      assert.equal(args.model, 'gpt-5.6-sol');
      assert.equal(args.reasoning_effort, 'high');
      assert.equal(args.agent_type, 'forge-researcher');
      assert.equal(args.fork_turns, 'none');
    }

    // The legacy phase/task name collides on the second dispatch through the same adapter.
    const route = JSON.parse(fs.readFileSync(`${requests[0].resultFile}.receipt.json`, 'utf8')).route;
    const legacySpawn = spawnRegistry();
    const legacy = requests.slice(0, 2).map(request => nativeApi.buildNativeInvocation({
      ...prep.nativeOptions(request, route, prep.buildPreparationPrompt(request)),
      taskName: `preparation_${request.phase}_${request.taskId}` }).args.task_name);
    assert.equal(legacy[0], legacy[1]);
    legacySpawn(legacy[0]);
    assert.throws(() => legacySpawn(legacy[1]), error => error.code === 'agent-name-exists');

    // The same dispatch always derives the same name, including from a fresh copy.
    for (const [index, request] of requests.entries()) {
      for (const copy of [request, JSON.parse(JSON.stringify(request))]) {
        const again = nativeApi.buildNativeInvocation(prep.nativeOptions(copy, route, prep.buildPreparationPrompt(copy)));
        assert.equal(again.ok, true);
        assert.equal(again.args.task_name, spawned[index].task_name);
        assert.equal(again.args.model, 'gpt-5.6-sol');
        assert.equal(again.args.reasoning_effort, 'high');
      }
    }

    // Accepted replay of every dispatch spawns no agent and never re-resolves.
    for (const request of requests) {
      const replay = await prep.prepareStandaloneTask(request, {
        resolveDispatch: () => { throw Error('ready replay must not resolve'); },
        invokeNative: async () => { throw Error('ready replay must not spawn'); },
      });
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.equal(replay.provider_called, false);
      assert.equal(replay.route.model_resolved, 'gpt-5.6-sol');
      assert.equal(replay.route.effort, 'high');
    }
    assert.equal(spawned.length, 3);
    assert.equal(fs.readFileSync(artifactPath(base), 'utf8'), content('research', base.taskId));
  });

  await test('Claude native uses observed frontmatter effort and the same acceptance boundary', async () => {
    const request = fixture({ phase: 'discuss', hostRuntime: 'claude', model: 'claude-sonnet-5' });
    const agent = path.join(path.dirname(request.resultFile), 'forge-discusser.md');
    fs.writeFileSync(agent, '---\nname: forge-discusser\neffort: medium\n---\n');
    request.activeCapabilities = { available: true, tool: 'Agent', source: 'fixture-tool-schema',
      model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] };
    request.effortBinding = { transport: 'agent-frontmatter', agentPath: agent,
      sourceFingerprint: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(agent)).digest('hex')}` };
    let calls = 0;
    const result = await prep.prepareStandaloneTask(request, { invokeNative: async args => {
      calls++;
      assert.equal(args.model, 'sonnet');
      assert.equal(args.subagent_type, 'forge-discusser');
      return framed(envelope(request));
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.transport, 'native');
    assert.equal(calls, 1);
  });

  await test('canonical, sequential and dashed timestamp task IDs publish without a milestone', async () => {
    for (const taskId of ['T-20260928151522-canonical', 'TASK-007', 'TASK-20260928-104227']) {
      const request = fixture({ phase: 'discuss', taskId });
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => envelope(request) });
      assert.equal(result.ok, true, `${taskId}: ${JSON.stringify(result)}`);
      assert(fs.existsSync(artifactPath(request)));
    }
  });

  await test('physical contract is validated before routing and included in the common prompt', async () => {
    const f = require('./forge-code-roots.test').fixture();
    try {
      const request = { ...fixture(), cwd: f.a, contextRoot: f.owner, execution_contract: f.contract };
      const validated = prep.validateRequest(request);
      const prompt = prep.buildPreparationPrompt(validated);
      assert(prompt.includes(JSON.stringify(f.contract)));
      for (const execution_contract of [{ ...f.contract, schema_version: 99 }, { ...f.contract, owner: f.b },
        { ...f.contract, code_roots: [] }, { ...f.contract, primary_root_id: 'beta' },
        { ...f.contract, code_roots: f.contract.code_roots.map(root => ({ ...root, identity_sha256: 'foreign' })) }]) {
        const result = await prep.startStandaloneTaskPreparation({ ...request, execution_contract }, {
          resolveDispatch() { throw new Error('invalid contract reached routing'); } });
        assert.equal(result.ok, false);
        assert.equal(result.provider_called, false);
        assert.notEqual(result.reason_code, 'preparation-resolution-failed');
      }
    } finally { f.cleanup(); }
  });

  await test('accumulated question texts and answers survive partial continuation and restart', async () => {
    const request = fixture({ phase: 'discuss' });
    const questions = ['First required decision?', 'Second required decision?'];
    await prep.prepareStandaloneTask(request, { invokeSidecar: async () => ({ status: 'partial', summary: 'Decisions', questions, artifacts: [] }) });
    const ids = require('./forge-interaction').mergePendingQuestions([], questions).map(row => row.id);
    const resume = answers => ({ ...request, dispatchId: request.dispatchId + '-resume', resultFile: request.resultFile + '-resume.json',
      continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile, answers } });
    const first = await prep.startStandaloneTaskPreparation(resume([{ id: ids[0], answer: 'First accepted answer' }]));
    assert.equal(first.reason_code, 'preparation-continuation-answers-incomplete');
    const second = await prep.prepareStandaloneTask(resume([{ id: ids[1], answer: 'Second accepted answer' }]), {
      invokeSidecar: async delivery => {
        for (const text of [...questions, ...ids, 'First accepted answer', 'Second accepted answer']) assert(delivery.prompt.includes(text));
        return envelope(request);
      } });
    assert.equal(second.ok, true, JSON.stringify(second));
  });

  await test('partial replay preserves input identity for native and injected transports', async () => {
    for (const native of [false, true]) {
      const request = fixture({ phase: 'discuss', ...(native ? { model: 'gpt-5.6-sol' } : {}) });
      const partial = { status: 'partial', summary: 'Need decision', questions: [{ id: 'source', question: 'Which source?' }], artifacts: [] };
      let calls = 0;
      if (native) {
        request.activeCapabilities = codexCapabilities();
        const started = await prep.startStandaloneTaskPreparation(request);
        const accepted = await prep.acceptStandaloneTaskPreparation(request, { route: started.route, rawResult: framed(partial),
          invocationTelemetry: started.invocation.telemetry, providerCalled: true });
        assert.equal(accepted.status, 'partial', JSON.stringify(accepted));
      } else {
        const accepted = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return partial; } });
        assert.equal(accepted.status, 'partial', JSON.stringify(accepted));
      }
      const options = { resolveDispatch() { throw Error('replay must not resolve'); }, invokeSidecar() { throw Error('replay must not invoke'); } };
      const replay = await prep.startStandaloneTaskPreparation(request, options);
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.deepEqual(replay.result.questions, partial.questions);
      assert.equal(calls, native ? 0 : 1);
      const continuation = { ...request, dispatchId: request.dispatchId + '-answer', resultFile: request.resultFile.replace('.json', '-answer.json'),
        continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile, answers: [{ id: 'source', answer: 'Schema' }] } };
      // A continuation has answered input questions plus a new output question.
      const next = { status: 'partial', summary: 'Another decision', questions: [{ id: 'scope', question: 'Which scope?' }], artifacts: [] };
      let accepted;
      if (native) {
        const started = await prep.startStandaloneTaskPreparation(continuation);
        accepted = await prep.acceptStandaloneTaskPreparation(continuation, { route: started.route, rawResult: framed(next),
          invocationTelemetry: started.invocation.telemetry, providerCalled: true });
      } else accepted = await prep.prepareStandaloneTask(continuation, { invokeSidecar: async () => next });
      assert.equal(accepted.status, 'partial', JSON.stringify(accepted));
      fs.unlinkSync(request.resultFile); fs.unlinkSync(request.resultFile + '.receipt.json');
      const replayNext = await prep.startStandaloneTaskPreparation(continuation, options);
      assert.equal(replayNext.replayed, true, JSON.stringify(replayNext));
      assert.deepEqual(replayNext.result.questions, next.questions);
    }
  });

  await test('partial questions publish nothing and explicit continuation uses a new fingerprint and prompt', async () => {
    const request = fixture({ phase: 'discuss' });
    const partial = { status: 'partial', summary: 'Need a decision',
      questions: ['Which source is authoritative?'], artifacts: [] };
    const first = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => partial });
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.result.questions, partial.questions);
    assert(!fs.existsSync(artifactPath(request)));
    const continuation = { ...request, dispatchId: `${request.dispatchId}-answer`,
      resultFile: request.resultFile.replace('.json', '-answer.json'),
      continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile,
        answers: [{ id: require('./forge-interaction').mergePendingQuestions([], ['Which source is authoritative?'])[0].id, answer: 'The checked-in schema is authoritative.' }] } };
    let prompt = '';
    const resumed = await prep.prepareStandaloneTask(continuation, { invokeSidecar: async delivery => {
      prompt = delivery.prompt;
      return envelope(continuation);
    } });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert(prompt.includes('The checked-in schema is authoritative.'));
    fs.unlinkSync(`${request.resultFile}.receipt.json`);
    fs.unlinkSync(request.resultFile);
    const replay = await prep.startStandaloneTaskPreparation(continuation, {
      resolveDispatch: () => { throw Error('completed continuation replay must not resolve'); },
    });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
  });

  await test('continuations require a matching pending receipt and exact question answers', async () => {
    const prior = fixture({ phase: 'discuss' });
    const partial = { status: 'partial', summary: 'Need a decision', questions: ['One?'], artifacts: [] };
    await prep.prepareStandaloneTask(prior, { invokeSidecar: async () => partial });
    function continuation(overrides = {}) {
      return { ...prior, dispatchId: `${prior.dispatchId}-${++sequence}`,
        resultFile: path.join(path.dirname(prior.resultFile), `continued-${sequence}.json`),
        continuation: { from_dispatch_id: prior.dispatchId, result_file: prior.resultFile, answers: [{ id: require('./forge-interaction').mergePendingQuestions([], ['One?'])[0].id, answer: 'Answer' }] },
        ...overrides };
    }
    const forged = [
      continuation({ continuation: { from_dispatch_id: 'missing',
        result_file: path.join(path.dirname(prior.resultFile), 'missing.json'), answers: [{ id: require('./forge-interaction').mergePendingQuestions([], ['One?'])[0].id, answer: 'Answer' }] } }),
      continuation({ taskId: `T-20260928151522-wrong-${sequence}` }),
      continuation({ phase: 'research' }),
      continuation({ dispatchId: prior.dispatchId }),
    ];
    let calls = 0;
    for (const request of forged) {
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
      assert.equal(result.ok, false);
      assert.equal(result.provider_called, false);
    }
    const completed = fixture({ phase: 'discuss' });
    await prep.prepareStandaloneTask(completed, { invokeSidecar: async () => envelope(completed) });
    const afterDone = { ...completed, dispatchId: `${completed.dispatchId}-continued`,
      resultFile: completed.resultFile.replace('.json', '-continued.json'),
      continuation: { from_dispatch_id: completed.dispatchId, result_file: completed.resultFile, answers: [{ id: require('./forge-interaction').mergePendingQuestions([], ['One?'])[0].id, answer: 'Answer' }] } };
    const refused = await prep.prepareStandaloneTask(afterDone, { invokeSidecar: async () => { calls++; return envelope(afterDone); } });
    assert.equal(refused.reason_code, 'preparation-continuation-not-pending');
    assert.equal(calls, 0);
  });

  await test('changed continuation under the same dispatch conflicts without provider work', async () => {
    const request = fixture({ phase: 'discuss' });
    let calls = 0;
    await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
    const changed = { ...request, inputs: { brief: 'changed under same dispatch' } };
    const result = await prep.prepareStandaloneTask(changed, { invokeSidecar: async () => { calls++; return envelope(changed); } });
    assert.equal(result.reason_code, 'dispatch-identity-conflict');
    assert.equal(calls, 1);
  });

  await test('native direct write before accept is refused even when bytes equal the returned artifact', async () => {
    const request = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    fs.mkdirSync(path.dirname(artifactPath(request)), { recursive: true });
    fs.writeFileSync(artifactPath(request), content(request.phase, request.taskId));
    const started = await prep.startStandaloneTaskPreparation(request);
    fs.writeFileSync(artifactPath(request), content(request.phase, request.taskId));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(artifactPath(request), future, future);
    const result = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(result.reason_code, 'artifact-direct-write-detected');
    assert.equal(JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8')).phase, 'failed');
  });

  await test('native writes to bounded Forge control files are refused without claiming a source sandbox', async () => {
    const request = fixture({ phase: 'research', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    const state = path.join(request.contextRoot, '.gsd', 'STATE.md');
    fs.writeFileSync(state, '# Before\n');
    const started = await prep.startStandaloneTaskPreparation(request);
    fs.writeFileSync(state, '# Written by native worker\n');
    const result = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(result.reason_code, 'artifact-direct-write-detected');

    const grouped = fixture({ phase: 'research', model: 'gpt-5.6-sol' });
    grouped.activeCapabilities = codexCapabilities();
    const container = path.join(grouped.contextRoot, '.gsd', 'milestones', 'epoch.md');
    fs.mkdirSync(path.dirname(container), { recursive: true });
    fs.writeFileSync(container, '# Grouped milestone bytes\n');
    const groupedStart = await prep.startStandaloneTaskPreparation(grouped);
    fs.writeFileSync(container, '# Modified grouped milestone bytes\n');
    const groupedResult = await prep.acceptStandaloneTaskPreparation(grouped, {
      route: groupedStart.route, rawResult: framed(envelope(grouped)),
      invocationTelemetry: groupedStart.invocation.telemetry, providerCalled: true,
    });
    assert.equal(groupedResult.reason_code, 'artifact-direct-write-detected');
  });

  await test('wrong phase formats, non-done artifacts and malformed final native frames are refused', async () => {
    const wrong = fixture({ phase: 'brainstorm' });
    const wrongEnvelope = envelope(wrong);
    wrongEnvelope.artifacts[0].content = content('plan', wrong.taskId);
    assert.equal((await prep.prepareStandaloneTask(wrong, { invokeSidecar: async () => wrongEnvelope })).ok, false);

    const emptySection = fixture({ phase: 'research' });
    const emptyEnvelope = envelope(emptySection);
    emptyEnvelope.artifacts[0].content = "# Research\n\n## Summary\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
    assert.equal((await prep.prepareStandaloneTask(emptySection, { invokeSidecar: async () => emptyEnvelope })).ok, false);

    for (const mutate of [
      value => value.replace('tier: standard', 'tier: banana'),
      value => value.replace('effort: medium', 'effort: banana'),
      value => value.replace('effort: medium', 'effort: medium\neffort: high'),
      value => `${value}\n## Deferred\n\nLater.\n`,
    ]) {
      const invalidPlan = fixture({ phase: 'plan' });
      const invalidEnvelope = envelope(invalidPlan);
      invalidEnvelope.artifacts[0].content = mutate(invalidEnvelope.artifacts[0].content);
      assert.equal((await prep.prepareStandaloneTask(invalidPlan,
        { invokeSidecar: async () => invalidEnvelope })).ok, false);
    }

    const nonDone = fixture({ phase: 'research' });
    const poisoned = envelope(nonDone, { status: 'partial', questions: ['Need input'] });
    assert.equal((await prep.prepareStandaloneTask(nonDone, { invokeSidecar: async () => poisoned })).ok, false);

    const native = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    native.activeCapabilities = codexCapabilities();
    const started = await prep.startStandaloneTaskPreparation(native);
    const malformed = `${framed(envelope(native))}\n---GSD-WORKER-RESULT---\nstatus: done`;
    const rejected = await prep.acceptStandaloneTaskPreparation(native, { route: started.route,
      rawResult: malformed, invocationTelemetry: started.invocation.telemetry, providerCalled: true });
    assert.equal(rejected.ok, false);
    assert.notEqual(rejected.reason_code, 'preparation-published');
  });

  await test('invalid scope, IDs, capability and symlink targets fail before a provider call', async () => {
    for (const mutate of [
      request => { request.scope = 'milestone'; },
      request => { request.taskId = '../escape'; },
      request => { request.phase = 'unknown'; },
    ]) {
      const request = fixture(); mutate(request);
      let calls = 0;
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
      assert.equal(result.provider_called, false);
      assert.equal(calls, 0);
    }
    const unsupported = fixture();
    const result = await prep.prepareStandaloneTask(unsupported, { resolveDispatch: options => ({
      ...resolveDispatch(options), resolved_worker_engine: 'agy', worker_mode: 'sidecar', sidecar_declared: true,
    }), invokeSidecar: async () => { throw Error('must not call'); } });
    assert.equal(result.reason_code, 'unsupported-sidecar-unit');
    assert.equal(result.provider_called, false);

    const linked = fixture();
    const taskRoot = path.join(linked.contextRoot, '.gsd', 'tasks');
    fs.mkdirSync(taskRoot, { recursive: true });
    fs.symlinkSync(path.dirname(linked.resultFile), path.join(taskRoot, linked.taskId), process.platform === 'win32' ? 'junction' : 'dir');
    let calls = 0;
    const linkedResult = await prep.prepareStandaloneTask(linked, { invokeSidecar: async () => { calls++; return envelope(linked); } });
    assert.equal(linkedResult.ok, false);
    assert.equal(calls, 0);
  });

  await test('duplicate, extra, oversized and secret-bearing results never publish', async () => {
    const cases = [
      request => { const value = envelope(request); value.artifacts.push(value.artifacts[0]); return value; },
      request => { const value = envelope(request); value.artifacts.push({ path: '.gsd/STATE.md', content: '# poison' }); return value; },
      request => envelope(request, { summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES + 1) }),
      request => envelope(request, { summary: 'x'.repeat(64 * 1024 + 1) }),
      request => ({ status: 'partial', summary: 'Need input', questions: ['x'.repeat(16 * 1024 + 1)], artifacts: [] }),
      request => envelope(request, { summary: 'credential=fixture-secret-never-persist' }),
    ];
    for (const make of cases) {
      const request = fixture({ phase: 'research' });
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => make(request) });
      assert.equal(result.ok, false);
      assert(!fs.existsSync(artifactPath(request)));
      const durable = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
      assert(!durable.includes('fixture-secret-never-persist'));
    }
  });

  await test('unproven invocation failures remain unknown, preflight is false and explicit provider evidence is true', async () => {
    const preflight = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    preflight.activeCapabilities = { ...codexCapabilities(), models: [] };
    const refused = await prep.prepareStandaloneTask(preflight, { invokeNative: async () => { throw Error('not called'); } });
    assert.equal(refused.reason_code, 'native-model-unsupported');
    assert.equal(refused.provider_called, false);

    const provider = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    provider.activeCapabilities = codexCapabilities();
    const failed = await prep.prepareStandaloneTask(provider, { invokeNative: async () => { throw Error('fixture secret'); } });
    assert.equal(failed.reason_code, 'native-invocation-failed');
    assert.equal(failed.provider_called, 'unknown');
    const durable = fs.readFileSync(`${provider.resultFile}.receipt.json`, 'utf8');
    assert(!durable.includes('fixture secret'));

    const confirmed = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    confirmed.activeCapabilities = codexCapabilities();
    const observed = await prep.prepareStandaloneTask(confirmed, { invokeNative: async () => {
      const error = Error('fixture confirmed provider failure');
      error.provider_called = true;
      throw error;
    } });
    assert.equal(observed.provider_called, true);
    assert.equal(JSON.parse(fs.readFileSync(`${confirmed.resultFile}.receipt.json`, 'utf8')).failure.provider_called, true);

    const sidecar = fixture({ phase: 'research', model: 'claude-sonnet-5' });
    let sidecarCalls = 0;
    const first = await prep.prepareStandaloneTask(sidecar, { invokeSidecar: async () => {
      sidecarCalls++;
      throw Error('fixture injected provider failure');
    } });
    assert.equal(first.provider_called, 'unknown');
    const receiptBytes = fs.readFileSync(`${sidecar.resultFile}.receipt.json`, 'utf8');
    const replay = await prep.prepareStandaloneTask(sidecar, { invokeSidecar: async () => {
      sidecarCalls++;
      throw Error('must not call failed injected provider again');
    } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.provider_called, false);
    assert.equal(replay.original_provider_called, 'unknown');
    assert.equal(sidecarCalls, 1);
    assert.equal(fs.readFileSync(`${sidecar.resultFile}.receipt.json`, 'utf8'), receiptBytes);
  });

  await test('timeout diagnostic reaches the preparation caller and failed replay without becoming provider refusal', async () => {
    const request = fixture({ phase: 'plan', hostRuntime: 'codex', model: 'claude-sonnet-5' });
    const original = unit.runUnitSidecar;
    let calls = 0;
    const detail = { version: 1, stage: 'transport', reason: 'provider-timeout',
      stdout_bytes: 0, stderr_bytes: 192, duration_ms: 295186 };
    unit.runUnitSidecar = async () => {
      calls++;
      const error = new Error('fixture-private-provider-message');
      error.code = 'claude-timeout';
      error.provider_called = true;
      error.diagnostic = { ...detail, private_stream: 'fixture-private-provider-message' };
      throw error;
    };
    try {
      const result = await prep.prepareStandaloneTask(request);
      assert.equal(result.reason_code, 'claude-timeout');
      assert.equal(result.provider_called, true);
      assert.deepStrictEqual(result.diagnostic, detail);
      assert(!JSON.stringify(result).includes('fixture-private-provider-message'));
      const replay = await prep.prepareStandaloneTask(request);
      assert.equal(replay.provider_called, false);
      assert.equal(replay.original_provider_called, true);
      assert.deepStrictEqual(replay.original_diagnostic, detail);
      assert.equal(calls, 1);
      assert(!fs.existsSync(artifactPath(request)));
    } finally { unit.runUnitSidecar = original; }
  });

  await test('injected sidecar preserves safe adapter diagnostics and explicit pre-spawn evidence', async () => {
    const request = fixture({ phase: 'research', model: 'claude-sonnet-5' });
    const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => {
      const error = new Error('fixture-private-adapter-message');
      error.code = 'claude-model-required';
      error.provider_called = false;
      error.diagnostic = { version: 1, stage: 'identity', reason: 'model-required',
        duration_ms: 0, private_stream: 'fixture-private-adapter-message' };
      throw error;
    } });
    assert.equal(result.provider_called, false);
    assert.deepStrictEqual(result.diagnostic, { version: 1, stage: 'identity', reason: 'model-required', duration_ms: 0 });
    const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
    assert.equal(receipt.failure.provider_called, false);
    assert(!JSON.stringify(result).includes('fixture-private-adapter-message'));
  });

  await test('unknown diagnostic metadata cannot forge a layer or expose provider text', async () => {
    const request = fixture({ phase: 'research', model: 'claude-sonnet-5' });
    const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => {
      const error = new Error('fixture-private-unknown-message');
      error.code = 'sidecar-unit-failed';
      error.diagnostic = { stage: 'fixture-private-unknown-message', reason: 'fixture-private-unknown-message' };
      throw error;
    } });
    assert(!JSON.stringify(result).includes('fixture-private-unknown-message'));
    assert.equal(result.provider_called, 'unknown');
    assert.equal(result.diagnostic.stage, 'transport');
  });

  await test('production sidecar pre-spawn route refusal records provider_called false', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'codex', model: 'claude-sonnet-5' });
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    const result = await prep.prepareStandaloneTask(request, { announce, resolveDispatch: options => {
      const route = resolveDispatch(options);
      return { ...route, model: 'gpt-5.6-sol', model_requested: 'gpt-5.6-sol',
        model_resolved: 'gpt-5.6-sol', sidecar_model: 'gpt-5.6-sol' };
    } });
    assert.equal(result.reason_code, 'route-model-engine-mismatch');
    assert.equal(result.provider_called, false);
    assert.equal(identityLines.length, 1);
    assert.match(identityLines[0], /^\[forge-sidecar\] recusado fase=research /);
    assert(identityLines[0].includes('modelo_enviado=-'));
    assert(identityLines[0].includes('provider_called=false'));
    assert.equal(result.diagnostic.stage, 'transport');
    const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
    assert.equal(receipt.failure.provider_called, false);
    const receiptBytes = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
    let replayResolutions = 0;
    const replay = await prep.prepareStandaloneTask(request, { resolveDispatch: () => {
      replayResolutions++;
      throw Error('failed replay must not resolve');
    } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.provider_called, false);
    assert.equal(replay.original_provider_called, false);
    assert.equal(replayResolutions, 0);
    assert.equal(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'), receiptBytes);
  });

  await test('production sidecar heartbeat without adapter evidence stays unknown in result, receipt, event and replay', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    const original = xllm.invokeCodexAppServer;
    let providerInvocations = 0;
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    xllm.invokeCodexAppServer = async options => {
      providerInvocations++;
      options.onHeartbeat(43211);
      const error = new Error('fixture provider exit');
      error.code = 'provider-exit';
      throw error;
    };
    try {
      const result = await prep.prepareStandaloneTask(request, { announce });
      assert.equal(result.reason_code, 'provider-exit');
      assert.equal(result.provider_called, 'unknown');
      assert.deepStrictEqual(identityLines.map(line => line.match(/^\[forge-sidecar\] (\w+)/)[1]), ['solicitado', 'iniciado', 'falhou']);
      assert(identityLines.every(line => line.includes('fase=research')));
      assert(identityLines[2].includes('causa=provider-exit provider_called=unknown'));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.failure.provider_called, 'unknown');
      const events = fs.readFileSync(path.join(request.contextRoot, '.gsd', 'forge', 'events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.event === 'sidecar-unit').at(-1).provider_called, 'unknown');
      const receiptBytes = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
      const replayLines = [];
      const replay = await prep.prepareStandaloneTask(request, { announce: require('./forge-sidecar-identity')
        .createAnnouncer({ write: line => replayLines.push(line) }) });
      assert.equal(replay.replayed, true);
      assert.equal(replay.provider_called, false);
      assert.equal(replay.original_provider_called, 'unknown');
      assert.equal(replayLines.length, 1);
      assert.match(replayLines[0], /^\[forge-sidecar\] reaproveitado /);
      assert.equal(providerInvocations, 1);
      assert.equal(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'), receiptBytes);
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('production sidecar separates output validation from publication conflict', async () => {
    const original = xllm.invokeCodexAppServer;
    const invalid = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    xllm.invokeCodexAppServer = async options => {
      options.onHeartbeat(43212);
      return { finalText: JSON.stringify({ status: 'done', summary: 'Incomplete', questions: [], artifacts: [] }) };
    };
    try {
      const result = await prep.prepareStandaloneTask(invalid);
      assert.equal(result.diagnostic.stage, 'validation');
      assert.equal(result.provider_called, true);
    } finally { xllm.invokeCodexAppServer = original; }

    const conflict = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    xllm.invokeCodexAppServer = async options => {
      options.onHeartbeat(43213);
      fs.mkdirSync(path.dirname(artifactPath(conflict)), { recursive: true });
      fs.writeFileSync(artifactPath(conflict), '# concurrent owner content\n');
      return { finalText: JSON.stringify(envelope(conflict)) };
    };
    try {
      const result = await prep.prepareStandaloneTask(conflict);
      assert.equal(result.reason_code, 'artifact-direct-write-detected');
      assert.equal(result.diagnostic.stage, 'validation');
      assert.equal(result.provider_called, true);
      assert.equal(JSON.parse(fs.readFileSync(`${conflict.resultFile}.receipt.json`, 'utf8')).phase, 'failed');
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('explicit native failure closes the started attempt without result parsing', async () => {
    const request = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    const started = await prep.startStandaloneTaskPreparation(request);
    const result = await prep.acceptStandaloneTaskPreparation(request, { route: started.route,
      nativeFailure: { reason_code: 'native-host-refused', provider_called: false } });
    assert.equal(result.reason_code, 'native-host-refused');
    assert.equal(result.provider_called, false);
    assert.equal(JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8')).phase, 'failed');

    const called = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    called.activeCapabilities = codexCapabilities();
    const calledStart = await prep.startStandaloneTaskPreparation(called);
    const invalidTelemetry = await prep.acceptStandaloneTaskPreparation(called, { route: calledStart.route,
      nativeFailure: { reason_code: 'native-provider-failed', provider_called: true } });
    assert.equal(invalidTelemetry.reason_code, 'native-preparation-telemetry-invalid');
    assert.equal(invalidTelemetry.provider_called, true);
    const calledReceipt = JSON.parse(fs.readFileSync(`${called.resultFile}.receipt.json`, 'utf8'));
    assert.equal(calledReceipt.failure.provider_called, true);
  });
  await test('standalone recovery disposes only independently attested original absence and exposes no executable first handoff', async () => {
    const h = require('./forge-recovery-transition.test');
    const f = await h.candidateFixture(true, false);
    try {
      await assert.rejects(h.recoverPublic(f, {}, { transitionAdapter: h.adapter(f, { attestHistory: challenge => ({
        binding_sha256: require('./forge-code-roots').digest(challenge), history: f.history,
        history_sha256: require('./forge-code-roots').digest(f.history), evidence_reference: 'current-json',
        provenance_reference: 'no-original-observation', original_provenance: 'unknown' }) }) }), /original-absence-unproved/);
      const result = await h.recoverPublic(f);
      assert.equal(result.action, 'reattest-native-handoff'); assert.equal(result.provider_called, false);
      assert.equal(result.invocation, undefined); assert.equal(result.result?.invocation, undefined);
      const state = h.assertHistoryPreserved(f);
      assert.equal(state.reservations.length, 1); assert.equal(state.transitions.length, 1);
      assert(!fs.existsSync(path.join(f.owner, prep.requiredArtifact(f.raw))));
      assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).phase, 'failed');
      assert.equal(f.request.milestoneId, undefined);
    } finally { f.cleanup(); }
  });
}

main().finally(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
});
