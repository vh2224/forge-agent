#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const memory = require('./forge-memory');
const projection = require('./forge-projection');
const evidence = require('./forge-memory-evidence');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`      ${error.stack || error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

function withTemp(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-test-'));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function fact(memId, category, text, sourceUnit) {
  return {
    mem_id: memId,
    category,
    text,
    created_at: '2026-07-20T00:00:00.000Z',
    source_unit: sourceUnit,
  };
}

function seed(memId, confidence, hits) {
  return {
    kind: 'seed',
    mem_id: memId,
    ts: '2026-07-20T00:00:00.000Z',
    confidence_base: confidence,
    hits,
  };
}

const NOW = Date.parse('2026-07-20T00:00:00.000Z');

console.log('\n=== forge-memory regression suite ===\n');

test('accepts canonical local S##/T## IDs without weakening traversal guards', () => {
  for (const id of ['S01', 'S2', 'T03', 't99', 'T03.1', 't3.12', 'M001', 'TASK-001']) {
    assert.strictEqual(memory.validateUnitId(id), true, `${id} should be valid`);
  }
  for (const id of ['../T03', 'S02/../../x', 'T', 'S', 'T03.', 'T03.1.2', 'S02.1', 'not-a-unit']) {
    assert.strictEqual(memory.validateUnitId(id), false, `${id} should be invalid`);
  }

  withTemp(cwd => {
    memory.writeFragment(cwd, {
      unit_id: 'T03.1',
      facts: [fact('MEM001', 'gotcha', 'local task memory', 'execute-task/T03.1')],
      stats: [seed('MEM001', 0.8, 0)],
    });
    assert.strictEqual(memory.readFragment(cwd, 'T03.1').facts[0].text, 'local task memory');
  });
});

test('keeps identical mem_id values isolated across fragments', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'first fragment fact', 'execute-task/T01')],
    stats: [seed('MEM001', 0.8, 1), {
      kind: 'hit', mem_id: 'MEM001', ts: '2026-07-20T00:00:01.000Z',
    }],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T02',
    facts: [fact('MEM001', 'pattern', 'second fragment fact', 'execute-task/T02')],
    stats: [seed('MEM001', 0.6, 4)],
  });

  const entries = projection.projectMemoryEntries(cwd, { nowMs: NOW });
  assert.strictEqual(entries.length, 2);
  const first = entries.find(entry => entry.identity === 'T01/MEM001');
  const second = entries.find(entry => entry.identity === 'T02/MEM001');
  assert(first && second, `identities: ${entries.map(entry => entry.identity).join(', ')}`);
  assert.strictEqual(first.hits, 2, 'T01 hit must stay scoped to T01');
  assert.strictEqual(second.hits, 4, 'T02 stats must stay scoped to T02');
  assert(Math.abs(first.confidence - 0.82) < 1e-9, `T01 confidence=${first.confidence}`);
  assert(Math.abs(second.confidence - 0.6) < 1e-9, `T02 confidence=${second.confidence}`);

  const rendered = projection.renderMemory(cwd);
  assert(rendered.includes('first fragment fact'));
  assert(rendered.includes('second fragment fact'));
  assert.strictEqual((rendered.match(/mem_id:MEM001/g) || []).length, 2);
}));

test('qualifies local fragment paths by milestone without breaking legacy reads', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    milestone_id: 'M001',
    facts: [fact('MEM001', 'gotcha', 'milestone one', 'execute-task/T01')],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    milestone_id: 'M002',
    facts: [fact('MEM001', 'pattern', 'milestone two', 'execute-task/T01')],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'environment', 'legacy unqualified', 'execute-task/T01')],
  });

  assert.strictEqual(path.basename(memory.fragmentPath(cwd, 'T01', { milestoneId: 'M001' })), 'M001__T01.md');
  assert.strictEqual(memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).facts[0].text, 'milestone one');
  assert.strictEqual(memory.readFragment(cwd, 'T01', { milestoneId: 'M002' }).facts[0].text, 'milestone two');
  assert.strictEqual(memory.readFragment(cwd, 'T01').facts[0].text, 'legacy unqualified');

  const listed = memory.listFragments(cwd);
  assert.deepStrictEqual(listed.map(item => item.storageKey), ['M001__T01', 'M002__T01', 'T01']);
  assert.deepStrictEqual(
    memory.listFragments(cwd, { milestoneId: 'M002' }).map(item => item.storageKey),
    ['M002__T01'],
  );

  const projected = projection.projectMemoryEntries(cwd, { nowMs: NOW });
  assert.deepStrictEqual(
    projected.map(entry => entry.identity).sort(),
    ['M001/T01/MEM001', 'M002/T01/MEM001', 'T01/MEM001'],
  );
  assert.throws(
    () => memory.fragmentPath(cwd, 'T01', { milestoneId: '../M001' }),
    /Invalid memory milestone ID/,
  );
}));

test('CLI milestone flag selects a qualified local fragment', () => withTemp(cwd => {
  const payload = JSON.stringify({
    unit_id: 'S01',
    facts: [fact('MEM001', 'architecture', 'qualified CLI write', 'plan-slice/S01')],
  });
  const written = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-memory.js'), '--write', '--milestone', 'M003', '--cwd', cwd,
  ], { input: payload, encoding: 'utf8' });
  assert.strictEqual(written.status, 0, written.stderr);
  assert(fs.existsSync(path.join(cwd, '.gsd', 'memory', 'M003__S01.md')));

  const read = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-memory.js'), '--read', 'S01', '--milestone', 'M003', '--cwd', cwd,
  ], { encoding: 'utf8' });
  assert.strictEqual(read.status, 0, read.stderr);
  assert.strictEqual(JSON.parse(read.stdout).milestone_id, 'M003');
}));

test('concurrent background writers preserve every merged fact and stat', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-concurrent-'));
  const childCount = 20;
  const script = path.join(__dirname, 'forge-memory.js');
  try {
    const writes = Array.from({ length: childCount }, (_, index) => new Promise((resolve, reject) => {
      const memId = `MEM${String(index + 1).padStart(3, '0')}`;
      const payload = JSON.stringify({
        unit_id: 'T01',
        milestone_id: 'M009',
        facts: [fact(memId, 'gotcha', `concurrent fact ${index + 1}`, 'execute-task/T01')],
        stats: [seed(memId, 0.8, 0)],
      });
      const child = spawn(process.execPath, [script, '--write', '--milestone', 'M009', '--cwd', cwd], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.resume();
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`writer ${index + 1} exited ${code}: ${stderr}`));
      });
      child.stdin.end(payload);
    }));
    await Promise.all(writes);

    const fragment = memory.readFragment(cwd, 'T01', { milestoneId: 'M009' });
    assert(fragment, 'qualified fragment must exist');
    assert.strictEqual(fragment.facts.length, childCount);
    assert.strictEqual(fragment.stats.length, childCount);
    assert.strictEqual(new Set(fragment.facts.map(item => item.mem_id)).size, childCount);
    const lockRoot = path.join(cwd, '.gsd', 'memory', '.locks');
    assert.deepStrictEqual(fs.readdirSync(lockRoot), [], 'all transaction locks must be released');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression guard: on Windows a mkdir that races the rmdir of a lock another
// writer is releasing reports EPERM (the directory is in pending-delete state),
// not EEXIST. The retry loop only tolerated EEXIST, so a contended writer died
// with exit 1 — reproduced on windows-latest under 20 concurrent writers. Both
// the platform and the errno are stubbed so the guard is deterministic on every
// runner instead of waiting for the race to happen again.
for (const code of ['EPERM', 'EACCES']) {
  test(`a Windows ${code} on the lock directory is contention, not a fatal write`, () => withTemp(cwd => {
    const realPlatform = process.platform;
    const realMkdir = fs.mkdirSync;
    let injected = 0;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    fs.mkdirSync = function stubbedMkdir(target, ...rest) {
      if (typeof target === 'string' && target.endsWith('.lock') && injected === 0) {
        injected += 1;
        const error = new Error(`${code}: operation not permitted, mkdir '${target}'`);
        error.code = code;
        throw error;
      }
      return realMkdir.call(fs, target, ...rest);
    };
    try {
      memory.writeFragment(cwd, {
        unit_id: 'T01',
        facts: [fact('MEM001', 'gotcha', 'written despite a contended lock', 'execute-task/T01')],
        stats: [seed('MEM001', 0.8, 0)],
      });
    } finally {
      fs.mkdirSync = realMkdir;
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
    assert.strictEqual(injected, 1, 'the stub must have fired once');
    assert.strictEqual(memory.readFragment(cwd, 'T01').facts[0].text, 'written despite a contended lock');
    assert.deepStrictEqual(fs.readdirSync(path.join(cwd, '.gsd', 'memory', '.locks')), [],
      'the retry must not leave a lock behind');
  }));
}

// A failed mkdir must never delete the directory another writer owns: that
// cleanup exists only for "mkdir succeeded, owner.json did not".
test('a non-contention mkdir failure surfaces and leaves a held lock intact', () => withTemp(cwd => {
  const realMkdir = fs.mkdirSync;
  let held = null;
  fs.mkdirSync = function stubbedMkdir(target, ...rest) {
    if (typeof target === 'string' && target.endsWith('.lock')) {
      held = target;
      realMkdir.call(fs, target, ...rest);
      const error = new Error(`EROFS: read-only file system, mkdir '${target}'`);
      error.code = 'EROFS';
      throw error;
    }
    return realMkdir.call(fs, target, ...rest);
  };
  let raised = null;
  try {
    memory.writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('MEM001', 'gotcha', 'never written', 'execute-task/T01')],
      stats: [seed('MEM001', 0.8, 0)],
    });
  } catch (error) {
    raised = error;
  } finally {
    fs.mkdirSync = realMkdir;
  }
  assert(raised && raised.code === 'EROFS', `EROFS must not be swallowed as contention: ${raised && raised.code}`);
  // The stub created the directory before throwing, standing in for a lock some
  // other writer holds. Our failed mkdir must have left it alone.
  const survived = Boolean(held) && fs.existsSync(held);
  if (held) { try { fs.rmSync(held, { recursive: true, force: true }); } catch (_) {} }
  assert(survived, 'a failed mkdir must not remove a lock directory it does not own');
}));

test('supports documented supersede old_id shape without pruning a sibling fragment', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'obsolete fact', 'execute-task/T01')],
    stats: [
      seed('MEM001', 0.8, 0),
      { kind: 'supersede', old_id: 'MEM001', new_id: 'MEM002', ts: '2026-07-20T00:00:01.000Z' },
    ],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T02',
    facts: [fact('MEM001', 'pattern', 'still active', 'execute-task/T02')],
    stats: [seed('MEM001', 0.7, 0)],
  });

  const entries = projection.projectMemoryEntries(cwd, { nowMs: NOW });
  assert.deepStrictEqual(entries.map(entry => entry.identity), ['T02/MEM001']);
}));

test('query selects relevant categories deterministically and excludes unrelated facts', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact(
      'MEM001',
      'gotcha',
      'Authentication token cache must invalidate after every account switch.',
      'execute-task/T01'
    )],
    stats: [seed('MEM001', 0.9, 2)],
  });
  memory.writeFragment(cwd, {
    unit_id: 'S01',
    facts: [fact(
      'MEM001',
      'architecture',
      'Authentication gateway performs token validation before routing.',
      'plan-slice/S01'
    )],
    stats: [seed('MEM001', 0.8, 1)],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T02',
    facts: [fact('MEM001', 'pattern', 'React components use CSS modules.', 'execute-task/T02')],
    stats: [seed('MEM001', 0.95, 10)],
  });

  const result = projection.queryMemoryEntries(cwd, {
    unitType: 'execute-task',
    query: 'authentication token cache',
    limit: 8,
    maxTokens: 2000,
    nowMs: NOW,
  });
  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(result.entries[0].identity, 'T01/MEM001');
  assert(!result.markdown.includes('React components'));
  assert.deepStrictEqual(result.entries[0].matched_terms, ['authentication', 'cache', 'token']);
}));

test('query enforces the chars/4 budget before returning injectable markdown', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact(
      'MEM001',
      'gotcha',
      'authentication token '.repeat(30),
      'execute-task/T01'
    )],
    stats: [seed('MEM001', 0.9, 0)],
  });

  const result = projection.queryMemoryEntries(cwd, {
    unitType: 'execute-task',
    query: 'authentication token',
    maxTokens: 16,
    nowMs: NOW,
  });
  assert(result.entries.length === 1);
  assert(result.truncated, 'long fact should report truncation');
  assert(result.markdown.length <= 16 * 4, `markdown chars=${result.markdown.length}`);
  assert(result.estimated_tokens <= 16, `tokens=${result.estimated_tokens}`);
}));

test('single-term execution queries can select one relevant memory', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'Authentication requires an explicit cache reset.', 'execute-task/T01')],
    stats: [seed('MEM001', 0.9, 0)],
  });
  const result = projection.queryMemoryEntries(cwd, {
    unitType: 'execute-task',
    query: 'authentication',
    nowMs: NOW,
  });
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].identity, 'T01/MEM001');

  const loose = projection.queryMemoryEntries(cwd, {
    unitType: 'execute-loose-task',
    query: 'unrelated words',
    nowMs: NOW,
  });
  assert.strictEqual(loose.entries.length, 0, 'loose tasks must use execution relevance filtering');
}));

test('selector rejects malformed numeric limits and caps excessive budgets', () => withTemp(cwd => {
  assert.throws(
    () => projection.queryMemoryEntries(cwd, { limit: '8junk' }),
    /limit must be a positive integer/,
  );
  const result = projection.queryMemoryEntries(cwd, { limit: '500', maxTokens: '999999' });
  assert.strictEqual(result.entries.length, 0);
  assert.strictEqual(result.estimated_tokens, 2);
}));

test('fragment enumeration ignores invalid names and non-regular entries', () => withTemp(cwd => {
  const dir = path.join(cwd, '.gsd', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'not-a-unit.md'), 'untrusted', 'utf8');
  fs.writeFileSync(path.join(dir, 'not-a-milestone__T01.md'), 'untrusted', 'utf8');
  fs.mkdirSync(path.join(dir, 'T99.md'));
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'valid', 'execute-task/T01')],
  });
  assert.deepStrictEqual(memory.listFragments(cwd).map(item => item.unitId), ['T01']);
}));

test('--query-file CLI returns the same bounded structured selector result', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'token cache invalidation rule', 'execute-task/T01')],
    stats: [seed('MEM001', 0.9, 0)],
  });
  const queryPath = path.join(cwd, 'plan.md');
  fs.writeFileSync(queryPath, 'Implement token cache invalidation safely.', 'utf8');
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-memory.js'),
    '--query',
    '--unit-type', 'execute-task',
    '--query-file', queryPath,
    '--limit', '8',
    '--max-tokens', '100',
    '--format', 'json',
    '--cwd', cwd,
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.strictEqual(result.entries[0].identity, 'T01/MEM001');
  assert(result.estimated_tokens <= 100);
}));

test('--query-file cannot escape cwd and unknown query flags fail closed', () => withTemp(cwd => {
  const outside = path.join(os.tmpdir(), `forge-memory-outside-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(outside, 'secret outside query', 'utf8');
  try {
    const escaped = spawnSync(process.execPath, [
      path.join(__dirname, 'forge-memory.js'), '--query', '--query-file', outside, '--cwd', cwd,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(escaped.status, 0);
    assert.match(escaped.stderr, /must stay inside cwd/);

    const unknown = spawnSync(process.execPath, [
      path.join(__dirname, 'forge-memory.js'), '--query', '--bogus', 'value', '--cwd', cwd,
    ], { encoding: 'utf8' });
    assert.notStrictEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown query option/);
  } finally {
    fs.rmSync(outside, { force: true });
  }
}));

