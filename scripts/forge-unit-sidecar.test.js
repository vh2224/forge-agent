'use strict';
// A selector runs exactly one recovery scenario; no arguments retain full coverage.
const scenarioSelectors = ['--review-fix-recovery', '--delivery-publication-limits', '--recovery-contracts', '--pre-spawn-sidecar', '--pre-spawn-native', '--no-progress-event', '--owner-event-reconcile', '--ceiling-route', '--claude-session', '--claude-resume', '--liveness-heartbeat', '--memory-evidence'];
const scenarioArgs = process.argv.slice(2);
if (scenarioArgs.length > 1 || (scenarioArgs.length === 1 && !scenarioSelectors.includes(scenarioArgs[0]))) {
  console.error(`Usage: node forge-unit-sidecar.test.js [${scenarioSelectors.join('|')}]`);
  process.exit(1);
}
const selectedScenario = scenarioArgs[0];
const assert = require('assert');
const { inspectArtifacts, schema } = require('./forge-unit-sidecar');
const result = questions => ({ status: 'partial', summary: 'Decision needed', questions, artifacts: [] });
const inspect = questions => inspectArtifacts(result(questions), [], [], Infinity, {}, { forbidArtifactsOnNonDone: true });
assert(inspect(['Legacy question?']).ok);
assert(inspect([{ id: 'decision', question: 'Which source?' }]).ok);
assert(schema.properties.questions.items.anyOf.some(row => row.type === 'object' && row.additionalProperties === false));
for (const value of [null, [], {}, { id: '', question: 'Q' }, { id: 'x', question: '' }, { id: 'x', question: 'Q', answer: 'forged' }, { id: 1, question: 'Q' }]) {
  assert.strictEqual(inspect([value]).reason, 'schema-invalid', JSON.stringify(value));
}
const limit = 16 * 1024;
assert(inspect(['a'.repeat(limit)]).ok);
assert.strictEqual(inspect(['a'.repeat(limit + 1)]).reason, 'payload-limit');
const overhead = Buffer.byteLength(JSON.stringify({ id: 'x', question: '' }));
assert(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead) }]).ok);
assert.strictEqual(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead + 1) }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x'.repeat(limit), question: 'Q' }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x', question: String.fromCodePoint(0x1f600).repeat(limit / 4) }]).reason, 'payload-limit');
assert.strictEqual(inspect(Array(33).fill('Q')).reason, 'payload-limit');
assert.strictEqual(inspectArtifacts({ ...result([{ id: 'x', question: 'Q' }]), status: 'done' }, [], []).reason, 'questions-on-done');
assert.strictEqual(inspectArtifacts(result([{ id: 'x', question: 'Q' }]), [], [], 1).reason, 'payload-limit');
console.log('stable-ID and legacy questions: strict schema, UTF-8 bytes, count, total payload and done invariants passed');

// Recovery must use the delivery contract of the actual unit, not execute's.
const sidecar = require('./forge-unit-sidecar');
{
  const fixtures = require('./forge-loop-failure.test'), f = fixtures.fixture();
  try {
    const consumed = fixtures.consume(f), entered = fixtures.invoke(f, 'reenter', consumed.snapshot, fixtures.entryInput(f, consumed));
    const linked = { ...f.request, route: { ...f.request.route, resolved_worker_engine: 'claude' }, linked_begin_key: entered.controller_result.details.transaction.idempotency_key };
    assert.throws(() => sidecar.validateRecoveryRequest({ ...linked, linkedEntryBinding: {}, approved: true }), /binding|required/);
    assert.strictEqual(sidecar.validateRecoveryRequest(linked, { linkedEntryOptions: { ...fixtures.liveOptions(f), ownerToken: f.input.owner_token } }).mode, 'plan');
  } finally { fixtures.cleanup(f); }
}
function resolveContext(request) {
  request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
    milestoneId: request.milestoneId, unitId: request.taskId || request.sliceId || request.milestoneId,
    planPath: request.planFile, roadmapPath: request.roadmapFile, hostRuntime: 'codex' });
  return request;
}
assert.strictEqual(typeof sidecar.validateRecoveryRequest, 'function');
const research = { unitType: 'research-milestone', milestoneId: 'M001', route: {
  resolved_worker_engine: 'claude', worker_mode: 'sidecar', dispatch_allowed: true } };
assert.strictEqual(sidecar.validateRecoveryRequest(research).mode, 'artifacts');
assert.strictEqual(sidecar.validateRecoveryRequest({ ...research, unitType: 'plan-slice', sliceId: 'S01' }).mode, 'plan');
assert.strictEqual(sidecar.locations({ ...research, unitType: 'execute-task', sliceId: 'S01', taskId: 'T01' }).required[0],
  '.gsd/milestones/M001/slices/S01/tasks/T01/T01-SUMMARY.md');

