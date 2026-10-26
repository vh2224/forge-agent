#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const extraction = require('./forge-memory-extraction');
const memory = require('./forge-memory');
const projection = require('./forge-projection');
const quarantine = require('./forge-memory-quarantine');
const { serializeGroup } = require('./forge-grouped-file');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function result(overrides) {
  return {
    schema_version: 1,
    status: 'done',
    summary: 'durable findings',
    questions: [],
    facts: [],
    events: [],
    ...(overrides || {}),
  };
}

function candidate(localId, text, overrides) {
  return {
    local_id: localId,
    category: 'gotcha',
    text,
    confidence_base: 0.95,
    ...(overrides || {}),
  };
}

function context(extractionId, overrides) {
  return {
    unitId: 'T01',
    milestoneId: 'M001',
    extractionId,
    extractedAt: '2026-09-24T22:30:00.000Z',
    source: {
      sourceUnit: 'execute-task/T01',
      sourceFingerprint: 'sha256:source',
      dispatchId: 'dispatch-1',
      model: 'gpt-6-luna',
      effort: 'medium',
    },
    ...(overrides || {}),
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-extraction-'));
}

function publish(cwd, value, sourceContext) {
  return extraction.publishExtraction({ cwd, extraction: value, sourceContext });
}

function snapshot(cwd) {
  const root = path.join(cwd, '.gsd');
  if (!fs.existsSync(root)) return [];
  const rows = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else rows.push(`${path.relative(cwd, target)}:${fs.readFileSync(target).toString('base64')}`);
    }
  }
  walk(root);
  return rows.sort();
}

function canonicalFact(memId, text) {
  return {
    mem_id: memId,
    category: 'gotcha',
    text,
    confidence_base: 0.9,
    created_at: '2026-09-20T00:00:00.000Z',
    source_unit: 'execute-task/T01',
  };
}

// ── v2 fixtures: owner evidence is bound to context().source ────────────────
const SOURCE = { sourceUnit: 'execute-task/T01', sourceFingerprint: 'sha256:source' };
const NOW_MS = Date.parse('2026-09-24T22:30:00.000Z');

function v2Result(overrides) {
  return { schema_version: 2, status: 'done', summary: 'evidence findings', questions: [], facts: [], events: [],
    ...(overrides || {}) };
}

function ownerRecord(ref, kind, overrides) {
  return { evidence_ref: ref, observation_id: `obs-${ref}`, source_unit: SOURCE.sourceUnit,
    source_fingerprint: SOURCE.sourceFingerprint, observed_kind: kind,
    ...(kind === 'confirm' ? { independent_ref: `verify:${ref}` } : {}), ...(overrides || {}) };
}

function registry(records, outcomes) {
  return extraction.normalizeEvidenceRegistry({ records, outcomes: outcomes || [] }, SOURCE);
}

function v2Context(extractionId, records, outcomes, overrides) {
  return context(extractionId, { evidence: registry(records || [], outcomes), ...(overrides || {}) });
}

function originFact(memId, text, overrides) {
  return { ...canonicalFact(memId, text), extraction_id: 'origin-extraction', source_fingerprint: 'sha256:origin',
    ...(overrides || {}) };
}

function reason(fn) {
  try {
    fn();
  } catch (error) {
    return error.reason;
  }
  return null;
}

// Publication and projection fold the same stored rows with the same reducer:
// the published semantic state equals the projected one at a fixed clock.
function assertProjectionMatches(cwd, state) {
  assert(Array.isArray(state) && state.length > 0, 'publication returns its folded state');
  const projected = projection.projectMemoryState(cwd, { nowMs: NOW_MS });
  const byIdentity = new Map(projected.entries.map(entry => [entry.identity, entry]));
  for (const item of state) {
    const entry = byIdentity.get(`M001/T01/${item.mem_id}`);
    if (item.pruned) {
      assert(!entry, `${item.mem_id} is pruned in both views`);
      continue;
    }
    assert(entry, `${item.mem_id} is projected`);
    const counters = entry.evidence.counters;
    assert.deepStrictEqual(
      [entry.hits, entry.base_confidence, entry.promoted, entry.evidence.v2.independent_confirmation_count,
        entry.evidence.v2.confidence, entry.evidence.v2.promoted, counters.exposure.count, counters.reobserve.count,
        counters.independent_confirmation.count, counters.utility.count],
      [item.hits, item.confidence, item.promoted, item.independent_confirmation_count, item.v2_confidence,
        item.v2_promoted, item.counters.exposure, item.counters.reobserve, item.counters.independent_confirmation,
        item.counters.utility],
      item.mem_id,
    );
  }
  assert.strictEqual(projected.entries.filter(entry => entry.identity.startsWith('M001/T01/')).length,
    state.filter(item => !item.pruned).length);
}

test('validator accepts the exact strict envelope and returns a frozen copy', () => {
  const validated = extraction.validateExtractionResult(result({
    facts: [candidate('new1', 'A durable project-specific constraint.')],
    events: [{ kind: 'seed', local_id: 'new1' }],
  }));
  assert(Object.isFrozen(validated));
  assert(Object.isFrozen(validated.facts[0]));
  assert.strictEqual(validated.facts[0].local_id, 'new1');
});

test('validator rejects worker paths, identities, unknown kinds and dangling references', () => {
  for (const extra of [
    { cwd: 'C:/redirect' },
    { unit_id: 'T99' },
    { milestone_id: 'M999' },
    { dispatch_id: 'worker-chosen' },
  ]) {
    assert.throws(
      () => extraction.validateExtractionResult({ ...result(), ...extra }),
      error => error.code === 'MEMORY_EXTRACTION_INVALID' && /unexpected property/.test(error.message),
    );
  }
  assert.throws(
    () => extraction.validateExtractionResult(result({ events: [{ kind: 'execute', existing_id: 'MEM001' }] })),
    /unknown event kind/,
  );
  assert.throws(
    () => extraction.validateExtractionResult(result({ events: [{ kind: 'hit', local_id: 'missing' }] })),
    /dangling candidate reference/,
  );
});

