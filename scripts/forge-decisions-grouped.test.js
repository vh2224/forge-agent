'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serializeGroup } = require('./forge-grouped-file');
const decisions = require('./forge-decisions');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; failures.push({ name, error }); console.log(`  ✗ ${name}`); }
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-decisions-grouped-'));
  fs.mkdirSync(decisions.decisionsDir(cwd), { recursive: true });
  const entries = ['M001', 'M002', 'M003'].map((unit_id, index) => ({
    unit_id,
    decisions: [{ when: `2026-01-0${index + 1}`, scope: 'test', decision: `Decision ${index}`, choice: 'keep', rationale: 'fixture', revisable: 'yes' }],
    body: `body-${unit_id}`,
  }));
  for (const entry of entries) decisions.writeFragment(cwd, entry);
  return { cwd, entries };
}

function groupEntries(cwd, ids, epoch) {
  const units = ids.map(unitId => ({
    id: unitId,
    content: fs.readFileSync(decisions.fragmentPath(cwd, unitId)),
  }));
  const result = serializeGroup({ epoch, units });
  const container = path.join(decisions.decisionsDir(cwd), `${epoch}.md`);
  fs.writeFileSync(container, result.buffer);
  for (const unitId of ids) fs.unlinkSync(decisions.fragmentPath(cwd, unitId));
  return container;
}

function captureStderr(fn) {
  let output = '';
  const original = process.stderr.write;
  process.stderr.write = value => { output += String(value); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return output;
}

test('grouped decisions preserve the loose unit count', () => {
  const { cwd } = fixture();
  const before = decisions.listFragments(cwd);
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const after = decisions.listFragments(cwd);
  assert.strictEqual(before.length, 3);
  assert.strictEqual(after.length, before.length);
  assert.ok(after.every(entry => typeof entry.grouped === 'boolean'));
  assert.ok(after.every(entry => typeof entry.epoch === 'string' || entry.epoch === null));
  assert.ok(after.every(entry => fs.existsSync(entry.path)));
});

test('readFragment and readFragmentText return one grouped decision fragment', () => {
  const { cwd } = fixture();
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const listed = decisions.listFragments(cwd).find(entry => entry.unitId === 'M001');
  assert.strictEqual(listed.grouped, true);
  const text = decisions.readFragmentText(cwd, listed);
  assert.ok(text.includes('unit_id: M001'));
  assert.deepStrictEqual(decisions.readFragment(cwd, 'M001'), decisions.parseFragment(text));
});

test('loose decision duplicate wins and is warned', () => {
  const { cwd } = fixture();
  const original = fs.readFileSync(decisions.fragmentPath(cwd, 'M001'));
  const container = path.join(decisions.decisionsDir(cwd), '2026-Q2.md');
  fs.writeFileSync(container, serializeGroup({ epoch: '2026-Q2', units: [{ id: 'M001', content: original }] }).buffer);
  const warning = captureStderr(() => {
    const list = decisions.listFragments(cwd).filter(entry => entry.unitId === 'M001');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].grouped, false);
  });
  assert.ok(warning.includes('M001'));
  assert.ok(warning.includes('usando a solta'));
});

test('loose entries carry null epoch while members carry the container epoch', () => {
  const { cwd } = fixture();
  groupEntries(cwd, ['M001'], '2026-Q9');
  const list = decisions.listFragments(cwd);
  assert.strictEqual(list.find(entry => entry.unitId === 'M001').epoch, '2026-Q9');
  assert.strictEqual(list.find(entry => entry.unitId === 'M002').epoch, null);
});

test('readFragment preserves invalid-id behavior', () => {
  const { cwd } = fixture();
  // Matches the production message verbatim (forge-decisions.js fragmentPath),
  // which names the store and PREDATES this milestone — `git show
  // 78bf210:scripts/forge-decisions.js` already carries it. The original regex
  // was written against an imagined message and never matched. This test is a
  // regression guard for the error surface users already see, so it is pointed
  // at the real contract, not loosened: the store name is now required.
  assert.throws(() => decisions.readFragment(cwd, 'not-an-id'), /Invalid decisions unit ID/);
});

