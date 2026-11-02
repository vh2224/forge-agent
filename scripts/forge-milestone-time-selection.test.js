#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
// Imported before anything else: loading the module must not load the controller.
const selection = require('./forge-milestone-time-selection');
const CONTROLLER_AT_IMPORT = Object.keys(require.cache).some(k => /forge-unit-controller\.js$/.test(k));
const time = require('./forge-milestone-time');
const offers = require('./forge-milestone-options');
const rt = require('./forge-milestone-roadmap-time');
const questions = require('./forge-pending-questions');
const controller = require('./forge-unit-controller');
const lease = require('./forge-unit-lease');
const channel = require('./forge-question-channel');
const { digest } = require('./forge-code-roots');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const SCRIPT = path.join(__dirname, 'forge-milestone-time-selection.js');
const M = PROPOSALS.milestone, OTHER = 'M002', NOW = Date.parse('2026-11-02T12:00:00.000Z');
const roots = [];
let passed = 0, serial = 0;

function test(name, callback) { callback(); passed++; console.log('PASS ' + name); }
function iso(value) { return new Date(value).toISOString(); }
function root() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-test-')); roots.push(cwd);
  fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true }); return cwd;
}
function write(cwd, relative, content) {
  const file = path.join(cwd, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content); return file;
}
function snapshot(cwd) {
  const result = {};
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
    result[path.relative(cwd, file)] = entry.isFile() ? [digest(fs.readFileSync(file)), stat.mtimeMs, stat.size] : 'directory';
    if (entry.isDirectory()) visit(file);
  } }
  visit(cwd); return result;
}
function stable(v) { return Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v; }
function sha(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function applyPatches(value, patches) {
  const result = structuredClone(value);
  for (const patch of patches) {
    const parent = patch.path.slice(0, -1).reduce((cursor, key) => cursor[key], result), last = patch.path.at(-1);
    if (patch.op === 'set') parent[last] = structuredClone(patch.value);
    else if (patch.op === 'delete') { if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last]; }
    else if (patch.op === 'push') parent[last].push(structuredClone(patch.value));
  }
  return result;
}
function validCase(name) { const row = PROPOSALS.valid.find(c => c.name === name); assert.ok(row, name); return applyPatches(PROPOSALS.base, row.input.patches || []); }
function docs(cwd, extra = '') { for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(cwd, `.gsd/milestones/${M}/${M}-${k}.md`, `# ${k}\nEscopo sintético${extra}\n`); }
// Controller records written through the controller's own atomic writer and read back by lookupRecord.
function transaction(cwd, key, fields) {
  const state = {}, unit = fields.unit;
  const record = { protocol_version: '1.0.0', idempotency_key: key, action: fields.action, unit, milestone: fields.milestone, host_runtime: 'codex',
    owner_digest: 'sha256:' + 'f'.repeat(64), lease_generation: 'fixture-generation', phase: fields.phase || 'committed', created_at: iso(fields.at), updated_at: iso(fields.at),
    before: { state_checksum: sha(state), state }, after: { state_checksum: sha(state), state, state_patch: {} },
    result: fields.result ? { idempotency_key: key, unit: unit.key, milestone: fields.milestone, status: fields.result } : null,
    event: { idempotency_key: key, unit: unit.key, milestone: fields.milestone, action: fields.action } };
  controller.writeAtomic(controller.transactionFile(cwd, key), record, false);
  return controller.transactionFile(cwd, key);
}
function unitOf(type, id) { return { type, id, key: type + '/' + id }; }
function commitEstimate(cwd, suffix, at, complete = true) {
  const key = selection.estimateBeginKey(M, suffix), unit = unitOf('estimate-milestone', M);
  transaction(cwd, key, { action: 'begin', unit, milestone: M, at });
  if (complete) transaction(cwd, key + ':complete', { action: 'complete', unit, milestone: M, at: at + 60000, result: 'succeeded' });
  return key;
}
function proposalFile(cwd, proposal) { return write(cwd, `.gsd/milestones/${M}/${M}-OPTIONS.json`, JSON.stringify(proposal, null, 2)); }
function enrolled(cwd = root()) {
  docs(cwd);
  const result = selection.enroll(cwd, M, { source: 'owner', now: NOW - 3600000 });
  assert.strictEqual(result.status, 'enrolled', JSON.stringify(result)); return cwd;
}
function materializeFor(cwd, proposal = structuredClone(PROPOSALS.base), opts = {}) {
  const before = selection.readSelectionState(cwd, M, opts);
  assert.strictEqual(before.status, 'estimate-required', JSON.stringify(before));
  commitEstimate(cwd, before.key_suffix, NOW - 1800000 + ++serial * 1000);
  proposalFile(cwd, proposal);
  assert.strictEqual(selection.readSelectionState(cwd, M, opts).status, 'materialization-required');
  const result = selection.prepareBoundary(cwd, M, { ...opts, now: NOW - 600000 });
  assert.strictEqual(result.status, 'materialized', JSON.stringify(result));
  return { sha: result.options_sha256, key_suffix: before.key_suffix };
}
function answer(cwd, label, opts = {}) {
  const opened = selection.nextRound({ cwd, milestone: M, ...opts });
  assert.strictEqual(opened.status, 'open', JSON.stringify(opened));
  const result = selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: label, source: opts.source || 'user-text', ...opts });
  assert.strictEqual(result.status, 'answered', JSON.stringify(result));
  return { opened, result };
}
// Live resolver fixture: the trusted host observed the operator's explicit answer to
// the exact persisted question and issues an opaque handle bound to the request.
function liveAdapter(cwd, overrides = {}) {
  const calls = [];
  return { calls, getDecisionHandle(request) {
    calls.push(request.kind);
    if (overrides.raw) return overrides.raw(request);
    const state = questions.continuation({ cwd, identity: request.question.identity_sha256 });
    const row = state.ok ? state.questions.find(q => q.id === request.question.id) : null;
    const clock = overrides.issuedAt ?? NOW, value = overrides.answer ? overrides.answer(request, row) : row && row.answer;
    const live = { reference: 'fixture-' + request.question.id, status: 'resolved', answer: value, source: 'user-text', resolved_at: iso(clock - 1000),
      question: overrides.question ? overrides.question(request) : { ...request.question } };
    return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: overrides.milestone || request.milestone, kind: request.kind,
      request_sha256: overrides.requestSha ? overrides.requestSha(request) : digest(request.request), expires_at: overrides.expires ?? clock + 60000 }, () => clock);
  } };
}
function decide(cwd, adapter = liveAdapter(cwd), extra = {}) { return selection.decide({ cwd, milestone: M, liveAdapter: adapter, now: NOW, ...extra }); }
function chooseCurta(cwd, opts = {}) { answer(cwd, 'Escolher posição', opts); answer(cwd, 'Escopo completo (curta) (Recomendado)', opts); }
function decidedCurta() {
  const cwd = enrolled(), { sha } = materializeFor(cwd); chooseCurta(cwd);
  const result = decide(cwd); assert.strictEqual(result.status, 'decided', JSON.stringify(result));
  return { cwd, sha, state: selection.readSelectionState(cwd, M) };
}
const ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
  { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
  { id: 's4', kind: 'slice', slice: 'S04', ms: 1200000, nodes: ['N4'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
  { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
function skeletonOf(block) { const match = /```json\n([\s\S]*?)\n```/.exec(block); assert.ok(match, 'skeleton present'); return JSON.parse(match[1]); }
function roadmapText(section, opts = {}) {
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [${opts.checked ? 'x' : ' '}] **S01: Contrato** \`risk:low\` \`depends:[]\`\n- [ ] **S02: Seleção** \`risk:low\` \`depends:[S01]\`\n`
    + `- [ ] **S03: Resumo** \`risk:low\` \`depends:[]\`\n- [ ] **S04: Relatório** \`risk:low\` \`depends:[S02]\`\n${opts.extraSlice || ''}\n`
    + (section === null ? '' : `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(section, null, 2)}\n\`\`\`\n`);
}
function writeRoadmap(cwd, section, opts) { return write(cwd, `.gsd/milestones/${M}/${M}-ROADMAP.md`, roadmapText(section, opts)); }
function sectionFor(cwd, overrides = {}) { return { ...skeletonOf(selection.promptBlock(cwd, M)), allocation: structuredClone(ALLOCATION), ...overrides }; }

try {
  test('exports-codes-and-inert-import-without-controller', () => {
    for (const name of ['TIME_OPTION_REASON_CODES', 'TIME_OPTION_RESUME_CODES', 'estimateKeySuffix', 'estimateBeginKey', 'readSelectionState', 'enroll', 'prepareBoundary',
      'nextRound', 'answerRound', 'decide', 'promptBlock', 'roadmapRule', 'resumeCheck', 'main']) assert.ok(selection[name] !== undefined, name);
    assert.deepStrictEqual(selection.TIME_OPTION_REASON_CODES, ['time-options-invalid', 'time-roadmap-nonconformant', 'time-allocation-pending', 'time-scope-unallocated']);
    assert.deepStrictEqual(selection.TIME_OPTION_RESUME_CODES, ['time-option-ready', 'time-option-resume-invalid']);
    for (const code of [...selection.TIME_OPTION_REASON_CODES, ...selection.TIME_OPTION_RESUME_CODES]) {
      assert.ok(!/timeout|terminated|network/.test(code) && code !== 'budget-exceeded-while-active' && code !== 'time-option-pending', code);
    }
    assert.ok(require('./forge-milestone-time-admission').TIME_REASON_CODES.includes('time-option-pending'));
    assert.strictEqual(CONTROLLER_AT_IMPORT, false, 'importing the module must not load forge-unit-controller');
    const file = require.resolve('./forge-milestone-time-selection'), Module = require('module'), previous = Module._load, localImports = [];
    Module._load = function (id, parent, ...args) { if (parent?.filename === file && id.startsWith('.')) localImports.push(id); return previous.call(this, id, parent, ...args); };
    const io = ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'lstatSync', 'mkdirSync'], saved = Object.fromEntries(io.map(k => [k, fs[k]]));
    const source = fs.readFileSync(file, 'utf8');
    try {
      for (const k of io) fs[k] = () => { throw new Error('import I/O ' + k); };
      const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths; mod._compile(source, file);
    } finally { for (const k of io) fs[k] = saved[k]; Module._load = previous; }
    assert.deepStrictEqual(localImports, [], 'local dependencies are lazy');
  });

  test('read-state-is-null-without-enrollment-never-throws-and-never-writes', () => {
    const cwd = root(), before = snapshot(cwd);
    assert.strictEqual(selection.readSelectionState(cwd, M), null);
    assert.strictEqual(selection.readSelectionState(cwd, 'T-20261102000000-x'), null);
    assert.strictEqual(selection.readSelectionState(path.join(cwd, 'ausente'), M), null);
    assert.strictEqual(selection.roadmapRule(cwd, M), null);
    assert.strictEqual(selection.prepareBoundary(cwd, M).status, 'no-op');
    assert.strictEqual(selection.promptBlock(cwd, M), 'Sem seleção de prazo: milestone sem adesão ao fluxo de opções; nenhuma seção ## Alocação de tempo é exigida.');
    assert.deepStrictEqual(snapshot(cwd), before, 'no file or directory created without enrollment');
    const broken = root(); write(broken, `.gsd/forge/time/${M}/enrollment.json`, '{"schema_version":1}\n');
    const invalid = selection.readSelectionState(broken, M);
    assert.deepStrictEqual([invalid.status, invalid.code, invalid.reason], ['options-invalid', 'time-options-invalid', 'time-enrollment-invalid']);
    assert.strictEqual(selection.resumeCheck(broken, M, { milestone: M, options_sha256: null }).reason_code, 'time-options-invalid');
  });

  test('estimate-materialization-and-decision-states-with-committed-begin-and-idempotent-render', () => {
    const cwd = enrolled(), first = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([first.status, first.previous_options_sha256, first.reason, first.enrolled_at], ['estimate-required', null, 'no-options', iso(NOW - 3600000)]);
    assert.match(first.key_suffix, /^[a-f0-9]{24}$/);
    assert.strictEqual(selection.estimateBeginKey(M, first.key_suffix), 'forge-orchestrate-next:M001:estimate-milestone/M001:' + first.key_suffix);
    assert.throws(() => selection.estimateBeginKey(M, 'curto'), e => e.code === 'time-estimate-key-invalid');
    // A begin without a committed successful complete keeps the estimate required.
    commitEstimate(cwd, first.key_suffix, NOW - 1800000, false);
    assert.strictEqual(selection.readSelectionState(cwd, M).status, 'estimate-required');
    const unit = unitOf('estimate-milestone', M), key = selection.estimateBeginKey(M, first.key_suffix);
    transaction(cwd, key + ':complete', { action: 'complete', unit, milestone: M, at: NOW - 1700000, result: 'succeeded' });
    // Complete without an accepted proposal: named invalid state, never a fabricated record.
    const missing = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([missing.status, missing.reason], ['options-invalid', 'options-proposal-missing']);
    proposalFile(cwd, { ...structuredClone(PROPOSALS.base), positions: [] });
    assert.strictEqual(selection.readSelectionState(cwd, M).reason, 'options-positions-invalid');
    proposalFile(cwd, structuredClone(PROPOSALS.base));
    const ready = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([ready.status, ready.key_suffix], ['materialization-required', first.key_suffix]);
    // A pending transaction of the SAME milestone defers the owner write without writing.
    const pending = transaction(cwd, 'fixture-pending-plan', { action: 'begin', unit: unitOf('plan-milestone', M), milestone: M, phase: 'intent', at: NOW - 1000 });
    let before = snapshot(cwd);
    assert.deepStrictEqual(selection.prepareBoundary(cwd, M, { now: NOW - 600000 }), { status: 'deferred', milestone: M, reason: 'transaction-pending' });
    assert.deepStrictEqual(snapshot(cwd), before);
    fs.unlinkSync(pending);
    const made = selection.prepareBoundary(cwd, M, { now: NOW - 600000 });
    assert.deepStrictEqual([made.status, made.render], ['materialized', 'written']);
    const stored = time.readOptions({ cwd, milestone: M, options_sha256: made.options_sha256 });
    assert.strictEqual(stored.status, 'valid');
    assert.deepStrictEqual([stored.record.producer_basis.producer, stored.record.producer_basis.frozen_at, stored.record.producer_basis.attested], ['estimate-milestone', iso(NOW - 1800000), false]);
    // The frozen producer identity is exactly the key that the committed begin used.
    assert.strictEqual(selection.estimateKeySuffix(stored.record.producer_basis.identity_sha256), first.key_suffix);
    assert.strictEqual(selection.estimateKeySuffix({ milestone: M, inputs: stored.record.inputs, previous_options_sha256: null }), first.key_suffix);
    assert.ok(stored.record.inputs.documents.some(d => d.path === `.gsd/milestones/${M}/${M}-CONTEXT.md`));
    const markdown = fs.readFileSync(path.join(cwd, `.gsd/milestones/${M}/${M}-OPTIONS.md`), 'utf8');
    assert.strictEqual(markdown, offers.renderOptionsMarkdown(stored.record));
    // Publication does not invalidate its own producer: repeated reads and boundaries are idempotent.
    before = snapshot(cwd);
    const state = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([state.status, state.options_sha256, state.round.type, state.question.opened, state.outcome], ['decision-pending', made.options_sha256, 'mode', false, null]);
    assert.deepStrictEqual(selection.prepareBoundary(cwd, M, { now: NOW }), { status: 'unchanged', milestone: M, state: 'decision-pending', render: 'unchanged' });
    selection.promptBlock(cwd, M); selection.roadmapRule(cwd, M); selection.resumeCheck(cwd, M, { milestone: M, options_sha256: made.options_sha256 });
    assert.deepStrictEqual(snapshot(cwd), before, 'readers and a repeated boundary keep bytes and mtime');
    // An unrelated append (shared events, another milestone's committed work) never re-estimates.
    write(cwd, '.gsd/forge/events.jsonl', JSON.stringify({ event: 'synthetic', milestone: OTHER }) + '\n');
    transaction(cwd, 'fixture-other-begin', { action: 'begin', unit: unitOf('plan-milestone', OTHER), milestone: OTHER, at: NOW - 500 });
    assert.strictEqual(selection.readSelectionState(cwd, M).options_sha256, made.options_sha256);
  });

  test('boundary-guard-defers-for-same-milestone-only', () => {
    const cwd = enrolled(), state = selection.readSelectionState(cwd, M);
    commitEstimate(cwd, state.key_suffix, NOW - 1800000); proposalFile(cwd, structuredClone(PROPOSALS.base));
    // Work of another milestone does not defer this one by association.
    transaction(cwd, 'fixture-other-pending', { action: 'begin', unit: unitOf('plan-milestone', OTHER), milestone: OTHER, phase: 'intent', at: NOW - 1000 });
    const otherBegin = 'fixture-other-lease';
    transaction(cwd, otherBegin, { action: 'begin', unit: unitOf('execute-task', 'T01'), milestone: OTHER, at: NOW - 1000 });
    const other = lease.acquire(cwd, 'execute-task/T01', { ownerToken: 'fixture-owner-other', requestId: otherBegin });
    assert.ok(other.ok, JSON.stringify(other));
    // Same milestone: a held lease and an open begin both defer every owner write.
    const ownBegin = 'fixture-own-lease';
    transaction(cwd, ownBegin, { action: 'begin', unit: unitOf('plan-milestone', M), milestone: M, at: NOW - 1000 });
    const own = lease.acquire(cwd, 'plan-milestone/' + M, { ownerToken: 'fixture-owner-own', requestId: ownBegin });
    let before = snapshot(cwd);
    assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW }).reason, 'lease-active');
    assert.strictEqual(selection.nextRound({ cwd, milestone: M }).reason, 'lease-active');
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: 'x', response: 'Sem contrato', source: 'user-text' }).reason, 'lease-active');
    assert.strictEqual(decide(cwd).reason, 'lease-active');
    assert.strictEqual(selection.enroll(cwd, M, { source: 'owner' }).reason, 'lease-active');
    assert.deepStrictEqual(snapshot(cwd), before);
    lease.release(cwd, 'plan-milestone/' + M, 'fixture-owner-own', own.generation);
    const events = write(cwd, `.gsd/milestones/${M}/${M}-events.jsonl`, JSON.stringify({ event: 'unit-began', action: 'begin', unit: 'plan-milestone/' + M, milestone: M,
      host_runtime: 'codex', ts: iso(NOW - 1000), idempotency_key: 'fixture-open-begin' }) + '\n');
    before = snapshot(cwd);
    assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW }).reason, 'begin-open');
    assert.deepStrictEqual(snapshot(cwd), before);
    fs.unlinkSync(events);
    assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW - 600000 }).status, 'materialized', 'another milestone\'s lease and pending work do not defer');
    lease.release(cwd, 'execute-task/T01', 'fixture-owner-other', other.generation);
  });

  test('stale-before-choice-gets-a-new-key-and-keeps-history-historical-after-choice', () => {
    const code = { files: ['src/app.js'] }, cwd = enrolled(); write(cwd, 'src/app.js', 'module.exports = 1;\n');
    const first = materializeFor(cwd, structuredClone(PROPOSALS.base), { code });
    // Relevant code change before the choice: stale, new key, the previous record preserved.
    write(cwd, 'src/app.js', 'module.exports = 2;\n');
    const stale = selection.readSelectionState(cwd, M, { code });
    assert.deepStrictEqual([stale.status, stale.reason, stale.previous_options_sha256, stale.changed], ['estimate-required', 'inputs-changed', first.sha, ['code_files:src/app.js']]);
    assert.notStrictEqual(stale.key_suffix, first.key_suffix);
    assert.strictEqual(decide(cwd, liveAdapter(cwd), { code }).reason, 'time-options-stale');
    const second = materializeFor(cwd, structuredClone(PROPOSALS.base), { code });
    assert.notStrictEqual(second.sha, first.sha);
    assert.deepStrictEqual(time.listOptions({ cwd, milestone: M }).records.map(r => r.options_sha256).sort(), [first.sha, second.sha].sort(), 'append-only history');
    assert.strictEqual(selection.readSelectionState(cwd, M, { code }).options_sha256, second.sha);
    // Document change before the choice is stale too.
    docs(cwd, ' revisado');
    const docStale = selection.readSelectionState(cwd, M, { code });
    assert.deepStrictEqual([docStale.status, docStale.previous_options_sha256], ['estimate-required', second.sha]);
    assert.ok(docStale.changed.includes(`documents:.gsd/milestones/${M}/${M}-CONTEXT.md`));
    docs(cwd);
    chooseCurta(cwd, { code }); assert.strictEqual(decide(cwd, liveAdapter(cwd), { code }).status, 'decided');
    // After the choice the sources are historical: legitimate later changes keep consent and history.
    write(cwd, 'src/app.js', 'module.exports = 3;\n'); docs(cwd, ' depois da escolha');
    const kept = selection.readSelectionState(cwd, M, { code });
    assert.deepStrictEqual([kept.status, kept.choice, kept.options_sha256], ['decided', 'option', second.sha]);
    assert.strictEqual(time.listOptions({ cwd, milestone: M }).records.length, 2);
  });

  test('rounds-persist-only-explicit-canonical-answers', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    const opened = selection.nextRound({ cwd, milestone: M });
    assert.deepStrictEqual([opened.status, opened.options_sha256, opened.question_id, opened.decision.id], ['open', sha, 'time-mode-' + sha.slice(0, 12), 'time-mode-' + sha.slice(0, 12)]);
    assert.match(opened.identity_sha256, /^[a-f0-9]{64}$/);
    assert.deepStrictEqual(opened.decision.options.map(o => o.label), ['Escolher posição', 'Teto próprio', 'Sem contrato']);
    for (const ch of ['claude-ask-user-question', 'codex-request-user-input', 'text-fallback']) assert.strictEqual(channel.normalizeDecision(opened.decision, ch).id, opened.question_id);
    const listed = questions.listPendingQuestions({ cwd, filter: { type: 'unit', id: 'milestone-time/' + opened.question_id } }).questions;
    assert.deepStrictEqual([listed.length, listed[0].status, listed[0].origin.decision_set, listed[0].origin.milestone], [1, 'pending', 'milestone-time-activation', M]);
    let before = snapshot(cwd);
    assert.deepStrictEqual(selection.nextRound({ cwd, milestone: M }), opened, 'idempotent open');
    assert.deepStrictEqual(snapshot(cwd), before, 'reopening writes nothing');
    // Missing, empty, unknown, foreign-round, foreign-milestone and bad-source answers persist nothing.
    const refusals = [[{ response: '' }, 'time-option-answer-empty'], [{ response: '   ' }, 'time-option-answer-empty'], [{ response: 'Outro' }, 'time-option-answer-invalid'],
      [{ response: 'mode:position' }, 'time-option-answer-invalid'], [{ round: 'time-position-' + sha.slice(0, 12) }, 'time-option-round-mismatch'],
      [{ round: 'time-mode-000000000000' }, 'time-option-round-mismatch'], [{ milestone: OTHER }, 'time-enrollment-required'], [{ source: 'approved' }, 'time-option-answer-source-invalid'],
      [{ source: undefined }, 'time-option-answer-source-invalid']];
    for (const [patch, reason] of refusals) {
      const result = selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Sem contrato', source: 'user-text', ...patch });
      assert.deepStrictEqual([result.status, result.reason], ['refused', reason], JSON.stringify(patch));
    }
    assert.deepStrictEqual(snapshot(cwd), before, 'refused answers write nothing');
    assert.strictEqual(selection.readSelectionState(cwd, M).round.id, opened.question_id, 'the round stays pending');
    // Partial: the explicit answer persists its canonical value; the next round is pending.
    const first = selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Escolher posição', source: 'tool-answer' });
    assert.deepStrictEqual([first.answer, first.next.status, first.next.round.type, first.next.answered_rounds], ['mode:position', 'decision-pending', 'position', 1]);
    const persisted = questions.continuation({ cwd, identity: opened.identity_sha256 });
    assert.deepStrictEqual(persisted.questions, [{ id: opened.question_id, question: opened.decision.question, status: 'resolved', answer: 'mode:position' }]);
    // Conflicting answer to the already answered round: refused, nothing written.
    before = snapshot(cwd);
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Sem contrato', source: 'user-text' }).reason, 'time-option-round-mismatch');
    const position = selection.readSelectionState(cwd, M).round;
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: position.id, response: 'Escopo completo (curta)', source: 'user-text' }).reason, 'time-option-round-not-open');
    assert.deepStrictEqual(snapshot(cwd), before);
    assert.strictEqual(decide(cwd).reason, 'time-option-pending', 'a partial decision never decides');
    answer(cwd, 'Escopo completo (curta) (Recomendado)');
    const done = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([done.status, done.round, done.outcome.choice, done.outcome.activation_answer, done.outcome.ceiling], ['decision-pending', null, 'option', 'option:curta', { source: 'offered', ceiling_ms: 16800000 }]);
    assert.deepStrictEqual(selection.nextRound({ cwd, milestone: M }), { status: 'none', milestone: M, state: 'decision-ready', options_sha256: sha });
  });

  test('decide-refuses-every-unattested-path-with-zero-writes', () => {
    const fresh = enrolled(); materializeFor(fresh);
    assert.strictEqual(decide(fresh).reason, 'time-option-pending', 'no answer: silence never decides');
    const cwd = enrolled(), { sha } = materializeFor(cwd); chooseCurta(cwd);
    assert.strictEqual(selection.readSelectionState(cwd, M).outcome.choice, 'option');
    const before = snapshot(cwd), pendingJson = JSON.parse(fs.readFileSync(path.join(cwd, '.gsd/forge/questions', fs.readdirSync(path.join(cwd, '.gsd/forge/questions')).find(n => !n.endsWith('.origin.json'))), 'utf8'));
    const cases = [
      ['no-adapter', () => selection.decide({ cwd, milestone: M, now: NOW }), 'time-decision-attestation-required'],
      ['approved-true', () => decide(cwd, liveAdapter(cwd, { raw: () => ({ approved: true }) })), 'time-decision-attestation-required'],
      ['persisted-json', () => decide(cwd, liveAdapter(cwd, { raw: () => pendingJson })), 'time-decision-attestation-required'],
      ['adapter-throws', () => decide(cwd, liveAdapter(cwd, { raw: () => { throw new Error('host closed'); } })), 'time-decision-attestation-required'],
      ['expired', () => decide(cwd, liveAdapter(cwd, { issuedAt: NOW - 120000, expires: NOW - 60000 })), 'time-decision-attestation-required'],
      ['foreign-milestone', () => decide(cwd, liveAdapter(cwd, { milestone: OTHER })), 'time-decision-scope-mismatch'],
      ['foreign-request', () => decide(cwd, liveAdapter(cwd, { requestSha: r => digest({ ...r.request, ceiling_ms: 1 }) })), 'time-decision-scope-mismatch'],
      ['divergent-answer', () => decide(cwd, liveAdapter(cwd, { answer: () => 'option:media' })), 'time-decision-answer-mismatch'],
      ['another-question', () => decide(cwd, liveAdapter(cwd, { question: r => ({ ...r.question, id: 'time-mode-' + sha.slice(0, 12) }) })), 'time-decision-scope-mismatch']];
    for (const [name, run, reason] of cases) {
      const result = run();
      assert.deepStrictEqual([result.status, result.reason], ['refused', reason], name + ': ' + JSON.stringify(result));
      assert.deepStrictEqual(snapshot(cwd), before, name + ' wrote');
    }
    // Stale options and a ROADMAP written before the choice refuse too.
    docs(cwd, ' alterado');
    assert.strictEqual(decide(cwd).reason, 'time-options-stale'); docs(cwd);
    const roadmap = writeRoadmap(cwd, null), withRoadmap = snapshot(cwd);
    assert.strictEqual(selection.readSelectionState(cwd, M).status, 'roadmap-preexisting');
    assert.strictEqual(decide(cwd).reason, 'time-options-roadmap-exists');
    assert.deepStrictEqual(snapshot(cwd), withRoadmap); fs.unlinkSync(roadmap);
    const restored = snapshot(cwd);
    // Direct T01 mutator without live handles refuses: JSON decisions never grant authority.
    const request = { milestone: M, options_sha256: sha, choice: 'no-contract' };
    assert.throws(() => time.recordSelection({ cwd, milestone: M, selection: { choice: 'no-contract', options_sha256: sha }, now: NOW }), e => e.code === 'time-decision-attestation-required');
    assert.throws(() => time.recordSelection({ cwd, milestone: M, selection: { choice: 'no-contract', options_sha256: sha, decisions: [{ kind: 'activation', decision: { approved: true } }] },
      handles: { activation: { approved: true } }, now: NOW }), e => e.code === 'time-decision-attestation-required');
    assert.throws(() => time.activateContract({ cwd, milestone: M, contract: request, now: NOW }), e => /^time-/.test(e.code));
    assert.deepStrictEqual([time.readSelection({ cwd, milestone: M }).status, time.readContract({ cwd, milestone: M }).status], ['absent', 'absent']);
    assert.deepStrictEqual(snapshot(cwd), restored);
  });

  test('offered-position-decides-records-selection-and-activates-the-same-request', () => {
    const { cwd, sha, state } = decidedCurta(), contract = time.readContract({ cwd, milestone: M });
    assert.deepStrictEqual([state.status, state.choice, state.option_id, state.position_id, state.contract.version], ['decided', 'option', 'curta', 'curta', 1]);
    assert.deepStrictEqual([contract.contract.option, contract.contract.ceiling_ms, contract.contract.preselection_started_at, contract.contract.activated_at, contract.contract.decision.answer],
      [{ id: 'curta', options_sha256: sha, label: 'Escopo completo', position_id: 'curta' }, 16800000, iso(NOW - 3600000), iso(NOW), 'option:curta']);
    assert.deepStrictEqual([contract.contract.allocation, contract.contract.linked_task, contract.contract.chain_forecast], [null, null, null]);
    assert.deepStrictEqual(contract.contract.endpoint, PROPOSALS.base.endpoint, 'endpoint items of the proposal');
    const stored = time.readSelection({ cwd, milestone: M }).selection;
    assert.deepStrictEqual(stored.contract_request, Object.fromEntries(Object.entries(contract.contract).filter(([k]) => k !== 'decision')));
    assert.deepStrictEqual(stored.rounds.map(r => r.answer), ['mode:position', 'option:curta']);
    const before = snapshot(cwd), again = decide(cwd);
    assert.deepStrictEqual([again.status, again.unchanged, again.contract_sha256], ['decided', true, contract.sha256]);
    assert.deepStrictEqual(snapshot(cwd), before, 'a repeated decide duplicates nothing');
    assert.deepStrictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: sha }), { ok: true, reason_code: 'time-option-ready', milestone: M, options_sha256: sha, status: 'decided' });
  });

  test('operator-ceiling-keeps-the-chosen-strategy-and-no-viable-position-never-gets-a-cap', () => {
    const cwd = enrolled(); materializeFor(cwd);
    answer(cwd, 'Teto próprio');
    const strategy = selection.readSelectionState(cwd, M).round;
    assert.strictEqual(strategy.type, 'strategy');
    answer(cwd, 'Escopo completo (curta)');
    const ceiling = selection.nextRound({ cwd, milestone: M });
    assert.deepStrictEqual([ceiling.decision.free_text, ceiling.decision.position_id, ceiling.decision.minimum_ms, ceiling.decision.options], [true, 'curta', 16800000, []]);
    // A ceiling too low for the defensible range is incompatible: it never reduces work.
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: ceiling.question_id, response: '1h', source: 'user-text' }).reason, 'time-option-answer-invalid');
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: ceiling.question_id, response: '6h', source: 'user-text' }).answer, 'operator-ceiling:21600000');
    const result = decide(cwd); assert.strictEqual(result.status, 'decided', JSON.stringify(result));
    const contract = time.readContract({ cwd, milestone: M }).contract;
    assert.deepStrictEqual([contract.ceiling_ms, contract.option.position_id, contract.decision.answer], [21600000, 'curta', 'operator-ceiling:21600000']);
    assert.match(selection.promptBlock(cwd, M), /tipo: teto do operador; posição curta/);
    // No viable position: only re-estimate or no contract; a ceiling alone never makes one viable.
    const none = enrolled(), nsha = materializeFor(none, validCase('nenhuma-viavel')).sha, mode = selection.nextRound({ cwd: none, milestone: M });
    assert.deepStrictEqual(mode.decision.options.map(o => o.label), ['Reestimar', 'Sem contrato']);
    assert.strictEqual(selection.answerRound({ cwd: none, milestone: M, round: mode.question_id, response: 'Teto próprio', source: 'user-text' }).reason, 'time-option-answer-invalid');
    selection.answerRound({ cwd: none, milestone: M, round: mode.question_id, response: 'Reestimar', source: 'user-text' });
    const again = selection.readSelectionState(none, M);
    assert.deepStrictEqual([again.status, again.reason, again.previous_options_sha256], ['estimate-required', 're-estimate-requested', nsha]);
    assert.strictEqual(decide(none).reason, 'time-options-stale');
    assert.strictEqual(selection.roadmapRule(none, M).expected.precondition, 'selection-required');
  });

  test('linked-task-authorization-and-declined-task-never-drops-moved-scope', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    answer(cwd, 'Escolher posição'); answer(cwd, 'Com task ligada (media)');
    const linked = selection.nextRound({ cwd, milestone: M });
    assert.deepStrictEqual([linked.round.type, linked.round.decision_set, linked.round.scope.moved_scope], ['linked', 'milestone-time-linked-task', ['SC4']]);
    selection.answerRound({ cwd, milestone: M, round: linked.question_id, response: 'Criar sem iniciar', source: 'user-text' });
    const adapter = liveAdapter(cwd), result = decide(cwd, adapter);
    assert.strictEqual(result.status, 'decided', JSON.stringify(result)); assert.deepStrictEqual(adapter.calls, ['activation', 'linked-task']);
    const contract = time.readContract({ cwd, milestone: M }).contract;
    assert.deepStrictEqual([contract.option, contract.linked_task.authorization, contract.linked_task.moved_scope, contract.chain_forecast],
      [{ id: 'media', options_sha256: sha, label: 'Com task ligada' }, 'create-without-auto-start', ['SC4'], { low_ms: 6600000, high_ms: 14400000, basis: 'milestone-plus-linked-task' }]);
    const block = selection.promptBlock(cwd, M);
    assert.match(block, /Task ligada: autorização create-without-auto-start; escopo movido SC4 \(nós N4\)/);
    assert.match(block, /Critérios da task: Relatório SC4 verificado/); assert.match(block, /Adiamentos consentidos: SC3/);
    assert.deepStrictEqual(skeletonOf(block).linked_task, { moved_scope: ['N4'] });
    // Declining the task keeps the moved scope: scope round, decide refused, plan-milestone blocked.
    const declined = enrolled(); materializeFor(declined);
    answer(declined, 'Escolher posição'); answer(declined, 'Com task ligada (media)'); answer(declined, 'Não criar task');
    const scope = selection.readSelectionState(declined, M);
    assert.deepStrictEqual([scope.round.type, scope.round.options.map(o => o.answer)], ['scope', ['re-estimate', 'reduce-scope:SC4', 'no-contract']]);
    assert.strictEqual(decide(declined).reason, 'time-option-pending');
    assert.deepStrictEqual(selection.roadmapRule(declined, M).expected, { status: 'pending', precondition: 'selection-required' });
    answer(declined, 'Consentir na redução');
    const reduced = selection.readSelectionState(declined, M);
    assert.deepStrictEqual([reduced.status, reduced.reason, reduced.scope_reduction], ['estimate-required', 're-estimate-requested', { scope_items: ['SC4'], consent: 'explicit' }]);
    assert.deepStrictEqual([time.readSelection({ cwd: declined, milestone: M }).status, time.readContract({ cwd: declined, milestone: M }).status], ['absent', 'absent']);
  });

  test('no-contract-is-an-attested-functional-choice-without-contract', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    answer(cwd, 'Sem contrato');
    const result = decide(cwd); assert.deepStrictEqual([result.status, result.choice, result.contract_sha256], ['decided', 'no-contract', null]);
    const stored = time.readSelection({ cwd, milestone: M }).selection;
    assert.deepStrictEqual([stored.choice, stored.decisions[0].decision.answer, stored.decisions[0].kind], ['no-contract', 'no-contract', 'activation']);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.strictEqual(selection.roadmapRule(cwd, M), null);
    assert.match(selection.promptBlock(cwd, M), /^Decisão explícita do operador: seguir sem contrato de tempo/);
    assert.strictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: sha }).reason_code, 'time-option-ready');
    // A no-contract decision never satisfies activateContract.
    const request = { milestone: M, options_sha256: sha, choice: 'no-contract' };
    const handle = liveAdapter(cwd).getDecisionHandle({ milestone: M, kind: 'activation', request, question: stored.decisions[0].decision.question });
    assert.throws(() => time.activateContract({ cwd, milestone: M, contract: request, handle, now: NOW }), e => /^time-/.test(e.code));
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    // A selection file whose persisted answers do not exist never looks decided.
    const forged = root(); docs(forged); selection.enroll(forged, M, { source: 'owner', now: NOW - 3600000 });
    const p = time.timePaths({ cwd: forged, milestone: M });
    fs.mkdirSync(path.join(p.directory, 'options'), { recursive: true });
    fs.copyFileSync(path.join(time.timePaths({ cwd, milestone: M }).directory, 'options', sha + '.json'), path.join(p.directory, 'options', sha + '.json'));
    fs.copyFileSync(time.timePaths({ cwd, milestone: M }).selection, p.selection);
    const forgedState = selection.readSelectionState(forged, M);
    assert.deepStrictEqual([forgedState.status, forgedState.reason], ['options-invalid', 'time-selection-unverified']);
    assert.deepStrictEqual(selection.roadmapRule(forged, M).expected, { status: 'invalid', reason: 'roadmap-time-options-invalid' });
  });

  test('crash-between-selection-and-activation-resumes-the-same-request', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd); chooseCurta(cwd);
    const crashed = decide(cwd, liveAdapter(cwd), { failpoint: name => name === 'after-selection' });
    assert.deepStrictEqual([crashed.status, crashed.reason], ['refused', 'time-selection-failpoint']);
    const pending = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([pending.status, pending.option_id], ['activation-pending', 'curta']);
    assert.deepStrictEqual(selection.roadmapRule(cwd, M).expected, { status: 'pending', precondition: 'activation-required' });
    assert.match(selection.promptBlock(cwd, M), /pendente \(activation-pending\)/);
    assert.strictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: sha }).reason_code, 'time-option-pending');
    const selectionBytes = fs.readFileSync(time.timePaths({ cwd, milestone: M }).selection), before = snapshot(cwd);
    // Divergent or missing authority leaves it pending without writing; silence is not consent.
    assert.strictEqual(decide(cwd, liveAdapter(cwd, { answer: () => 'option:media' })).reason, 'time-decision-answer-mismatch');
    assert.strictEqual(decide(cwd, liveAdapter(cwd, { raw: () => ({ approved: true }) })).reason, 'time-decision-attestation-required');
    assert.deepStrictEqual(snapshot(cwd), before);
    const resumed = decide(cwd, liveAdapter(cwd, { issuedAt: NOW + 5000 }), { now: NOW + 10000 });
    assert.deepStrictEqual([resumed.status, resumed.resumed], ['decided', true], JSON.stringify(resumed));
    assert.ok(fs.readFileSync(time.timePaths({ cwd, milestone: M }).selection).equals(selectionBytes), 'selection unchanged: no duplicate decision');
    const contract = time.readContract({ cwd, milestone: M });
    assert.deepStrictEqual([contract.status, contract.contract.activated_at, contract.contract.ceiling_ms], ['valid', iso(NOW), 16800000], 'the persisted contract_request is used');
    assert.strictEqual(selection.readSelectionState(cwd, M).status, 'decided');
  });

  test('prompt-block-variants-are-bounded-sanitized-and-carry-the-exact-skeleton', () => {
    const pendingRoot = enrolled();
    assert.match(selection.promptBlock(pendingRoot, M), /^Seleção de prazo pendente \(estimate-required\)/);
    const { cwd, sha, state } = decidedCurta(), block = selection.promptBlock(cwd, M);
    assert.ok(Buffer.byteLength(block) <= 8192, 'bounded to 8 KiB');
    assert.ok(!/DATA FROM|\[\s*END\s+DATA|forge-procedure/i.test(block), 'no markers');
    for (const p of [cwd, cwd.replace(/\\/g, '/'), os.tmpdir()]) assert.ok(!block.includes(p), 'no absolute path');
    for (const piece of ['Opção: curta — Escopo completo (tipo: posição oferecida; posição curta)', 'Contrato base: ' + state.contract.base_sha256,
      'contrato atual: ' + state.contract.sha256, 'Teto: 4 h 40 min (16800000 ms)', 'Faixa da milestone: 2 h 10 min a 4 h 40 min; confiança baixa',
      'Marco final: Publicação: pendente; Instalação: não se aplica; UAT manual: incluído; Esperas externas: adiado', 'Divisão preliminar:', 'PREP [preparação] Preparação da milestone; depende de nada.',
      'INT [integração] Integração; depende de N2, N3, N4.', 'Adiamentos consentidos: nenhum.']) assert.ok(block.includes(piece), piece);
    const skeleton = skeletonOf(block), rule = selection.roadmapRule(cwd, M);
    assert.deepStrictEqual([skeleton.option_id, skeleton.position_id, skeleton.options_sha256, skeleton.contract_sha256, skeleton.allocation], ['curta', 'curta', sha, state.contract.base_sha256, []]);
    assert.deepStrictEqual([skeleton.dependencies, skeleton.deferred, skeleton.linked_task], [rule.expected.edges, rule.expected.deferred, rule.expected.linked_task]);
    // Filling only allocation in the exact skeleton yields a conformant roadmap.
    const text = roadmapText({ ...skeleton, allocation: structuredClone(ALLOCATION) });
    assert.deepStrictEqual([rt.validateRoadmapContent(text, rule.expected).status, rt.validateRoadmapContent(text, rule.expected).total_ms], ['conformant', 7800000]);
  });

  test('roadmap-rule-preconditions-conformance-delegated-allocation-and-structural-change', () => {
    // Enrolled without proposal, with proposal and no answer, stale: unsatisfied preconditions refuse an early ROADMAP.
    const early = enrolled(), text = roadmapText(null);
    assert.deepStrictEqual(selection.roadmapRule(early, M), { kind: 'milestone-roadmap-time', milestone: M, expected: { status: 'pending', precondition: 'options-required' } });
    materializeFor(early);
    assert.deepStrictEqual(selection.roadmapRule(early, M).expected, { status: 'pending', precondition: 'selection-required' });
    assert.deepStrictEqual([rt.validateRoadmapContent(text, selection.roadmapRule(early, M).expected).reason], ['roadmap-time-preparation-pending']);
    docs(early, ' alterado');
    assert.strictEqual(selection.readSelectionState(early, M).status, 'estimate-required');
    assert.deepStrictEqual(selection.roadmapRule(early, M).expected, { status: 'pending', precondition: 'selection-required' });
    // The physical owner is contextRoot even when cwd is a CODE_DIR without .gsd.
    const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-code-')); roots.push(codeDir);
    assert.strictEqual(selection.roadmapRule(codeDir, M), null, 'CODE_DIR alone has no enrollment');
    assert.deepStrictEqual(selection.roadmapRule({ cwd: codeDir, contextRoot: early }, M).expected.precondition, 'selection-required');
    assert.match(selection.promptBlock({ cwd: codeDir, contextRoot: early }, M), /pendente/);
    // Contract: real expected; each refusal and the acceptance.
    const { cwd, state } = decidedCurta(), rule = selection.roadmapRule(cwd, M);
    assert.deepStrictEqual([rule.kind, rule.expected.status, rule.expected.contract_sha256, rule.expected.ceiling_ms], ['milestone-roadmap-time', 'ready', state.contract.base_sha256, 16800000]);
    const status = () => selection.readSelectionState(cwd, M).roadmap;
    const refusals = [[null, {}, 'roadmap-time-section-missing'], [sectionFor(cwd, { position_id: 'media' }), {}, 'roadmap-time-strategy-mismatch'],
      [sectionFor(cwd, { contract_sha256: 'a'.repeat(64) }), {}, 'roadmap-time-contract-mismatch'],
      [sectionFor(cwd, { allocation: ALLOCATION.map(r => r.id === 's1' ? { ...r, ms: 20000000 } : r) }), {}, 'roadmap-time-ceiling-exceeded'],
      [sectionFor(cwd, { allocation: ALLOCATION.filter(r => r.id !== 'rev') }), {}, 'roadmap-time-node-missing'],
      [sectionFor(cwd), { extraSlice: '- [ ] **S05: Extra** `risk:low` `depends:[S04]`\n' }, 'roadmap-time-slice-unallocated']];
    for (const [section, opts, reason] of refusals) {
      writeRoadmap(cwd, section, opts);
      assert.deepStrictEqual(status(), { status: 'nonconformant', reasons: [reason], ...(status().detail ? { detail: status().detail } : {}) }, reason);
      const before = snapshot(cwd);
      assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW }).status, 'unchanged');
      assert.deepStrictEqual(snapshot(cwd), before, 'nonconformant roadmap: no allocation written');
    }
    writeRoadmap(cwd, sectionFor(cwd));
    assert.strictEqual(status().status, 'allocation-pending');
    const allocated = selection.prepareBoundary(cwd, M, { now: NOW });
    assert.deepStrictEqual([allocated.status, allocated.version], ['allocated', 2], JSON.stringify(allocated));
    let contract = time.readContract({ cwd, milestone: M });
    assert.deepStrictEqual([contract.chain[1].kind, contract.chain[1].delegation.basis, contract.chain[1].delegation.contract_sha256], ['allocation', 'activation-delegation', state.contract.base_sha256]);
    assert.deepStrictEqual([status().status, status().total_ms], ['conformant', 7800000]);
    // The section always names the BASE contract; the current hash is only diagnostic.
    assert.notStrictEqual(contract.sha256, state.contract.base_sha256);
    assert.match(selection.promptBlock(cwd, M), new RegExp('contrato atual: ' + contract.sha256));
    // A marked checkbox keeps conformance and writes nothing.
    writeRoadmap(cwd, sectionFor(cwd), { checked: true });
    let before = snapshot(cwd);
    assert.strictEqual(status().status, 'conformant');
    assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW }).status, 'unchanged');
    assert.deepStrictEqual(snapshot(cwd), before);
    // Technical reallocation within the delegation (below the initial range, no floor): append-only amendment, no question.
    const pendingQuestions = fs.readdirSync(path.join(cwd, '.gsd/forge/questions')).length;
    writeRoadmap(cwd, sectionFor(cwd, { allocation: ALLOCATION.map(r => r.id === 's1' ? { ...r, ms: 300000 } : r) }), { checked: true });
    assert.strictEqual(status().status, 'allocation-pending');
    assert.strictEqual(selection.prepareBoundary(cwd, M, { now: NOW }).version, 3);
    contract = time.readContract({ cwd, milestone: M });
    assert.deepStrictEqual([contract.chain.length, contract.chain[1].kind, contract.chain[2].kind, contract.contract.allocation.items[1].ms], [3, 'allocation', 'allocation', 300000]);
    assert.strictEqual(fs.readdirSync(path.join(cwd, '.gsd/forge/questions')).length, pendingQuestions, 'no new question');
    assert.strictEqual(status().status, 'conformant');
    // A later structural change is visible as unallocated scope and is never auto-allocated.
    writeRoadmap(cwd, sectionFor(cwd, { allocation: ALLOCATION.map(r => r.id === 's1' ? { ...r, ms: 300000 } : r) }), { extraSlice: '- [ ] **S05: Extra** `risk:low` `depends:[S04]`\n' });
    assert.deepStrictEqual([status().status, status().reasons], ['scope-unallocated', ['roadmap-time-slice-unallocated']]);
    before = snapshot(cwd);
    assert.deepStrictEqual(selection.prepareBoundary(cwd, M, { now: NOW }), { status: 'unchanged', milestone: M, state: 'decided', roadmap: 'scope-unallocated' });
    assert.deepStrictEqual(snapshot(cwd), before);
    // Reading the rule, state and block never writes.
    selection.roadmapRule(cwd, M); selection.readSelectionState(cwd, M); selection.promptBlock(cwd, M);
    assert.deepStrictEqual(snapshot(cwd), before);
    // A ROADMAP over an enrolled milestone without selection is preexisting and does not block, but still refuses acceptance.
    const preexisting = enrolled(); writeRoadmap(preexisting, null);
    assert.strictEqual(selection.readSelectionState(preexisting, M).status, 'roadmap-preexisting');
    assert.strictEqual(selection.roadmapRule(preexisting, M).expected.precondition, 'options-required');
    assert.strictEqual(selection.prepareBoundary(preexisting, M, { now: NOW }).status, 'unchanged');
  });

  test('resume-check-codes', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    for (const block of [null, undefined, {}, { milestone: OTHER, options_sha256: sha }, { milestone: M, options_sha256: 'x' }, { milestone: M, options_sha256: sha, approved: true }]) {
      assert.strictEqual(selection.resumeCheck(cwd, M, block).reason_code, 'time-option-resume-invalid', JSON.stringify(block));
    }
    assert.deepStrictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: sha }), { ok: false, reason_code: 'time-option-pending', milestone: M, options_sha256: sha, status: 'decision-pending' });
    assert.strictEqual(selection.resumeCheck(root(), M, { milestone: M, options_sha256: null }).reason_code, 'time-option-resume-invalid');
    chooseCurta(cwd); decide(cwd);
    assert.strictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: null }).reason_code, 'time-option-ready');
    assert.strictEqual(selection.resumeCheck(cwd, M, { milestone: M, options_sha256: 'b'.repeat(64) }).reason_code, 'time-option-pending');
  });

  test('cli-by-process-exec-path-with-exit-codes-and-embedded-decide', () => {
    const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
    const cwd = root(); docs(cwd);
    const absolute = [cwd, cwd.replace(/\\/g, '/'), os.tmpdir()], at = ['--cwd', cwd, '--milestone', M];
    const checkPaths = result => { for (const p of absolute) assert.ok(!result.stdout.includes(p) && !result.stderr.includes(p), 'absolute path in output'); };
    let result = run(['--status', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout)], [0, { status: 'ok', state: null }]);
    assert.match(run(['--status', ...at], cwd).stdout, /^Milestone sem adesão/);
    result = run(['--enroll', '--source', 'owner', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout).status], [0, 'enrolled']);
    assert.strictEqual(run(['--enroll', '--source', 'desconhecida', ...at, '--json'], cwd).status, 3);
    materializeFor(cwd);
    result = run(['--round', ...at, '--json'], cwd); checkPaths(result);
    const opened = JSON.parse(result.stdout);
    assert.deepStrictEqual([result.status, opened.status], [0, 'open']);
    assert.match(run(['--round', ...at], cwd).stdout, /^Decisão time-mode-[a-f0-9]{12}: /);
    result = run(['--answer', '--round', opened.question_id, '--response', '', '--source', 'user-text', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout).reason], [3, 'time-option-answer-empty']);
    // Standalone --decide never decides and writes nothing.
    let before = snapshot(cwd);
    result = run(['--decide', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout)], [3, { status: 'refused', milestone: M, reason: 'time-decision-attestation-required' }]);
    assert.match(run(['--decide', ...at], cwd).stdout, /^Operação recusada: time-decision-attestation-required/);
    assert.deepStrictEqual(snapshot(cwd), before);
    result = run(['--answer', '--round', opened.question_id, '--response', 'Sem contrato', '--source', 'user-text', ...at], cwd);
    assert.deepStrictEqual([result.status, result.stdout], [0, 'Resposta registrada: no-contract.\n']);
    result = run(['--conformance', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout).rule.expected], [3, { status: 'pending', precondition: 'selection-required' }]);
    result = run(['--prompt-block', ...at], cwd); checkPaths(result);
    assert.deepStrictEqual([result.status, /^Seleção de prazo pendente \(decision-pending\)/.test(result.stdout)], [0, true]);
    for (const args of [['--status'], ['--bogus', ...at], [...at], ['--answer', ...at], ['--status', '--source', 'owner', ...at], ['--status', '--decide', ...at], ['--enroll', ...at]]) {
      result = run([...args, '--json'], cwd);
      assert.deepStrictEqual([result.status, JSON.parse(result.stdout).reason], [2, 'time-usage'], args.join(' '));
    }
    assert.match(run(['--bogus'], cwd).stdout, /^Uso: /);
    // Embedded main with the trusted host's live adapter (real clock for the live handle).
    const out = []; const io = { stdout: { write: s => out.push(s) } }, clock = Date.now();
    const status = selection.main(['--decide', ...at, '--json'], io, liveAdapter(cwd, { issuedAt: clock }));
    assert.deepStrictEqual([status, JSON.parse(out[0]).status, JSON.parse(out[0]).choice], [0, 'decided', 'no-contract'], out.join(''));
    result = run(['--conformance', ...at, '--json'], cwd);
    assert.deepStrictEqual([result.status, JSON.parse(result.stdout).rule], [0, null]);
    before = snapshot(cwd);
    run(['--status', ...at, '--json'], cwd); run(['--prompt-block', ...at], cwd); run(['--conformance', ...at], cwd);
    assert.deepStrictEqual(snapshot(cwd), before, 'read-only CLI actions write nothing');
  });

  // Real controller.begin through the controller's own API; the unit is attributed to the milestone it names.
  function realBegin(cwd, milestone, key) {
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
    require('./forge-state').write(cwd, { milestone, kind: 'milestone', phase: 'execute-task', active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
    return controller.begin(cwd, { milestone, slice: 'S01', unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'fixture-' + key, idempotency_key: key },
      { now: () => NOW, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }] }) });
  }
  function forbiddenWrites(cwd) {
    return [time.readSelection({ cwd, milestone: M }).status, time.readContract({ cwd, milestone: M }).status];
  }
  // The code option is read inside the guarded region: its getter runs a callback exactly once at that point.
  function trap(callback) {
    const seen = { calls: 0 };
    return { seen, code: { get files() { if (!seen.calls++) callback(seen); return []; } } };
  }

  test('writers-recheck-the-same-milestone-inside-the-controller-transaction-boundary', () => {
    // decide: a real same-milestone begin commits inside the live handle callback, after the early check.
    const cwd = enrolled(); materializeFor(cwd); chooseCurta(cwd);
    const adapter = liveAdapter(cwd), original = adapter.getDecisionHandle; let began = null;
    adapter.getDecisionHandle = request => { if (!began) began = realBegin(cwd, M, 'interposed-begin'); return original(request); };
    const questionsBefore = fs.readdirSync(path.join(cwd, '.gsd/forge/questions')).sort();
    const result = decide(cwd, adapter);
    assert.ok(began && began.ok, 'the adversary begin is real and committed: ' + JSON.stringify(began));
    assert.strictEqual(controller.lookupRecord(cwd, 'transaction', 'interposed-begin').phase, 'committed');
    assert.strictEqual(result.status, 'deferred', JSON.stringify(result));
    assert.match(result.reason, /^(begin-open|lease-active|transaction-pending)$/);
    assert.deepStrictEqual(forbiddenWrites(cwd), ['absent', 'absent'], 'no selection or contract after the interposed begin');
    assert.deepStrictEqual(fs.readdirSync(path.join(cwd, '.gsd/forge/questions')).sort(), questionsBefore, 'no question written');
    assert.ok(controller.lookupRecord(cwd, 'transaction', 'interposed-begin'), 'the legitimate begin evidence remains');
    // Work of another milestone interposed in the same place never defers this one.
    const other = enrolled(); materializeFor(other); chooseCurta(other);
    const adapter2 = liveAdapter(other), original2 = adapter2.getDecisionHandle; let otherBegin = null;
    adapter2.getDecisionHandle = request => { if (!otherBegin) otherBegin = realBegin(other, OTHER, 'other-milestone-begin'); return original2(request); };
    const progressed = decide(other, adapter2);
    assert.ok(otherBegin && otherBegin.ok, JSON.stringify(otherBegin));
    assert.deepStrictEqual([progressed.status, progressed.choice], ['decided', 'option'], JSON.stringify(progressed));
    // Publication boundaries: the controller transaction mutex is held while owner writes happen, so no begin can commit in between.
    const lock = require('./forge-lock'), held = c => { const h = lock.tryAcquireSync(c, 'unit-controller-transactions', {}); if (h) h.release(); return !h; };
    const prepare = enrolled(), state = selection.readSelectionState(prepare, M);
    commitEstimate(prepare, state.key_suffix, NOW - 1800000); proposalFile(prepare, structuredClone(PROPOSALS.base));
    const materialize = trap(seen => { seen.mutexHeld = held(prepare); seen.error = null; try { seen.began = realBegin(prepare, M, 'during-materialize'); } catch (e) { seen.error = e.code; } });
    const made = selection.prepareBoundary(prepare, M, { now: NOW - 600000, code: materialize.code });
    assert.strictEqual(made.status, 'materialized', JSON.stringify(made));
    assert.deepStrictEqual([materialize.seen.mutexHeld, materialize.seen.error, materialize.seen.began], [true, 'LOCK_BUSY', undefined], 'a real begin cannot commit inside the publication');
    assert.strictEqual(controller.lookupRecord(prepare, 'transaction', 'during-materialize'), null);
    const round = trap(seen => { seen.mutexHeld = held(prepare); });
    assert.strictEqual(selection.nextRound({ cwd: prepare, milestone: M, code: round.code }).status, 'open');
    assert.strictEqual(round.seen.mutexHeld, true, 'nextRound publishes inside the boundary');
    const reply = trap(seen => { seen.mutexHeld = held(prepare); });
    const opened = selection.nextRound({ cwd: prepare, milestone: M });
    assert.strictEqual(selection.answerRound({ cwd: prepare, milestone: M, round: opened.question_id, response: 'Sem contrato', source: 'user-text', code: reply.code }).status, 'answered');
    assert.strictEqual(reply.seen.mutexHeld, true, 'answerRound publishes inside the boundary');
    assert.strictEqual(held(prepare), false, 'the boundary is released afterwards');
    // A begin that committed before the boundary defers every writer without writing.
    const busy = enrolled(); materializeFor(busy);
    realBegin(busy, M, 'committed-before');
    const before = snapshot(busy);
    assert.strictEqual(selection.nextRound({ cwd: busy, milestone: M }).status, 'deferred');
    assert.strictEqual(selection.prepareBoundary(busy, M, { now: NOW }).status, 'deferred');
    assert.deepStrictEqual(snapshot(busy), before);
  });

  test('declined-task-then-scope-no-contract-completes-with-its-own-activation-round', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    answer(cwd, 'Escolher posição'); answer(cwd, 'Com task ligada (media)'); answer(cwd, 'Não criar task');
    const scope = selection.readSelectionState(cwd, M).round;
    answer(cwd, 'Sem contrato');
    // The linked-set answer stays intent/history: an activation decision is still required.
    const pending = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([pending.status, pending.round.type, pending.round.decision_set, pending.outcome], ['decision-pending', 'confirm', 'milestone-time-activation', null]);
    assert.strictEqual(decide(cwd).reason, 'time-option-pending');
    assert.deepStrictEqual(selection.roadmapRule(cwd, M).expected, { status: 'pending', precondition: 'selection-required' });
    const opened = selection.nextRound({ cwd, milestone: M });
    assert.deepStrictEqual([opened.status, opened.question_id, opened.decision.options.map(o => o.label)], ['open', 'time-confirm-' + sha.slice(0, 12), ['Confirmar sem contrato', 'Reestimar']]);
    // The ACTUAL returned confirmation is accepted and presented by every supported canonical channel.
    for (const ch of channel.CHANNELS.filter(c => c !== 'worker-partial')) {
      const normalized = channel.normalizeDecision(opened.decision, ch), presented = channel.presentDecision(opened.decision, ch);
      assert.deepStrictEqual([normalized.id, normalized.options.map(o => o.label), presented.channel], [opened.question_id, ['Confirmar sem contrato', 'Reestimar'], ch], ch);
    }
    assert.match(channel.presentDecision(opened.decision, 'text-fallback').message, /1\. Confirmar sem contrato: [\s\S]*2\. Reestimar: /);
    // Wrong, foreign and empty answers never persist; the scope answer is not reinterpreted.
    const before = snapshot(cwd);
    for (const [patch, reason] of [[{ response: '' }, 'time-option-answer-empty'], [{ response: 'Talvez' }, 'time-option-answer-invalid'], [{ round: scope.id }, 'time-option-round-mismatch'], [{ milestone: OTHER }, 'time-enrollment-required']]) {
      const refusal = selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Confirmar sem contrato', source: 'user-text', ...patch });
      assert.deepStrictEqual([refusal.status, refusal.reason], ['refused', reason], JSON.stringify(patch));
    }
    assert.deepStrictEqual(snapshot(cwd), before);
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Confirmar sem contrato', source: 'user-text' }).answer, 'no-contract');
    assert.strictEqual(selection.answerRound({ cwd, milestone: M, round: opened.question_id, response: 'Confirmar sem contrato', source: 'user-text' }).reason, 'time-option-round-mismatch');
    const ready = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([ready.status, ready.round, ready.outcome.choice, ready.outcome.activation_answer], ['decision-pending', null, 'no-contract', 'no-contract']);
    assert.deepStrictEqual(selection.nextRound({ cwd, milestone: M }), { status: 'none', milestone: M, state: 'decision-ready', options_sha256: sha });
    // Missing, foreign, expired and linked-round handles refuse without writes.
    const readyBytes = snapshot(cwd);
    assert.strictEqual(selection.readSelectionState(cwd, M).answered_rounds, 5);
    for (const [name, adapter, reason] of [
      ['missing', { getDecisionHandle: () => undefined }, 'time-decision-attestation-required'],
      ['foreign', liveAdapter(cwd, { milestone: OTHER }), 'time-decision-scope-mismatch'],
      ['expired', liveAdapter(cwd, { issuedAt: NOW - 120000, expires: NOW - 60000 }), 'time-decision-attestation-required'],
      ['linked-round-handle', liveAdapter(cwd, { question: r => ({ ...r.question, id: scope.id, identity_sha256: opened.identity_sha256.replace(/^./, c => c === 'a' ? 'b' : 'a') }) }), 'time-decision-scope-mismatch'],
      ['conflicting-answer', liveAdapter(cwd, { answer: () => 'linked-task:none' }), 'time-decision-answer-mismatch']]) {
      const refusal = decide(cwd, adapter);
      assert.deepStrictEqual([refusal.status, refusal.reason], ['refused', reason], name + ': ' + JSON.stringify(refusal));
      assert.deepStrictEqual(snapshot(cwd), readyBytes, name + ' wrote');
    }
    const adapter = liveAdapter(cwd), result = decide(cwd, adapter);
    assert.deepStrictEqual([result.status, result.choice, result.contract_sha256, adapter.calls], ['decided', 'no-contract', null, ['activation']], JSON.stringify(result));
    const stored = time.readSelection({ cwd, milestone: M }).selection;
    assert.deepStrictEqual([stored.choice, stored.decisions[0].kind, stored.decisions[0].decision.question.id, stored.decisions[0].decision.answer], ['no-contract', 'activation', opened.question_id, 'no-contract']);
    assert.ok(stored.rounds.some(r => r.round_id === scope.id && r.decision_set === 'milestone-time-linked-task' && r.answer === 'no-contract'), 'the scope answer is preserved as history');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    // Restart/repeated reads: decided/no-contract, nothing stranded, bytes and mtime unchanged.
    const settled = snapshot(cwd), first = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([first.status, first.choice, first.contract], ['decided', 'no-contract', null]);
    assert.deepStrictEqual(selection.readSelectionState(cwd, M), first);
    assert.deepStrictEqual(selection.nextRound({ cwd, milestone: M }), { status: 'none', milestone: M, state: 'decided' });
    assert.deepStrictEqual([selection.decide({ cwd, milestone: M, now: NOW }).reason, decide(cwd, liveAdapter(cwd)).unchanged], ['time-decision-attestation-required', true]);
    assert.strictEqual(selection.roadmapRule(cwd, M), null);
    assert.deepStrictEqual(snapshot(cwd), settled);
  });

  test('re-estimation-outcome-keeps-position-reason-authorization-and-decisions', () => {
    const outcomeOf = (cwd, sha) => {
      const state = selection.readSelectionState(cwd, M);
      assert.deepStrictEqual([state.status, state.reason, state.previous_options_sha256, state.re_estimate.options_sha256], ['estimate-required', 're-estimate-requested', sha, sha]);
      return state;
    };
    const readOnly = (cwd, state) => {
      const before = snapshot(cwd);
      assert.deepStrictEqual(selection.readSelectionState(cwd, M), state, 'repeated reads return the same outcome');
      assert.deepStrictEqual(snapshot(cwd), before, 'bytes and mtime unchanged');
      assert.deepStrictEqual(forbiddenWrites(cwd), ['absent', 'absent'], 'no selection or contract');
    };
    // Known milestone range with an unknown linked-task horizon.
    const unknown = enrolled(), unknownSha = materializeFor(unknown, applyPatches(PROPOSALS.base, [{ op: 'set', path: ['positions', 1, 'nodes', 4, 'judgment'], value: null }])).sha;
    answer(unknown, 'Teto próprio'); answer(unknown, 'Com task ligada (media)'); answer(unknown, '6h'); answer(unknown, 'Criar sem iniciar');
    const horizon = outcomeOf(unknown, unknownSha), r = horizon.re_estimate;
    assert.deepStrictEqual([r.reason, r.position_id, r.linked_task_authorization, r.scope_reduction], ['linked-task-horizon-unknown', 'media', 'create-without-auto-start', null]);
    assert.deepStrictEqual(r.decisions.map(d => d.answer), ['mode:operator-ceiling', 'option:media', 'operator-ceiling:21600000', 'linked-task:create-without-auto-start']);
    assert.deepStrictEqual(r.decisions.map(d => d.decision_set), ['milestone-time-activation', 'milestone-time-activation', 'milestone-time-activation', 'milestone-time-linked-task']);
    for (const d of r.decisions) assert.deepStrictEqual([/^[a-f0-9]{64}$/.test(d.identity_sha256), d.question_id], [true, d.round_id]);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 4096 && !/handle|approved/.test(JSON.stringify(r)));
    readOnly(unknown, horizon);
    // A custom ceiling cannot be requested when the estimated upper bound exceeds the 365-day maximum.
    const high = structuredClone(PROPOSALS.base.positions[0].nodes[1].judgment); high.high_ms = 40000000000;
    const above = enrolled(), aboveSha = materializeFor(above, applyPatches(PROPOSALS.base, [{ op: 'set', path: ['positions', 0, 'nodes', 1, 'judgment'], value: high }])).sha;
    answer(above, 'Teto próprio'); answer(above, 'Escopo completo (curta)');
    const maximum = outcomeOf(above, aboveSha);
    assert.deepStrictEqual([maximum.re_estimate.reason, maximum.re_estimate.position_id, maximum.re_estimate.linked_task_authorization, maximum.re_estimate.decisions.map(d => d.answer)],
      ['operator-ceiling-above-maximum', 'curta', null, ['mode:operator-ceiling', 'option:curta']]);
    readOnly(above, maximum);
    // No viable position keeps the generic reason without a position.
    const none = enrolled(), noneSha = materializeFor(none, validCase('nenhuma-viavel')).sha; answer(none, 'Reestimar');
    const generic = outcomeOf(none, noneSha);
    assert.deepStrictEqual([generic.re_estimate.reason, generic.re_estimate.position_id, generic.re_estimate.decisions.map(d => d.answer)], ['re-estimate-requested', null, ['re-estimate']]);
  });
  test('declining-the-no-contract-confirmation-requests-re-estimation-without-authority', () => {
    const cwd = enrolled(), { sha } = materializeFor(cwd);
    answer(cwd, 'Escolher posição'); answer(cwd, 'Com task ligada (media)'); answer(cwd, 'Não criar task'); answer(cwd, 'Sem contrato');
    const { opened } = answer(cwd, 'Reestimar');
    assert.strictEqual(opened.question_id, 'time-confirm-' + sha.slice(0, 12));
    const state = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([state.status, state.reason, state.previous_options_sha256], ['estimate-required', 're-estimate-requested', sha]);
    assert.strictEqual(state.re_estimate.decisions.at(-1).answer, 're-estimate');
    assert.deepStrictEqual(forbiddenWrites(cwd), ['absent', 'absent'], 'no selection or contract');
    assert.deepStrictEqual(selection.nextRound({ cwd, milestone: M }), { status: 'none', milestone: M, state: 'estimate-required' });
    const refusal = decide(cwd); assert.deepStrictEqual([refusal.status, refusal.reason], ['refused', 'time-options-stale']);
    assert.strictEqual(selection.roadmapRule(cwd, M).expected.precondition, 'selection-required');
    // The cycle progresses: a new estimate yields a new proposal and a new first round; the old record is preserved.
    const next = materializeFor(cwd);
    assert.notStrictEqual(next.sha, sha);
    const again = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([again.status, again.options_sha256, again.round.type], ['decision-pending', next.sha, 'mode']);
    assert.strictEqual(time.listOptions({ cwd, milestone: M }).records.length, 2);
  });

  test('cli-and-default-readers-recover-the-investigated-code-context', () => {
    const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
    const json = (args, cwd) => { const r = run([...args, '--json'], cwd); return { status: r.status, out: JSON.parse(r.stdout), raw: r.stdout + r.stderr }; };
    const fixture = () => {
      const cwd = enrolled(), codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-code-')); roots.push(codeDir);
      write(codeDir, 'src/app.js', 'module.exports = 1;\n'); write(codeDir, 'src/lib.js', 'module.exports = 2;\n');
      const code = { root: codeDir, files: ['src/app.js', 'src/lib.js'] }, made = materializeFor(cwd, structuredClone(PROPOSALS.base), { code });
      return { cwd, codeDir, made, at: ['--cwd', cwd, '--milestone', M], context: path.join(cwd, '.gsd/forge/time-code-context', M + '-' + made.sha + '.json') };
    };
    const { cwd, codeDir, made, at, context } = fixture();
    const record = time.readOptions({ cwd, milestone: M, options_sha256: made.sha }).record;
    assert.deepStrictEqual(record.inputs.code_files.map(f => f.path), ['src/app.js', 'src/lib.js']);
    // Default public reader and CLI: no code argument, same context, unchanged data is fresh.
    const settled = snapshot(cwd);
    assert.deepStrictEqual([selection.readSelectionState(cwd, M).status, selection.readSelectionState(cwd, M).options_sha256], ['decision-pending', made.sha], JSON.stringify(selection.readSelectionState(cwd, M)));
    let r = json(['--status', ...at], cwd); assert.deepStrictEqual([r.status, r.out.state.status, r.out.state.options_sha256], [0, 'decision-pending', made.sha]);
    assert.ok(!r.raw.includes(codeDir) && !r.raw.includes(codeDir.replace(/\\/g, '/')), 'no absolute code path in output');
    assert.deepStrictEqual(snapshot(cwd), settled, 'readers write nothing');
    r = json(['--round', ...at], cwd); assert.deepStrictEqual([r.status, r.out.status], [0, 'open']);
    let answered = json(['--answer', '--round', r.out.question_id, '--response', 'Escolher posição', '--source', 'user-text', ...at], cwd);
    assert.deepStrictEqual([answered.status, answered.out.status], [0, 'answered'], answered.raw);
    r = json(['--round', ...at], cwd); assert.strictEqual(r.out.status, 'open', r.raw);
    answered = json(['--answer', '--round', r.out.question_id, '--response', 'Escopo completo (curta) (Recomendado)', '--source', 'user-text', ...at], cwd);
    assert.deepStrictEqual([answered.status, answered.out.status], [0, 'answered'], answered.raw);
    // An actual file change BEFORE the choice is still detected through the recovered context: nothing is decided.
    write(codeDir, 'src/app.js', 'module.exports = 11;\n');
    const stale = json(['--status', ...at], cwd).out.state;
    assert.deepStrictEqual([stale.status, stale.reason, stale.changed, stale.previous_options_sha256], ['estimate-required', 'inputs-changed', ['code_files:src/app.js'], made.sha]);
    assert.strictEqual(json(['--round', ...at], cwd).out.status, 'none');
    const early = []; assert.strictEqual(selection.main(['--decide', ...at, '--json'], { stdout: { write: s => early.push(s) } }, liveAdapter(cwd, { issuedAt: Date.now() })), 3);
    assert.strictEqual(JSON.parse(early[0]).reason, 'time-options-stale');
    assert.deepStrictEqual(forbiddenWrites(cwd), ['absent', 'absent']);
    // Unchanged data (fresh child processes): embedded decide with only the genuine live adapter selects and activates.
    write(codeDir, 'src/app.js', 'module.exports = 1;\n');
    assert.strictEqual(json(['--status', ...at], cwd).out.state.outcome.choice, 'option');
    const out = []; const status = selection.main(['--decide', ...at, '--json'], { stdout: { write: s => out.push(s) } }, liveAdapter(cwd, { issuedAt: Date.now() }));
    assert.deepStrictEqual([status, JSON.parse(out[0]).status, JSON.parse(out[0]).choice], [0, 'decided', 'option'], out.join(''));
    assert.deepStrictEqual(forbiddenWrites(cwd), ['valid', 'valid']);
    // After the choice the sources are historical: legitimate later development keeps the consent.
    write(codeDir, 'src/app.js', 'module.exports = 99;\n'); write(cwd, `.gsd/milestones/${M}/${M}-SCOPE.md`, '# SCOPE\nevoluiu\n');
    const kept = json(['--status', ...at], cwd).out.state;
    assert.deepStrictEqual([kept.status, kept.options_sha256], ['decided', made.sha]);
    // Missing, malformed and foreign contexts refuse; there is no fallback to the owner root and readers never repair.
    const refusals = (name, mutate, reason) => {
      const f = fixture(); mutate(f);
      const before = snapshot(f.cwd), state = selection.readSelectionState(f.cwd, M);
      assert.deepStrictEqual([state.status, state.reason], ['options-invalid', reason], name);
      assert.strictEqual(json(['--status', ...f.at], f.cwd).out.state.reason, reason, name);
      assert.deepStrictEqual([json(['--round', ...f.at], f.cwd).out.reason, decide(f.cwd).reason], [reason, reason], name);
      assert.deepStrictEqual(snapshot(f.cwd), before, name + ' wrote');
      assert.deepStrictEqual(forbiddenWrites(f.cwd), ['absent', 'absent'], name);
    };
    refusals('missing', f => fs.rmSync(f.context), 'time-code-context-missing');
    refusals('malformed', f => fs.writeFileSync(f.context, '{ nope'), 'time-code-context-invalid');
    refusals('foreign-milestone', f => fs.writeFileSync(f.context, fs.readFileSync(f.context, 'utf8').replace(`"milestone": "${M}"`, `"milestone": "${OTHER}"`)), 'time-code-context-invalid');
    refusals('foreign-record', f => fs.writeFileSync(f.context, fs.readFileSync(f.context, 'utf8').replace(f.made.sha, 'f'.repeat(64))), 'time-code-context-invalid');
    refusals('foreign-root', f => { const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-code-')); roots.push(other);
      fs.writeFileSync(f.context, fs.readFileSync(f.context, 'utf8').replace(JSON.stringify(fs.realpathSync.native(f.codeDir)).slice(1, -1), JSON.stringify(fs.realpathSync.native(other)).slice(1, -1))); }, 'time-code-context-invalid');
    refusals('vanished-root', f => fs.rmSync(f.codeDir, { recursive: true, force: true }), 'time-code-context-invalid');
  });

  test('supplied-canonical-code-identity-is-bound-to-the-measured-physical-root', () => {
    const codeRoots = require('./forge-code-roots'), { spawnSync: sync } = require('node:child_process');
    const checkout = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-code-')); roots.push(dir);
      write(dir, 'src/app.js', 'module.exports = 1;\n');
      assert.strictEqual(sync('git', ['init', '-q'], { cwd: dir }).status, 0);
      return fs.realpathSync.native(dir);
    };
    const original = checkout(), clone = checkout(), canonical = dir => codeRoots.measureRoot({ id: 'code', path: dir }).identity_sha256;
    assert.notStrictEqual(canonical(original), canonical(clone));
    // Invalid or foreign supplied identities fail closed before any persistence.
    for (const [name, identity] of [['malformed', 'nope'], ['foreign-root', canonical(clone)], ['constant', 'a'.repeat(64)]]) {
      const cwd = enrolled(), code = { root: original, files: ['src/app.js'], identity_sha256: identity };
      const before = snapshot(cwd);
      const refused = selection.prepareBoundary(cwd, M, { now: NOW - 600000, code });
      assert.deepStrictEqual([refused.status, refused.reason], ['refused', 'time-inputs-invalid'], name);
      assert.deepStrictEqual(snapshot(cwd), before, name + ' wrote');
    }
    const cwd = enrolled(), made = materializeFor(cwd, structuredClone(PROPOSALS.base), { code: { root: original, files: ['src/app.js'], identity_sha256: canonical(original) } });
    const context = path.join(cwd, '.gsd/forge/time-code-context', M + '-' + made.sha + '.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(context, 'utf8')).identity_source, 'supplied');
    assert.deepStrictEqual([selection.readSelectionState(cwd, M).status, selection.readSelectionState(cwd, M).options_sha256], ['decision-pending', made.sha]);
    // The clone holds the original investigated bytes; the original changes; the descriptor is redirected.
    write(clone, 'src/app.js', 'module.exports = 1;\n'); write(original, 'src/app.js', 'module.exports = 2;\n');
    fs.writeFileSync(context, fs.readFileSync(context, 'utf8').replace(JSON.stringify(original).slice(1, -1), JSON.stringify(clone).slice(1, -1)));
    const before = snapshot(cwd), reason = 'time-code-context-invalid';
    const state2 = selection.readSelectionState(cwd, M);
    assert.deepStrictEqual([state2.status, state2.reason], ['options-invalid', reason]);
    const cli = spawnSync(process.execPath, [SCRIPT, '--status', '--cwd', cwd, '--milestone', M, '--json'], { encoding: 'utf8', cwd });
    assert.strictEqual(JSON.parse(cli.stdout).state.reason, reason);
    assert.strictEqual(decide(cwd).reason, reason);
    assert.deepStrictEqual(snapshot(cwd), before, 'redirected context wrote');
    assert.deepStrictEqual(forbiddenWrites(cwd), ['absent', 'absent']);
  });

  test('canonical-owner-root-identity-with-empty-files-recovers-after-restart', () => {
    const codeRoots = require('./forge-code-roots'), { spawnSync: sync } = require('node:child_process');
    const cwd = enrolled(); assert.strictEqual(sync('git', ['init', '-q'], { cwd }).status, 0);
    const owner = fs.realpathSync.native(cwd), identity = codeRoots.measureRoot({ id: 'code', path: owner }).identity_sha256;
    const made = materializeFor(cwd, structuredClone(PROPOSALS.base), { code: { root: owner, files: [], identity_sha256: identity } });
    const context = path.join(cwd, '.gsd/forge/time-code-context', M + '-' + made.sha + '.json');
    assert.ok(fs.existsSync(context), 'descriptor persisted for the supplied owner-root identity');
    // Fresh default readers (no code argument) and a fresh process recover the same basis.
    assert.deepStrictEqual([selection.readSelectionState(cwd, M).status, selection.readSelectionState(cwd, M).options_sha256], ['decision-pending', made.sha]);
    const cli = spawnSync(process.execPath, [SCRIPT, '--status', '--cwd', cwd, '--milestone', M, '--json'], { encoding: 'utf8', cwd });
    const status = JSON.parse(cli.stdout).state;
    assert.deepStrictEqual([status.status, status.options_sha256], ['decision-pending', made.sha], cli.stdout);
    chooseCurta(cwd);
    const result = decide(cwd); assert.strictEqual(result.status, 'decided', JSON.stringify(result));
  });

  test('rejected-options-destination-leaves-feature-bytes-unchanged', () => {
    const feature = cwd => Object.fromEntries(Object.entries(snapshot(cwd)).filter(([name]) => !/lock/i.test(name)));
    const prepare = place => {
      const cwd = enrolled(), state = selection.readSelectionState(cwd, M);
      commitEstimate(cwd, state.key_suffix, NOW - 1800000); proposalFile(cwd, structuredClone(PROPOSALS.base));
      const target = path.join(cwd, `.gsd/milestones/${M}/${M}-OPTIONS.md`); place(target, cwd);
      return { cwd, target };
    };
    const cases = [['directory', target => fs.mkdirSync(target)], ['oversized', target => fs.writeFileSync(target, Buffer.alloc(256 * 1024 + 1, 97))]];
    const linkTarget = path.join(os.tmpdir(), 'forge-selection-link-' + process.pid + '.md');
    fs.writeFileSync(linkTarget, 'externo\n'); roots.push(linkTarget);
    let linked = true;
    try { fs.symlinkSync(linkTarget, path.join(root(), 'probe'), 'file'); } catch { linked = false; }
    if (linked) cases.push(['symlink', target => fs.symlinkSync(linkTarget, target, 'file')]);
    else console.log('NOTE file symlink case skipped: file links need a privilege this process lacks');
    // A directory junction needs no privilege on Windows; the same refusal must run even when file links are unavailable.
    const junctionTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-selection-junction-')); roots.push(junctionTarget);
    fs.writeFileSync(path.join(junctionTarget, 'externo.txt'), 'externo\n');
    cases.push(['junction', target => fs.symlinkSync(junctionTarget, target, 'junction')]);
    for (const [name, place] of cases) {
      const { cwd, target } = prepare(place), before = feature(cwd), kind = fs.lstatSync(target);
      const refused = selection.prepareBoundary(cwd, M, { now: NOW - 600000 });
      assert.strictEqual(refused.status, 'refused', name + ' ' + JSON.stringify(refused));
      assert.deepStrictEqual(feature(cwd), before, name + ' changed feature bytes');
      assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd/forge/time-code-context')), false, name + ' wrote a descriptor');
      assert.strictEqual(selection.readSelectionState(cwd, M).status, 'materialization-required', name + ' published a proposal');
      assert.deepStrictEqual([fs.lstatSync(target).isSymbolicLink(), fs.lstatSync(target).isDirectory()], [kind.isSymbolicLink(), kind.isDirectory()], name);
      if (name === 'symlink') assert.strictEqual(fs.readFileSync(linkTarget, 'utf8'), 'externo\n');
      if (name === 'junction') {
        assert.deepStrictEqual([fs.readdirSync(junctionTarget), fs.readFileSync(path.join(junctionTarget, 'externo.txt'), 'utf8')], [['externo.txt'], 'externo\n'], 'junction target mutated');
        assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), true, 'junction was not a link');
      }
      console.log('NOTE link case executed: ' + name + ' refused with ' + refused.reason);
    }
    assert.ok(cases.some(([name]) => name === 'junction'), 'the supported junction case must run');

  });

  test('options-capacity-refuses-before-descriptor-and-matches-canonical-limit', () => {
    const feature = cwd => Object.fromEntries(Object.entries(snapshot(cwd)).filter(([name]) => !/lock/i.test(name)));
    // Template: a real materialized record from a throwaway root, cloned as valid historical options.
    const template = enrolled(), made0 = materializeFor(template), base = time.readOptions({ cwd: template, milestone: M, options_sha256: made0.sha }).record;
    const history = (cwd, count) => {
      for (let i = 0; i < count; i++) {
        const record = { ...structuredClone(base), materialized_at: iso(NOW - 86400000 - i * 1000) };
        assert.strictEqual(time.recordOptions({ cwd, milestone: M, record }).status, 'valid', 'history ' + i);
      }
    };
    const cwd = enrolled(); history(cwd, 256);
    assert.deepStrictEqual([time.listOptions({ cwd, milestone: M }).status, time.listOptions({ cwd, milestone: M }).records.length], ['valid', 256]);
    commitEstimate(cwd, selection.readSelectionState(cwd, M).key_suffix, NOW - 1800000); proposalFile(cwd, structuredClone(PROPOSALS.base));
    const before = feature(cwd);
    const refused = selection.prepareBoundary(cwd, M, { now: NOW - 600000 });
    assert.deepStrictEqual([refused.status, refused.reason], ['refused', 'time-record-limit'], JSON.stringify(refused));
    assert.deepStrictEqual(feature(cwd), before, 'capacity refusal changed feature bytes');
    assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd/forge/time-code-context')), false, 'capacity refusal wrote a descriptor');
    assert.strictEqual(fs.existsSync(path.join(cwd, `.gsd/milestones/${M}/${M}-OPTIONS.md`)), false, 'capacity refusal rendered options');
    assert.strictEqual(time.listOptions({ cwd, milestone: M }).records.length, 256);
    // Parity: the canonical writer refuses a new record at the same boundary and replays a stored one.
    const extra = { ...structuredClone(base), materialized_at: iso(NOW - 1) };
    assert.throws(() => time.recordOptions({ cwd, milestone: M, record: extra }), e => e.code === 'time-record-limit');
    const stored = time.listOptions({ cwd, milestone: M }).records[0];
    assert.strictEqual(time.recordOptions({ cwd, milestone: M, record: stored.record }).options_sha256, stored.options_sha256, 'duplicate replay at capacity');
    // One below the limit the same preparation succeeds, so the preflight bound equals the canonical one.
    const below = enrolled(); history(below, 255);
    commitEstimate(below, selection.readSelectionState(below, M).key_suffix, NOW - 1800000); proposalFile(below, structuredClone(PROPOSALS.base));
    const ok = selection.prepareBoundary(below, M, { now: NOW - 600000 });
    assert.strictEqual(ok.status, 'materialized', JSON.stringify(ok));
    assert.strictEqual(time.listOptions({ cwd: below, milestone: M }).records.length, 256);
  });

  test('invalid-canonical-contract-refuses-before-descriptor-with-unchanged-feature', () => {
    const feature = cwd => Object.fromEntries(Object.entries(snapshot(cwd)).filter(([name]) => !/lock/i.test(name)));
    // A real, valid contract produced by the live-authority fixture is copied into a separate enrolled target.
    const donor = decidedCurta().cwd, validBase = fs.readFileSync(time.timePaths({ cwd: donor, milestone: M }).contract);
    const cases = [['malformed-contract', dir => fs.writeFileSync(path.join(dir, 'contract.json'), '{'), 'invalid', 'time-contract-json-invalid'],
      ['unexpected-entry', dir => fs.writeFileSync(path.join(dir, 'inesperado.txt'), 'x'), 'invalid', 'time-contract-base-missing'],
      ['valid-existing-contract', dir => fs.writeFileSync(path.join(dir, 'contract.json'), validBase), 'valid', 'time-options-contract-exists']];
    for (const [name, place, canonicalStatus, expectedReason] of cases) {
      const cwd = enrolled();
      commitEstimate(cwd, selection.readSelectionState(cwd, M).key_suffix, NOW - 1800000); proposalFile(cwd, structuredClone(PROPOSALS.base));
      place(time.timePaths({ cwd, milestone: M }).directory);
      const canonicalRead = time.readContract({ cwd, milestone: M });
      assert.strictEqual(canonicalRead.status, canonicalStatus, name + ' canonical ' + JSON.stringify(canonicalRead));
      const before = feature(cwd), refused = selection.prepareBoundary(cwd, M, { now: NOW - 600000 });
      assert.strictEqual(refused.status, 'refused', name + ' ' + JSON.stringify(refused));
      assert.strictEqual(refused.reason, expectedReason, name + ' ' + refused.reason);
      if (canonicalStatus === 'invalid') assert.strictEqual(refused.reason, canonicalRead.reason, name + ' reason parity with canonical readContract');
      assert.deepStrictEqual(feature(cwd), before, name + ' changed feature bytes');
      assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd/forge/time-code-context')), false, name + ' wrote a descriptor');
      assert.strictEqual(fs.existsSync(path.join(cwd, `.gsd/milestones/${M}/${M}-OPTIONS.md`)), false, name + ' rendered options');
    }
  });

  test('invalid-owner-context-fails-closed-while-unenrolled-owner-stays-null', () => {
    const { spawnSync: sync } = require('node:child_process');
    const cwd = enrolled(), link = path.join(os.tmpdir(), 'forge-selection-owner-junction-' + process.pid);
    roots.push(link);
    fs.symlinkSync(fs.realpathSync.native(cwd), link, 'junction');
    const before = snapshot(cwd), rule = selection.roadmapRule(link, M);
    assert.deepStrictEqual(rule, { kind: 'milestone-roadmap-time', milestone: M, expected: { status: 'invalid', reason: 'roadmap-time-expected-invalid' } });
    const cli = sync(process.execPath, [SCRIPT, '--conformance', '--cwd', link, '--milestone', M, '--json'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 3, cli.stdout + cli.stderr);
    assert.strictEqual(JSON.parse(cli.stdout).rule.expected.status, 'invalid');
    assert.ok(!cli.stdout.includes(os.tmpdir()) && !cli.stdout.includes(cwd), 'absolute path leaked');
    assert.deepStrictEqual(snapshot(cwd), before, 'owner bytes changed');
    assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), true);
    const plain = root();
    assert.strictEqual(selection.roadmapRule(plain, M), null);
    const ok = sync(process.execPath, [SCRIPT, '--conformance', '--cwd', plain, '--milestone', M, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual([ok.status, JSON.parse(ok.stdout).rule], [0, null]);
  });
} finally {
  for (const cwd of roots) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temporary root cleanup */ } }
}
console.log(passed + ' passed');
