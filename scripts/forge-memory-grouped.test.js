'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeGroup } = require('./forge-grouped-file');
const memory = require('./forge-memory');

let passed = 0;
let failed = 0;
const failures = [];
const MILESTONE = 'M-20260804003633-grouped-memory';

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
  }
}

function fact(memId, text) {
  return { mem_id: memId, category: 'test', text, source: 'grouped-test' };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-grouped-'));
  fs.mkdirSync(memory.memoryDir(cwd), { recursive: true });
  memory.writeFragment(cwd, { unit_id: 'S01', facts: [fact('MEM001', 'loose milestone fact')], stats: [] }, { milestoneId: MILESTONE });
  memory.writeFragment(cwd, { unit_id: 'T01', facts: [fact('MEM002', 'second milestone fact')], stats: [] }, { milestoneId: MILESTONE });
  memory.writeFragment(cwd, { unit_id: 'M001', facts: [fact('MEM003', 'global fact')], stats: [] });
  return { cwd };
}

function storageKey(unitId, opts) {
  return memory.qualifiedStorageKey(unitId, opts && opts.milestoneId);
}

function groupEntries(cwd, unitSpecs, epoch) {
  const units = unitSpecs.map(({ unitId, opts }) => ({
    id: storageKey(unitId, opts),
    content: fs.readFileSync(memory.fragmentPath(cwd, unitId, opts)),
  }));
  const container = path.join(memory.memoryDir(cwd), `${epoch}.md`);
  fs.writeFileSync(container, serializeGroup({ epoch, units }).buffer);
  for (const { unitId, opts } of unitSpecs) {
    fs.unlinkSync(memory.fragmentPath(cwd, unitId, opts));
  }
  return container;
}

// listFragments deliberately returns the *resolved* path (assertMemoryDirectory
// realpaths the memory dir so a symlinked .gsd/memory cannot redirect writes out
// of the workspace). Test helpers build raw paths from memoryDir(). Comparing the
// two sides only agrees where os.tmpdir() has no symlink component, so resolve
// BOTH sides instead of downgrading the hardened one to its raw form.
function samePath(a, b) {
  return fs.realpathSync(a) === fs.realpathSync(b);
}

function captureStderr(fn) {
  let output = '';
  const original = process.stderr.write;
  process.stderr.write = value => {
    output += String(value);
    return true;
  };
  try {
    return { result: fn(), output };
  } finally {
    process.stderr.write = original;
  }
}

test('grouped store preserves the unfiltered loose fragment count', () => {
  const { cwd } = fixture();
  const before = memory.listFragments(cwd);
  const container = groupEntries(cwd, [
    { unitId: 'S01', opts: { milestoneId: MILESTONE } },
    { unitId: 'T01', opts: { milestoneId: MILESTONE } },
  ], '2026-Q1');
  const after = memory.listFragments(cwd);
  assert.strictEqual(after.length, before.length);
  assert.strictEqual(after.filter(entry => entry.grouped).length, 2);
  assert.ok(after.filter(entry => entry.grouped).every(entry => samePath(entry.path, container)));
  assert.ok(after.every(entry => typeof entry.storageKey === 'string'));
});

test('milestone filtering happens after group expansion', () => {
  const { cwd } = fixture();
  const before = memory.listFragments(cwd, { milestoneId: MILESTONE });
  groupEntries(cwd, [
    { unitId: 'S01', opts: { milestoneId: MILESTONE } },
    { unitId: 'T01', opts: { milestoneId: MILESTONE } },
  ], '2026-Q1');
  const after = memory.listFragments(cwd, { milestoneId: MILESTONE });
  assert.strictEqual(before.length, 2);
  assert.strictEqual(after.length, before.length);
  assert.ok(after.every(entry => entry.milestoneId === MILESTONE));
  assert.deepStrictEqual(after.map(entry => entry.unitId), ['S01', 'T01']);
});

test('readFragment and readFragmentText return exactly one grouped member', () => {
  const { cwd } = fixture();
  groupEntries(cwd, [{ unitId: 'S01', opts: { milestoneId: MILESTONE } }], '2026-Q2');
  const entry = memory.listFragments(cwd, { milestoneId: MILESTONE })
    .find(item => item.unitId === 'S01');
  assert.strictEqual(entry.grouped, true);
  const text = memory.readFragmentText(cwd, entry);
  assert.ok(text.includes('loose milestone fact'));
  assert.ok(!text.includes('grouped_format: forge-group@1'));
  assert.deepStrictEqual(
    memory.readFragment(cwd, 'S01', { milestoneId: MILESTONE }),
    memory.parseFragment(text)
  );
});

