#!/usr/bin/env node
'use strict';

// No real account/CLI is used. Only the account lookup and external providers
// are substituted; controller, guard, resolver, artifacts and receipts are real.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bidirectional-'));
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
const token = 'fixture-only-never-a-real-account';
accounts.resolveLaunch = () => ({ name: 'fixture', token });
delete require.cache[require.resolve('./forge-claude-sidecar')];
const claude = require('./forge-claude-sidecar');
const xllm = require('./forge-xllm');
const unit = require('./forge-unit-sidecar');
const { resolveDispatch } = require('./forge-dispatch-resolve');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { ARTIFACT_UNITS } = require('./forge-transport-capabilities');
const loop = require('./forge-long-workflow-adapter');
const state = require('./forge-state');
const memory = require('./forge-memory');
const originalCodex = xllm.invokeCodexAppServer;
const originalAuthorize = xllm.authorizeSidecar;
const originalEnv = process.env.FORGE_XLLM_CLAUDE_BIN;
const fixture = path.join(root, 'provider.js');
fs.writeFileSync(fixture, `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('invocations.txt', 'spawn\\n');
fs.writeFileSync('argv.json', JSON.stringify(args));
const p = JSON.parse(fs.readFileSync('payload.json','utf8'));
if (p.failure === 'auth') { process.stderr.write('401 invalid token'); process.exit(1); }
if (p.failure === 'process') { process.stderr.write(process.env[${JSON.stringify(accounts.TOKEN_ENV)}]); process.exit(9); }
if (p.failure === 'invalid') { process.stdout.write('not a result'); process.exit(0); }
if (p.failure === 'wait') { setInterval(() => {}, 1000); }
else process.stdout.write(['---GSD-WORKER-RESULT---','status: '+p.status,'result_json: '+JSON.stringify(p),'---END-RESULT---'].join('\\n'));
`);
process.env.FORGE_XLLM_CLAUDE_BIN = fixture;
let sequence = 0;
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function setup() {
  const cwd = path.join(root, `case-${++sequence}`); fs.mkdirSync(cwd);
  write(path.join(cwd, '.gsd/forge-prefs.jsonc'), { routing: { default: { planner: { heavy: ['claude-opus-5'], max: ['claude-fable-5'] }, executor: { standard: ['claude-sonnet-5'] } } }, tier_models: { standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' } });
  const m = '.gsd/milestones/M001';
  write(path.join(cwd, m, 'M001-ROADMAP.md'), '# Roadmap\n\n- [ ] **S01: Work**\n');
  write(path.join(cwd, m, 'M001-CONTEXT.md'), '# Decisions\n');
  write(path.join(cwd, m, 'slices/S01/S01-PLAN.md'), '# Plan\n\n- [ ] T01: Work\n');
  return cwd;
}
function request(cwd, unitType, engine = 'claude') {
  const host = engine === 'claude' ? 'codex' : 'claude';
  // Test Codex artifact delivery with a route produced from the configured tier.
  if (engine === 'codex') {
    write(path.join(cwd, '.gsd/forge-prefs.jsonc'), { tier_models: { light: 'gpt-5.6-sol', standard: 'gpt-5.6-sol', heavy: 'gpt-5.6-sol', max: 'gpt-5.6-sol' } });
  }
  const route = resolveDispatch({ cwd, unitType, hostRuntime: host });
  const r = { cwd, contextRoot: cwd, unitType, milestoneId: 'M001',
    route,
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}-${unitType}`,
    resultFile: path.join(root, `result-${sequence}-${unitType}.json`), constraints: { auto_commit: false, deploy: false },
    promptFile: path.join(cwd, 'prompt.md') };
  if (/slice|plan-check|execute-task/.test(unitType)) r.sliceId = 'S01';
  if (unitType === 'execute-task') r.taskId = 'T01';
  write(r.promptFile, '# Selected unit\nHonor the operator constraints.');
  return r;
}
function artifactContent(r, p, loc) {
  const rule = loc.rules[p];
  if (rule && rule.kind === 'input') return JSON.stringify({ schema_version: 1, unit: rule.unit,
    plan: 'fixture-plan.md', plan_fingerprint: 'fixture-sha', bindings: [], expected_children: [] });
  if (rule && rule.kind === 'delivery') return JSON.stringify({ schema_version: 1, generated_by: 'forge-delivery',
    unit: rule.unit, delivery_fingerprint: 'fixture-delivery-sha', criteria: [], facts: [] });
  if (rule) return JSON.stringify({ schema_version: 1, kind: rule.kind, unit: rule.unit,
    plan_fingerprint: 'fixture-sha', code_dir: r.cwd, revision: 'abc123', environment: 'fixture',
    captured_at: '2026-09-24T12:00:00Z', result: {} });
  return r.unitType === 'plan-milestone' ? '# Roadmap\n\n- [ ] **S01: Work**\n' : '# Valid artifact\n\nFixture evidence.\n';
}
function payload(r, includeDeliveryEnvelopes = false) { const loc = unit.locations(r);
  const paths = includeDeliveryEnvelopes && loc.delivery
    ? [...loc.required, loc.delivery.verification, loc.delivery.artifact] : loc.required;
  return { status: 'done', summary: 'Fixture delivery', questions: [],
    artifacts: paths.map(p => ({ path: p, content: artifactContent(r, p, loc) })) }; }
function memoryPayload(text = 'The canonical publisher allocates memory IDs under the fragment lock.') {
  return { schema_version: 1, status: 'done', summary: 'One durable fact', questions: [],
    facts: [{ local_id: 'new1', category: 'architecture', text, confidence_base: 0.85 }], events: [] };
}
function memoryRequest(cwd, engine, sourceUnitId, milestoneId) {
  if (engine === 'codex') write(path.join(cwd, '.gsd/forge-prefs.jsonc'), {
    tier_models: { light: 'gpt-5.6-sol', standard: 'gpt-5.6-sol', heavy: 'gpt-5.6-sol', max: 'gpt-5.6-sol' },
  });
  const hostRuntime = engine === 'claude' ? 'codex' : 'claude';
  const route = resolveDispatch({ cwd, unitType: 'memory-extract', hostRuntime,
    workerEngine: engine, workerMode: 'sidecar', sidecarDeclared: true });
  return { cwd, contextRoot: cwd, unitType: 'memory-extract', sourceUnitType: 'execute-task',
    sourceUnitId, ...(milestoneId ? { milestoneId } : {}), route,
    workflowId: `memory-workflow-${sequence}`, dispatchId: `memory-dispatch-${sequence}-${engine}-${sourceUnitId}`,
    extractionId: `extract-${sequence}-${engine}-${sourceUnitId}`, sourceFingerprint: 'fixture-source-sha256',
    summaryContent: 'Completed work summary', sourceResult: 'status: done', keyDecisions: [],
    existingMemory: { facts: [], stats: [] },
    resultFile: path.join(root, `memory-result-${sequence}-${engine}-${sourceUnitId}.json`),
    constraints: { auto_commit: false, deploy: false }, publicationSafe: false,
    publicationBoundary: { ownerJoined: false, checkedAt: '2026-09-24T12:00:00Z',
      protectedSnapshots: [{ id: 'fixture-worker', state: 'active' }] } };
}
async function rejects(fn, code) { await assert.rejects(fn, e => e.code === code, code); }

(async () => {
  const sourceRecord = { source_unit: 'T-20260924000000-source', extraction_id: 'source-extraction',
    extracted_at: '2026-09-24T12:00:00Z', dispatch_id: 'source-dispatch', model: 'gpt-6-luna', effort: 'medium' };
  const sourceA = unit.memorySourceContext({ summaryContent: 'summary A' }, sourceRecord);
  const sourceB = unit.memorySourceContext({ summaryContent: 'summary B' }, sourceRecord);
  assert.match(sourceA.source.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(sourceA.source.sourceFingerprint, sourceB.source.sourceFingerprint);
  for (const sourceUnitId of ['M-20260924223724-route', 'TASK-001']) {
    assert.strictEqual(unit.locations({ unitType: 'memory-extract', sourceUnitId }).sourceUnit, sourceUnitId);
  }

  for (const host of ['claude', 'codex']) for (const engine of ['claude', 'codex']) {
    for (const unitType of [...ARTIFACT_UNITS, 'plan-slice', 'execute-task', 'review-challenger', 'review-advocate', 'review-rebuttal']) {
      assert.strictEqual(evaluateDispatchGuard({ host_runtime: host, worker_engine: engine, unit_type: unitType }).dispatch_allowed, true);
    }
    assert.strictEqual(evaluateDispatchGuard({ host_runtime: host, worker_engine: engine, worker_mode: 'sidecar', unit_type: 'review-fix' }).reason_code, 'unsupported-sidecar-unit');
  }
  for (const engine of ['claude', 'codex']) for (const type of ARTIFACT_UNITS) {
    const cwd = setup(), r = request(cwd, type, engine), p = payload(r);
    write(path.join(cwd, 'payload.json'), p);
    let codexCalls = 0;
    xllm.invokeCodexAppServer = async options => {
      codexCalls++;
      assert.strictEqual(options.sandbox, 'read-only');
      assert.strictEqual(options.model, r.route.model);
      assert.strictEqual(options.effort, r.route.effort);
      assert(options.prompt.includes('auto_commit'));
      return { finalText: JSON.stringify(p) };
    };
    assert.strictEqual((await unit.runUnitSidecar(r)).status, 'done');
    for (const a of p.artifacts) assert.strictEqual(fs.readFileSync(path.join(cwd, a.path), 'utf8'), a.content);
    // Simulate an interrupted publication (receipt durable, a target not yet written).
    fs.unlinkSync(path.join(cwd, p.artifacts[0].path));
    // Only a originally-absent target can be replayed from absence.
    const receipt = JSON.parse(fs.readFileSync(r.resultFile + '.receipt.json'));
    if (receipt.artifacts[0].before !== null) write(path.join(cwd, p.artifacts[0].path), type === 'discuss-milestone' ? '# Decisions\n' : '# Roadmap\n\n- [ ] **S01: Work**\n');
    await unit.runUnitSidecar(r);
    if (engine === 'claude') {
      assert.strictEqual(fs.readFileSync(path.join(cwd, 'invocations.txt'), 'utf8'), 'spawn\n');
      const args = JSON.parse(fs.readFileSync(path.join(cwd, 'argv.json')));
      assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.strictEqual(args[args.indexOf('--effort') + 1], r.route.effort);
      assert(!JSON.stringify(args).includes(token));
    } else assert.strictEqual(codexCalls, 1);
    const events = fs.readFileSync(path.join(cwd, '.gsd/forge/events.jsonl'), 'utf8');
    assert(events.includes('"event":"dispatch"'));
    assert(!events.includes('worker-engine-fallback'));
    write(path.join(cwd, p.artifacts[0].path), 'another writer');
    await rejects(() => unit.runUnitSidecar(r), 'artifact-conflict');
  }
  // Memory uses the existing read-only transports but has a specialized owner
  // publisher. Inference may finish early; the ready receipt defers canonical
  // writes until the owner confirms the protected-snapshot boundary is clear.
  for (const engine of ['claude', 'codex']) for (const identity of [
    { sourceUnitId: 'T01', milestoneId: 'M001' },
    { sourceUnitId: 'T-20260924010101-loose-memory' },
  ]) {
    const dir = setup(), req = memoryRequest(dir, engine, identity.sourceUnitId, identity.milestoneId);
    const extraction = memoryPayload(`${engine}/${identity.sourceUnitId} is published only by the owner.`);
    write(path.join(dir, 'payload.json'), extraction);
    let codexCalls = 0;
    xllm.invokeCodexAppServer = async options => {
      codexCalls++;
      assert.strictEqual(options.sandbox, 'read-only');
      assert.strictEqual(options.model, req.route.model);
      assert.strictEqual(options.effort, req.route.effort);
      assert(!options.prompt.includes('publishExtraction('));
      return { finalText: JSON.stringify(extraction) };
    };
    const deferred = await unit.runUnitSidecar(req);
    assert.strictEqual(deferred.publication.status, 'deferred');
    const memoryEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    for (const eventName of ['sidecar-unit', 'dispatch']) {
      assert(memoryEvents.some(event => event.event === eventName
        && event.unit === `memory-extract/${identity.sourceUnitId}`));
    }
    assert(!memoryEvents.some(event => event.event === 'memory-publication'));
    const memoryDir = path.join(dir, '.gsd', 'memory');
    assert.strictEqual(fs.existsSync(memoryDir), false);
    req.publicationSafe = true;
    // A boolean alone cannot bypass the owner boundary check.
    const stillDeferred = await unit.runUnitSidecar(req);
    assert.strictEqual(stillDeferred.publication.status, 'deferred');
    req.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:01:00Z',
      protectedSnapshots: [{ id: 'fixture-worker', state: 'ended' }] };
    const written = await unit.runUnitSidecar(req);
    assert.strictEqual(written.publication.status, 'written');
    assert.strictEqual(fs.existsSync(memoryDir), true);
    const publicationEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === req.dispatchId);
    assert.strictEqual(publicationEvents.length, 1);
    assert.strictEqual(publicationEvents[0].publication_status, 'written');
    assert.strictEqual(publicationEvents[0].model_requested, req.route.model_requested);
    assert.strictEqual(publicationEvents[0].model_resolved, req.route.model_resolved);
    assert.strictEqual(publicationEvents[0].model_observed, null);
    const replay = await unit.runUnitSidecar(req);
    assert.strictEqual(replay.publication.status, 'noop');
    assert.strictEqual(replay.publication.reason, 'replay');
    const replayedEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === req.dispatchId);
    assert.strictEqual(replayedEvents.length, 1);
    if (engine === 'codex') assert.strictEqual(codexCalls, 1);
    else assert.strictEqual(fs.readFileSync(path.join(dir, 'invocations.txt'), 'utf8'), 'spawn\n');
    const receipt = fs.readFileSync(`${req.resultFile}.receipt.json`, 'utf8');
    assert(!receipt.includes(token));
    assert(!receipt.includes('contextRoot'));
    await rejects(() => unit.runUnitSidecar({ ...req, summaryContent: 'unrelated request' }), 'dispatch-identity-conflict');
  }

  // Terminal memory shapes remain truthful: empty and partial publish nothing,
  // while malformed output and authentication failure never reach the store.
  {
    const dir = setup(), emptyReq = memoryRequest(dir, 'codex', 'T-20260924030303-empty-memory');
    const empty = { schema_version: 1, status: 'done', summary: 'No durable fact', questions: [], facts: [], events: [] };
    xllm.invokeCodexAppServer = async () => ({ finalText: JSON.stringify(empty) });
    emptyReq.publicationSafe = true;
    emptyReq.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:03:00Z', protectedSnapshots: [] };
    const emptyResult = await unit.runUnitSidecar(emptyReq);
    assert.strictEqual(emptyResult.publication.status, 'noop');
    assert.strictEqual(emptyResult.publication.reason, 'empty-extraction');
    assert.strictEqual(fs.existsSync(path.join(dir, '.gsd', 'memory')), false);
    let terminalEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(event => event.event === 'memory-publication');
    assert(terminalEvents.some(event => event.dispatch_id === emptyReq.dispatchId
      && event.status === 'done' && event.publication_status === 'noop'
      && event.publication_reason === 'empty-extraction'));

    const partialReq = memoryRequest(dir, 'codex', 'T-20260924030304-partial-memory');
    const partialMemory = { schema_version: 1, status: 'partial', summary: 'Need context',
      questions: ['Which invariant is durable?'], facts: [], events: [] };
    xllm.invokeCodexAppServer = async () => ({ finalText: JSON.stringify(partialMemory) });
    partialReq.publicationSafe = true;
    partialReq.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:04:00Z', protectedSnapshots: [] };
    const partialResult = await unit.runUnitSidecar(partialReq);
    assert.strictEqual(partialResult.status, 'partial');
    assert.strictEqual(partialResult.publication.status, 'noop');
    terminalEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(event => event.event === 'memory-publication');
    assert(terminalEvents.some(event => event.dispatch_id === partialReq.dispatchId
      && event.status === 'partial' && event.publication_reason === 'worker-partial'));

    const blockedReq = memoryRequest(dir, 'codex', 'T-20260924030304-blocked-memory');
    const blockedMemory = { schema_version: 1, status: 'blocked', summary: 'Required input is unavailable',
      questions: ['Which source is authoritative?'], facts: [], events: [] };
    xllm.invokeCodexAppServer = async () => ({ finalText: JSON.stringify(blockedMemory) });
    blockedReq.publicationSafe = true;
    blockedReq.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:04:10Z', protectedSnapshots: [] };
    const blockedResult = await unit.runUnitSidecar(blockedReq);
    assert.strictEqual(blockedResult.status, 'blocked');
    terminalEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(event => event.event === 'memory-publication');
    assert(terminalEvents.some(event => event.dispatch_id === blockedReq.dispatchId
      && event.status === 'blocked' && event.publication_reason === 'worker-blocked'));

    const invalidReq = memoryRequest(dir, 'codex', 'T-20260924030305-invalid-memory');
    xllm.invokeCodexAppServer = async () => ({ finalText: JSON.stringify({ ...empty, path: '.gsd/STATE.md' }) });
    await rejects(() => unit.runUnitSidecar(invalidReq), 'MEMORY_EXTRACTION_INVALID');
    const invalidReceipt = fs.readFileSync(`${invalidReq.resultFile}.receipt.json`, 'utf8');
    assert(!invalidReceipt.includes('.gsd/STATE.md'));

    const authDir = setup(), authReq = memoryRequest(authDir, 'claude', 'T-20260924030306-auth-memory');
    write(path.join(authDir, 'payload.json'), { failure: 'auth' });
    await rejects(() => unit.runUnitSidecar(authReq), 'claude-auth-failed');
    assert(!fs.readFileSync(authReq.resultFile, 'utf8').includes(token));
    assert.strictEqual(fs.existsSync(path.join(authDir, '.gsd', 'memory')), false);
  }

  // The real dispatch policy is consulted before either provider transport.
  {
    const dir = setup(), req = memoryRequest(dir, 'codex', 'T-20260924030307-policy-memory');
    req.publicationSafe = true;
    req.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:04:30Z', protectedSnapshots: [] };
    let providerCalls = 0, policyCalls = 0;
    xllm.invokeCodexAppServer = async () => { providerCalls++; return { finalText: JSON.stringify(memoryPayload()) }; };
    xllm.authorizeSidecar = (mode, options) => {
      policyCalls++;
      assert.strictEqual(mode, 'memory');
      return originalAuthorize(mode, { ...options, workspaceRoot: path.join(options.cwd, 'outside-spawn-root') });
    };
    await rejects(() => unit.runUnitSidecar(req), 'target-outside-workspace');
    assert.strictEqual(policyCalls, 1);
    assert.strictEqual(providerCalls, 0);
    xllm.authorizeSidecar = originalAuthorize;
  }

  // Publication outcomes remain visible even though extraction itself completed.
  {
    const dir = setup(), req = memoryRequest(dir, 'codex', 'T-20260924030308-conflict-memory');
    const conflictPayload = { schema_version: 1, status: 'done', summary: 'Conflicting reference', questions: [],
      facts: [], events: [{ kind: 'hit', existing_id: 'MEM999' }] };
    xllm.invokeCodexAppServer = async () => ({ finalText: JSON.stringify(conflictPayload) });
    req.publicationSafe = true;
    req.publicationBoundary = { ownerJoined: true, checkedAt: '2026-09-24T12:04:45Z', protectedSnapshots: [] };
    const result = await unit.runUnitSidecar(req);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.publication.status, 'conflict');
    const published = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .find(event => event.event === 'memory-publication' && event.dispatch_id === req.dispatchId);
    assert.strictEqual(published.publication_status, 'conflict');
    assert.strictEqual(published.publication_reason, 'memory-publication-conflict');
    assert(!published.publication_reason.includes('MEM999'));
    assert.strictEqual(published.model_observed, null);
    assert(!JSON.stringify(published).includes(token));
    memory.writeFragment(dir, { unit_id: req.sourceUnitId, facts: [{ mem_id: 'MEM999', category: 'gotcha',
      text: 'An externally restored canonical target.', confidence_base: 0.9,
      created_at: '2026-09-24T12:04:46Z', source_unit: `execute-task/${req.sourceUnitId}` }], stats: [] });
    const recovered = await unit.runUnitSidecar(req);
    assert.strictEqual(recovered.publication.status, 'written');
    let transitions = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === req.dispatchId);
    assert.deepStrictEqual(transitions.map(event => event.publication_status), ['conflict', 'written']);
    const replay = await unit.runUnitSidecar(req);
    assert.strictEqual(replay.publication.status, 'noop');
    transitions = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === req.dispatchId);
    assert.strictEqual(transitions.length, 2);
  }

  // Native memory consumes the same envelope and durable owner acceptance path.
  // A policy skip returns before the injected provider callback is reached.
  {
    const dir = setup();
    write(path.join(dir, '.gsd/forge-prefs.jsonc'), {
      tier_models: { light: 'gpt-6-luna', standard: 'gpt-6-luna', heavy: 'gpt-6-luna', max: 'gpt-6-luna' },
      effort: { 'memory-extract': 'medium' },
    });
    const route = resolveDispatch({ cwd: dir, unitType: 'memory-extract', hostRuntime: 'codex',
      workerEngine: 'native', workerMode: 'native' });
    const base = { cwd: dir, contextRoot: dir, sourceUnitId: 'T-20260924020202-native-memory',
      sourceUnitType: 'execute-task', workflowId: 'native-memory-workflow', dispatchId: 'native-memory-dispatch',
      extractionId: 'native-memory-extraction', sourceFingerprint: 'native-source-sha256', route,
      hostRuntime: 'codex', activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture',
        models: ['gpt-6-luna'], reasoning_efforts: ['medium'], fork_turns: ['none'] },
      resultFile: path.join(root, 'native-memory-result.json'), publicationSafe: true,
      publicationBoundary: { ownerJoined: true, checkedAt: '2026-09-24T12:02:00Z', protectedSnapshots: [] } };
    let calls = 0;
    const skipped = await unit.runNativeMemory({ ...base, policy: { decision: 'skip', reason: 'fixture-skip' } }, async () => { calls++; });
    assert.strictEqual(skipped.status, 'skipped');
    assert.strictEqual(skipped.provider_called, false);
    assert.strictEqual(calls, 0);
    const taskNames = [];
    const delivered = await unit.runNativeMemory({ ...base, policy: { decision: 'extract' } }, async args => {
      calls++;
      assert.strictEqual(args.model, 'gpt-6-luna');
      assert.strictEqual(args.reasoning_effort, 'medium');
      assert.strictEqual(args.fork_turns, 'none');
      assert.match(args.task_name, /^[a-z0-9_]+$/);
      taskNames.push(args.task_name);
      return memoryPayload('Native and sidecar results share the owner publication path.');
    });
    assert.strictEqual(delivered.status, 'done');
    assert.strictEqual(delivered.publication.status, 'written');
    assert.strictEqual(delivered.telemetry.model_observed, null);
    assert.strictEqual(calls, 1);
    let nativePublicationEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === base.dispatchId);
    assert.strictEqual(nativePublicationEvents.length, 1);
    assert.strictEqual(nativePublicationEvents[0].publication_status, 'written');
    assert.strictEqual(nativePublicationEvents[0].model_requested, 'gpt-6-luna');
    assert.strictEqual(nativePublicationEvents[0].model_resolved, 'gpt-6-luna');
    assert.strictEqual(nativePublicationEvents[0].model_argument, 'gpt-6-luna');
    assert.strictEqual(nativePublicationEvents[0].model_observed, null);
    const nativeReplay = await unit.runNativeMemory({ ...base, policy: { decision: 'extract' } }, async () => {
      calls++;
      throw new Error('provider must not run on ready replay');
    });
    assert.strictEqual(nativeReplay.publication.status, 'noop');
    assert.strictEqual(nativeReplay.provider_called, false);
    assert.strictEqual(nativeReplay.telemetry.model_resolved, 'gpt-6-luna');
    assert.strictEqual(nativeReplay.telemetry.model_argument, 'gpt-6-luna');
    assert.strictEqual(nativeReplay.telemetry.model_observed, null);
    assert.strictEqual(calls, 1);
    nativePublicationEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'memory-publication' && event.dispatch_id === base.dispatchId);
    assert.strictEqual(nativePublicationEvents.length, 1);
    await assert.rejects(() => unit.runNativeMemory({ ...base, dispatchId: 'lying-native',
      resultFile: path.join(root, 'lying-native-memory.json'), model: 'gpt-5.6-sol',
      policy: { decision: 'extract' } }, async () => { calls++; }), error => error.code === 'native-memory-route-mismatch');
    assert.strictEqual(calls, 1);
    const secondDispatch = { ...base, dispatchId: 'native-memory-dispatch-2',
      extractionId: 'native-memory-extraction-2', resultFile: path.join(root, 'native-memory-result-2.json'),
      policy: { decision: 'extract' } };
    const secondDelivered = await unit.runNativeMemory(secondDispatch, async args => {
      calls++;
      assert.match(args.task_name, /^[a-z0-9_]+$/);
      taskNames.push(args.task_name);
      return memoryPayload('A second dispatch keeps a distinct native task identity.');
    });
    assert.strictEqual(secondDelivered.status, 'done');
    assert.strictEqual(secondDelivered.publication.status, 'written');
    assert.notStrictEqual(taskNames[0], taskNames[1]);
    assert.strictEqual(calls, 2);
    const secondReplay = await unit.runNativeMemory(secondDispatch, async () => {
      calls++;
      throw new Error('provider must not run on second ready replay');
    });
    assert.strictEqual(secondReplay.publication.status, 'noop');
    assert.strictEqual(secondReplay.provider_called, false);
    assert.strictEqual(calls, 2);
    for (const [suffix, rawResult, expectedStatus, expectedReason] of [
      ['empty', { schema_version: 1, status: 'done', summary: 'Nothing durable', questions: [], facts: [], events: [] },
        'done', 'empty-extraction'],
      ['partial', { schema_version: 1, status: 'partial', summary: 'Need context',
        questions: ['Which source is authoritative?'], facts: [], events: [] }, 'partial', 'worker-partial'],
      ['blocked', { schema_version: 1, status: 'blocked', summary: 'Input unavailable',
        questions: ['Provide the missing source?'], facts: [], events: [] }, 'blocked', 'worker-blocked'],
    ]) {
      const dispatchId = `native-${suffix}`;
      const terminal = await unit.acceptNativeMemoryResult({ ...base, dispatchId, extractionId: dispatchId,
        resultFile: path.join(root, `${dispatchId}.json`), rawResult,
        invocationTelemetry: delivered.telemetry });
      assert.strictEqual(terminal.status, expectedStatus);
      const events = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert(events.some(event => event.event === 'memory-publication' && event.dispatch_id === dispatchId
        && event.status === expectedStatus && event.publication_status === 'noop'
        && event.publication_reason === expectedReason));
    }
    const unsupported = await unit.runNativeMemory({ ...base, dispatchId: 'unsupported-native',
      resultFile: path.join(root, 'unsupported-native-memory.json'),
      activeCapabilities: { ...base.activeCapabilities, models: ['gpt-5.6-sol'] },
      policy: { decision: 'extract' } }, async () => { calls++; });
    assert.strictEqual(unsupported.reason_code, 'native-model-unsupported');
    assert.strictEqual(unsupported.provider_called, false);
    let nativeTerminalEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(event => event.event === 'memory-publication');
    assert(nativeTerminalEvents.some(event => event.dispatch_id === 'unsupported-native'
      && event.status === 'failure' && event.publication_status === 'noop'
      && event.publication_reason === 'worker-error'));
    const failedDispatch = { ...base, dispatchId: 'failed-native', extractionId: 'failed-native',
      resultFile: path.join(root, 'failed-native-memory.json'), policy: { decision: 'extract' } };
    const failedNative = await unit.runNativeMemory(failedDispatch, async () => {
      calls++;
      throw new Error('fixture provider failure');
    });
    assert.strictEqual(failedNative.reason_code, 'native-invocation-failed');
    assert.strictEqual(failedNative.provider_called, true);
    nativeTerminalEvents = fs.readFileSync(path.join(dir, '.gsd/forge/events.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(event => event.event === 'memory-publication');
    assert(nativeTerminalEvents.some(event => event.dispatch_id === failedDispatch.dispatchId
      && event.status === 'failure' && event.publication_reason === 'worker-error'));
    await assert.rejects(() => unit.runNativeMemory({ ...base, dispatchId: 'inside-target',
      resultFile: path.join(dir, 'inside-result.json'), policy: { decision: 'extract' } },
    async () => { calls++; }), /outside the workspace/);
    assert.strictEqual(calls, 3);
    const interrupted = { ...base, dispatchId: 'interrupted-native',
      extractionId: 'interrupted-native', resultFile: path.join(root, 'interrupted-native-memory.json'),
      policy: { decision: 'extract' } };
    write(`${interrupted.resultFile}.receipt.json`, { phase: 'started',
      fingerprint: unit.nativeMemoryFingerprint(interrupted), dispatch_id: interrupted.dispatchId });
    const interruptedResult = await unit.runNativeMemory(interrupted, async () => { calls++; });
    assert.strictEqual(interruptedResult.reason_code, 'native-memory-attempt-interrupted');
    assert.strictEqual(interruptedResult.provider_called, false);
    assert.strictEqual(calls, 3);
  }
  {
    const dir = setup();
    write(path.join(dir, '.gsd/forge-prefs.jsonc'), {
      tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' },
      effort: { 'memory-extract': 'medium' },
    });
    const route = resolveDispatch({ cwd: dir, unitType: 'memory-extract', hostRuntime: 'claude',
      workerEngine: 'native', workerMode: 'native' });
    const agentPath = path.join(dir, 'forge-memory-fixture.md');
    write(agentPath, '---\nname: forge-memory\neffort: medium\n---\n\nRead-only fixture.\n');
    const agentFingerprint = crypto.createHash('sha256').update(fs.readFileSync(agentPath, 'utf8')).digest('hex');
    let calls = 0;
    const delivered = await unit.runNativeMemory({ cwd: dir, contextRoot: dir, route,
      hostRuntime: 'claude', sourceUnitId: 'T-20260924040404-claude-native', sourceUnitType: 'execute-task',
      workflowId: 'claude-native-workflow', dispatchId: 'claude-native-dispatch',
      extractionId: 'claude-native-extraction', sourceFingerprint: 'claude-native-source',
      activeCapabilities: { available: true, tool: 'Agent', source: 'fixture-active-tool',
        model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] },
      effortBinding: { transport: 'agent-frontmatter', agentPath,
        sourceFingerprint: `sha256:${agentFingerprint}` },
      resultFile: path.join(root, 'claude-native-memory-result.json'), policy: { decision: 'extract' },
      publicationSafe: true, publicationBoundary: { ownerJoined: true,
        checkedAt: '2026-09-24T12:05:00Z', protectedSnapshots: [] } }, async args => {
      calls++;
      assert.strictEqual(args.model, 'sonnet');
      assert.strictEqual(args.subagent_type, 'forge-memory');
      assert(!args.prompt.includes('reasoning_effort:'));
      return memoryPayload('Claude native effort is bound in the rendered prompt contract.');
    });
    assert.strictEqual(delivered.status, 'done');
    assert.strictEqual(delivered.publication.status, 'written');
    assert.strictEqual(delivered.telemetry.model_resolved, 'claude-sonnet-5');
    assert.strictEqual(delivered.telemetry.model_argument, 'sonnet');
    assert.strictEqual(delivered.telemetry.model_observed, null);
    assert.strictEqual(delivered.telemetry.effort_argument, null);
    assert.strictEqual(delivered.telemetry.effort_transport, 'agent-frontmatter');
    assert.strictEqual(delivered.telemetry.effort_transport_value, 'medium');
    assert.strictEqual(delivered.telemetry.effort_binding_observed, 'medium');
    assert.strictEqual(calls, 1);
  }
  // Delivery publication uses exact, unit-scoped paths for every closing unit.
  // Exercise the real validator and durable materializer without a provider.
  for (const type of ['execute-task', 'complete-slice', 'complete-milestone']) {
    const dir = setup(), req = request(dir, type), loc = unit.locations(req), value = payload(req, true);
    assert(loc.required.includes(loc.delivery.input));
    assert(loc.required.includes(loc.delivery.output));
    assert(loc.allowed.includes(loc.delivery.verification));
    assert(loc.allowed.includes(loc.delivery.artifact));
    assert.deepStrictEqual(Object.keys(loc.rules).sort(), Object.values(loc.delivery).sort());
    assert.strictEqual(unit.inspectArtifacts(value, loc.allowed, loc.required, Infinity, loc.rules).ok, true);
    const record = { result: value, artifacts: value.artifacts.map(artifact => ({ ...artifact, before: null })) };
    assert.strictEqual(unit.materialize(req, record).status, 'done');
    for (const artifact of value.artifacts) assert.strictEqual(fs.readFileSync(path.join(dir, artifact.path), 'utf8'), artifact.content);

    const foreign = JSON.parse(JSON.stringify(value));
    foreign.artifacts.find(artifact => artifact.path === loc.delivery.output).path = loc.delivery.output.replace(/(T01|S01|M001)-DELIVERY\.json$/, 'FOREIGN-DELIVERY.json');
    assert.strictEqual(unit.inspectArtifacts(foreign, loc.allowed, loc.required, Infinity, loc.rules).reason, 'artifact-path-invalid');
    const traversal = JSON.parse(JSON.stringify(value)); traversal.artifacts[0].path = '.gsd/../escape.json';
    assert.strictEqual(unit.inspectArtifacts(traversal, loc.allowed, loc.required, Infinity, loc.rules).reason, 'artifact-path-invalid');
    const malformed = JSON.parse(JSON.stringify(value));
    malformed.artifacts.find(artifact => artifact.path === loc.delivery.input).content = '{bad';
    assert.strictEqual(unit.inspectArtifacts(malformed, loc.allowed, loc.required, Infinity, loc.rules).reason, 'delivery-artifact-invalid');
  }
  const cwd = setup(), r = request(cwd, 'research-milestone');
  write(path.join(cwd, 'payload.json'), { status: 'partial', summary: 'Need input', artifacts: [], questions: ['Required decision?'] });
  const partial = await unit.runUnitSidecar(r);
  assert.strictEqual(partial.status, 'partial');
  assert(!fs.existsSync(path.join(cwd, unit.locations(r).required[0])));
  assert(!unit.validateArtifacts({ ...payload(r), questions: ['Unanswered'] }, unit.locations(r).allowed, unit.locations(r).required));
  assert(!unit.validateArtifacts({ ...payload(r), artifacts: [{ path: '.gsd/STATE.md', content: 'poison' }] }, unit.locations(r).allowed, []));
  assert.throws(() => unit.target(cwd, '.gsd/../escape.md'));
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, '.gsd/link'), 'junction');
  assert.throws(() => unit.target(cwd, '.gsd/link/STATE.md'), e => e.code === 'artifact-link-refused');

  for (const [failure, code] of [['auth', 'claude-auth-failed'], ['invalid', 'claude-invalid-result'], ['process', 'claude-exit-nonzero']]) {
    const dir = setup(), req = request(dir, 'research-milestone');
    write(path.join(dir, 'payload.json'), { failure });
    await rejects(() => unit.runUnitSidecar(req), code);
    const output = fs.readFileSync(req.resultFile, 'utf8');
    assert(!output.includes(token));
    await rejects(() => unit.runUnitSidecar(req), code);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'invocations.txt'), 'utf8'), 'spawn\n');
  }
  const waitDir = setup(); write(path.join(waitDir, 'payload.json'), { failure: 'wait' });
  const abort = new AbortController();
  const waiting = claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 10000,
    signal: abort.signal, terminateChild: xllm.terminateOwnedProcessTree });
  setTimeout(() => abort.abort(), 150);
  await rejects(() => waiting, 'claude-cancelled');
  await rejects(() => claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 5100,
    terminateChild: xllm.terminateOwnedProcessTree }), 'claude-timeout');
  await rejects(() => claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 10000,
    sourceEnv: { ...process.env, FORGE_XLLM_CLAUDE_BIN: path.join(root, 'missing.exe') } }), 'claude-command-not-found');
  const concurrentDir = setup(), concurrentRequest = request(concurrentDir, 'research-milestone');
  const concurrentAbort = new AbortController(); concurrentRequest.signal = concurrentAbort.signal;
  write(path.join(concurrentDir, 'payload.json'), { failure: 'wait' });
  const active = unit.runUnitSidecar(concurrentRequest);
  await rejects(() => unit.runUnitSidecar(concurrentRequest), 'sidecar-attempt-interrupted');
  concurrentAbort.abort(); await rejects(() => active, 'claude-cancelled');

  const hangingServer = path.join(root, 'hanging-appserver.js');
  write(hangingServer, 'setInterval(() => {}, 1000);');
  const codexAbort = new AbortController();
  const codexPending = require('./forge-appserver-client').startAppServerTurn({
    cmd: process.execPath, args: [hangingServer], cwd: waitDir, timeoutMs: 10000,
    signal: codexAbort.signal,
  });
  setTimeout(() => codexAbort.abort(), 100);
  await assert.rejects(() => codexPending, /cancelled/);

  // Plan/execute use their production xllm paths, not the artifact schema.
  const planDir = setup();
  function git(args) {
    const result = spawnSync('git', args, { cwd: planDir, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-q']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const startSha = git(['rev-parse', 'HEAD']);
  const planRequest = request(planDir, 'plan-slice');
  const planContent = '---\ncapability: readonly\nmust_haves:\n  truths:\n    - "fixture execution stays observable"\n  artifacts: []\n  key_links: []\nexpected_output: []\n---\n# Task\n\n## Standards\nFixture.\n';
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Plan fixture',
    slice_plan: { filename: 'S01-PLAN.md', content: '# Slice\n\n- [ ] T01: Fixture\n' },
    task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: planContent }] });
  await unit.runUnitSidecar(planRequest);
  const planFile = path.join(planDir, '.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md');
  assert.strictEqual(fs.readFileSync(planFile, 'utf8'), planContent);
  const badPlan = { ...planRequest, dispatchId: 'bad-plan', resultFile: path.join(root, 'bad-plan.json') };
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Invalid plan',
    slice_plan: { filename: 'S01-PLAN.md', content: '# Slice' },
    task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: '# No must haves' }] });
  await assert.rejects(() => unit.runUnitSidecar(badPlan), /must_haves/);
  const executeRequest = request(planDir, 'execute-task'); executeRequest.planFile = planFile;
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Execution fixture', must_haves_status: [], files_changed: [] });
  await unit.runUnitSidecar(executeRequest);
  const executeLocations = unit.locations(executeRequest);
  for (const required of executeLocations.required) assert.strictEqual(fs.existsSync(path.join(planDir, required)), true, required);
  const deliveryInput = JSON.parse(fs.readFileSync(path.join(planDir, executeLocations.delivery.input), 'utf8'));
  const deliveryOutput = JSON.parse(fs.readFileSync(path.join(planDir, executeLocations.delivery.output), 'utf8'));
  const executeSummary = fs.readFileSync(path.join(planDir, executeLocations.required[0]), 'utf8');
  assert.deepStrictEqual(deliveryInput.unit, { type: 'task', id: 'T01', milestone: 'M001', slice: 'S01' });
  assert.deepStrictEqual(deliveryInput.bindings, []);
  assert.strictEqual(deliveryOutput.generated_by, 'forge-delivery');
  assert(deliveryOutput.criteria.length > 0);
  assert(deliveryOutput.criteria.every(criterion => criterion.status !== 'verificado'));
  assert(executeSummary.includes('## Entrega por critério'));
  assert(executeSummary.includes(`./${path.posix.basename(executeLocations.delivery.output)}`));
  assert.strictEqual(git(['rev-parse', 'HEAD']), startSha);
  assert(fs.readFileSync(path.join(planDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md'), 'utf8').includes('[x] T01'));
  const reviewOptions = { cwd: planDir, engine: 'claude', hostRuntime: 'codex', sidecarDeclared: true, timeoutSecs: 20, model: 'claude-sonnet-5' };
  // Nonempty diff is needed to exercise transport, not the empty-diff shortcut.
  write(path.join(planDir, 'tracked.txt'), 'before'); git(['add', 'tracked.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline']);
  write(path.join(planDir, 'tracked.txt'), 'after');
  write(path.join(planDir, 'payload.json'), { status: 'done', output: { objections: [] } });
  await xllm.runChallenge({ ...reviewOptions, diffCmd: 'git diff' });
  const inputFile = path.join(planDir, 'review.md'); write(inputFile, 'R1: fixture objection');
  for (const review of [xllm.runDefend, xllm.runRebuttal]) {
    write(path.join(planDir, 'payload.json'), { status: 'done', output: { verdicts: [] } });
    await review({ ...reviewOptions, inputFile });
  }

  // Actual controller/lease lifecycle: Codex selects research, delegates to a
  // mock Claude CLI, acknowledges completion, then selects plan-slice.
  const flowDir = setup(), flow = request(flowDir, 'research-milestone');
  fs.unlinkSync(path.join(flowDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md'));
  state.write(flowDir, { milestone: 'M001', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'off' });
  const input = { cwd: flowDir, milestone: 'M001', workflow_id: flow.workflowId, owner_token: 'fixture-owner',
    prefsReader: () => ({ ok: true, prefs: {} }) };
  const selected = loop.invoke('codex', 'auto', 'next', input).result;
  assert.strictEqual(selected.unit.type, 'research-milestone');
  write(path.join(flowDir, 'payload.json'), payload(flow));
  const delivered = await unit.runUnitSidecar(flow);
  const completion = loop.invoke('codex', 'auto', 'complete', { ...input, result: delivered }, selected.snapshot).result;
  assert.strictEqual(completion.action, 'continue', JSON.stringify(completion));
  const replay = loop.invoke('codex', 'auto', 'complete', { ...input, result: delivered }, selected.snapshot).result;
  assert.strictEqual(replay.action, 'continue', JSON.stringify(replay));
  const next = loop.invoke('codex', 'auto', 'next', input, completion.snapshot).result;
  assert.strictEqual(next.unit.type, 'plan-slice', JSON.stringify(next));
  assert.strictEqual(next.snapshot.workflow_id, flow.workflowId);
  assert.strictEqual(next.host_runtime, 'codex');
  console.log('Bidirectional contracts, artifact replay/conflicts, failure classification and Codex forge-auto progression passed (fixture providers only).');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  accounts.resolveLaunch = originalLookup; xllm.invokeCodexAppServer = originalCodex; xllm.authorizeSidecar = originalAuthorize;
  if (originalEnv === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = originalEnv;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