test('validator enforces duplicate IDs, references and finite numeric bounds', () => {
  assert.throws(
    () => extraction.validateExtractionResult(result({
      facts: [candidate('a', 'one'), candidate('a', 'two')],
    })),
    /duplicate local_id/,
  );
  for (const confidence of [NaN, Infinity, -0.01, 1.01]) {
    assert.throws(
      () => extraction.validateExtractionResult(result({ facts: [candidate('a', 'one', { confidence_base: confidence })] })),
      /finite number|between 0 and 1/,
    );
  }
  assert.throws(
    () => extraction.validateExtractionResult(result({
      facts: [candidate('a', 'one')],
      events: [{ kind: 'hit', local_id: 'a' }, { kind: 'hit', local_id: 'a' }],
    })),
    /duplicate event/,
  );
});

test('validator accepts every documented boundary and rejects the next value', () => {
  const limits = extraction.LIMITS;
  extraction.validateExtractionResult(result({
    summary: 's'.repeat(limits.summaryChars),
    facts: Array.from({ length: limits.facts }, (_, index) => candidate(`f${index}`, 'x'.repeat(limits.factTextChars))),
    events: Array.from({ length: limits.events }, (_, index) => ({ kind: 'hit', existing_id: `MEM${String(index + 1).padStart(3, '0')}` })),
  }));
  extraction.validateExtractionResult(result({
    status: 'blocked',
    questions: Array.from({ length: limits.questions }, () => 'q'.repeat(limits.questionChars)),
  }));
  assert.throws(() => extraction.validateExtractionResult(result({ summary: 's'.repeat(limits.summaryChars + 1) })), /at most/);
  assert.throws(() => extraction.validateExtractionResult(result({ questions: Array(limits.questions + 1).fill('q') })), /at most/);
  assert.throws(() => extraction.validateExtractionResult(result({ questions: ['q'.repeat(limits.questionChars + 1)] })), /at most/);
  assert.throws(() => extraction.validateExtractionResult(result({ facts: Array.from({ length: limits.facts + 1 }, (_, i) => candidate(`f${i}`, 'x')) })), /at most/);
  assert.throws(() => extraction.validateExtractionResult(result({ facts: [candidate('f', 'x'.repeat(limits.factTextChars + 1))] })), /at most/);
  assert.throws(() => extraction.validateExtractionResult(result({ events: Array.from({ length: limits.events + 1 }, (_, i) => ({ kind: 'hit', existing_id: `MEM${String(i + 1).padStart(3, '0')}` })) })), /at most/);
});

test('partial, blocked and error outputs cannot smuggle publishable rows', () => {
  for (const status of ['partial', 'blocked', 'error']) {
    const clean = extraction.validateExtractionResult(result({ status }));
    assert.strictEqual(clean.status, status);
    assert.throws(
      () => extraction.validateExtractionResult(result({ status, facts: [candidate('x', 'must not publish')] })),
      /cannot carry publishable/,
    );
  }
  assert.throws(
    () => extraction.validateExtractionResult(result({ questions: ['Need an owner decision'] })),
    /done results cannot carry unresolved questions/,
  );
});