test('a loose fragment wins over a grouped member with the same storage key', () => {
  const { cwd } = fixture();
  const loosePath = memory.fragmentPath(cwd, 'S01', { milestoneId: MILESTONE });
  const looseText = fs.readFileSync(loosePath);
  const container = path.join(memory.memoryDir(cwd), '2026-Q3.md');
  fs.writeFileSync(container, serializeGroup({
    epoch: '2026-Q3',
    units: [{ id: storageKey('S01', { milestoneId: MILESTONE }), content: looseText }],
  }).buffer);
  const captured = captureStderr(() => memory.listFragments(cwd, { milestoneId: MILESTONE }));
  const duplicates = captured.result.filter(entry => entry.unitId === 'S01');
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(duplicates[0].grouped, false);
  assert.ok(captured.output.includes('usando a solta'));
  assert.ok(captured.output.includes('S01'));
});

test('an invalid grouped storage key is discarded with a container warning', () => {
  const { cwd } = fixture();
  const container = path.join(memory.memoryDir(cwd), '2026-Q4.md');
  fs.writeFileSync(container, serializeGroup({
    epoch: '2026-Q4',
    units: [{ id: 'not-a-memory-storage-key', content: Buffer.from('---\nfacts: []\n---\n') }],
  }).buffer);
  const captured = captureStderr(() => memory.listFragments(cwd));
  assert.ok(!captured.result.some(entry => entry.storageKey === 'not-a-memory-storage-key'));
  assert.ok(captured.output.includes('2026-Q4.md'));
  assert.ok(captured.output.includes('not-a-memory-storage-key'));
  assert.ok(captured.output.includes('discarded'));
});

// An unreadable container used to be pushed as a LOOSE fragment named after
// its epoch, and the second loop then skipped it: every unit inside vanished
// with nothing on stderr, while a mere parse error two lines below did warn.
test('an unreadable container warns instead of listing itself as a loose fragment', () => {
  const { cwd } = fixture();
  groupEntries(cwd, [{ unitId: 'S01', opts: { milestoneId: MILESTONE } }], '2026-Q1');
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (typeof target === 'string' && target.endsWith('2026-Q1.md')) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return realReadFileSync(target, ...rest);
  };
  let listed;
  let captured;
  try { captured = captureStderr(() => { listed = memory.listFragments(cwd); }); }
  finally { fs.readFileSync = realReadFileSync; }
  assert.ok(!listed.some(entry => String(entry.storageKey || '').includes('2026-Q1')),
    'the container is not listed as a loose fragment named after its epoch');
  assert.ok(/container-unreadable/.test(captured.output),
    `expected a warning, got: ${JSON.stringify(captured.output)}`);
});

test('grouped envelopes preserve storage key, unit id, milestone id, and epoch', () => {
  const { cwd } = fixture();
  groupEntries(cwd, [{ unitId: 'T01', opts: { milestoneId: MILESTONE } }], '2026-Q5');
  const entry = memory.listFragments(cwd, { milestoneId: MILESTONE })
    .find(item => item.unitId === 'T01');
  assert.strictEqual(entry.storageKey, `${MILESTONE}__T01`);
  assert.strictEqual(entry.milestoneId, MILESTONE);
  assert.strictEqual(entry.epoch, '2026-Q5');
  assert.strictEqual(entry.grouped, true);
});

test('transaction seam sees grouped state and quarantines the complete append payload', () => {
  const { cwd } = fixture();
  groupEntries(cwd, [{ unitId: 'S01', opts: { milestoneId: MILESTONE } }], '2026-Q6');
  const captured = captureStderr(() => memory.transactFragment(
    cwd,
    { unit_id: 'S01', milestone_id: MILESTONE },
    {
      milestoneId: MILESTONE,
      extractionId: 'grouped-transaction',
      extractedAt: '2026-09-24T22:30:00.000Z',
    },
    current => ({
      fragment: {
        ...current,
        facts: [...current.facts, fact('MEM099', 'transaction candidate')],
      },
      result: { observed: current.facts.length },
    }),
  ));
  assert.strictEqual(captured.result.quarantined, true);
  assert.strictEqual(captured.result.transaction_result.observed, 1);
  const record = JSON.parse(fs.readFileSync(captured.result.path, 'utf8'));
  assert.strictEqual(record.fragment.facts.length, 2);
  assert.strictEqual(record.fragment.facts[1].mem_id, 'MEM099');
});

if (failed) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} grouped memory tests passed`);
}