// ── --hit: usage feedback loop ───────────────────────────────────────────────
//
// --hit remains an input/output compatibility alias for exposure v2.

test('--hit accepts the selection envelope and records invocation-only exposure without fabricating observation or reinforcement', () => withTemp((cwd) => {
  memory.writeFragment(cwd, {
    unit_id: 'T-20260823120000-hits',
    facts: [fact('MEM001', 'gotcha', 'spawnSync shell false rejects glob argv on win32', 'T-20260823120000-hits')],
    stats: [],
  });
  const script = path.join(__dirname, 'forge-memory.js');
  const select = spawnSync(process.execPath, [script, '--select', '--unit-type', 'execute-task',
    '--text', 'spawnSync glob argv win32', '--cwd', cwd], { encoding: 'utf8' });
  const envelope = JSON.parse(select.stdout);
  assert.strictEqual(envelope.entries[0].hits, 0, 'starts unused');
  const hit = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd],
    { encoding: 'utf8', input: select.stdout });
  const report = JSON.parse(hit.stdout);
  assert.strictEqual(hit.status, 0);
  assert.strictEqual(report.recorded, 1);
  assert.deepStrictEqual(report.skipped, []);
  const again = JSON.parse(spawnSync(process.execPath, [script, '--select', '--unit-type', 'execute-task',
    '--text', 'spawnSync glob argv win32', '--cwd', cwd], { encoding: 'utf8' }).stdout);
  assert.strictEqual(again.entries[0].hits, 0, 'exposure is not confirmation');
  assert.strictEqual(again.entries[0].confidence, envelope.entries[0].confidence, 'exposure never reinforces confidence');
  const rows = memory.readFragment(cwd, 'T-20260823120000-hits').stats;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].provenance, 'legacy-invocation-only');
  assert.strictEqual(rows[0].invocation_id, report.invocation_id);
  for (const key of ['observation_id', 'independent_ref', 'outcome_id', 'delivery_id']) assert(!(key in rows[0]), key);
}));

