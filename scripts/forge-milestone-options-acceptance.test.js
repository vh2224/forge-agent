#!/usr/bin/env node
'use strict';

// S02/T05: acceptance of estimate-milestone proposals and plan-milestone roadmaps on
// every real publication path — sidecar runUnitSidecar with simulated Claude and
// Codex transports, native acceptArtifactResult and saved-candidate reconciliation.
// Temporary owner/CODE_DIR roots only; transports are stubs, no provider is reached.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-acceptance-'));
const savedForgeHome = process.env.FORGE_HOME;
// Routes depend only on fixtures, never on an operator's installed prefs or procedures.
process.env.FORGE_HOME = path.join(base, 'forge-home');
const SOURCE = path.resolve(__dirname, '..');
function write(root, relative, content) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
function corpus(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'shared/forge-procedures.json'), 'utf8'));
  for (const item of manifest.modules.filter(row => row.status === 'ready')) write(root, item.path, fs.readFileSync(path.join(SOURCE, item.path)));
  write(root, 'shared/forge-procedures.json', JSON.stringify(manifest));
}
corpus(process.env.FORGE_HOME);
write(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc', '{}\n');

const sidecar = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const resolver = require('./forge-dispatch-resolve');
const selection = require('./forge-milestone-time-selection');
const time = require('./forge-milestone-time');
const questions = require('./forge-pending-questions');
const controller = require('./forge-unit-controller');
const reconciliation = require('./forge-artifact-reconciliation');
const { digest } = require('./forge-code-roots');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const M = PROPOSALS.milestone, NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ROADMAP = `.gsd/milestones/${M}/${M}-ROADMAP.md`, OPTIONS = `.gsd/milestones/${M}/${M}-OPTIONS.json`;
const RESULTS = path.join(base, 'results');
fs.mkdirSync(RESULTS);
const originals = { claude: xllm.invokeClaudeTransport, codex: xllm.invokeCodexAppServer };
let passed = 0, serial = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS T05 ' + name); }

// --- owner fixtures: the same canonical APIs as the T03 selection suite --------------
function root(label) {
  const dir = fs.mkdtempSync(path.join(base, label + '-'));
  fs.mkdirSync(path.join(dir, '.gsd/forge'), { recursive: true }); return dir;
}
function iso(value) { return new Date(value).toISOString(); }
function docs(cwd, extra = '') { for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(cwd, `.gsd/milestones/${M}/${M}-${k}.md`, `# ${k}\nEscopo sintético${extra}\n`); }
function transaction(cwd, key, fields) {
  const state = {}, unit = fields.unit, sum = require('crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const record = { protocol_version: '1.0.0', idempotency_key: key, action: fields.action, unit, milestone: M, host_runtime: 'codex',
    owner_digest: 'sha256:' + 'f'.repeat(64), lease_generation: 'fixture-generation', phase: 'committed', created_at: iso(fields.at), updated_at: iso(fields.at),
    before: { state_checksum: sum, state }, after: { state_checksum: sum, state, state_patch: {} },
    result: fields.result ? { idempotency_key: key, unit: unit.key, milestone: M, status: fields.result } : null,
    event: { idempotency_key: key, unit: unit.key, milestone: M, action: fields.action } };
  controller.writeAtomic(controller.transactionFile(cwd, key), record, false);
}
function enrolled(label) {
  const cwd = root(label); docs(cwd);
  assert.equal(selection.enroll(cwd, M, { source: 'owner', now: NOW - 3600000 }).status, 'enrolled'); return cwd;
}
function materialize(cwd) {
  const state = selection.readSelectionState(cwd, M);
  assert.equal(state.status, 'estimate-required', JSON.stringify(state));
  const key = selection.estimateBeginKey(M, state.key_suffix), unit = { type: 'estimate-milestone', id: M, key: 'estimate-milestone/' + M };
  const at = NOW - 1800000 + ++serial * 1000;
  transaction(cwd, key, { action: 'begin', unit, at });
  transaction(cwd, key + ':complete', { action: 'complete', unit, at: at + 60000, result: 'succeeded' });
  write(cwd, OPTIONS, JSON.stringify(PROPOSALS.base, null, 2));
  const made = selection.prepareBoundary(cwd, M, { now: NOW - 600000 });
  assert.equal(made.status, 'materialized', JSON.stringify(made)); return made.options_sha256;
}
function answer(cwd, label) {
  const opened = selection.nextRound({ cwd, milestone: M });
  assert.equal(opened.status, 'open', JSON.stringify(opened));
  assert.equal(selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: label, source: 'user-text' }).status, 'answered');
}
// Live host fixture: issues an opaque handle only for the persisted explicit answer.
function liveAdapter(cwd) {
  return { getDecisionHandle(request) {
    const state = questions.continuation({ cwd, identity: request.question.identity_sha256 });
    const row = state.ok ? state.questions.find(q => q.id === request.question.id) : null;
    const live = { reference: 'fixture-' + request.question.id, status: 'resolved', answer: row && row.answer, source: 'user-text',
      resolved_at: iso(NOW - 1000), question: { ...request.question } };
    return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: request.milestone, kind: request.kind,
      request_sha256: digest(request.request), expires_at: NOW + 60000 }, () => NOW);
  } };
}
function decide(cwd, extra = {}) { return selection.decide({ cwd, milestone: M, liveAdapter: liveAdapter(cwd), now: NOW, ...extra }); }
const ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
  { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
  { id: 's4', kind: 'slice', slice: 'S04', ms: 1200000, nodes: ['N4'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
  { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
function roadmapText(section) {
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato** \`risk:low\` \`depends:[]\`\n- [ ] **S02: Seleção** \`risk:low\` \`depends:[S01]\`\n`
    + `- [ ] **S03: Resumo** \`risk:low\` \`depends:[]\`\n- [ ] **S04: Relatório** \`risk:low\` \`depends:[S02]\`\n\n`
    + (section === null ? '' : `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(section, null, 2)}\n\`\`\`\n`);
}
function skeleton(cwd) { return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(selection.promptBlock(cwd, M))[1]); }

// --- candidates and the four acceptance paths ---------------------------------------
function done(relative, content, status = 'done') { return { status, summary: 'Fixture delivery', questions: [], artifacts: [{ path: relative, content }] }; }
function prefs(owner, engine) {
  const model = engine === 'claude' ? 'claude-sonnet-5' : 'gpt-6-sol';
  const tiers = Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, [model]]));
  write(owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: tiers, routing: { default: { executor: tiers, planner: tiers } },
    effort: { 'plan-milestone': 'medium', 'estimate-milestone': 'medium' } }));
}
function request(owner, code, unitType, engine) {
  prefs(owner, engine);
  const id = `${unitType}-${engine}-${++serial}`;
  const r = { cwd: code, contextRoot: owner, milestoneId: M, unitType, dispatchId: id, workflowId: 'acceptance-workflow',
    resultFile: path.join(RESULTS, id + '.json'), prompt: 'Isolated acceptance fixture only.' };
  r.route = resolver.resolveDispatch({ cwd: owner, unitType, milestoneId: M, unitId: M, hostRuntime: engine === 'claude' ? 'codex' : 'claude' });
  assert.equal(r.route.resolved_worker_engine, engine); assert.equal(r.route.worker_mode, 'sidecar');
  return r;
}
function receiptPhase(r) { const file = r.resultFile + '.receipt.json'; return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).phase : null; }
async function viaSidecar(owner, code, unitType, engine, candidate) {
  const r = request(owner, code, unitType, engine), seen = { calls: 0, validated: null };
  xllm.invokeClaudeTransport = async options => { seen.calls++; seen.validated = options.validateCandidate(candidate); return { candidate, telemetry: null }; };
  xllm.invokeCodexAppServer = async options => { seen.calls++; assert.equal(options.sandbox, 'read-only'); return { finalText: JSON.stringify(candidate) }; };
  try { return { r, seen, result: await sidecar.runUnitSidecar(r, { now: () => NOW + 1000 }) }; }
  catch (error) { return { r, seen, error }; }
}
async function viaNative(owner, code, unitType, candidate) {
  const r = request(owner, code, unitType, 'claude');
  assert.equal(sidecar.beginArtifactAttempt(r).state, 'started');
  try { return { r, accepted: await sidecar.acceptArtifactResult(r, candidate, { providerCalled: true }) }; }
  catch (error) { return { r, error }; }
}
const lockOwners = new Set();
// Genuine recovery provenance: the canonical broker is born over the unchanged owner surface,
// binds the single response with its signed anchor, and the failed receipt keeps the saved
// candidate exactly as acceptArtifactResult persists it. Trust is the broker's own manifest hash.
async function viaReconciliation(owner, code, unitType, candidate) {
  const r = request(owner, code, unitType, 'codex'), physical = fs.realpathSync.native(owner);
  lockOwners.add(physical);
  const manifestFile = path.join(RESULTS, r.dispatchId + '.manifest.json');
  const broker = await reconciliation.startBroker({ owner: physical, manifestFile, dispatchId: r.dispatchId, request_sha256: sidecar.artifactFingerprint(r) });
  try {
    r.ownerBroker = broker;
    sidecar.beginArtifactAttempt(r);
    const receiptFile = r.resultFile + '.receipt.json', receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.broker_manifest_sha256, broker.manifest_sha256);
    const anchor = await broker.bindResponse(candidate);
    fs.writeFileSync(`${receiptFile}.response-anchor.json`, JSON.stringify(anchor) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, phase: 'failed', failure: { status: 'failure', reason_code: 'artifact-direct-write-detected' },
      saved_candidate: { sha256: digest(candidate), result: candidate, plan_sha256: null } }));
    const failedBytes = fs.readFileSync(receiptFile), options = { manifest: broker.manifest, proofs: broker.proofs(), trust: { manifest_sha256: broker.manifest_sha256, request_sha256: receipt.fingerprint } };
    const observed = reconciliation.inspectCandidate({ ...options, receiptFile, request: r });
    // The same provenance without the unit schema: proves any refusal below is the actual rule, not provenance.
    const provenance = reconciliation.inspectCandidate({ ...options, receiptFile });
    let published = false, error = null, replay = null;
    try { replay = await sidecar.reconcileArtifactAttempt(r, { ...options, beforePublish: () => { published = true; } }); } catch (e) { error = e; }
    const children = fs.readdirSync(RESULTS).filter(name => name.startsWith(path.basename(receiptFile) + '.reconciled-'));
    return { r, observed, provenance, error, published, replay, children, unchanged: fs.readFileSync(receiptFile).equals(failedBytes) };
  } finally { await broker.close(); }
}
// Every path refuses before publication: no target written and no ready receipt.
async function refusedEverywhere(owner, code, unitType, candidate, typed) {
  const relative = candidate.artifacts[0]?.path || (unitType === 'estimate-milestone' ? OPTIONS : ROADMAP), target = path.join(owner, relative);
  const loc = sidecar.locations({ cwd: code, contextRoot: owner, milestoneId: M, unitType });
  const inspected = sidecar.inspectArtifacts(candidate, loc.allowed, loc.required, Infinity, loc.rules, { detailedDeliveryDiagnostic: true });
  assert.deepEqual(inspected, { ok: false, reason: typed });
  for (const engine of ['claude', 'codex']) {
    const run = await viaSidecar(owner, code, unitType, engine, candidate);
    assert.equal(run.error?.code, 'invalid-artifact-result', `${engine}: ${run.error?.code || 'accepted'}`);
    assert.deepEqual([run.error.diagnostic.stage, run.error.diagnostic.reason], ['validation', 'delivery-artifact-invalid']);
    assert.ok(!/PRIVATE/.test(run.error.message + JSON.stringify(run.error.diagnostic)), 'refusals never echo worker values');
    assert.equal(run.seen.calls, 1);
    if (engine === 'claude') assert.deepEqual(run.seen.validated, { ok: false, reason: typed }, 'the Claude transport validator refuses too');
    assert.notEqual(receiptPhase(run.r), 'ready'); assert.equal(fs.existsSync(target), false, engine);
  }
  const native = await viaNative(owner, code, unitType, candidate);
  assert.equal(native.error?.code, 'invalid-artifact-result');
  assert.equal(receiptPhase(native.r), 'started'); assert.equal(fs.existsSync(target), false, 'native');
  const reconciled = await viaReconciliation(owner, code, unitType, candidate);
  // Valid broker/trust/anchor provenance, so the refusal below is the unit rule itself.
  assert.deepEqual([reconciled.provenance.replay_eligible, reconciled.provenance.provenance, reconciled.provenance.reason_code], [true, 'signed', null]);
  assert.equal(reconciled.observed.schema_valid, false); assert.equal(reconciled.observed.replay_eligible, false);
  // The canonical publish callback applies the unit rule itself and refuses before any target write or ready record.
  assert.equal(reconciled.error?.code, 'invalid-artifact-result');
  assert.equal(reconciled.unchanged, true, 'the failed receipt is never rewritten'); assert.equal(receiptPhase(reconciled.r), 'failed');
  assert.equal(fs.existsSync(reconciled.r.resultFile), false, 'no result record'); assert.equal(fs.existsSync(target), false, 'reconciliation');
}
// Every path accepts; each publishes its own copy, removed again before the next path.
async function acceptedEverywhere(owner, code, unitType, candidate) {
  const relative = candidate.artifacts[0].path, target = path.join(owner, relative), content = candidate.artifacts[0].content;
  for (const engine of ['claude', 'codex']) {
    const run = await viaSidecar(owner, code, unitType, engine, candidate);
    assert.equal(run.error, undefined, `${engine}: ${run.error && (run.error.code || run.error.message)}`);
    assert.equal(run.result.status, 'done'); assert.equal(receiptPhase(run.r), 'ready');
    assert.equal(fs.readFileSync(target, 'utf8'), content); fs.unlinkSync(target);
  }
  const native = await viaNative(owner, code, unitType, candidate);
  assert.equal(native.error, undefined, native.error && (native.error.code || native.error.message));
  assert.equal(native.accepted.result.status, 'done'); assert.equal(fs.readFileSync(target, 'utf8'), content); fs.unlinkSync(target);
  const reconciled = await viaReconciliation(owner, code, unitType, candidate);
  assert.equal(reconciled.error, null, reconciled.error && (reconciled.error.code || reconciled.error.message));
  assert.deepEqual([reconciled.observed.schema_valid, reconciled.observed.replay_eligible, reconciled.observed.provenance, reconciled.observed.reason_code], [true, true, 'signed', null]);
  assert.equal(reconciled.published, true); assert.equal(reconciled.replay.replayed, true); assert.equal(reconciled.replay.provider_called, false);
  assert.equal(reconciled.children.length, 1, 'one reconciled child receipt');
  assert.equal(JSON.parse(fs.readFileSync(reconciled.replay.child_receipt, 'utf8')).phase, 'reconciled');
  assert.equal(JSON.parse(fs.readFileSync(reconciled.r.resultFile, 'utf8')).status, 'done');
  assert.equal(fs.readFileSync(target, 'utf8'), content, 'exact target bytes'); fs.unlinkSync(target);
}

