'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
const wrapper = require('./forge-native-execution'), native = require('./forge-native-invocation');
const crypto = require('crypto'), delivery = require('./forge-native-recovery-delivery');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const f = lab.fixture(), oldEnv = { ...process.env };
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const home = path.join(f.dir, 'home'), forge = path.join(home, 'forge');
  Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: forge });
  const source = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
  for (const rel of ['shared/forge-procedures.json', ...manifest.modules.filter(row => row.status === 'ready').map(row => row.path)])
    put(path.join(forge, rel), fs.readFileSync(path.join(source, rel)));
  put(path.join(f.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: { standard: ['gpt-5.6-sol'] }, effort: { 'execute-task': 'high' } }));
  const base = path.join(f.owner, '.gsd/milestones/M901/slices/S01');
  const planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  const plan = lab.plan(f.contract).replace('id: T-roots', 'id: T01').replace('effort: medium', 'effort: high')
    .replace('must_haves:', 'verify:\n  - node check.cjs\nmust_haves:');
  put(planFile, plan); put(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
  const roadmapFile = path.join(f.owner, '.gsd/milestones/M901/M901-ROADMAP.md');
  put(roadmapFile, '# Roadmap\n- [ ] **S01: Native** `depends:[]`\n');
  for (const root of f.contract.code_roots) put(path.join(root.path, 'check.cjs'),
    "require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS claimed root content');");
  const runs = require('./forge-runs'), claims = require('./forge-write-claim'), controller = require('./forge-unit-controller');
  const runId = 'native-milestone-fixture';
  runs.add(f.owner, { id: runId, kind: 'milestone', session_id: 'fixture-native' });
  const claim = claims.recordClaim(f.owner, runId, { schema_version: 2, source: 'plan-writes', unit: 'execute-task/T01',
    execution_contract: f.contract, paths: f.contract.code_roots.map(row => ({ root_id: row.id, path: 'same.txt' })) });
  require('./forge-state').write(f.owner, { milestone: 'M901', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
  controller.begin(f.owner, { milestone: 'M901', unit: 'execute-task/T01', slice: 'S01', host_runtime: 'codex',
    owner_token: 'fixture-owner', idempotency_key: 'fresh-native-begin', ttl_ms: 300000 });
  const begin = controller.lookupRecord(f.owner, 'transaction', 'fresh-native-begin');
  const assertBoundary = () => {
    assert.equal(roots.digest(controller.lookupRecord(f.owner, 'transaction', 'fresh-native-begin')), roots.digest(begin));
    const pending = require('./forge-orchestrate').validatePending({ cwd: f.owner, milestone: 'M901', host_runtime: 'codex', owner_token: 'fixture-owner' },
      { unit: begin.unit, details: { transaction: { idempotency_key: begin.idempotency_key, begin_checksum: require('./forge-orchestrate').checksum(begin) } } });
    assert.equal(pending.ok, true, JSON.stringify(pending));
  };
  const route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', unitId: 'T01',
    milestoneId: 'M901', scope: 'milestone', phase: 'execute', hostRuntime: 'codex', planPath: planFile, roadmapPath: roadmapFile });
  assert.equal(route.worker_mode, 'native'); assert.equal(route.dispatch_allowed, true);
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M901', sliceId: 'S01', taskId: 'T01',
    cwd: f.a, contextRoot: f.owner, planFile, roadmapFile, execution_contract: f.contract, claim, runId, route,
    gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'passed' },
    contextFile: path.join(base, 'S01-CONTEXT.md'), researchFile: path.join(base, 'S01-RESEARCH.md'),
    securityFile: planFile.replace('-PLAN.md', '-SECURITY.md'), workflowId: 'fresh-native-fixture', dispatchId: 'fresh-native-attempt',
    resultFile: path.join(f.dir, 'durable-native-result.json'), prompt: 'Change only both claimed fixture files.',
    constraints: { auto_commit: false, deploy: false },
    verification: { commandTimeoutMs: 30000, commandsByRoot: { alpha: ['node check.cjs'], beta: ['node check.cjs'] } } };
  const requiredInputs = new Map([[request.contextFile, 'NATIVE_CONTEXT_EVIDENCE: preserve the scoped implementation.\n'],
    [request.researchFile, 'NATIVE_RESEARCH_EVIDENCE: both original files contain before.\n'],
    [request.securityFile, 'NATIVE_SECURITY_EVIDENCE: preserve claims and owner metadata.\n']]);
  for (const [file, content] of requiredInputs) put(file, content);
  require('./fixtures/issues-434-436/execution-fixtures.cjs').declareBindings(request);
  const invocationOptions = { hostRuntime: 'codex', resolvedDispatch: route, agentType: 'forge-executor',
    activeCapabilities: { available: true, tool: 'spawn_agent', source: 'observed-fixture-tool',
      models: ['gpt-5.6-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] },
    prompt: request.prompt, forkTurns: 'none', taskName: 'fresh_native_milestone' };
  const result = () => ({ status: 'done', summary: 'Both claimed outputs changed.',
    files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status:
      require('./forge-delivery').inventoryPlan(plan, planFile, { type: 'task', milestone: 'M901', slice: 'S01', id: 'T01' }).criteria.map(c => ({
        kind: c.origin, index: c.index, item: c.text, note: 'Observed fixture assertion.', status: 'met',
        root_id: c.origin === 'artifact' ? roots.resolvePath(f.contract, c.artifact_path).root_id : '',
        evidence: c.origin === 'artifact' ? [] : f.contract.code_roots.map(row => ({ root_id: row.id, check: 'node check.cjs', stdout_line: 'PASS claimed root content' })),
      })) });
  let calls = 0; const receipts = [];
  const options = { request, invocationOptions, nativeInvocation: native.buildNativeInvocation(invocationOptions), assertBoundary, assertAuthority: assertBoundary,
    persistDeliveryReceipt: receipt => receipts.push(receipt), invokeNative: async args => {
      assert(args.message.includes('forge-procedure:execution'));
      for (const module of ['core', 'verification', 'execution'])
        assert.equal(args.message.split('<!-- forge-procedure:' + module + ' -->').length, 2, 'mandatory module occurs once: ' + module);
      assert(args.message.includes('## Plan') && args.message.includes('## Security'));
      assert.equal(args.message.split(plan).length, 2, 'complete task plan occurs once');
      for (const content of requiredInputs.values()) assert.equal(args.message.split(content).length, 2, 'complete required input occurs once');
      assert(!args.message.includes('Otherwise write T##-SUMMARY.md'));
      assert(!args.message.includes('Capture gate/verifier JSON in v1'));
      assert(args.message.includes(request.resultFile));
      calls++; for (const root of f.contract.code_roots) put(path.join(root.path, 'same.txt'), 'after\n'); return result();
    } };
  return { ...f, request, options, result, put, receipts, calls: () => calls,
    cleanup() { process.env = oldEnv; f.cleanup(); } };
}
async function autoGateCase() {
    const f = fixture();
    try {
      Object.assign(f.request.gates, { plan: 'skipped', planSkipReason: 'auto-defer', authorizationReference: 'conversation:fixture-auto-choice' });
      await assert.rejects(wrapper.run(f.options), /execution.*gate/); assert.equal(f.calls(), 0);
      assert(!fs.existsSync(f.request.resultFile + '.manifest.json'));
      await assert.rejects(wrapper.run({ ...f.options, executionPlanGate: {} }), /execution-auto-gate-adapter-required/);
      let attestations = 0;
      const expectedWorkflow = f.request.workflowId, expectedDispatch = f.request.dispatchId,
        expectedReference = f.request.gates.authorizationReference;
      const adapter = require('./forge-task-execution').createAutoPlanGateAdapter(scope => {
        attestations++;
        return { authorized: scope.reference === expectedReference && scope.workflowId === expectedWorkflow
          && scope.dispatchId === expectedDispatch && scope.taskId === 'T01', mode: 'auto', reference: expectedReference };
      });
      f.request.workflowId = 'foreign-workflow';
      await assert.rejects(wrapper.run({ ...f.options, executionPlanGate: adapter }), /execution-auto-gate-not-attested/);
      f.request.workflowId = expectedWorkflow;
      assert.equal(f.calls(), 0); assert(!fs.existsSync(f.request.resultFile + '.manifest.json'));
      const value = await wrapper.run({ ...f.options, executionPlanGate: adapter });
      assert.equal(value.published, true); assert(attestations > 1); assert.equal(f.calls(), 1);
      await assert.rejects(wrapper.run({ ...f.options, executionPlanGate: adapter }), /fresh-native-attempt-exists/);
      assert.equal(f.calls(), 1);
      console.log('PASS fresh native auto-defer: no inferred approval, real opaque exact-scope host adapter reattested through publication');
    } finally { f.cleanup(); }
}
async function main() {
  if (process.argv.includes('--auto-gate-only')) return autoGateCase();
  if (process.argv.includes('--bounded-inputs-only')) return boundedInputs();
  const positive = fixture();
  try {
    const rendered = require('./forge-prompt').renderPrompt({ unitType: 'execute-task', cwd: positive.owner,
      codeDir: positive.a, milestoneId: 'M901', sliceId: 'S01', taskId: 'T01', isolationMode: 'worktree',
      branch: 'fixture-native', autoCommit: false, unitEffort: 'high', standards: {},
      templateDir: path.resolve(__dirname, '../shared/templates/dispatch'), forgeHome: process.env.FORGE_HOME });
    const sentinel = 'SENTINEL_PRIVATE_NATIVE_PROMPT_62584';
    positive.request.prompt = rendered.prompt + '\n' + sentinel; positive.request.procedure_context = rendered.procedure_context;
    positive.options.invocationOptions.resolvedDispatch = structuredClone(positive.request.route);
    positive.options.invocationOptions.prompt = positive.request.prompt;
    positive.options.nativeInvocation = native.buildNativeInvocation(positive.options.invocationOptions);
    const actualInvoke = positive.options.invokeNative;
    let effectivePrompt, invocationHash;
    positive.options.invokeNative = async (...args) => {
      const prompt = args[0].message;
      effectivePrompt = prompt; invocationHash = sha(JSON.stringify(args[1]));
      assert(prompt.includes(sentinel), 'actual worker still receives the exact required prompt');
      assert(prompt.includes('## Worker instructions'));
      assert(/^DELIVERY_MODE: owner-managed-worker-result$/m.test(prompt));
      assert(prompt.includes('The worker must not create or modify owner .gsd files'));
      assert(prompt.includes('[DATA FROM "owner-publication-reference"'));
      const workerInstructions = prompt.split('## Worker instructions')[1].split('## Owner publication reference')[0];
      assert(!/Capture gate|forge-delivery\.js|write T\d+-SUMMARY|DELIVERY-INPUT\.json/.test(workerInstructions));
      assert(prompt.includes(`--cwd "${positive.a}" --gsd-dir "${positive.owner}/.gsd"`));
      const role = fs.readFileSync(path.resolve(__dirname, '../agents/forge-executor.md'), 'utf8');
      assert(role.includes('`DELIVERY_MODE: owner-managed-worker-result`'));
      assert(role.includes('`Owner (parent publication only)`'));
      const standaloneTransport = require('./forge-xllm').buildExecutePrompt('Standalone plan fixture.', {});
      assert(standaloneTransport.includes('HARD PROHIBITIONS'));
      assert(standaloneTransport.includes('NEVER create or modify anything under `.gsd/`'));
      assert(role.includes('`HARD PROHIBITIONS` assigning `.gsd/` exclusively to the orchestrator'));
      const workerBranch = role.slice(role.indexOf('### Modern worker-result workflow'), role.indexOf('### Legacy artifact-owner workflow'));
      assert(workerBranch.includes('Do not follow the artifact-owner Process, Summary Format or Verification publication steps'));
      assert(role.includes('**Artifact-owner workflow only.**'));
      assert(role.includes('Modern workers do not append owner events.'));
      assert(role.includes('**Artifact-owner evidence section only.**'));
      return actualInvoke(...args);
    };
    const value = await wrapper.run(positive.options);
    assert.equal(value.published, true, JSON.stringify({ reason: value.outcome?.reason_code, diagnostic: value.outcome?.diagnostic })); assert.equal(value.status, 'done'); assert.equal(positive.calls(), 1);
    assert.equal(positive.receipts.length, 2); assert.equal(value.delivery.phase, 'ready');
    const diagnosticBytes = fs.readFileSync(value.outcome_file, 'utf8'), diagnostic = JSON.parse(diagnosticBytes);
    assert(!diagnosticBytes.includes(sentinel)); assert(!diagnosticBytes.includes('Worker instructions'));
    assert(!('args' in diagnostic) && !('message' in diagnostic.invocation));
    assert.equal(diagnostic.prompt.sha256, sha(effectivePrompt));
    assert.equal(diagnostic.prompt.bytes, Buffer.byteLength(effectivePrompt));
    assert.equal(diagnostic.invocation.sha256, invocationHash);
    assert.equal(diagnostic.final_evidence.context.sha256, sha(effectivePrompt));
    assert.equal(diagnostic.provider_called, true); assert.equal(diagnostic.result.worker_status, 'done');
    assert.equal(diagnostic.result.sha256, sha(JSON.stringify(value.outcome.result)));
    assert.deepEqual(JSON.parse(fs.readFileSync(value.returned_file)).result, value.outcome.result);
    assert(fs.existsSync(path.join(positive.owner, '.gsd/milestones/M901/slices/S01/tasks/T01/T01-DELIVERY.json')));
    await assert.rejects(wrapper.run(positive.options), { code: 'fresh-native-attempt-exists' });
    assert.equal(positive.calls(), 1, 'fresh entry must not infer over retained evidence');
    const manifest = JSON.parse(fs.readFileSync(positive.request.resultFile + '.manifest.json'));
    const session = wrapper.prepare({ ...positive.options, savedManifest: manifest });
    const replay = session.replayReady(value.delivery); assert.equal(replay.phase, 'ready');
    assert.equal(positive.calls(), 1, 'ready publication replay invokes no provider');
  } finally { positive.cleanup(); }
  if (process.argv.includes('--positive-only')) {
    console.log('PASS fresh native cloned route and precomposed canonical prompt: one module, root publication and replay'); return;
  }
  const partial = fixture();
  try {
    const options = { ...partial.options, invokeNative: async () => ({ ...partial.result(), status: 'partial' }) };
    const value = await wrapper.run(options); assert.equal(value.published, false); assert.equal(value.status, 'partial');
    assert.equal(partial.receipts.length, 1); assert(!fs.existsSync(path.join(partial.owner, '.gsd/milestones/M901/slices/S01/tasks/T01/T01-DELIVERY.json')));
  } finally { partial.cleanup(); }
  const bad = fixture();
  try {
    const options = { ...bad.options, invocationOptions: { ...bad.options.invocationOptions,
      activeCapabilities: { ...bad.options.invocationOptions.activeCapabilities, models: [] } } };
    await assert.rejects(wrapper.run(options), /native-model-unsupported/); assert.equal(bad.calls(), 0);
    assert(!fs.existsSync(bad.request.resultFile + '.manifest.json'));
  } finally { bad.cleanup(); }
  const protectedOwner = fixture();
  try {
    const invoke = protectedOwner.options.invokeNative;
    const value = await wrapper.run({ ...protectedOwner.options, invokeNative: async (...args) => {
      const result = await invoke(...args); fs.appendFileSync(protectedOwner.request.contextFile, 'unauthorized'); return result;
    } });
    assert.equal(value.status, 'failed'); assert.equal(value.published, false);
    assert.match(value.outcome.reason_code, /execution-protected-metadata|milestone-input-changed/);
    assert.equal(JSON.parse(fs.readFileSync(value.returned_file, 'utf8')).accepted, false);
    assert(!fs.existsSync(path.join(protectedOwner.owner, '.gsd/milestones/M901/slices/S01/tasks/T01/T01-DELIVERY.json')));
  } finally { protectedOwner.cleanup(); }
  const failing = fixture();
  try {
    await assert.rejects(wrapper.run({ ...failing.options, invokeNative: async () => failing.result() }), error => {
      assert.match(error.message, /verification/); assert.equal(error.provider_called, true);
      assert(fs.existsSync(error.native_outcome_file) && fs.existsSync(error.native_returned_file)); return true;
    });
    const verification = fs.readdirSync(failing.dir).filter(name => name.startsWith('forge-verification-'));
    assert.equal(verification.length, 1, 'failed real command evidence is retained');
    assert(!fs.existsSync(path.join(failing.owner, '.gsd/milestones/M901/slices/S01/tasks/T01/T01-DELIVERY.json')));
  } finally { failing.cleanup(); }
  await autoGateCase();
  await boundedInputs();
  console.log('PASS fresh milestone native: owner gates, actual root checks/publication, partial retention, binding refusal, owner mutation refusal and ready replay without reinference');
}
async function boundedInputs() {
  const size = fixture();
  try {
    const bytes = Buffer.concat([Buffer.from('\uFEFF'), Buffer.alloc(1024 * 1024 + 37, 0x61)]);
    size.put(size.request.contextFile, bytes);
    assert.equal(delivery.INPUT_MAX_BYTES, 2 * 1024 * 1024);
    assert(delivery.readInput(size.request.contextFile).equals(bytes), '1–2MiB UTF8/BOM source bytes preserved exactly');
    assert.equal(sha(delivery.readInput(size.request.contextFile)), sha(bytes));
    size.put(size.request.contextFile, Buffer.alloc(delivery.INPUT_MAX_BYTES + 1));
    assert.throws(() => delivery.readInput(size.request.contextFile), /execution-input-source_too_large/);
  } finally { size.cleanup(); }
  // Guard every real public milestone observation against accidental fallback
  // to readFileSync. The streaming protected tree census remains independent.
  for (const mode of ['overlimit', 'growth', 'substitution', 'late-growth', 'unbounded-reread']) {
    const f = fixture(), original = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync };
    let armed = false, changed = false, reads = 0;
    const inputs = new Set([f.request.planFile, f.request.contextFile, f.request.securityFile, f.request.researchFile].map(file => path.resolve(file)));
    const descriptors = new Map();
    try {
      if (mode === 'overlimit') fs.appendFileSync(f.request.planFile, Buffer.alloc(delivery.INPUT_MAX_BYTES + 1));
      fs.openSync = function(file, ...args) {
        const fd = original.openSync.call(fs, file, ...args);
        if (typeof file === 'string') descriptors.set(fd, { file: path.resolve(file), observed: false }); return fd;
      };
      fs.readFileSync = function(file, ...args) {
        if (typeof file === 'string' && inputs.has(path.resolve(file))) throw Error('unbounded mandatory input reread');
        return original.readFileSync.call(fs, file, ...args);
      };
      fs.readSync = function(fd, buffer, offset, length, position) {
        const descriptor = descriptors.get(fd), file = descriptor?.file;
        // Only the fixed-buffer input reader, not the separate 64KiB census.
        if (file === path.resolve(f.request.contextFile) && buffer.length === delivery.INPUT_MAX_BYTES + 1 && !descriptor.observed) {
          descriptor.observed = true;
          reads++;
          const trigger = mode === 'late-growth' ? reads === 2 : reads === 1;
          if (armed && trigger && !changed && ['growth', 'late-growth', 'substitution'].includes(mode)) {
            changed = true;
            if (mode === 'substitution') {
              fs.renameSync(file, file + '.old'); fs.writeFileSync(file, 'replacement scoped context\n');
            } else fs.appendFileSync(file, Buffer.alloc(delivery.INPUT_MAX_BYTES + 1));
          }
        }
        return original.readSync.call(fs, fd, buffer, offset, length, position);
      };
      armed = true;
      if (mode === 'unbounded-reread') {
        const value = await wrapper.run(f.options); assert.equal(value.published, true); assert.equal(f.calls(), 1);
      } else {
        await assert.rejects(wrapper.run(f.options), /execution-input-source_(too_large|changed_during_read)/);
        assert.equal(f.calls(), 0); assert(!fs.existsSync(f.request.resultFile + '.manifest.json'));
        if (mode !== 'overlimit') assert(changed, 'actual descriptor observation exercised ' + mode);
      }
    } finally { Object.assign(fs, original); f.cleanup(); }
  }
  for (const provider of [false, 'unknown']) {
    const f = fixture();
    try {
      let calls = 0;
      const options = { ...f.options, invokeNative: async () => { calls++; throw Error('private host error text'); } };
      if (provider === false) options.invocationOptions = { ...options.invocationOptions,
        assertInvocation: () => { throw Object.assign(Error('private pre-tool diagnostic'), { code: 'fixture-pre-tool-refusal' }); } };
      const value = await wrapper.run(options), saved = JSON.parse(fs.readFileSync(value.outcome_file));
      assert.equal(value.published, false); assert.equal(saved.provider_called, provider);
      assert.equal(value.outcome.provider_called, provider); assert.equal(calls, provider === false ? 0 : 1);
      assert(!fs.readFileSync(value.outcome_file, 'utf8').includes('private host error text'));
    } finally { f.cleanup(); }
  }
  console.log('PASS bounded native inputs: descriptor growth/substitution, downstream rereads, no-inference refusal and sanitized true/false/unknown diagnostics');
}
module.exports = { fixture, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
