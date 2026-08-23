#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const memory = require('./forge-memory');
const projection = require('./forge-projection');

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
// Ranking is confidence × max(1, hits), but nothing ever emitted a hit event —
// measured: every fact in this repo's store carried hits: 0. --hit closes the
// loop: the orchestrator pipes --select's own envelope back in after injecting.

test('--hit records a hit stat for each injected fact and ranking sees it', () => withTemp((cwd) => {
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
  assert.strictEqual(report.recorded, 1, 'one hit recorded');
  assert.strictEqual(report.fragments[0].landed, true, 'stat landed on the owning fragment');
  const again = JSON.parse(spawnSync(process.execPath, [script, '--select', '--unit-type', 'execute-task',
    '--text', 'spawnSync glob argv win32', '--cwd', cwd], { encoding: 'utf8' }).stdout);
  assert.strictEqual(again.entries[0].hits, 1, 'projection folds the hit');
  assert.ok(again.entries[0].confidence > envelope.entries[0].confidence, 'hit nudges confidence up');
}));

test('--hit accepts a bare array, reports unusable rows in skipped, and stays exit 0', () => withTemp((cwd) => {
  memory.writeFragment(cwd, {
    unit_id: 'T-20260823120000-hits',
    facts: [fact('MEM001', 'gotcha', 'x', 'T-20260823120000-hits')],
    stats: [],
  });
  const script = path.join(__dirname, 'forge-memory.js');
  const r = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], {
    encoding: 'utf8',
    input: JSON.stringify([
      { unit_id: 'T-20260823120000-hits', mem_id: 'MEM001' },
      { mem_id: 'MEM-orphan' },
    ]),
  });
  const report = JSON.parse(r.stdout);
  assert.strictEqual(r.status, 0, 'advisory: per-row problems never fail the call');
  assert.strictEqual(report.recorded, 1);
  assert.strictEqual(report.skipped.length, 1, 'the unit-less row is named, not swallowed');
  assert.strictEqual(report.skipped[0].reason, 'missing-unit-or-mem-id');
}));

test('--hit refuses unusable stdin loudly (never a silent no-op)', () => withTemp((cwd) => {
  const script = path.join(__dirname, 'forge-memory.js');
  const garbage = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], { encoding: 'utf8', input: '{nope' });
  assert.strictEqual(garbage.status, 1, 'unparseable stdin is exit 1');
  const wrongShape = spawnSync(process.execPath, [script, '--hit', '--cwd', cwd], { encoding: 'utf8', input: '{"markdown":"x"}' });
  assert.strictEqual(wrongShape.status, 1, 'an envelope without entries[] is refused by name');
}));

runTests().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