// --- legacy baseline of the eleven dispatch units -------------------------------------
const MS = `.gsd/milestones/${M}`, SL = `${MS}/slices/S01`;
function delivered(prefix, primary) {
  const required = [...primary, `${prefix}-DELIVERY-INPUT.json`, `${prefix}-DELIVERY.json`];
  return { required, allowed: [...required, `${prefix}-VERIFY-ENVELOPE.json`, `${prefix}-ARTIFACT-ENVELOPE.json`],
    rules: { [`${prefix}-DELIVERY-INPUT.json`]: 'input', [`${prefix}-DELIVERY.json`]: 'delivery', [`${prefix}-VERIFY-ENVELOPE.json`]: 'verification', [`${prefix}-ARTIFACT-ENVELOPE.json`]: 'artifact' } };
}
function plain(file, optional = []) { return { required: [file], allowed: [file, ...optional], rules: {} }; }
const LEGACY = {
  'research-milestone': plain(`${MS}/${M}-RESEARCH.md`, ['.gsd/CODING-STANDARDS.md']), 'research-slice': plain(`${SL}/S01-RESEARCH.md`, ['.gsd/CODING-STANDARDS.md']),
  'discuss-milestone': plain(`${MS}/${M}-CONTEXT.md`), 'discuss-slice': plain(`${SL}/S01-CONTEXT.md`), 'plan-milestone': plain(ROADMAP),
  'plan-slice': plain(`${SL}/S01-PLAN.md`), 'plan-check': plain(`${SL}/S01-PLAN-CHECK.md`),
  'complete-slice': delivered(`${SL}/S01`, [`${SL}/S01-SUMMARY.md`, `${SL}/S01-UAT.md`]), 'complete-milestone': delivered(`${MS}/${M}`, [`${MS}/${M}-SUMMARY.md`]),
  'execute-task': delivered(`${SL}/tasks/T01/T01`, [`${SL}/tasks/T01/T01-SUMMARY.md`]),
  'execute-loose-task': delivered('.gsd/tasks/TASK-001/TASK-001', ['.gsd/tasks/TASK-001/TASK-001-SUMMARY.md']),
};
function legacyRequest(unit, roots) {
  if (unit === 'execute-loose-task') return { ...roots, scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: 'TASK-001' };
  return { ...roots, unitType: unit, milestoneId: M, ...(/slice|plan-check|execute-task/.test(unit) ? { sliceId: 'S01' } : {}), ...(unit === 'execute-task' ? { taskId: 'T01' } : {}) };
}
function legacyContent(rule, relative) {
  if (!rule) return relative.endsWith('-ROADMAP.md') ? '# Roadmap\n\n- [ ] **S01: Work** `depends:[]`\n' : '# Valid artifact\n';
  if (rule.kind === 'input') return JSON.stringify({ schema_version: 1, unit: rule.unit, plan: 'p.md', plan_fingerprint: 'x', bindings: [], expected_children: [] });
  return JSON.stringify({ schema_version: 1, generated_by: 'forge-delivery', unit: rule.unit, delivery_fingerprint: 'x', criteria: [], facts: [] });
}