test('--hit accepts a bare array, reports unusable rows in skipped, and stays exit 0', () => withTemp((cwd) => {
  memory.writeFragment(cwd, {
    unit_id: 'T-20260823120000-hits',
    facts: [fact('MEM001', 'gotcha', 'x', 'T-20260823120000-hits'),
      fact('MEM002', 'gotcha', 'y', 'T-20260823120000-hits')],
    stats: [],
  });
  const script = path.join(__dirname, 'forge-memory.js');
  const r = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], {
    encoding: 'utf8',
    input: JSON.stringify([
      { unit_id: 'T-20260823120000-hits', mem_id: 'MEM001' },
      { unit_id: 'T-20260823120000-hits', mem_id: 'MEM002' },
      { unit_id: 'T-20260823120000-hits', mem_id: 'MEM001' },
      { mem_id: 'MEM-orphan' },
    ]),
  });
  const report = JSON.parse(r.stdout);
  assert.strictEqual(r.status, 0, 'advisory: per-row problems never fail the call');
  assert.strictEqual(report.recorded, 2);
  assert.strictEqual(report.skipped.length, 1, 'only the unit-less row is skipped');
  assert.strictEqual(report.skipped[0].reason, 'missing-unit-or-mem-id');
  const rows = memory.readFragment(cwd, 'T-20260823120000-hits').stats;
  assert.strictEqual(rows.length, 2);
  assert(rows.every(row => row.invocation_id === report.invocation_id), 'one local invocation ID shared by every entry');
}));

