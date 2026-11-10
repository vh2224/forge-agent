#!/usr/bin/env node
'use strict';

// S02/T06: the time-options flow through the public bridge
// forge-long-workflow-adapter.invoke with host claude and host codex. Temporary
// owner roots with synthetic history only; transports are never reached (the
// native acceptance path publishes the worker candidate), no provider is called
// and no real state (including this milestone's) is touched.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-flow-'));
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

const adapter = require('./forge-long-workflow-adapter');
const controller = require('./forge-unit-controller');
const orchestrate = require('./forge-orchestrate');
const selection = require('./forge-milestone-time-selection');
const time = require('./forge-milestone-time');
const questions = require('./forge-pending-questions');
const sidecar = require('./forge-unit-sidecar');
const resolver = require('./forge-dispatch-resolve');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const { renderPrompt } = require('./forge-prompt');
const { digest } = require('./forge-code-roots');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const HISTORIES = require('./fixtures/milestone-options/history-cases.json');
const M = PROPOSALS.milestone, NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ROADMAP = `.gsd/milestones/${M}/${M}-ROADMAP.md`, OPTIONS = `.gsd/milestones/${M}/${M}-OPTIONS.json`;
const RESULTS = path.join(base, 'results');
fs.mkdirSync(RESULTS);
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
let passed = 0, serial = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS T06 ' + name); }
function iso(value) { return new Date(value).toISOString(); }