test('empty and non-done results perform no filesystem writes', () => {
  const cwd = tempDir();
  try {
    for (const value of [result(), result({ status: 'partial' }), result({ status: 'blocked' }), result({ status: 'error' })]) {
      const before = snapshot(cwd);
      const outcome = publish(cwd, value, context(`empty-${value.status}`));
      assert.strictEqual(outcome.status, 'noop');
      assert.deepStrictEqual(snapshot(cwd), before);
    }
    assert.throws(
      () => publish(cwd, { ...result(), path: '../escape' }, context('invalid-before-write')),
      /unexpected property/,
    );
    assert.deepStrictEqual(snapshot(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('owner publication allocates canonical IDs and persists scalar provenance', () => {
  const cwd = tempDir();
  try {
    const outcome = publish(cwd, result({
      facts: [candidate('new1', 'First safe publication.')],
      events: [{ kind: 'seed', local_id: 'new1' }],
    }), context('extract-1'));
    assert.strictEqual(outcome.status, 'written');
    assert.deepStrictEqual(outcome.mappings, { new1: 'MEM001' });
    assert.deepStrictEqual(outcome.counts, { facts: 1, events: 1 });
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    assert.strictEqual(fragment.facts[0].extraction_id, 'extract-1');
    assert.strictEqual(fragment.facts[0].candidate_id, 'new1');
    assert.strictEqual(fragment.facts[0].source_fingerprint, 'sha256:source');
    assert.strictEqual(fragment.facts[0].model, 'gpt-6-luna');
    assert.strictEqual(fragment.stats[0].event_id, 'extract-1:seed:new1');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('same extraction replay is byte-idempotent and does not inflate hits', () => {
  const cwd = tempDir();
  try {
    const first = publish(cwd, result({ facts: [candidate('new1', 'Replay-safe candidate.')] }), context('extract-replay'));
    assert.strictEqual(first.status, 'written');
    const target = first.path;
    const before = fs.readFileSync(target);
    const replay = publish(cwd, result({ facts: [candidate('new1', 'Replay-safe candidate.')] }), context('extract-replay'));
    assert.strictEqual(replay.status, 'noop');
    assert.strictEqual(replay.reason, 'replay');
    assert.deepStrictEqual(replay.mappings, { new1: 'MEM001' });
    assert(fs.readFileSync(target).equals(before));

    const hitResult = result({ events: [{ kind: 'hit', existing_id: 'MEM001' }] });
    publish(cwd, hitResult, context('extract-hit'));
    publish(cwd, hitResult, context('extract-hit'));
    const entries = projection.projectMemoryEntries(cwd, { nowMs: Date.parse('2026-09-24T22:30:00.000Z') });
    assert.strictEqual(entries[0].hits, 1, 'replayed hit must be counted once');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('supersede and prune replays validate their canonical events before current-state eligibility', () => {
  const supersedeCwd = tempDir();
  const pruneCwd = tempDir();
  try {
    memory.writeFragment(supersedeCwd, {
      unit_id: 'T01', milestone_id: 'M001',
      facts: [canonicalFact('MEM001', 'Superseded fact.')], stats: [],
    });
    const supersede = result({
      facts: [candidate('replacement', 'Durable replacement.')],
      events: [{ kind: 'supersede', existing_id: 'MEM001', replacement_local_id: 'replacement' }],
    });
    const supersedeContext = context('replay-supersede');
    const firstSupersede = publish(supersedeCwd, supersede, supersedeContext);
    const supersedeBytes = fs.readFileSync(firstSupersede.path);
    const replayedSupersede = publish(supersedeCwd, supersede, supersedeContext);
    assert.strictEqual(firstSupersede.status, 'written');
    assert.strictEqual(replayedSupersede.status, 'noop');
    assert.strictEqual(replayedSupersede.reason, 'replay');
    assert(fs.readFileSync(firstSupersede.path).equals(supersedeBytes));
    const changedSupersede = publish(supersedeCwd, result({
      facts: supersede.facts,
      events: [{ kind: 'hit', existing_id: 'MEM001' }],
    }), supersedeContext);
    assert.strictEqual(changedSupersede.status, 'conflict');
    assert.match(changedSupersede.reason, /event identity/);
    assert(fs.readFileSync(firstSupersede.path).equals(supersedeBytes));

    memory.writeFragment(pruneCwd, {
      unit_id: 'T01', milestone_id: 'M001',
      facts: Array.from({ length: 50 }, (_, index) => canonicalFact(
        `MEM${String(index + 1).padStart(3, '0')}`, `Prune candidate ${index}.`,
      )),
      stats: [],
    });
    const prune = result({
      facts: [candidate('overflow', 'Overflow fact.')],
      events: [{ kind: 'prune', existing_id: 'MEM001', reason: 'cap' }],
    });
    const pruneContext = context('replay-prune');
    const firstPrune = publish(pruneCwd, prune, pruneContext);
    const pruneBytes = fs.readFileSync(firstPrune.path);
    const replayedPrune = publish(pruneCwd, prune, pruneContext);
    assert.strictEqual(firstPrune.status, 'written');
    assert.strictEqual(replayedPrune.status, 'noop');
    assert.strictEqual(replayedPrune.reason, 'replay');
    assert(fs.readFileSync(firstPrune.path).equals(pruneBytes));
    const changedPrune = publish(pruneCwd, result({
      facts: prune.facts,
      events: [{ kind: 'prune', existing_id: 'MEM002', reason: 'cap' }],
    }), pruneContext);
    assert.strictEqual(changedPrune.status, 'conflict');
    assert(fs.readFileSync(firstPrune.path).equals(pruneBytes));
  } finally {
    fs.rmSync(supersedeCwd, { recursive: true, force: true });
    fs.rmSync(pruneCwd, { recursive: true, force: true });
  }
});

test('changed content under the same extraction/candidate identity returns conflict without writes', () => {
  const cwd = tempDir();
  try {
    const first = publish(cwd, result({ facts: [candidate('new1', 'Immutable text.')] }), context('extract-conflict'));
    const before = fs.readFileSync(first.path);
    const conflict = publish(cwd, result({ facts: [candidate('new1', 'Changed text.')] }), context('extract-conflict'));
    assert.strictEqual(conflict.status, 'conflict');
    assert.match(conflict.reason, /changed during extraction replay/);
    assert(fs.readFileSync(first.path).equals(before));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sequential stale candidates receive distinct owner-allocated IDs', () => {
  const cwd = tempDir();
  try {
    const one = publish(cwd, result({ facts: [candidate('new1', 'Fact from stale reader one.')] }), context('stale-one'));
    const two = publish(cwd, result({ facts: [candidate('new1', 'Fact from stale reader two.')] }), context('stale-two'));
    assert.deepStrictEqual(one.mappings, { new1: 'MEM001' });
    assert.deepStrictEqual(two.mappings, { new1: 'MEM002' });
    assert.strictEqual(memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).facts.length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('concurrent CLI publishers allocate every canonical ID under the fragment lock', async () => {
  const cwd = tempDir();
  const script = path.join(__dirname, 'forge-memory-extraction.js');
  const requests = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const requestPath = path.join(os.tmpdir(), `forge-memory-request-${process.pid}-${Date.now()}-${index}.json`);
      fs.writeFileSync(requestPath, JSON.stringify({
        cwd,
        extraction: result({ facts: [candidate('candidate', `Concurrent fact ${index}.`)] }),
        sourceContext: context(`concurrent-${index}`),
      }));
      requests.push(requestPath);
    }
    await Promise.all(requests.map(requestPath => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--publish', '--request', requestPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    })));
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    assert.strictEqual(fragment.facts.length, requests.length);
    assert.strictEqual(new Set(fragment.facts.map(fact => fact.mem_id)).size, requests.length);
  } finally {
    for (const requestPath of requests) fs.rmSync(requestPath, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('same-time supersedes remain distinct and project both old facts away', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, {
      unit_id: 'T01', milestone_id: 'M001',
      facts: [canonicalFact('MEM001', 'Old one.'), canonicalFact('MEM002', 'Old two.')],
      stats: [],
    });
    const outcome = publish(cwd, result({
      facts: [candidate('replacement1', 'Replacement one.'), candidate('replacement2', 'Replacement two.')],
      events: [
        { kind: 'supersede', existing_id: 'MEM001', replacement_local_id: 'replacement1' },
        { kind: 'supersede', existing_id: 'MEM002', replacement_local_id: 'replacement2' },
      ],
    }), context('supersede-two'));
    assert.strictEqual(outcome.status, 'written');
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    const supersedes = fragment.stats.filter(stat => stat.kind === 'supersede');
    assert.strictEqual(supersedes.length, 2);
    assert.notStrictEqual(supersedes[0].event_id, supersedes[1].event_id);
    const visible = projection.projectMemoryEntries(cwd, { nowMs: Date.parse(context('x').extractedAt) });
    assert(!visible.some(entry => entry.fact.text.startsWith('Old')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('promotion is rechecked against current hits and rejected below threshold', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, {
      unit_id: 'T01', milestone_id: 'M001',
      facts: [canonicalFact('MEM001', 'Reusable architecture constraint.')],
      stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0.9, hits: 2 }],
    });
    const promoted = publish(cwd, result({ events: [
      { kind: 'hit', existing_id: 'MEM001' },
      { kind: 'promote', existing_id: 'MEM001', threshold_met: true },
    ] }), context('promotion-ok'));
    assert.strictEqual(promoted.status, 'written');
    const projected = projection.projectMemoryEntries(cwd, { nowMs: Date.parse(context('x').extractedAt) });
    assert.strictEqual(projected[0].promoted, true);

    const before = fs.readFileSync(promoted.path);
    const refused = publish(cwd, result({
      facts: [candidate('low', 'A tentative pattern.', { confidence_base: 0.7, category: 'pattern' })],
      events: [{ kind: 'promote', local_id: 'low', threshold_met: true }],
    }), context('promotion-low'));
    assert.strictEqual(refused.status, 'conflict');
    assert(fs.readFileSync(promoted.path).equals(before));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cap boundary keeps 50 active facts and emits deterministic prune events', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, {
      unit_id: 'T01', milestone_id: 'M001',
      facts: Array.from({ length: 50 }, (_, index) => canonicalFact(`MEM${String(index + 1).padStart(3, '0')}`, `Existing fact ${index}.`)),
      stats: [],
    });
    const outcome = publish(cwd, result({ facts: [candidate('overflow', 'Newest durable fact.')] }), context('cap-overflow'));
    assert.strictEqual(outcome.status, 'written');
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    assert.strictEqual(fragment.stats.filter(stat => stat.kind === 'prune').length, 1);
    assert.strictEqual(projection.projectMemoryEntries(cwd, { nowMs: Date.parse(context('x').extractedAt) }).length, 50);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('zero confidence survives seed folding and is pruned before 0.1 at cap 51', () => {
  const cwd = tempDir();
  try {
    const facts = Array.from({ length: 51 }, (_, index) => canonicalFact(
      `MEM${String(index + 1).padStart(3, '0')}`,
      `Confidence fact ${index + 1}.`,
    ));
    facts[0].confidence_base = 0;
    facts[1].confidence_base = 0.1;
    memory.writeFragment(cwd, {
      unit_id: 'T01', milestone_id: 'M001', facts,
      stats: [
        { kind: 'seed', mem_id: 'MEM001', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0, hits: 0 },
        { kind: 'seed', mem_id: 'MEM002', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0.1, hits: 0 },
      ],
    });
    const folded = extraction._private.publicationState(facts, [
      { kind: 'seed', mem_id: 'MEM001', confidence_base: 0, hits: 0 },
    ]);
    assert.strictEqual(folded.get('MEM001').confidence, 0, 'seed confidence zero must not fall back');

    const outcome = publish(cwd, result({ events: [{ kind: 'hit', existing_id: 'MEM051' }] }), context('cap-zero'));
    assert.strictEqual(outcome.status, 'written');
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    const capPrunes = fragment.stats.filter(stat => stat.kind === 'prune' && stat.extraction_id === 'cap-zero');
    assert.strictEqual(capPrunes.length, 1);
    assert.strictEqual(capPrunes[0].mem_id, 'MEM001', '0 must rank below 0.1 for pruning');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('grouped refusal retains full payload/provenance and replay reuses one quarantine record', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, {
      unit_id: 'T01', milestone_id: 'M001', facts: [canonicalFact('MEM001', 'Grouped fact.')], stats: [],
    });
    const loose = memory.fragmentPath(cwd, 'T01', { milestoneId: 'M001' });
    const container = path.join(memory.memoryDir(cwd), 'sweep-project-01.md');
    fs.writeFileSync(container, serializeGroup({
      epoch: 'sweep-project-01',
      units: [{ id: 'M001__T01', content: fs.readFileSync(loose) }],
    }).buffer);
    fs.unlinkSync(loose);

    const value = result({ facts: [candidate('parked', 'Full quarantined payload.')] });
    const first = publish(cwd, value, context('grouped-replay'));
    const second = publish(cwd, value, context('grouped-replay'));
    assert.strictEqual(first.status, 'quarantined');
    assert.strictEqual(second.status, 'quarantined');
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.path, first.path);
    assert.strictEqual(quarantine.listQuarantine(cwd).length, 1);
    const record = JSON.parse(fs.readFileSync(first.path, 'utf8'));
    assert.strictEqual(record.extraction_id, 'grouped-replay');
    assert.strictEqual(record.fragment.facts[1].candidate_id, 'parked');
    assert.strictEqual(record.fragment.facts[1].source_fingerprint, 'sha256:source');
    assert.strictEqual(record.container, fs.realpathSync(container));
    assert.ok(record.remedy);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('validateExtractionResult selects v1 or v2 explicitly and refuses unknown, hybrid and cross-field envelopes', () => {
  const fresh = v2Result({ facts: [candidate('fresh', 'A durable v2 fact.')],
    events: [{ kind: 'seed', local_event_id: 'e0', local_id: 'fresh' }] });
  assert.throws(() => extraction.validateExtractionResult(fresh), /must equal 1/, 'v1 stays the default contract');
  const decoded = extraction.validateExtractionResult(fresh, { schemaVersions: [2] });
  assert.strictEqual(decoded.schema_version, 2);
  assert(Object.isFrozen(decoded.events[0]));
  assert.strictEqual(extraction.validateExtractionResult(result(), { schemaVersions: [1, 2] }).schema_version, 1);
  assert.throws(() => extraction.validateExtractionResult(result(), { schemaVersions: [2] }), /not selected/);
  assert.throws(() => extraction.validateExtractionResult(fresh, { schemaVersions: [3] }), TypeError);
  const both = { schemaVersions: [1, 2] };
  const refusals = [
    [{ ...fresh, schema_version: 3 }, 'unknown-schema-version'],
    [{ ...fresh, schema_version: '2' }, 'unknown-schema-version'],
    [result({ events: [{ kind: 'hit', existing_id: 'MEM001', local_event_id: 'e1' }] }), 'hybrid-shape'],
    [result({ events: [{ kind: 'exposure', existing_id: 'MEM001' }] }), 'hybrid-shape'],
    [v2Result({ events: [{ kind: 'hit', local_event_id: 'e1', existing_id: 'MEM001' }] }), 'hybrid-shape'],
    [v2Result({ events: [{ kind: 'confirm', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'r', mem_id: 'MEM009' }] }), 'invalid-envelope'],
    [v2Result({ events: [{ kind: 'seed', local_event_id: 'e1', local_id: 'missing' }] }), 'invalid-envelope'],
    [v2Result({ status: 'partial', facts: [candidate('x', 'must not publish')] }), 'invalid-envelope'],
    [v2Result({ events: Array.from({ length: extraction.LIMITS.events + 1 }, (_, index) => (
      { kind: 'exposure', local_event_id: `e${index}`, existing_id: 'MEM001', evidence_ref: 'r' })) }), 'invalid-envelope'],
    [v2Result({ events: [{ kind: 'exposure', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'r' },
      { kind: 'reobserve', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'r' }] }), 'invalid-envelope'],
  ];
  for (const [value, expected] of refusals) {
    assert.throws(() => extraction.validateExtractionResult(value, both),
      error => error.code === 'MEMORY_EXTRACTION_INVALID' && error.reason === expected, `${expected}: ${JSON.stringify(value).slice(0, 120)}`);
  }
  assert.throws(() => extraction.validateExtractionResult(v2Result({ facts: [candidate('a', 'one')], events: [
    { kind: 'seed', local_event_id: 's1', local_id: 'a' }, { kind: 'seed', local_event_id: 's2', local_id: 'a' }] }), both),
  /duplicate seed/);
  // With the owner registry known, references outside it are invalid before any write.
  const owner = registry([ownerRecord('seen', 'exposure'), ownerRecord('verified', 'confirm')]);
  const cite = (kind, ref) => v2Result({ events: [{ kind, local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: ref }] });
  assert.strictEqual(extraction.validateExtractionResult(cite('confirm', 'verified'), { ...both, evidence: owner }).events.length, 1);
  assert.throws(() => extraction.validateExtractionResult(cite('confirm', 'ghost'), { ...both, evidence: owner }), /owner-supplied evidence/);
  assert.throws(() => extraction.validateExtractionResult(cite('confirm', 'seen'), { ...both, evidence: owner }), /owner observed exposure/);
  assert.throws(() => extraction.validateExtractionResult(v2Result({ events: [{ kind: 'utility', local_event_id: 'u1',
    existing_id: 'MEM001', evidence_ref: 'seen', outcome_ref: 'nothing' }] }), { ...both, evidence: owner }), /owner observed|outcome/);
});

test('owner evidence registry is closed, bounded, source-bound, digest-stable and sanitized', () => {
  const records = [ownerRecord('verified', 'confirm'), ownerRecord('seen', 'exposure'), ownerRecord('used', 'utility')];
  const outcomes = [{ outcome_ref: 'passed', outcome_id: 'outcome-T05', result_ref: 'result:T05:verify' }];
  const first = registry(records, outcomes);
  const second = registry([...records].reverse(), outcomes);
  assert(Object.isFrozen(first) && Object.isFrozen(first.records[0]));
  assert.strictEqual(first.contract_version, 2);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.strictEqual(second.digest, first.digest, 'order of the owner list never changes the snapshot');
  assert.deepStrictEqual(first.records.map(record => record.evidence_ref), ['seen', 'used', 'verified']);
  assert.strictEqual(extraction.normalizeEvidenceRegistry(JSON.parse(JSON.stringify(first)), SOURCE).digest, first.digest);
  const refuse = (value, source) => reason(() => extraction.normalizeEvidenceRegistry(value, source || SOURCE));
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'exposure', { source_unit: 'execute-task/T99' })], outcomes: [] }), 'evidence-source-mismatch');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'exposure', { source_fingerprint: 'sha256:other' })], outcomes: [] }), 'evidence-source-mismatch');
  const unverified = ownerRecord('a', 'confirm');
  delete unverified.independent_ref;
  assert.strictEqual(refuse({ records: [unverified], outcomes: [] }), 'confirm-binding-missing');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'reobserve', { independent_ref: 'verify:a' })], outcomes: [] }), 'unexpected-property');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'exposure', { path: '/etc/passwd' })], outcomes: [] }), 'unexpected-property');
  assert.strictEqual(refuse({ records: [ownerRecord('../escape', 'exposure')], outcomes: [] }), 'invalid-identifier');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'hit')], outcomes: [] }), 'unknown-kind');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'exposure'), ownerRecord('a', 'reobserve', { observation_id: 'obs-b' })], outcomes: [] }), 'duplicate-reference');
  assert.strictEqual(refuse({ records: [ownerRecord('a', 'exposure'), ownerRecord('b', 'reobserve', { observation_id: 'obs-a' })], outcomes: [] }), 'duplicate-observation');
  assert.strictEqual(refuse({ records: Array.from({ length: 65 }, (_, index) => ownerRecord(`r${index}`, 'exposure')), outcomes: [] }), 'limit');
  assert.strictEqual(refuse({ ...first, digest: 'f'.repeat(64) }), 'evidence-digest-mismatch');
  assert.strictEqual(refuse({ records: [], outcomes: [{ outcome_ref: 'o', outcome_id: 'x' }] }), 'binding-missing');
  const secret = 'PRIVATE source text that must stay out of errors';
  assert.throws(() => extraction.normalizeEvidenceRegistry({ records: [ownerRecord('a', 'exposure', { observation_id: secret })], outcomes: [] }, SOURCE),
    error => error.code === 'MEMORY_EVIDENCE_REGISTRY_INVALID' && !error.message.includes('PRIVATE'));
  assert.strictEqual(extraction.evidenceSourceFingerprint('sha256:source'), 'sha256:source');
  assert.match(extraction.evidenceSourceFingerprint('free form / fingerprint'), /^sha256:[0-9a-f]{64}$/);
});