test('--hit refuses unusable stdin loudly (never a silent no-op)', () => withTemp((cwd) => {
  const script = path.join(__dirname, 'forge-memory.js');
  const garbage = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], { encoding: 'utf8', input: '{nope' });
  assert.strictEqual(garbage.status, 1, 'unparseable stdin is exit 1');
  const wrongShape = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], { encoding: 'utf8', input: '{"markdown":"x"}' });
  assert.strictEqual(wrongShape.status, 1, 'an envelope without entries[] is refused by name');
}));

test('same mem_id with different immutable content is a named conflict, never silent loss', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'original immutable fact', 'execute-task/T01')],
    stats: [],
  });
  const before = fs.readFileSync(memory.fragmentPath(cwd, 'T01'));
  assert.throws(
    () => memory.writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('MEM001', 'gotcha', 'different fact under stale ID', 'execute-task/T01')],
      stats: [],
    }),
    error => error && error.code === 'MEMORY_FACT_CONFLICT',
  );
  assert(fs.readFileSync(memory.fragmentPath(cwd, 'T01')).equals(before));
}));

test('same-time supersedes use old/new references in event identity', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [
      fact('MEM001', 'gotcha', 'old one', 'execute-task/T01'),
      fact('MEM002', 'gotcha', 'old two', 'execute-task/T01'),
      fact('MEM003', 'pattern', 'new one', 'execute-task/T01'),
      fact('MEM004', 'pattern', 'new two', 'execute-task/T01'),
    ],
    stats: [
      { kind: 'supersede', old_id: 'MEM001', new_id: 'MEM003', ts: '2026-09-24T22:30:00.000Z' },
      { kind: 'supersede', old_id: 'MEM002', new_id: 'MEM004', ts: '2026-09-24T22:30:00.000Z' },
    ],
  });
  const fragment = memory.readFragment(cwd, 'T01');
  assert.strictEqual(fragment.stats.length, 2);
  assert.notStrictEqual(
    memory._private.statHash(fragment.stats[0]),
    memory._private.statHash(fragment.stats[1]),
  );
}));

