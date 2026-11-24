#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { digest } = require('./forge-code-roots');
const options = require('./forge-milestone-options');
const time = require('./forge-milestone-time');
const rt = require('./forge-milestone-roadmap-time');
const channel = require('./forge-question-channel');
const questions = require('./forge-pending-questions');
const { MAX_BYTES } = require('./forge-phase-cost');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const HISTORIES = require('./fixtures/milestone-options/history-cases.json');
const SCRIPT = path.join(__dirname, 'forge-milestone-options.js');
const M = PROPOSALS.milestone, NOW = Date.parse('2026-11-02T12:00:00.000Z');
const roots = [];
let passed = 0, serial = 0;

function test(name, callback) { callback(); passed++; console.log('PASS ' + name); }
function root(initialized = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-options-test-')); roots.push(cwd);
  if (initialized) fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
  return cwd;
}
function snapshot(cwd) {
  const result = {};
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
    result[path.relative(cwd, file)] = entry.isFile() ? [digest(fs.readFileSync(file)), stat.mtimeMs, stat.size] : stat.isSymbolicLink() ? 'link' : 'directory';
    if (entry.isDirectory() && !stat.isSymbolicLink()) visit(file);
  } }
  visit(cwd); return result;
}
function link(target, at) { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); }
function applyPatches(value, patches) {
  const result = structuredClone(value);
  for (const patch of patches) {
    const keys = patch.path.slice(0, -1), last = patch.path.at(-1);
    const parent = keys.reduce((cursor, key) => cursor[key], result);
    if (patch.op === 'set') parent[last] = structuredClone(patch.value);
    else if (patch.op === 'delete') { if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last]; }
    else if (patch.op === 'push') parent[last].push(structuredClone(patch.value));
    else throw new Error('unknown patch ' + patch.op);
  }
  return result;
}
function proposalOf(input) {
  let value = applyPatches(PROPOSALS.base, input.patches || []);
  if (input.transform === 'strip-judgments') for (const p of value.positions) for (const n of p.nodes) n.judgment = null;
  else if (input.transform) throw new Error('unknown transform ' + input.transform);
  return value;
}
function validCase(name) { const row = PROPOSALS.valid.find(c => c.name === name); assert.ok(row, name); return proposalOf(row.input); }
function historyCase(name) { const row = HISTORIES.cases.find(c => c.name === name); assert.ok(row, name); return row; }
// Expands a named history specification into controller events inside a temporary owner.
function eventRows(work, specs, start) {
  const rows = [], at = value => new Date(value).toISOString();
  let t = start, k = 0;
  const push = (event, action, unit, when) => rows.push({ event, action, unit, milestone: work, host_runtime: 'codex', ts: at(when), idempotency_key: work + ':' + unit + ':' + (++k) });
  for (const spec of specs) {
    const kind = spec.kind || 'complete', unit = () => spec.phase + '/U' + (++serial);
    if (kind === 'complete') for (const d of spec.durations_ms) { const u = unit(); push('unit-began', 'begin', u, t); push('unit-transition', 'complete', u, t + d); t += d + 1000; }
    else if (kind === 'fail' || kind === 'expired-safe') { const u = unit(); push('unit-began', 'begin', u, t); push('unit-transition', kind, u, t + spec.duration_ms); t += spec.duration_ms + 1000; }
    else if (kind === 'paused') {
      const u = unit(); push('unit-began', 'begin', u, t); t += spec.segments_ms[0]; push('unit-transition', 'pause', u, t); t += spec.gap_ms;
      push('unit-began', 'begin', u, t); t += spec.segments_ms[1]; push('unit-transition', 'complete', u, t); t += 1000;
    } else if (kind === 'open') { push('unit-began', 'begin', unit(), t); t += 1000; }
    else if (kind === 'ambiguous') { const u = unit(); push('unit-began', 'begin', u, t); push('unit-began', 'begin', u, t + 1000); push('unit-transition', 'complete', u, t + 2000); t += 3000; }
    else if (kind === 'invalid-line' || kind === 'padding') rows.push(spec);
    else throw new Error('unknown history kind ' + kind);
  }
  return rows;
}
function serialize(rows) {
  let text = '';
  for (const row of rows) {
    if (row.kind === 'invalid-line') text += 'not json\n';
    else if (row.kind === 'padding') { const filler = JSON.stringify({ event: 'synthetic-padding', note: 'x'.repeat(1000) }) + '\n'; while (Buffer.byteLength(text) <= MAX_BYTES + row.bytes_over_limit) text += filler; }
    else text += JSON.stringify(row) + '\n';
  }
  return text;
}
function buildHistory(cwd, input) {
  if (input.ledger.length) fs.mkdirSync(path.join(cwd, '.gsd/ledger'), { recursive: true });
  for (const m of input.ledger) fs.writeFileSync(path.join(cwd, '.gsd/ledger', m + '.md'), '## ' + m + '\nFechamento sintético\n');
  let start = Date.parse('2026-10-01T08:00:00.000Z');
  for (const [m, specs] of Object.entries(input.events)) {
    const dir = path.join(cwd, '.gsd/milestones', m); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, m + '-events.jsonl'), serialize(eventRows(m, specs, start))); start += 86400000;
  }
  if (input.shared) {
    const rows = input.shared.flatMap(spec => spec.work ? eventRows(spec.work, [spec], start += 86400000) : [spec]);
    fs.writeFileSync(path.join(cwd, '.gsd/forge/events.jsonl'), serialize(rows));
  }
  return cwd;
}
function historyFor(name) { const cwd = buildHistory(root(), historyCase(name).input); return { cwd, history: options.readHistory({ cwd, milestone: M }) }; }
function inputs(extra = {}) {
  return { documents: [{ path: '.gsd/milestones/' + M + '/' + M + '-CONTEXT.md', sha256: digest('synthetic:context') }],
    code_root: { identity_sha256: digest('synthetic:root'), revision: 'synthetic-revision-0001', workspace: 'synthetic-workspace-0001' },
    code_files: [{ path: 'scripts/forge-milestone-time.js', sha256: digest('synthetic:time') }], ...extra };
}
const PRODUCER = { producer: 'forge-planner', identity_sha256: digest('synthetic:producer'), frozen_at: new Date(NOW - 60000).toISOString() };
function materialized(proposal = validCase('completa-tres-posicoes'), history = options.readHistory({ cwd: root(), milestone: M })) {
  return options.materialize({ milestone: M, proposal, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW });
}
function numbersOf(value, found = []) {
  if (typeof value === 'number') found.push(value);
  else if (value && typeof value === 'object') for (const x of Object.values(value)) numbersOf(x, found);
  return found;
}
function roundsOk(round) {
  const channels = round.options.length ? ['claude-ask-user-question', 'codex-request-user-input', 'text-fallback'] : ['text-fallback'];
  for (const ch of channels) {
    const normalized = channel.normalizeDecision(round, ch);
    assert.strictEqual(normalized.id, round.id); assert.strictEqual(normalized.options.length, round.options.length);
    if (round.recommended) assert.strictEqual(normalized.options[0].label, round.recommended + ' (Recomendado)');
  }
  if (!round.options.length) assert.throws(() => channel.normalizeDecision(round, 'claude-ask-user-question'), e => e.code === 'decision-options-required');
  assert.ok(new RegExp('^time-' + round.type + '-[a-f0-9]{12}$').test(round.id));
  assert.ok(Array.from(round.header).length <= 12 && Array.from(round.question).length <= 240);
  for (const o of round.options) assert.ok(Array.from(o.description).length <= 240 && /Horizontes/.test(o.description) && /milestone|curta|media|longa/.test(o.description), o.description);
  return round;
}
function walkRounds(record, answers) {
  let answered = {}, result;
  for (const answer of answers) {
    result = options.selectionRounds(record, answered);
    assert.ok(!result.done, 'round expected before ' + answer);
    roundsOk(result);
    answered = { ...answered, [result.id]: answer };
  }
  return { result: options.selectionRounds(record, answered), answered };
}