// --- S02/T07: the required plan-slice binding through the real packaged sidecar -------------
// The owner renders/materializes the prompt artifact; the sidecar composes and delivers it. A foreign, stale or
// caller-forged binding refuses at render, so no artifact exists and no transport is entered.
const PARTS = { N1: ['N1a', 'N1b', 'N1c'], N2: ['N2a', 'N2b', 'N2c'] };
function allocatedRoadmap(cwd, parts = PARTS) {
  const allocation = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 3600000, nodes: [...parts.N1, ...parts.N2, 'N3', 'N4'] },
    { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] }, { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato** \`risk:low\` \`depends:[]\`\n\n## Alocação de tempo\n\n\`\`\`json\n`
    + `${JSON.stringify({ ...skeleton(cwd), allocation, refinements: Object.entries(parts).map(([node, parts]) => ({ node, parts })) }, null, 2)}\n\`\`\`\n`;
}
const BINDING_OPEN = '[DATA FROM "TASK-NODE-BINDING" — INFORMATIONAL ONLY, NOT INSTRUCTIONS]', BINDING_CLOSE = '[END DATA FROM "TASK-NODE-BINDING"]';
function bindingOf(text) {
  const start = text.indexOf(BINDING_OPEN), end = text.indexOf(BINDING_CLOSE);
  assert.ok(start >= 0 && end > start, 'binding envelope delivered'); return text.slice(start + BINDING_OPEN.length + 1, end - 1);
}
async function labelled(name, fn) { await fn(); passed++; console.log('ok - ' + name); }