test('legacy event tuple ignores additive metadata while event_id owns new replay identity', () => withTemp(cwd => {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'event identity', 'execute-task/T01')],
    stats: [{ kind: 'hit', mem_id: 'MEM001', ts: '2026-09-24T22:30:00.000Z', source: 'first' }],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [fact('MEM001', 'gotcha', 'event identity', 'execute-task/T01')],
    stats: [
      { kind: 'hit', mem_id: 'MEM001', ts: '2026-09-24T22:30:00.000Z', source: 'later-metadata' },
      { kind: 'hit', mem_id: 'MEM001', ts: '2026-09-24T22:30:00.000Z', event_id: 'extract:event:1' },
      { kind: 'hit', mem_id: 'MEM001', ts: '2026-09-24T22:30:00.000Z', event_id: 'extract:event:1' },
    ],
  });
  const stats = memory.readFragment(cwd, 'T01').stats;
  assert.strictEqual(stats.length, 2, 'one legacy tuple and one explicit event identity survive');
  assert.strictEqual(stats.filter(stat => stat.event_id === 'extract:event:1').length, 1);
  assert.throws(
    () => memory.writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('MEM001', 'gotcha', 'event identity', 'execute-task/T01')],
      stats: [{
        kind: 'hit', mem_id: 'MEM001', ts: '2026-09-24T22:30:00.000Z',
        event_id: 'extract:event:1', source: 'conflicting-content',
      }],
    }),
    error => error && error.code === 'MEMORY_EVENT_CONFLICT',
  );
}));

// ── Evidence v2 rows in the store (S03/T02) ────────────────────────────────
// Rows follow shared/forge-memory-evidence.md; the store validates incoming v2
// rows through forge-memory-evidence and never rewrites stored history.

function originFact(memId) {
  return {
    ...fact(memId, 'gotcha', `Fact ${memId}.`, 'execute-task/T01'),
    confidence_base: 0.8, extraction_id: 'extract-1', source_fingerprint: 'sha256:origin',
  };
}

function v2Row(kind, localEventId, overrides) {
  const extractionId = (overrides && overrides.extraction_id) || 'extract-2';
  const base = { kind, evidence_version: 2, event_id: `${extractionId}:v2:${localEventId}`, extraction_id: extractionId,
    local_event_id: localEventId, ts: '2026-10-02T00:00:00.000Z', mem_id: 'MEM001' };
  const bound = { evidence_ref: 'ev', observation_id: `obs-${localEventId}`, source_unit: 'execute-task/T02',
    source_fingerprint: 'sha256:other', observed_kind: kind };
  const extra = kind === 'confirm' ? { independent_ref: 'verify:T02:check-7' }
    : kind === 'utility' ? { outcome_ref: 'out1', outcome_id: 'outcome-T02-pass', outcome_result_ref: 'result:T02:summary' } : {};
  return { ...base, ...(evidence.EVIDENCE_KINDS.includes(kind) ? { ...bound, ...extra } : {}), ...(overrides || {}) };
}

