#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildAutonomyReport, renderAutonomyMarkdown } = require('./forge-autonomy.js');
const { MAX_FILE_BYTES, MAX_RECORDS_PER_SOURCE, readAutonomyManifest } = require('./forge-autonomy-sources.js');
const { buildDispatchEvent } = require('./forge-dispatch-event.js');
const { buildReviewEvent } = require('./forge-review-emit.js');

const SCRIPT = path.join(__dirname, 'forge-autonomy.js');
let passed = 0;
let skipped = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function skip(name, reason) {
  skipped += 1;
  process.stdout.write(`  - ${name} (skip: ${reason})\n`);
}

function fixture(target = { type: 'task', id: 'TASK-014' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autonomy-'));
  fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gsd', 'PROJECT.md'), '# fixture\n');
  const input = {
    schema_version: 1,
    owner_root: root,
    target,
    sources: { gates: [], events: [], results: [] },
  };
  let sequence = 0;
  function write(kind, value, extension = kind === 'events' ? 'jsonl' : 'json') {
    const name = `${kind}-${String(sequence++).padStart(3, '0')}.${extension}`;
    const relative = path.join('telemetry', name);
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.isBuffer(value) ? value : String(value));
    input.sources[kind].push(relative);
    return { relative, absolute };
  }
  return { root, input, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function gate(f, overrides = {}) {
  const value = {
    schema: 1,
    id: overrides.id || `G-${crypto.randomBytes(4).toString('hex')}`,
    cwd: f.root,
    run_id: 'TASK-014',
    unit_id: 'execute-task/TASK-014',
    origin: 'fixture',
    status: 'answered',
    created_at: 1000,
    expires_at: 5000,
    question: 'PRIVATE_QUESTION_SENTINEL',
    options: [{ key: 'yes', label: 'PRIVATE_OPTION_SENTINEL' }],
    answer: { key: 'yes', label: 'PRIVATE_ANSWER_SENTINEL', source: 'human', at: 3000, notes: 'PRIVATE_NOTES_SENTINEL' },
    ...overrides,
  };
  f.write('gates', `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

const ROUTE = Object.freeze({
  host_runtime: 'codex', worker_mode: 'sidecar', resolved_worker_engine: 'codex',
  dispatch_reason_code: 'fixture', dispatch_posture: 'native', dispatch_decision: 'dispatch',
  dispatch_allowed: true, model: 'gpt', tier: 'heavy', reason: 'fixture', effort: 'high',
  effort_reason: 'fixture', engine: 'codex', domain: 'fixture', route_source: 'fixture', chain_len: 0,
});

function dispatch(unit, id, overrides = {}) {
  const args = {
    unit,
    dispatchId: id,
    ts: overrides.ts || '2026-09-24T10:00:00Z',
    ...(overrides.milestone !== undefined ? { milestone: overrides.milestone } : {}),
    ...(overrides.slice !== undefined ? { slice: overrides.slice } : {}),
    ...(overrides.allowed !== undefined ? { dispatchAllowed: overrides.allowed } : {}),
    ...(overrides.attempt !== undefined ? { attempt: overrides.attempt } : {}),
    ...(overrides.engine !== undefined ? { engine: overrides.engine } : {}),
  };
  const event = buildDispatchEvent(args, ROUTE, args.ts);
  if (overrides.removeId) delete event.dispatch_id;
  return event;
}

function review(milestone, slice, concededFixed, overrides = {}) {
  const built = buildReviewEvent({
    milestone, slice, authorEngine: 'codex', conceded: Math.max(concededFixed, 1),
    concededFixed, resolved: 0, open: 0, ts: overrides.ts || '2026-09-24T10:00:00Z',
    ...(overrides.style !== undefined ? { style: overrides.style } : {}),
    ...(overrides.rounds !== undefined ? { rounds: overrides.rounds } : {}),
    ...(overrides.engine !== undefined ? { engine: overrides.engine } : {}),
    ...(overrides.challenger !== undefined ? { challenger: overrides.challenger } : {}),
    ...(overrides.advocate !== undefined ? { advocate: overrides.advocate } : {}),
    ...(overrides.intraFamilyWithdrawn !== undefined ? { intraFamilyWithdrawn: overrides.intraFamilyWithdrawn } : {}),
  });
  assert.deepStrictEqual(built.errors, []);
  return built.event;
}

function result(id, start, finish, durationSecs, overrides = {}) {
  return {
    status: 'done', dispatch_id: id, started_at: start, finished_at: finish,
    duration_secs: durationSecs, summary: 'PRIVATE_SUMMARY_SENTINEL',
    prompt: 'PRIVATE_PROMPT_SENTINEL', resume: { token: 'PRIVATE_TOKEN_SENTINEL' },
    ...overrides,
  };
}

function writeEvents(f, values, separator = '\n') {
  f.write('events', `${values.map((value) => JSON.stringify(value)).join(separator)}${separator}`);
}

function writeResult(f, value) {
  f.write('results', `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(root) {
  const out = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  }
  visit(root);
  return out;
}

function growingFileIo(readLengths) {
  let fstatCalls = 0;
  const shaped = (stat, size) => ({
    size,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    isFile: () => true,
  });
  return {
    openSync: (...args) => fs.openSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    realpathSync: (...args) => fs.realpathSync(...args),
    fstatSync: (descriptor) => {
      const stat = fs.fstatSync(descriptor);
      return shaped(stat, fstatCalls++ === 0 ? 1 : MAX_FILE_BYTES + 1);
    },
    statSync: (file) => shaped(fs.statSync(file), MAX_FILE_BYTES + 1),
    readSync: (_descriptor, buffer, offset, length) => {
      readLengths.push(length);
      buffer.fill(65, offset, offset + length);
      return length;
    },
  };
}

test('four families remain present and unknown when no sources are supplied', () => {
  const f = fixture();
  try {
    const report = buildAutonomyReport(f.input);
    assert.strictEqual(report.valid, true);
    assert.deepStrictEqual(Object.keys(report.families), ['human_interventions', 'time', 'reviews', 'resumptions']);
    for (const family of Object.values(report.families)) {
      for (const measure of Object.values(family.measures)) {
        assert(['observed', 'unknown', 'invalid', 'conflict'].includes(measure.state));
        assert(['provided_sources_only', 'partial', 'none'].includes(measure.coverage));
        assert(Object.prototype.hasOwnProperty.call(measure, 'definition'));
        assert(Object.prototype.hasOwnProperty.call(measure, 'unit'));
        assert(Object.prototype.hasOwnProperty.call(measure, 'references'));
      }
    }
    assert.strictEqual(report.families.human_interventions.measures.registered_human_answers.value, null);
    assert.strictEqual(report.families.resumptions.measures.success_rate.value, null);
  } finally { f.cleanup(); }
});

test('human gates count answers and calculate sum versus union without exposing private fields', () => {
  const f = fixture();
  try {
    gate(f, { id: 'G-one', created_at: 1000, answer: { source: 'human', at: 5000, notes: 'SECRET_ONE' } });
    gate(f, { id: 'G-two', created_at: 3000, answer: { source: 'human', at: 7000, notes: 'SECRET_TWO' } });
    const report = buildAutonomyReport(f.input);
    const measures = report.families.human_interventions.measures;
    assert.strictEqual(measures.registered_human_answers.value, 2);
    assert.strictEqual(measures.registered_response_latency_sum_ms.value, 8000);
    assert.strictEqual(measures.registered_response_latency_wall_ms.value, 6000);
    const serialized = JSON.stringify(report);
    for (const secret of ['PRIVATE_QUESTION_SENTINEL', 'PRIVATE_OPTION_SENTINEL', 'SECRET_ONE', 'SECRET_TWO']) assert(!serialized.includes(secret));
    assert(measures.registered_human_answers.references.every((entry) => /^owner:/.test(entry.source) && /^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally { f.cleanup(); }
});

test('producer-shaped bare slice gate contributes to slice and milestone but not another milestone', () => {
  const f = fixture({ type: 'slice', id: 'S02', milestone: 'M014' });
  try {
    gate(f, {
      id: 'G-review-open', run_id: 'M014', unit_id: 'S02',
      created_at: 1000, answer: { source: 'human', at: 2000 },
    });
    const slice = buildAutonomyReport(f.input);
    const milestone = buildAutonomyReport({ ...f.input, target: { type: 'milestone', id: 'M014' } });
    const unrelated = buildAutonomyReport({ ...f.input, target: { type: 'milestone', id: 'M999' } });
    for (const report of [slice, milestone]) {
      const measures = report.families.human_interventions.measures;
      assert.strictEqual(measures.registered_human_answers.value, 1);
      assert.strictEqual(measures.registered_response_latency_sum_ms.value, 1000);
      assert.strictEqual(report.valid, true);
    }
    assert.strictEqual(unrelated.families.human_interventions.measures.registered_human_answers.value, null);
    assert(!unrelated.diagnostics.some((entry) => entry.code === 'gate_identity_conflict'));
  } finally { f.cleanup(); }
});

test('timeout/default and cancelled gates sustain zero registered human answers but no human latency', () => {
  const f = fixture();
  try {
    gate(f, { id: 'G-timeout', status: 'expired', answer: { source: 'timeout-default', at: 9000 } });
    gate(f, { id: 'G-cancelled', status: 'cancelled', answer: { source: 'cancelled', at: 4000 } });
    const measures = buildAutonomyReport(f.input).families.human_interventions.measures;
    assert.strictEqual(measures.registered_human_answers.value, 0);
    assert.strictEqual(measures.registered_human_answers.state, 'observed');
    assert.strictEqual(measures.registered_response_latency_sum_ms.value, null);
  } finally { f.cleanup(); }
});

test('impossible gate status/source combinations are invalid and never become observed zero', () => {
  const invalid = [
    { status: 'answered', answer: { source: 'cancelled', at: 2000 } },
    { status: 'answered', answer: { source: 'timeout-default', at: 2000 } },
    { status: 'cancelled', answer: { source: 'human', at: 2000 } },
    { status: 'cancelled', answer: { source: 'timeout-default', at: 2000 } },
    { status: 'pending', answer: { source: 'human', at: 2000 } },
    { status: 'expired', answer: { source: 'human', at: 2000 } },
  ];
  for (const shape of invalid) {
    const f = fixture();
    try {
      gate(f, { id: `G-invalid-${shape.status}-${shape.answer.source}`, ...shape });
      const report = buildAutonomyReport(f.input);
      const measure = report.families.human_interventions.measures.registered_human_answers;
      assert.strictEqual(report.valid, false);
      assert.strictEqual(measure.value, null);
      assert.strictEqual(measure.state, 'invalid');
      assert(report.diagnostics.some((entry) => entry.code === 'gate_status_answer_invalid'));
    } finally { f.cleanup(); }
  }

  const unresolved = fixture();
  try {
    gate(unresolved, { id: 'G-expired-unresolved', status: 'expired', answer: null });
    const measure = buildAutonomyReport(unresolved.input).families.human_interventions.measures.registered_human_answers;
    assert.strictEqual(measure.value, 0);
    assert.strictEqual(measure.state, 'observed');
  } finally { unresolved.cleanup(); }
});

test('execution separates invocation sum, observed wall time, and explicit review-fix rework', () => {
  const f = fixture();
  try {
    writeEvents(f, [dispatch('execute-task/TASK-014', 'D-one'), dispatch('review-fix/TASK-014', 'D-fix')]);
    writeResult(f, result('D-one', '2026-09-24T10:00:00Z', '2026-09-24T10:00:10Z', 10));
    writeResult(f, result('D-fix', '2026-09-24T10:00:05Z', '2026-09-24T10:00:15Z', 10));
    const measures = buildAutonomyReport(f.input).families.time.measures;
    assert.strictEqual(measures.execution_sum_ms.value, 20000);
    assert.strictEqual(measures.execution_wall_ms.value, 15000);
    assert.strictEqual(measures.recorded_rework_sum_ms.value, 10000);
    assert.strictEqual(measures.recorded_rework_wall_ms.value, 10000);
  } finally { f.cleanup(); }
});

test('slice and milestone count exact descendant review-fix task units as recorded rework', () => {
  for (const target of [
    { type: 'slice', id: 'S02', milestone: 'M014' },
    { type: 'milestone', id: 'M014' },
  ]) {
    const f = fixture(target);
    try {
      writeEvents(f, [dispatch('review-fix/T01', `D-fix-${target.type}`, { milestone: 'M014', slice: 'S02' })]);
      writeResult(f, result(`D-fix-${target.type}`, '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
      const measures = buildAutonomyReport(f.input).families.time.measures;
      assert.strictEqual(measures.execution_sum_ms.value, 1000);
      assert.strictEqual(measures.recorded_rework_sum_ms.value, 1000);
      assert.strictEqual(measures.recorded_rework_wall_ms.value, 1000);
    } finally { f.cleanup(); }
  }
});

test('a normal repeated execute attempt is execution and never inferred as rework', () => {
  const f = fixture();
  try {
    writeEvents(f, [dispatch('execute-task/TASK-014', 'D-retry')]);
    writeResult(f, result('D-retry', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    const measures = buildAutonomyReport(f.input).families.time.measures;
    assert.strictEqual(measures.execution_sum_ms.value, 1000);
    assert.strictEqual(measures.recorded_rework_sum_ms.value, null);
  } finally { f.cleanup(); }
});

test('review declarations deduplicate canonically and verified corrections remain unknown', () => {
  const f = fixture({ type: 'slice', id: 'S02', milestone: 'M014' });
  try {
    const row = review('M014', 'S02', 2);
    writeEvents(f, [row, { ...row }, review('M014', 'S02', 1, { ts: '2026-09-24T11:00:00Z' })]);
    const report = buildAutonomyReport(f.input);
    const measures = report.families.reviews.measures;
    assert.strictEqual(measures.declared_corrections.value, 3);
    assert.strictEqual(measures.positive_declarations.value, 2);
    assert.strictEqual(measures.verified_corrections.value, null);
    assert.strictEqual(measures.verified_corrections.state, 'unknown');
    assert.strictEqual(measures.verified_impact.value, null);
    assert.strictEqual(measures.verified_impact.state, 'unknown');
    assert(report.diagnostics.some((entry) => entry.code === 'review_identity_not_universal'));
  } finally { f.cleanup(); }
});

test('review fingerprint keeps distinct valid producer style, rounds, and engine semantics', () => {
  const f = fixture({ type: 'slice', id: 'S02', milestone: 'M014' });
  try {
    const flags = review('M014', 'S02', 2, { style: 'flags', rounds: 1, engine: 'agents' });
    const dialectic = review('M014', 'S02', 2, { style: 'dialectic', rounds: 2, engine: 'workflow' });
    assert.strictEqual(flags.ts, dialectic.ts, 'fixture must exercise the emitter second-level timestamp collision');
    writeEvents(f, [flags, dialectic]);
    const measures = buildAutonomyReport(f.input).families.reviews.measures;
    assert.strictEqual(measures.declared_corrections.value, 4);
    assert.strictEqual(measures.positive_declarations.value, 2);
  } finally { f.cleanup(); }
});

test('slice review is not attributed to a local task with the same local task id', () => {
  const f = fixture({ type: 'task', id: 'T01', milestone: 'M014', slice: 'S02' });
  try {
    writeEvents(f, [review('M014', 'S02', 2)]);
    const report = buildAutonomyReport(f.input);
    assert.strictEqual(report.families.reviews.measures.declared_corrections.value, null);
    assert(report.diagnostics.some((entry) => entry.code === 'review_not_attributable'));
  } finally { f.cleanup(); }
});

test('identical gates deduplicate while divergent content conflicts independently of source order', () => {
  function run(reverse) {
    const f = fixture();
    try {
      const common = { schema: 1, id: 'G-conflict', cwd: f.root, run_id: 'TASK-014', unit_id: 'execute-task/TASK-014', status: 'answered', created_at: 1, answer: { source: 'human', at: 2 } };
      const left = { ...common, origin: 'plan-gate' };
      const right = { ...common, origin: 'review-triage' };
      const stable = { ...common, id: 'G-stable', origin: 'plan-gate' };
      for (const value of (reverse ? [right, left, stable, stable] : [left, right, stable, stable])) f.write('gates', JSON.stringify(value));
      const report = buildAutonomyReport(f.input);
      return { value: report.families.human_interventions.measures.registered_human_answers.value, state: report.families.human_interventions.measures.registered_human_answers.state, codes: report.diagnostics.map((entry) => entry.code) };
    } finally { f.cleanup(); }
  }
  const left = run(false);
  const right = run(true);
  assert.deepStrictEqual(left, right);
  assert.strictEqual(left.value, 1);
  assert.strictEqual(left.state, 'conflict');
  assert(left.codes.includes('gate_identity_conflict'));
});

test('conflicting dispatch identity excludes its result instead of first/last wins', () => {
  const f = fixture();
  try {
    const one = dispatch('execute-task/TASK-014', 'D-conflict', { attempt: 1, engine: 'codex' });
    const two = dispatch('execute-task/TASK-014', 'D-conflict', { attempt: 2, engine: 'agy' });
    writeEvents(f, [one, two]);
    writeResult(f, result('D-conflict', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    const report = buildAutonomyReport(f.input);
    assert.strictEqual(report.families.time.measures.execution_sum_ms.value, null);
    assert.strictEqual(report.families.time.measures.execution_sum_ms.state, 'conflict');
  } finally { f.cleanup(); }
});

test('dispatch identity collisions across target scopes conflict before attribution, independent of order', () => {
  const cases = [
    {
      target: { type: 'task', id: 'TASK-014' },
      targetEvent: dispatch('execute-task/TASK-014', 'D-cross-task'),
      foreignEvent: dispatch('execute-task/TASK-999', 'D-cross-task'),
      id: 'D-cross-task',
    },
    {
      target: { type: 'task', id: 'T01', milestone: 'M014', slice: 'S02' },
      targetEvent: dispatch('execute-task/T01', 'D-cross-slice', { milestone: 'M014', slice: 'S02' }),
      foreignEvent: dispatch('execute-task/T01', 'D-cross-slice', { milestone: 'M014', slice: 'S01' }),
      id: 'D-cross-slice',
    },
  ];
  for (const item of cases) {
    const run = (reverse) => {
      const f = fixture(item.target);
      try {
        writeEvents(f, reverse ? [item.foreignEvent, item.targetEvent] : [item.targetEvent, item.foreignEvent]);
        writeResult(f, result(item.id, '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
        const report = buildAutonomyReport(f.input);
        return {
          valid: report.valid,
          value: report.families.time.measures.execution_sum_ms.value,
          state: report.families.time.measures.execution_sum_ms.state,
          codes: report.diagnostics.map((entry) => entry.code).sort(),
        };
      } finally { f.cleanup(); }
    };
    const forward = run(false);
    assert.deepStrictEqual(forward, run(true));
    assert.strictEqual(forward.valid, false);
    assert.strictEqual(forward.value, null);
    assert.strictEqual(forward.state, 'conflict');
    assert(forward.codes.includes('dispatch_identity_conflict'));
  }
});

test('gate identity collisions across run and unit scopes conflict before attribution, independent of order', () => {
  const run = (reverse) => {
    const f = fixture({ type: 'milestone', id: 'M014' });
    try {
      const common = { schema: 1, id: 'G-cross-run', cwd: f.root, status: 'answered', created_at: 1000, answer: { source: 'human', at: 2000 } };
      const target = { ...common, run_id: 'M014', unit_id: 'S02' };
      const foreign = { ...common, run_id: 'M999', unit_id: 'S09' };
      for (const value of (reverse ? [foreign, target] : [target, foreign])) f.write('gates', JSON.stringify(value));
      const report = buildAutonomyReport(f.input);
      return {
        valid: report.valid,
        value: report.families.human_interventions.measures.registered_human_answers.value,
        state: report.families.human_interventions.measures.registered_human_answers.state,
        codes: report.diagnostics.map((entry) => entry.code).sort(),
      };
    } finally { f.cleanup(); }
  };
  const forward = run(false);
  assert.deepStrictEqual(forward, run(true));
  assert.strictEqual(forward.valid, false);
  assert.strictEqual(forward.value, null);
  assert.strictEqual(forward.state, 'conflict');
  assert(forward.codes.includes('gate_identity_conflict'));
});

test('isolated foreign identity collisions stay non-attributable without conflict or content disclosure', () => {
  const f = fixture();
  try {
    writeEvents(f, [
      dispatch('execute-task/TASK-998', 'D-PRIVATE-FOREIGN'),
      dispatch('execute-task/TASK-999', 'D-PRIVATE-FOREIGN'),
    ]);
    writeResult(f, result('D-PRIVATE-FOREIGN', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    const common = { schema: 1, id: 'G-PRIVATE-FOREIGN', cwd: f.root, status: 'answered', created_at: 1000, answer: { source: 'human', at: 2000 } };
    f.write('gates', JSON.stringify({ ...common, run_id: 'TASK-998', unit_id: 'execute-task/TASK-998' }));
    f.write('gates', JSON.stringify({ ...common, run_id: 'TASK-999', unit_id: 'execute-task/TASK-999' }));
    const report = buildAutonomyReport(f.input);
    const serialized = JSON.stringify(report);
    assert.strictEqual(report.valid, true);
    assert.strictEqual(report.families.time.measures.execution_sum_ms.value, null);
    assert.strictEqual(report.families.human_interventions.measures.registered_human_answers.value, null);
    assert(!report.diagnostics.some((entry) => entry.code.endsWith('_identity_conflict')));
    assert(!report.diagnostics.some((entry) => Object.prototype.hasOwnProperty.call(entry, 'identity')));
    for (const privateValue of ['D-PRIVATE-FOREIGN', 'G-PRIVATE-FOREIGN', 'TASK-998', 'TASK-999']) assert(!serialized.includes(privateValue));
  } finally { f.cleanup(); }
});

test('conflicting result identity is order-independent and cannot attach ambiguously', () => {
  function run(reverse) {
    const f = fixture();
    try {
      writeEvents(f, [dispatch('execute-task/TASK-014', 'D-result-conflict')]);
      const left = result('D-result-conflict', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1, { start_sha: 'aaa', head_sha: 'bbb' });
      const right = result('D-result-conflict', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1, { start_sha: 'ccc', head_sha: 'bbb' });
      for (const value of (reverse ? [right, left] : [left, right])) writeResult(f, value);
      const report = buildAutonomyReport(f.input);
      return {
        value: report.families.time.measures.execution_sum_ms.value,
        state: report.families.time.measures.execution_sum_ms.state,
        diagnostics: report.diagnostics.map((entry) => entry.code),
      };
    } finally { f.cleanup(); }
  }
  const forward = run(false);
  assert.deepStrictEqual(forward, run(true));
  assert.strictEqual(forward.value, null);
  assert.strictEqual(forward.state, 'conflict');
  assert(forward.diagnostics.includes('result_identity_conflict'));
});

test('invalid and conflicting intervals never become zero while a closed zero interval is observed', () => {
  const invalidCases = [
    result('D-time', '2026-09-24T10:00:00', '2026-09-24T10:00:01Z', 1),
    result('D-time', '2026-09-24T10:00:02Z', '2026-09-24T10:00:01Z', 0),
    result('D-time', '2026-09-24T10:00:00Z', undefined, 1),
    result('D-time', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', '1'),
    result('D-time', '2026-09-24T10:00:00Z', '2026-09-24T10:00:10Z', 50),
  ];
  for (const invalid of invalidCases) {
    const f = fixture();
    try {
      writeEvents(f, [dispatch('execute-task/TASK-014', 'D-time')]);
      writeResult(f, invalid);
      const measure = buildAutonomyReport(f.input).families.time.measures.execution_sum_ms;
      assert.strictEqual(measure.value, null);
      assert(['invalid', 'conflict'].includes(measure.state));
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    writeEvents(f, [dispatch('execute-task/TASK-014', 'D-zero')]);
    writeResult(f, result('D-zero', '2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z', 0));
    const measure = buildAutonomyReport(f.input).families.time.measures.execution_sum_ms;
    assert.strictEqual(measure.value, 0);
    assert.strictEqual(measure.state, 'observed');
  } finally { f.cleanup(); }
});

test('dispatch without id, refused dispatch, orphan result and foreign task do not create duration', () => {
  const f = fixture();
  try {
    writeEvents(f, [
      dispatch('execute-task/TASK-014', 'D-no-id', { removeId: true }),
      dispatch('execute-task/TASK-014', 'D-refused', { allowed: false }),
      dispatch('execute-task/TASK-999', 'D-foreign'),
    ]);
    writeResult(f, result('D-refused', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    writeResult(f, result('D-orphan', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    const report = buildAutonomyReport(f.input);
    assert.strictEqual(report.families.time.measures.execution_sum_ms.value, null);
    for (const code of ['dispatch_identity_missing', 'dispatch_refused_no_duration', 'result_orphan', 'dispatch_not_attributable']) {
      assert(report.diagnostics.some((entry) => entry.code === code), code);
    }
  } finally { f.cleanup(); }
});

test('exact target grammar covers global, local, slice, and milestone without cross-slice leakage', () => {
  const cases = [
    { target: { type: 'task', id: 'T-20260924193738-sample' }, event: dispatch('execute-task/T-20260924193738-sample', 'D-global'), expected: true },
    { target: { type: 'task', id: 'T01', milestone: 'M014', slice: 'S02' }, event: dispatch('execute-task/T01', 'D-local', { milestone: 'M014', slice: 'S02' }), expected: true },
    { target: { type: 'task', id: 'T01', milestone: 'M014', slice: 'S02' }, event: dispatch('execute-task/T01', 'D-other', { milestone: 'M014', slice: 'S01' }), expected: false },
    { target: { type: 'slice', id: 'S02', milestone: 'M014' }, event: dispatch('execute-task/T01', 'D-slice', { milestone: 'M014', slice: 'S02' }), expected: true },
    { target: { type: 'milestone', id: 'M014' }, event: dispatch('execute-task/T01', 'D-milestone', { milestone: 'M014', slice: 'S02' }), expected: true },
    { target: { type: 'milestone', id: 'M014' }, event: dispatch('plan-slice/S02', 'D-plan-slice', { milestone: 'M014', slice: 'S02' }), expected: true },
  ];
  for (const item of cases) {
    const f = fixture(item.target);
    try {
      writeEvents(f, [item.event]);
      writeResult(f, result(item.event.dispatch_id, '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
      const value = buildAutonomyReport(f.input).families.time.measures.execution_sum_ms.value;
      assert.strictEqual(value !== null, item.expected, JSON.stringify(item.target));
    } finally { f.cleanup(); }
  }
});

test('global task rejects a dispatch carrying a foreign milestone', () => {
  const f = fixture();
  try {
    writeEvents(f, [dispatch('execute-task/TASK-014', 'D-foreign-ms', { milestone: 'M999', slice: 'S01' })]);
    writeResult(f, result('D-foreign-ms', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    assert.strictEqual(buildAutonomyReport(f.input).families.time.measures.execution_sum_ms.value, null);
  } finally { f.cleanup(); }
});

test('malformed JSON, truncated JSONL, scalar rows, missing files, directories, and excessive files are explicit errors', () => {
  const cases = [
    (f) => f.write('gates', '{not json'),
    (f) => f.write('events', '{"event":"dispatch"'),
    (f) => f.write('events', '42\n'),
    (f) => f.input.sources.gates.push('telemetry/missing.json'),
    (f) => { fs.mkdirSync(path.join(f.root, 'telemetry', 'dir'), { recursive: true }); f.input.sources.gates.push('telemetry/dir'); },
    (f) => f.write('results', Buffer.alloc(MAX_FILE_BYTES + 1, 65)),
  ];
  for (const arrange of cases) {
    const f = fixture();
    try {
      arrange(f);
      const report = buildAutonomyReport(f.input);
      assert.strictEqual(report.valid, false);
      assert(report.diagnostics.some((entry) => entry.severity === 'error'));
    } finally { f.cleanup(); }
  }
});

test('source and record count limits fail closed without truncation', () => {
  const references = fixture();
  try {
    references.input.sources.gates = Array.from({ length: 101 }, (_, index) => `gate-${index}.json`);
    const report = buildAutonomyReport(references.input);
    assert(report.diagnostics.some((entry) => entry.code === 'source_reference_limit_exceeded'));
  } finally { references.cleanup(); }

  const records = fixture();
  try {
    const row = JSON.stringify({ event: 'unsupported' });
    records.write('events', `${Array.from({ length: MAX_RECORDS_PER_SOURCE + 1 }, () => row).join('\n')}\n`);
    const report = buildAutonomyReport(records.input);
    assert(report.diagnostics.some((entry) => entry.code === 'source_record_limit_exceeded'));
  } finally { records.cleanup(); }
});

test('source and manifest reads stay bounded to MAX_FILE_BYTES + 1 under simulated concurrent growth', () => {
  const source = fixture();
  try {
    source.write('gates', '{}');
    const sourceReads = [];
    const report = buildAutonomyReport(source.input, { io: growingFileIo(sourceReads) });
    assert(report.diagnostics.some((entry) => entry.code === 'source_too_large'));
    assert.deepStrictEqual(sourceReads, [MAX_FILE_BYTES + 1]);

    const manifestFile = path.join(source.root, 'manifest-bounded.json');
    fs.writeFileSync(manifestFile, JSON.stringify(source.input));
    const manifestReads = [];
    const manifest = readAutonomyManifest(manifestFile, { io: growingFileIo(manifestReads) });
    assert.strictEqual(manifest.error.code, 'manifest_too_large');
    assert.deepStrictEqual(manifestReads, [MAX_FILE_BYTES + 1]);
  } finally { source.cleanup(); }
});

test('BOM, CRLF, and CR JSONL are parsed from the validated bytes', () => {
  const f = fixture();
  try {
    const rows = [dispatch('execute-task/TASK-014', 'D-crlf'), { event: 'unsupported' }];
    f.write('events', `\uFEFF${JSON.stringify(rows[0])}\r\n${JSON.stringify(rows[1])}\r`);
    writeResult(f, result('D-crlf', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    const report = buildAutonomyReport(f.input);
    assert.strictEqual(report.families.time.measures.execution_sum_ms.value, 1000);
    assert(report.diagnostics.some((entry) => entry.code === 'event_record_unsupported'));
  } finally { f.cleanup(); }
});

test('traversal, outside absolute files, and false worktrees fail closed without leaking supplied paths', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autonomy-outside-PRIVATE_OWNER_SENTINEL-'));
  const outside = path.join(outsideRoot, 'secret.json');
  fs.writeFileSync(outside, JSON.stringify({ secret: 'PRIVATE_FILE_SENTINEL' }));
  const f = fixture();
  try {
    f.input.sources.gates.push(outside);
    let report = buildAutonomyReport(f.input);
    assert.strictEqual(report.valid, false);
    assert(!JSON.stringify(report).includes(outsideRoot));
    assert(!JSON.stringify(report).includes('PRIVATE_FILE_SENTINEL'));
    const fake = path.join(f.root, 'fake-worktree');
    fs.mkdirSync(fake);
    report = buildAutonomyReport({ ...f.input, code_root: fake, branch: 'forge/fake', sources: { gates: [], events: [], results: [] } });
    assert(report.diagnostics.some((entry) => entry.code.startsWith('worktree_')));
  } finally {
    f.cleanup();
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('a registered worktree of the declared repository and branch is accepted as the second fixed root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autonomy-worktree-'));
  const owner = path.join(base, 'owner');
  const worktree = path.join(base, 'code');
  fs.mkdirSync(path.join(owner, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(owner, '.gsd', 'PROJECT.md'), '# project\n');
  const git = (args, cwd = owner) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'user.name', 'Fixture']);
    git(['add', '.gsd/PROJECT.md']);
    git(['commit', '-m', 'fixture']);
    git(['worktree', 'add', '-b', 'forge/autonomy-test', worktree]);
    const gateFile = path.join(worktree, 'gate.json');
    fs.writeFileSync(gateFile, JSON.stringify({
      schema: 1, id: 'G-worktree', cwd: worktree, run_id: 'TASK-014',
      unit_id: 'execute-task/TASK-014', status: 'answered', created_at: 1,
      answer: { source: 'human', at: 2 },
    }));
    const report = buildAutonomyReport({
      schema_version: 1,
      owner_root: owner,
      code_root: worktree,
      branch: 'forge/autonomy-test',
      target: { type: 'task', id: 'TASK-014' },
      sources: { gates: [path.relative(owner, gateFile)], events: [], results: [] },
    });
    assert.strictEqual(report.valid, true, JSON.stringify(report.diagnostics));
    assert.strictEqual(report.families.human_interventions.measures.registered_human_answers.value, 1);
    assert(report.families.human_interventions.measures.registered_human_answers.references[0].source.startsWith('code:'));
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: owner, encoding: 'utf8' });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a gate cwd may use the declared lexical root alias while foreign roots remain excluded', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autonomy-root-alias-'));
  const realRoot = path.join(base, 'project');
  const aliasRoot = path.join(base, 'project-alias');
  const foreignRoot = path.join(base, 'foreign');
  fs.mkdirSync(path.join(realRoot, '.gsd'), { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  fs.writeFileSync(path.join(realRoot, '.gsd', 'PROJECT.md'), '# project\n');
  try {
    try { fs.symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { skip('declared root lexical alias', `platform denied symlink (${error.code})`); return; }
      throw error;
    }
    const telemetry = path.join(realRoot, 'telemetry');
    fs.mkdirSync(telemetry, { recursive: true });
    fs.writeFileSync(path.join(telemetry, 'alias.json'), JSON.stringify({
      schema: 1, id: 'G-alias', cwd: aliasRoot, run_id: 'TASK-014',
      unit_id: 'execute-task/TASK-014', status: 'answered', created_at: 1,
      answer: { source: 'human', at: 2 },
    }));
    fs.writeFileSync(path.join(telemetry, 'foreign.json'), JSON.stringify({
      schema: 1, id: 'G-foreign', cwd: foreignRoot, run_id: 'TASK-014',
      unit_id: 'execute-task/TASK-014', status: 'answered', created_at: 1,
      answer: { source: 'human', at: 2 },
    }));
    const report = buildAutonomyReport({
      schema_version: 1,
      owner_root: aliasRoot,
      target: { type: 'task', id: 'TASK-014' },
      sources: { gates: ['telemetry/alias.json', 'telemetry/foreign.json'], events: [], results: [] },
    });
    assert.strictEqual(report.valid, true, JSON.stringify(report.diagnostics));
    assert.strictEqual(report.families.human_interventions.measures.registered_human_answers.value, 1);
    assert(report.diagnostics.some((entry) => entry.code === 'gate_cwd_foreign'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an exterior symlink is rejected after realpath resolution when the platform permits symlinks', () => {
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-autonomy-link-outside-'));
  const outside = path.join(outsideRoot, 'secret.json');
  fs.writeFileSync(outside, '{}');
  const f = fixture();
  try {
    const link = path.join(f.root, 'telemetry', 'link.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(outside, link, 'file'); } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { skip('exterior symlink', `platform denied symlink (${error.code})`); return; }
      throw error;
    }
    f.input.sources.gates.push(path.relative(f.root, link));
    const report = buildAutonomyReport(f.input);
    assert(report.diagnostics.some((entry) => entry.code === 'source_outside_roots'));
  } finally {
    f.cleanup();
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('report generation is read-only and leaves expired gate bytes intact', () => {
  const f = fixture();
  try {
    gate(f, { id: 'G-expired', status: 'pending', created_at: 1, expires_at: 2, answer: null });
    const before = snapshot(f.root);
    buildAutonomyReport(f.input);
    const after = snapshot(f.root);
    assert.deepStrictEqual(after, before);
  } finally { f.cleanup(); }
});

test('report and references are deterministic across repeated builds', () => {
  const f = fixture();
  try {
    gate(f, { id: 'G-deterministic' });
    writeEvents(f, [dispatch('execute-task/TASK-014', 'D-deterministic')]);
    writeResult(f, result('D-deterministic', '2026-09-24T10:00:00Z', '2026-09-24T10:00:01Z', 1));
    assert.strictEqual(JSON.stringify(buildAutonomyReport(f.input)), JSON.stringify(buildAutonomyReport(f.input)));
  } finally { f.cleanup(); }
});

test('CLI emits JSON and pt-BR text, uses exit 0 for gaps, and exit 2 for invalid sources without stacks', () => {
  const f = fixture();
  try {
    const manifest = path.join(f.root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(f.input));
    const json = spawnSync(process.execPath, [SCRIPT, '--input', manifest, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 0, json.stderr);
    assert.deepStrictEqual(Object.keys(JSON.parse(json.stdout).families), ['human_interventions', 'time', 'reviews', 'resumptions']);
    const text = spawnSync(process.execPath, [SCRIPT, '--input', manifest], { encoding: 'utf8' });
    assert.strictEqual(text.status, 0, text.stderr);
    assert(text.stdout.includes('Intervenções humanas') && text.stdout.includes('Retomadas'));
    f.input.sources.gates.push('missing-PRIVATE_PATH_SENTINEL.json');
    fs.writeFileSync(manifest, JSON.stringify(f.input));
    const invalid = spawnSync(process.execPath, [SCRIPT, '--input', manifest, '--json'], { encoding: 'utf8' });
    assert.strictEqual(invalid.status, 2);
    assert(!invalid.stdout.includes('PRIVATE_PATH_SENTINEL'));
    assert(!invalid.stderr.includes('at '));
    assert.strictEqual(JSON.parse(invalid.stdout).valid, false);
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert(help.stdout.includes('--input'));
  } finally { f.cleanup(); }
});

test('invalid target and owner are rejected before any source content is read or exposed', () => {
  const f = fixture();
  try {
    const secret = f.write('gates', 'PRIVATE_MALFORMED_SOURCE_SENTINEL');
    const badTarget = buildAutonomyReport({ ...f.input, target: { type: 'task', id: 'T01' } });
    assert(badTarget.diagnostics.some((entry) => entry.code === 'target_local_task_context_invalid'));
    assert(!JSON.stringify(badTarget).includes('PRIVATE_MALFORMED_SOURCE_SENTINEL'));
    const badOwner = buildAutonomyReport({ ...f.input, owner_root: path.join(f.root, 'missing-PRIVATE_OWNER') });
    assert(badOwner.diagnostics.some((entry) => entry.code === 'owner_root_unreadable'));
    assert(!JSON.stringify(badOwner).includes(secret.absolute));
  } finally { f.cleanup(); }
});

test('rendered Markdown contains states, coverage, sanitized evidence, and no raw private data', () => {
  const f = fixture();
  try {
    gate(f, { id: 'G-render', answer: { source: 'human', at: 4000, notes: 'PRIVATE_RENDER_SENTINEL' } });
    const markdown = renderAutonomyMarkdown(buildAutonomyReport(f.input));
    assert(markdown.includes('estado=observed'));
    assert(markdown.includes('cobertura=provided_sources_only'));
    assert(markdown.includes('owner:telemetry/'));
    assert(!markdown.includes('PRIVATE_RENDER_SENTINEL'));
  } finally { f.cleanup(); }
});

test('documented target shapes and public API/CLI contract remain present', () => {
  const contract = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-autonomy.md'), 'utf8');
  for (const needle of ['buildAutonomyReport', 'renderAutonomyMarkdown', '"type": "task"', '"type": "slice"', '"type": "milestone"', '--input autonomy-input.json --json']) {
    assert(contract.includes(needle), needle);
  }
});

process.stdout.write(`\n${passed} passed, 0 failed${skipped ? `, ${skipped} skipped` : ''}\n`);