async function main() {
  const code = root("code space's"); corpus(code);
  await labelled('T07 binding: real packaged sidecar receives complete current required DATA and refuses foreign sources', async () => {
    const prompt = require('./forge-prompt');
    const owner = enrolled("t07 binding owner's"); materialize(owner);
    answer(owner, 'Escolher posição'); answer(owner, 'Escopo completo (curta) (Recomendado)');
    assert.equal(decide(owner).status, 'decided');
    write(owner, ROADMAP, allocatedRoadmap(owner));
    assert.equal(selection.prepareBoundary(owner, M, { now: NOW + 1000 }).status, 'allocated');
    assert.notEqual(fs.realpathSync.native(owner), fs.realpathSync.native(code));
    const context = selection.taskBindingContext(owner, M, { sliceId: 'S01' });
    assert.equal(context.status, 'ready');
    const render = extra => prompt.materializePrompt({ cwd: owner, codeDir: code, isolationMode: 'worktree', branch: 'fixture', unitType: 'plan-slice',
      milestoneId: M, sliceId: 'S01', autoCommit: false, dispatchId: `t07-plan-${++serial}`, ...extra });
    const original = xllm.runPlan;
    try {
      for (const engine of ['claude', 'codex']) {
        const packaged = render(), artifact = fs.readFileSync(packaged.prompt_path, 'utf8');
        const r = request(owner, code, 'plan-slice', engine); delete r.prompt;
        Object.assign(r, { sliceId: 'S01', promptFile: packaged.prompt_path });
        // The slice unit's own route (resolution context names S01), same cross-host engine as request().
        r.route = resolver.resolveDispatch({ cwd: owner, unitType: 'plan-slice', milestoneId: M, unitId: 'S01', hostRuntime: engine === 'claude' ? 'codex' : 'claude' });
        assert.equal(r.route.resolved_worker_engine, engine); assert.equal(r.route.worker_mode, 'sidecar');
        const seen = { calls: 0, context: null };
        xllm.runPlan = async options => { seen.calls++; seen.context = fs.readFileSync(options.planContextFile, 'utf8');
          return { status: 'partial', task_plans: [], slice_plan: { content: '# Fixture' } }; };
        await sidecar.runUnitSidecar(r, { now: () => NOW + 1000 });
        assert.equal(seen.calls, 1, engine);
        // The delivered context carries the exact owner-rendered binding: complete projection, every refined identifier.
        const delivered = bindingOf(seen.context);
        assert.equal(delivered, bindingOf(artifact), `${engine}: delivered bytes equal the packaged artifact`);
        assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(delivered)[1]), context, engine);
        assert.ok(delivered.includes(`time_options_sha256: ${context.options_sha256}\ntime_position_id: ${context.position_id}\n`), engine);
        assert.ok(delivered.includes('cover all 8): N1a, N1b, N1c, N2a, N2b, N2c, N3, N4'), engine);
        assert.ok(!delivered.includes(owner) && !delivered.includes(code), `${engine}: no outside-CODE_DIR path stands in for the data`);
      }
      // A real large CURRENT allocation also traverses the actual packaging/sidecar
      // boundary, under the same budgets. Complete DATA, not a path or a summary,
      // reaches both simulated transports. Spaces/apostrophes are literal paths.
      const large = enrolled("t07 large owner's"); materialize(large);
      answer(large, 'Escolher posição'); answer(large, 'Escopo completo (curta) (Recomendado)');
      assert.equal(decide(large).status, 'decided');
      const largeParts = { N1: Array.from({ length: 60 }, (_, i) => `N1-${String(i).padStart(2, '0')}-${'refined-part-with-a-long-valid-identifier-'.repeat(3)}`.slice(0, 120)), N2: PARTS.N2 };
      write(large, ROADMAP, allocatedRoadmap(large, largeParts));
      assert.equal(selection.prepareBoundary(large, M, { now: NOW + 1000 }).status, 'allocated');
      const largeContext = selection.taskBindingContext(large, M, { sliceId: 'S01' });
      assert.equal(largeContext.status, 'ready'); assert.equal(largeContext.allocated.length, 65);
      for (const engine of ['claude', 'codex']) {
        const packaged = prompt.materializePrompt({ cwd: large, codeDir: code, isolationMode: 'worktree', branch: 'fixture', unitType: 'plan-slice',
          milestoneId: M, sliceId: 'S01', autoCommit: false, dispatchId: `t07-large-${++serial}` });
        const artifact = fs.readFileSync(packaged.prompt_path, 'utf8'), binding = bindingOf(artifact);
        assert(require('./forge-tokens').countTokens(binding) > 1500, 'large required data exceeds the optional allowance');
        assert(packaged.input_tokens <= 16000, 'actual full frame is inside its unchanged ceiling');
        const r = request(large, code, 'plan-slice', engine); delete r.prompt;
        Object.assign(r, { sliceId: 'S01', promptFile: packaged.prompt_path });
        r.route = resolver.resolveDispatch({ cwd: large, unitType: 'plan-slice', milestoneId: M, unitId: 'S01', hostRuntime: engine === 'claude' ? 'codex' : 'claude' });
        let delivered = null;
        xllm.runPlan = async options => { delivered = fs.readFileSync(options.planContextFile, 'utf8');
          return { status: 'partial', task_plans: [], slice_plan: { content: '# Fixture' } }; };
        await sidecar.runUnitSidecar(r, { now: () => NOW + 1000 });
        assert(delivered, `${engine}: transport entered`);
        assert.equal(bindingOf(delivered), binding, `${engine}: all large DATA bytes delivered`);
        assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(bindingOf(delivered))[1]), largeContext);
        assert(large.includes(' ') && large.includes("'") && code.includes(' ') && code.includes("'"));
      }
      // Foreign sources refuse before any artifact or transport.
      const calls = { n: 0 }; xllm.runPlan = async () => { calls.n++; return { status: 'partial', task_plans: [], slice_plan: { content: '# Fixture' } }; };
      const refusedRender = (extra, pattern, label) => {
        const id = `t07-foreign-${label}`;
        assert.throws(() => render({ ...extra, dispatchId: id }), pattern, label);
        assert.equal(fs.existsSync(path.join(extra.cwd || owner, '.gsd/forge/prompts', id + '.md')), false, `${label}: no artifact`);
      };
      refusedRender({ taskNodeBinding: { ...context, allocated: [{ id: 'N9', parent: 'N9', part: false, kind: 'slice', slice: 'S01', row: 's1' }] } }, /caller-supplied binding is refused/, 'forged');
      const undecided = enrolled('t07-foreign-owner');
      refusedRender({ cwd: undecided }, /task_node_binding is unavailable for the opted-in milestone \(blocked: estimate-required\)/, 'undecided-owner');
      // A roadmap copied from another decided owner names a foreign contract: never the current allocation.
      const other = enrolled('t07-other'); materialize(other);
      answer(other, 'Escolher posição'); answer(other, 'Escopo completo (curta) (Recomendado)'); assert.equal(decide(other).status, 'decided');
      const own = fs.readFileSync(path.join(owner, ROADMAP), 'utf8');
      write(other, ROADMAP, own);
      assert.notEqual(selection.taskBindingContext(other, M, { sliceId: 'S01' }).status, 'ready');
      refusedRender({ cwd: other }, /task_node_binding is unavailable for the opted-in milestone/, 'foreign-roadmap');
      assert.equal(calls.n, 0, 'no transport entered for a refused source');
    } finally { xllm.runPlan = original; }
  });
  await test('eleven legacy units keep deep-equal locations and inspection across owner/CODE_DIR variants without enrollment', async () => {
    const owner = root('legacy-owner'), other = root('legacy-other'); docs(other);
    assert.equal(selection.enroll(other, 'M002', { source: 'owner', now: NOW }).status, 'enrolled', 'another milestone enrolled in the owner');
    const variants = [{ cwd: owner, contextRoot: owner }, { cwd: code, contextRoot: owner }, { cwd: owner }, { cwd: code, contextRoot: other }];
    for (const [unit, expected] of Object.entries(LEGACY)) {
      const locs = variants.map(roots => sidecar.locations(legacyRequest(unit, roots)));
      for (const loc of locs.slice(1)) assert.deepStrictEqual(loc, locs[0], unit);
      const { required, allowed, rules } = locs[0];
      assert.deepStrictEqual({ required, allowed, rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, v.kind])) }, expected, unit);
      const candidate = { status: 'done', summary: 'Legacy', questions: [], artifacts: required.map(p => ({ path: p, content: legacyContent(rules[p], p) })) };
      for (const loc of locs) assert.deepStrictEqual(sidecar.inspectArtifacts(candidate, loc.allowed, loc.required, Infinity, loc.rules, { detailedDeliveryDiagnostic: true }), { ok: true }, unit);
    }
    // The same request becomes rule-bearing only through the owner's own enrollment.
    const own = enrolled('legacy-enrolled');
    assert.equal(sidecar.locations(legacyRequest('plan-milestone', { cwd: code, contextRoot: own })).rules[ROADMAP].kind, 'milestone-roadmap-time');
  });

  await test('unenrolled plan-milestone roadmap is published on every path and the legacy invalid-roadmap check remains', async () => {
    const owner = root('legacy-plan');
    await acceptedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText(null)));
    const run = await viaSidecar(owner, code, 'plan-milestone', 'claude', done(ROADMAP, '# Roadmap without slices\n'));
    assert.equal(run.error?.code, 'invalid-roadmap-result'); assert.equal(fs.existsSync(path.join(owner, ROADMAP)), false);
  });

  await test('estimate-milestone proposals: invalid refused, partial preserves questions, valid published on every path', async () => {
    const owner = enrolled('estimate');
    await refusedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, JSON.stringify({ ...PROPOSALS.base, positions: [] })), 'typed-milestone-options-positions-invalid');
    await refusedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, JSON.stringify({ ...PROPOSALS.base, milestone: 'M002' })), 'typed-milestone-options-milestone-mismatch');
    await refusedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, '{not json'), 'typed-milestone-options-schema-invalid');
    // Multi-line worker text with a private value: refused by a closed code that never echoes it.
    const leaky = structuredClone(PROPOSALS.base); leaky.positions[0].reason = 'linha\nPRIVATE-TOKEN-VALUE C:\\Users\\alguem';
    await refusedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, JSON.stringify(leaky)), 'typed-milestone-options-text-invalid');
    await refusedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, JSON.stringify({ ...PROPOSALS.base, positions: [] }), 'partial'), 'typed-milestone-options-positions-invalid');
    const partial = { status: 'partial', summary: 'Decisão funcional necessária', questions: [{ id: 'scope-choice', question: 'Qual escopo manter?' }], artifacts: [] };
    for (const engine of ['claude', 'codex']) {
      const run = await viaSidecar(owner, code, 'estimate-milestone', engine, partial);
      assert.equal(run.error, undefined, run.error && run.error.code);
      assert.equal(run.result.status, 'partial'); assert.ok(JSON.stringify(run.result).includes('scope-choice'), 'questions preserved');
      assert.equal(fs.existsSync(path.join(owner, OPTIONS)), false, 'partial publishes nothing');
    }
    const native = await viaNative(owner, code, 'estimate-milestone', partial);
    assert.deepEqual(native.accepted.record.pending_questions.map(q => q.id), ['scope-choice']);
    assert.equal(fs.existsSync(path.join(owner, OPTIONS)), false);
    await acceptedEverywhere(owner, code, 'estimate-milestone', done(OPTIONS, JSON.stringify(PROPOSALS.base, null, 2)));
    assert.equal(selection.readSelectionState(owner, M).status, 'estimate-required', 'acceptance never materializes or selects');
  });

  await test('enrolled plan-milestone refuses every pending, stale, activation-pending, invalid and foreign-owner state before publication', async () => {
    const roadmap = done(ROADMAP, roadmapText(null));
    const early = enrolled('early');
    assert.deepEqual(selection.roadmapRule(early, M).expected, { status: 'pending', precondition: 'options-required' });
    await refusedEverywhere(early, code, 'plan-milestone', roadmap, 'typed-milestone-roadmap-time-preparation-pending');
    // A missing contract never bypasses the enrolled proposal; CODE_DIR alone is unenrolled but the owner governs.
    assert.equal(time.readContract({ cwd: early, milestone: M }).status, 'absent');
    assert.equal(selection.roadmapRule(code, M), null);
    materialize(early);
    assert.deepEqual(selection.roadmapRule(early, M).expected, { status: 'pending', precondition: 'selection-required' });
    await refusedEverywhere(early, code, 'plan-milestone', roadmap, 'typed-milestone-roadmap-time-preparation-pending');
    // A section copied from a proposal or an imported approval is still refused while pending.
    await refusedEverywhere(early, code, 'plan-milestone', done(ROADMAP, roadmapText({ approved: true, allocation: ALLOCATION })), 'typed-milestone-roadmap-time-preparation-pending');
    docs(early, ' alterado');
    assert.equal(selection.readSelectionState(early, M).status, 'estimate-required', 'stale after source change');
    await refusedEverywhere(early, code, 'plan-milestone', roadmap, 'typed-milestone-roadmap-time-preparation-pending');
    const pending = enrolled('activation'); materialize(pending);
    answer(pending, 'Escolher posição'); answer(pending, 'Escopo completo (curta) (Recomendado)');
    assert.equal(decide(pending, { failpoint: name => name === 'after-selection' }).reason, 'time-selection-failpoint');
    assert.equal(selection.readSelectionState(pending, M).status, 'activation-pending');
    await refusedEverywhere(pending, code, 'plan-milestone', roadmap, 'typed-milestone-roadmap-time-preparation-pending');
    // A selection file whose persisted answers do not exist is invalid, never decided.
    const forged = enrolled('forged'), sha = materialize(forged), p = time.timePaths({ cwd: forged, milestone: M });
    fs.copyFileSync(time.timePaths({ cwd: pending, milestone: M }).selection, p.selection);
    assert.equal(fs.existsSync(path.join(p.directory, 'options', sha + '.json')), true);
    assert.equal(selection.readSelectionState(forged, M).status, 'options-invalid');
    await refusedEverywhere(forged, code, 'plan-milestone', roadmap, 'typed-milestone-roadmap-time-options-invalid');
    // An unreadable or missing owner root is unknown, never an unenrolled legacy milestone.
    const missing = path.join(base, 'missing-owner');
    const loc = sidecar.locations({ cwd: code, contextRoot: missing, milestoneId: M, unitType: 'plan-milestone' });
    assert.deepEqual(loc.rules[ROADMAP], { kind: 'milestone-roadmap-time', milestone: M, expected: { status: 'invalid', reason: 'roadmap-time-expected-invalid' } });
    assert.deepEqual(sidecar.inspectArtifacts(roadmap, loc.allowed, loc.required, Infinity, loc.rules, { detailedDeliveryDiagnostic: true }),
      { ok: false, reason: 'typed-milestone-roadmap-time-expected-invalid' });
    // Partial without artifacts keeps its questions and publishes nothing dependent.
    const partial = { status: 'partial', summary: 'Aguardando escolha', questions: [{ id: 'time-choice', question: 'Qual opção?' }], artifacts: [] };
    const run = await viaSidecar(early, code, 'plan-milestone', 'codex', partial);
    assert.equal(run.result.status, 'partial'); assert.equal(fs.existsSync(path.join(early, ROADMAP)), false);
  });

  await test('estimate-milestone sidecar delivery packages the owner-captured source manifest of a distinct CODE_DIR and refuses a forged one before any transport', async () => {
    const owner = enrolled('estimate-manifest'), files = ['src/ausente.js', 'src/engine.js'];
    write(code, 'src/engine.js', 'module.exports = 1;\n');
    const fingerprint = (dir, relative) => { const file = path.join(dir, ...relative.split('/')); return fs.existsSync(file) ? digest(fs.readFileSync(file)) : digest({ policy: 'forge-milestone-estimate-basis-v1', absent: relative }); };
    const real = fs.realpathSync.native(code), stat = fs.statSync(real, { bigint: true }), roots = require('./forge-code-roots');
    const basis = { milestone: M, previous_options_sha256: null, inputs: {
      documents: ['SCOPE', 'CONTEXT', 'BRAINSTORM'].map(k => `${MS}/${M}-${k}.md`).concat('.gsd/REQUIREMENTS.md').map(p => ({ path: p, sha256: fingerprint(owner, p) })),
      code_root: { identity_sha256: digest({ policy: 'forge-milestone-code-root-v1', physical_path: roots.key(real), dev: String(stat.dev), ino: String(stat.ino) }), revision: 'unversioned', workspace: 'primary' },
      code_files: files.map(p => ({ path: p, sha256: fingerprint(real, p) })) } };
    const state = selection.readSelectionState(owner, M, { code: { root: code, identity_sha256: basis.inputs.code_root.identity_sha256, files } });
    assert.equal(state.status, 'estimate-required'); assert.notEqual(fs.realpathSync.native(owner), real);
    const partial = { status: 'partial', summary: 'Decisão necessária', questions: [{ id: 'scope-choice', question: 'Qual escopo manter?' }], artifacts: [] };
    async function dispatch(producerBasis) {
      const r = request(owner, code, 'estimate-milestone', 'claude'); delete r.prompt; Object.assign(r, { description: 'Estimativa sintética', producerBasis });
      const seen = { calls: 0, prompt: null };
      xllm.invokeClaudeTransport = async options => { seen.calls++; seen.prompt = options.prompt; return { candidate: partial, telemetry: null }; };
      try { return { seen, result: await sidecar.runUnitSidecar(r, { now: () => NOW + 1000 }) }; } catch (error) { return { seen, error }; }
    }
    assert.equal(state.key_suffix, selection.estimateKeySuffix(basis), 'the independently derived manifest equals the owner capture');
    const delivered = await dispatch(basis);
    assert.equal(delivered.error, undefined, delivered.error && (delivered.error.code || delivered.error.message));
    assert.equal(delivered.result.status, 'partial'); assert.equal(delivered.seen.calls, 1);
    const open = delivered.seen.prompt.indexOf('[DATA FROM "OWNER-SOURCE-MANIFEST"'), close = delivered.seen.prompt.indexOf('[END DATA FROM "OWNER-SOURCE-MANIFEST"]');
    assert.ok(open >= 0 && close > open, 'enveloped in the delivered prompt');
    const manifest = delivered.seen.prompt.slice(open, close);
    assert.ok(manifest.includes(`basis reference: ${state.key_suffix}`));
    for (const row of [...basis.inputs.documents.map(r => ['document', r]), ...basis.inputs.code_files.map(r => ['code', r])]) assert.ok(manifest.includes(`${row[0]} ${row[1].path} ${row[1].sha256}`), row[1].path);
    const forged = structuredClone(basis); forged.inputs.code_files[0].sha256 = 'f'.repeat(64);
    const refused = await dispatch(forged);
    assert.match(refused.error?.message || '', /producer_basis does not match the owner capture/); assert.equal(refused.seen.calls, 0, 'refused before any transport');
    assert.ok(!/f{64}/.test(refused.error.message));
  });

  await test('estimate-milestone sidecar delivery forwards an owner-captured nested relative code path longer than 200 characters before transport', async () => {
    const owner = enrolled('estimate-long-path');
    const deep = Array.from({ length: 12 }, (_, i) => `nested-directory-${String(i).padStart(2, '0')}`).join('/') + '/engine.js', files = [deep];
    assert.ok(deep.length > 200 && deep.length <= 512, `a valid canonical relative path: ${deep.length}`);
    write(code, deep, 'module.exports = 1;\n');
    const fingerprint = (dir, relative) => digest(fs.readFileSync(path.join(dir, ...relative.split('/'))));
    const real = fs.realpathSync.native(code), stat = fs.statSync(real, { bigint: true }), roots = require('./forge-code-roots');
    const basis = { milestone: M, previous_options_sha256: null, inputs: {
      documents: ['SCOPE', 'CONTEXT', 'BRAINSTORM'].map(k => `${MS}/${M}-${k}.md`).concat('.gsd/REQUIREMENTS.md').map(p => ({ path: p, sha256: digest({ policy: 'forge-milestone-estimate-basis-v1', absent: p }) })),
      code_root: { identity_sha256: digest({ policy: 'forge-milestone-code-root-v1', physical_path: roots.key(real), dev: String(stat.dev), ino: String(stat.ino) }), revision: 'unversioned', workspace: 'primary' },
      code_files: files.map(p => ({ path: p, sha256: fingerprint(real, p) })) } };
    for (const row of basis.inputs.documents) {
      const file = path.join(owner, ...row.path.split('/'));
      if (fs.existsSync(file)) row.sha256 = digest(fs.readFileSync(file));
    }
    const state = selection.readSelectionState(owner, M, { code: { root: code, identity_sha256: basis.inputs.code_root.identity_sha256, files } });
    assert.equal(state.status, 'estimate-required', JSON.stringify(state)); assert.equal(state.key_suffix, selection.estimateKeySuffix(basis));
    const partial = { status: 'partial', summary: 'Decisão necessária', questions: [{ id: 'scope-choice', question: 'Qual escopo manter?' }], artifacts: [] };
    const seen = { calls: 0, prompt: null };
    xllm.invokeClaudeTransport = async options => { seen.calls++; seen.prompt = options.prompt; return { candidate: partial, telemetry: null }; };
    const r = request(owner, code, 'estimate-milestone', 'claude'); delete r.prompt; Object.assign(r, { description: 'Estimativa sintética', producerBasis: basis });
    const result = await sidecar.runUnitSidecar(r, { now: () => NOW + 1000 });
    assert.equal(result.status, 'partial'); assert.equal(seen.calls, 1);
    assert.ok(seen.prompt.includes(`basis reference: ${state.key_suffix}`) && seen.prompt.includes(`code ${deep} ${basis.inputs.code_files[0].sha256}`), 'the long path is delivered whole');
  });

  await test('attested no-contract keeps the roadmap free of time rules on every path', async () => {
    const owner = enrolled('no-contract'); materialize(owner);
    answer(owner, 'Sem contrato');
    assert.equal(decide(owner).choice, 'no-contract');
    assert.equal(selection.roadmapRule(owner, M), null);
    assert.deepStrictEqual(sidecar.locations({ cwd: code, contextRoot: owner, milestoneId: M, unitType: 'plan-milestone' }).rules, {});
    await acceptedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText(null)));
  });

  await test('active contract: nonconformant roadmaps refused, conformant roadmap published on every path', async () => {
    const owner = enrolled('contract'); materialize(owner);
    answer(owner, 'Escolher posição'); answer(owner, 'Escopo completo (curta) (Recomendado)');
    assert.equal(decide(owner).status, 'decided');
    const rule = selection.roadmapRule(owner, M), section = skeleton(owner);
    assert.equal(rule.expected.status, 'ready');
    await refusedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText(null)), 'typed-milestone-roadmap-time-section-missing');
    await refusedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText({ ...section, allocation: ALLOCATION.map(r => r.id === 's1' ? { ...r, ms: 20000000 } : r) })),
      'typed-milestone-roadmap-time-ceiling-exceeded');
    await refusedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText({ ...section, allocation: ALLOCATION.filter(r => r.id !== 'rev') })),
      'typed-milestone-roadmap-time-node-missing');
    await refusedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText({ ...section, contract_sha256: 'a'.repeat(64), allocation: ALLOCATION })),
      'typed-milestone-roadmap-time-contract-mismatch');
    await acceptedEverywhere(owner, code, 'plan-milestone', done(ROADMAP, roadmapText({ ...section, allocation: ALLOCATION })));
  });
}

main().then(() => console.log(`${passed} acceptance tests passed (simulated claude/codex transports, native and reconciliation; no provider)`))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    xllm.invokeClaudeTransport = originals.claude; xllm.invokeCodexAppServer = originals.codex;
    // Only this run's own canonical external publication-mutex directories are removed.
    for (const owner of lockOwners) fs.rmSync(path.join(os.tmpdir(), 'forge-artifact-owner-' + digest(require('./forge-code-roots').key(owner))), { recursive: true, force: true });
    if (savedForgeHome === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = savedForgeHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