test('member text is not the container frontmatter', () => {
  const { cwd } = fixture();
  const container = groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const entry = decisions.listFragments(cwd).find(item => item.unitId === 'M002');
  const text = decisions.readFragmentText(cwd, entry);
  assert.ok(text.includes('unit_id: M002'));
  assert.ok(!text.includes('grouped_format: forge-group@1'));
  assert.ok(fs.readFileSync(container, 'utf8').includes('grouped_format: forge-group@1'));
});

test('every grouped decision envelope points at the physical container', () => {
  const { cwd } = fixture();
  const container = groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  for (const entry of decisions.listFragments(cwd).filter(item => item.grouped)) {
    assert.strictEqual(entry.path, container);
    assert.ok(fs.statSync(entry.path).isFile());
  }
});

// An unreadable container used to be pushed as a LOOSE fragment named after
// its epoch, and the second loop then skipped it: every unit inside vanished
// with nothing on stderr, while a mere parse error two lines below did warn.
test('an unreadable container warns instead of listing itself as a loose fragment', () => {
  const { cwd } = fixture();
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
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
  let output;
  try { output = captureStderr(() => { listed = decisions.listFragments(cwd); }); }
  finally { fs.readFileSync = realReadFileSync; }
  assert.ok(!listed.some(entry => entry.unitId === '2026-Q1'),
    'the container is not listed as a loose fragment named after its epoch');
  assert.ok(/container-unreadable/.test(output), `expected a warning, got: ${JSON.stringify(output)}`);
  assert.ok(listed.some(entry => entry.unitId === 'M003'), 'readable neighbours are unaffected');
});

test('loose decision text remains the complete original fragment', () => {
  const { cwd } = fixture();
  const entry = decisions.listFragments(cwd).find(item => item.unitId === 'M003');
  const text = decisions.readFragmentText(cwd, entry);
  assert.ok(text.startsWith('---'));
  assert.ok(text.includes('unit_id: M003'));
  assert.ok(text.includes('Decision 2'));
});

test('review R18 decisions prepare is read-only and apply deduplicates exact bytes while rejecting stale or foreign plans', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-decisions-prepared-'));
  const fragment = { unit_id:'M001', decisions:[{when:'2026-11-10',scope:'task',decision:'Retain custody',choice:'yes',rationale:'joined cohort',revisable:'yes'}] };
  const prepared = decisions.prepareFragment(cwd, fragment).prepared;
  assert.strictEqual(fs.existsSync(path.join(cwd,'.gsd')),false,'preview must not create directories or locks');
  const applied = decisions.applyPreparedFragment(cwd,fragment,prepared);
  const before = fs.readFileSync(applied.path);
  assert.strictEqual(decisions.applyPreparedFragment(cwd,fragment,prepared).created,false);
  assert.deepStrictEqual(fs.readFileSync(applied.path),before);
  assert.strictEqual(decisions.readFragment(cwd,'M001').decisions.length,1,'replay keeps one canonical decision');
  assert.throws(()=>decisions.applyPreparedFragment(cwd,fragment,{...prepared,path:path.join(cwd,'foreign.md')}),/prepared|conflict|stale/i);
  const revised = {...fragment,decisions:[...fragment.decisions,{...fragment.decisions[0],decision:'Second fact'}]};
  assert.throws(()=>decisions.applyPreparedFragment(cwd,revised,prepared),/prepared|conflict|stale/i);
  fs.appendFileSync(applied.path,'foreign\n');
  const foreign = fs.readFileSync(applied.path);
  assert.throws(()=>decisions.applyPreparedFragment(cwd,fragment,prepared),/prepared|conflict|stale/i);
  assert.deepStrictEqual(fs.readFileSync(applied.path),foreign);
});

if (failed) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} grouped decisions tests passed`);
}