function writeRawFragment(cwd, unitId, fragment, eol) {
  const nl = eol || '\n';
  const dir = path.join(cwd, '.gsd', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${unitId}.md`);
  fs.writeFileSync(file, `---${nl}${memory.serializeFrontmatter({ unit_id: unitId, ...fragment }, nl)}${nl}---${nl}`);
  return file;
}

function lockNames(cwd) {
  const lockRoot = path.join(cwd, '.gsd', 'memory', '.locks');
  return fs.existsSync(lockRoot) ? fs.readdirSync(lockRoot) : [];
}

test('v2 evidence rows round-trip as closed scalars, keep origin and version, and replay without rewrite', () => withTemp(cwd => {
  const yamlish = '!!js/function >- {exec: "rm -rf /"} #not-a-comment';
  const rows = [
    v2Row('confirm', 'c1', { source_unit: yamlish }),
    v2Row('exposure', 'x1'),
    v2Row('utility', 'u1'),
    v2Row('seed', 's1', { mem_id: 'MEM002', confidence_base: 0.75, hits: 0 }),
    v2Row('promote', 'p1', { threshold_met: true }),
  ];
  memory.writeFragment(cwd, {
    unit_id: 'T01', milestone_id: 'M001', facts: [originFact('MEM001'), originFact('MEM002')], stats: rows,
  });
  const file = memory.fragmentPath(cwd, 'T01', { milestoneId: 'M001' });
  const text = fs.readFileSync(file, 'utf8');
  assert(!text.includes(`source_unit: ${yamlish}`), 'a YAML-significant owner scalar must not be emitted as a plain scalar');

  const stored = memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).stats;
  assert.strictEqual(stored.length, rows.length);
  for (const original of rows) {
    const back = stored.find(stat => stat.event_id === original.event_id);
    assert(back, `${original.event_id} must survive the round-trip`);
    assert.deepStrictEqual(Object.keys(back).sort(), Object.keys(original).sort(), 'no field is added or lost');
    for (const key of Object.keys(original)) {
      assert.strictEqual(back[key], String(original[key]), `${original.event_id}.${key} stays a literal scalar`);
    }
    const reread = evidence.normalizeEvidenceEvent(back);
    assert.strictEqual(reread.origin, 'v2', `${original.event_id} still reads as evidence v2`);
    assert.strictEqual(reread.payload, evidence.normalizeEvidenceEvent(original).payload);
  }
  const confirm = stored.find(stat => stat.kind === 'confirm');
  assert.deepStrictEqual(
    [confirm.evidence_version, confirm.extraction_id, confirm.local_event_id, confirm.source_unit, confirm.source_fingerprint],
    ['2', 'extract-2', 'c1', yamlish, 'sha256:other'],
    'version and origin are retained',
  );

  const replay = memory.writeFragment(cwd, {
    unit_id: 'T01', milestone_id: 'M001', facts: [originFact('MEM001')], stats: stored,
  });
  assert.strictEqual(replay.created, false, 'replaying the parsed rows is a no-op');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'history bytes are not rewritten');
}));

test('invalid, unknown-version, hybrid and non-scalar evidence rows are refused before any byte persists', () => withTemp(cwd => {
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [originFact('MEM001')], stats: [v2Row('exposure', 'x0')] });
  const file = memory.fragmentPath(cwd, 'T01');
  const before = fs.readFileSync(file);
  const cases = [
    [v2Row('confirm', 'c1', { evidence_version: 3 }), 'unknown-evidence-version'],
    [v2Row('mystery', 'm1'), 'unknown-kind'],
    [{ kind: 'exposure', mem_id: 'MEM001', ts: '2026-10-02T00:00:00.000Z' }, 'hybrid-shape'],
    [v2Row('hit', 'h1'), 'hybrid-shape'],
    [v2Row('exposure', 'x2', { path: '/etc/passwd' }), 'unexpected-property'],
    [v2Row('exposure', 'x3', { observation_id: '$(rm -rf /)' }), 'invalid-identifier'],
    [v2Row('exposure', 'x4', { event_id: 'extract-2:v2:other' }), 'identity-mismatch'],
    [v2Row('exposure', 'x5', { source_unit: ['execute-task/T02'] }), 'non-scalar-field'],
    [v2Row('exposure', 'x6', { ts: ['2026-10-02T00:00:00.000Z'] }), 'non-scalar-field'],
    [v2Row('seed', 's1', { confidence_base: { valueOf: () => 0.5 }, hits: 0 }), 'non-scalar-field'],
  ];
  for (const [row, reason] of cases) {
    assert.throws(
      () => memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [v2Row('reobserve', 'ok1'), row] }),
      error => error && error.code === 'MEMORY_EVENT_INVALID' && error.reason === reason,
      `expected MEMORY_EVENT_INVALID/${reason}`,
    );
    assert(fs.readFileSync(file).equals(before), `${reason}: the valid sibling row must not persist partially`);
  }
  assert.throws(
    () => memory.transactFragment(cwd, { unit_id: 'T01' }, {}, current => ({
      ...current, stats: [...current.stats, cases[0][0]],
    })),
    error => error && error.code === 'MEMORY_EVENT_INVALID',
  );
  assert(fs.readFileSync(file).equals(before), 'a refused transaction leaves the fragment untouched');
  assert.deepStrictEqual(lockNames(cwd), [], 'every refusal releases the fragment lock');
}));

test('v2 replay is a no-op; a conflicting event_id or observation is MEMORY_EVENT_CONFLICT before writing', () => withTemp(cwd => {
  const confirm = v2Row('confirm', 'c1');
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [originFact('MEM001')], stats: [confirm] });
  const file = memory.fragmentPath(cwd, 'T01');
  const before = fs.readFileSync(file);

  const replay = memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [{ ...confirm, evidence_version: '2' }] });
  assert.strictEqual(replay.created, false, 'the stringified delivery is the same event');
  const repackaged = v2Row('confirm', 'c9', { extraction_id: 'extract-3', event_id: 'extract-3:v2:c9',
    observation_id: 'obs-c1', evidence_ref: 'other', ts: '2026-10-03T00:00:00.000Z' });
  const sameObservation = memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [repackaged] });
  assert.strictEqual(sameObservation.created, true, 'a distinct delivery identity is retained without reinforcement');
  assert.strictEqual(memory.readFragment(cwd, 'T01').stats.length, 2);
  const afterDelivery = fs.readFileSync(file);

  const conflicts = [
    [{ ...confirm, independent_ref: 'verify:other' }, evidence.REASONS.EVENT_ID_CONFLICT],
    [{ ...repackaged, event_id: 'extract-3:v2:c10', local_event_id: 'c10', source_fingerprint: 'sha256:elsewhere' }, evidence.REASONS.OBSERVATION_CONFLICT],
    [v2Row('reobserve', 'r9', { observation_id: 'obs-c1' }), evidence.REASONS.OBSERVATION_CONFLICT],
  ];
  for (const [row, reason] of conflicts) {
    assert.throws(
      () => memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [row] }),
      error => error && error.code === 'MEMORY_EVENT_CONFLICT' && error.reason === reason,
      `expected MEMORY_EVENT_CONFLICT/${reason}`,
    );
  }
  assert(!afterDelivery.equals(before), 'new delivery is persisted');
  assert(fs.readFileSync(file).equals(afterDelivery), 'conflicts never persist');
  assert.deepStrictEqual(lockNames(cwd), []);
}));

test('legacy subsequence keeps stored order and multiplicity while v2 rows merge canonically', () => {
  const legacyRows = [
    { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T03:00:00.000Z' },
    { kind: 'decay', mem_id: 'MEM001', ts: '2026-10-01T01:00:00.000Z', new_confidence: '0.5' },
    { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T03:00:00.000Z' },
  ];
  const incoming = [
    v2Row('exposure', 'x2', { ts: '2026-10-01T03:00:00.000Z' }),
    v2Row('reobserve', 'r1', { ts: '2026-10-01T00:30:00.000Z' }),
    v2Row('exposure', 'x1', { ts: '2026-10-01T03:00:00.000Z' }),
  ];
  const label = stat => stat.event_id ? stat.local_event_id : `${stat.kind}@${stat.ts.slice(11, 13)}`;
  const outputs = [incoming, [incoming[2], incoming[0], incoming[1]]].map(order => withTemp(cwd => {
    const file = writeRawFragment(cwd, 'T01', { facts: [originFact('MEM001')], stats: legacyRows });
    memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: order });
    const stats = memory.readFragment(cwd, 'T01').stats;
    assert.deepStrictEqual(stats.filter(stat => !stat.evidence_version), legacyRows,
      'stored legacy rows keep their order and their duplicate');
    assert.deepStrictEqual(stats.map(label), ['r1', 'hit@03', 'decay@01', 'hit@03', 'x1', 'x2'],
      'v2 rows sit before the first legacy row that sorts after them, ties going to the legacy row');
    const bytes = fs.readFileSync(file, 'utf8');

    // A legacy write keeps the historical comparator for the legacy subsequence.
    memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [{ kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T02:00:00.000Z' }] });
    const afterLegacy = memory.readFragment(cwd, 'T01').stats;
    assert.deepStrictEqual(afterLegacy.filter(stat => !stat.evidence_version).map(label),
      ['decay@01', 'hit@02', 'hit@03', 'hit@03']);
    assert.deepStrictEqual(afterLegacy.filter(stat => stat.evidence_version).map(label), ['r1', 'x1', 'x2']);
    return bytes;
  }));
  assert.strictEqual(outputs[0], outputs[1], 'the same v2 set yields the same bytes whatever the delivery order');
});

test('a CRLF fragment stays CRLF after a v2 merge', () => withTemp(cwd => {
  const file = writeRawFragment(cwd, 'T01', {
    facts: [originFact('MEM001')], stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z', confidence_base: '0.8', hits: '1' }],
  }, '\r\n');
  const writerSeesCrlf = /\r\n/.test(fs.readFileSync(file, 'utf8'));
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [v2Row('exposure', 'x1')] });
  const text = fs.readFileSync(file, 'utf8');
  if (writerSeesCrlf) {
    assert(text.includes('\r\n'), 'CRLF must be re-emitted');
    assert(!/[^\r]\n/.test(text), 'no bare LF may be spliced in by the merge');
  }
  assert.strictEqual(memory.readFragment(cwd, 'T01').stats.length, 2);
}));

test('a stored v2 row the reducer refuses is preserved verbatim by later merges', () => withTemp(cwd => {
  const unknownVersion = v2Row('exposure', 'x1', { evidence_version: '9' });
  writeRawFragment(cwd, 'T01', { facts: [originFact('MEM001')], stats: [unknownVersion] });
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [], stats: [{ kind: 'hit', mem_id: 'MEM001', ts: '2026-10-03T00:00:00.000Z' }] });
  const stats = memory.readFragment(cwd, 'T01').stats;
  assert.strictEqual(stats.length, 2);
  assert.deepStrictEqual(stats.find(stat => stat.event_id === unknownVersion.event_id), unknownVersion,
    'history is neither dropped nor rewritten');
  const state = projection.projectMemoryState(cwd, { nowMs: NOW });
  assert.deepStrictEqual(state.diagnostics.rejected.map(item => item.reason), [evidence.REASONS.UNKNOWN_EVIDENCE_VERSION],
    'the reducer reports it instead of discarding it silently');
}));

test('the same v2 delivery stays separate per fragment namespace', () => withTemp(cwd => {
  const confirm = v2Row('confirm', 'c1');
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [originFact('MEM001')], stats: [confirm] });
  memory.writeFragment(cwd, { unit_id: 'T02', facts: [originFact('MEM001')], stats: [confirm] });
  memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts: [originFact('MEM001')], stats: [confirm] });
  for (const [unit, milestoneId] of [['T01', null], ['T02', null], ['T01', 'M001']]) {
    assert.strictEqual(memory.readFragment(cwd, unit, { milestoneId }).stats.length, 1, `${milestoneId || ''}/${unit}`);
  }
  const entries = projection.projectMemoryEntries(cwd, { nowMs: NOW });
  assert.deepStrictEqual(
    entries.map(entry => [entry.identity, entry.hits, entry.evidence.v2.independent_confirmation_count]).sort(),
    [['M001/T01/MEM001', 1, 1], ['T01/MEM001', 1, 1], ['T02/MEM001', 1, 1]],
  );
}));

test('--expose uses stable owner delivery identity: replay zero, distinct delivery one, bounded input and advisory conflict', () => withTemp(cwd => {
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [originFact('MEM001')], stats: [] });
  const script = path.join(__dirname, 'forge-memory.js');
  const entries = [{ unit_id: 'T01', mem_id: 'MEM001' }];
  const invoke = (id, input = entries, cmd = '--expose') => spawnSync(process.execPath,
    [script, cmd, ...(id === null ? [] : ['--event-id', id]), '--cwd', cwd],
    { encoding: 'utf8', input: JSON.stringify(input) });
  const first = JSON.parse(invoke('dispatch-1', { entries: [...entries, ...entries] }).stdout);
  assert.strictEqual(first.recorded, 1);
  assert.strictEqual(first.fragments[0].hits, first.fragments[0].exposures);
  const file = memory.fragmentPath(cwd, 'T01');
  const before = fs.readFileSync(file);
  assert.strictEqual(JSON.parse(invoke('dispatch-1').stdout).recorded, 0);
  assert(fs.readFileSync(file).equals(before), 'replay preserves exact bytes');
  assert.strictEqual(JSON.parse(invoke('dispatch-2').stdout).recorded, 1);
  const state = projection.projectMemoryEntries(cwd, { nowMs: NOW })[0];
  assert.strictEqual(state.hits, 0);
  assert.strictEqual(state.evidence.v2.independent_confirmation_count, 0);
  const unchanged = fs.readFileSync(file);
  for (const id of [null, '', 'x'.repeat(129), '../escape', '$(whoami)']) {
    assert.notStrictEqual(invoke(id).status, 0);
    assert(fs.readFileSync(file).equals(unchanged));
  }
  const legacy = JSON.parse(invoke(null, [...entries, ...entries], '--hit').stdout);
  assert.strictEqual(legacy.recorded, 1, 'duplicate entries in one invocation count once');
  assert.deepStrictEqual(legacy.skipped, []);
  assert.strictEqual(legacy.provenance, 'legacy-invocation-only');
  assert.strictEqual(legacy.delivery_id, null);
  assert(legacy.invocation_id);
  const nextLegacy = JSON.parse(invoke(null, entries, '--hit').stdout);
  assert.strictEqual(nextLegacy.recorded, 1, 'separate unidentified calls are separate invocations');
  assert.notStrictEqual(nextLegacy.invocation_id, legacy.invocation_id);
  const rows = memory.readFragment(cwd, 'T01').stats;
  assert.strictEqual(rows.length, 4, 'two deliveries and two local invocations');
  assert(rows.every(row => row.kind === 'exposure' && row.evidence_version === '2'));
  const invocationRows = rows.filter(row => row.provenance === 'legacy-invocation-only');
  assert.strictEqual(invocationRows.length, 2);
  for (const row of invocationRows) {
    for (const key of ['observation_id', 'independent_ref', 'outcome_id', 'delivery_id']) assert(!(key in row), key);
  }
  const afterLegacy = projection.projectMemoryEntries(cwd, { nowMs: NOW })[0];
  assert.strictEqual(afterLegacy.evidence.counters.exposure.count, 4);
  assert.strictEqual(afterLegacy.hits, 0);
  assert.strictEqual(afterLegacy.evidence.v2.independent_confirmation_count, 0);
  // Tamper a stored binding to demonstrate named identity conflict before write.
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('source_unit: confirmed-delivery', 'source_unit: other'));
  const tampered = fs.readFileSync(file);
  const conflict = JSON.parse(invoke('dispatch-1').stdout);
  assert.strictEqual(conflict.recorded, 0);
  assert.match(conflict.skipped[0].reason, /conflict/i);
  assert(fs.readFileSync(file).equals(tampered));
}));

runTests().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