async function recoveryContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
  const recovery = require('./forge-attempt-recovery'), xllm = require('./forge-xllm');
  const lab = fixtures.fixture();
  const runExecute = xllm.runExecute, runPlan = xllm.runPlan;
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, route,
    workflowId: 'fixture', dispatchId: 'baseline', resultFile: path.join(lab.dir, 'r.json'), prompt: 'Fixture only.',
    verification: { preferenceCommands: ['node --version'] } };
  const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
  fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
  resolveContext(request);
  const runs = require('./forge-runs');
  request.runId = 'fixture-run';
  request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
    paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
  request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
  runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
  let calls = 0;
  try {
    fs.writeFileSync(path.join(lab.a, 'preexisting.txt'), 'foreign baseline\n');
    // A legacy executor receipt is still a possible writer when fields vanish.
    const legacyFile = path.join(lab.dir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ phase: 'failed', provider_called: false }));
    assert.strictEqual(recovery.inspectReceipt(legacyFile, { request }).writer_possible, true);
    assert.strictEqual(recovery.inspectReceipt(legacyFile).writer_possible, 'unknown');
    assert.throws(() => sidecar.reconcileMilestoneAttempt(request, JSON.parse(fs.readFileSync(legacyFile))), /baseline-required/);
    const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase: 'execute-task', forgeHome: path.resolve(__dirname, '..') });
    for (const prompt of ['<!-- forge-procedure:core -->', '[DATA FROM "CUSTOM"]\nopen']) {
      const invalid = { ...request, prompt, dispatchId: 'invalid-composition', resultFile: path.join(lab.dir, 'invalid-composition.json') };
      await assert.rejects(sidecar.runUnitSidecar(invalid), /composition|DATA envelope/);
      assert(!fs.existsSync(invalid.resultFile + '.receipt.json'), 'invalid composition precedes receipt and provider');
    }
    xllm.runExecute = async options => {
      calls++;
      assert.strictEqual(options.scope, 'milestone');
      assert.strictEqual(options.cwd, fs.realpathSync(lab.a));
      assert.strictEqual(options.procedureContext.procedureText, procedure.content);
      assert.deepStrictEqual(options.procedureContext.procedure_context.modules.map(row => row.id), ['core', 'verification', 'execution']);
      const receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
      assert(receipt.recovery_baseline, 'durable caller baseline must precede provider');
      assert.strictEqual(receipt.recovery_baseline.protected_roots.length, 2);
      fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker a\n');
      fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker b\n');
      throw Object.assign(Error('timeout fixture'), { code: 'claude-timeout' });
    };
    for (const incomplete of [route, { ...request.route, resolution_context: { ...request.route.resolution_context, unit_id: 'T99' } }]) {
      const missingContext = { ...request, route: incomplete, dispatchId: 'missing-context', resultFile: path.join(lab.dir, 'missing-context.json') };
      await assert.rejects(sidecar.runUnitSidecar(missingContext), /milestone-resolver-context-required/);
      assert.strictEqual(calls, 0, 'milestone context refusal precedes provider');
      assert(!fs.existsSync(missingContext.resultFile + '.receipt.json'));
    }
    const refused = { ...request, dispatchId: 'blocked-baseline', resultFile: path.join(lab.dir, 'blocked.json') };
    fs.writeFileSync(refused.resultFile + '.reset-state.json', '{}');
    await assert.rejects(sidecar.runUnitSidecar(refused), /baseline-already-exists/);
    assert.strictEqual(calls, 0, 'baseline persistence refusal precedes provider');
    await assert.rejects(sidecar.runUnitSidecar(request), /timeout fixture/);
    assert.strictEqual(calls, 1);
    let receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
    assert(receipt.recovery_baseline && receipt.phase === 'failed');
    const stateFile = request.resultFile + '.recovery.json';
    await assert.rejects(sidecar.recoverUnitSidecar(request, { stateFile, receiptFile: request.resultFile + '.receipt.json' },
      { processProbe: () => 'alive' }), /process-receipt-inspection/);
    await assert.rejects(sidecar.recoverUnitSidecar(request, { stateFile, receiptFile: request.resultFile + '.receipt.json' },
      { processProbe: () => 'stopped' }), /writer-reconciliation/);
    assert.strictEqual(calls, 1, 'unknown ownership cannot start another provider');
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'worker a\n');
    const partial = sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: observed =>
      observed.root_id === 'alpha' && observed.path === 'same.txt' });
    assert.strictEqual(partial.ok, false, 'one pending root keeps the attempt unreconciled');
    assert.strictEqual(fs.readFileSync(path.join(lab.b, 'same.txt'), 'utf8'), 'worker b\n');
    const reset = sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: observed =>
      observed.attempt === request.dispatchId && ['alpha', 'beta'].includes(observed.root_id) && observed.path === 'same.txt' });
    assert.strictEqual(reset.ok, true, JSON.stringify(reset));
    assert.deepStrictEqual(reset.roots.map(row => row.root_id), ['alpha', 'beta']);
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.b, 'same.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'preexisting.txt'), 'utf8'), 'foreign baseline\n');
    // A procedural segment must not manufacture a prepared execution context:
    // xllm uses its presence to select historical budgeting/schema semantics.
    xllm.runExecute = async options => {
      assert.strictEqual(options.executionContext, undefined);
      assert.strictEqual(options.procedureContext.procedureText, procedure.content);
      assert.deepStrictEqual(options.procedureContext.procedure_context.modules, procedure.modules);
      throw Error('legacy context boundary inspected');
    };
    const originalPlan = fs.readFileSync(request.planFile);
    try {
      fs.writeFileSync(request.planFile, fixtures.plan(roots.singleContract(lab.owner, lab.a)));
      await assert.rejects(sidecar.runUnitSidecar(resolveContext({ ...request, execution_contract: undefined,
        dispatchId: 'legacy-context', resultFile: path.join(lab.dir, 'legacy-context.json') })), /legacy context boundary inspected/);
    } finally { fs.writeFileSync(request.planFile, originalPlan); }
    // Exercise the actual nativeOptions closure with the recovery controller
    // substituted at its boundary. This exercises composition/the adapter;
    // recovery authority and end-to-end recovery are not exercised here.
    const recoverAttempt = recovery.recoverAttempt;
    const nativeRoute = { ...route, worker_mode: 'native', host_runtime: 'codex', resolved_worker_engine: 'codex', worker_engine: 'codex',
      model: 'gpt-6-sol', model_resolved: 'gpt-6-sol', config_ok: true };
    const capabilities = { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
    const customFile = path.join(lab.dir, 'custom-prompt.md');
    fs.writeFileSync(customFile, 'Custom recovery prompt');
    const artifact = require('./forge-prompt').materializePrompt({ cwd: lab.owner, codeDir: lab.a, forgeHome: path.resolve(__dirname, '..'),
      unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', dispatchId: 'recovery-doublepass', autoCommit: false });
    const recoverCustom = patch => sidecar.recoverUnitSidecar({ ...request, prompt: undefined, ...patch }, {}, { activeCapabilities: capabilities });
    try {
      recovery.recoverAttempt = async options => options.validateInvocation(nativeRoute);
      for (const patch of [{ prompt: 'Custom recovery prompt' }, { promptFile: customFile }, { promptFile: artifact.prompt_path }]) {
        const invocation = await recoverCustom(patch);
        assert.strictEqual(invocation.ok, true, JSON.stringify(invocation));
        assert(invocation.args.message.includes(procedure.content));
        for (const id of ['core', 'verification', 'execution']) assert.strictEqual(invocation.args.message.split(`<!-- forge-procedure:${id} -->`).length - 1, 1);
      }
      for (const unitType of ['complete-slice', 'complete-milestone']) {
        const completion = require('./forge-prompt').renderPrompt({ cwd: lab.owner, codeDir: lab.a,
          forgeHome: path.resolve(__dirname, '..'), unitType, milestoneId: 'M001', sliceId: 'S01', autoCommit: false });
        const expected = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase: unitType,
          forgeHome: require('path').resolve(__dirname, '..') });
        // The actual recovery nativeOptions closure and real native adapter are
        // exercised; only the recovery controller is replaced at its boundary.
        const invocation = await recoverCustom({ unitType, phase: 'complete', prompt: completion.prompt,
          procedure_context: completion.procedure_context });
        assert.strictEqual(invocation.ok, true, JSON.stringify(invocation));
        assert(invocation.args.message.includes(expected.content));
        assert(invocation.args.message.includes('FORGE_SCRIPTS_DIR: '));
        for (const id of ['core', 'verification', 'completion', 'recovery']) {
          assert.strictEqual(invocation.args.message.split(`<!-- forge-procedure:${id} -->`).length - 1, 1);
        }
        const bad = completion.prompt.replace('Never integrate;', 'Always integrate;');
        await assert.rejects(recoverCustom({ unitType, phase: 'complete', prompt: bad,
          procedure_context: completion.procedure_context }), /composition/);
      }
      const { content, ...metadata } = procedure;
      for (const prompt of ['<!-- forge-procedure:core -->', '[DATA FROM "CUSTOM"]\nopen',
        '[DATA FROM "CUSTOM"]\n' + content + '\n[END DATA]', '[DATA FROM "A"]\nvalue\n[END DATA FROM "B"]']) {
        await assert.rejects(recoverCustom({ prompt, procedure_context: metadata }), /composition|DATA envelope/);
        fs.writeFileSync(customFile, prompt);
        await assert.rejects(recoverCustom({ promptFile: customFile, procedure_context: metadata }), /composition|DATA envelope/);
      }
    } finally { recovery.recoverAttempt = recoverAttempt; }
    let nativeCalls = 0;
    await assert.rejects(sidecar.recoverUnitSidecar({ ...request, execution_contract: undefined },
      { stateFile, receiptFile: request.resultFile + '.receipt.json', correction: true },
      { processProbe: () => 'stopped', invokeNative() { nativeCalls++; } }), /held-claim-required/);
    for (const patch of [{ active: false }, { write_claim: { ...request.claim, released: true } },
      { write_claim: { ...request.claim, generation: 'replacement' } }]) {
      runs.update(lab.owner, request.runId, patch);
      for (const mode of [{ correction: true }, { transitions: [{ type: 'resolver-context-omission', reference: 'fixture:claim-negative' }] }]) {
        await assert.rejects(sidecar.recoverUnitSidecar({ ...request, prompt: 'repaired packaging' },
          { stateFile, receiptFile: request.resultFile + '.receipt.json', ...mode },
          { processProbe: () => 'stopped', invokeNative() { nativeCalls++; } }), /claim-generation-stale/);
      }
      runs.update(lab.owner, request.runId, { active: true, write_claim: request.claim });
    }
    assert.strictEqual(nativeCalls, 0, 'released/replaced/inactive live authority never reaches another writer');
    for (const [patch, error] of [
      [{ claim: { ...request.claim, released: true } }, /held-claim-required/],
      [{ gates: { ...request.gates, claim: 'blocked' } }, /gates-required/],
      [{ gates: { ...request.gates, plan: 'approved', planSkipReason: undefined } }, /plan-gate-required/],
    ]) assert.throws(() => sidecar.validateRecoveryRequest({ ...request, ...patch }), error);
    const narrower = { ...request.claim, paths: [{ root_id: 'alpha', path: 'same.txt' }] };
    runs.update(lab.owner, request.runId, { write_claim: narrower });
    assert.throws(() => sidecar.validateRecoveryRequest({ ...request, claim: narrower }), /held-claim-mismatch/);
    runs.update(lab.owner, request.runId, { write_claim: request.claim });
    const changed = structuredClone(receipt); changed.recovery_baseline.state_sha256 = 'forged';
    assert.throws(() => sidecar.reconcileMilestoneAttempt(request, changed, { verifyOwnership: () => true }), /baseline-binding/);
    assert.strictEqual(sidecar.milestonePlanFile(request), request.planFile);
    const legacy = path.join(base, 'tasks/T01-PLAN.md');
    fs.renameSync(request.planFile, legacy);
    assert.strictEqual(sidecar.milestonePlanFile({ ...request, planFile: legacy }), legacy, 'explicit legacy read only');
    fs.copyFileSync(legacy, request.planFile);
    assert.throws(() => sidecar.milestonePlanFile(request), /legacy-task-plan-conflict/);
    fs.unlinkSync(legacy);

    // R8: valid owner corpus cannot shadow the physical code corpus.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/forge-procedures.json')));
    for (const folder of [lab.a, lab.owner]) {
      fs.mkdirSync(path.join(folder, 'shared'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'shared/forge-procedures.json'), JSON.stringify(manifest));
      for (const module of manifest.modules.filter(row => row.status === 'ready'))
        fs.copyFileSync(path.join(__dirname, '..', module.path), path.join(folder, module.path));
    }
    const originalClaude = xllm.invokeClaudeTransport;
    let entered = 0, sent;
    try {
      xllm.invokeClaudeTransport = async options => {
        entered++; sent = options.prompt;
        return { candidate: { status: 'partial', summary: 'synthetic', questions: [], artifacts: [] } };
      };
      xllm.runPlan = async options => {
        entered++; sent = fs.readFileSync(options.planContextFile, 'utf8');
        return { status: 'partial', task_plans: [], slice_plan: { content: '# Fixture' } };
      };
      let attempt = 0;
      for (const input of ['prompt', 'promptFile', 'planContextFile', 'rendered']) {
        const phase = input === 'planContextFile' ? 'plan-slice' : 'research-milestone';
        const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase });
        const modulePath = path.join(lab.a, procedure.modules[procedure.modules.length - 1].path);
        const bytes = fs.readFileSync(modulePath);
        for (const change of ['missing', 'changed-hash', 'tampered-body', 'tampered-materialized', 'plain', 'composed', 'materialized']) {
          if (input === 'rendered' && ['tampered-body', 'tampered-materialized', 'composed', 'materialized'].includes(change)) continue;
          const id = 'procedure-boundary-' + attempt++;
          let body = ['composed', 'tampered-body', 'tampered-materialized', 'materialized'].includes(change) ? 'fixture\n' + procedure.content : 'fixture';
          const { content, ...metadata } = procedure;
          if (['materialized', 'tampered-materialized'].includes(change)) body = '---\nprocedure_context: ' + JSON.stringify(metadata)
            + '\nfinal_prompt_sha256: ' + JSON.stringify(crypto.createHash('sha256').update(body).digest('hex')) + '\n---\n\n' + body;
          if (['tampered-body', 'tampered-materialized'].includes(change)) body = body.replace('Forge mandatory procedure core', 'TAMPERED core');
          const file = path.join(lab.dir, id + '.md'); fs.writeFileSync(file, body);
          const probe = { ...request, unitType: phase, phase: 'research', taskId: undefined, description: 'Synthetic research fixture',
            sliceId: phase === 'plan-slice' ? 'S01' : undefined, execution_contract: undefined,
            prompt: input === 'prompt' ? body : undefined, promptFile: ['promptFile', 'planContextFile'].includes(input) ? file : undefined,
            procedure_context: ['composed', 'tampered-body'].includes(change) ? metadata : undefined,
            dispatchId: id, resultFile: path.join(lab.dir, id + '.json') };
          const previous = entered;
          resolveContext(probe);
          try {
            if (change === 'missing') fs.unlinkSync(modulePath);
            if (change === 'changed-hash') fs.appendFileSync(modulePath, '\ntampered');
            if (['missing', 'changed-hash', 'tampered-body', 'tampered-materialized'].includes(change)) {
              await assert.rejects(sidecar.runUnitSidecar(probe), error => /^procedure-/.test(error.code), input + '/' + change);
              assert.strictEqual(entered, previous, 'invalid corpus/body stops before transport');
            } else {
              await sidecar.runUnitSidecar(probe);
              assert.strictEqual(entered, previous + 1);
              assert(sent.includes(procedure.content));
              for (const module of procedure.modules) assert.strictEqual(sent.split(`<!-- forge-procedure:${module.id} -->`).length - 1, 1);
              assert(!sent.startsWith('---'), 'materialized metadata removed');
            }
          } finally { fs.writeFileSync(modulePath, bytes); }
        }
      }
      console.log('R8 artifact/plan boundary: physical corpus, missing/hash/body failures and fresh single composition passed');
    } finally { xllm.invokeClaudeTransport = originalClaude; xllm.runPlan = runPlan; }

    // Plan publication creates the exact source consumed by discovery/execution.
    const planning = { ...request, unitType: 'plan-slice', phase: 'plan', taskId: undefined, execution_contract: undefined,
      promptFile: request.planFile, dispatchId: 'plan', resultFile: path.join(lab.dir, 'p.json') };
    const rejectedPlan = { status: 'done', summary: 'local-only explanation',
      slice_plan: { content: '# Slice\n- [ ] T03: mismatch\n' },
      task_plans: [{ id: 'T02', content: fixtures.plan(lab.contract) }],
      transport_telemetry: { model_observed: 'fixture-model' } };
    const mismatch = { ...planning, dispatchId: 'plan-mismatch', resultFile: path.join(lab.dir, 'mismatch.json') };
    xllm.runPlan = async () => rejectedPlan;
    await assert.rejects(sidecar.runUnitSidecar(resolveContext(mismatch)), /plan-task-list-mismatch/);
    const rejectedBytes = fs.readFileSync(mismatch.resultFile + '.returned.json');
    const failedPlan = JSON.parse(fs.readFileSync(mismatch.resultFile + '.receipt.json'));
    assert.deepStrictEqual(JSON.parse(rejectedBytes).result, rejectedPlan);
    assert.strictEqual(failedPlan.phase, 'failed');
    assert.strictEqual(failedPlan.result, undefined);
    assert.strictEqual(failedPlan.returned_response.sha256, crypto.createHash('sha256').update(rejectedBytes).digest('hex'));
    assert.deepStrictEqual(failedPlan.plan_task_diagnostic.listed_ids, ['T03']);
    assert.deepStrictEqual(failedPlan.plan_task_diagnostic.returned_ids, ['T02']);
    assert.strictEqual(failedPlan.telemetry.model_observed, 'fixture-model');
    assert(!fs.existsSync(path.join(base, 'tasks/T02/T02-PLAN.md')));
    await assert.rejects(sidecar.runUnitSidecar(mismatch), error => error.code === 'plan-task-list-mismatch');
    assert(fs.readFileSync(mismatch.resultFile + '.returned.json').equals(rejectedBytes));
    assert(!fs.readFileSync(mismatch.resultFile, 'utf8').includes('local-only explanation'));
    xllm.runPlan = async () => ({ status: 'done', slice_plan: { content: '# Slice\n- [ ] **T02** — fixture\n' },
      task_plans: [{ id: 'T02', content: fixtures.plan(lab.contract) }] });
    await sidecar.runUnitSidecar(resolveContext(planning));
    const canonicalPlan = path.join(base, 'tasks/T02/T02-PLAN.md');
    assert(fs.existsSync(canonicalPlan));
    assert(!fs.existsSync(path.join(base, 'tasks/T02-PLAN.md')));
    assert(require('./forge-parallelism').discoverTasks(base).some(task => task.id === 'T02' && task.planPath === canonicalPlan));
    assert.strictEqual(sidecar.milestonePlanFile({ ...request, taskId: 'T02', planFile: canonicalPlan }), canonicalPlan);
    // Offline research correction exercises the real recovery caller without
    // touching execution.prepare or requiring an execution contract.
    const readonly = { ...request, unitType: 'research-milestone', phase: 'research', sliceId: undefined, taskId: undefined,
      execution_contract: undefined, planFile: undefined, dispatchId: 'research', resultFile: path.join(lab.dir, 'q.json'),
      route: { ...route, resolved_worker_engine: 'codex', worker_engine: 'codex', worker_mode: 'native',
        model: 'gpt-5.6-sol', model_resolved: 'gpt-5.6-sol', config_ok: true,
        chain: [{ id: 'gpt-5.6-sol', engine: 'gpt' }] } };
    const replayable = { ...readonly, route, dispatchId: 'saved-replay', resultFile: path.join(lab.dir, 'saved.json') };
    sidecar.beginArtifactAttempt(replayable);
    const candidate = { status: 'partial', summary: 'Saved fixture response', questions: [], artifacts: [] };
    await sidecar.acceptArtifactResult(replayable, candidate, { providerCalled: true });
    const replayReceipt = replayable.resultFile + '.receipt.json', replayState = replayable.resultFile + '.recovery.json';
    recovery.captureFailure({ stateFile: replayState, receiptFile: replayReceipt, request: replayable,
      unit: 'research-milestone/M001', route: replayable.route, error: { code: 'publication-interrupted' } });
    const replayOptions = { stateFile: replayState, receiptFile: replayReceipt, environmentalCorrection: true };
    const replayRuntime = { processProbe: () => 'stopped',
      inspectPreSpawn() { throw Error('saved response must not use pre-spawn repair'); } };
    assert.strictEqual((await sidecar.recoverUnitSidecar(replayable, replayOptions, replayRuntime)).action, 'replay');
    const savedReceipt = JSON.parse(fs.readFileSync(replayReceipt));
    fs.writeFileSync(replayReceipt, JSON.stringify({ ...savedReceipt, phase: 'failed', saved_candidate: {
      result: candidate, sha256: roots.digest(JSON.stringify(candidate)) } }));
    await assert.rejects(sidecar.recoverUnitSidecar(replayable, replayOptions, replayRuntime), /artifact-reconciliation-required/,
      'saved candidates take canonical reconciliation, never pre-spawn repair');
    sidecar.beginArtifactAttempt(readonly);
    sidecar.failArtifactAttempt(readonly, 'context-budget-exceeded', 'adapter-failed', false);
    const executeApi = require('./forge-task-execution'), prepare = executeApi.prepare;
    executeApi.prepare = () => { throw Error('research must not execute.prepare'); };
    try {
      const changedRequest = { ...readonly, prompt: 'Corrected fixture only.' };
      const recovered = await sidecar.recoverUnitSidecar(changedRequest, {
        stateFile: readonly.resultFile + '.recovery.json', receiptFile: readonly.resultFile + '.receipt.json', correction: true }, {
        activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-5.6-sol'],
          reasoning_efforts: ['medium'], fork_turns: ['none'] } });
      assert(recovered.corrected);
      assert.strictEqual(recovered.result.action, 'invoke-native');
      assert.strictEqual((recovered.result.invocation.args.message.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      assert(recovered.result.invocation.args.message.includes('<!-- forge-procedure:recovery -->'));
      const artifact = require('./forge-prompt').materializePrompt({ cwd: lab.owner, codeDir: lab.a, forgeHome: path.resolve(__dirname, '..'),
        unitType: 'research-milestone', milestoneId: 'M001', description: 'Synthetic ultraviolet research', dispatchId: 'research-materialized-recovery' });
      const materializedRequest = { ...readonly, prompt: 'Original broken packaging', promptFile: artifact.prompt_path,
        dispatchId: 'research-materialized', resultFile: path.join(lab.dir, 'materialized.json') };
      sidecar.beginArtifactAttempt(materializedRequest);
      sidecar.failArtifactAttempt(materializedRequest, 'context-budget-exceeded', 'adapter-failed', false);
      const original = fs.readFileSync(artifact.prompt_path, 'utf8');
      const correctedArtifact = original.replace('## ', '## Offline repaired ');
      // A tampered artifact refuses its recorded hash, even with imported markers.
      fs.writeFileSync(artifact.prompt_path, correctedArtifact);
      const caps = { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-5.6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
      await assert.rejects(sidecar.recoverUnitSidecar({ ...materializedRequest, prompt: undefined }, {
        stateFile: materializedRequest.resultFile + '.recovery.json', receiptFile: materializedRequest.resultFile + '.receipt.json', correction: true },
        { activeCapabilities: caps }), /inconsistent metadata or body hash/);
      fs.writeFileSync(artifact.prompt_path, original);
      const materialized = await sidecar.recoverUnitSidecar({ ...materializedRequest, prompt: undefined }, {
        stateFile: materializedRequest.resultFile + '.recovery.json', receiptFile: materializedRequest.resultFile + '.receipt.json', correction: true },
        { activeCapabilities: caps });
      const finalPrompt = materialized.result.invocation.args.message;
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:preparation -->/g) || []).length, 1);
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:recovery -->/g) || []).length, 1);
      assert(finalPrompt.includes('<!-- forge-procedure:recovery -->'));

    } catch (error) {
      assert.notStrictEqual(error.message, 'research must not execute.prepare');
      // Never contact a real service for the fixture.
      throw error;
    } finally { executeApi.prepare = prepare; }
    console.log('PASS milestone baseline before provider, stripped legacy receipt, live/unknown writer, two-root trusted reset, tampering and canonical plan publication');
  } finally { xllm.runExecute = runExecute; xllm.runPlan = runPlan; lab.cleanup(); }
}
async function preSpawnRecoveryContracts(nativeInitial = false) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
  const recovery = require('./forge-attempt-recovery'), reset = require('./forge-surgical-reset');
  const lease = require('./forge-unit-lease'), runs = require('./forge-runs');
  const lab = fixtures.fixture();
  const contract = roots.validateContract({ ...lab.contract, code_roots: [lab.contract.code_roots[0]] });
  const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_engine: 'claude',
    worker_mode: 'sidecar', model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    dispatch_allowed: true, config_ok: true,
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-6.1-sol', engine: 'gpt' }] };
  if (nativeInitial) Object.assign(route, { resolved_worker_engine: 'codex', worker_engine: 'codex', worker_mode: 'native',
    model: 'gpt-6-sol', model_resolved: 'gpt-6-sol',
    chain: [{ id: 'gpt-6-sol', engine: 'gpt' }, { id: 'gpt-6.1-sol', engine: 'gpt' }] });
  const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  const planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  fs.writeFileSync(planFile, fixtures.plan(contract));
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** fixture\n');
  const request = { unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, route, workflowId: 'fixture', dispatchId: 'before-spawn',
    resultFile: path.join(lab.dir, 'pre-spawn.json'), planFile, prompt: 'Offline fixture only.' };
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract,
    paths: [{ root_id: 'alpha', path: 'same.txt' }] };
  if (nativeInitial) request.execution_contract = contract;
  const executionAuthority = { execution_contract: contract, claim, runId: 'pre-spawn-run',
    gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' } };
  runs.add(lab.owner, { id: executionAuthority.runId, kind: 'milestone', session_id: 'fixture', write_claim: claim });
  const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
  const baselineFile = path.join(lab.dir, 'original-predispatch.json');
  fs.writeFileSync(baselineFile, JSON.stringify(reset.captureAttemptSnapshot(lab.a)));
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: request.dispatchId,
    fingerprint: sidecar.artifactFingerprint(request), recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))),
    failure: { reason_code: 'execution-protected-snapshot-unstable', provider_called: false } }));
  const initial = recovery.captureFailure({ stateFile, receiptFile, request, unit: 'execute-task/T01', route, contract: nativeInitial ? contract : undefined,
    error: { code: 'execution-protected-snapshot-unstable', provider_called: false }, layer: 'protected-snapshot' });
  // v2 state has no cumulative clock: run past the old 60000 ms window to prove
  // recovery is not stopped by elapsed time (the former deadline_at + 1).
  assert.strictEqual(initial.schema_version, 2); assert.strictEqual(initial.deadline_at, undefined);
  const now = initial.started_at + 60001;
  const receiptBytes = fs.readFileSync(receiptFile), baselineBytes = fs.readFileSync(baselineFile), stateBytes = fs.readFileSync(stateFile);
  const held = lease.acquire(lab.owner, initial.unit, { hostRuntime: 'codex', ownerToken: 'fixture-owner', ttlMs: 300000 });
  let window = lease.openProtectedWindow(lab.owner, initial.unit, held.owner_token, held.generation, { durationMs: 300000 });
  let calls = 0, stageCalls = 0, deltaCalls = 0;
  const authority = recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() }));
  const runtime = {
    executionAuthority, activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-6-sol', 'gpt-6.1-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] },
    processProbe: () => 'stopped',
    inspectPreSpawn: async challenge => { stageCalls++; return { binding_sha256: roots.digest(challenge), stage: 'before-provider-spawn', process: 'stopped',
      process_reference: 'fixture:awaited-adapter-exit', stage_reference: 'fixture:observed-stack-before-spawn',
      baseline: { path: baselineFile, sha256: roots.digest(baselineBytes), provenance_reference: 'fixture:captured-before-failure' } }; },
    inspectPreSpawnDelta: async challenge => { deltaCalls++; return { binding_sha256: roots.digest(challenge),
      classification: 'no-failed-worker-writes', evidence_reference: 'fixture:independent-all-root-journal' }; },
    validateEnvironmentalCorrection: async challenge => ({ binding_sha256: roots.digest(challenge), ok: true,
      repair: 'bounded-held-lease-window', lease_window: window, evidence_reference: 'fixture:lease-test',
      offline_check: { command: 'node scripts/forge-unit-lease.test.js', passed: true, exit_code: 0 } }),
    resolveDispatch: () => ({ ...route, chain: route.chain, source: 'fixture-resolver' }),
    recoveryAuthorization: { reference: 'fixture:standing', adapter: {
      readStandingAuthorization: () => ({ expires_at: now + 100000 }),
      issueRecoveryException: (reference, scope) => authority.issue(reference, scope, () => now) } },
    invokeNative: async (next, binding) => { calls++; assert.strictEqual(next.route.model, 'gpt-6.1-sol');
      assert.strictEqual(binding.args.model, 'gpt-6.1-sol');
      assert(binding.args.message.includes('<!-- forge-procedure:recovery -->'));
      assert.strictEqual((binding.args.message.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      return { fixture_only: true, provider_contact: false }; },
  };
  const options = { stateFile, receiptFile, environmentalCorrection: true, clock: () => now };
  const invoke = (patch = {}, input = request, recoveryPatch = {}) => sidecar.recoverUnitSidecar(input, { ...options, ...recoveryPatch }, { ...runtime, ...patch });
  const restore = () => { fs.writeFileSync(stateFile, stateBytes); fs.writeFileSync(receiptFile, receiptBytes); fs.writeFileSync(baselineFile, baselineBytes); };
  const rejected = async (patch, expected, input) => { restore(); await assert.rejects(invoke(patch, input), expected); assert.strictEqual(calls, 0); };
  try {
    if (nativeInitial) {
      await rejected({ activeCapabilities: undefined }, /execution-route-incompatible/);
      await rejected({ activeCapabilities: { ...runtime.activeCapabilities, models: ['foreign'] } }, /execution-route-incompatible/);
      await rejected({ activeCapabilities: undefined }, /execution-route-incompatible/,
        { ...request, nativeInvocation: { ok: true, args: { model: 'gpt-6.1-sol' } }, approved: true });
    }
    await rejected({ inspectPreSpawn: undefined }, /inspector-required/);
    await rejected({ processProbe: () => 'alive' }, /process-receipt-inspection/);
    await rejected({ inspectPreSpawn: async () => ({ stage: 'before-provider-spawn', process: 'stopped', approved: true }) }, /unproved/);
    await rejected({ inspectPreSpawn: async c => ({ ...await runtime.inspectPreSpawn(c), stage: 'unknown' }) }, /unproved/);
    await rejected({ executionAuthority: { ...executionAuthority, claim: { ...claim, generation: 'foreign' } } }, /claim-generation-stale/);
    await rejected({ executionAuthority: { ...executionAuthority, execution_contract: lab.contract } }, /claim|root|writes/);
    await rejected({ inspectPreSpawn: async c => { c.roots[0].path = lab.b; return runtime.inspectPreSpawn(c); } }, /unproved/);
    await rejected({ inspectPreSpawn: async c => { fs.writeFileSync(receiptFile, '{}'); return runtime.inspectPreSpawn(c); } }, /inspection-changed/);
    await rejected({ inspectPreSpawn: async c => { fs.writeFileSync(stateFile, '{}'); return runtime.inspectPreSpawn(c); } }, /inspection-changed/);
    await rejected({ inspectPreSpawn: async c => ({ ...await runtime.inspectPreSpawn(c), baseline: { path: baselineFile, sha256: 'forged', provenance_reference: 'forged' } }) }, /baseline-binding/);
    await rejected({ inspectPreSpawnDelta: undefined }, /drift-unproved/);
    await rejected({ inspectPreSpawnDelta: async () => ({ independentChanges: true }) }, /drift-unproved/);
    await rejected({ validateEnvironmentalCorrection: async c => ({ ...await runtime.validateEnvironmentalCorrection(c), lease_window: JSON.parse(JSON.stringify(window)) }) }, /window-invalid/);
    await rejected({ validateEnvironmentalCorrection: async c => ({ ...await runtime.validateEnvironmentalCorrection(c), offline_check: { passed: true, exit_code: 0 } }) }, /repair-unproved/);
    await rejected({ validateEnvironmentalCorrection: async c => { fs.writeFileSync(path.join(lab.a, 'same.txt'), 'concurrent\n'); return runtime.validateEnvironmentalCorrection(c); } }, /inspection-changed/);
    fs.writeFileSync(path.join(lab.a, 'same.txt'), 'before\n');
    await rejected({ validateEnvironmentalCorrection: async c => { fs.writeFileSync(path.join(lab.owner, '.gsd/unrelated'), 'foreign'); return runtime.validateEnvironmentalCorrection(c); } }, /protected/);
    fs.unlinkSync(path.join(lab.owner, '.gsd/unrelated'));
    await rejected({}, /pre-spawn-binding/, { ...request, dispatchId: 'foreign' });
    for (const saved of nativeInitial ? [] : [{ phase: 'ready' }, { phase: 'failed', saved_candidate: { sha256: 'fixture' } }]) {
      restore(); fs.writeFileSync(receiptFile, JSON.stringify({ ...JSON.parse(receiptBytes), ...saved }));
      await assert.rejects(invoke({ inspectPreSpawn() { throw Error('replay must skip repair inspection'); } }), /identity-mismatch/,
        'legacy root migration applies only to proved pre-spawn repair, not unvalidated saved-response authority');
    }
    restore();
    const wrongFailure = JSON.parse(receiptBytes); wrongFailure.failure.reason_code = 'invalid-payload';
    fs.writeFileSync(receiptFile, JSON.stringify(wrongFailure));
    await assert.rejects(invoke(), /pre-spawn-binding/);
    restore();
    const changed = JSON.parse(receiptBytes); changed.pid = process.pid; fs.writeFileSync(receiptFile, JSON.stringify(changed));
    await assert.rejects(invoke(), /process-receipt-inspection/);
    restore();
    const pending = JSON.parse(stateBytes); pending.pending_questions = [{ id: 'human', question: 'Functional decision?', status: 'pending' }]; fs.writeFileSync(stateFile, JSON.stringify(pending));
    assert.strictEqual((await invoke()).action, 'pending-questions'); assert.strictEqual(calls, 0);
    restore();
    // Prove later HEAD/untracked/deleted/renamed deltas are presented explicitly.
    fs.writeFileSync(path.join(lab.a, 'repair.txt'), 'independent repair\n');
    fixtures.command('git', ['add', 'repair.txt'], lab.a); fixtures.command('git', ['commit', '-qm', 'independent fixture repair'], lab.a);
    fs.writeFileSync(path.join(lab.a, 'untracked.txt'), 'independent\n');
    fs.renameSync(path.join(lab.a, 'same.txt'), path.join(lab.a, 'renamed.txt'));
    let driftSeen = false;
    const handed = await invoke({ invokeNative: undefined, inspectPreSpawnDelta: async c => { driftSeen = c.vcs_drift
      && c.before.start_sha !== c.current.start_sha && c.current.pre_dirty.length >= 3 && c.claimed[0].sha256 === null;
      return runtime.inspectPreSpawnDelta(c); } });
    assert(driftSeen, 'all-root VCS delta and explicit missing claimed path reach independent inspector');
    assert.strictEqual(handed.result.action, 'reattest-native-handoff');
    assert.strictEqual(handed.result.invocation, undefined, 'pending reservation has no executable native arguments');
    assert.strictEqual(handed.action, 'reattest-native-handoff');
    assert.deepStrictEqual(Object.keys(handed).sort(), ['action', 'provider_called', 'reservation_sha256', 'result']);
    assert.deepStrictEqual(Object.keys(handed.result).sort(), ['action', 'provider_called', 'reservation_sha256']);
    assert(!JSON.stringify(handed).includes('invocation'), 'no nesting of the phase-one response exposes executable arguments');
    const resumeReservation = { sha256: handed.result.reservation_sha256 };
    await assert.rejects(invoke({ invokeNative: undefined }, request, { resumeReservation: { sha256: 'foreign' } }), /reservation-invalid/);
    await assert.rejects(invoke({ invokeNative: undefined, inspectPreSpawn: undefined }, request, { resumeReservation }), /inspector-required/);
    await assert.rejects(invoke({ invokeNative: undefined, activeCapabilities: { ...runtime.activeCapabilities, models: ['foreign'] } }, request, { resumeReservation }), /model|adapter|capability|route/);
    await assert.rejects(invoke({ invokeNative: undefined, resolveDispatch: () => ({ ...route, effort: 'high' }) }, request, { resumeReservation }), /provenance|route/);
    window.close();
    window = lease.openProtectedWindow(lab.owner, initial.unit, held.owner_token, held.generation, { durationMs: 300000 });
    const ready = await invoke({ invokeNative: undefined }, request, { resumeReservation });
    assert.strictEqual(ready.result.action, 'invoke-native');
    ready.result.assertReady();
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reservations.length, 1);
    await assert.rejects(invoke({ invokeNative: undefined }, request, { resumeReservation }), /reservation-invalid/);
    fs.writeFileSync(path.join(lab.a, 'untracked.txt'), 'changed after handoff\n');
    assert.throws(() => ready.result.assertReady(), /inspection-changed/);
    await assert.rejects(invoke(), /retry-exhausted/);
    assert.strictEqual(calls, 0, 'a reserved handoff cannot open another writer');
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reservations.length, 1);
    restore();
    const recovered = await invoke();
    assert.strictEqual(calls, 1); assert(recovered.corrected);
    assert.strictEqual(recovered.sidecar_ceiling, null, 'native recovery route carries no sidecar ceiling');
    assert.strictEqual(recovered.remaining_ms, undefined); assert.strictEqual(recovered.sidecar_remaining_ms, undefined);
    assert.strictEqual(recovered.result.result.provider_contact, false);
    const saved = JSON.parse(fs.readFileSync(stateFile));
    assert.strictEqual(saved.started_at, initial.started_at); assert.strictEqual(saved.schema_version, 2);
    assert.strictEqual(saved.budget, 'tier-ceiling'); assert.strictEqual(saved.deadline_at, undefined, 'no clock is written back');
    assert.strictEqual(saved.roots_sha256, initial.roots_sha256, 'original root identity is retained');
    assert.strictEqual(saved.reservations[0].correction.kind, 'environment');
    assert.deepStrictEqual(fs.readFileSync(receiptFile), receiptBytes); assert.deepStrictEqual(fs.readFileSync(baselineFile), baselineBytes);
    if (nativeInitial) {
      // Plain caller correction has possible-writer semantics. Capture an
      // actual current reset baseline, rather than reuse pre-spawn testimony.
      const original = { ...request, dispatchId: 'native-offline', resultFile: path.join(lab.dir, 'native-offline.json') };
      const correctionReceipt = original.resultFile + '.receipt.json', correctionState = original.resultFile + '.recovery.json';
      const resetFile = original.resultFile + '.reset-state.json';
      const resetState = reset.initState(resetFile, { cwd: lab.a, attempt: original.dispatchId, executionContract: contract });
      const { reconciliation, ...baseline } = resetState;
      const execution = require('./forge-task-execution');
      const receipt = { phase: 'failed', dispatch_id: original.dispatchId, fingerprint: sidecar.artifactFingerprint(original),
        recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(original))),
        failure: { reason_code: 'context-budget-exceeded', provider_called: false } };
      receipt.recovery_baseline = { schema_version: 1, state_file: resetFile, state_sha256: roots.digest(baseline),
        execution_contract: contract, fingerprint: receipt.fingerprint, dispatch_id: original.dispatchId,
        input: { path: planFile, sha256: roots.digest(fs.readFileSync(planFile)) },
        protected_owner: execution.protectedSnapshot(contract.owner),
        protected_roots: contract.code_roots.map(root => ({ root_id: root.id, path: root.path, snapshot: execution.protectedSnapshot(root.path) })) };
      fs.writeFileSync(correctionReceipt, JSON.stringify(receipt));
      const correction = recovery.captureFailure({ stateFile: correctionState, receiptFile: correctionReceipt, request: original,
        unit: initial.unit, route, contract, error: { code: 'context-budget-exceeded', provider_called: false }, layer: 'caller' });
      let correctedCalls = 0;
      const corrected = await sidecar.recoverUnitSidecar({ ...original, prompt: 'Offline corrected caller packaging.' },
        { stateFile: correctionState, receiptFile: correctionReceipt, correction: true, clock: () => correction.started_at + 1 },
        { executionAuthority, activeCapabilities: runtime.activeCapabilities, processProbe: () => 'stopped', verifyOwnership: () => false,
          invokeNative: async (next, binding) => {
        correctedCalls++; assert.strictEqual(next.route.model, 'gpt-6-sol');
        assert.strictEqual(binding.args.model, 'gpt-6-sol');
        assert(binding.args.message.includes('<!-- forge-procedure:recovery -->'));
        return { fixture_only: true, provider_contact: false };
      } });
      assert.strictEqual(correctedCalls, 1); assert.strictEqual(corrected.corrected, true);
      const correctionSaved = JSON.parse(fs.readFileSync(correctionState));
      assert.strictEqual(correctionSaved.started_at, correction.started_at); assert.strictEqual(correctionSaved.budget, 'tier-ceiling');
      assert.strictEqual(correctionSaved.deadline_at, undefined, 'corrected retry writes no cumulative clock');
    }
    assert(stageCalls > 5 && deltaCalls > 5);
    console.log('PASS ' + (nativeInitial ? 'native-initial R4 authority/correction/resume: ' : '') + 'pre-spawn trusted inspection, immutable challenge, full root delta, native after original deadline, pending questions, handoff guard and one correction across restart');
  } finally { window.close(); lab.cleanup(); }
}
async function deliveryPublicationLimits() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const delivery = require('./forge-delivery');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sidecar-delivery-size-')));
  try {
    const owner = path.join(root, 'owner'), code = path.join(root, 'code');
    fs.mkdirSync(owner); fs.mkdirSync(code);
    const request = { unitType: 'complete-milestone', milestoneId: 'M001', cwd: code, contextRoot: owner,
      workflowId: 'size-fixture', dispatchId: 'size-fixture', resultFile: path.join(root, 'result.json') };
    const loc = sidecar.locations(request), unit = { type: 'milestone', id: 'M001' };
    const plan = '# Milestone acceptance\n';
    fs.writeFileSync(path.join(owner, 'plan.md'), plan);
    // Build real canonical output rather than inflating an unvalidated JSON stub.
    const input = { schema_version: 1, unit, plan: 'plan.md', plan_fingerprint: delivery.sha256(plan),
      bindings: [], expected_children: [], additional_criteria: Array.from({ length: 425 }, (_, i) => ({
        id: `criterion-${i}`, text: `Observable acceptance ${i}: ${'evidence '.repeat(100)}`,
        reference: `acceptance#${i}`, type: 'functional',
      })) };
    const output = delivery.buildDelivery(input, { ownerRoot: owner, codeDir: code });
    assert.strictEqual(output.criteria.length, 425);
    const content = JSON.stringify(output, null, 2) + '\n';
    assert(Buffer.byteLength(content) > sidecar.MAX_ARTIFACT_BYTES);
    assert(Buffer.byteLength(content) < delivery.MAX_FILE_BYTES);
    const payload = { status: 'done', summary: 'Complete inventory', questions: [], artifacts: [
      { path: loc.required[0], content: '# Summary\n' },
      { path: loc.delivery.input, content: JSON.stringify(input) },
      { path: loc.delivery.output, content },
    ] };
    const inspectPayload = (value, max = Infinity) => sidecar.inspectArtifacts(value, loc.allowed, loc.required, max, loc.rules);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    sidecar.beginArtifactAttempt(request);
    await assert.rejects(sidecar.acceptArtifactResult(request, payload, { providerCalled: true, maxPayloadBytes: bytes - 1 }),
      error => error.code === 'invalid-artifact-result' && error.message === 'payload-limit');
    assert(!fs.existsSync(path.join(owner, loc.delivery.output)), 'total cap refuses publication');
    const calibration = require('./forge-sidecar-calibration');
    const calibrationIdentity = { model: 'claude-fixture', effort: 'high', phase: 'artifacts' };
    const proposal = calibration.propose(calibrationIdentity, { initial_sample_ms: 100, gap_sample_ms: 200 });
    const commit = calibration.commit;
    let commitCalls = 0, accepted;
    calibration.commit = () => { commitCalls++; return { committed: false, diagnostic: 'calibration-busy' }; };
    try {
      accepted = await sidecar.acceptArtifactResult(request, payload, { providerCalled: true, maxPayloadBytes: bytes,
        telemetry: { calibration_proposal: proposal, observation: { phase: 'closed', input_tokens: 42, raw: 'private-text' } } });
    } finally { calibration.commit = commit; }
    assert.equal(accepted.result.transport_telemetry.observation.input_tokens, 42);
    assert(!JSON.stringify(accepted.result.transport_telemetry.observation).includes('private-text'));
    assert.equal(accepted.result.transport_telemetry.calibration_commit.diagnostic, 'calibration-busy');
    assert.equal(commitCalls, 3, 'accepted proposals get bounded automatic persistence retries');
    assert.equal(JSON.parse(fs.readFileSync(request.resultFile)).transport_telemetry.observation.input_tokens, 42);
    const firstReceipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
    assert.deepEqual(firstReceipt.calibration_proposal, proposal, 'trusted proposal is durable before replay');
    assert.equal(calibration.read(calibrationIdentity).initial.count, 0);
    const replay = await sidecar.acceptArtifactResult(request, payload, { providerCalled: true,
      telemetry: { calibration_proposal: calibration.propose(calibrationIdentity, { initial_sample_ms: 999, gap_sample_ms: 999 }) } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.transport_telemetry.observation.input_tokens, 42);
    assert.equal(replay.result.transport_telemetry.calibration_commit.committed, true);
    assert.equal(calibration.read(calibrationIdentity).initial.count, 1, 'same persisted proposal cannot learn twice');
    assert.deepEqual(JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json')).calibration_proposal, proposal);
    assert.equal(inspectPayload({ ...payload, calibration_proposal: proposal }).reason, 'schema-invalid');
    assert.strictEqual(fs.readFileSync(path.join(owner, loc.delivery.output), 'utf8'), content);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(owner, loc.delivery.output))).criteria.length, 425);
    assert.strictEqual(JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json')).phase, 'ready');
    const replace = (artifactPath, artifactContent) => ({ ...payload, artifacts: payload.artifacts.map(row =>
      row.path === artifactPath ? { ...row, content: artifactContent } : row) });
    const oversized = 'x'.repeat(sidecar.MAX_ARTIFACT_BYTES + 1);
    assert.strictEqual(inspectPayload(replace(loc.required[0], oversized)).reason, 'artifact-limit');
    assert.strictEqual(inspectPayload(replace(loc.required[0], content)).reason, 'artifact-limit', 'JSON cannot spoof a generic path');
    assert.strictEqual(inspectPayload(replace(loc.delivery.input, JSON.stringify({ ...input, padding: oversized }))).reason, 'artifact-limit');
    assert.strictEqual(inspectPayload(replace(loc.delivery.input, content)).reason, 'delivery-artifact-invalid');
    for (const kind of ['verification', 'artifact']) {
      const envelope = { schema_version: 1, unit, kind: kind === 'verification' ? kind : 'artifact', plan_fingerprint: input.plan_fingerprint,
        code_dir: code, revision: 'fixture', environment: 'node', captured_at: '2026-10-20T00:00:00Z', result: {}, padding: oversized };
      const value = { ...payload, artifacts: [...payload.artifacts, { path: loc.delivery[kind], content: JSON.stringify(envelope) }] };
      assert.strictEqual(inspectPayload(value).reason, 'artifact-limit');
    }
    // Valid JSON whitespace exercises the exact UTF-8 byte boundary without changing the contract.
    const atCap = content + ' '.repeat(delivery.MAX_FILE_BYTES - Buffer.byteLength(content));
    assert(inspectPayload(replace(loc.delivery.output, atCap)).ok);
    assert.strictEqual(inspectPayload(replace(loc.delivery.output, atCap + ' ')).reason, 'artifact-limit');
    for (const invalid of ['{', JSON.stringify({ ...output, generated_by: 'spoof' }),
      JSON.stringify({ ...output, schema_version: 2 }), JSON.stringify({ ...output, criteria: {} }),
      JSON.stringify({ ...output, unit: { type: 'milestone', id: 'M999' } })]) {
      assert.strictEqual(inspectPayload(replace(loc.delivery.output, invalid)).reason, 'delivery-artifact-invalid');
    }
    const wrongPath = { ...payload, artifacts: payload.artifacts.map(row => row.path === loc.delivery.output
      ? { ...row, path: '.gsd/milestones/M999/M999-DELIVERY.json' } : row) };
    assert.strictEqual(inspectPayload(wrongPath).reason, 'artifact-path-invalid');
    assert.strictEqual(inspectPayload({ ...payload, artifacts: [...payload.artifacts, payload.artifacts[2]] }).reason, 'artifact-duplicate');
    assert.strictEqual(inspectPayload({ ...payload, artifacts: Array(33).fill(payload.artifacts[2]) }).reason, 'artifact-limit');
    assert(inspectPayload(payload, bytes).ok);
    assert.strictEqual(inspectPayload(payload, bytes - 1).reason, 'payload-limit');
    assert.strictEqual(inspectPayload(payload, sidecar.MAX_ARTIFACT_PAYLOAD_BYTES).reason, 'payload-limit');
    console.log(`PASS complete-milestone publication: 425 canonical criteria, ${Buffer.byteLength(content)} DELIVERY bytes; generic/input/envelope, reader cap, spoof/schema/path/count/duplicate and total payload limits`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
// The owner turns a worker no-progress transition into one closed
// sidecar-no-progress line per episode, through its own event channel.
async function noProgressEventContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const runExecute = xllm.runExecute;
  const SENTINEL = 'T05_PRIVATE_TOOL_ARGUMENT_SENTINEL_4e7a';
  const FINGERPRINT = 'a1b2c3d4e5f60718';
  const EVENT_KEYS = ['dispatch_id', 'event', 'fingerprint_sha256', 'model', 'repeats', 'ts', 'unit', 'worker_engine', 'workflow_id'];
  const loop = (fingerprint = FINGERPRINT) => ({ from: 'working', to: 'slow-suspect', at_ms: 1000, reason: 'no-progress',
    detail: SENTINEL, progress: { repeats: 5, fingerprint_sha256: fingerprint, command: `echo ${SENTINEL}` } });
  const repeated = { ...loop(), from: 'slow-suspect' };
  const toolUnproven = { from: 'slow-suspect', to: 'slow-suspect', at_ms: 2000, reason: 'tool-unproven' };
  const proofUnavailable = { from: 'slow-suspect', to: 'slow-suspect', at_ms: 3000, reason: 'proof-unavailable' };
  const working = { from: 'slow-suspect', to: 'working', at_ms: 1500, reason: null };
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  // One temporary owner + two code roots per case: each case is a fresh unit.
  async function runCase(id, transitions, hooks = {}) {
    const lab = fixtures.fixture();
    try {
      const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
        cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, route,
        workflowId: 'no-progress-fixture', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.',
        verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
      const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
      fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
      fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
      fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
        ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
      resolveContext(request);
      request.runId = `no-progress-${id}`;
      request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
      let seen = null;
      xllm.runExecute = async options => {
        seen = options;
        hooks.beforeTransitions?.(lab);
        for (const transition of transitions) {
          options.onLiveness(transition);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await hooks.afterTransitions?.(lab);
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
        fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
        return { status: 'done', summary: 'Synthetic loop fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
      };
      const result = await sidecar.runUnitSidecar(request);
      const eventsText = fs.readFileSync(path.join(lab.owner, '.gsd/forge/events.jsonl'), 'utf8');
      const events = eventsText.split('\n').filter(Boolean).map(line => JSON.parse(line));
      return { result, seen, eventsText, events, loops: events.filter(row => row.event === 'sidecar-no-progress'),
        unitEvents: events.filter(row => row.event === 'sidecar-unit'), request };
    } finally { xllm.runExecute = runExecute; lab.cleanup(); }
  }
  const base = await runCase('baseline', []);
  assert.strictEqual(base.result.status, 'done', JSON.stringify(base.result));
  assert.strictEqual(base.loops.length, 0);
  const terminalStatus = base.unitEvents[base.unitEvents.length - 1].status;

  // (a) two consecutive no-progress transitions are one episode; other reasons add nothing.
  const once = await runCase('episode-once', [loop(), repeated, toolUnproven, proofUnavailable]);
  assert.strictEqual(once.result.status, base.result.status);
  assert.strictEqual(once.loops.length, 1, once.eventsText);
  const line = once.loops[0];
  assert.deepStrictEqual(Object.keys(line).sort(), EVENT_KEYS);
  assert.strictEqual(line.repeats, 5);
  assert.strictEqual(line.fingerprint_sha256, FINGERPRINT);
  assert.strictEqual(line.dispatch_id, 'episode-once');
  assert.strictEqual(line.workflow_id, 'no-progress-fixture');
  assert.strictEqual(line.worker_engine, 'claude');
  assert.strictEqual(line.model, 'claude-sonnet-5');
  assert.strictEqual(line.unit, once.unitEvents[0].unit);
  assert(!once.eventsText.includes(SENTINEL), 'no tool argument, detail or prompt text reaches events.jsonl');
  assert(!JSON.stringify(line).includes(SENTINEL));
  // Ordered before the terminal owner event of the unit.
  const indexOf = row => once.events.indexOf(row);
  assert(indexOf(line) > indexOf(once.unitEvents[0]) && indexOf(line) < indexOf(once.unitEvents[once.unitEvents.length - 1]));
  assert.strictEqual(once.unitEvents[once.unitEvents.length - 1].status, terminalStatus);
  // The owner's result/receipt channel is excluded from local proof.
  const resultFile = once.seen.resultFile;
  assert.strictEqual(path.basename(resultFile), 'episode-once.json');
  assert(once.seen.localProofIgnore.includes(resultFile), JSON.stringify(once.seen.localProofIgnore));
  assert(once.seen.localProofIgnore.includes(`${resultFile}.receipt.json`), JSON.stringify(once.seen.localProofIgnore));
  assert.strictEqual(typeof once.seen.onLiveness, 'function');

  // (b) leaving the episode reopens it; an invalid fingerprint is omitted, never echoed.
  const twice = await runCase('episode-reopened', [loop(), working, loop(`NOT-HEX ${SENTINEL}`)]);
  assert.strictEqual(twice.result.status, base.result.status);
  assert.strictEqual(twice.loops.length, 2, twice.eventsText);
  assert.strictEqual(twice.loops[0].fingerprint_sha256, FINGERPRINT);
  assert.deepStrictEqual(Object.keys(twice.loops[1]).sort(), EVENT_KEYS.filter(key => key !== 'fingerprint_sha256'));
  assert(!twice.eventsText.includes(SENTINEL));

  // Other reasons never open an episode.
  const none = await runCase('other-reasons', [toolUnproven, proofUnavailable,
    { from: 'working', to: 'slow-suspect', at_ms: 4000, reason: 'silence' }]);
  assert.strictEqual(none.result.status, base.result.status);
  assert.strictEqual(none.loops.length, 0, none.eventsText);

  // (c) a failed append is best-effort: the unit result is unchanged.
  const foreign = lab => path.join(lab.owner, '.gsd/foreign-during-loop.json');
  const failed = await runCase('append-fails', [loop()], {
    beforeTransitions: lab => fs.writeFileSync(foreign(lab), '{}'),
    afterTransitions: async lab => { await new Promise(resolve => setTimeout(resolve, 20)); fs.unlinkSync(foreign(lab)); },
  });
  assert.strictEqual(failed.result.status, base.result.status, JSON.stringify(failed.result));
  assert.strictEqual(failed.loops.length, 0, 'a refused owner append writes nothing');
  assert.strictEqual(failed.unitEvents[failed.unitEvents.length - 1].status, terminalStatus);
  console.log('PASS sidecar-no-progress: one closed owner event per episode, reopened after exit, other reasons ignored, best-effort append, result/receipt excluded from local proof');
}
// S06/T04: the owner forwards the worker's liveness block to the host (runtime.onProgress)
// and records the last state in the started-phase receipt; no block means the old payload.
async function livenessHeartbeatContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const runExecute = xllm.runExecute;
  const SENTINEL = 'S06_T04_LIVENESS_SENTINEL_9c1d';
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  const beat = (state, since_ms, extra = {}) => ({ version: 1, state, since_ms, reason: state === 'slow-suspect' ? 'silence' : null, ...extra });
  async function runCase(id, snapshots) {
    const lab = fixtures.fixture();
    try {
      const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
        cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, route,
        workflowId: 'liveness-fixture', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.',
        verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
      const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
      fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
      fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
      fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
        ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
      resolveContext(request);
      request.runId = `liveness-${id}`;
      request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
      const hostSeen = [], receipts = [];
      xllm.runExecute = async options => {
        const receiptFile = `${options.resultFile}.receipt.json`;
        for (const snapshot of snapshots) {
          options.onProgress({ elapsed_ms: 10, ...snapshot });
          receipts.push(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).telemetry?.observation);
        }
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
        fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
        return { status: 'done', summary: 'Synthetic liveness fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
      };
      const result = await sidecar.runUnitSidecar(request, { onProgress: safe => { hostSeen.push(safe); } });
      const eventsText = fs.readFileSync(path.join(lab.owner, '.gsd/forge/events.jsonl'), 'utf8');
      return { result, hostSeen, receipts, eventsText };
    } finally { xllm.runExecute = runExecute; lab.cleanup(); }
  }
  const states = [['starting', 0], ['working', 5000], ['slow-suspect', 120000]];
  const withBlock = await runCase('heartbeat', states.map(([state, since]) => ({ liveness: beat(state, since) })));
  assert.strictEqual(withBlock.result.status, 'done', JSON.stringify(withBlock.result));
  assert.deepStrictEqual(withBlock.hostSeen.map(row => row.liveness.state), ['starting', 'working', 'slow-suspect']);
  assert.deepStrictEqual(withBlock.hostSeen.map(row => row.liveness.since_ms), [0, 5000, 120000]);
  assert.deepStrictEqual(withBlock.hostSeen[2].liveness, { version: 1, state: 'slow-suspect', since_ms: 120000, reason: 'silence' });
  withBlock.receipts.forEach((row, index) => assert.deepStrictEqual(row.liveness, withBlock.hostSeen[index].liveness));
  assert.deepStrictEqual(withBlock.receipts[2].liveness, withBlock.hostSeen[2].liveness, 'receipt reflects the last emitted state');

  const without = await runCase('no-block', [{}, { phase: 'remote-activity' }]);
  assert.strictEqual(without.result.status, 'done', JSON.stringify(without.result));
  assert.strictEqual(without.hostSeen.length, 2);
  for (const row of [...without.hostSeen, ...without.receipts]) assert(!('liveness' in row), JSON.stringify(row));

  const leaky = await runCase('sentinel', [{ liveness: { ...beat('working', 1), note: SENTINEL, session_id: SENTINEL } }]);
  assert.strictEqual(leaky.result.status, 'done', JSON.stringify(leaky.result));
  assert.deepStrictEqual(leaky.hostSeen[0].liveness, beat('working', 1));
  // Closed key set: only the four documented fields survive normalization.
  assert.deepStrictEqual(Object.keys(leaky.hostSeen[0].liveness).sort(), ['reason', 'since_ms', 'state', 'version']);
  assert.strictEqual(leaky.hostSeen.length, 1);
  assert.strictEqual(leaky.receipts.length, 1);
  assert.deepStrictEqual(leaky.receipts[0].liveness, leaky.hostSeen[0].liveness);
  assert(!JSON.stringify(leaky.hostSeen).includes(SENTINEL));
  assert(!JSON.stringify(leaky.receipts).includes(SENTINEL));
  assert(!leaky.eventsText.includes(SENTINEL));
  console.log('PASS liveness-heartbeat: host receives starting/working/slow-suspect, receipt reflects the last state, no-block payload unchanged, extra fields never leak');
}
// R1/R2: the owner's authenticated no-progress append is reconciled into the
// preparation surface (no broker) and into the shared write-contract validation
// (owner == code root, events.jsonl tracked), while unrelated edits still fail.
async function ownerEventReconcileContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
  const fixtures = require('./forge-code-roots.test'), runs = require('./forge-runs'), roots = require('./forge-code-roots');
  const FINGERPRINT = 'a1b2c3d4e5f60718';
  const loop = { from: 'working', to: 'slow-suspect', at_ms: 1000, reason: 'no-progress',
    progress: { repeats: 5, fingerprint_sha256: FINGERPRINT } };
  const moduleKeys = () => Object.keys(require.cache).filter(key => /forge-(xllm|unit-sidecar|claude-sidecar|task-preparation)\.js$/.test(key));
  const saved = moduleKeys().map(key => [key, require.cache[key]]);
  for (const [key] of saved) delete require.cache[key];
  const claude = require('./forge-claude-sidecar');
  const realInvoke = claude.invokeClaudeSidecar;
  let adapter = null;
  claude.invokeClaudeSidecar = options => adapter(options);
  const fresh = require('./forge-unit-sidecar');
  const prep = require('./forge-task-preparation');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  try {
    // R2 - complete sidecar -> runExecute -> adapter path with owner == code root.
    async function runOwnerCase(id, extraWorkerWrite) {
      const lab = fixtures.fixture();
      try {
        const contract = roots.validateContract({ schema_version: 2, owner: lab.a, primary_root_id: 'alpha',
          code_roots: [{ id: 'alpha', path: lab.a }, { id: 'beta', path: lab.b }] });
        fs.mkdirSync(path.join(lab.a, '.gsd/forge'), { recursive: true });
        fs.writeFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), '{"event":"seed"}\n');
        fixtures.command('git', ['add', '-f', '.gsd/forge/events.jsonl'], lab.a);
        fixtures.command('git', ['commit', '-qm', 'track events'], lab.a);
        const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
          cwd: lab.a, contextRoot: lab.a, execution_contract: contract, route,
          workflowId: 'owner-event-fixture', dispatchId: id, resultFile: path.join(lab.dir, id + '.json'), prompt: 'Fixture only.',
          verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
        const base = path.join(lab.a, '.gsd/milestones/M001/slices/S01');
        fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
        request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
        fs.writeFileSync(request.planFile, fixtures.plan(contract));
        fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
        fs.writeFileSync(path.join(lab.a, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
          ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
        request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: lab.a, unitType: request.unitType,
          milestoneId: 'M001', unitId: 'T01', planPath: request.planFile, hostRuntime: 'codex' });
        request.runId = 'owner-event-' + id;
        request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract,
          paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
        request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
        runs.add(lab.a, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
        adapter = async options => {
          options.onLiveness(loop);
          await sleep(40);
          fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
          fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
          if (extraWorkerWrite) fs.appendFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), '{"event":"forged"}\n');
          return { candidate: { status: 'done', summary: 'Synthetic loop fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] }, telemetry: null };
        };
        let outcome;
        try { outcome = { result: await fresh.runUnitSidecar(request) }; } catch (error) { outcome = { error }; }
        outcome.events = fs.readFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), 'utf8');
        return outcome;
      } finally { lab.cleanup(); }
    }
    const ok = await runOwnerCase('owner-event-ok', false);
    assert(!ok.error, ok.error && ok.error.stack);
    assert.strictEqual(ok.result.status, 'done', JSON.stringify(ok.result));
    assert.strictEqual(ok.events.split('\n').filter(line => line.includes('"sidecar-no-progress"')).length, 1, ok.events);
    const forged = await runOwnerCase('owner-event-forged', true);
    assert(forged.error || forged.result.status !== 'done', 'an arbitrary events.jsonl edit is still rejected');

    // R1 - standalone preparation without an owner broker publishes after no-progress.
    const stage = destination => {
      const source = path.resolve(__dirname, '..');
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
      fs.mkdirSync(path.join(destination, 'shared'), { recursive: true });
      fs.copyFileSync(path.join(source, 'shared/forge-procedures.json'), path.join(destination, 'shared/forge-procedures.json'));
      for (const module of manifest.modules.filter(item => item.status === 'ready')) fs.copyFileSync(path.join(source, module.path), path.join(destination, module.path));
    };
    const caseRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-event-prep-')));
    try {
      const cwd = path.join(caseRoot, 'code'), contextRoot = path.join(caseRoot, 'owner'), results = path.join(caseRoot, 'results');
      fs.mkdirSync(cwd, { recursive: true }); stage(cwd);
      fixtures.command('git', ['init', '-q'], cwd);
      fixtures.command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
      fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true }); fs.mkdirSync(results);
      fs.writeFileSync(path.join(contextRoot, '.gsd/forge-prefs.jsonc'), JSON.stringify({
        tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-sonnet-5', max: 'claude-sonnet-5' },
        effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
      const request = { schema_version: 1, scope: 'standalone-task', phase: 'research', taskId: 'T-20261023000000-ownerevent',
        cwd, contextRoot, hostRuntime: 'codex', workflowId: 'prep-owner-event', dispatchId: 'prep-owner-event',
        resultFile: path.join(results, 'result.json'), constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Fixture' } };
      const body = "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
      adapter = async options => {
        options.onLiveness(loop);
        await sleep(40);
        return { candidate: { status: 'done', summary: 'research complete', questions: [],
          artifacts: [{ path: prep.requiredArtifact(request), content: body }] }, telemetry: null };
      };
      const outcome = await prep.prepareStandaloneTask(request);
      assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
      const events = fs.readFileSync(path.join(contextRoot, '.gsd/forge/events.jsonl'), 'utf8');
      assert.strictEqual(events.split('\n').filter(line => line.includes('"sidecar-no-progress"')).length, 1, events);
      assert(fs.existsSync(path.join(contextRoot, prep.requiredArtifact(request))));
    } finally { fs.rmSync(caseRoot, { recursive: true, force: true }); }
    console.log('PASS owner-event reconcile: preparation without broker publishes after no-progress; owner==code-root real transport succeeds; forged events edit still rejected');
  } finally {
    claude.invokeClaudeSidecar = realInvoke;
    for (const key of moduleKeys()) delete require.cache[key];
    for (const [key, entry] of saved) require.cache[key] = entry;
  }
}
// The transport receives the safety ceiling resolved from the route, never a fixed 300.
async function ceilingRouteContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const runExecute = xllm.runExecute;
  async function timeoutFor(id, shape, viaRecovery = false) {
    const lab = fixtures.fixture();
    try {
      const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
        cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, workflowId: 'ceiling-fixture', dispatchId: id,
        resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.', verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
      const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
      fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
      fs.writeFileSync(request.planFile, fixtures.plan(lab.contract).replace('tier: standard', `tier: ${shape.tier || 'standard'}`));
      fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
        ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
      resolveContext(request);
      const route = { ...request.route };
      delete route.workers_timeout; delete route.workers_timeout_source; delete route.workers_timeout_warning;
      request.route = { ...route, ...shape };
      request.runId = `ceiling-${id}`;
      request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
      let seen = null;
      xllm.runExecute = async options => {
        seen = options.timeoutSecs;
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
        fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
        return { status: 'done', summary: 'Ceiling fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
      };
      if (!viaRecovery) await sidecar.runUnitSidecar(request);
      else {
        // Substitute only the recovery controller at its boundary: the real
        // recoverUnitSidecar.invoke adapter receives the inherited route and a
        // bogus third argument (a stale clock remainder) that must be ignored.
        const recovery = require('./forge-attempt-recovery'), recoverAttempt = recovery.recoverAttempt;
        let handed = null;
        const transportExecute = xllm.runExecute;
        xllm.runExecute = async options => { handed = options; return transportExecute(options); };
        recovery.recoverAttempt = async options => options.invoke(request.route, { ok: true }, 21, undefined, 'fixture-reservation');
        try {
          await sidecar.recoverUnitSidecar(request, { stateFile: request.resultFile + '.recovery.json',
            receiptFile: request.resultFile + '.receipt.json' }, {});
        } finally { recovery.recoverAttempt = recoverAttempt; }
        assert(handed, 'recovery reached the sidecar transport');
      }
      return seen;
    } finally { xllm.runExecute = runExecute; lab.cleanup(); }
  }
  assert.strictEqual(await timeoutFor('standard-no-source', { tier: 'standard' }), 1800);
  assert.strictEqual(await timeoutFor('explicit-42', { workers_timeout: 42, workers_timeout_source: 'explicit' }), 42);
  assert.strictEqual(await timeoutFor('legacy-heavy-300', { tier: 'heavy', workers_timeout: 300 }), 3600);
  console.log('PASS ceiling route: transport timeoutSecs = ceilingFromRoute (standard 1800, explicit 42, legacy heavy 300 → 3600)');
  // Recovery adapter: the recovered sidecar gets the full tier ceiling, never a
  // remainder of the former cumulative 60000 ms clock.
  assert.strictEqual(await timeoutFor('recovery-standard', { tier: 'standard' }, true), 1800);
  assert.strictEqual(await timeoutFor('recovery-heavy', { tier: 'heavy' }, true), 3600);
  assert.strictEqual(await timeoutFor('recovery-explicit', { workers_timeout: 1234, workers_timeout_source: 'explicit' }, true), 1234);
  // R1 (S03-REVIEW): an inherited fractional tier-default value is invalid and
  // resolves to the tier ceiling, never 59.999 nor the stale remainder.
  const r1 = await timeoutFor('recovery-r1-fractional', { tier: 'standard', workers_timeout: 59.999, workers_timeout_source: 'tier-default' }, true);
  assert.strictEqual(r1, 1800); assert.notStrictEqual(r1, 59.999); assert.notStrictEqual(r1, 21);
  console.log('PASS recovery ceiling: recoverUnitSidecar transport timeoutSecs = tier ceiling (standard 1800, heavy 3600, explicit 1234, R1 59.999 → 1800)');
}
// S05/T05: per-unit Claude session opt-in through the real chain
// runUnitSidecar -> forge-xllm -> invokeClaudeSidecar -> fake CLI
// (FORGE_XLLM_CLAUDE_BIN), with HOME/USERPROFILE under the temporary profile.
// The adapter is only wrapped to inject its documented test seams (clock,
// liveness interval, sessionRemover); argv, receipt and recovery are real.
async function claudeSessionContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
  const fixtures = require('./forge-code-roots.test'), runs = require('./forge-runs');
  const session = require('./forge-claude-session');
  const accounts = require('./forge-accounts');
  const moduleKeys = () => Object.keys(require.cache).filter(key => /forge-(xllm|unit-sidecar|claude-sidecar|task-preparation)\.js$/.test(key));
  const saved = moduleKeys().map(key => [key, require.cache[key]]);
  for (const [key] of saved) delete require.cache[key];
  const realResolve = accounts.resolveLaunch;
  // Fictitious account: never a real token; the adapter binds resolveLaunch at load.
  accounts.resolveLaunch = () => ({ name: 'fixture-session-account', token: 'fixture-token-not-a-secret' });
  const claude = require('./forge-claude-sidecar');
  accounts.resolveLaunch = realResolve;
  const realInvoke = claude.invokeClaudeSidecar;
  let seam = () => ({});
  const handed = [];
  claude.invokeClaudeSidecar = options => { handed.push(options); return realInvoke({ ...options, ...seam(options) }); };
  const fresh = require('./forge-unit-sidecar');
  const previousBin = process.env.FORGE_XLLM_CLAUDE_BIN;
  const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-session-')));
  // Fake CLI: answers --version, records argv beside itself, materializes the
  // transcript in the measured layout and confirms the id in system/init.
  const writeCli = (mode, structured) => {
    const file = path.join(work, `fake-claude-${mode}.js`);
    fs.writeFileSync(file, [
      "'use strict';",
      "const fs = require('fs'), path = require('path');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { process.stdout.write('2.1.310 (Claude Code)\\n'); process.exit(0); }",
      `fs.appendFileSync(path.join(__dirname, 'argv-${mode}.jsonl'), JSON.stringify(args) + '\\n');`,
      "const at = args.indexOf('--session-id'), resumeAt = args.indexOf('--resume');",
      'const sid = at >= 0 ? args[at + 1] : resumeAt >= 0 ? args[resumeAt + 1] : null;',
      'if (sid) {',
      "  const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;",
      `  const { projectKey } = require(${JSON.stringify(require.resolve('./forge-claude-session'))});`,
      "  const dir = path.join(home, '.claude', 'projects', projectKey(process.cwd()));",
      '  fs.mkdirSync(dir, { recursive: true });',
      "  fs.appendFileSync(path.join(dir, sid + '.jsonl'), '{\"type\":\"fixture\"}\\n');",
      '}',
      "const out = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const delta = () => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });",
      "out({ type: 'system', subtype: 'init', session_id: sid });",
      "out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-session', role: 'assistant' } } });",
      "out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });",
      'delta();',
      `const mode = ${JSON.stringify(mode)};`,
      "if (mode === 'endless') setInterval(delta, 30);",
      'else {',
      "  if (mode === 'execute') {",
      "    fs.writeFileSync(path.join(process.cwd(), 'same.txt'), 'worker alpha\\n');",
      "    for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') fs.writeFileSync(path.join(args[i + 1], 'same.txt'), 'worker beta\\n');",
      '  }',
      "  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });",
      "  out({ type: 'stream_event', event: { type: 'message_stop' } });",
      "  const model = args[args.indexOf('--model') + 1];",
      `  out({ type: 'result', subtype: 'success', is_error: false, result: 'fixture', structured_output: ${JSON.stringify(structured)},`,
      '    usage: { input_tokens: 11, output_tokens: 13 }, modelUsage: { [model]: { inputTokens: 11, outputTokens: 13 } } });',
      '}',
      '',
    ].join('\n'));
    return file;
  };
  const argvOf = mode => fs.readFileSync(path.join(work, `argv-${mode}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const sessionIdOf = args => { const at = args.indexOf('--session-id'); return at >= 0 ? args[at + 1] : null; };
  const transcriptOf = id => {
    const projects = path.join(home, '.claude', 'projects');
    for (const key of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      const file = path.join(projects, key, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };
  const executeCli = writeCli('execute', { status: 'done', summary: 'Session fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] });
  const endlessCli = writeCli('endless', null);
  async function executeCase(id, cli, extra = {}) {
    const lab = fixtures.fixture();
    process.env.FORGE_XLLM_CLAUDE_BIN = cli;
    const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
      cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract,
      workflowId: 'claude-session-fixture', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.',
      verification: { preferenceCommands: ['node -e "process.exit(0)"'] }, ...extra };
    const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
    fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
    request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
    fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
    fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
    fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
      ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
    resolveContext(request);
    // Explicit 60 s ceiling: the accelerated seam clock reaches it in ~0.2 s real.
    request.route = { ...request.route, workers_timeout: 60, workers_timeout_source: 'explicit' };
    delete request.route.workers_timeout_warning;
    request.runId = `claude-session-${id}`;
    request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
      paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
    request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
    runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
    let outcome;
    try { outcome = { result: await fresh.runUnitSidecar(request) }; } catch (error) { outcome = { error }; }
    const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    outcome.receiptText = read(`${request.resultFile}.receipt.json`);
    outcome.resultText = read(request.resultFile);
    outcome.recoveryText = read(`${request.resultFile}.recovery.json`);
    outcome.eventsText = read(path.join(lab.owner, '.gsd/forge/events.jsonl'));
    outcome.lab = lab;
    return outcome;
  }
  const sha = id => crypto.createHash('sha256').update(id, 'utf8').digest('hex');
  const noRawId = (outcome, id) => {
    for (const [channel, text] of [['receipt', outcome.receiptText], ['result', outcome.resultText], ['events', outcome.eventsText]]) {
      assert(text.length > 0, `${channel} written`);
      assert(!text.includes(id), `raw session id absent from ${channel}`);
    }
  };
  try {
    // (a) execute-task: --session-id <uuid>, receipt with session_sha256 only, transcript removed.
    const ok = await executeCase('session-execute', executeCli);
    try {
      assert(!ok.error, ok.error && ok.error.stack);
      assert.strictEqual(ok.result.status, 'done', JSON.stringify(ok.result));
      assert.deepStrictEqual(handed[handed.length - 1].session, { persist: true }, 'execute unit opts in');
      const args = argvOf('execute').pop();
      const id = sessionIdOf(args);
      assert(session.SESSION_ID_PATTERN.test(id), JSON.stringify(args));
      assert(!args.includes('--no-session-persistence'));
      assert.strictEqual(JSON.parse(ok.receiptText).session_sha256, sha(id));
      noRawId(ok, id);
      assert.strictEqual(transcriptOf(id), null, 'session removed after success');
      assert(!ok.eventsText.includes('claude-session-cleanup-failed'));
    } finally { ok.lab.cleanup(); }

    // Resume request on an eligible unit: the adapter receives {resume: ref}
    // (never persist) and the new receipt is born chained (resumed_from) with
    // the digest only. The ref's cwd differs, so the adapter refuses pre-spawn.
    const resumeRef = session.createSessionRef({ id: session.newSessionId(), accountName: 'fixture-session-account',
      configDir: path.join(home, '.claude'), cwd: work });
    const resumedFrom = { receipt_sha256: 'c'.repeat(64), dispatch_id: 'session-active-budget' };
    const resumed = await executeCase('session-resume-request', executeCli, { claudeResume: resumeRef, resumedFrom });
    try {
      assert.deepStrictEqual(handed[handed.length - 1].session, { resume: resumeRef }, 'resume forwarded instead of persist');
      assert.strictEqual(resumed.error && resumed.error.code, 'claude-resume-config-mismatch', resumed.error && resumed.error.stack);
      const receipt = JSON.parse(resumed.receiptText);
      assert.deepStrictEqual(receipt.resumed_from, resumedFrom);
      assert.strictEqual(receipt.session_sha256, sha(resumeRef.id));
      noRawId(resumed, resumeRef.id);
    } finally { resumed.lab.cleanup(); }

    // (c) active ceiling: the error keeps the ref; .recovery.json holds it, receipt only the digest.
    seam = options => {
      const t0 = performance.now();
      let pivot = null;
      return { monotonicClock: () => { const now = performance.now(); return pivot === null ? now - t0 : (pivot - t0) + (now - pivot) * 300; },
        livenessIntervalMs: 25,
        onProgress: snapshot => { if (pivot === null && snapshot.phase !== 'local-start') pivot = performance.now(); return options.onProgress?.(snapshot); } };
    };
    const active = await executeCase('session-active-budget', endlessCli);
    seam = () => ({});
    try {
      assert(active.error, 'expected the active-ceiling failure');
      assert.strictEqual(active.error.code, 'budget-exceeded-while-active', active.error.stack);
      const id = sessionIdOf(argvOf('endless').pop());
      assert(session.SESSION_ID_PATTERN.test(id));
      const state = JSON.parse(active.recoveryText);
      assert.strictEqual(state.attempts.at(-1).session.id, id, 'recovery state keeps the ref of the argv uuid');
      assert(transcriptOf(id), 'session preserved for the single resume');
      assert.strictEqual(JSON.parse(active.receiptText).session_sha256, sha(id));
      noRawId(active, id);
      fs.rmSync(transcriptOf(id), { force: true });
    } finally { active.lab.cleanup(); }

    // (d) failed removal: one closed owner event, counts and digest only.
    seam = () => ({ sessionRemover: () => ({ ok: false, removed: [], refused: [{ path: 'projects/k/x.jsonl', reason: 'symlink' }],
      errors: [{ path: 'session-env/x', code: 'EPERM' }, { path: 'file-history/x', code: 'EBUSY' }] }) });
    const failed = await executeCase('session-cleanup-failed', executeCli);
    seam = () => ({});
    try {
      assert(!failed.error, failed.error && failed.error.stack);
      assert.strictEqual(failed.result.status, 'done', 'a failed removal never fails a valid result');
      const id = sessionIdOf(argvOf('execute').pop());
      const lines = failed.eventsText.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.event === 'claude-session-cleanup-failed');
      assert.strictEqual(lines.length, 1, failed.eventsText);
      assert.deepStrictEqual(Object.keys(lines[0]).sort(), ['dispatch_id', 'errors', 'event', 'refused', 'session_sha256', 'ts', 'unit', 'workflow_id']);
      assert.strictEqual(lines[0].dispatch_id, 'session-cleanup-failed');
      assert.strictEqual(lines[0].session_sha256, sha(id));
      assert.strictEqual(lines[0].refused, 1);
      assert.strictEqual(lines[0].errors, 2);
      assert(!failed.eventsText.includes('projects/k'), 'no path in the event');
      noRawId(failed, id);
      const transcript = transcriptOf(id);
      if (transcript) fs.rmSync(transcript, { force: true });
    } finally { failed.lab.cleanup(); }

    // (e) a malformed resume ref is a named refusal before any receipt or adapter call.
    const before = handed.length;
    const refused = await executeCase('session-resume-invalid', executeCli, { claudeResume: { version: 1 },
      resumedFrom: { receipt_sha256: 'a'.repeat(64), dispatch_id: 'previous' } });
    try {
      assert.strictEqual(refused.error && refused.error.code, 'claude-session-invalid', refused.error && refused.error.stack);
      assert.strictEqual(refused.receiptText, '', 'no receipt before transport');
      assert.strictEqual(handed.length, before, 'no adapter call');
    } finally { refused.lab.cleanup(); }

    // (b) ineligible unit (research-milestone, artifacts transport): legacy argv,
    // no session option; a resume ref there is refused before any receipt.
    const researchCase = async (id, extra = {}) => {
      const lab = fixtures.fixture();
      try {
        const request = { unitType: 'research-milestone', scope: 'milestone', milestoneId: 'M001', cwd: lab.a, contextRoot: lab.owner,
          workflowId: 'claude-session-research', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.', ...extra };
        fs.mkdirSync(path.join(lab.owner, '.gsd/milestones/M001'), { recursive: true });
        fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
          ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
        resolveContext(request);
        const required = fresh.locations(request).required;
        process.env.FORGE_XLLM_CLAUDE_BIN = writeCli(`research-${id}`, { status: 'done', summary: 'Research fixture', questions: [],
          artifacts: required.map(p => ({ path: p, content: "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n" })) });
        let outcome;
        try { outcome = { result: await fresh.runUnitSidecar(request) }; } catch (error) { outcome = { error }; }
        outcome.receiptExists = fs.existsSync(`${request.resultFile}.receipt.json`);
        return outcome;
      } finally { lab.cleanup(); }
    };
    const legacyBefore = handed.length;
    const research = await researchCase('session-research');
    assert(handed.length > legacyBefore, research.error && research.error.stack);
    assert.strictEqual(handed[handed.length - 1].session, undefined, 'research never opts in');
    const researchArgs = argvOf('research-session-research').pop();
    assert(researchArgs.includes('--no-session-persistence'), JSON.stringify(researchArgs));
    assert(!researchArgs.includes('--session-id') && !researchArgs.includes('--resume'));
    // plan-milestone carries no explicit phase: the canonical phase is inferred once,
    // so it still opts in to persistence and calibrates as 'plan'.
    const planBefore = handed.length;
    const planned = await researchCase('session-plan-milestone', { unitType: 'plan-milestone' });
    assert(handed.length > planBefore, planned.error && planned.error.stack);
    assert.deepStrictEqual(handed[handed.length - 1].session, { persist: true }, 'plan-milestone without phase opts in');
    assert.strictEqual(handed[handed.length - 1].calibrationPhase, 'plan');
    const planArgs = argvOf('research-session-plan-milestone').pop();
    assert(planArgs.includes('--session-id') && !planArgs.includes('--no-session-persistence'), JSON.stringify(planArgs));
    const ref = session.createSessionRef({ id: session.newSessionId(), accountName: 'fixture-session-account',
      configDir: path.join(home, '.claude'), cwd: work });
    const ineligibleBefore = handed.length;
    const ineligible = await researchCase('session-research-resume', { claudeResume: ref,
      resumedFrom: { receipt_sha256: 'b'.repeat(64), dispatch_id: 'previous' } });
    assert.strictEqual(ineligible.error && ineligible.error.code, 'claude-invalid-options', ineligible.error && ineligible.error.stack);
    assert.strictEqual(ineligible.receiptExists, false, 'refused before the receipt');
    assert.strictEqual(handed.length, ineligibleBefore, 'refused before transport');
    console.log('PASS claude session opt-in: execute persists (--session-id, receipt session_sha256, removed), resume request forwards {resume} with a chained receipt (resumed_from), active ceiling keeps the ref in .recovery.json only, failed removal emits claude-session-cleanup-failed, raw id absent from receipt/result/events, malformed resume refused before transport; research keeps the legacy argv and refuses a resume ref (claude-invalid-options)');
  } finally {
    if (previousBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = previousBin;
    claude.invokeClaudeSidecar = realInvoke;
    for (const key of moduleKeys()) delete require.cache[key];
    for (const [key, entry] of saved) require.cache[key] = entry;
    fs.rmSync(work, { recursive: true, force: true });
  }
}
// S05/T06: end-to-end same-session resume through the real recovery adapter:
// runUnitSidecar (start, --session-id) -> active ceiling -> captureFailure with
// the ref -> recoverUnitSidecar -> real reconcile -> --resume on the fake CLI.
// Only the documented adapter seams (clock, liveness interval) are injected; the
// reconcile marker wraps the real forge-surgical-reset.reconcileFailedAttempt.
async function claudeResumeContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
  const fixtures = require('./forge-code-roots.test'), runs = require('./forge-runs');
  const session = require('./forge-claude-session'), accounts = require('./forge-accounts');
  const surgical = require('./forge-surgical-reset');
  const moduleKeys = () => Object.keys(require.cache).filter(key => /forge-(xllm|unit-sidecar|claude-sidecar|task-preparation)\.js$/.test(key));
  const saved = moduleKeys().map(key => [key, require.cache[key]]);
  for (const [key] of saved) delete require.cache[key];
  const realResolve = accounts.resolveLaunch;
  // Fictitious account: never a real token; the adapter binds resolveLaunch at load.
  accounts.resolveLaunch = () => ({ name: 'fixture-resume-account', token: 'fixture-token-not-a-secret' });
  const claude = require('./forge-claude-sidecar');
  accounts.resolveLaunch = realResolve;
  const realInvoke = claude.invokeClaudeSidecar;
  let seam = () => ({});
  claude.invokeClaudeSidecar = options => realInvoke({ ...options, ...seam(options) });
  const fresh = require('./forge-unit-sidecar');
  const realReconcile = surgical.reconcileFailedAttempt;
  const previousBin = process.env.FORGE_XLLM_CLAUDE_BIN;
  const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-resume-')));
  const orderFile = path.join(work, 'order.jsonl'), argvFile = path.join(work, 'argv.jsonl');
  surgical.reconcileFailedAttempt = (...args) => { fs.appendFileSync(orderFile, '"reconcile"\n'); return realReconcile(...args); };
  // Fake CLI modes: start (--session-id, endless stream), resume-ok, resume-endless
  // (--resume requires the preserved transcript), silent (N events then silence).
  const writeCli = mode => {
    const file = path.join(work, `fake-claude-${mode}.js`);
    fs.writeFileSync(file, [
      "'use strict';",
      "const fs = require('fs'), path = require('path');",
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { process.stdout.write('2.1.310 (Claude Code)\\n'); process.exit(0); }",
      `fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args) + '\\n');`,
      "const at = args.indexOf('--session-id'), resumeAt = args.indexOf('--resume');",
      'const sid = at >= 0 ? args[at + 1] : resumeAt >= 0 ? args[resumeAt + 1] : null;',
      "const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;",
      `const { projectKey } = require(${JSON.stringify(require.resolve('./forge-claude-session'))});`,
      "const dir = path.join(home, '.claude', 'projects', projectKey(process.cwd()));",
      "const transcript = sid && path.join(dir, sid + '.jsonl');",
      'if (resumeAt >= 0) {',
      `  fs.appendFileSync(${JSON.stringify(orderFile)}, '"resume"\\n');`,
      "  if (!fs.existsSync(transcript)) { process.stderr.write('No conversation found\\n'); process.exit(1); }",
      '}',
      "if (sid) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(transcript, JSON.stringify({ type: 'fixture' }) + '\\n'); }",
      "const out = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const delta = () => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });",
      "out({ type: 'system', subtype: 'init', session_id: sid });",
      "out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-resume', role: 'assistant' } } });",
      "out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });",
      'delta();',
      `const mode = ${JSON.stringify(mode)};`,
      "if (mode === 'start' || mode === 'resume-endless') setInterval(delta, 30);",
      "else if (mode === 'silent') { delta(); setInterval(() => {}, 1000); }",
      'else {',
      "  fs.writeFileSync(path.join(process.cwd(), 'same.txt'), 'worker alpha\\n');",
      "  for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') fs.writeFileSync(path.join(args[i + 1], 'same.txt'), 'worker beta\\n');",
      "  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });",
      "  out({ type: 'stream_event', event: { type: 'message_stop' } });",
      "  const model = args[args.indexOf('--model') + 1];",
      "  out({ type: 'result', subtype: 'success', is_error: false, result: 'fixture', structured_output: { status: 'done', summary: 'Resumed fixture',",
      "    files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] },",
      '    usage: { input_tokens: 11, output_tokens: 13 }, modelUsage: { [model]: { inputTokens: 11, outputTokens: 13 } } });',
      '}',
      '',
    ].join('\n'));
    return file;
  };
  const cli = Object.fromEntries(['start', 'resume-ok', 'resume-endless', 'silent'].map(mode => [mode, writeCli(mode)]));
  const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const reset = () => { fs.rmSync(orderFile, { force: true }); fs.rmSync(argvFile, { force: true }); };
  // Accelerated model clock (S03 mechanism): real time until the first remote
  // progress, then x300, so the 60 s explicit ceiling or the 240 s dead-silence
  // threshold is reached in under a second of real time.
  const accelerated = options => {
    const t0 = performance.now();
    let pivot = null;
    return { monotonicClock: () => { const now = performance.now(); return pivot === null ? now - t0 : (pivot - t0) + (now - pivot) * 300; },
      livenessIntervalMs: 25,
      onProgress: snapshot => { if (pivot === null && snapshot.phase !== 'local-start') pivot = performance.now(); return options.onProgress?.(snapshot); } };
  };
  function unitRequest(id, timeoutSecs) {
    const lab = fixtures.fixture();
    const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
      cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract,
      workflowId: 'claude-resume-fixture', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.',
      verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
    const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
    fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
    request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
    fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
    fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
    fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
      ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
    resolveContext(request);
    request.route = { ...request.route, workers_timeout: timeoutSecs, workers_timeout_source: 'explicit' };
    delete request.route.workers_timeout_warning;
    request.runId = `claude-resume-${id}`;
    request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
      paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
    request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
    runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
    return { lab, request, recovery: { stateFile: `${request.resultFile}.recovery.json`, receiptFile: `${request.resultFile}.receipt.json` } };
  }
  // Trusted authorship callback of the fixture: the start wrote nothing, so the
  // real reset reconciles every declared root without attributing a change.
  const runtime = { processProbe: () => 'stopped', verifyOwnership: () => true };
  const attempt = async fn => { try { return { value: await fn() }; } catch (error) { return { error }; } };
  // Starts the unit and returns the preserved session ref read from .recovery.json.
  async function startActive(id) {
    reset();
    const unit = unitRequest(id, 60);
    process.env.FORGE_XLLM_CLAUDE_BIN = cli.start;
    seam = accelerated;
    const started = await attempt(() => fresh.runUnitSidecar(unit.request));
    seam = () => ({});
    assert.strictEqual(started.error && started.error.code, 'budget-exceeded-while-active', started.error ? started.error.stack : 'no failure');
    const state = JSON.parse(fs.readFileSync(unit.recovery.stateFile, 'utf8'));
    const ref = state.attempts.at(-1).session;
    assert(session.validateSessionRef(ref).ok, 'the recovery state keeps a valid ref');
    unit.ref = ref;
    unit.receiptBytes = fs.readFileSync(unit.recovery.receiptFile);
    return unit;
  }
  const targetsAbsent = ref => session.sessionTargets({ configDir: ref.config_dir, cwd: ref.cwd, id: ref.id })
    .every(target => !fs.existsSync(target.path));
  const resumedFiles = unit => fs.readdirSync(unit.lab.dir).filter(name => name.startsWith(`${path.basename(unit.request.resultFile)}.recovery-`));
  try {
    // 1. Full cycle: start -> active ceiling -> recovery -> reconcile -> --resume -> success.
    const main = await startActive('resume-main');
    try {
      const [startArgs] = lines(argvFile);
      const id = startArgs[startArgs.indexOf('--session-id') + 1];
      assert(session.SESSION_ID_PATTERN.test(id) && id === main.ref.id, 'start argv carries the Forge uuid');
      assert(!startArgs.includes('--no-session-persistence') && !startArgs.includes('--resume'));
      assert(!targetsAbsent(main.ref), 'transcript preserved for the single resume');
      process.env.FORGE_XLLM_CLAUDE_BIN = cli['resume-ok'];
      const recovered = await attempt(() => fresh.recoverUnitSidecar(main.request, main.recovery, runtime));
      assert(!recovered.error, recovered.error && recovered.error.stack);
      assert.strictEqual(recovered.value.action, 'invoke');
      assert.strictEqual(recovered.value.result && recovered.value.result.status, 'done', JSON.stringify(recovered.value.result));
      assert.strictEqual(recovered.value.sidecar_ceiling.seconds, 60, 'resume keeps the route ceiling');
      const argv = lines(argvFile);
      assert.strictEqual(argv.length, 2, JSON.stringify(argv));
      const resumeArgs = argv[1];
      assert.strictEqual(resumeArgs[resumeArgs.indexOf('--resume') + 1], id);
      for (const flag of ['--session-id', '--no-session-persistence', '--fork-session']) assert(!resumeArgs.includes(flag), `resume argv without ${flag}`);
      const order = lines(orderFile);
      assert(order.includes('reconcile') && order.includes('resume'), JSON.stringify(order));
      assert(order.indexOf('reconcile') < order.indexOf('resume'), `reconcile before the resume spawn: ${JSON.stringify(order)}`);
      const resumedReceipts = resumedFiles(main).filter(name => name.endsWith('.json.receipt.json'));
      assert.strictEqual(resumedReceipts.length, 1, JSON.stringify(resumedFiles(main)));
      const resumedReceipt = JSON.parse(fs.readFileSync(path.join(main.lab.dir, resumedReceipts[0]), 'utf8'));
      assert.strictEqual(resumedReceipt.resumed_from.receipt_sha256, crypto.createHash('sha256').update(main.receiptBytes).digest('hex'));
      assert.strictEqual(resumedReceipt.resumed_from.dispatch_id, main.request.dispatchId);
      assert.strictEqual(resumedReceipt.session_sha256, session.sessionDigest(id));
      const events = path.join(main.lab.owner, '.gsd/forge/events.jsonl');
      const channels = [main.recovery.receiptFile, main.request.resultFile, events,
        ...resumedFiles(main).filter(name => !name.endsWith('.recovery.json')).map(name => path.join(main.lab.dir, name))];
      for (const file of channels) if (fs.existsSync(file)) assert(!fs.readFileSync(file, 'utf8').includes(id), `raw id absent from ${path.basename(file)}`);
      assert(targetsAbsent(main.ref), 'the four session targets are gone after the resume');
    } finally { main.lab.cleanup(); }
    console.log('PASS claude resume: start --session-id -> active ceiling -> recoverUnitSidecar -> reconcile before --resume (no --session-id/legacy flag) -> chained receipt (resumed_from sha of the previous receipt, session_sha256) -> done; raw id absent; four targets removed');

    // 2. Exhausted: the resume hits the ceiling again; the next recovery stops without a third spawn.
    const exhausted = await startActive('resume-exhausted');
    try {
      process.env.FORGE_XLLM_CLAUDE_BIN = cli['resume-endless'];
      seam = accelerated;
      const second = await attempt(() => fresh.recoverUnitSidecar(exhausted.request, exhausted.recovery, runtime));
      seam = () => ({});
      assert.strictEqual(second.error && second.error.code, 'budget-exceeded-while-active', second.error ? second.error.stack : JSON.stringify(second.value));
      assert.strictEqual(lines(argvFile).length, 2);
      // The next recovery inspects the latest attempt: the resume's own receipt/dispatch.
      const resumedReceipt = resumedFiles(exhausted).find(name => name.endsWith('.json.receipt.json'));
      const resumedResult = path.join(exhausted.lab.dir, resumedReceipt.slice(0, -'.receipt.json'.length));
      const resumedDispatch = JSON.parse(fs.readFileSync(path.join(exhausted.lab.dir, resumedReceipt), 'utf8')).dispatch_id;
      const third = await attempt(() => fresh.recoverUnitSidecar({ ...exhausted.request, dispatchId: resumedDispatch, resultFile: resumedResult },
        { stateFile: exhausted.recovery.stateFile, receiptFile: `${resumedResult}.receipt.json` }, runtime));
      assert(!third.error, third.error && third.error.stack);
      assert.strictEqual(third.value.action, 'stop', JSON.stringify(third.value));
      assert.strictEqual(third.value.reason_code, 'budget-exceeded-resume-exhausted');
      assert.strictEqual(lines(argvFile).length, 2, 'no third spawn');
      assert(targetsAbsent(exhausted.ref), 'session removed');
    } finally { exhausted.lab.cleanup(); }
    console.log('PASS claude resume exhausted: a second active ceiling stops with budget-exceeded-resume-exhausted, no third spawn, session removed');

    // 3. Dead silence at the start: never resumed; the adapter already removed the session.
    reset();
    const dead = unitRequest('resume-dead', 3600);
    try {
      process.env.FORGE_XLLM_CLAUDE_BIN = cli.silent;
      seam = accelerated;
      const started = await attempt(() => fresh.runUnitSidecar(dead.request));
      seam = () => ({});
      assert.strictEqual(started.error && started.error.code, 'claude-anomalous-silence', started.error ? started.error.stack : 'no failure');
      const [startArgs] = lines(argvFile);
      const id = startArgs[startArgs.indexOf('--session-id') + 1];
      const ref = { config_dir: path.join(home, '.claude'), cwd: dead.request.cwd, id };
      assert(targetsAbsent(ref), 'dead session removed by the adapter');
      const state = JSON.parse(fs.readFileSync(dead.recovery.stateFile, 'utf8'));
      assert.strictEqual(state.attempts.at(-1).session, undefined, 'no ref recorded for silence');
      process.env.FORGE_XLLM_CLAUDE_BIN = cli['resume-ok'];
      const recovered = await attempt(() => fresh.recoverUnitSidecar(dead.request, dead.recovery, runtime));
      assert.strictEqual(lines(argvFile).filter(args => args.includes('--resume')).length, 0,
        `dead never resumed: ${JSON.stringify(recovered.value || (recovered.error && recovered.error.code))}`);
      console.log(`PASS claude resume dead: dead-silence start never produces a --resume spawn (recovery outcome: ${recovered.error ? recovered.error.code : recovered.value.action || recovered.value.status}); session removed`);
    } finally { dead.lab.cleanup(); }

    // 4. The adapter refuses a resume on any route other than a Claude sidecar,
    // before validation, receipt or spawn (controller substituted at its boundary).
    reset();
    const routed = unitRequest('resume-route', 60);
    const recoveryApi = require('./forge-attempt-recovery'), realRecover = recoveryApi.recoverAttempt;
    try {
      const resume = { session: session.createSessionRef({ id: session.newSessionId(), accountName: 'fixture-resume-account',
        configDir: path.join(home, '.claude'), cwd: routed.request.cwd }), resumed_from: { receipt_sha256: 'd'.repeat(64), dispatch_id: 'resume-route' } };
      for (const route of [{ ...routed.request.route, resolved_worker_engine: 'codex' }, { ...routed.request.route, worker_mode: 'native' }]) {
        recoveryApi.recoverAttempt = async options => options.invoke(route, { ok: true }, null, undefined, 'fixture-reservation', resume);
        const refused = await attempt(() => fresh.recoverUnitSidecar(routed.request, routed.recovery, runtime));
        assert.strictEqual(refused.error && refused.error.code, 'recovery-resume-route-invalid', refused.error ? refused.error.stack : 'accepted');
      }
      assert.strictEqual(lines(argvFile).length, 0, 'no spawn');
      assert.strictEqual(fs.existsSync(routed.recovery.receiptFile), false, 'no receipt');
    } finally { recoveryApi.recoverAttempt = realRecover; routed.lab.cleanup(); }
    console.log('PASS claude resume route: a resume on a codex or native route is refused (recovery-resume-route-invalid) before receipt or spawn');
  } finally {
    seam = () => ({});
    surgical.reconcileFailedAttempt = realReconcile;
    if (previousBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = previousBin;
    claude.invokeClaudeSidecar = realInvoke;
    for (const key of moduleKeys()) delete require.cache[key];
    for (const [key, entry] of saved) require.cache[key] = entry;
    fs.rmSync(work, { recursive: true, force: true });
  }
}
// Memory extraction contract v2 through the real owner acceptance path: schema
// selection, owner-derived evidence bindings, legacy v1 ready receipts,
// deferred publication and replay without any provider call.
async function memoryEvidenceContracts() {
  const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
  const { spawnSync } = require('child_process');
  const extraction = require('./forge-memory-extraction'), memory = require('./forge-memory');
  const projection = require('./forge-projection');
  const { matches } = require('./forge-worker-result-contract');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-memory-')));
  const cwd = path.join(work, 'project'), results = path.join(work, 'results');
  fs.mkdirSync(cwd);
  fs.mkdirSync(results);
  const route = { host_runtime: 'codex', worker_engine: 'native', resolved_worker_engine: 'native', worker_mode: 'native',
    model: 'gpt-6-luna', model_resolved: 'gpt-6-luna', effort: 'medium' };
  const telemetry = { model_requested: null, model_resolved: 'gpt-6-luna', model_argument: 'gpt-6-luna',
    model_observed: null, model_observed_source: null, effort_requested: 'medium', effort_resolved: 'medium',
    effort_argument: 'medium', effort_transport: 'native-argument', effort_transport_value: 'medium',
    effort_transport_source: 'fixture-native-argument', effort_binding_observed: null,
    effort_binding_observed_source: null, effort_binding_observed_fingerprint: null,
    effort_applied: null, effort_applied_source: null, capabilities_source: 'fixture' };
  const extractedAt = '2026-10-24T12:00:00.000Z';
  const joined = { ownerJoined: true, checkedAt: extractedAt, protectedSnapshots: [] };
  const protectedBoundary = { ownerJoined: false, checkedAt: extractedAt, protectedSnapshots: [{ id: 'fixture-worker', state: 'active' }] };
  const request = (name, overrides) => ({ cwd, contextRoot: cwd, unitType: 'memory-extract', sourceUnitType: 'execute-task',
    sourceUnitId: 'T01', milestoneId: 'M001', workflowId: 'memory-workflow', dispatchId: `memory-${name}`,
    extractionId: `extract-${name}`, extractedAt, sourceFingerprint: 'sha256:source',
    summaryContent: 'PRIVATE completed work summary', sourceResult: 'status: done', keyDecisions: [],
    existingMemory: { facts: [], stats: [] }, route, hostRuntime: 'codex',
    resultFile: path.join(results, `${name}.json`), publicationSafe: true, publicationBoundary: joined,
    invocationTelemetry: telemetry, ...(overrides || {}) });
  // The exact pre-v2 native fingerprint formula, as written by older receipts.
  const legacyFormula = r => crypto.createHash('sha256').update(JSON.stringify({ ...r, unitType: 'memory-extract',
    rawResult: undefined, invocationTelemetry: undefined, resultFile: undefined, publicationSafe: undefined,
    publicationBoundary: undefined, waitForPublicationBoundary: undefined })).digest('hex');
  const receiptOf = r => JSON.parse(fs.readFileSync(`${r.resultFile}.receipt.json`, 'utf8'));
  const fragmentBytes = unitId => fs.readFileSync(memory.fragmentPath(cwd, unitId, { milestoneId: 'M001' }));
  const projected = identity => projection.projectMemoryState(cwd, { nowMs: Date.parse(extractedAt) }).entries
    .find(entry => entry.identity === identity);
  const memoryEvents = dispatchId => {
    const file = path.join(cwd, '.gsd/forge/events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === dispatchId) : [];
  };
  const verified = {
    records: [
      { evidence_ref: 'verified', observation_id: 'obs-verify-T05', observed_kind: 'confirm', independent_ref: 'verify:T05:check-1' },
      { evidence_ref: 'used', observation_id: 'obs-use-T05', observed_kind: 'utility' },
    ],
    outcomes: [{ outcome_ref: 'passed', outcome_id: 'outcome-T05', result_ref: 'result:T05:verify' }],
  };
  const v2 = (events, facts) => ({ schema_version: 2, status: 'done', summary: 'v2 evidence', questions: [], facts: facts || [], events });
  try {
    // 1. Explicit schema selection: v1 export unchanged, v2 requested, v1 decodable.
    assert.strictEqual(sidecar.NEW_MEMORY_SCHEMA_VERSION, 2);
    assert.strictEqual(sidecar.memoryExtractionSchema(1), sidecar.memorySchema);
    assert.deepStrictEqual(sidecar.memoryExtractionSchema(2),
      JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'schemas', 'memory-extraction-v2.schema.json'), 'utf8')));
    assert.throws(() => sidecar.memoryExtractionSchema(3), error => error.code === 'memory-schema-version-unsupported');
    assert.strictEqual(sidecar.memoryResponseSchema(1), sidecar.memorySchema);
    const v2Sample = v2([{ kind: 'seed', local_event_id: 'e0', local_id: 'fresh' }],
      [{ local_id: 'fresh', category: 'pattern', text: 'Owner-bound v2 fact.', confidence_base: 0.9 }]);
    const v1Sample = { schema_version: 1, status: 'done', summary: 'legacy', questions: [], facts: [], events: [{ kind: 'hit', existing_id: 'MEM001' }] };
    assert(matches(v2Sample, sidecar.memoryTransportSchema) && matches(v1Sample, sidecar.memoryTransportSchema));
    for (const invalid of [{ ...v2Sample, schema_version: 3 }, { ...v2Sample, extra: true },
      v2([{ kind: 'hit', local_event_id: 'e1', existing_id: 'MEM001' }]), { ...v1Sample, events: [{ kind: 'exposure', existing_id: 'MEM001' }] }]) {
      assert(!matches(invalid, sidecar.memoryTransportSchema), JSON.stringify(invalid));
    }
    const prompt = sidecar.memoryPrompt(request('prompt', { memoryEvidence: verified }), 'T01');
    const promptContract = sidecar.memoryEvidenceContract(request('prompt', { memoryEvidence: verified }), 'T01');
    assert(prompt.includes(sidecar.MEMORY_QUALITY_CONTRACT) && sidecar.MEMORY_QUALITY_CONTRACT.includes('schema_version 2')
      && sidecar.MEMORY_QUALITY_CONTRACT.includes('three independent confirmations'));
    assert(prompt.includes(`SCHEMA:\n${JSON.stringify(sidecar.memorySchemaV2)}`));
    assert(prompt.includes('"evidence_refs":[{"evidence_ref":"source_exposure","observed_kind":"exposure"},{"evidence_ref":"source_reobserve","observed_kind":"reobserve"},{"evidence_ref":"used","observed_kind":"utility"},{"evidence_ref":"verified","observed_kind":"confirm"}]'));
    assert(prompt.includes('"outcome_refs":[{"outcome_ref":"passed"}]'));
    for (const record of promptContract.records) assert(!prompt.includes(record.observation_id), 'observations stay with the owner');
    assert(!prompt.includes('verify:T05:check-1'), 'independence proof stays with the owner');
    console.log('PASS memory schema selection: v1 export unchanged, transports request v2 with v1 decodable, prompt carries refs only');

    // 2. Owner-derived evidence: source identity plus structured owner records only.
    const contract = sidecar.memoryEvidenceContract(request('contract', { memoryEvidence: verified }), 'T01');
    assert.deepStrictEqual(contract.records.map(record => record.evidence_ref), ['source_exposure', 'source_reobserve', 'used', 'verified']);
    assert(contract.records.every(record => record.source_unit === 'execute-task/T01' && record.source_fingerprint === 'sha256:source'));
    const sourceObservation = value => value.records.find(record => record.evidence_ref === 'source_reobserve').observation_id;
    const reattempt = sidecar.memoryEvidenceContract(request('contract-again', { extractionId: 'another-extraction',
      extractedAt: '2026-10-25T00:00:00.000Z', existingMemory: { facts: [{ mem_id: 'MEM009' }], stats: [] } }), 'T01');
    assert.strictEqual(sourceObservation(reattempt), sourceObservation(contract), 'attempt, time and existingMemory never make a new observation');
    assert.notStrictEqual(sourceObservation(sidecar.memoryEvidenceContract(request('other-source', { summaryContent: 'Another source' }), 'T01')),
      sourceObservation(contract));
    assert(!reattempt.records.some(record => ['confirm', 'utility'].includes(record.observed_kind)),
      'without owner verification there is no confirm or utility reference');
    let refusal = 0;
    for (const memoryEvidence of [
      { records: [{ evidence_ref: 'verified', observation_id: 'obs-x', observed_kind: 'confirm' }] },
      { records: [{ evidence_ref: 'foreign', observation_id: 'obs-y', observed_kind: 'reobserve', source_unit: 'execute-task/T99' }] },
      { records: [{ evidence_ref: 'source_exposure', observation_id: 'obs-z', observed_kind: 'exposure' }] },
      { records: [], outcomes: [], path: '/etc/passwd' },
      'not-an-object',
    ]) {
      const refused = request(`refused-${refusal += 1}`, { memoryEvidence });
      await assert.rejects(sidecar.acceptNativeMemoryResult({ ...refused, rawResult: v2Sample }),
        error => error.code === 'memory-evidence-invalid' && !String(error.message).includes('/etc/passwd'));
      assert(!fs.existsSync(`${refused.resultFile}.receipt.json`), 'refused owner evidence precedes any receipt');
    }
    console.log('PASS owner evidence: source-bound, attempt-independent observations; unverified/divergent/reserved evidence refused before receipt');

    // 3. A pre-v2 ready receipt (promote pending) replays with the historical
    // rule and identities, without a provider, before and after this update.
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts: [{ mem_id: 'MEM001', category: 'architecture',
      text: 'Reusable architecture constraint.', confidence_base: 0.9, created_at: '2026-10-01T00:00:00.000Z',
      source_unit: 'execute-task/T01' }], stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z', confidence_base: 0.9, hits: 2 }] });
    const legacyRequest = request('legacy-v1', { policy: { decision: 'extract' } });
    const legacyExtraction = extraction.validateExtractionResult({ schema_version: 1, status: 'done', summary: 'Pending promotion',
      questions: [], facts: [], events: [{ kind: 'hit', existing_id: 'MEM001' }, { kind: 'promote', existing_id: 'MEM001', threshold_met: true }] });
    const legacyReceipt = { phase: 'ready', kind: 'memory-extraction', fingerprint: legacyFormula(legacyRequest),
      dispatch_id: legacyRequest.dispatchId, extraction_id: legacyRequest.extractionId, extracted_at: extractedAt,
      source_unit: 'T01', model: 'gpt-6-luna', effort: 'medium', telemetry, extraction: legacyExtraction, artifacts: [] };
    fs.writeFileSync(`${legacyRequest.resultFile}.receipt.json`, JSON.stringify(legacyReceipt));
    let providerCalls = 0;
    const provider = async () => { providerCalls += 1; throw new Error('provider must not run on replay'); };
    const legacyReplay = await sidecar.runNativeMemory(legacyRequest, provider);
    assert.deepStrictEqual([legacyReplay.status, legacyReplay.replayed, legacyReplay.provider_called], ['done', true, false]);
    assert.deepStrictEqual([legacyReplay.publication.status, legacyReplay.publication.schema_version, legacyReplay.publication.promotion_policy],
      ['written', 1, 'v1'], JSON.stringify(legacyReplay.publication));
    const legacyStats = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).stats;
    assert.deepStrictEqual(legacyStats.filter(stat => String(stat.event_id || '').startsWith('extract-legacy-v1:')).map(stat => stat.event_id).sort(),
      ['extract-legacy-v1:event:000', 'extract-legacy-v1:event:001'], 'v1 extractionId:event:index identities');
    assert.strictEqual(projected('M001/T01/MEM001').promoted, true);
    assert.strictEqual(projected('M001/T01/MEM001').evidence.v2.independent_confirmation_count, 0, 'legacy replay creates no independent confirmation');
    const legacyAgain = await sidecar.runNativeMemory(legacyRequest, provider);
    assert.deepStrictEqual([legacyAgain.publication.status, legacyAgain.publication.reason], ['noop', 'replay']);
    assert.strictEqual(receiptOf(legacyRequest).memory_contract, undefined, 'the legacy receipt is never rewritten');
    assert.strictEqual(receiptOf(legacyRequest).fingerprint, legacyReceipt.fingerprint);
    const divergent = await sidecar.runNativeMemory({ ...legacyRequest, summaryContent: 'unrelated request' }, provider);
    assert.strictEqual(divergent.reason_code, 'dispatch-identity-conflict');
    assert.strictEqual(providerCalls, 0);
    console.log('PASS legacy v1 ready receipt: pending promotion replays under historical rules and IDs, provider count zero, divergence conflicts');

    // 4. New v2 receipt: owner bindings, deferred publication, replay in a new process.
    memory.writeFragment(cwd, { unit_id: 'T02', milestone_id: 'M001', facts: [{ mem_id: 'MEM001', category: 'gotcha',
      text: 'Origin fact for T02.', confidence_base: 0.8, created_at: '2026-10-01T00:00:00.000Z', source_unit: 'execute-task/T02',
      extraction_id: 'origin-extraction', source_fingerprint: 'sha256:origin' }], stats: [] });
    const t02 = (name, overrides) => request(name, { sourceUnitId: 'T02', memoryEvidence: verified, ...(overrides || {}) });
    const v2Events = [
      { kind: 'seed', local_event_id: 'e0', local_id: 'fresh' },
      { kind: 'confirm', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'verified' },
      { kind: 'reobserve', local_event_id: 'e2', existing_id: 'MEM001', evidence_ref: 'source_reobserve' },
      { kind: 'utility', local_event_id: 'e3', existing_id: 'MEM001', evidence_ref: 'used', outcome_ref: 'passed' },
    ];
    const evidenceRequest = t02('v2-evidence', { publicationSafe: false, publicationBoundary: protectedBoundary });
    const t02Before = fragmentBytes('T02');
    const deferred = await sidecar.acceptNativeMemoryResult({ ...evidenceRequest, rawResult: v2(v2Events, v2Sample.facts) });
    assert.strictEqual(deferred.publication.status, 'deferred');
    assert(fragmentBytes('T02').equals(t02Before), 'a protected boundary defers every canonical write');
    assert.deepStrictEqual(memoryEvents(evidenceRequest.dispatchId), []);
    const receipt = receiptOf(evidenceRequest);
    assert.deepStrictEqual([receipt.phase, receipt.extraction.schema_version, receipt.memory_contract.schema_version], ['ready', 2, 2]);
    assert.strictEqual(receipt.memory_contract.evidence.digest, sidecar.memoryEvidenceContract(evidenceRequest, 'T02').digest);
    assert.strictEqual(receipt.fingerprint, sidecar.nativeMemoryFingerprint(evidenceRequest));
    assert.notStrictEqual(receipt.fingerprint, legacyFormula(evidenceRequest), 'new requests bind version and evidence');
    assert(!JSON.stringify(receipt).includes('PRIVATE'), 'the receipt keeps bounded refs, not source text');
    const joinedRequest = { ...evidenceRequest, publicationSafe: true, publicationBoundary: joined };
    const written = await sidecar.runNativeMemory(joinedRequest, provider);
    assert.deepStrictEqual([written.status, written.replayed, written.provider_called, written.publication.status],
      ['done', true, false, 'written'], JSON.stringify(written.publication));
    assert.deepStrictEqual([written.publication.schema_version, written.publication.promotion_policy], [2, 'v2']);
    const t02Stats = memory.readFragment(cwd, 'T02', { milestoneId: 'M001' }).stats;
    const storedConfirm = t02Stats.find(stat => stat.kind === 'confirm');
    assert.deepStrictEqual([storedConfirm.event_id, storedConfirm.observation_id, storedConfirm.independent_ref],
      ['extract-v2-evidence:v2:e1', 'obs-verify-T05', 'verify:T05:check-1']);
    assert.strictEqual(t02Stats.find(stat => stat.kind === 'reobserve').observation_id, sourceObservation(receipt.memory_contract.evidence));
    const t02Entry = projected('M001/T02/MEM001');
    const counters = t02Entry.evidence.counters;
    assert.deepStrictEqual([counters.independent_confirmation.count, counters.reobserve.count, counters.utility.count, t02Entry.hits], [1, 1, 1, 1]);
    const published = written.publication.state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual([published.hits, published.confidence, published.independent_confirmation_count],
      [t02Entry.hits, t02Entry.base_confidence, t02Entry.evidence.v2.independent_confirmation_count]);
    const [publicationEvent] = memoryEvents(evidenceRequest.dispatchId);
    assert.deepStrictEqual([publicationEvent.publication_status, publicationEvent.schema_version, publicationEvent.memory_contract_version],
      ['written', 2, 2]);
    assert(!JSON.stringify(publicationEvent).includes('PRIVATE') && !JSON.stringify(publicationEvent).includes('verify:T05'));
    const requestFile = path.join(results, 'v2-evidence-request.json');
    fs.writeFileSync(requestFile, JSON.stringify(joinedRequest));
    const restarted = spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-sidecar.js'), '--accept-native-memory', requestFile],
      { cwd, encoding: 'utf8' });
    assert.strictEqual(restarted.status, 0, restarted.stderr);
    const restartedResult = JSON.parse(restarted.stdout);
    assert.deepStrictEqual([restartedResult.publication.status, restartedResult.publication.reason], ['noop', 'replay']);
    assert.strictEqual(memoryEvents(evidenceRequest.dispatchId).length, 1, 'replay appends no second publication event');
    console.log('PASS v2 receipt: owner-bound confirm/reobserve/utility, deferred boundary, replay in a new process without provider');

    // 5. Stable identities, deduplicated observations and explicit conflicts.
    let settled = fragmentBytes('T02');
    const reordered = await sidecar.acceptNativeMemoryResult({ ...t02('v2-reordered', { extractionId: 'extract-v2-evidence' }),
      rawResult: v2([...v2Events.slice(1)].reverse()) });
    assert.deepStrictEqual([reordered.publication.status, reordered.publication.reason], ['noop', 'replay'], 'same local_event_id, any order');
    const repackaged = await sidecar.acceptNativeMemoryResult({ ...t02('v2-repackaged'),
      rawResult: v2([{ kind: 'confirm', local_event_id: 'c9', existing_id: 'MEM001', evidence_ref: 'verified' }]) });
    assert.strictEqual(repackaged.publication.status, 'written', 'new delivery identity is retained without reinforcement');
    assert(!fragmentBytes('T02').equals(settled));
    settled = fragmentBytes('T02');
    assert.strictEqual(repackaged.publication.state.find(item => item.mem_id === 'MEM001').independent_confirmation_count, 1);
    const conflicting = await sidecar.acceptNativeMemoryResult({ ...t02('v2-conflict', { extractionId: 'extract-v2-evidence' }),
      rawResult: v2([{ kind: 'reobserve', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'source_reobserve' }]) });
    assert.deepStrictEqual([conflicting.status, conflicting.publication.status], ['done', 'conflict']);
    const [conflictEvent] = memoryEvents(conflicting.dispatch_id || 'memory-v2-conflict');
    assert.deepStrictEqual([conflictEvent.publication_reason, conflictEvent.publication_reason_code],
      ['memory-publication-conflict', 'publication-conflict']);
    assert(fragmentBytes('T02').equals(settled), 'no-op and conflict leave the fragment untouched');
    console.log('PASS v2 identities: reordered events are no-ops; repackaged IDs persist without reinforcement; conflicts write nothing');

    // 6. Missing bindings, unverified claims and a tampered snapshot never write.
    for (const [name, overrides, events] of [
      ['v2-outcome-missing', {}, [{ kind: 'utility', local_event_id: 'u1', existing_id: 'MEM001', evidence_ref: 'used', outcome_ref: 'missing' }]],
      ['v2-unverified', { memoryEvidence: undefined }, [{ kind: 'confirm', local_event_id: 'c1', existing_id: 'MEM001', evidence_ref: 'verified' }]],
    ]) {
      const refused = t02(name, overrides);
      await assert.rejects(sidecar.acceptNativeMemoryResult({ ...refused, rawResult: v2(events) }),
        error => error.code === 'MEMORY_EXTRACTION_INVALID');
      assert.strictEqual(receiptOf(refused).phase, 'failed');
      const replayedFailure = await sidecar.runNativeMemory(refused, provider);
      assert.deepStrictEqual([replayedFailure.status, replayedFailure.reason_code, replayedFailure.provider_called],
        ['failure', 'MEMORY_EXTRACTION_INVALID', false], 'a failed receipt is never relaunched');
    }
    const tamperRequest = t02('v2-tamper', { publicationSafe: false, publicationBoundary: protectedBoundary });
    const tamperDeferred = await sidecar.acceptNativeMemoryResult({ ...tamperRequest,
      rawResult: v2([{ kind: 'reobserve', local_event_id: 'r7', existing_id: 'MEM001', evidence_ref: 'source_reobserve' }]) });
    assert.strictEqual(tamperDeferred.publication.status, 'deferred');
    const tampered = receiptOf(tamperRequest);
    tampered.memory_contract.evidence.records[0].observation_id = 'obs-forged';
    fs.writeFileSync(`${tamperRequest.resultFile}.receipt.json`, JSON.stringify(tampered));
    const tamperReplay = await sidecar.acceptNativeMemoryResult({ ...tamperRequest, publicationSafe: true, publicationBoundary: joined });
    assert.deepStrictEqual([tamperReplay.publication.status, tamperReplay.publication.reason_code], ['conflict', 'evidence-registry-refused']);
    assert(fragmentBytes('T02').equals(settled));
    console.log('PASS v2 refusals: missing outcome and unverified confirm fail validation, failed receipts never relaunch, tampered snapshots conflict');

    // 7. A v1 envelope under the v2 contract keeps v1 identities but cannot bypass the v2 promotion rule.
    const v1Under = await sidecar.acceptNativeMemoryResult({ ...t02('v1-under-v2'), rawResult: { schema_version: 1, status: 'done',
      summary: 'legacy shape', questions: [], facts: [], events: [{ kind: 'hit', existing_id: 'MEM001' },
        { kind: 'promote', existing_id: 'MEM001', threshold_met: true }] } });
    assert.deepStrictEqual([v1Under.publication.status, v1Under.publication.reason_code, v1Under.publication.promotion_policy],
      ['conflict', 'promotion-threshold-not-met', 'v2']);
    assert.strictEqual(receiptOf(t02('v1-under-v2')).memory_contract.schema_version, 2);
    assert(fragmentBytes('T02').equals(settled));
    assert.strictEqual(providerCalls, 0);
    console.log('PASS v1 envelope under the v2 contract: historical identities, v2 promotion rule, no partial write');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function reviewFixRecoveryContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
  const recovery = require('./forge-attempt-recovery'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const fix = require('./forge-review-fix'), lab = fixtures.fixture();
  const originalRunFix = xllm.runFix;
  const contract = roots.singleContract(lab.owner, lab.a);
  const reviewFile = '.gsd/milestones/M001/slices/S01/S01-REVIEW.md';
  fs.mkdirSync(path.dirname(path.join(lab.owner, reviewFile)), { recursive: true });
  fs.writeFileSync(path.join(lab.owner, reviewFile), '# Review\n\n### R1 — bug\n- **Veredito:** CONCEDED\n');
  fs.writeFileSync(path.join(lab.owner, '.gsd/milestones/M001/M001-ROADMAP.md'), '# Roadmap\n\n- [ ] **S01: Work** `depends:[]`\n');
  fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5', 'gpt-6-sol']])) }));
  const request = resolveContext({ unitType: 'review-fix', milestoneId: 'M001', sliceId: 'S01',
    cwd: lab.a, contextRoot: lab.owner, resultFile: path.join(lab.dir, 'fix.json'), workflowId: 'fixture', dispatchId: 'fix-legacy',
    constraints: { auto_commit: false }, reviewFix: { boundary: 'slice', decision: 'proceed', claimPaths: ['same.txt'],
      items: [{ r: 'R1', path: 'same.txt', claim: 'broken', action: 'repair' }] } });
  const executionAuthority = { execution_contract: contract, runId: 'fixture-fixer',
    claim: { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract, paths: [{ root_id: 'primary', path: 'same.txt' }] },
    gates: { claim: 'proceed', security: 'not-applicable' } };
  runs.add(lab.owner, { id: executionAuthority.runId, kind: 'milestone', session_id: 'fixture', write_claim: executionAuthority.claim });
  const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
  let nativeCalls = 0;
  try {
    fs.writeFileSync(path.join(lab.a, 'prior.txt'), 'preexisting\n');
    xllm.runFix = async () => {
      fs.writeFileSync(path.join(lab.a, 'same.txt'), 'partial worker\n');
      return { status: 'partial', summary: 'fixture', items: [], files_changed: ['same.txt'],
        transport_telemetry: { model_observed: 'fix-fixture-model' } };
    };
    await assert.rejects(sidecar.runUnitSidecar(request), error => error.code === 'review-fix-worker-partial');
    const receiptBytes = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBytes);
    const returnedBytes = fs.readFileSync(request.resultFile + '.returned.json');
    assert.strictEqual(JSON.parse(returnedBytes).result.summary, 'fixture');
    assert.strictEqual(receipt.phase, 'failed');
    assert.strictEqual(receipt.returned_response.sha256, crypto.createHash('sha256').update(returnedBytes).digest('hex'));
    assert.strictEqual(receipt.telemetry.model_observed, 'fix-fixture-model');
    const baselineFile = receipt.reset_state_file, baselineBytes = fs.readFileSync(baselineFile);
    const originalState = fs.readFileSync(stateFile);
    assert.strictEqual(receipt.failure.reset.verified, true);
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'before\n');
    assert.strictEqual(JSON.parse(originalState).roots_sha256, roots.digest({ cwd: request.cwd }));
    assert.strictEqual(sidecar.reconcileLegacyReviewFix(request, receipt, contract).ok, true);
    for (const content of ['changed prior\n', null]) {
      if (content === null) fs.unlinkSync(path.join(lab.a, 'prior.txt'));
      else fs.writeFileSync(path.join(lab.a, 'prior.txt'), content);
      assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, contract), /baseline-changed/);
      fs.writeFileSync(path.join(lab.a, 'prior.txt'), 'preexisting\n');
    }
    fs.writeFileSync(path.join(lab.a, 'new.txt'), 'new\n');
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, contract), /baseline-changed/);
    fs.unlinkSync(path.join(lab.a, 'new.txt'));
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, lab.contract), /recovery-roots/);
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, { ...receipt, dispatch_id: 'foreign' }, contract), /binding/);
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, { ...receipt, reset_state_file: path.join(lab.dir, 'foreign.json') }, contract), /binding/);
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, { ...receipt, failure: { ...receipt.failure, reset: { verified: false } } }, contract), /reset-unverified/);
    const baseline = JSON.parse(baselineBytes);
    for (const repos of [[], [baseline], {}, null]) {
      fs.writeFileSync(baselineFile, JSON.stringify({ ...baseline, repos }));
      assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, contract), /recovery-roots/);
    }
    fs.writeFileSync(baselineFile, JSON.stringify({ ...baseline, start_sha: '0'.repeat(40) }));
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, contract), /baseline-changed/);
    fs.writeFileSync(baselineFile, baselineBytes);
    // A maintenance commit in the writer root is not a completed reset. The
    // repaired runtime lives elsewhere and must leave that original HEAD alone.
    const git = args => require('child_process').execFileSync('git', args, { cwd: lab.a, windowsHide: true, encoding: 'utf8' });
    git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture maintenance in wrong root']);
    assert.throws(() => sidecar.reconcileLegacyReviewFix(request, receipt, contract), /baseline-changed/);
    git(['switch', '--detach', baseline.start_sha]);
    assert.strictEqual(sidecar.reconcileLegacyReviewFix(request, receipt, contract).ok, true);
    const authority = recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() }));
    const runtime = { executionAuthority, processProbe: () => 'stopped',
      activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] },
      recoveryAuthorization: { reference: 'fixture:review-fix', adapter: {
        readStandingAuthorization: () => ({}), issueRecoveryException: (reference, scope) => authority.issue(reference, scope) } },
      invokeNative: async (next, binding, guards) => {
        nativeCalls++;
        assert.strictEqual(binding.args.model, 'gpt-6-sol');
        assert(binding.args.message.includes('same.txt'));
        assert(binding.args.message.includes(`CODE_DIR (physical working directory): ${JSON.stringify(request.cwd)}`));
        assert(binding.args.message.includes(`CONTEXT_ROOT (owner artifacts): ${JSON.stringify(request.contextRoot)}`));
        assert(binding.args.message.includes('resolve claimed relative paths only inside CODE_DIR'));
        assert(binding.args.message.includes('Do not edit owner artifacts or a separate CONTEXT_ROOT checkout'));
        assert(binding.args.message.includes('<!-- forge-procedure:recovery -->'));
        assert.strictEqual(binding.args.message.split('<!-- forge-procedure:core -->').length - 1, 1);
        // The public native callback owns preparation and acceptance. This is a
        // local worker fixture, not a provider invocation or a product receipt.
        const nativePreparation = fix.prepareNativeReviewFix({ ...next, vcs: 'git' });
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'fixed\n');
        guards.assertAuthority(); // Post-write authority does not reassert the old baseline.
        const reviewBeforeRevocation = fs.readFileSync(path.join(lab.owner, reviewFile));
        runs.update(lab.owner, executionAuthority.runId, { active: false });
        assert.throws(() => guards.assertAuthority(), /held-claim/);
        assert(fs.readFileSync(path.join(lab.owner, reviewFile)).equals(reviewBeforeRevocation));
        runs.update(lab.owner, executionAuthority.runId, { active: true });
        guards.assertAuthority();
        return fix.acceptNativeReviewFix({ ...next, nativePreparation,
          rawResult: { status: 'done', items: [{ r: 'R1', outcome: 'fixed', note: 'fixture' }] } });
      } };
    const invoke = patch => sidecar.recoverUnitSidecar(request, { stateFile, receiptFile }, { ...runtime, ...patch });
    await assert.rejects(invoke({ processProbe: () => 'alive' }), /process-receipt-inspection/);
    await assert.rejects(invoke({ executionAuthority: { ...executionAuthority, claim: { ...executionAuthority.claim, generation: 'foreign' } } }), /held-claim/);
    const pending = JSON.parse(originalState);
    pending.pending_questions = [{ id: 'decision', question: 'Required?', status: 'pending' }];
    fs.writeFileSync(stateFile, JSON.stringify(pending));
    assert.strictEqual((await invoke()).action, 'pending-questions');
    assert.strictEqual(nativeCalls, 0);
    fs.writeFileSync(stateFile, originalState);
    await assert.rejects(invoke({ resolveDispatch: options => {
      const route = require('./forge-dispatch-resolve').resolveDispatch(options);
      fs.writeFileSync(baselineFile, JSON.stringify({ ...baseline, reason: 'changed after inspection' }));
      return route;
    } }), /snapshot-changed/);
    assert.strictEqual(nativeCalls, 0);
    fs.writeFileSync(stateFile, originalState);
    fs.writeFileSync(baselineFile, baselineBytes);
    const recovered = await invoke();
    assert.strictEqual(recovered.action, 'invoke', JSON.stringify({ action: recovered.action, reason: recovered.reason_code, rejected: recovered.rejected }));
    assert.strictEqual(recovered.result.ok, true, JSON.stringify(recovered.result.diagnostic));
    assert.strictEqual(recovered.result.result.items[0].verified, true);
    assert.strictEqual(nativeCalls, 1);
    assert(fs.readFileSync(receiptFile).equals(receiptBytes));
    assert(fs.readFileSync(baselineFile).equals(baselineBytes));
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).roots_sha256, roots.digest({ cwd: request.cwd }));
    console.log('PASS legacy review-fix: real failed/reset producer, exact dirty restoration, held claim, pending questions, native prompt and public prepare/accept; historical bytes unchanged');
  } finally { xllm.runFix = originalRunFix; lab.cleanup(); }
}

async function runScenarios() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-profile-'))), previous = {};
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FORGE_HOME']) previous[key] = process.env[key];
  process.env.HOME = process.env.USERPROFILE = profile;
  process.env.CODEX_HOME = path.join(profile, '.codex'); process.env.CLAUDE_CONFIG_DIR = path.join(profile, '.claude');
  process.env.FORGE_HOME = path.resolve(__dirname, '..');
  try {
    if (!selectedScenario || selectedScenario === '--review-fix-recovery') await reviewFixRecoveryContracts();
    if (!selectedScenario || selectedScenario === '--delivery-publication-limits') await deliveryPublicationLimits();
    if (!selectedScenario || selectedScenario === '--recovery-contracts') await recoveryContracts();
    if (!selectedScenario || selectedScenario === '--pre-spawn-sidecar') await preSpawnRecoveryContracts();
    if (!selectedScenario || selectedScenario === '--pre-spawn-native') await preSpawnRecoveryContracts(true);
    if (!selectedScenario || selectedScenario === '--no-progress-event') await noProgressEventContracts();
    if (!selectedScenario || selectedScenario === '--owner-event-reconcile') await ownerEventReconcileContracts();
    if (!selectedScenario || selectedScenario === '--ceiling-route') await ceilingRouteContracts();
    if (!selectedScenario || selectedScenario === '--claude-session') await claudeSessionContracts();
    if (!selectedScenario || selectedScenario === '--claude-resume') await claudeResumeContracts();
    if (!selectedScenario || selectedScenario === '--liveness-heartbeat') await livenessHeartbeatContracts();
    if (!selectedScenario || selectedScenario === '--memory-evidence') await memoryEvidenceContracts();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
runScenarios().catch(error => { console.error(error); process.exitCode = 1; });