test('v2 publication binds owner evidence under stable local_event_id identities and matches the projection', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts: [originFact('MEM001', 'Origin fact.')], stats: [] });
    const records = [ownerRecord('seen', 'exposure'), ownerRecord('again', 'reobserve'), ownerRecord('verified', 'confirm'),
      ownerRecord('used', 'utility')];
    const outcomes = [{ outcome_ref: 'passed', outcome_id: 'outcome-T05', result_ref: 'result:T05:verify' }];
    const events = [
      { kind: 'seed', local_event_id: 'e0', local_id: 'fresh' },
      { kind: 'exposure', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'seen' },
      { kind: 'reobserve', local_event_id: 'e2', existing_id: 'MEM001', evidence_ref: 'again' },
      { kind: 'confirm', local_event_id: 'e3', existing_id: 'MEM001', evidence_ref: 'verified' },
      { kind: 'utility', local_event_id: 'e4', existing_id: 'MEM001', evidence_ref: 'used', outcome_ref: 'passed' },
    ];
    const value = v2Result({ facts: [candidate('fresh', 'A durable v2 fact.')], events });
    const ctx = v2Context('v2-a', records, outcomes);
    const first = publish(cwd, value, ctx);
    assert.strictEqual(first.status, 'written', first.reason);
    assert.deepStrictEqual([first.schema_version, first.promotion_policy], [2, 'v2']);
    assert.deepStrictEqual(first.mappings, { fresh: 'MEM002' });
    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    const v2Rows = fragment.stats.filter(stat => stat.evidence_version !== undefined);
    assert.deepStrictEqual(v2Rows.map(stat => stat.event_id).sort(), ['v2-a:v2:e0', 'v2-a:v2:e1', 'v2-a:v2:e2', 'v2-a:v2:e3', 'v2-a:v2:e4']);
    assert(!fragment.stats.some(stat => String(stat.event_id).startsWith('v2-a:seed:')), 'an explicit v2 seed replaces the owner seed');
    const confirm = v2Rows.find(stat => stat.kind === 'confirm');
    assert.deepStrictEqual([confirm.observation_id, confirm.independent_ref, confirm.source_unit],
      ['obs-verified', 'verify:verified', 'execute-task/T01'], 'binding comes from the owner registry');
    const entry = first.state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual(entry.counters, { exposure: 1, reobserve: 1, independent_confirmation: 1, utility: 1 });
    assert.strictEqual(entry.hits, 1, 'only the independent confirmation reinforces');
    assertProjectionMatches(cwd, first.state);

    const bytes = fs.readFileSync(first.path);
    const replay = publish(cwd, value, ctx);
    assert.deepStrictEqual([replay.status, replay.reason], ['noop', 'replay']);
    const reordered = publish(cwd, v2Result({ facts: value.facts, events: [...events].reverse() }), ctx);
    assert.deepStrictEqual([reordered.status, reordered.reason], ['noop', 'replay'], 'array position is not identity');
    assert(fs.readFileSync(first.path).equals(bytes));

    const repackaged = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 'c9', existing_id: 'MEM001',
      evidence_ref: 'verified' }] }), v2Context('v2-b', records, outcomes));
    assert.strictEqual(repackaged.status, 'written', 'same observation retains its new delivery identity');
    assert.strictEqual(repackaged.state.find(item => item.mem_id === 'MEM001').independent_confirmation_count, 1);
    assert(!fs.readFileSync(first.path).equals(bytes));
    const afterDelivery = fs.readFileSync(first.path);

    const changed = publish(cwd, v2Result({ events: [{ kind: 'reobserve', local_event_id: 'e3', existing_id: 'MEM001',
      evidence_ref: 'again' }] }), ctx);
    assert.strictEqual(changed.status, 'conflict');
    assert.match(changed.reason, /event identity v2-a:v2:e3/);
    const ghost = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 'g1', existing_id: 'MEM001',
      evidence_ref: 'ghost' }] }), v2Context('v2-c', records, outcomes));
    assert.deepStrictEqual([ghost.status, ghost.reason_code], ['conflict', 'evidence-binding-refused']);
    const unbound = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 'u1', existing_id: 'MEM001',
      evidence_ref: 'verified' }] }), context('v2-d'));
    assert.deepStrictEqual([unbound.status, unbound.reason_code], ['conflict', 'evidence-binding-refused'],
      'without an owner registry a worker claim never becomes a confirmation');
    const tampered = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 't1', existing_id: 'MEM001',
      evidence_ref: 'verified' }] }), context('v2-e', { evidence: { ...registry(records, outcomes), digest: 'f'.repeat(64) } }));
    assert.deepStrictEqual([tampered.status, tampered.reason_code], ['conflict', 'evidence-registry-refused']);
    const foreignSource = { sourceUnit: 'execute-task/T99', sourceFingerprint: 'sha256:source' };
    const foreign = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 'f1', existing_id: 'MEM001',
      evidence_ref: 'verified' }] }), context('v2-f', { evidence: extraction.normalizeEvidenceRegistry({
      records: [ownerRecord('verified', 'confirm', { source_unit: foreignSource.sourceUnit })], outcomes: [] }, foreignSource) }));
    assert.deepStrictEqual([foreign.status, foreign.reason_code], ['conflict', 'evidence-registry-refused'], 'divergent source');
    assert(fs.readFileSync(first.path).equals(afterDelivery), 'refusals write nothing');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('confirmation from the fact origin is refused by the shared reducer before any write', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001',
      facts: [originFact('MEM001', 'Same-origin fact.', { source_fingerprint: SOURCE.sourceFingerprint })], stats: [] });
    const before = snapshot(cwd);
    const outcome = publish(cwd, v2Result({ events: [{ kind: 'confirm', local_event_id: 'c1', existing_id: 'MEM001',
      evidence_ref: 'verified' }] }), v2Context('same-origin', [ownerRecord('verified', 'confirm')]));
    assert.deepStrictEqual([outcome.status, outcome.reason_code], ['conflict', 'evidence-reducer-refused']);
    assert.match(outcome.reason, /confirm-not-independent/);
    assert.deepStrictEqual(snapshot(cwd), before);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('new promotion needs three deduplicated independent confirmations; exposure, reobserve and ambiguous hits never promote', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts: [
      originFact('MEM001', 'Reusable architecture constraint.', { confidence_base: 0.8 }),
      originFact('MEM002', 'Low confidence architecture note.', { confidence_base: 0.5 }),
    ], stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0.9, hits: 5 }] });
    const promote = memId => v2Result({ events: [{ kind: 'promote', local_event_id: 'p1', existing_id: memId, threshold_met: true }] });
    const refused = publish(cwd, promote('MEM001'), context('promote-early'));
    assert.deepStrictEqual([refused.status, refused.reason_code], ['conflict', 'promotion-threshold-not-met'],
      'legacy seed hits are ambiguous and never satisfy the v2 rule');

    for (let index = 0; index < 50; index += 1) {
      const outcome = publish(cwd, v2Result({ events: [
        { kind: 'exposure', local_event_id: 'x', existing_id: 'MEM001', evidence_ref: `seen${index}` },
        { kind: 'reobserve', local_event_id: 'r', existing_id: 'MEM001', evidence_ref: `again${index}` },
      ] }), v2Context(`exposure-${index}`, [ownerRecord(`seen${index}`, 'exposure'), ownerRecord(`again${index}`, 'reobserve')]));
      assert.strictEqual(outcome.status, 'written', outcome.reason);
    }
    const ambiguous = publish(cwd, result({ events: [
      { kind: 'hit', existing_id: 'MEM001' }, { kind: 'confirm', existing_id: 'MEM001' },
      { kind: 'promote', existing_id: 'MEM001', threshold_met: true },
    ] }), v2Context('ambiguous'));
    assert.deepStrictEqual([ambiguous.status, ambiguous.reason_code], ['conflict', 'promotion-threshold-not-met'],
      'a v1 envelope under the v2 contract cannot bypass the rule');
    const exposed = publish(cwd, promote('MEM001'), context('promote-after-exposure'));
    assert.strictEqual(exposed.status, 'conflict', '100 exposures/reobservations never promote');
    let state = publish(cwd, v2Result({ events: [{ kind: 'exposure', local_event_id: 'x', existing_id: 'MEM001',
      evidence_ref: 'seen0' }] }), v2Context('exposure-0', [ownerRecord('seen0', 'exposure'), ownerRecord('again0', 'reobserve')])).state;
    const exposedEntry = state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual([exposedEntry.counters.exposure, exposedEntry.counters.reobserve, exposedEntry.hits,
      exposedEntry.independent_confirmation_count], [50, 50, 5, 0]);

    const confirmations = index => v2Context(`confirm-${index}`, [ownerRecord(`ver${index}`, 'confirm')]);
    const confirmBoth = index => v2Result({ events: [
      { kind: 'confirm', local_event_id: 'c1', existing_id: 'MEM001', evidence_ref: `ver${index}` },
      { kind: 'confirm', local_event_id: 'c2', existing_id: 'MEM002', evidence_ref: `ver${index}` },
    ] });
    for (const index of [0, 1]) assert.strictEqual(publish(cwd, confirmBoth(index), confirmations(index)).status, 'written');
    assert.strictEqual(publish(cwd, promote('MEM001'), context('promote-two')).status, 'conflict', 'two confirmations are not enough');
    const duplicate = publish(cwd, confirmBoth(0), v2Context('confirm-again', [ownerRecord('ver0', 'confirm')]));
    assert.strictEqual(duplicate.status, 'written', 'delivery retained; repeated observation adds no reinforcement');
    assert.strictEqual(duplicate.state.find(item => item.mem_id === 'MEM001').independent_confirmation_count, 2);
    assert.strictEqual(publish(cwd, confirmBoth(2), confirmations(2)).status, 'written');
    assert.strictEqual(publish(cwd, promote('MEM002'), context('promote-low')).reason_code, 'promotion-threshold-not-met',
      'three confirmations still need confidence >= 0.85');

    const usedRecords = [ownerRecord('used', 'utility')];
    const usedOutcomes = [{ outcome_ref: 'passed', outcome_id: 'outcome-T05', result_ref: 'result:T05:verify' }];
    const beforeUtility = publish(cwd, confirmBoth(2), confirmations(2)).state.find(item => item.mem_id === 'MEM001');
    const utility = publish(cwd, v2Result({ events: [{ kind: 'utility', local_event_id: 'u1', existing_id: 'MEM001',
      evidence_ref: 'used', outcome_ref: 'passed' }] }), v2Context('utility', usedRecords, usedOutcomes));
    const afterUtility = utility.state.find(item => item.mem_id === 'MEM001');
    assert.strictEqual(afterUtility.counters.utility, 1);
    assert.deepStrictEqual([afterUtility.hits, afterUtility.confidence], [beforeUtility.hits, beforeUtility.confidence],
      'utility records an outcome without touching ranking');

    const promoted = publish(cwd, promote('MEM001'), context('promote-ok'));
    assert.strictEqual(promoted.status, 'written', promoted.reason);
    state = promoted.state;
    const promotedEntry = state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual([promotedEntry.independent_confirmation_count, promotedEntry.v2_promoted, promotedEntry.promoted],
      [3, true, true]);
    assertProjectionMatches(cwd, state);
    assert.strictEqual(publish(cwd, promote('MEM001'), context('promote-ok')).status, 'noop', 'replayed promotion');
    assert.strictEqual(publish(cwd, promote('MEM001'), context('promote-again')).status, 'noop', 'historical promotion is kept');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('v1 envelopes keep seed/event/cap identities; the historical rule applies only outside the v2 contract', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001',
      facts: [canonicalFact('MEM001', 'Reusable architecture constraint.')],
      stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0.9, hits: 2 }] });
    const value = result({ facts: [candidate('legacy', 'Legacy envelope fact.')], events: [
      { kind: 'hit', existing_id: 'MEM001' }, { kind: 'promote', existing_id: 'MEM001', threshold_met: true }] });
    const before = snapshot(cwd);
    const contracted = publish(cwd, value, v2Context('legacy-contract'));
    assert.deepStrictEqual([contracted.status, contracted.promotion_policy], ['conflict', 'v2']);
    assert.deepStrictEqual(snapshot(cwd), before, 'no partial hit is written');
    const historical = publish(cwd, value, context('legacy-ok'));
    assert.deepStrictEqual([historical.status, historical.schema_version, historical.promotion_policy], ['written', 1, 'v1']);
    const stats = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).stats;
    assert.deepStrictEqual(stats.filter(stat => String(stat.event_id || '').startsWith('legacy-ok:')).map(stat => stat.event_id).sort(),
      ['legacy-ok:event:000', 'legacy-ok:event:001', 'legacy-ok:seed:legacy']);
    assert(!stats.some(stat => stat.evidence_version !== undefined), 'v1 never writes v2 rows');
    const entry = historical.state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual([entry.promoted, entry.v2_promoted, entry.independent_confirmation_count], [true, false, 0],
      'a historical promotion stays legacy history');
    assertProjectionMatches(cwd, historical.state);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('v2 cap prunes keep owner cap identities and refuse ineligible targets without writes', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001',
      facts: Array.from({ length: 50 }, (_, index) => canonicalFact(`MEM${String(index + 1).padStart(3, '0')}`, `Existing fact ${index}.`)),
      stats: [] });
    const overflow = prune => v2Result({ facts: [candidate('overflow', 'Overflow v2 fact.')], events: [
      { kind: 'seed', local_event_id: 's1', local_id: 'overflow' },
      { kind: 'prune', local_event_id: 'p1', existing_id: prune, reason: 'cap' }] });
    const before = snapshot(cwd);
    const refused = publish(cwd, overflow('MEM002'), context('v2-cap'));
    assert.strictEqual(refused.status, 'conflict');
    assert.deepStrictEqual(snapshot(cwd), before);
    const written = publish(cwd, overflow('MEM001'), context('v2-cap-ok'));
    assert.strictEqual(written.status, 'written', written.reason);
    const prunes = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).stats.filter(stat => stat.kind === 'prune');
    assert.deepStrictEqual(prunes.map(stat => stat.event_id), ['v2-cap-ok:cap:MEM001']);
    assert.strictEqual(publish(cwd, overflow('MEM001'), context('v2-cap-ok')).status, 'noop');
    assertProjectionMatches(cwd, written.state);
    assert.strictEqual(projection.projectMemoryEntries(cwd, { nowMs: NOW_MS }).length, 50);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('mixed v1 and v2 history publishes the same semantic state the projection rebuilds', () => {
  const cwd = tempDir();
  try {
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts: [originFact('MEM001', 'Mixed history fact.')],
      stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-09-20T00:00:00.000Z', confidence_base: 0.7, hits: 1 },
        { kind: 'decay', mem_id: 'MEM001', ts: '2026-09-21T00:00:00.000Z', new_confidence: 0.6 }] });
    assert.strictEqual(publish(cwd, result({ events: [{ kind: 'hit', existing_id: 'MEM001' }] }), context('mixed-v1')).status, 'written');
    const mixed = publish(cwd, v2Result({ events: [
      { kind: 'confirm', local_event_id: 'c1', existing_id: 'MEM001', evidence_ref: 'verified' },
      { kind: 'reobserve', local_event_id: 'r1', existing_id: 'MEM001', evidence_ref: 'again' },
    ] }), v2Context('mixed-v2', [ownerRecord('verified', 'confirm'), ownerRecord('again', 'reobserve')]));
    assert.strictEqual(mixed.status, 'written', mixed.reason);
    const entry = mixed.state.find(item => item.mem_id === 'MEM001');
    assert.deepStrictEqual([entry.hits, entry.independent_confirmation_count, entry.counters.reobserve], [3, 1, 1]);
    assertProjectionMatches(cwd, mixed.state);
    const stored = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
    const folded = extraction._private.foldPublication(stored.facts, stored.stats, { milestoneId: 'M001', unitId: 'T01' });
    assert.deepStrictEqual(extraction._private.semanticState(folded.folded), mixed.state);
    const legacy = folded.state.get('MEM001');
    assert.deepStrictEqual([legacy.hits, legacy.confidence], [3, 0.7], 'the cap/historical view keeps its own numbers');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('CLI validates stdin and publishes only a strict owner request file', () => {
  const cwd = tempDir();
  const script = path.join(__dirname, 'forge-memory-extraction.js');
  const requestPath = path.join(os.tmpdir(), `forge-memory-cli-${process.pid}-${Date.now()}.json`);
  try {
    const checked = spawnSync(process.execPath, [script, '--validate'], {
      input: JSON.stringify(result()), encoding: 'utf8',
    });
    assert.strictEqual(checked.status, 0, checked.stderr);
    assert.strictEqual(JSON.parse(checked.stdout).schema_version, 1);
    fs.writeFileSync(requestPath, JSON.stringify({
      cwd,
      extraction: result({ facts: [candidate('cli', 'CLI publication.')] }),
      sourceContext: context('cli-publication'),
    }));
    const published = spawnSync(process.execPath, [script, '--publish', '--request', requestPath], { encoding: 'utf8' });
    assert.strictEqual(published.status, 0, published.stderr);
    assert.strictEqual(JSON.parse(published.stdout).status, 'written');
  } finally {
    fs.rmSync(requestPath, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

async function run() {
  console.log('\nforge-memory-extraction tests\n');
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