function decideFor(cwd, kind, request, answer) {
  const id = 'question-' + ++serial, opened = questions.openQuestions({ cwd, unit: 'milestone-time/' + M + '-' + id, milestone: M, decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Escolha explícita?' }] });
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const live = { reference: 'live-' + serial, status: 'resolved', answer, resolved_at: new Date(NOW).toISOString(), source: 'user-text', question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: M, kind, request_sha256: digest(request), expires_at: NOW + 60000 }, () => NOW);
}
function contractFor(record, option, ceiling, linked, chain) {
  return { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 }, option, activated_at: new Date(NOW).toISOString(),
    preselection_started_at: new Date(NOW - 120000).toISOString(), ceiling_ms: ceiling, endpoint: record.proposal.endpoint, allocation: null, linked_task: linked, chain_forecast: chain };
}
function prepareFor(record) { const cwd = root(); time.recordEnrollment({ cwd, milestone: M, source: 'owner', now: NOW - 120000 }); time.recordOptions({ cwd, milestone: M, record }); return cwd; }
// Issue 342 fixtures: closed milestone M101 written by the real controller (committed begin
// transactions carrying active_slice) plus synthetic rows in the owner global log.
const HOUR = 3600000, T0 = Date.parse('2026-10-01T08:00:00.000Z');
function iso(value) { return new Date(value).toISOString(); }
function globalLog(cwd) { return path.join(cwd, '.gsd/forge/events.jsonl'); }
function writeRows(cwd, rows) { fs.writeFileSync(globalLog(cwd), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
// units: [{ unit, slice, segments: [[startMs, endMs, host?], ...] }]; consecutive segments pause and resume.
function committedOwner(units, ownerRows = []) {
  const controller = require('./forge-unit-controller'), state = require('./forge-state');
  const cwd = root(), milestone = 'M101';
  fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on', created: iso(T0), heartbeat: iso(T0) });
  let at = T0;
  const opts = { now: () => at, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [] }) };
  for (const [u, item] of units.entries()) {
    const slice = item.slice || 'S01', tag = 'issue342-' + u + '-' + item.unit.replace('/', '-') + '-' + slice;
    item.segments.forEach(([start, end, host = 'claude'], i) => {
      at = T0 + start;
      const begun = controller.begin(cwd, { milestone, unit: item.unit, slice, host_runtime: host, owner_token: 'history-owner', idempotency_key: tag + '-begin-' + i,
        state_patch: { active_slice: slice } }, opts);
      assert.ok(begun.ok, JSON.stringify(begun));
      at = T0 + end;
      const last = i === item.segments.length - 1, request = { milestone, unit: item.unit, host_runtime: host, owner_token: 'history-owner', generation: begun.generation,
        idempotency_key: tag + (last ? '-complete-' : '-pause-') + i };
      const closed = last ? controller.complete(cwd, { ...request, result: { status: 'succeeded' } }, opts) : controller.pause(cwd, request, opts);
      assert.ok(closed.ok, JSON.stringify(closed));
    });
  }
  fs.mkdirSync(path.join(cwd, '.gsd/ledger'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.gsd/ledger', milestone + '.md'), '# Closed history\n');
  if (ownerRows.length) writeRows(cwd, ownerRows);
  return cwd;
}
// dispatch + sidecar-unit started/done of one review-fix attempt (the forge-review-policy fixture shape).
function reviewRows(id, unit, milestone, slice, start, end, extra = {}) {
  const dispatch = { ts: iso(start), event: 'dispatch', unit, ...(milestone ? { milestone } : {}), ...(slice ? { slice } : {}), ...(extra.noId ? {} : { dispatch_id: id }) };
  if (extra.noId) return [dispatch];
  const rows = extra.noDispatch ? [] : [dispatch];
  rows.push({ ts: extra.ts || iso(start), event: 'sidecar-unit', workflow_id: 'wf-fixture', dispatch_id: id, unit, status: 'started', provider_called: false });
  if (extra.terminal !== false) rows.push({ ts: iso(end), event: 'sidecar-unit', workflow_id: 'wf-fixture', dispatch_id: id, unit, status: 'done', provider_called: true });
  return rows;
}
const T01_27H = [{ unit: 'execute-task/T01', segments: [[0, 27 * HOUR]] }];
function w1Rows(milestone = 'M101') { return reviewRows('rf-s01-a', 'review-fix/S01', milestone, 'S01', T0 + HOUR, T0 + 26.5 * HOUR); }
function readM(cwd) { return options.readHistory({ cwd, milestone: M }); }
function intCor(history) { const e = options.estimate(validCase('sem-julgamento'), history).positions[0]; return ['INT', 'COR'].map(id => e.nodes.find(n => n.id === id).high_ms); }
function executeStats(history) { const e = history.phases['execute-task']; return [e.n, e.p50_ms, e.p90_ms, e.min_ms, e.max_ms]; }

try {
  test('S02 review R62: cross-host pause history never truncates successful sample cost', () => {
    const controller = require('./forge-unit-controller'), state = require('./forge-state');
    const cwd = root(), milestone = 'M101', unit = 'plan-slice/S01', owner_token = 'history-owner';
    const start = NOW - 3000000, prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
    const at = n => ({ now: () => start + n, prefsReader });
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
    state.write(cwd, { milestone, kind: 'milestone', phase: 'plan-slice', active_slice: 'S01', active_task: '—', auto_mode: 'on', next_action: 'plan-slice' });
    const dir = path.join(cwd, '.gsd/milestones', milestone);
    fs.writeFileSync(path.join(dir, `${milestone}-ROADMAP.md`), '# History\n\n- [ ] **S01: Work** `depends:[]`\n');
    // A newly enrolled planner must have its actual owner S/T outputs before completion.
    // These files change no synthetic clock, pause/handoff, lease or history assertions.
    const sliceDir = path.join(dir, 'slices', 'S01'), taskDir = path.join(sliceDir, 'tasks', 'T01');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, 'S01-PLAN.md'), '# S01\n- [ ] **T01**: History fixture\n');
    fs.writeFileSync(path.join(taskDir, 'T01-PLAN.md'), '---\nid: T01\ndepends: []\nwrites:\n  - src/result.js\nmust_haves:\n  truths:\n    - History fixture behavior is observable.\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/result.js\n---\n# T01\n');
    const first = controller.begin(cwd, { milestone, unit, owner_token, host_runtime: 'claude', idempotency_key: 'history-first' }, at(0));
    controller.pause(cwd, { milestone, unit, owner_token, host_runtime: 'claude', generation: first.generation, idempotency_key: 'history-pause' }, at(600000));
    assert.strictEqual(controller.handoff(cwd, { unit, next_host_runtime: 'codex' }, at(700000)).reason, 'handoff-ready');
    const last = controller.begin(cwd, { milestone, unit, owner_token, host_runtime: 'codex', idempotency_key: 'history-continuation' }, at(900000));
    controller.complete(cwd, { milestone, unit, owner_token, host_runtime: 'codex', generation: last.generation, idempotency_key: 'history-complete', result: { status: 'succeeded' } }, at(1500000));
    fs.mkdirSync(path.join(cwd, '.gsd/ledger'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.gsd/ledger', milestone + '.md'), '# Closed history\n');
    const file = controller.eventsFile(cwd, milestone), original = fs.readFileSync(file), read = () => options.readHistory({ cwd, milestone: M });
    const intervals = require('./forge-phase-cost').analyzeEventIntervals(original);
    assert.deepStrictEqual(intervals.intervals.map(row => [row.host, row.end - row.start, row.action]), [['claude', 600000, 'pause'], ['codex', 600000, 'complete']]);
    const history = read();
    // The event interval API does not retain slice/attempt handoff proof. Unknown
    // is honest even here, where the live producer really validated a handoff.
    assert.deepStrictEqual([history.observations, history.phases['plan-slice'].n, history.phases['plan-slice'].p50_ms, history.phases['plan-slice'].p90_ms], [0, 0, null, null]);
    assert.strictEqual(history.excluded.continuation_unknown, 2);
    assert(history.limitations.some(text => text.includes('custo completo desconhecido')));
    const unjudged = proposalOf({ transform: 'strip-judgments' });
    const estimated = options.estimate(unjudged, history);
    assert(estimated.positions.every(p => p.ceiling_ms === null), 'no false final-segment ceiling');
    const rows = controller.readEvents(file);
    // Foreign slice/attempt collisions cannot turn a final segment into a full sample.
    for (const mutate of [
      copy => { copy[2].slice = 'S99'; },
      copy => { copy[2].idempotency_key = 'unrelated-retry'; },
      copy => { copy.splice(1, 0, { ...copy[0], idempotency_key: 'ambiguous-first', ts: new Date(start + 1000).toISOString() }); },
    ]) {
      const copy = structuredClone(rows); mutate(copy); fs.writeFileSync(file, serialize(copy));
      const negative = read(); assert.strictEqual(negative.phases['plan-slice'].n, 0); assert.strictEqual(negative.phases['plan-slice'].p90_ms, null);
    }
    const foreign = rows.slice(0, 2).map(row => ({ ...row, milestone: 'M102', idempotency_key: 'foreign-' + row.idempotency_key }));
    fs.writeFileSync(file, serialize([...foreign, ...rows]));
    assert.strictEqual(read().phases['plan-slice'].p90_ms, null, 'foreign pause cannot establish M101 continuation');
    fs.writeFileSync(file, original);
    assert.deepStrictEqual(read(), history);
    console.log('ok - S02 review R62: cross-host pause history never truncates successful sample cost');
  });
  test('issue342 attributed review-fix: committed S01 begin and a measured 25.5 h attempt turn the 27 h execute-task sample into 1.5 h; p90, INT/COR and the range follow', () => {
    const cwd = committedOwner(T01_27H, w1Rows()), history = readM(cwd);
    assert.deepStrictEqual(executeStats(history), [1, 5400000, 5400000, 5400000, 5400000]);
    assert.deepStrictEqual(intCor(history), [5400000, 5400000]);
    // curta with every node on execute-task:1 follows the adjusted sample (independent count x 1.5 h).
    const stripped = validCase('sem-julgamento');
    const curta = applyPatches(stripped, stripped.positions[0].nodes.map((_, i) => ({ op: 'set', path: ['positions', 0, 'nodes', i, 'phases'], value: { 'execute-task': 1 } })));
    assert.deepStrictEqual(options.validateProposal(curta, M), { valid: true });
    const e = options.estimate(curta, history).positions[0], expected = curta.positions[0].nodes.reduce((t, n) => t + Object.values(n.phases).reduce((s, count) => s + count * 5400000, 0), 0);
    assert.deepStrictEqual([e.status, e.low_ms, e.high_ms], ['estimated', expected, expected]);
    // Without scope proof for M101 (dispatch moved to M102) the same owner keeps the 27 h sample.
    writeRows(cwd, w1Rows('M102'));
    const foreign = readM(cwd);
    assert.deepStrictEqual([executeStats(foreign), intCor(foreign), foreign.review_fix.discounted_ms, foreign.review_fix.attempts.no_sample], [[1, 97200000, 97200000, 97200000, 97200000], [97200000, 97200000], 0, 1]);
  });
  test('issue342 separate surface: history.review_fix and the rendered options show the discounted cost apart, never inside a range or node', () => {
    const cwd = committedOwner(T01_27H, w1Rows()), history = readM(cwd), bytes = fs.readFileSync(globalLog(cwd));
    assert.deepStrictEqual(history.review_fix, { status: 'applied', reason: null,
      source: { path: '.gsd/forge/events.jsonl', sha256: digest(bytes), bytes: bytes.length, max_bytes: 16777216, malformed_lines: 0 },
      attempts: { measured: 1, used: 1, partial: 0, unmeasured: 0, missing_dispatch: 0, invalid_scope: 0, ambiguous: 0, missing_proof: 0, foreign: 0, triage: 0, no_sample: 0, no_overlap: 0 },
      samples_adjusted: 1, samples_consumed: 0, measured_ms: 91800000, discounted_ms: 91800000,
      by_phase: { 'execute-task': { samples_adjusted: 1, discounted_ms: 91800000 }, 'complete-slice': { samples_adjusted: 0, discounted_ms: 0 } }, added_to_ranges: false });
    for (const name of ['sem-julgamento', 'completa-tres-posicoes']) assert.ok(!numbersOf(options.estimate(validCase(name), history)).includes(91800000), name);
    const { record } = materialized(validCase('completa-tres-posicoes'), history);
    assert.ok(!numbersOf(record.estimate).includes(91800000), 'never in positions, nodes, ranges, ceilings or chain');
    assert.strictEqual(rt.optionsView(record).status, 'valid');
    const markdown = options.renderOptionsMarkdown(record), lines = markdown.split('\n');
    assert.ok(lines.includes('- Review-fix separado (fora de faixas e nós): aplicado; descontado 1 d 1 h 30 min de 1 amostra(s) (execute-task 1, complete-slice 0); tentativas usadas 1, parciais 0, sem prova 0, triagem 0; fonte `.gsd/forge/events.jsonl` sha256 '
      + digest(bytes).slice(0, 12) + ', ' + bytes.length + ' bytes.'), markdown);
    const section = markdown.slice(markdown.indexOf('## Histórico usado'), markdown.indexOf('## Posição curta'));
    assert.ok(section.includes('Review-fix separado') && section.indexOf('Review-fix separado') < section.indexOf('- Limitação:'), 'separate line in Histórico usado before the limitations');
    assert.ok(lines.includes('- Limitação: Review-fix medido e atribuído foi retirado das amostras de execução e é apresentado à parte; não foi somado a nenhuma faixa nem nó'));
    assert.ok(lines.find(l => l.startsWith('- Números:')).endsWith(' Além das pausas, só o review-fix medido e atribuído sai das amostras de execução; aparece à parte em Histórico usado e não entra em faixa.'));
    for (const line of lines.filter(l => /review-fix/i.test(l))) assert.ok(!/cobert/i.test(line), 'no coverage claim: ' + line);
  });
  test('issue342 preservation: controller events, transactions, ledger, state and global log keep bytes and mtime; reads are deterministic and aggregate-only', () => {
    const cwd = committedOwner(T01_27H, w1Rows()), before = snapshot(cwd);
    assert.ok(Object.keys(before).some(k => /transactions/.test(k)) && Object.keys(before).some(k => k.endsWith('M101-events.jsonl')) && Object.keys(before).some(k => k.endsWith('events.jsonl') && /forge/.test(k)));
    const history = readM(cwd), again = readM(cwd);
    assert.deepStrictEqual(again, history);
    const { record } = materialized(validCase('completa-tres-posicoes'), history);
    options.estimate(validCase('sem-julgamento'), history); options.renderOptionsMarkdown(record);
    assert.deepStrictEqual(snapshot(cwd), before, 'sources keep sha256, size and mtime');
    const text = JSON.stringify(history), real = fs.realpathSync.native(cwd);
    for (const bad of [cwd, cwd.replace(/\\/g, '/'), real, real.replace(/\\/g, '/'), 'rf-s01-a', 'review-fix/S01', 'execute-task/T01', 'issue342-']) assert.ok(!text.includes(bad), 'leaked ' + bad);
    assert.ok(!/"(?:start|end|unit|begin_key|begin_keys|segments|dispatch_id)"/.test(text), 'no windows, units or ids');
    assert.ok(time.isPublicData(history) && time.isPublicData(record));
  });
  test('issue342 partial and pause: only the proven intersection with active segments is discounted; the explicit pause gap is never subtracted', () => {
    const partial = readM(committedOwner(T01_27H, reviewRows('rf-p', 'review-fix/S01', 'M101', 'S01', T0 + 20 * HOUR, T0 + 30 * HOUR)));
    assert.deepStrictEqual([executeStats(partial)[0], executeStats(partial)[2], partial.review_fix.discounted_ms, partial.review_fix.measured_ms, partial.review_fix.attempts.partial],
      [1, 20 * HOUR, 7 * HOUR, 10 * HOUR, 1]);
    assert.ok(partial.limitations.includes('Só a interseção provada de cada tentativa de review-fix com os segmentos ativos de uma única amostra foi descontada; o restante ficou nas amostras'));
    // Real same-host pause and resume: active 0-10 h and 20-27 h (17 h); the 10-20 h gap is not in the sample.
    const paused = [{ unit: 'execute-task/T01', segments: [[0, 10 * HOUR], [20 * HOUR, 27 * HOUR]] }];
    const gapOnly = readM(committedOwner(paused, reviewRows('rf-gap', 'review-fix/S01', 'M101', 'S01', T0 + 12 * HOUR, T0 + 18 * HOUR)));
    assert.deepStrictEqual([executeStats(gapOnly)[2], gapOnly.review_fix.status, gapOnly.review_fix.discounted_ms, gapOnly.review_fix.attempts.no_overlap], [17 * HOUR, 'none', 0, 1]);
    const across = readM(committedOwner(paused, [...reviewRows('rf-across', 'review-fix/S01', 'M101', 'S01', T0 + 5 * HOUR, T0 + 25 * HOUR),
      ...reviewRows('rf-gap', 'review-fix/S01', 'M101', 'S01', T0 + 12 * HOUR, T0 + 18 * HOUR)]));
    assert.deepStrictEqual([executeStats(across)[0], executeStats(across)[2], across.review_fix.discounted_ms, across.review_fix.attempts.used, across.review_fix.attempts.no_overlap, across.review_fix.attempts.partial],
      [1, 7 * HOUR, 10 * HOUR, 1, 1, 1]);
    // A sample entirely covered leaves the pool; no zero-duration sample is published.
    const covered = readM(committedOwner(T01_27H, reviewRows('rf-all', 'review-fix/S01', 'M101', 'S01', T0 - HOUR, T0 + 28 * HOUR)));
    assert.deepStrictEqual([covered.phases['execute-task'].n, covered.phases['execute-task'].min_ms, covered.review_fix.samples_consumed, covered.review_fix.samples_adjusted, covered.review_fix.discounted_ms, covered.excluded.zero_duration],
      [0, null, 1, 1, 27 * HOUR, 0]);
    assert.deepStrictEqual(covered.sources.find(s => s.kind === 'milestone').samples, {});
    assert.ok(covered.limitations.includes('Amostra(s) inteiramente coberta(s) por review-fix medido saíram do conjunto; o custo está à parte'));
  });
  test('issue342 no double counting: an overlapping recovery counts once and one attempt adjusts exactly one sample', () => {
    const union = readM(committedOwner(T01_27H, [...reviewRows('rf-a', 'review-fix/S01', 'M101', 'S01', T0 + HOUR, T0 + 10 * HOUR),
      ...reviewRows('rf-a-recovery-1', 'review-fix/S01', 'M101', 'S01', T0 + 8 * HOUR, T0 + 20 * HOUR)]));
    assert.deepStrictEqual([union.review_fix.discounted_ms, union.review_fix.measured_ms, union.review_fix.attempts.used, union.review_fix.samples_adjusted, executeStats(union)[2]],
      [19 * HOUR, 21 * HOUR, 2, 1, 8 * HOUR]);
    // Sequential execute-task/T01 and complete-slice/S01 of S01, both committed: the larger fresh intersection wins alone.
    const sequential = [{ unit: 'execute-task/T01', segments: [[0, 10 * HOUR]] }, { unit: 'complete-slice/S01', segments: [[10 * HOUR + 60000, 27 * HOUR]] }];
    const one = readM(committedOwner(sequential, reviewRows('rf-b', 'review-fix/S01', 'M101', 'S01', T0 + 8 * HOUR, T0 + 20 * HOUR)));
    const slice = 27 * HOUR - (10 * HOUR + 60000), fresh = 20 * HOUR - (10 * HOUR + 60000);
    assert.deepStrictEqual([one.phases['execute-task'].p90_ms, one.phases['complete-slice'].p90_ms, one.review_fix.discounted_ms, one.review_fix.samples_adjusted, one.review_fix.attempts.partial],
      [10 * HOUR, slice - fresh, fresh, 1, 1]);
    assert.deepStrictEqual(one.review_fix.by_phase, { 'execute-task': { samples_adjusted: 0, discounted_ms: 0 }, 'complete-slice': { samples_adjusted: 1, discounted_ms: fresh } });
    // Equal fresh intersections are ambiguous and discount nothing.
    const tie = readM(committedOwner([{ unit: 'execute-task/T01', segments: [[0, 10 * HOUR]] }, { unit: 'execute-task/T02', segments: [[10 * HOUR, 20 * HOUR]] }],
      reviewRows('rf-c', 'review-fix/S01', 'M101', 'S01', T0 + 5 * HOUR, T0 + 15 * HOUR)));
    assert.deepStrictEqual([tie.review_fix.discounted_ms, tie.review_fix.attempts.ambiguous, tie.phases['execute-task'].n, tie.phases['execute-task'].min_ms, tie.phases['execute-task'].max_ms],
      [0, 1, 2, 10 * HOUR, 10 * HOUR]);
  });
  test('issue342 missing, ambiguous and foreign proof: the unbound original fixture and every negative keep samples intact with a named counter', () => {
    // The original unbound diagnostic: synthetic controller rows without any committed transaction.
    const diagnostic = [[5400000, []], [97200000, w1Rows()], [97200000, []], [5400000, reviewRows('rf-out', 'review-fix/S01', 'M101', 'S01', T0 + 3 * HOUR, T0 + 4 * HOUR)]].map(([duration, rows]) => {
      const cwd = buildHistory(root(), { ledger: ['M101'], events: { M101: [{ phase: 'execute-task', durations_ms: [duration] }] } });
      if (rows.length) writeRows(cwd, rows);
      return readM(cwd);
    });
    assert.deepStrictEqual(diagnostic.map(h => h.phases['execute-task'].p90_ms), [5400000, 97200000, 97200000, 5400000]);
    assert.deepStrictEqual([diagnostic[1].review_fix.attempts.missing_proof, diagnostic[1].review_fix.discounted_ms, diagnostic[3].review_fix.attempts.no_overlap], [1, 0, 1]);
    assert.ok(diagnostic[1].limitations.includes('Tentativas de review-fix sem prova suficiente (ausente, ambígua, estrangeira ou sem medição) não foram descontadas e podem permanecer nas amostras'));
    const intact = (history, counter, label) => {
      assert.deepStrictEqual([executeStats(history), intCor(history), history.review_fix.status, history.review_fix.discounted_ms, history.review_fix.attempts[counter]],
        [[1, 97200000, 97200000, 97200000, 97200000], [97200000, 97200000], 'none', 0, 1], label);
    };
    const window = [T0 + HOUR, T0 + 26.5 * HOUR];
    for (const [label, counter, rows] of [
      ['sidecar-unit without dispatch', 'missing_dispatch', reviewRows('rf-orphan', 'review-fix/S01', 'M101', 'S01', ...window, { noDispatch: true })],
      ['started without terminal', 'unmeasured', reviewRows('rf-open', 'review-fix/S01', 'M101', 'S01', ...window, { terminal: false })],
      ['invalid ts', 'unmeasured', reviewRows('rf-ts', 'review-fix/S01', 'M101', 'S01', ...window, { ts: 'not-a-date' })],
      ['dispatch without dispatch_id', 'unmeasured', reviewRows('rf-none', 'review-fix/S01', 'M101', 'S01', ...window, { noId: true })],
      ['dispatch for M102', 'no_sample', w1Rows('M102')],
      ['dispatch for the current milestone', 'no_sample', w1Rows(M)],
      ['one dispatch_id with two scopes', 'ambiguous', [...w1Rows(), { ts: iso(window[0]), event: 'dispatch', unit: 'review-fix/S02', milestone: 'M101', slice: 'S02', dispatch_id: 'rf-s01-a' }]],
      ['milestone triage', 'triage', reviewRows('rf-triage', 'review-fix/M101-triage', 'M101', null, ...window)],
      ['task review-fix carrying a milestone', 'invalid_scope', reviewRows('rf-task', 'review-fix/TASK-001', 'M101', null, ...window)]]) {
      intact(readM(committedOwner(T01_27H, rows)), counter, label);
    }
    intact(readM(committedOwner([{ unit: 'execute-task/T01', slice: 'S02', segments: [[0, 27 * HOUR]] }], w1Rows())), 'foreign', 'committed begin of S02');
    // Cross-host segments of one unit stay continuation_unknown and are never a target.
    const hosts = [{ unit: 'execute-task/T01', segments: [[0, 10 * HOUR, 'claude'], [12 * HOUR, 27 * HOUR, 'codex']] }];
    const plain = readM(committedOwner(hosts)), crossed = readM(committedOwner(hosts, w1Rows()));
    assert.deepStrictEqual([crossed.excluded.continuation_unknown, crossed.phases['execute-task'].n, crossed.review_fix.discounted_ms, crossed.review_fix.attempts.no_sample],
      [plain.excluded.continuation_unknown, 0, 0, 1]);
    assert.ok(plain.excluded.continuation_unknown >= 1);
  });
  test('issue342 unknown stays unknown: unclassified waits and absent, oversized, invalid or linked global logs keep samples and history available', () => {
    const unclassified = readM(committedOwner(T01_27H, [{ ts: iso(T0), event: 'dispatch', unit: 'execute-task/T09', dispatch_id: 'not-review' }]));
    assert.deepStrictEqual([executeStats(unclassified)[2], unclassified.review_fix.status], [97200000, 'none']);
    assert.ok(unclassified.limitations.some(l => /sem classificação/.test(l) && /desconhecidas/.test(l)));
    const absent = historyFor('sem-pausa').history;
    assert.deepStrictEqual([absent.status, absent.review_fix.status, absent.review_fix.reason], ['available', 'absent', null]);
    assert.ok(absent.limitations.includes('Sem log global do owner: review-fix não pôde ser separado das amostras'));
    const text = w1Rows().map(row => JSON.stringify(row)).join('\n') + '\n';
    const closedSource = history => history.sources.find(s => s.path === '.gsd/milestones/M101/M101-events.jsonl');
    const refused = (write, reason) => {
      const cwd = committedOwner(T01_27H);
      write(cwd);
      const history = readM(cwd);
      assert.deepStrictEqual([history.status, closedSource(history).status, executeStats(history)[2], history.review_fix.status, history.review_fix.reason, history.review_fix.discounted_ms],
        ['available', 'available', 97200000, 'unavailable', reason, 0], reason);
      assert.ok(history.limitations.includes('Log global do owner indisponível (' + reason + '): review-fix não separado das amostras; custo desconhecido'), reason);
      return history;
    };
    const big = refused(cwd => fs.writeFileSync(globalLog(cwd), Buffer.concat([Buffer.from(text), Buffer.alloc(16 * 1024 * 1024 + 1 - Buffer.byteLength(text), 0x0a)])), 'review-fix-source-too-large');
    assert.strictEqual(big.review_fix.source.bytes, 16 * 1024 * 1024 + 1, 'real size, never truncated');
    refused(cwd => fs.writeFileSync(globalLog(cwd), Buffer.concat([Buffer.from(text), Buffer.from([0xff, 0x0a])])), 'review-fix-source-invalid');
    refused(cwd => { writeRows(cwd, w1Rows()); const moved = path.join(root(false), 'forge'); fs.renameSync(path.join(cwd, '.gsd/forge'), moved); link(moved, path.join(cwd, '.gsd/forge')); }, 'review-fix-source-link');
    // 3 MiB: refused as the 2 MiB shared-tasks source, still read by the 16 MiB attribution reader.
    const cwd = committedOwner(T01_27H), filler = JSON.stringify({ event: 'synthetic-padding', note: 'x'.repeat(1000) }) + '\n';
    let padded = text;
    while (Buffer.byteLength(padded) <= 3 * 1024 * 1024) padded += filler;
    fs.writeFileSync(globalLog(cwd), padded);
    const independent = readM(cwd);
    assert.deepStrictEqual([independent.sources.find(s => s.kind === 'shared-tasks').reason, independent.review_fix.status, executeStats(independent)[2]], ['history-source-too-large', 'applied', 5400000]);
    assert.ok(independent.limits.max_source_bytes === 2 * 1024 * 1024 && independent.review_fix.source.max_bytes === 16 * 1024 * 1024);
  });
  test('issue342 standalone task: review-fix of a task discounts only its own shared-tasks sample', () => {
    const task = eventRows('TASK-001', [{ phase: 'execute-task', durations_ms: [28 * HOUR] }], T0);
    const taskFix = reviewRows('rf-task-001', 'review-fix/TASK-001', null, null, T0 + HOUR, T0 + 26.5 * HOUR);
    const otherFix = reviewRows('rf-task-002', 'review-fix/TASK-002', null, null, T0 + HOUR, T0 + 26.5 * HOUR);
    const cwd = committedOwner(T01_27H, [...task, ...taskFix, ...otherFix]), before = snapshot(cwd), history = readM(cwd);
    assert.deepStrictEqual(snapshot(cwd), before, 'no transaction is invented for tasks');
    const pooled = h => [h.phases['execute-task'].min_ms, h.phases['execute-task'].max_ms];
    assert.deepStrictEqual([pooled(history), history.review_fix.discounted_ms, history.review_fix.attempts.used, history.review_fix.attempts.no_sample],
      [[2.5 * HOUR, 27 * HOUR], 25.5 * HOUR, 1, 1], 'TASK-001 discounted, M101 sample intact');
    assert.deepStrictEqual(history.sources.map(s => [s.kind, s.samples]), [['milestone', { 'execute-task': 1 }], ['shared-tasks', { 'execute-task': 1 }]]);
    // A slice review-fix never adjusts a task sample.
    const slice = readM(committedOwner(T01_27H, [...task, ...w1Rows()]));
    assert.deepStrictEqual([pooled(slice), slice.review_fix.discounted_ms], [[1.5 * HOUR, 28 * HOUR], 25.5 * HOUR]);
  });
  test('issue342 compatibility: a history without review_fix stays valid, viewable and renderable with the unchanged header', () => {
    const history = readM(committedOwner(T01_27H, w1Rows()));
    assert.deepStrictEqual(Object.keys(history.excluded), ['open', 'ambiguous', 'unfinished_paused', 'zero_duration']);
    const legacy = structuredClone(history);
    delete legacy.review_fix;
    legacy.limitations = legacy.limitations.filter(l => !/review-fix|log global/i.test(l));
    const { record, options_sha256: sha } = materialized(validCase('completa-tres-posicoes'), legacy);
    assert.strictEqual(rt.optionsView(record).status, 'valid');
    assert.deepStrictEqual(time.readOptions({ cwd: prepareFor(record), milestone: M, options_sha256: sha }).record, record);
    const markdown = options.renderOptionsMarkdown(record);
    assert.ok(!markdown.includes('Review-fix separado') && !/review-fix/i.test(markdown), 'no review-fix line');
    assert.strictEqual(markdown.split('\n').find(l => l.startsWith('- Números:')), '- Números: consumo de trabalho e coordenação identificáveis, não tempo de parede; só pausas explicitamente registradas ficam fora; '
      + 'esperas humanas, de CI, externas ou sem classificação não são separadas por esta evidência (desconhecidas) e podem permanecer nas amostras; overhead desconhecido fica explícito.');
    assert.deepStrictEqual([options.ESTIMATE_POLICY, options.HISTORY_LIMITS, options.CALIBRATED_SAMPLES], [{ id: 'forge-milestone-time-estimate', version: 1 }, { max_sources: 64, max_total_bytes: 64 * 1024 * 1024, max_source_bytes: MAX_BYTES }, 5]);
    assert.deepStrictEqual(options.MEASURABLE_PHASES, ['plan-milestone', 'discuss-milestone', 'research-milestone', 'plan-slice', 'research-slice', 'execute-task', 'complete-slice', 'complete-milestone']);
  });
  test('exports-constants-and-import-purity', () => {
    for (const name of ['PROPOSAL_SCHEMA_VERSION', 'POSITION_IDS', 'MEASURABLE_PHASES', 'NODE_KINDS', 'ESTIMATE_POLICY', 'HISTORY_LIMITS', 'validateProposal', 'validateProposalContent',
      'inspectProposalContent', 'readHistory', 'estimate', 'materialize', 'renderOptionsMarkdown', 'selectionRounds', 'canonicalAnswer', 'parseOperatorCeiling', 'formatDuration', 'main']) assert.ok(options[name] !== undefined, name);
    assert.deepStrictEqual(options.POSITION_IDS, ['curta', 'media', 'longa']);
    assert.deepStrictEqual(options.MEASURABLE_PHASES, ['plan-milestone', 'discuss-milestone', 'research-milestone', 'plan-slice', 'research-slice', 'execute-task', 'complete-slice', 'complete-milestone']);
    assert.deepStrictEqual(options.NODE_KINDS, ['preparation', 'slice', 'integration', 'review', 'corrections']);
    assert.deepStrictEqual(options.NODE_KINDS, [...rt.ALLOCATION_KINDS]);
    assert.deepStrictEqual(options.ESTIMATE_POLICY, { id: 'forge-milestone-time-estimate', version: 1 });
    assert.deepStrictEqual(options.HISTORY_LIMITS, { max_sources: 64, max_total_bytes: 64 * 1024 * 1024, max_source_bytes: MAX_BYTES });
    assert.ok(options.PROPOSAL_ITEM_STATES.every(s => time.ITEM_STATES.includes(s)));
    // Policy thresholds are sample counts and factor bounds: no duration constant exists in the module surface.
    assert.ok(Number.isInteger(options.CALIBRATED_SAMPLES) && options.CALIBRATED_SAMPLES === 5);
    const file = require.resolve('./forge-milestone-options'), Module = require('module'), previous = Module._load, local = [];
    Module._load = function (id, parent, ...args) { if (parent?.filename === file && id.startsWith('.')) local.push(id); return previous.call(this, id, parent, ...args); };
    const io = ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'lstatSync', 'mkdirSync', 'openSync', 'appendFileSync'];
    const saved = Object.fromEntries(io.map(k => [k, fs[k]])), source = fs.readFileSync(file, 'utf8');
    try {
      for (const k of io) fs[k] = () => { throw new Error('import I/O ' + k); };
      const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths; mod._compile(source, file);
    } finally { for (const k of io) fs[k] = saved[k]; Module._load = previous; }
    assert.deepStrictEqual(local, [], 'local dependencies are lazy at import');
  });
  test('declared-artifacts-minimum-lines-and-no-stubs', () => {
    for (const [file, minimum] of [['shared/schemas/forge-milestone-options.schema.json', 150], ['scripts/forge-milestone-options.js', 450], ['scripts/forge-milestone-options.test.js', 340],
      ['scripts/fixtures/milestone-options/proposals.json', 220], ['scripts/fixtures/milestone-options/history-cases.json', 80]]) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.ok(source.split('\n').length >= minimum, file);
      if (file.endsWith('options.js')) assert.ok(!/\b(?:TODO|TBD|FIXME)\b/.test(source), 'stub marker in ' + file);
    }
  });
  test('schema-required-and-enums-match-the-validator', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/schemas/forge-milestone-options.schema.json'), 'utf8')), defs = schema.$defs;
    assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema'); assert.strictEqual(schema.$id, 'urn:forge:milestone-options:v1');
    const pairs = { proposal: schema, scope_item: defs.scopeItem, endpoint: defs.endpoint, position: defs.position, node: defs.node, range_judgment: defs.rangeJudgment,
      factor_judgment: defs.factorJudgment, parallel_group: defs.parallelGroup, deferral: defs.deferral, linked_task: defs.linkedTask, criteria: defs.linkedTask.properties.criteria };
    for (const [name, def] of Object.entries(pairs)) {
      assert.deepStrictEqual(def.required, options.REQUIRED[name], name);
      assert.deepStrictEqual(Object.keys(def.properties), options.REQUIRED[name], name + ' properties');
      assert.strictEqual(def.additionalProperties, false, name);
    }
    assert.deepStrictEqual(defs.endpoint.properties.items.required, [...time.ENDPOINT_ITEMS]);
    assert.deepStrictEqual(defs.itemState.enum, options.PROPOSAL_ITEM_STATES);
    assert.deepStrictEqual(defs.phases.propertyNames.enum, options.MEASURABLE_PHASES);
    assert.deepStrictEqual([defs.phases.additionalProperties.minimum, defs.phases.additionalProperties.maximum], [1, 999]);
    assert.deepStrictEqual(defs.node.properties.kind.enum, options.NODE_KINDS);
    assert.deepStrictEqual(defs.position.properties.id.enum, options.POSITION_IDS);
    assert.deepStrictEqual(defs.position.properties.status.enum, options.POSITION_STATUSES);
    assert.deepStrictEqual(defs.scopeItem.properties.source.enum, options.SCOPE_SOURCES);
    assert.deepStrictEqual(schema.properties.recommended.oneOf[1].enum, options.POSITION_IDS);
    assert.deepStrictEqual([defs.factorJudgment.properties.factor_low.minimum, defs.factorJudgment.properties.factor_high.maximum], [options.FACTOR_MIN, options.FACTOR_MAX]);
    assert.strictEqual(defs.deferral.properties.consent.const, 'required');
    assert.strictEqual(defs.endpoint.properties.kind.const, 'verified-integrated-delivery');
    assert.ok(schema.description.includes(String(options.MAX_PROPOSAL_BYTES)));
  });
  test('valid-fixture-proposals-pass-and-every-refusal-is-named-with-its-path', () => {
    for (const row of PROPOSALS.valid) {
      const proposal = proposalOf(row.input), result = options.validateProposal(proposal, M);
      assert.deepStrictEqual(result, { valid: true }, row.name + ' ' + JSON.stringify(result));
      assert.deepStrictEqual(proposal.positions.filter(p => p.status === 'viable').map(p => p.id), row.expect.viable, row.name);
    }
    const seen = new Set();
    for (const row of PROPOSALS.refusals) {
      const result = options.validateProposal(proposalOf(row.input), M);
      assert.deepStrictEqual(result, { valid: false, ...row.expect }, row.name);
      assert.ok(options.REFUSALS.includes(result.reason)); seen.add(result.reason);
      // The refusal names path and reason only; private text never echoes.
      assert.ok(!JSON.stringify(result).includes('alguem') && !JSON.stringify(result).includes('abc'));
    }
    // The comparison-limit refusal needs an injected step budget and is proven in the labelled-graph identity test.
    assert.deepStrictEqual([...seen].sort(), options.REFUSALS.filter(r => r !== 'options-comparison-limit').sort(), 'one fixture per closed refusal');
    assert.strictEqual(options.validateProposal([], M).reason, 'options-schema-invalid');
    assert.strictEqual(options.validateProposal(PROPOSALS.base, 'M999').reason, 'options-milestone-mismatch');
  });
  test('content-validators-apply-the-same-validator-to-the-sidecar-json-text', () => {
    const text = JSON.stringify(PROPOSALS.base, null, 2);
    assert.strictEqual(options.validateProposalContent(text, M), true);
    assert.deepStrictEqual(options.inspectProposalContent(text, M).proposal, PROPOSALS.base);
    assert.deepStrictEqual(options.inspectProposalContent('{ not json', M), { valid: false, reason: 'options-schema-invalid', path: '(json)' });
    const refusal = PROPOSALS.refusals.find(r => r.name === 'ciclo');
    assert.deepStrictEqual(options.inspectProposalContent(JSON.stringify(proposalOf(refusal.input)), M), { valid: false, ...refusal.expect });
    assert.strictEqual(options.validateProposalContent(JSON.stringify(PROPOSALS.base), 'M002'), false);
    const big = structuredClone(PROPOSALS.base); big.positions[0].risks = Array.from({ length: 32 }, () => 'r'.repeat(999));
    for (const p of big.positions) for (const n of p.nodes) n.activities = Array.from({ length: 32 }, () => 'a'.repeat(200));
    assert.deepStrictEqual(options.validateProposal(big, M), { valid: false, reason: 'options-schema-invalid', path: '(tamanho)' });
    assert.strictEqual(options.validateProposalContent(' '.repeat(options.MAX_PROPOSAL_BYTES + 1), M), false);
  });
  test('history-cases-are-bounded-read-only-deterministic-and-aggregate-only', () => {
    for (const row of HISTORIES.cases) {
      const cwd = buildHistory(root(), row.input), before = snapshot(cwd);
      const history = options.readHistory({ cwd, milestone: M }), again = options.readHistory({ cwd, milestone: M });
      assert.deepStrictEqual(snapshot(cwd), before, row.name + ' wrote or touched history');
      assert.deepStrictEqual(again, history, row.name + ' is not deterministic');
      assert.strictEqual(history.status, row.expect.status, row.name); assert.strictEqual(history.observations, row.expect.observations, row.name);
      if (row.expect.sources) {
        assert.strictEqual(history.sources.length, row.expect.sources.length, row.name);
        row.expect.sources.forEach((s, i) => { for (const [k, v] of Object.entries(s)) assert.deepStrictEqual(history.sources[i][k], v, row.name + ' ' + k); });
      }
      for (const [phase, stats] of Object.entries(row.expect.phases || {})) for (const [k, v] of Object.entries(stats)) assert.strictEqual(history.phases[phase][k], v, row.name + ' ' + phase + ' ' + k);
      if (row.expect.failures !== undefined) assert.strictEqual(history.failures, row.expect.failures);
      if (row.expect.excluded) assert.deepStrictEqual(history.excluded, row.expect.excluded);
      const text = JSON.stringify(history);
      assert.ok(!text.includes(cwd) && !text.includes(cwd.replace(/\\/g, '/')) && !/"(?:start|end|unit|intervals|begin_key)"/.test(text), row.name + ' leaked raw data');
      assert.ok(!/U\d+/.test(text), row.name + ' leaked unit identities');
      for (const s of history.sources) {
        assert.ok(!path.isAbsolute(s.path) && /^\.gsd\//.test(s.path));
        if (s.status === 'available') assert.ok(/^[a-f0-9]{64}$/.test(s.sha256) && s.bytes > 0);
        // Unavailable rows carry a reason; only bytes actually read (a corrupt source) carry their real hash.
        else assert.ok(s.reason && (s.sha256 === null || s.reason === 'history-source-invalid' && /^[a-f0-9]{64}$/.test(s.sha256)), 'unavailable has a reason and no invented hash');
      }
      assert.ok(time.isPublicData(history), row.name);
    }
    const over = historyFor('fonte-acima-do-limite').history.sources[0];
    assert.ok(over.bytes > MAX_BYTES, 'oversized source keeps its real size, never truncated');
    assert.deepStrictEqual(over.samples, {});
    assert.throws(() => options.readHistory({ cwd: root(), milestone: 'TASK-001' }), e => e.code === 'history-milestone-invalid');
  });
  test('history-source-limits-and-links-are-refused-explicitly', () => {
    const cwd = buildHistory(root(), historyCase('suficiente').input), moved = path.join(root(false), 'moved');
    fs.renameSync(path.join(cwd, '.gsd/milestones/M101'), moved); link(moved, path.join(cwd, '.gsd/milestones/M101'));
    const before = snapshot(cwd), history = options.readHistory({ cwd, milestone: M });
    assert.deepStrictEqual(history.sources.map(s => [s.path, s.status, s.reason]), [['.gsd/milestones/M102/M102-events.jsonl', 'available', null], ['.gsd/milestones/M101/M101-events.jsonl', 'unavailable', 'history-source-link']]);
    assert.strictEqual(history.phases['execute-task'].n, 3); assert.deepStrictEqual(snapshot(cwd), before);
    const ledgerOwner = buildHistory(root(), historyCase('suficiente').input), ledgerMoved = path.join(root(false), 'ledger');
    fs.renameSync(path.join(ledgerOwner, '.gsd/ledger'), ledgerMoved); link(ledgerMoved, path.join(ledgerOwner, '.gsd/ledger'));
    const refused = options.readHistory({ cwd: ledgerOwner, milestone: M });
    assert.deepStrictEqual([refused.status, refused.reason, refused.observations, refused.sources.length], ['unavailable', 'history-link-refused', 0, 0]);
    // More closed milestones than the canonical source limit: deterministic descending order, the rest only counted.
    const many = root(), ledger = Array.from({ length: options.HISTORY_LIMITS.max_sources + 3 }, (_, i) => 'M' + String(200 + i));
    buildHistory(many, { ledger, events: Object.fromEntries(ledger.map(m => [m, [{ phase: 'execute-task', durations_ms: [600000] }]])) });
    const limited = options.readHistory({ cwd: many, milestone: M });
    assert.strictEqual(limited.sources.length, options.HISTORY_LIMITS.max_sources); assert.strictEqual(limited.omitted_sources, 3);
    assert.deepStrictEqual(limited.sources.map(s => s.path), [...ledger].sort().reverse().slice(0, 64).map(m => '.gsd/milestones/' + m + '/' + m + '-events.jsonl'));
  });
  test('estimator-follows-policy-v1-without-duration-constants', () => {
    const empty = options.readHistory({ cwd: root(), milestone: M });
    for (const row of PROPOSALS.valid.filter(r => r.expect.empty_history)) {
      const result = options.estimate(proposalOf(row.input), empty);
      assert.deepStrictEqual(result.policy, options.ESTIMATE_POLICY);
      for (const [id, want] of Object.entries(row.expect.empty_history)) {
        const e = result.positions.find(p => p.position_id === id);
        assert.strictEqual(e.status, want.status, row.name + ' ' + id);
        for (const k of ['low_ms', 'high_ms', 'ceiling_ms', 'confidence']) if (want[k] !== undefined) assert.strictEqual(e[k], want[k], row.name + ' ' + id + ' ' + k);
        if (want.critical_high_ms) { assert.strictEqual(e.critical_path.high_ms, want.critical_high_ms); assert.notStrictEqual(e.critical_path.high_ms, e.serial_sum.high_ms); assert.match(e.critical_path.label, /sem crédito/); assert.match(e.serial_sum.label, /sem crédito de paralelismo/); }
        if (want.task) assert.deepStrictEqual(e.linked_task_horizon, want.task);
        if (want.chain) { assert.strictEqual(e.chain.low_ms, want.chain.low_ms); assert.strictEqual(e.chain.high_ms, want.chain.high_ms); assert.match(e.chain.label, /cadeia/); assert.strictEqual(e.chain.basis, 'milestone-plus-linked-task'); }
        if (want.status !== 'estimated') assert.deepStrictEqual([e.low_ms, e.high_ms, e.ceiling_ms, e.chain], [null, null, null, null], row.name + ' ' + id + ' invented a number');
        if (e.status !== 'infeasible') { assert.strictEqual(e.parallel.credited_ms, 0); assert.ok(e.uncertainty && Array.isArray(e.uncertainty.judgment_nodes)); }
      }
    }
    // Negative proof: empty history and no judgment basis gives no number anywhere.
    const none = options.estimate(validCase('sem-julgamento'), empty);
    for (const e of none.positions) {
      assert.deepStrictEqual(numbersOf({ low: e.low_ms, high: e.high_ms, ceiling: e.ceiling_ms, nodes: (e.nodes || []).map(n => [n.low_ms, n.high_ms]), chain: e.chain }), []);
    }
    assert.deepStrictEqual(none.positions[0].uncertainty.insufficient_nodes, ['PREP', 'N1', 'N2', 'N3', 'N4', 'INT', 'REV', 'COR']);
    const curta = options.estimate(validCase('completa-tres-posicoes'), empty).positions[0];
    assert.deepStrictEqual(curta.uncertainty.judgment_nodes, ['PREP', 'N1', 'N2', 'N3', 'N4', 'INT', 'REV', 'COR']);
    assert.deepStrictEqual(curta.coverage, { preparation: true, integration: true, review: true, corrections: true });
    assert.ok(curta.nodes.every(n => n.basis === 'judgment' && n.confidence === 'low' && n.sources.length));
    const media = options.estimate(validCase('completa-tres-posicoes'), empty).positions[1];
    assert.deepStrictEqual(media.nodes.map(n => [n.id, n.side]), [['PREP', 'milestone'], ['N1', 'milestone'], ['N2', 'milestone'], ['N3', 'deferred'], ['N4', 'task'], ['INT', 'milestone'], ['REV', 'milestone'], ['COR', 'milestone']]);
    assert.strictEqual(media.linked_task_status, 'estimated');
    assert.strictEqual(media.chain.low_ms, media.low_ms + media.linked_task_horizon.low_ms, 'chain is milestone plus task, never a reduction');
    assert.ok(media.chain.high_ms > media.high_ms);
    const longa = options.estimate(validCase('completa-tres-posicoes'), empty).positions[2];
    assert.deepStrictEqual([longa.status, longa.low_ms, longa.high_ms, longa.ceiling_ms, longa.confidence], ['infeasible', null, null, null, null]);
    assert.throws(() => options.estimate(proposalOf(PROPOSALS.refusals[0].input), empty), e => e.code === 'options-schema-invalid');
  });
  test('estimator-uses-sufficient-scarce-and-paused-history-as-evidence', () => {
    const stripped = validCase('sem-julgamento'), judged = validCase('completa-tres-posicoes');
    for (const name of ['suficiente', 'escasso']) {
      const { history } = historyFor(name), row = historyCase(name), e = options.estimate(stripped, history).positions[0];
      for (const [k, v] of Object.entries(row.expect.stripped_curta)) assert.strictEqual(e[k], v, name + ' ' + k);
      // Independent recomputation: phase counts × p50/p90 of the fixture's own expectations.
      if (name === 'suficiente') {
        const sum = key => stripped.positions[0].nodes.reduce((t, n) => t + Object.entries(n.phases).reduce((s, [p, c]) => s + c * row.expect.phases[p][key], 0), 0);
        assert.deepStrictEqual([e.low_ms, e.high_ms], [sum('p50_ms'), sum('p90_ms')]);
        assert.strictEqual(e.uncertainty.min_samples, 5); assert.ok(e.uncertainty.ratio_samples > 0 && e.uncertainty.max_dispersion >= 1);
        const calibrated = options.estimate(judged, history).positions[0];
        assert.ok(calibrated.nodes.every(n => n.basis === 'history'), 'calibrated history wins over the judgment');
        const withFactor = applyPatches(stripped, [{ op: 'set', path: ['positions', 0, 'nodes', 5, 'judgment'], value: { factor_low: 1, factor_high: 2, reason: 'Integração mais larga que a média', sources: ['scripts/forge-unit-controller.js'] } }]);
        const f = options.estimate(withFactor, history).positions[0].nodes[5];
        assert.deepStrictEqual([f.basis, f.low_ms, f.high_ms, f.factor.high], ['history', 1200000, 3600000, 2]);
      } else {
        assert.ok(e.nodes.every(n => n.basis === 'history' && n.confidence === 'low'));
        const j = options.estimate(judged, history).positions[0];
        for (const [k, v] of Object.entries(row.expect.judged_curta)) assert.strictEqual(j[k], v, 'scarce judged ' + k);
        assert.ok(j.nodes.every(n => n.basis === 'judgment'), 'a node judgment replaces scarce phases and is not summed with them');
      }
    }
    // A long synthetic pause does not inflate the consumption forecast of the same work.
    const paused = historyFor('falhas-e-pausas').history, plain = historyFor('sem-pausa').history;
    assert.deepStrictEqual(paused.phases['execute-task'], { ...plain.phases['execute-task'], sources: paused.phases['execute-task'].sources });
    const onlyExecute = applyPatches(stripped, [{ op: 'set', path: ['positions', 0, 'nodes', 5, 'phases'], value: { 'execute-task': 1 } }]);
    assert.deepStrictEqual(options.estimate(onlyExecute, paused).positions[0].nodes[5], options.estimate(onlyExecute, plain).positions[0].nodes[5]);
    assert.strictEqual(options.estimate(onlyExecute, paused).positions[0].nodes[5].high_ms, 600000);
    assert.ok(!JSON.stringify(options.estimate(judged, paused)).includes('observed_span'), 'no span/active multiplier');
  });
  test('materialize-is-deterministic-sanitized-and-interoperates-with-the-t01-store', () => {
    const { history } = historyFor('suficiente'), proposal = validCase('completa-tres-posicoes');
    const a = options.materialize({ milestone: M, proposal, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW });
    const reverse = v => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverse(v[k])])) : v;
    const shuffled = reverse(proposal);
    assert.notStrictEqual(JSON.stringify(shuffled), JSON.stringify(proposal));
    const b = options.materialize({ milestone: M, proposal: shuffled, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW });
    assert.strictEqual(a.options_sha256, b.options_sha256, 'key order does not change the canonical digest');
    assert.strictEqual(a.options_sha256, digest(a.record)); assert.strictEqual(a.record.proposal_sha256, digest(a.record.proposal));
    assert.ok(!Object.hasOwn(a.record, 'options_sha256') && !JSON.stringify(a.record).includes(a.options_sha256), 'no self-referential options digest');
    assert.deepStrictEqual(Object.keys(a.record).sort(), ['estimate', 'history', 'inputs', 'materialized_at', 'milestone', 'policy', 'producer_basis', 'proposal', 'proposal_sha256', 'schema_version']);
    assert.deepStrictEqual(a.record.producer_basis, { attested: false, frozen_at: PRODUCER.frozen_at, frozen_before: 'begin', history_fingerprint_sha256: digest(a.record.history),
      identity_sha256: PRODUCER.identity_sha256, inputs_fingerprint_sha256: digest(a.record.inputs), producer: 'forge-planner' });
    assert.strictEqual(a.record.materialized_at, new Date(NOW).toISOString()); assert.ok(time.isPublicData(a.record));
    assert.ok(!JSON.stringify(a.record).includes(os.tmpdir()) && !JSON.stringify(a.record).includes(os.tmpdir().replace(/\\/g, '/')));
    // Same input/history/instant gives the same digest in another process.
    const inputFile = path.join(root(false), 'materialize-input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ milestone: M, proposal, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW }));
    const child = spawnSync(process.execPath, ['-e', 'const fs=require("fs");const o=require(process.env.FORGE_T02_MODULE);process.stdout.write(o.materialize(JSON.parse(fs.readFileSync(process.env.FORGE_T02_INPUT,"utf8"))).options_sha256)'],
      { encoding: 'utf8', env: { ...process.env, FORGE_T02_MODULE: SCRIPT, FORGE_T02_INPUT: inputFile } });
    assert.strictEqual(child.status, 0, child.stderr); assert.strictEqual(child.stdout, a.options_sha256);
    // The actual output is the raw payload of recordOptions: same digest, normalized by optionsView, graph and partition valid.
    const cwd = root(); time.recordEnrollment({ cwd, milestone: M, source: 'owner', now: NOW - 120000 });
    const stored = time.recordOptions({ cwd, milestone: M, record: a.record });
    assert.strictEqual(stored.options_sha256, a.options_sha256); assert.deepStrictEqual(time.readOptions({ cwd, milestone: M, options_sha256: a.options_sha256 }).record, a.record);
    const view = rt.optionsView(stored.record);
    assert.strictEqual(view.status, 'valid'); assert.deepStrictEqual(view.options.map(o => o.id), ['curta', 'media', 'longa']);
    for (const option of view.options) {
      const graph = rt.sourceGraph(option, option.positions[0]);
      assert.strictEqual(graph.status, 'valid'); assert.strictEqual(rt.selectedPartition(graph).status, 'valid');
    }
    assert.deepStrictEqual(view.options[1].positions[0].linked_task.horizon, a.record.estimate.positions[1].linked_task_horizon);
    assert.deepStrictEqual(Object.keys(a.record.estimate.positions[1].linked_task_horizon), ['ceiling_ms', 'high_ms', 'low_ms']);
    // Worker JSON never attests owner inputs: absolute paths, missing fingerprints or a future freeze are refused before anything is returned.
    for (const [bad, code] of [[{ inputs: inputs({ code_files: [{ path: 'C:/root/x.js', sha256: digest('x') }] }) }, 'options-inputs-invalid'],
      [{ inputs: { ...inputs(), code_root: { identity_sha256: 'x', revision: 'r', workspace: 'w' } } }, 'options-inputs-invalid'],
      [{ producer_basis: { ...PRODUCER, frozen_at: new Date(NOW + 1000).toISOString() } }, 'options-producer-invalid'],
      [{ producer_basis: { ...PRODUCER, attested: true } }, 'options-producer-invalid'],
      [{ proposal: proposalOf(PROPOSALS.refusals.find(r => r.name === 'marcador-data').input) }, 'options-text-invalid']]) {
      assert.throws(() => options.materialize({ milestone: M, proposal, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW, ...bad }), e => e.code === code, code);
    }
    // Relevant change before the choice invalidates; after the choice the chosen history stays.
    const changed = inputs({ code_files: [{ path: 'scripts/forge-milestone-time.js', sha256: digest('synthetic:time-v2') }] });
    assert.deepStrictEqual(options.inputsFreshness(a.record, inputs()), { status: 'fresh', changed: [] });
    assert.deepStrictEqual(options.inputsFreshness(a.record, changed), { status: 'stale', changed: ['code_files:scripts/forge-milestone-time.js'] });
    assert.deepStrictEqual(options.inputsFreshness(a.record, changed, { selected: true }), { status: 'historical', changed: [] });
  });
  test('large-fixture-measures-proposal-history-and-record-against-t01-limits', () => {
    const big = structuredClone(PROPOSALS.base);
    for (const p of big.positions) for (const n of p.nodes) n.activities = Array.from({ length: 18 }, (_, i) => 'atividade sintética ' + i + ' ' + 'x'.repeat(200));
    const bytes = Buffer.byteLength(JSON.stringify(big));
    assert.ok(bytes > 100 * 1024 && bytes <= options.MAX_PROPOSAL_BYTES, 'near the proposal limit: ' + bytes);
    assert.deepStrictEqual(options.validateProposal(big, M), { valid: true });
    const cwd = root(), ledger = Array.from({ length: options.HISTORY_LIMITS.max_sources }, (_, i) => 'M' + String(300 + i));
    buildHistory(cwd, { ledger, events: Object.fromEntries(ledger.map(m => [m, options.MEASURABLE_PHASES.map(phase => ({ phase, durations_ms: [600000, 900000] }))])) });
    const history = options.readHistory({ cwd, milestone: M });
    assert.strictEqual(history.sources.length, 64);
    const result = options.materialize({ milestone: M, proposal: big, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW });
    assert.ok(result.bytes <= options.MAX_RECORD_BYTES, 'maximal proposal plus maximal history fits the T01 options store: ' + result.bytes);
    time.recordEnrollment({ cwd, milestone: M, source: 'owner', now: NOW - 120000 });
    assert.strictEqual(time.recordOptions({ cwd, milestone: M, record: result.record }).options_sha256, result.options_sha256);
    const files = Array.from({ length: 256 }, (_, i) => ({ path: 'scripts/' + 'd'.repeat(450) + '/file-' + i + '.js', sha256: digest('f' + i) }));
    const before = snapshot(cwd);
    assert.throws(() => options.materialize({ milestone: M, proposal: big, inputs: inputs({ code_files: files }), producer_basis: PRODUCER, history, now: NOW }), e => e.code === 'options-record-too-large');
    assert.deepStrictEqual(snapshot(cwd), before, 'size refusal writes nothing');
  });
  test('render-is-deterministic-pt-br-and-free-of-absolute-paths', () => {
    // media keeps a node with no judgment and only an unsampled phase, so it stays evidence-insufficient over the scarce history.
    const proposal = applyPatches(validCase('media-base-incompleta'), [{ op: 'set', path: ['positions', 1, 'nodes', 7, 'phases'], value: { 'discuss-milestone': 1 } }]);
    const { history } = historyFor('escasso'), record = materialized(proposal, history).record;
    const markdown = options.renderOptionsMarkdown(record);
    assert.strictEqual(options.renderOptionsMarkdown(structuredClone(record)), markdown);
    for (const piece of ['# Opções de prazo — M001', 'Estratégia:', 'Escolhas técnicas:', 'Entregas:', 'Divisão preliminar:', 'Caminho crítico:', 'Paralelismo declarado:', 'Crédito: nenhum',
      'Verificações:', 'Revisão:', 'Margem de correção:', 'Riscos:', 'Incertezas:', 'Adiamentos:', 'consentimento explícito exigido', 'Task ligada:', 'Escopo movido: SC4',
      'Critérios da milestone:', 'Critérios da task:', 'Horizonte da task:', 'Previsão da cadeia (milestone + task, não reduz o total): desconhecida', 'Criar e iniciar após prova', 'Criar sem iniciar', 'Não criar task',
      'Publicação: pendente', 'Instalação: não se aplica', 'UAT manual: incluído', 'Esperas externas: adiado', 'sha256 ', 'amostras', 'julgamento rotulado', 'teto proposto', 'confiança baixa',
      'Situação: inviável', 'Previsão: evidência insuficiente', 'nenhuma opção vem pré-selecionada']) assert.ok(markdown.includes(piece), piece);
    const sections = markdown.split('\n## ');
    const longa = sections.find(s => s.startsWith('Posição longa')), media = sections.find(s => s.startsWith('Posição media'));
    assert.ok(!/\d+ (?:h|min|d)\b/.test(longa.replace(/fases [^;]*;/g, '')), 'infeasible shows no number');
    assert.ok(!/Previsão \(/.test(media) && !/teto proposto/.test(media), 'evidence-insufficient shows no forecast');
    assert.ok(!markdown.includes(os.tmpdir()) && !/[A-Za-z]:\\/.test(markdown));
    assert.throws(() => options.renderOptionsMarkdown({ ...record, proposal: { ...record.proposal, milestone: 'M002' } }), e => e.code === 'options-record-invalid');
  });
  test('format-duration-and-operator-ceiling-parsing', () => {
    assert.deepStrictEqual([0, 30000, 60000, 3600000, 5400000, 90000000, null].map(options.formatDuration), ['0 s', '30 s', '1 min', '1 h', '1 h 30 min', '1 d 1 h', 'desconhecido']);
    const cases = { '1m': 60000, '90m': 5400000, '6h': 21600000, '2d': 172800000, '365d': 31536000000, '600000': 600000, ' 3h ': 10800000,
      '': null, '0': null, '0h': null, '-5m': null, '1.5h': null, '2w': null, 'seis horas': null, '59999': null, '366d': null, '3 h': null, '1e6': null };
    for (const [input, want] of Object.entries(cases)) assert.strictEqual(options.parseOperatorCeiling(input), want, JSON.stringify(input));
    assert.strictEqual(options.parseOperatorCeiling(null), null);
  });
  test('rounds-with-two-offered-positions-keep-mode-then-position-and-linked-task-authorizations', () => {
    const record = materialized().record, sha = digest(record), suffix = sha.slice(0, 12), before = structuredClone(record);
    const mode = roundsOk(options.selectionRounds(record, {}));
    assert.deepStrictEqual([mode.id, mode.header, mode.decision_set], ['time-mode-' + suffix, 'Prazo', 'milestone-time-activation']);
    assert.deepStrictEqual(mode.options.map(o => o.answer), ['mode:position', 'mode:operator-ceiling', 'no-contract']); assert.strictEqual(mode.recommended, undefined);
    const position = walkRounds(record, ['mode:position']).result;
    assert.deepStrictEqual([position.id, position.options.map(o => o.answer), position.recommended], ['time-position-' + suffix, ['option:curta', 'option:media'], 'Escopo completo (curta)']);
    assert.ok(position.options.every(o => /teto proposto/.test(o.description) && /milestone .*; task .*; cadeia/.test(o.description)));
    const full = walkRounds(record, ['mode:position', 'option:curta']).result;
    assert.deepStrictEqual({ ...full, decisions: full.decisions.map(d => d.answer) }, { done: true, choice: 'option', options_sha256: sha, option_id: 'curta', position_id: 'curta',
      ceiling: { source: 'offered', ceiling_ms: 16800000 }, activation_answer: 'option:curta', linked_task_authorization: null, scope_reduction: null, decisions: ['mode:position', 'option:curta'] });
    const linked = walkRounds(record, ['mode:position', 'option:media']).result;
    assert.deepStrictEqual([linked.type, linked.header, linked.decision_set, linked.options.map(o => o.answer)], ['linked', 'Task ligada', 'milestone-time-linked-task',
      ['linked-task:create-and-start-after-proven-completion', 'linked-task:create-without-auto-start', 'linked-task:none']]);
    const created = walkRounds(record, ['mode:position', 'option:media', 'linked-task:create-without-auto-start']).result;
    assert.deepStrictEqual([created.choice, created.position_id, created.linked_task_authorization, created.activation_answer], ['option', 'media', 'create-without-auto-start', 'option:media']);
    assert.deepStrictEqual(created.decisions.map(d => d.decision_set), ['milestone-time-activation', 'milestone-time-activation', 'milestone-time-linked-task']);
    // Declining the task is not consent to drop the moved scope.
    const scope = walkRounds(record, ['mode:position', 'option:media', 'linked-task:none']).result;
    assert.deepStrictEqual([scope.type, scope.options.map(o => o.answer)], ['scope', ['re-estimate', 'reduce-scope:SC4', 'no-contract']]);
    assert.deepStrictEqual(walkRounds(record, ['mode:position', 'option:media', 'linked-task:none', 're-estimate']).result.scope_reduction, null);
    const reduced = walkRounds(record, ['mode:position', 'option:media', 'linked-task:none', 'reduce-scope:SC4']).result;
    assert.deepStrictEqual([reduced.choice, reduced.scope_reduction, reduced.linked_task_authorization], ['re-estimate', { scope_items: ['SC4'], consent: 'explicit' }, null]);
    assert.strictEqual(walkRounds(record, ['mode:position', 'option:media', 'linked-task:none', 'no-contract']).result.choice, 'no-contract');
    assert.deepStrictEqual(walkRounds(record, ['no-contract']).result.choice, 'no-contract');
    const wrong = options.selectionRounds(record, { ['time-mode-' + suffix]: 'option:longa' });
    assert.deepStrictEqual([wrong.id, wrong.invalid_answer], [mode.id, 'answer-not-offered']);
    assert.deepStrictEqual(record, before, 'rounds are pure');
  });
  test('operator-ceiling-keeps-a-concrete-viable-strategy-and-never-turns-infeasible-viable', () => {
    const record = materialized().record;
    const strategy = walkRounds(record, ['mode:operator-ceiling']).result;
    assert.deepStrictEqual([strategy.type, strategy.options.map(o => o.answer)], ['strategy', ['option:curta', 'option:media']], 'infeasible longa is never offered');
    const ceiling = walkRounds(record, ['mode:operator-ceiling', 'option:media']).result;
    assert.deepStrictEqual([ceiling.type, ceiling.free_text, ceiling.options, ceiling.position_id, ceiling.minimum_ms, ceiling.answer_format], ['ceiling', true, [], 'media', 12000000, 'operator-ceiling:<ms>']);
    const low = options.selectionRounds(record, { [walkRounds(record, []).result.id]: 'mode:operator-ceiling', [strategy.id]: 'option:media', [ceiling.id]: 'operator-ceiling:600000' });
    assert.deepStrictEqual([low.id, low.invalid_answer], [ceiling.id, 'operator-ceiling-incompatible']);
    assert.strictEqual(options.canonicalAnswer(ceiling, '10m'), null); assert.strictEqual(options.canonicalAnswer(ceiling, '20h'), 'operator-ceiling:72000000');
    const done = walkRounds(record, ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000', 'linked-task:create-and-start-after-proven-completion']).result;
    assert.deepStrictEqual([done.choice, done.position_id, done.ceiling, done.activation_answer, done.linked_task_authorization],
      ['option', 'media', { source: 'operator', ceiling_ms: 72000000 }, 'operator-ceiling:72000000', 'create-and-start-after-proven-completion']);
    // One viable position: the strategy is fixed and named before the ceiling.
    const single = materialized(validCase('uma-viavel')).record, first = roundsOk(options.selectionRounds(single, {}));
    assert.deepStrictEqual([first.options.map(o => o.answer), first.recommended], [['option:curta', 'mode:operator-ceiling', 'no-contract'], 'Escopo completo (curta)']);
    const fixed = walkRounds(single, ['mode:operator-ceiling']).result;
    assert.deepStrictEqual([fixed.type, fixed.position_id], ['ceiling', 'curta']); assert.match(fixed.question, /curta/);
    // Incomplete bounds: the position stays selectable only with its own strategy and an operator ceiling; the forecast stays unknown.
    const partial = materialized(validCase('media-base-incompleta')).record, p0 = roundsOk(options.selectionRounds(partial, {}));
    assert.deepStrictEqual(p0.options.map(o => o.answer), ['option:curta', 'mode:operator-ceiling', 'no-contract']);
    const open = walkRounds(partial, ['mode:operator-ceiling', 'option:media']).result;
    assert.deepStrictEqual([open.minimum_ms, /desconhecida/.test(open.question)], [null, true]);
    assert.strictEqual(walkRounds(partial, ['mode:operator-ceiling', 'option:media', 'operator-ceiling:3600000', 'linked-task:create-without-auto-start']).result.ceiling.ceiling_ms, 3600000);
    // Scarcity without complete bounds: no offered cap, re-estimate instead of a position.
    const scarce = materialized(validCase('sem-julgamento')).record, s0 = roundsOk(options.selectionRounds(scarce, {}));
    assert.deepStrictEqual(s0.options.map(o => o.answer), ['re-estimate', 'mode:operator-ceiling', 'no-contract']);
    assert.strictEqual(walkRounds(scarce, ['re-estimate']).result.choice, 're-estimate');
    // No viable position: explicit limit, re-estimate or no contract — never a numeric authorization without a strategy.
    const none = materialized(validCase('nenhuma-viavel')).record, n0 = roundsOk(options.selectionRounds(none, {}));
    assert.deepStrictEqual(n0.options.map(o => o.answer), ['re-estimate', 'no-contract']); assert.match(n0.question, /Nenhuma posição é viável/);
    assert.ok(!n0.options.some(o => /operator-ceiling/.test(o.answer)));
    // Three viable positions: mode and then a three-option position round with the recommendation moved first.
    const three = materialized(validCase('tres-viaveis')).record, pos = walkRounds(three, ['mode:position']).result;
    assert.deepStrictEqual([pos.options.length, pos.recommended], [3, 'Escopo ampliado (longa)']);
    assert.strictEqual(channel.normalizeDecision(pos, 'codex-request-user-input').options[0].label, 'Escopo ampliado (longa) (Recomendado)');
  });
  test('canonical-answer-maps-only-exact-round-labels', () => {
    const record = materialized().record, mode = options.selectionRounds(record, {}), position = walkRounds(record, ['mode:position']).result;
    assert.strictEqual(options.canonicalAnswer(mode, 'Sem contrato'), 'no-contract');
    assert.strictEqual(options.canonicalAnswer(mode, 'Teto próprio'), 'mode:operator-ceiling');
    assert.strictEqual(options.canonicalAnswer(position, 'Escopo completo (curta) (Recomendado)'), 'option:curta');
    assert.strictEqual(options.canonicalAnswer(position, 'Escopo completo (curta)'), 'option:curta');
    for (const other of ['sem contrato', 'Outro', 'option:curta', '', 'Com task ligada']) assert.strictEqual(options.canonicalAnswer(mode, other), null, other);
    assert.strictEqual(options.canonicalAnswer(mode, 42), null); assert.strictEqual(options.canonicalAnswer(null, 'Sem contrato'), null);
  });
  test('rounds-and-the-t01-selection-interoperate-for-offered-ceilings-and-linked-tasks', () => {
    const { record, options_sha256: sha } = materialized();
    const decide = decideFor, contract = (option, ceiling, linked, chain) => contractFor(record, option, ceiling, linked, chain), prepare = () => prepareFor(record);
    // Full scope with the offered cap.
    const a = prepare(), outcome = walkRounds(record, ['mode:position', 'option:curta']).result;
    const request = contract({ id: outcome.option_id, options_sha256: sha, label: 'Escopo completo', position_id: outcome.position_id }, outcome.ceiling.ceiling_ms, null, null);
    const activationHandle = decide(a, 'activation', request, outcome.activation_answer);
    const selection = time.recordSelection({ cwd: a, milestone: M, selection: { choice: 'option', options_sha256: sha, option_id: 'curta', position_id: 'curta', linked_task_authorization: null,
      contract_request: request, rounds: outcome.decisions.map(d => ({ round: d.round_id, outcome: 'answered' })) }, handles: { activation: activationHandle }, now: NOW });
    assert.strictEqual(selection.status, 'valid'); assert.strictEqual(selection.selection.contract_request.ceiling_ms, 16800000);
    // The real activation: live handle for the exact selected request, persisted contract read back by the real reader.
    assert.strictEqual(time.readContract({ cwd: a, milestone: M }).status, 'absent');
    time.activateContract({ cwd: a, milestone: M, contract: request, handle: activationHandle, now: NOW });
    const active = time.readContract({ cwd: a, milestone: M });
    assert.strictEqual(active.status, 'valid');
    assert.deepStrictEqual([active.contract.option, active.contract.ceiling_ms, active.contract.linked_task, active.contract.chain_forecast, active.contract.decision.answer],
      [request.option, 16800000, null, null, 'option:curta']);
    assert.deepStrictEqual(time.activateContract({ cwd: a, milestone: M, contract: request, handle: activationHandle, now: NOW }).sha256, active.sha256, 'activation is idempotent');
    // Linked task: the persisted horizon and the milestone-plus-task chain pass the T01 contract validation unchanged, for both create authorizations and an operator cap.
    const e = record.estimate.positions[1], linked = record.proposal.positions[1].linked_task;
    for (const [authorization, walk, cap] of [['create-without-auto-start', ['mode:position', 'option:media'], 12000000], ['create-and-start-after-proven-completion', ['mode:position', 'option:media'], 12000000],
      ['create-without-auto-start', ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000'], 72000000], ['create-and-start-after-proven-completion', ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000'], 72000000]]) {
      const b = prepare(), linkedOutcome = walkRounds(record, [...walk, 'linked-task:' + authorization]).result;
      assert.deepStrictEqual([linkedOutcome.choice, linkedOutcome.ceiling.ceiling_ms], ['option', cap]);
      const linkedRequest = contract({ id: 'media', options_sha256: sha, label: 'Com task ligada' }, linkedOutcome.ceiling.ceiling_ms,
        { position_id: 'media', authorization: linkedOutcome.linked_task_authorization, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon: e.linked_task_horizon, options_sha256: sha },
        { low_ms: e.chain.low_ms, high_ms: e.chain.high_ms, basis: e.chain.basis });
      const task = { milestone: M, options_sha256: sha, option_id: 'media', position_id: 'media', authorization: linkedOutcome.linked_task_authorization };
      const linkedActivation = decide(b, 'activation', linkedRequest, linkedOutcome.activation_answer);
      const linkedSelection = time.recordSelection({ cwd: b, milestone: M, selection: { choice: 'option', options_sha256: sha, option_id: 'media', position_id: 'media',
        linked_task_authorization: linkedOutcome.linked_task_authorization, contract_request: linkedRequest, rounds: [] },
      handles: { activation: linkedActivation, 'linked-task': decide(b, 'linked-task', task, 'linked-task:' + linkedOutcome.linked_task_authorization) }, now: NOW });
      assert.strictEqual(linkedSelection.status, 'valid'); assert.deepStrictEqual(linkedSelection.selection.contract_request.chain_forecast, { low_ms: 6600000, high_ms: 14400000, basis: 'milestone-plus-linked-task' });
      assert.strictEqual(time.readContract({ cwd: b, milestone: M }).status, 'absent');
      // A handle issued for another request cannot activate this one.
      assert.throws(() => time.activateContract({ cwd: b, milestone: M, contract: linkedRequest, handle: decide(b, 'activation', { ...linkedRequest, ceiling_ms: cap + 1 }, linkedOutcome.activation_answer), now: NOW }), e2 => e2.code === 'time-decision-scope-mismatch');
      assert.strictEqual(time.readContract({ cwd: b, milestone: M }).status, 'absent');
      time.activateContract({ cwd: b, milestone: M, contract: linkedRequest, handle: linkedActivation, now: NOW });
      const persisted = time.readContract({ cwd: b, milestone: M });
      assert.strictEqual(persisted.status, 'valid');
      assert.deepStrictEqual([persisted.contract.option, persisted.contract.ceiling_ms, persisted.contract.decision.answer, persisted.contract.chain_forecast], [linkedRequest.option, cap, linkedOutcome.activation_answer, linkedRequest.chain_forecast]);
      assert.deepStrictEqual(persisted.contract.linked_task, { position_id: 'media', authorization, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon: e.linked_task_horizon, options_sha256: sha });
    }
  });
  test('cli-validate-estimate-render-are-read-only-with-exit-codes', () => {
    const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
    const cwd = buildHistory(root(), historyCase('suficiente').input), dir = path.join(cwd, '.gsd/milestones', M);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, M + '-OPTIONS.json'), JSON.stringify(PROPOSALS.base, null, 2));
    const badFile = path.join(cwd, 'bad.json'); fs.writeFileSync(badFile, JSON.stringify(proposalOf(PROPOSALS.refusals.find(r => r.name === 'caminho-absoluto').input)));
    const recordFile = path.join(cwd, 'record.json'); fs.writeFileSync(recordFile, JSON.stringify(materialized().record));
    const before = snapshot(cwd), absolute = [cwd, cwd.replace(/\\/g, '/'), os.tmpdir()];
    const checks = [
      [['--validate', path.join(dir, M + '-OPTIONS.json'), '--milestone', M, '--json'], 0, o => assert.deepStrictEqual(JSON.parse(o), { status: 'valid' })],
      [['--validate', badFile, '--milestone', M, '--json'], 3, o => assert.deepStrictEqual(JSON.parse(o), { status: 'refused', reason: 'options-text-invalid', path: 'positions[0].nodes[0].judgment.sources[0]' })],
      [['--validate', badFile, '--milestone', M], 3, o => assert.match(o, /^Proposta recusada: options-text-invalid/)],
      [['--validate', path.join(dir, M + '-OPTIONS.json'), '--milestone', 'M002'], 3, o => assert.match(o, /options-milestone-mismatch/)],
      [['--estimate', '--cwd', cwd, '--milestone', M, '--json'], 0, o => { const r = JSON.parse(o); assert.strictEqual(r.status, 'preview'); assert.strictEqual(r.estimate.positions[0].confidence, 'medium'); assert.strictEqual(r.history.observations, 30); }],
      [['--estimate', '--cwd', cwd, '--milestone', M], 0, o => assert.match(o, /^Prévia somente leitura \(30 amostras\):\ncurta: .* teto proposto .*confiança média\nmedia: .*\nlonga: inviável/)],
      [['--render', recordFile], 0, o => assert.match(o, /^# Opções de prazo — M001/)],
      [['--render', recordFile, '--json'], 0, o => { const r = JSON.parse(o); assert.strictEqual(r.status, 'rendered'); assert.ok(/^[a-f0-9]{64}$/.test(r.options_sha256)); }],
      [['--render', badFile, '--json'], 3, o => assert.deepStrictEqual(JSON.parse(o), { status: 'refused', reason: 'options-record-invalid' })],
      [['--estimate', '--cwd', cwd, '--milestone', 'M999', '--json'], 3, o => assert.deepStrictEqual(JSON.parse(o), { status: 'refused', reason: 'options-file-unreadable' })],
      [['--validate', badFile], 2, o => assert.match(o, /^Uso:/)],
      [['--estimate', '--milestone', M, '--json'], 2, o => assert.deepStrictEqual(JSON.parse(o), { status: 'usage', reason: 'options-usage' })],
      [['--bogus'], 2, o => assert.match(o, /^Uso:/)],
      [[], 2, o => assert.match(o, /^Uso:/)]];
    for (const [args, status, check] of checks) {
      const result = run(args, cwd);
      assert.strictEqual(result.status, status, args.join(' ') + ': ' + result.stdout + result.stderr); check(result.stdout);
      for (const p of absolute) assert.ok(!result.stdout.includes(p) && !result.stderr.includes(p), 'absolute path in output of ' + args[0]);
    }
    assert.deepStrictEqual(snapshot(cwd), before, 'CLI wrote to the owner');
  });
  test('numeric-only-differences-are-not-distinct-strategies-but-real-work-is', () => {
    const viable = [{ op: 'set', path: ['positions', 2, 'status'], value: 'viable' }];
    const withPatches = more => applyPatches(PROPOSALS.base, [...viable, ...more]);
    // Only the phase count (3 -> 5), only the judgment/label, or both: still the same execution.
    for (const name of ['posicoes-so-contagem-de-fase', 'posicoes-so-julgamento-e-rotulo']) {
      const row = PROPOSALS.refusals.find(r => r.name === name);
      assert.deepStrictEqual(options.validateProposal(proposalOf(row.input), M), { valid: false, reason: 'options-positions-identical', path: 'positions[2]' }, name);
    }
    // A different phase kind, a different activity or a different dependency is substantive work.
    assert.deepStrictEqual(options.validateProposal(withPatches([{ op: 'set', path: ['positions', 2, 'nodes', 1, 'phases', 'research-slice'], value: 1 }]), M), { valid: true });
    assert.deepStrictEqual(options.validateProposal(withPatches([{ op: 'set', path: ['positions', 2, 'nodes', 1, 'activities'], value: ['Schema', 'Validador', 'Testes', 'Regressão'] }]), M), { valid: true });
    assert.deepStrictEqual(options.validateProposal(withPatches([{ op: 'set', path: ['positions', 2, 'nodes', 4, 'depends'], value: ['N2', 'N3'] }]), M), { valid: true });
    // The positive three-strategy fixture differs in concrete work and dependencies, not only in a number.
    const three = validCase('tres-viaveis'), [curta, , longa] = three.positions;
    assert.notDeepStrictEqual(longa.nodes[1].activities, curta.nodes[1].activities); assert.notDeepStrictEqual(longa.nodes[4].depends, curta.nodes[4].depends);
    assert.notStrictEqual(longa.strategy, curta.strategy); assert.notDeepStrictEqual(longa.technical_choices, curta.technical_choices);
    const record = materialized(three).record, view = rt.optionsView(record);
    assert.strictEqual(view.status, 'valid'); assert.deepStrictEqual(view.options.map(o => o.id), ['curta', 'media', 'longa']);
    assert.ok(record.estimate.positions.every(e => e.status === 'estimated'));
    for (const option of view.options) assert.strictEqual(rt.selectedPartition(rt.sourceGraph(option, option.positions[0])).status, 'valid');
  });
  test('strategy-identity-ignores-node-order-and-cosmetic-ids-but-not-work', () => {
    const base = structuredClone(PROPOSALS.base), identical = { valid: false, reason: 'options-positions-identical', path: 'positions[2]' };
    const asLonga = source => { const x = structuredClone(source); Object.assign(x, { id: 'longa', label: 'Cópia reordenada', status: 'viable' }); return x; };
    const swap = (list, i, j) => { [list[i], list[j]] = [list[j], list[i]]; };
    // Cosmetic ids are renamed everywhere they are referenced; node, dependency and parallel-group order are shuffled.
    const rename = (x, prefix) => {
      const map = new Map(x.nodes.map((n, i) => [n.id, prefix + (99 - i)])), to = list => list.map(d => map.get(d));
      for (const n of x.nodes) { n.id = map.get(n.id); n.depends = to(n.depends).reverse(); }
      x.nodes.reverse(); for (const g of x.parallel_groups) g.nodes = to(g.nodes).reverse();
      if (x.linked_task) x.linked_task.nodes = to(x.linked_task.nodes);
      return map;
    };
    const withLonga = longa => { const p = structuredClone(base); p.positions[2] = longa; return p; };
    // Reorder alone: longa viable with only N2/N3 swapped in the node array.
    const swapped = asLonga(base.positions[0]); swap(swapped.nodes, 2, 3);
    assert.deepStrictEqual(options.validateProposal(withLonga(swapped), M), identical);
    // Reorder plus consistent renaming (and dependency/group order) of the same execution.
    const renamed = asLonga(base.positions[0]); swap(renamed.nodes, 2, 3); rename(renamed, 'Z');
    assert.deepStrictEqual(options.validateProposal(withLonga(renamed), M), identical);
    // Linked membership and moved scope follow the renaming: the linked execution is still the same strategy.
    const linkedCopy = asLonga(base.positions[1]); swap(linkedCopy.nodes, 4, 5); rename(linkedCopy, 'K');
    assert.deepStrictEqual(options.validateProposal(withLonga(linkedCopy), M), { valid: false, reason: 'options-positions-identical', path: 'positions[2]' });
    // Same renamed copy with a different substantive dependency, activity, kind coverage or linked membership is a real alternative.
    const dependency = asLonga(base.positions[0]); const map = rename(dependency, 'Z');
    dependency.nodes.find(n => n.id === map.get('INT')).depends = ['N2', 'N3'].map(d => map.get(d));
    assert.deepStrictEqual(options.validateProposal(withLonga(dependency), M), { valid: true });
    const activity = asLonga(base.positions[0]); rename(activity, 'Z'); activity.nodes.find(n => n.activities.includes('Rodadas')).activities = ['Rodadas', 'Persistência', 'Regressão'];
    assert.deepStrictEqual(options.validateProposal(withLonga(activity), M), { valid: true });
    const membership = asLonga(base.positions[1]); const names = rename(membership, 'K');
    membership.linked_task.nodes = [names.get('N4')]; membership.nodes.find(n => n.id === names.get('N4')).depends = [names.get('N1')];
    assert.deepStrictEqual(options.validateProposal(withLonga(membership), M), { valid: true });
    // Several genuinely different viable alternatives stay valid.
    assert.deepStrictEqual(options.validateProposal(validCase('tres-viaveis'), M), { valid: true });
  });
  test('large-safe-duration-totals-keep-bounded-linked-rounds-with-all-three-horizons', () => {
    const big = (position, node, low, high) => [{ op: 'set', path: ['positions', position, 'nodes', node, 'judgment', 'low_ms'], value: low }, { op: 'set', path: ['positions', position, 'nodes', node, 'judgment', 'high_ms'], value: high }];
    const spans = [[4000000001234567, 4000000001234567], [1000000000000007, 4000000001234567]];
    for (const [low, high] of spans) {
      // Milestone and linked task each total `high` (the other nodes of the position are measured/short): the chain is the safe sum.
      const proposal = applyPatches(validCase('completa-tres-posicoes'), [...big(0, 1, low, high), ...big(1, 1, low, high), ...big(1, 3, low, low), ...big(1, 4, low, high)]);
      const { record } = materialized(proposal), media = record.estimate.positions[1];
      assert.ok(Number.isSafeInteger(media.chain.high_ms) && media.chain.high_ms > high && media.linked_task_horizon.high_ms >= high, 'large safe chain');
      assert.strictEqual(rt.optionsView(record).status, 'valid'); time.recordOptions({ cwd: prepareFor(record), milestone: M, record });
      // Walk every reachable round with real answers (answers are keyed by round id).
      let answered = {}; const seen = [];
      for (const answer of ['mode:position', 'option:media']) { const r = options.selectionRounds(record, answered); seen.push(roundsOk(r)); answered = { ...answered, [r.id]: answer }; }
      const linkedRound = options.selectionRounds(record, answered); seen.push(roundsOk(linkedRound));
      assert.strictEqual(linkedRound.type, 'linked');
      for (const o of linkedRound.options) assert.ok(Array.from(o.description).length <= 240 && /milestone/.test(o.description) && /task/.test(o.description) && /cadeia/.test(o.description), o.description);
      for (const o of linkedRound.options.slice(0, 2)) assert.ok(/≈|\d+ d/.test(o.description) && !/—.*—.*—/.test(o.description.split('Horizontes:')[1]), 'all three horizons are present: ' + o.description);
      answered = { ...answered, [linkedRound.id]: 'linked-task:none' }; seen.push(roundsOk(options.selectionRounds(record, answered)));
      // The operator-cap branch with the same totals: strategy round, free-text ceiling round and the offered options all stay bounded and channel-valid.
      answered = {};
      for (const answer of ['mode:operator-ceiling', 'option:media']) { const r = options.selectionRounds(record, answered); seen.push(roundsOk(r)); answered = { ...answered, [r.id]: answer }; }
      // The estimated upper bound is above the 365-day parser maximum: no free-text round with an unanswerable minimum, an explicit re-estimation instead.
      const impossible = options.selectionRounds(record, answered);
      assert.deepStrictEqual([impossible.done, impossible.choice, impossible.reason, impossible.position_id, impossible.ceiling, impossible.activation_answer, impossible.scope_reduction], [true, 're-estimate', 'operator-ceiling-above-maximum', 'media', null, null, null]);
      assert.deepStrictEqual(impossible.decisions.map(d => d.answer), ['mode:operator-ceiling', 'option:media']);
      assert.strictEqual(seen.length, 6);
      // Exact values stay in the immutable record, never rewritten by the compact presentation.
      assert.ok(options.renderOptionsMarkdown(record).includes(options.formatDuration(media.chain.high_ms)), 'the general render keeps the complete value');
    }
  });
  test('custom-ceiling-boundary-at-365-days-and-unknown-forecast', () => {
    const MAX = 31536000000, base = validCase('completa-tres-posicoes');
    const withN1High = high => applyPatches(base, [{ op: 'set', path: ['positions', 0, 'nodes', 1, 'judgment', 'high_ms'], value: high }]);
    const probe = materialized(withN1High(3600000)).record.estimate.positions[0], target = 3600000 + (MAX - probe.high_ms);
    const at = materialized(withN1High(target)).record, above = materialized(withN1High(target + 1)).record;
    assert.strictEqual(at.estimate.positions[0].high_ms, MAX); assert.strictEqual(above.estimate.positions[0].high_ms, MAX + 1);
    // Exactly 365 days: the minimum equals the parser maximum and the answer is accepted through selection.
    const walked = walkRounds(at, ['mode:operator-ceiling', 'option:curta']), ceilingRound = walked.result;
    assert.deepStrictEqual([ceilingRound.type, ceilingRound.minimum_ms], ['ceiling', MAX]);
    assert.strictEqual(options.canonicalAnswer(ceilingRound, '365d'), 'operator-ceiling:' + MAX);
    const accepted = options.selectionRounds(at, { ...walked.answered, [ceilingRound.id]: 'operator-ceiling:' + MAX });
    assert.deepStrictEqual([accepted.done, accepted.choice, accepted.ceiling, accepted.position_id], [true, 'option', { source: 'operator', ceiling_ms: MAX }, 'curta']);
    // One millisecond above: no numeric round is asked; explicit re-estimation keeps the chosen position and the real decisions.
    const refused = options.selectionRounds(above, walkRounds(above, ['mode:operator-ceiling', 'option:curta']).answered);
    assert.deepStrictEqual([refused.done, refused.choice, refused.reason, refused.position_id, refused.ceiling, refused.activation_answer, refused.scope_reduction],
      [true, 're-estimate', 'operator-ceiling-above-maximum', 'curta', null, null, null]);
    assert.deepStrictEqual(refused.decisions.map(d => d.answer), ['mode:operator-ceiling', 'option:curta']);
    assert.strictEqual(options.parseOperatorCeiling('365d'), MAX); assert.strictEqual(options.parseOperatorCeiling('366d'), null);
    assert.strictEqual(options.parseOperatorCeiling(String(MAX + 1)), null);
    // Unknown milestone forecast: no minimum exists, so the operator ceiling is still requested and accepted.
    const unknown = materialized(proposalOf({ transform: 'strip-judgments' })).record;
    const open = walkRounds(unknown, ['mode:operator-ceiling', 'option:curta']).result;
    assert.deepStrictEqual([open.type, open.minimum_ms], ['ceiling', null]);
    const unknownDone = options.selectionRounds(unknown, { ...walkRounds(unknown, ['mode:operator-ceiling', 'option:curta']).answered, [open.id]: 'operator-ceiling:3600000' });
    assert.deepStrictEqual([unknownDone.done, unknownDone.choice, unknownDone.ceiling], [true, 'option', { source: 'operator', ceiling_ms: 3600000 }]);
  });
  test('labelled-graph-identity-is-exact-not-just-the-refinement-fingerprint', () => {
    const base = structuredClone(PROPOSALS.base), judgment = { low_ms: 600000, high_ms: 1200000, reason: 'Histórico vazio: faixa ligada ao trabalho do nó', sources: ['scripts/forge-milestone-time.js'] };
    const [prep, , , , , , rev, cor] = base.positions[0].nodes;
    const work = (id, depends) => ({ id, kind: 'slice', title: 'Fatia ' + id, phases: { 'execute-task': 1 }, activities: ['Trabalho'], judgment: structuredClone(judgment), depends, covers: [] });
    const symmetric = (id, status, pairs) => {
      const x = structuredClone(base.positions[0]);
      Object.assign(x, { id, status, label: 'Símétrica ' + id, linked_task: null, deferrals: [], parallel_groups: [] });
      const a = ['A1', 'A2', 'A3', 'A4'].map(n => work(n, ['PREP'])), b = pairs.map((deps, i) => work('B' + (i + 1), deps));
      const integration = { ...structuredClone(base.positions[0].nodes[5]), covers: ['SC2', 'SC3', 'SC4', 'SC5'], depends: b.map(n => n.id) };
      x.nodes = [structuredClone(prep), ...a, ...b, integration, structuredClone(rev), structuredClone(cor)];
      return x;
    };
    const ring = [['A1', 'A2'], ['A2', 'A3'], ['A3', 'A4'], ['A4', 'A1']], pairs = [['A1', 'A2'], ['A1', 'A2'], ['A3', 'A4'], ['A3', 'A4']];
    const build = (second, secondPairs) => { const p = structuredClone(base); p.positions[0] = symmetric('curta', 'viable', ring); p.positions[1].status = 'infeasible'; p.positions[2] = symmetric('longa', 'viable', secondPairs); return p; };
    // One cycle versus two disconnected components: same labels throughout refinement, genuinely different dependencies.
    assert.deepStrictEqual(options.validateProposal(build('longa', pairs), M), { valid: true });
    // The same ring, renamed and reordered, is the same strategy.
    const renamed = build('longa', ring), longa = renamed.positions[2], names = new Map(longa.nodes.map((n, i) => [n.id, 'Q' + (99 - i)]));
    for (const n of longa.nodes) { n.id = names.get(n.id); n.depends = n.depends.map(d => names.get(d)).reverse(); }
    longa.nodes.reverse();
    assert.deepStrictEqual(options.validateProposal(renamed, M), { valid: false, reason: 'options-positions-identical', path: 'positions[2]' });
    // An exhausted comparison budget is unknown, never "identical" and never "distinct".
    assert.deepStrictEqual(options.validateProposal(renamed, M, { comparison_steps: 1 }), { valid: false, reason: 'options-comparison-limit', path: 'positions[2]' });
    assert.ok(options.REFUSALS.includes('options-comparison-limit'));
  });
  test('linked-horizon-unknown-never-completes-a-selection-the-t01-contract-refuses', () => {
    // media/N4 without its total-range judgment: the milestone stays estimated while the task horizon and the chain stay unknown.
    const unknown = applyPatches(validCase('completa-tres-posicoes'), [{ op: 'set', path: ['positions', 1, 'nodes', 4, 'judgment'], value: null }]);
    const { record, options_sha256: sha } = materialized(unknown), media = record.estimate.positions[1];
    assert.deepStrictEqual([media.status, media.linked_task_status, media.chain, media.linked_task_horizon], ['estimated', 'evidence-insufficient', null, { low_ms: null, high_ms: null, ceiling_ms: null }]);
    const unknownAnswers = ['linked-task:create-and-start-after-proven-completion', 'linked-task:create-without-auto-start'];
    // The position is no longer offered with a proposed cap: only its own strategy plus an operator ceiling, then re-estimate.
    const mode = roundsOk(options.selectionRounds(record, {}));
    assert.deepStrictEqual(mode.options.map(o => o.answer), ['option:curta', 'mode:operator-ceiling', 'no-contract']);
    assert.deepStrictEqual(walkRounds(record, ['mode:position']).result.type, 'mode', 'a single offered position is chosen directly');
    for (const authorization of unknownAnswers) {
      const outcome = walkRounds(record, ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000', authorization]).result;
      assert.deepStrictEqual([outcome.done, outcome.choice, outcome.reason, outcome.position_id, outcome.linked_task_authorization, outcome.option_id, outcome.ceiling, outcome.activation_answer],
        [true, 're-estimate', 'linked-task-horizon-unknown', 'media', authorization.slice('linked-task:'.length), null, null, null], authorization);
      assert.deepStrictEqual(outcome.decisions.map(d => d.answer), ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000', authorization], 'actual decisions are preserved');
    }
    // No-task and scope consent behaviour is unchanged: declining creation is not consent to reduce the scope.
    const scope = walkRounds(record, ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000', 'linked-task:none']).result;
    assert.deepStrictEqual([scope.type, scope.options.map(o => o.answer)], ['scope', ['re-estimate', 'reduce-scope:SC4', 'no-contract']]);
    assert.strictEqual(walkRounds(record, ['mode:operator-ceiling', 'option:media', 'operator-ceiling:72000000', 'linked-task:none', 'reduce-scope:SC4']).result.scope_reduction.consent, 'explicit');
    // Nothing was written by the rounds, and the real T01 mutation refuses the unknown horizon: no selection and no contract exist.
    const cwd = prepareFor(record), linked = record.proposal.positions[1].linked_task, e = record.estimate.positions[1];
    const request = contractFor(record, { id: 'media', options_sha256: sha, label: 'Com task ligada' }, 72000000,
      { position_id: 'media', authorization: 'create-without-auto-start', moved_scope: linked.moved_scope, criteria: linked.criteria, horizon: e.linked_task_horizon, options_sha256: sha }, null);
    const task = { milestone: M, options_sha256: sha, option_id: 'media', position_id: 'media', authorization: 'create-without-auto-start' };
    const before = snapshot(cwd);
    assert.throws(() => time.recordSelection({ cwd, milestone: M, selection: { choice: 'option', options_sha256: sha, option_id: 'media', position_id: 'media', linked_task_authorization: 'create-without-auto-start',
      contract_request: request, rounds: [] }, handles: { activation: decideFor(cwd, 'activation', request, 'operator-ceiling:72000000'), 'linked-task': decideFor(cwd, 'linked-task', task, 'linked-task:create-without-auto-start') }, now: NOW }),
    e2 => e2.code === 'time-selection-invalid');
    assert.strictEqual(time.readSelection({ cwd, milestone: M }).status, 'absent'); assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    // The unknown-task branch cannot activate either, even with a live handle for the exact request.
    assert.throws(() => time.activateContract({ cwd, milestone: M, contract: request, handle: decideFor(cwd, 'activation', request, 'operator-ceiling:72000000'), now: NOW }), e2 => e2.code === 'time-contract-schema-invalid');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.deepStrictEqual(Object.keys(snapshot(cwd)).filter(k => !(k in before) && /selection|contract/.test(k)), [], 'no selection or contract file was created');
    // A fully estimated linked position still completes for both authorizations (the T01 mutation is exercised by the interoperability check).
    const good = materialized().record;
    for (const authorization of unknownAnswers) {
      const outcome = walkRounds(good, ['mode:position', 'option:media', authorization]).result;
      assert.deepStrictEqual([outcome.choice, outcome.linked_task_authorization, outcome.reason], ['option', authorization.slice('linked-task:'.length), undefined]);
    }
  });
  test('long-scope-ids-keep-bounded-questions-and-exact-structured-ids', () => {
    for (const count of [2, 60]) {
      const ids = Array.from({ length: count }, (_, i) => ('ESCOPO-MOVIDO-' + String(i).padStart(2, '0') + '-').padEnd(120, 'ITEM'));
      assert.ok(ids.every(x => x.length === 120) && new Set(ids).size === count);
      const proposal = validCase('completa-tres-posicoes');
      proposal.scope_items.splice(3, 1, ...ids.map(x => ({ id: x, title: 'Item movido ' + x.slice(14, 16), indispensable: false, source: 'REQUIREMENTS' })));
      for (const p of proposal.positions) p.nodes[4].covers = [...ids];
      proposal.positions[1].linked_task.moved_scope = [...ids];
      assert.deepStrictEqual(options.validateProposal(proposal, M), { valid: true }, count + ' ids');
      assert.ok(Buffer.byteLength(JSON.stringify(proposal)) <= options.MAX_PROPOSAL_BYTES);
      const { record, options_sha256: sha } = materialized(proposal), suffix = sha.slice(0, 12);
      assert.strictEqual(rt.optionsView(record).status, 'valid');
      const linked = roundsOk(walkRounds(record, ['mode:position', 'option:media']).result);
      assert.deepStrictEqual([linked.type, linked.id], ['linked', 'time-linked-' + suffix]);
      assert.ok(linked.question.includes('media') && linked.question.includes(suffix) && linked.question.includes(String(count)) && !linked.question.includes(ids[0]), linked.question);
      assert.deepStrictEqual(linked.scope, { options_sha256: digest(record), position_id: 'media', moved_scope: ids });
      assert.strictEqual(options.canonicalAnswer(linked, 'Criar sem iniciar'), 'linked-task:create-without-auto-start');
      const scope = roundsOk(walkRounds(record, ['mode:position', 'option:media', 'linked-task:none']).result), exactAnswer = 'reduce-scope:' + ids.join(',');
      assert.deepStrictEqual([scope.type, scope.id], ['scope', 'time-scope-' + suffix]); assert.deepStrictEqual(scope.scope, linked.scope);
      assert.deepStrictEqual(scope.options.map(o => o.answer), ['re-estimate', exactAnswer, 'no-contract']);
      assert.strictEqual(options.canonicalAnswer(scope, 'Consentir na redução'), exactAnswer);
      assert.ok(scope.options.every(o => !o.description.includes(ids[0])) && !scope.question.includes(ids[0]));
      const reduced = walkRounds(record, ['mode:position', 'option:media', 'linked-task:none', exactAnswer]).result;
      assert.deepStrictEqual([reduced.choice, reduced.scope_reduction, reduced.decisions.at(-1).answer], ['re-estimate', { scope_items: ids, consent: 'explicit' }, exactAnswer]);
      assert.deepStrictEqual(rt.optionsView(record).options[1].positions[0].linked_task.moved_scope, ids, 'the immutable record keeps every exact ID');
      // The same digest-bound round IDs hold when the unbounded details change nothing else.
      assert.strictEqual(options.selectionRounds(record, {}).id, 'time-mode-' + suffix);
    }
  });
  test('unsafe-duration-arithmetic-is-refused-with-a-named-reason-at-every-boundary', () => {
    const MAX = Number.MAX_SAFE_INTEGER, base = validCase('completa-tres-posicoes'), empty = options.readHistory({ cwd: root(), milestone: M });
    const unsafe = (proposal, history = empty) => assert.throws(() => options.materialize({ milestone: M, proposal, inputs: inputs(), producer_basis: PRODUCER, history, now: NOW }), e => e.code === 'options-duration-unsafe');
    const setJudgment = (position, node, key, value) => ({ op: 'set', path: ['positions', position, 'nodes', node, 'judgment', key], value });
    // Two individually valid judgments overflow the serial sum: the proposal is valid, the aggregate is refused.
    const two = applyPatches(base, [0, 1].flatMap(n => [setJudgment(0, n, 'low_ms', MAX), setJudgment(0, n, 'high_ms', MAX)]));
    assert.deepStrictEqual(options.validateProposal(two, M), { valid: true });
    unsafe(two); assert.throws(() => options.estimate(two, empty), e => e.code === 'options-duration-unsafe');
    // Exact safe boundary: the serial sum equals MAX_SAFE_INTEGER, one more is refused; the real consumer accepts the boundary record.
    const rest = 16800000 - 3600000, edge = applyPatches(base, [setJudgment(0, 1, 'high_ms', MAX - rest)]);
    const exact = materialized(edge).record, curta = exact.estimate.positions[0];
    assert.deepStrictEqual([curta.high_ms, curta.ceiling_ms, curta.serial_sum.high_ms], [MAX, MAX, MAX]);
    const stored = time.recordOptions({ cwd: prepareFor(exact), milestone: M, record: exact });
    assert.strictEqual(stored.options_sha256, digest(exact)); assert.strictEqual(rt.optionsView(exact).status, 'valid');
    unsafe(applyPatches(base, [setJudgment(0, 1, 'high_ms', MAX - rest + 1)]));
    // Historical multiplication (count x p90) and factor application/rounding.
    const history = { status: 'available', observations: 5, phases: { 'execute-task': { n: 5, p50_ms: 2 ** 52, p90_ms: 2 ** 52, sources: ['.gsd/milestones/M101/M101-events.jsonl'] } } };
    // Only N1 is fully measured by the history; every other node keeps its judgment range.
    const node = (phases, judgment) => [{ op: 'set', path: ['positions', 0, 'nodes', 1, 'phases'], value: phases }, { op: 'set', path: ['positions', 0, 'nodes', 1, 'judgment'], value: judgment },
      ...[0, 1].flatMap(p => [5, 7].map(n => ({ op: 'set', path: ['positions', p, 'nodes', n, 'phases'], value: {} })))];
    const times = n => applyPatches(base, node({ 'execute-task': n }, null));
    assert.strictEqual(options.estimate(times(1), history).positions[0].nodes[1].high_ms, 2 ** 52);
    assert.throws(() => options.estimate(times(3), history), e => e.code === 'options-duration-unsafe', 'multiplication');
    const factor = high => applyPatches(base, node({ 'execute-task': 1 }, { factor_low: 1, factor_high: high, reason: 'Fator rotulado para o teste de fronteira', sources: ['scripts/forge-milestone-options.js'] }));
    assert.strictEqual(options.estimate(factor(1.5), history).positions[0].nodes[1].high_ms, Math.round(2 ** 52 * 1.5));
    assert.throws(() => options.estimate(factor(3), history), e => e.code === 'options-duration-unsafe', 'factor');
    // Each side is safe but the milestone-plus-task chain overflows; the exact chain boundary is accepted.
    const side = high => applyPatches(base, [setJudgment(1, 1, 'high_ms', 2 ** 52), setJudgment(1, 4, 'high_ms', high)]);
    const milestoneHigh = 2 ** 52 + 8400000;
    unsafe(side(2 ** 52));
    const chain = materialized(side(MAX - milestoneHigh)).record.estimate.positions[1];
    assert.deepStrictEqual([chain.high_ms, chain.linked_task_horizon.ceiling_ms, chain.chain.high_ms], [milestoneHigh, MAX - milestoneHigh, MAX]);
    assert.strictEqual(rt.optionsView(materialized(side(MAX - milestoneHigh)).record).status, 'valid');
    unsafe(side(MAX - milestoneHigh + 1));
    // The CLI surfaces the named reason without a path.
    const cwd = root(), dir = path.join(cwd, '.gsd/milestones', M); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, M + '-OPTIONS.json'), JSON.stringify(two));
    const cli = spawnSync(process.execPath, [SCRIPT, '--estimate', '--cwd', cwd, '--milestone', M, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual([cli.status, JSON.parse(cli.stdout)], [3, { status: 'refused', reason: 'options-duration-unsafe' }]);
  });
  test('only-explicit-pauses-are-claimed-excluded-and-unclassified-waits-stay-unknown', () => {
    const judged = validCase('completa-tres-posicoes'), stripped = validCase('sem-julgamento');
    const only = applyPatches(stripped, [{ op: 'set', path: ['positions', 0, 'nodes', 5, 'phases'], value: { 'execute-task': 1 } }]);
    const paused = historyFor('falhas-e-pausas').history, unclassified = historyFor('espera-sem-pausa').history, plain = historyFor('sem-pausa').history;
    // Same 10 min of work: an explicit 10 h pause gap does not inflate it, an unclassified 10 h wait does and says so.
    const high = history => options.estimate(only, history).positions[0].nodes[5].high_ms;
    assert.strictEqual(high(paused), 600000); assert.strictEqual(high(plain), 600000);
    assert.strictEqual(high(unclassified), 36600000, 'the unclassified wait remains inside the completed interval');
    assert.strictEqual(unclassified.excluded.unfinished_paused, 0); assert.strictEqual(paused.excluded.unfinished_paused, 0);
    assert.ok(unclassified.limitations.some(l => /sem classificação/.test(l) && /desconhecidas/.test(l)) && paused.limitations.some(l => /pausa explícita/.test(l)));
    const waits = options.estimate(judged, unclassified).overhead.waits;
    assert.match(waits.pause, /somente quando há pausa explícita/);
    for (const k of ['human', 'ci', 'external', 'unclassified']) { assert.match(waits[k], /desconhecida/); assert.ok(!/^excluída/.test(waits[k]), k); }
    assert.ok(!Object.values(waits).some(v => v === 'excluída'));
    const markdown = options.renderOptionsMarkdown(materialized(judged, unclassified).record);
    assert.ok(markdown.includes('só pausas explicitamente registradas ficam fora') && markdown.includes('não são separadas por esta evidência (desconhecidas)'));
    assert.ok(!markdown.includes('pausas, CI, espera humana e externa ficam fora'));
    assert.ok(!JSON.stringify(options.estimate(judged, unclassified)).includes('observed_span'));
  });
  console.log(`PASS milestone-options ${passed} named checks`);
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
