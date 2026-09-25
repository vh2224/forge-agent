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
    assert.strictEqual(record.container, container);
    assert.ok(record.remedy);
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