// --- owner fixtures ------------------------------------------------------------------
function root(label) {
  const dir = fs.mkdtempSync(path.join(base, label + '-'));
  fs.mkdirSync(path.join(dir, '.gsd/forge'), { recursive: true }); return dir;
}
function docs(cwd, extra = '') { for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(cwd, `.gsd/milestones/${M}/${M}-${k}.md`, `# ${k}\nEscopo sintético${extra}\n`); }
// Synthetic closed history (the T02 "suficiente" case): ledger fragments plus controller events.
function history(cwd, name = 'suficiente') {
  const spec = HISTORIES.cases.find(row => row.name === name).input;
  for (const m of spec.ledger) write(cwd, `.gsd/ledger/${m}.md`, `## ${m}\nFechamento sintético\n`);
  let start = Date.parse('2026-10-01T08:00:00.000Z');
  for (const [m, specs] of Object.entries(spec.events)) {
    if (m === M) continue; // never synthesize events for the milestone under test
    const rows = []; let t = start, k = 0;
    for (const row of specs) for (const duration of row.durations_ms) {
      const unit = `${row.phase}/U${++serial}`;
      rows.push({ event: 'unit-began', action: 'begin', unit, milestone: m, host_runtime: 'codex', ts: iso(t), idempotency_key: `${m}:${unit}:${++k}` });
      rows.push({ event: 'unit-transition', action: 'complete', unit, milestone: m, host_runtime: 'codex', ts: iso(t + duration), idempotency_key: `${m}:${unit}:${++k}` });
      t += duration + 1000;
    }
    write(cwd, `.gsd/milestones/${m}/${m}-events.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    start += 86400000;
  }
}
function owner(label, options = {}) {
  const cwd = root(label); docs(cwd);
  if (options.history !== false) history(cwd, options.history || 'suficiente');
  state.write(cwd, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
  if (options.enroll !== false) assert.equal(selection.enroll(cwd, M, { source: 'owner', now: NOW - 3600000 }).status, 'enrolled');
  return cwd;
}
function clock(f) { return () => NOW + f.at; }
function fixture(host, label, options = {}) {
  const cwd = owner(label, options);
  const f = { cwd, host, at: 0, input: { cwd, milestone: M, workflow_id: `${label}-${host}`, owner_token: `${label}-owner`, max_steps: 20 } };
  f.options = { prefsReader, now: clock(f) };
  return f;
}
function invoke(f, command, snapshot, extra = {}, options = f.options) {
  f.at += 1000;
  return adapter.invoke(f.host, 'auto', command, { ...f.input, ...extra }, snapshot, options).result;
}

// --- acceptance through the canonical native path (no transport, no provider) ----------
function prefsFile(cwd) {
  const tiers = Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']]));
  write(cwd, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: tiers, routing: { default: { executor: tiers, planner: tiers } },
    effort: { 'plan-milestone': 'medium', 'estimate-milestone': 'medium' } }));
}
function artifactRequest(f, unitType) {
  prefsFile(f.cwd);
  const id = `${unitType}-${f.host}-${++serial}`;
  const r = { cwd: f.cwd, contextRoot: f.cwd, milestoneId: M, unitType, dispatchId: id, workflowId: f.input.workflow_id,
    resultFile: path.join(RESULTS, id + '.json'), prompt: 'Isolated flow fixture only.' };
  r.route = resolver.resolveDispatch({ cwd: f.cwd, unitType, milestoneId: M, unitId: M, hostRuntime: f.host });
  return r;
}
// The real project-local preference file read by the canonical reader (no reader seam).
function reviewMode(cwd, mode) {
  const prefs = JSON.parse(fs.readFileSync(path.join(cwd, '.gsd/forge-prefs.jsonc'), 'utf8'));
  write(cwd, '.gsd/forge-prefs.jsonc', JSON.stringify({ ...prefs, review: { mode } }));
}
function candidate(relative, content) { return { status: 'done', summary: 'Fixture delivery', questions: [], artifacts: [{ path: relative, content }] }; }
async function accept(f, unitType, relative, content) {
  const r = artifactRequest(f, unitType);
  assert.equal(sidecar.beginArtifactAttempt(r).state, 'started');
  try { return { accepted: await sidecar.acceptArtifactResult(r, candidate(relative, content), { providerCalled: true }) }; }
  catch (error) { return { error }; }
}
// Live host resolver fixture: an opaque handle only for the persisted explicit answer.
function liveAdapter(f, overrides = {}) {
  return { getDecisionHandle(request) {
    if (overrides.raw) return overrides.raw(request);
    const read = questions.continuation({ cwd: f.cwd, identity: request.question.identity_sha256 });
    const row = read.ok ? read.questions.find(q => q.id === request.question.id) : null;
    const at = NOW + f.at;
    const live = { reference: 'fixture-' + request.question.id, status: 'resolved', answer: row && row.answer, source: 'user-text',
      resolved_at: iso(at - 500), question: { ...request.question } };
    return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: request.milestone, kind: request.kind,
      request_sha256: digest(request.request), expires_at: at + 60000 }, () => at);
  } };
}
function answer(f, label) {
  const opened = selection.nextRound({ cwd: f.cwd, milestone: M });
  assert.equal(opened.status, 'open', JSON.stringify(opened));
  const answered = selection.answerRound({ cwd: f.cwd, milestone: M, round: opened.question_id, response: label, source: 'user-text' });
  assert.equal(answered.status, 'answered', JSON.stringify(answered));
  return opened;
}
function decide(f, live = liveAdapter(f)) { return selection.decide({ cwd: f.cwd, milestone: M, liveAdapter: live, now: NOW + f.at }); }
function transactions(cwd) {
  const dir = controller.transactionDir(cwd);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => controller.readJson(path.join(dir, name))) : [];
}
function begins(cwd, type) { return transactions(cwd).filter(row => row.action === 'begin' && row.unit.type === type); }

// Estimate dispatch -> accepted proposal -> complete -> materialized options, pending decision.
async function toDecision(f, proposal = PROPOSALS.base) {
  const first = invoke(f, 'next');
  assert.equal(first.outcome, 'dispatch_required', JSON.stringify(first.controller_result));
  assert.equal(first.unit.key, `estimate-milestone/${M}`);
  const estimate = first.controller_result.details.time_options;
  assert.equal(first.controller_result.details.transaction.idempotency_key, selection.estimateBeginKey(M, estimate.key_suffix));
  assert.equal(selection.estimateKeySuffix(estimate.producer_basis), estimate.key_suffix, 'the forwarded basis is the owner capture behind the key');
  const accepted = await accept(f, 'estimate-milestone', OPTIONS, JSON.stringify(proposal, null, 2));
  assert.equal(accepted.error, undefined, accepted.error && (accepted.error.code || accepted.error.message));
  const done = invoke(f, 'complete', first.snapshot, { result: { status: 'done' } });
  assert.equal(done.outcome, 'completed', JSON.stringify(done.controller_result));
  const blocked = invoke(f, 'next', done.snapshot);
  return { first, estimate, done, blocked };
}

const ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
  { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
  { id: 's4', kind: 'slice', slice: 'S04', ms: 1200000, nodes: ['N4'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
  { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
function roadmapText(section, opts = {}) {
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [${opts.checked ? 'x' : ' '}] **S01: Contrato** \`risk:low\` \`depends:[]\`\n- [ ] **S02: Seleção** \`risk:low\` \`depends:[S01]\`\n`
    + `- [ ] **S03: Resumo** \`risk:low\` \`depends:[]\`\n- [ ] **S04: Relatório** \`risk:low\` \`depends:[S02]\`\n${opts.extraSlice || ''}\n`
    + (section === null ? '' : `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(section, null, opts.compact ? 0 : 2)}\n\`\`\`\n`);
}
function skeleton(f) { return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(selection.promptBlock(f.cwd, M))[1]); }
function questionFiles(cwd) { const dir = path.join(cwd, '.gsd/forge/questions'); return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; }
function stripped(proposal) { const value = structuredClone(proposal); for (const p of value.positions) for (const n of p.nodes) n.judgment = null; return value; }

function closeAllocationFixtureSlice(f, snapshot, slice) {
  // Strict planning now creates a real task; close it with the existing canonical proof fixtures.
  const task = invoke(f, 'next', snapshot);
  assert.deepEqual([task.outcome, task.unit.key], ['dispatch_required', 'execute-task/T01'], JSON.stringify(task.controller_result));
  deliveryFile(f.cwd, slice, 'T01');
  const taskDone = invoke(f, 'complete', task.snapshot, { result: { status: 'done' } });
  assert.equal(taskDone.outcome, 'completed', JSON.stringify(taskDone.controller_result));
  slicePlan(f.cwd, slice, [['T01', true]]);
  write(f.cwd, `.gsd/milestones/${M}/slices/${slice}/tasks/T01/T01-SUMMARY.md`, '# T01\nFeito\n');
  const close = invoke(f, 'next', taskDone.snapshot);
  assert.deepEqual([close.outcome, close.unit.key], ['dispatch_required', `complete-slice/${slice}`], JSON.stringify(close.controller_result));
  sliceDeliveryFiles(f.cwd, slice, ['T01']);
  const closed = invoke(f, 'complete', close.snapshot, { result: { status: 'done' } });
  assert.equal(closed.outcome, 'completed', JSON.stringify(closed.controller_result));
  return closed;
}
async function hostFlow(host) {
  const f = fixture(host, 'flow');
  const { blocked, estimate, done } = await toDecision(f);
  // Estimate dispatch used the owner key and forwarded the exact owner capture.
  assert.equal(estimate.begin_key, selection.estimateBeginKey(M, estimate.key_suffix));
  assert.deepEqual(estimate.producer_basis.inputs.documents.map(row => row.path),
    [...['SCOPE', 'CONTEXT', 'BRAINSTORM'].map(k => `.gsd/milestones/${M}/${M}-${k}.md`), '.gsd/REQUIREMENTS.md']);
  assert.equal(done.snapshot.step_count, 1);
  // The next boundary materialized the accepted proposal, rendered it and blocked on the operator.
  assert.deepEqual([blocked.outcome, blocked.reason_code, blocked.lifecycle], ['blocked', 'time-option-pending', 'blocked']);
  const options = blocked.controller_result.details.time_options;
  assert.deepEqual([options.status, options.boundary.status, options.boundary.render], ['decision-pending', 'materialized', 'written']);
  assert.deepEqual(blocked.snapshot.time_option_block, { milestone: M, options_sha256: options.options_sha256 });
  assert.deepEqual([options.round.type, options.round.options.map(row => row.label)], ['mode', ['Escolher posição', 'Teto próprio', 'Sem contrato']]);
  const stored = time.readOptions({ cwd: f.cwd, milestone: M, options_sha256: options.options_sha256 });
  assert.equal(stored.status, 'valid');
  assert.equal(fs.readFileSync(path.join(f.cwd, options.rendered), 'utf8'), require('./forge-milestone-options').renderOptionsMarkdown(stored.record));
  assert.deepEqual(options.positions.map(row => [row.position_id, row.status]), [['curta', 'estimated'], ['media', 'estimated'], ['longa', 'infeasible']]);
  for (const row of options.positions.filter(item => item.status === 'estimated')) {
    assert.ok(row.low_ms > 0 && row.high_ms >= row.low_ms && row.ceiling_ms >= row.high_ms, 'range and proposed ceiling');
    assert.ok(Array.isArray(row.critical_path.nodes) && row.critical_path.high_ms > 0, 'critical path');
    assert.ok(['low', 'medium'].includes(row.confidence), 'explicit uncertainty');
  }
  const longa = options.positions.find(row => row.position_id === 'longa');
  assert.deepEqual([longa.low_ms, longa.high_ms, longa.ceiling_ms], [null, null, null], 'infeasible has no number');
  const sources = stored.record.history.sources.filter(row => row.status === 'available');
  assert.ok(sources.length >= 2 && sources.every(row => /^[a-f0-9]{64}$/.test(row.sha256)), 'sources carry sha256');
  assert.ok(Object.values(stored.record.history.phases).some(row => row.n >= 5), 'samples per phase');
  for (const row of stored.record.estimate.positions.filter(item => item.status === 'estimated')) assert.ok(row.uncertainty, 'uncertainty recorded');
  assert.equal(begins(f.cwd, 'plan-milestone').length, 0);
  // Publication does not invalidate its own producer: a repeated next never re-estimates.
  const again = invoke(f, 'next', null, { workflow_id: `${f.input.workflow_id}-again` });
  assert.deepEqual([again.reason_code, again.controller_result.details.time_options.options_sha256], ['time-option-pending', options.options_sha256]);
  assert.equal(again.controller_result.details.time_options.boundary.status, 'unchanged');
  assert.equal(begins(f.cwd, 'estimate-milestone').length, 1, 'one estimate begin only');

  // No answer: the same snapshot stays pending.
  let resumed = invoke(f, 'resume-time-option', blocked.snapshot);
  assert.deepEqual([resumed.outcome, resumed.reason_code, resumed.snapshot.step_count], ['blocked', 'time-option-pending', 1]);
  // Persisted explicit answers alone (no live handle) do not decide.
  answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
  resumed = invoke(f, 'resume-time-option', blocked.snapshot);
  assert.equal(resumed.reason_code, 'time-option-pending');
  // Imported approvals never decide: JSON flags, a forged block or an adapter returning approved:true.
  resumed = invoke(f, 'resume-time-option', blocked.snapshot, { approved: true, decision: { approved: true, choice: 'option:curta' },
    time_option_block: { milestone: M, options_sha256: options.options_sha256, approved: true } });
  assert.equal(resumed.reason_code, 'time-option-pending');
  const forged = orchestrate.run('resume-time-option', { ...f.input, host_runtime: host, time_option_block: { milestone: M, options_sha256: options.options_sha256, approved: true } });
  assert.equal(forged.reason_code, 'time-option-resume-invalid');
  assert.equal(decide(f, liveAdapter(f, { raw: () => ({ approved: true }) })).reason, 'time-decision-attestation-required');
  assert.equal(selection.decide({ cwd: f.cwd, milestone: M, now: NOW + f.at }).reason, 'time-decision-attestation-required');
  assert.equal(time.readContract({ cwd: f.cwd, milestone: M }).status, 'absent');
  assert.equal(begins(f.cwd, 'plan-milestone').length, 0, 'plan-milestone never selected while pending');

  // The explicit attested answer activates the contract; the SAME snapshot continues.
  const decided = decide(f);
  assert.deepEqual([decided.status, decided.choice], ['decided', 'option'], JSON.stringify(decided));
  const contract = time.readContract({ cwd: f.cwd, milestone: M });
  assert.deepEqual([contract.contract.option.id, contract.contract.option.position_id, contract.contract.ceiling_ms, contract.contract.preselection_started_at],
    ['curta', 'curta', options.positions[0].ceiling_ms, time.readEnrollment({ cwd: f.cwd, milestone: M }).enrollment.enrolled_at]);
  const plan = invoke(f, 'resume-time-option', blocked.snapshot);
  assert.deepEqual([plan.outcome, plan.unit.key, plan.snapshot.step_count, plan.snapshot.time_option_block], ['dispatch_required', `plan-milestone/${M}`, 2, undefined]);
  assert.equal(plan.snapshot.workflow_id, blocked.snapshot.workflow_id);

  // The rendered plan-milestone prompt carries option, contract and range from the owner.
  const rendered = renderPrompt({ cwd: f.cwd, codeDir: SOURCE, templateDir: path.join(SOURCE, 'shared/templates/dispatch'), unitType: 'plan-milestone',
    milestoneId: M, description: 'Fixture roadmap', unitEffort: 'medium', autoCommit: false, memoryMaxTokens: 0, standardsMaxTokens: 0, ledgerMaxTokens: 0,
    memoryQuery: '', memories: '', ledger: '' });
  for (const piece of ['Opção: curta', 'Contrato base: ' + contract.chain[0].sha256, 'Faixa da milestone:', 'Teto:']) assert.ok(rendered.prompt.includes(piece), piece);

  // Acceptance refuses a roadmap without the section, out of range, or moving indispensable verification.
  const section = { ...skeleton(f), allocation: structuredClone(ALLOCATION) };
  const refusals = [[null, 'typed-milestone-roadmap-time-section-missing'],
    [{ ...section, allocation: ALLOCATION.map(row => row.id === 's1' ? { ...row, ms: 30000000 } : row) }, 'typed-milestone-roadmap-time-ceiling-exceeded'],
    [{ ...section, linked_task: { moved_scope: ['REV'] } }, 'typed-milestone-roadmap-time-linked-task-mismatch']];
  for (const [value, reason] of refusals) {
    const refused = await accept(f, 'plan-milestone', ROADMAP, roadmapText(value));
    assert.equal(refused.error?.code, 'invalid-artifact-result', reason);
    const loc = sidecar.locations({ cwd: f.cwd, contextRoot: f.cwd, milestoneId: M, unitType: 'plan-milestone' });
    assert.deepEqual(sidecar.inspectArtifacts(candidate(ROADMAP, roadmapText(value)), loc.allowed, loc.required, Infinity, loc.rules, { detailedDeliveryDiagnostic: true }), { ok: false, reason });
    assert.equal(fs.existsSync(path.join(f.cwd, ROADMAP)), false, 'nothing published');
  }
  const accepted = await accept(f, 'plan-milestone', ROADMAP, roadmapText(section));
  assert.equal(accepted.error, undefined, accepted.error && (accepted.error.code || accepted.error.message));
  const planned = invoke(f, 'complete', plan.snapshot, { result: { status: 'done' } });
  assert.equal(planned.outcome, 'completed');

  // The next boundary publishes the delegated allocation; no question is asked.
  const questionsBefore = questionFiles(f.cwd);
  const slice1 = invoke(f, 'next', planned.snapshot);
  assert.deepEqual([slice1.outcome, slice1.unit.key], ['dispatch_required', 'plan-slice/S01'], JSON.stringify(slice1.controller_result));
  assert.deepEqual([slice1.controller_result.details.time_options.boundary.status, slice1.controller_result.details.time_options.boundary.version], ['allocated', 2]);
  let current = time.readContract({ cwd: f.cwd, milestone: M });
  assert.deepEqual([current.version, current.chain[1].kind, current.chain[1].delegation.basis], [2, 'allocation', 'activation-delegation']);
  assert.equal(selection.readSelectionState(f.cwd, M).roadmap.status, 'conformant', 'conformant after the amendment');
  assert.deepEqual(questionFiles(f.cwd), questionsBefore, 'no redundant question');
  slicePlan(f.cwd, 'S01', [['T01', false]]); taskPlan(f.cwd, 'S01', 'T01', []);
  const sliceDone = invoke(f, 'complete', slice1.snapshot, { result: { status: 'done' } });
  const closedSlice1 = closeAllocationFixtureSlice(f, sliceDone.snapshot, 'S01');
  // A checked box and an equivalent compact JSON section keep the allocation.
  write(f.cwd, ROADMAP, roadmapText(section, { checked: true, compact: true }));
  const slice2 = invoke(f, 'next', closedSlice1.snapshot);
  assert.deepEqual([slice2.unit.key, slice2.controller_result.details.time_options.boundary.status], ['plan-slice/S02', 'unchanged']);
  assert.equal(time.readContract({ cwd: f.cwd, milestone: M }).version, 2);
  slicePlan(f.cwd, 'S02', [['T01', false]]); taskPlan(f.cwd, 'S02', 'T01', []);
  const slice2Done = invoke(f, 'complete', slice2.snapshot, { result: { status: 'done' } });
  // A technical refinement inside strategy/scope/ceiling publishes a new delegated amendment.
  write(f.cwd, ROADMAP, roadmapText({ ...section, allocation: ALLOCATION.map(row => row.id === 's1' ? { ...row, ms: 300000 } : row) }, { checked: true }));
  const refined = invoke(f, 'next', slice2Done.snapshot);
  assert.deepEqual([refined.outcome, refined.controller_result.details.time_options.boundary.status, refined.controller_result.details.time_options.boundary.version],
    ['dispatch_required', 'allocated', 3]);
  current = time.readContract({ cwd: f.cwd, milestone: M });
  assert.deepEqual([current.chain[2].kind, current.contract.allocation.items[1].ms], ['allocation', 300000]);
  assert.deepEqual(questionFiles(f.cwd), questionsBefore, 'still no question');
  if (refined.unit.type === 'plan-slice') {
    slicePlan(f.cwd, refined.unit.id, [['T01', false]]); taskPlan(f.cwd, refined.unit.id, 'T01', []);
  }
  const refinedDone = invoke(f, 'complete', refined.snapshot, { result: { status: 'done' } });
  // A structural change outside the authorization blocks until a specific decision.
  write(f.cwd, ROADMAP, roadmapText({ ...section, allocation: ALLOCATION.map(row => row.id === 's1' ? { ...row, ms: 300000 } : row) },
    { checked: true, extraSlice: '- [ ] **S05: Extra** `risk:low` `depends:[S04]`\n' }));
  const unallocated = invoke(f, 'next', refinedDone.snapshot);
  assert.deepEqual([unallocated.outcome, unallocated.reason_code], ['blocked', 'time-scope-unallocated']);
  assert.equal(unallocated.controller_result.details.time_options.boundary.status, 'unchanged');
  assert.equal(time.readContract({ cwd: f.cwd, milestone: M }).version, 3, 'never auto-allocated');
  assert.deepEqual(unallocated.snapshot.time_option_block, { milestone: M, options_sha256: options.options_sha256 });
  assert.equal(invoke(f, 'resume-time-option', unallocated.snapshot).reason_code, 'time-scope-unallocated', 'resume re-blocks on the same structural change');
  return f;
}

// --- scoped task DAG of an enrolled milestone with an active contract ------------------
// Opt-in TaskPlan binding: the exact selected digest/position and one allocated node, read from the owner.
const NODE_OF = { S01: 'N1', S02: 'N2', S03: 'N3', S04: 'N4' };
function bindingLines(cwd, slice, node = NODE_OF[slice]) {
  const selected = selection.readSelectionState(cwd, M);
  if (selected === null) return ''; // a genuinely legacy milestone keeps its plain TaskPlan
  return `time_options_sha256: ${selected.options_sha256}\ntime_position_id: ${selected.position_id}\ntime_node: ${node}\n`;
}
function taskPlan(cwd, slice, id, depends, node) {
  const source = `src/${slice}-${id}.js`;
  write(cwd, `.gsd/milestones/${M}/slices/${slice}/tasks/${id}/${id}-PLAN.md`, `---\nid: ${id}\nslice: ${slice}\nmilestone: ${M}\ndepends: [${depends.join(', ')}]\n${bindingLines(cwd, slice, node)}writes:\n  - "${source}"\nmust_haves:\n  truths:\n    - "Fixture ${id} verificada"\n  artifacts:\n    - path: "${source}"\n      provides: "Fixture ${id}"\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - "${source}"\n---\n# ${id}\n`);
}
function slicePlan(cwd, slice, tasks) {
  write(cwd, `.gsd/milestones/${M}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n\n## Tasks\n${tasks.map(([id, checked]) => `- [${checked ? 'x' : ' '}] **${id}: Trabalho ${id}**`).join('\n')}\n`);
}
function deliveryFile(cwd, slice, task, exitCode = 0, depends = []) {
  // Genuine canonical historical proof: structured plan with declared writes and two criteria, the
  // verification and artifact captures of one workspace, delivery input and the output of the public
  // builder (never hand-made verified JSON).
  const delivery = require('./forge-delivery'), unit = { type: 'task', id: task, slice, milestone: M }, key = delivery.unitKey(unit);
  const rel = name => `.gsd/milestones/${M}/slices/${slice}/tasks/${task}/${task}-${name}`, source = `src/${slice}-${task}.js`;
  const planText = `---\nid: ${task}\nslice: ${slice}\nmilestone: ${M}\ndepends: [${depends.join(', ')}]\n${bindingLines(cwd, slice)}writes:\n  - "${source}"\n`
    + `must_haves:\n  truths:\n    - "Fixture ${task} verificada"\n  artifacts:\n    - path: "${source}"\n      provides: "Fixture ${task}"\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - "${source}"\n---\n# ${task}\n`;
  write(cwd, rel('PLAN.md'), planText);
  const context = { schema_version: 1, unit, plan_fingerprint: delivery.sha256(planText), code_dir: cwd, revision: 'abc123',
    workspace: [{ path: source, hash: 'c'.repeat(40) }], environment: 'node-test', captured_at: '2026-11-02T12:00:00.000Z' };
  write(cwd, rel('VERIFY-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'verification', result: { passed: !exitCode, checks: [{ command: 'node check.js', exitCode }] } }));
  write(cwd, rel('ARTIFACT-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'artifact', result: { passed: true, rows: [{ path: source, exists: true }] } }));
  const input = { schema_version: 1, unit, plan: rel('PLAN.md'), plan_fingerprint: delivery.sha256(planText), bindings: [
    { criterion_id: `${key}:truth:0`, coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 0 } },
    { criterion_id: `${key}:artifact:0`, coverage: 'structural', source: { kind: 'artifact', path: rel('ARTIFACT-ENVELOPE.json'), row_index: 0, property: 'exists' } }] };
  write(cwd, rel('DELIVERY-INPUT.json'), JSON.stringify(input));
  write(cwd, rel('DELIVERY.json'), JSON.stringify(delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd }), null, 2));
}
// The canonical slice closure artifacts: the review gate record and the slice delivery built by the
// public builder over the exact slice plan and every child delivery (the complete-slice transition itself
// goes through the bridge).
function sliceDeliveryFiles(cwd, slice, tasks) {
  const delivery = require('./forge-delivery'), dir = `.gsd/milestones/${M}/slices/${slice}`;
  write(cwd, `${dir}/${slice}-REVIEW.md`, `# ${slice} review\n\n**Outcome:** 0 resolved · 0 conceded · 0 open\n`);
  const input = { schema_version: 1, unit: { type: 'slice', id: slice, milestone: M }, plan: `${dir}/${slice}-PLAN.md`,
    plan_fingerprint: delivery.sha256(fs.readFileSync(path.join(cwd, ...`${dir}/${slice}-PLAN.md`.split('/')), 'utf8')), bindings: [],
    expected_children: tasks.map(task => ({ unit: { type: 'task', id: task, slice, milestone: M }, delivery: `${dir}/tasks/${task}/${task}-DELIVERY.json` })),
    facts: { review: { status: 'completed with 0 open', reference: `${slice}-REVIEW.md` } } };
  write(cwd, `${dir}/${slice}-DELIVERY-INPUT.json`, JSON.stringify(input));
  write(cwd, `${dir}/${slice}-DELIVERY.json`, JSON.stringify(delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd }), null, 2));
}
function markSlice(cwd, slice, checked) {
  const file = path.join(cwd, ROADMAP), text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(new RegExp(`- \\[[ x]\\] \\*\\*${slice}:`), `- [${checked ? 'x' : ' '}] **${slice}:`));
  const summary = path.join(cwd, `.gsd/milestones/${M}/slices/${slice}/${slice}-SUMMARY.md`);
  if (checked) write(cwd, `.gsd/milestones/${M}/slices/${slice}/${slice}-SUMMARY.md`, `# ${slice}\nConcluído\n`); else fs.rmSync(summary, { force: true });
}
function explicitTask(f, slice, task, key) {
  return () => controller.begin(f.cwd, { milestone: M, unit: `execute-task/${task}`, slice, state_patch: { active_slice: slice }, host_runtime: f.host,
    owner_token: 'explicit-owner', idempotency_key: key }, { prefsReader, now: clock(f),
    inventoryReader: () => ({ roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: slice, checked: false, plan_exists: true, research_exists: true,
      tasks: [{ id: task, checked: false }] }] }) });
}
async function dagFlow(host) {
  const f = fixture(host, 'dag');
  const { blocked } = await toDecision(f);
  answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
  assert.equal(decide(f).status, 'decided');
  const plan = invoke(f, 'resume-time-option', blocked.snapshot);
  assert.equal((await accept(f, 'plan-milestone', ROADMAP, roadmapText({ ...skeleton(f), allocation: structuredClone(ALLOCATION) }))).error, undefined);
  const slice = invoke(f, 'next', invoke(f, 'complete', plan.snapshot, { result: { status: 'done' } }).snapshot);
  assert.equal(slice.unit.key, 'plan-slice/S01');
  // Inverted checklist: T08 is listed first but depends on T10.
  slicePlan(f.cwd, 'S01', [['T08', false], ['T10', false]]); taskPlan(f.cwd, 'S01', 'T08', ['T10']); taskPlan(f.cwd, 'S01', 'T10', []);
  const first = invoke(f, 'next', invoke(f, 'complete', slice.snapshot, { result: { status: 'done' } }).snapshot);
  assert.deepEqual([first.outcome, first.unit.key], ['dispatch_required', 'execute-task/T10'], JSON.stringify(first.controller_result));
  // Explicit begin of T08 before T10 is refused under the mutex: zero lease and zero transaction.
  const before = transactions(f.cwd).length;
  assert.throws(explicitTask(f, 'S01', 'T08', 'explicit-T08'), error => error.code === 'time-task-dependency-pending' && error.details.task_dag.pending.includes('T10'));
  assert.deepEqual([transactions(f.cwd).length, lease.observe(f.cwd, 'execute-task/T08').lease], [before, null]);
  // T10 completes through the bridge and is checked, with a SUMMARY, but has no verified delivery: T08 stays blocked.
  const done = invoke(f, 'complete', first.snapshot, { result: { status: 'done' } });
  slicePlan(f.cwd, 'S01', [['T08', false], ['T10', true]]); write(f.cwd, `.gsd/milestones/${M}/slices/S01/tasks/T10/T10-SUMMARY.md`, '# T10\nFeito\n');
  const pending = invoke(f, 'next', done.snapshot);
  assert.deepEqual([pending.outcome, pending.reason_code, pending.controller_result.details.task_dag.slice], ['blocked', 'time-task-dependency-pending', 'S01']);
  assert.deepEqual(pending.snapshot.time_option_block, { milestone: M, options_sha256: blocked.snapshot.time_option_block.options_sha256 });
  // The verified historical delivery plus the scoped committed completion prove T10; the same snapshot continues.
  // A failing captured check behind an intact-looking delivery never proves T10 (next and explicit begin).
  deliveryFile(f.cwd, 'S01', 'T10', 1);
  const forged = invoke(f, 'resume-time-option', pending.snapshot);
  assert.deepEqual([forged.outcome, forged.reason_code], ['blocked', 'time-task-dependency-pending']);
  assert.throws(explicitTask(f, 'S01', 'T08', 'explicit-T08-forged'), error => error.code === 'time-task-dependency-pending');
  deliveryFile(f.cwd, 'S01', 'T10');
  const t08 =invoke(f, 'resume-time-option', pending.snapshot);
  assert.deepEqual([t08.outcome, t08.unit.key], ['dispatch_required', 'execute-task/T08'], JSON.stringify(t08.controller_result));
  // Same task IDs in another slice: S01/T10's proof never satisfies S03/T08 -> S03/T10.
  slicePlan(f.cwd, 'S03', [['T08', false], ['T10', false]]); taskPlan(f.cwd, 'S03', 'T08', ['T10']); taskPlan(f.cwd, 'S03', 'T10', []);
  assert.throws(explicitTask(f, 'S03', 'T08', 'explicit-S03-T08'), error => error.code === 'time-task-dependency-pending');
  // Unknown and cyclic dependencies refuse explicitly.
  taskPlan(f.cwd, 'S03', 'T08', ['T99']);
  assert.throws(explicitTask(f, 'S03', 'T10', 'explicit-S03-T10-unknown'), error => error.code === 'time-task-dependency-unknown');
  taskPlan(f.cwd, 'S03', 'T08', ['T10']); taskPlan(f.cwd, 'S03', 'T10', ['T08']);
  assert.throws(explicitTask(f, 'S03', 'T10', 'explicit-S03-T10-cycle'), error => error.code === 'time-task-dependency-cycle');
  slicePlan(f.cwd, 'S03', [['T08', false], ['T08', false]]);
  assert.throws(explicitTask(f, 'S03', 'T08', 'explicit-S03-T08-ambiguous'), error => error.code === 'time-task-identity-ambiguous');
  assert.equal(transactions(f.cwd).filter(row => /^explicit-/.test(row.idempotency_key)).length, 0, 'no explicit begin was admitted');
  // R52 through the bridge: dependent S02 waits for the canonical closure and review of S01.
  slicePlan(f.cwd, 'S03', [['T08', false], ['T10', false]]); taskPlan(f.cwd, 'S03', 'T08', ['T10']); taskPlan(f.cwd, 'S03', 'T10', []);
  const t08Done = invoke(f, 'complete', t08.snapshot, { result: { status: 'done' } });
  deliveryFile(f.cwd, 'S01', 'T08', 0, ['T10']);
  slicePlan(f.cwd, 'S01', [['T08', true], ['T10', true]]);
  slicePlan(f.cwd, 'S02', [['T01', false]]); taskPlan(f.cwd, 'S02', 'T01', []);
  const slice01Barrier = key => {
    let caught = null;
    try { explicitTask(f, 'S02', 'T01', key)(); } catch (error) { caught = error; }
    assert.equal(caught?.code, 'time-task-dependency-pending', String(caught && caught.message));
    return caught.details.task_dag.barrier.filter(row => row.slice === 'S01').map(row => [row.task, row.reason, row.proof]);
  };
  // Every S01 task done and proven, then checkbox + SUMMARY: the slice is still not closed (next and explicit begin).
  assert.deepEqual(slice01Barrier('explicit-S02-tasks-only'), [[null, 'slice-incomplete', 'delivery-completion-missing']]);
  markSlice(f.cwd, 'S01', true);
  const fake = invoke(f, 'next', t08Done.snapshot);
  assert.deepEqual([fake.outcome, fake.reason_code, fake.controller_result.details.task_dag.slice], ['blocked', 'time-task-dependency-pending', 'S02'],
    JSON.stringify(fake.controller_result));
  assert.match(JSON.stringify(fake.controller_result.details.task_dag), /"slice":"S01","task":null,"reason":"slice-incomplete","proof":"delivery-completion-missing"/);
  assert.deepEqual(slice01Barrier('explicit-S02-summary'), [[null, 'slice-incomplete', 'delivery-completion-missing']]);
  // The canonical closure: complete-slice selected and completed through the bridge with its delivery and review.
  markSlice(f.cwd, 'S01', false);
  const close = invoke(f, 'resume-time-option', fake.snapshot);
  assert.deepEqual([close.outcome, close.unit.key], ['dispatch_required', 'complete-slice/S01'], JSON.stringify(close.controller_result));
  sliceDeliveryFiles(f.cwd, 'S01', ['T08', 'T10']);
  const closed = invoke(f, 'complete', close.snapshot, { result: { status: 'done' } });
  markSlice(f.cwd, 'S01', true);
  const s02 = controller.discoverInventory(f.cwd, M, state.read(f.cwd, M), { now: clock(f) }).slices.find(row => row.id === 'S02').task_dag;
  assert.deepEqual([s02.status, s02.tasks[0].barrier], ['valid', []], 'closed and reviewed S01 leaves no barrier');
  // The review record removed: the closure is unreviewed and the dependent refuses again.
  const review = path.join(f.cwd, `.gsd/milestones/${M}/slices/S01/S01-REVIEW.md`), reviewBytes = fs.readFileSync(review);
  fs.rmSync(review);
  assert.deepEqual(slice01Barrier('explicit-S02-unreviewed'), [[null, 'slice-unreviewed', 'slice-review-missing']]);
  fs.writeFileSync(review, reviewBytes);
  const dependent = invoke(f, 'next', closed.snapshot);
  assert.deepEqual([dependent.outcome, dependent.unit.key], ['dispatch_required', 'execute-task/T01'], JSON.stringify(dependent.controller_result));
  assert.equal(controller.lookupRecord(f.cwd, 'transaction', dependent.controller_result.details.transaction.idempotency_key).after.state.active_slice, 'S02');
  assert.equal(transactions(f.cwd).filter(row => /^explicit-/.test(row.idempotency_key)).length, 0, 'no explicit begin was admitted');
}
// A selected edge inside one slice (N2 depends on N1, both allocated to S01) realized by the real task graph: T08 (N2) must reach T10 (N1).
const BINDING_ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 3000000, nodes: ['N1', 'N2'] },
  { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N4'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
  { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] }, { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
function bindingRoadmap(section) {
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato** \`risk:low\` \`depends:[]\`\n- [ ] **S02: Relatório** \`risk:low\` \`depends:[S01]\`\n`
    + `- [ ] **S03: Resumo** \`risk:low\` \`depends:[]\`\n\n## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(section, null, 2)}\n\`\`\`\n`;
}
async function bindingFlow(host) {
  const f = fixture(host, 'binding');
  const { blocked } = await toDecision(f);
  answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
  assert.equal(decide(f).status, 'decided');
  const plan = invoke(f, 'resume-time-option', blocked.snapshot);
  assert.equal((await accept(f, 'plan-milestone', ROADMAP, bindingRoadmap({ ...skeleton(f), allocation: structuredClone(BINDING_ALLOCATION) }))).error, undefined);
  const slice = invoke(f, 'next', invoke(f, 'complete', plan.snapshot, { result: { status: 'done' } }).snapshot);
  assert.equal(slice.unit.key, 'plan-slice/S01');
  const context = selection.taskBindingContext(f.cwd, M, { sliceId: 'S01' });
  assert.deepEqual([context.status, context.allocated.map(item => item.id), context.edges.map(edge => `${edge.from}>${edge.to}`)], ['ready', ['N1', 'N2'], ['N1>PREP', 'N2>N1']]);
  slicePlan(f.cwd, 'S01', [['T08', false], ['T10', false]]);
  taskPlan(f.cwd, 'S01', 'T08', ['T10'], 'N2'); taskPlan(f.cwd, 'S01', 'T10', [], 'N1');
  const done = invoke(f, 'complete', slice.snapshot, { result: { status: 'done' } });
  const roadmapBytes = fs.readFileSync(path.join(f.cwd, ROADMAP), 'utf8');
  const unchanged = () => JSON.stringify([fs.readFileSync(path.join(f.cwd, ROADMAP), 'utf8') === roadmapBytes, selection.readSelectionState(f.cwd, M), time.readContract({ cwd: f.cwd, milestone: M }).sha256]);
  const baseline = unchanged();
  let serial = 0;
  // Removing or inverting the required task edge (choice, roadmap and contract untouched) refuses next, explicit begin and a fresh workflow with zero writes.
  for (const [label, t08, t10] of [['removed', [], []], ['inverted', [], ['T08']]]) {
    taskPlan(f.cwd, 'S01', 'T08', t08, 'N2'); taskPlan(f.cwd, 'S01', 'T10', t10, 'N1');
    const before = transactions(f.cwd).length;
    for (const refused of [invoke(f, 'next', done.snapshot), invoke(f, 'next', null, { workflow_id: `${f.input.workflow_id}-${label}-${++serial}` })]) {
      assert.deepEqual([refused.outcome, refused.reason_code], ['blocked', 'time-task-dependency-unknown'], `${label}: ${JSON.stringify(refused.controller_result)}`);
    }
    for (const task of ['T08', 'T10']) assert.throws(explicitTask(f, 'S01', task, `explicit-${label}-${task}`), error => error.code === 'time-task-dependency-unknown');
    assert.deepEqual([transactions(f.cwd).length, lease.observe(f.cwd, 'execute-task/T08').lease, lease.observe(f.cwd, 'execute-task/T10').lease], [before, null, null], `${label}: zero writes`);
    assert.equal(unchanged(), baseline, `${label}: selection, roadmap and contract unchanged`);
  }
  // Binding metadata that is missing or foreign is a named scope/allocation block, never legacy.
  taskPlan(f.cwd, 'S01', 'T08', ['T10'], 'N2'); taskPlan(f.cwd, 'S01', 'T10', [], 'N7');
  assert.deepEqual(['time-scope-unallocated'], [invoke(f, 'next', done.snapshot).reason_code]);
  assert.throws(explicitTask(f, 'S01', 'T10', 'explicit-N7'), error => error.code === 'time-scope-unallocated');
  // The real realization admits the work.
  taskPlan(f.cwd, 'S01', 'T10', [], 'N1');
  const first = invoke(f, 'next', done.snapshot);
  assert.deepEqual([first.outcome, first.unit.key], ['dispatch_required', 'execute-task/T10'], JSON.stringify(first.controller_result));
  assert.throws(explicitTask(f, 'S01', 'T08', 'explicit-T08-early'), error => error.code === 'time-task-dependency-pending' && error.details.task_dag.pending.includes('T10'));
  assert.equal(unchanged(), baseline);
}
// The same roadmap/plans without enrollment: the checklist order is unchanged legacy behavior.
function legacyDag(host) {
  const f = fixture(host, 'dag-legacy', { enroll: false, history: false });
  write(f.cwd, ROADMAP, roadmapText(null));
  write(f.cwd, `.gsd/milestones/${M}/slices/S01/S01-PLAN.md`, '# S01\n');
  slicePlan(f.cwd, 'S01', [['T08', false], ['T10', false]]); taskPlan(f.cwd, 'S01', 'T08', ['T10']); taskPlan(f.cwd, 'S01', 'T10', []);
  const first = invoke(f, 'next');
  assert.deepEqual([first.outcome, first.unit.key], ['dispatch_required', 'execute-task/T08']);
  const inventory = controller.discoverInventory(f.cwd, M, state.read(f.cwd, M));
  assert.equal(inventory.task_dag, undefined); assert.equal(inventory.slices[0].task_dag, undefined);
}

async function main() {
  for (const host of ['claude', 'codex']) {
    await test(`${host}: enrolled contract milestone admits tasks by the scoped DAG (inverted list, explicit begin, slice identity, unknown/cycle/ambiguous)`, () => dagFlow(host));
    await test(`${host}: a selected allocated edge needs its task edge (removed/inverted/unbound refuse next, begin and fresh workflow without writes)`, () => bindingFlow(host));
    await test(`${host}: untimed milestone keeps the checklist selection`, () => legacyDag(host));
    await test(`${host}: estimate -> pending decision -> attested choice -> same-snapshot plan-milestone -> roadmap conformance and delegated allocation`, () => hostFlow(host));

    await test(`${host}: roadmap written outside acceptance blocks next with time-roadmap-nonconformant and refuses explicit dependents`, async () => {
      const f = fixture(host, 'outside');
      const { blocked } = await toDecision(f);
      answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
      assert.equal(decide(f).status, 'decided');
      const plan = invoke(f, 'resume-time-option', blocked.snapshot);
      assert.equal(plan.unit.key, `plan-milestone/${M}`);
      write(f.cwd, ROADMAP, roadmapText(null));
      const planned = invoke(f, 'complete', plan.snapshot, { result: { status: 'done' } });
      const refused = invoke(f, 'next', planned.snapshot);
      assert.deepEqual([refused.outcome, refused.reason_code, refused.controller_result.details.time_options.roadmap.status],
        ['blocked', 'time-roadmap-nonconformant', 'nonconformant']);
      const before = transactions(f.cwd).length;
      assert.throws(() => controller.begin(f.cwd, { milestone: M, unit: 'plan-slice/S01', slice: 'S01', state_patch: { active_slice: 'S01' },
        host_runtime: host, owner_token: 'explicit', idempotency_key: 'explicit-plan-slice' },
        { prefsReader, now: clock(f), inventoryReader: () => ({ roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S01', checked: false, plan_exists: false, tasks: [] }] }) }),
      error => error.code === 'time-roadmap-nonconformant');
      assert.equal(transactions(f.cwd).length, before, 'zero transaction');
      assert.equal(lease.observe(f.cwd, 'plan-slice/S01').lease, null, 'zero lease');
    });

    await test(`${host}: operator ceiling keeps the chosen position and DAG; no-contract needs a live handle`, async () => {
      const f = fixture(host, 'ceiling');
      const { blocked } = await toDecision(f);
      answer(f, 'Teto próprio'); answer(f, 'Escopo completo (curta)');
      const opened = selection.nextRound({ cwd: f.cwd, milestone: M });
      assert.equal(selection.answerRound({ cwd: f.cwd, milestone: M, round: opened.question_id, response: '9h', source: 'user-text' }).answer, 'operator-ceiling:32400000');
      assert.equal(decide(f).status, 'decided');
      const contract = time.readContract({ cwd: f.cwd, milestone: M }).contract;
      assert.deepEqual([contract.ceiling_ms, contract.option.position_id, contract.decision.answer], [32400000, 'curta', 'operator-ceiling:32400000']);
      assert.deepEqual(selection.roadmapRule(f.cwd, M).expected.nodes.map(row => row.id).sort(), ['COR', 'INT', 'N1', 'N2', 'N3', 'N4', 'PREP', 'REV'].sort(), 'same DAG');
      assert.equal(invoke(f, 'resume-time-option', blocked.snapshot).unit.key, `plan-milestone/${M}`);

      const n = fixture(host, 'no-contract');
      const pending = (await toDecision(n)).blocked;
      answer(n, 'Sem contrato');
      assert.equal(selection.decide({ cwd: n.cwd, milestone: M, now: NOW + n.at }).reason, 'time-decision-attestation-required');
      assert.throws(() => time.recordSelection({ cwd: n.cwd, milestone: M, selection: { choice: 'no-contract', options_sha256: pending.snapshot.time_option_block.options_sha256 }, now: NOW }),
        error => error.code === 'time-decision-attestation-required');
      assert.equal(invoke(n, 'resume-time-option', pending.snapshot).reason_code, 'time-option-pending');
      assert.equal(decide(n).choice, 'no-contract');
      const plan = invoke(n, 'resume-time-option', pending.snapshot);
      assert.equal(plan.unit.key, `plan-milestone/${M}`);
      assert.equal(time.readContract({ cwd: n.cwd, milestone: M }).status, 'absent');
      const roadmap = await accept(n, 'plan-milestone', ROADMAP, roadmapText(null));
      assert.equal(roadmap.error, undefined, 'no-contract roadmap needs no section');
    });

    await test(`${host}: review disabled is a named incompatibility before a contracted activation and for new admissions after it; no-contract stays normal`, async () => {
      const f = fixture(host, 'review');
      const { blocked } = await toDecision(f);
      const canonical = { now: clock(f) };
      // Inspectable before the choice through the bridge, from the real effective preference file.
      reviewMode(f.cwd, 'disabled');
      const shown = invoke(f, 'next', null, { workflow_id: `${f.input.workflow_id}-shown` }, canonical);
      assert.deepEqual([shown.reason_code, shown.controller_result.details.time_options.contract_compatibility],
        ['time-option-pending', { status: 'incompatible', reason: 'review-disabled', review_mode: 'disabled' }]);
      answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
      const questionsBefore = questionFiles(f.cwd);
      const refused = decide(f);
      assert.deepEqual([refused.status, refused.reason], ['refused', 'time-review-disabled-incompatible']);
      assert.deepEqual([time.readContract({ cwd: f.cwd, milestone: M }).status, selection.readSelectionState(f.cwd, M).status], ['absent', 'decision-pending']);
      assert.equal(invoke(f, 'resume-time-option', blocked.snapshot, {}, canonical).reason_code, 'time-option-pending', 'never activated');
      assert.equal(begins(f.cwd, 'plan-milestone').length, 0);
      // Restoring the compatible mode activates the same recorded answers without a new question.
      reviewMode(f.cwd, 'enabled');
      assert.equal(decide(f).status, 'decided');
      assert.deepEqual(questionFiles(f.cwd), questionsBefore, 'no redundant question');
      // Disabled after activation: the new admission is refused by name with zero writes.
      reviewMode(f.cwd, 'disabled');
      const before = transactions(f.cwd).length;
      const off = invoke(f, 'resume-time-option', blocked.snapshot, {}, canonical);
      assert.deepEqual([off.outcome, off.reason_code, off.controller_result.details.review.reason], ['blocked', 'time-review-disabled-incompatible', 'review-disabled'],
        JSON.stringify(off.controller_result));
      assert.deepEqual([transactions(f.cwd).length, lease.observe(f.cwd, `plan-milestone/${M}`).lease], [before, null], 'zero writes');
      assert.deepEqual(off.snapshot.time_option_block, { milestone: M, options_sha256: blocked.snapshot.time_option_block.options_sha256 });
      reviewMode(f.cwd, 'enabled');
      const plan = invoke(f, 'resume-time-option', off.snapshot, {}, canonical);
      assert.deepEqual([plan.outcome, plan.unit.key], ['dispatch_required', `plan-milestone/${M}`], JSON.stringify(plan.controller_result));
      // An attested no-contract choice keeps the normal path with review disabled.
      const n = fixture(host, 'review-none');
      const pending = (await toDecision(n)).blocked;
      reviewMode(n.cwd, 'disabled');
      answer(n, 'Sem contrato');
      assert.equal(decide(n).choice, 'no-contract');
      const none = invoke(n, 'resume-time-option', pending.snapshot, {}, { now: clock(n) });
      assert.deepEqual([none.outcome, none.unit.key], ['dispatch_required', `plan-milestone/${M}`], JSON.stringify(none.controller_result));
      assert.equal(time.readContract({ cwd: n.cwd, milestone: M }).status, 'absent');
    });

    await test(`${host}: relevant code change before the choice gets a new estimate begin; a change after the choice keeps history`, async () => {
      const f = fixture(host, 'code');
      const code = path.join(f.cwd, 'code'); write(code, 'src/app.js', 'module.exports = 1;\n');
      f.input.code = { root: code, files: ['src/app.js'] };
      const { blocked, estimate } = await toDecision(f);
      assert.equal(blocked.reason_code, 'time-option-pending');
      assert.deepEqual(estimate.producer_basis.inputs.code_files.map(row => row.path), ['src/app.js']);
      write(code, 'src/app.js', 'module.exports = 2;\n');
      const stale = invoke(f, 'resume-time-option', blocked.snapshot);
      assert.deepEqual([stale.outcome, stale.unit.key], ['dispatch_required', `estimate-milestone/${M}`], JSON.stringify(stale.controller_result));
      const second = stale.controller_result.details.time_options;
      assert.notEqual(second.begin_key, estimate.begin_key, 'new begin key');
      assert.equal(second.producer_basis.previous_options_sha256, blocked.snapshot.time_option_block.options_sha256);
      assert.equal(begins(f.cwd, 'estimate-milestone').length, 2);
      // Without the same CODE_DIR locator the owner capture differs: refused before begin, never re-keyed by the caller.
      const opened = begins(f.cwd, 'estimate-milestone').length;
      const mismatch = orchestrate.run('next', { ...f.input, code: undefined, idempotency_key: undefined, host_runtime: host }, { prefsReader, now: clock(f) });
      assert.deepEqual([mismatch.outcome, mismatch.reason_code, mismatch.details.time_options.reason], ['blocked', 'time-options-invalid', 'producer-basis-mismatch']);
      assert.equal(begins(f.cwd, 'estimate-milestone').length, opened, 'refused before any begin');
      const accepted = await accept(f, 'estimate-milestone', OPTIONS, JSON.stringify(PROPOSALS.base, null, 2));
      assert.equal(accepted.error, undefined);
      const fresh = invoke(f, 'next', invoke(f, 'complete', stale.snapshot, { result: { status: 'done' } }).snapshot);
      assert.equal(fresh.reason_code, 'time-option-pending');
      answer(f, 'Escolher posição'); answer(f, 'Escopo completo (curta) (Recomendado)');
      assert.equal(decide(f).status, 'decided');
      write(code, 'src/app.js', 'module.exports = 3;\n'); docs(f.cwd, ' depois da escolha');
      const kept = selection.readSelectionState(f.cwd, M, { code: f.input.code });
      assert.deepEqual([kept.status, kept.options_sha256], ['decided', fresh.snapshot.time_option_block.options_sha256]);
      assert.equal(invoke(f, 'resume-time-option', fresh.snapshot).unit.key, `plan-milestone/${M}`);
    });

    await test(`${host}: empty history gives evidence-insufficient without any number`, async () => {
      const f = fixture(host, 'empty', { history: false });
      const { blocked } = await toDecision(f, stripped(PROPOSALS.base));
      const positions = blocked.controller_result.details.time_options.positions;
      assert.ok(positions.every(row => row.low_ms === null && row.high_ms === null && row.ceiling_ms === null), JSON.stringify(positions));
      assert.ok(positions.some(row => row.status === 'evidence-insufficient'), JSON.stringify(positions.map(row => row.status)));
    });

    await test(`${host}: unenrolled and preexisting-roadmap milestones and standalone tasks never enter the flow`, () => {
      const f = fixture(host, 'legacy', { enroll: false, history: false });
      const inventory = controller.discoverInventory(f.cwd, M, state.read(f.cwd, M));
      assert.deepEqual(Object.keys(inventory), ['roadmap_exists', 'context_exists', 'research_exists', 'active_slice', 'slices', 'dependency_validation', 'milestone_complete']);
      const first = invoke(f, 'next');
      assert.deepEqual([first.outcome, first.unit.key], ['dispatch_required', `plan-milestone/${M}`]);
      assert.equal(first.controller_result.details.time_options, undefined);
      assert.equal(first.controller_result.details.transaction.idempotency_key, `forge-orchestrate-next:${M}:plan-milestone/${M}`);
      assert.equal(fs.existsSync(path.join(f.cwd, '.gsd/forge/time')), false, 'nothing enrolled or written');
      const injected = { roadmap_exists: false };
      controller.select(f.cwd, { milestone: M }, { prefsReader, inventoryReader: () => injected });
      assert.equal('time_options' in injected, false, 'an injected inventory is not altered');
      // A preexisting roadmap refuses enrollment and keeps its legacy order.
      const pre = fixture(host, 'preexisting', { enroll: false, history: false });
      write(pre.cwd, ROADMAP, roadmapText(null));
      assert.equal(selection.enroll(pre.cwd, M, { source: 'owner', now: NOW }).status, 'refused');
      assert.equal(invoke(pre, 'next').unit.key, 'plan-slice/S01');
      // A standalone task keeps its named refusal and never reaches the owner state.
      const loose = adapter.invoke(host, 'task', 'next', { cwd: f.cwd, workflow_id: 'loose', owner_token: 'loose' }, null, { prefsReader }).result;
      assert.deepEqual([loose.reason_code, loose.controller_result], ['task-scope-unsupported', null]);
      assert.equal(selection.readSelectionState(f.cwd, 'TASK-001'), null);
    });
  }
  await test('help lists resume-time-option and orchestrate/controller codes map the S02 blocks', () => {
    let out = '';
    adapter.main(['--help'], value => { out += value; });
    assert.match(out, /resume-time-option/);
    for (const code of [...selection.TIME_OPTION_REASON_CODES, ...selection.TIME_OPTION_RESUME_CODES, ...controller.TIME_ADMISSION_CODES, 'time-option-pending']) {
      assert.ok(controller.REASON_CODES.includes(code), code); assert.ok(orchestrate.REASON_CODES.includes(code), code);
    }
    assert.ok(orchestrate.OPERATIONS.includes('resume-time-option'));
    assert.ok(require('./forge-loop-controller').COMMANDS.includes('resume-time-option'));
  });
}

main().then(() => console.log(`${passed} flow tests passed (public bridge on claude and codex; native acceptance; no provider)`))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => {
    if (savedForgeHome === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = savedForgeHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
