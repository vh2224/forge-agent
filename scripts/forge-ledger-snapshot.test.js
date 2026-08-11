'use strict';

// renderLedgerSnapshot — recency-first ledger selection for dispatch prompts
// (M-20260811134201-controle-contexto-gsd / S02 T01).
//
// The blocker this suite exists to hold down (S02-RISK B1): renderLedger emits
// entries in ASCENDING completed_at order, so any tail-cutting truncator keeps
// the OLDEST entries — the exact opposite of what a prompt wants. A size-only
// assertion passes green with the list inverted, so every selection case below
// asserts WHICH ids survived AND which were discarded, by id.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('./forge-ledger');
const projection = require('./forge-projection');
const { countTokens } = require('./forge-tokens');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; failures.push({ name, error }); console.log(`  ✗ ${name}`); }
}

function tmpCwd(label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `forge-ledger-snapshot-${label}-`));
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  return cwd;
}

function withStore(label) {
  const cwd = tmpCwd(label);
  fs.mkdirSync(ledger.ledgerDir(cwd), { recursive: true });
  return cwd;
}

function entry(id, completedAt, bulk = 3) {
  return {
    id,
    title: `Milestone ${id}`,
    completed_at: completedAt,
    slices: ['S01', 'S02'],
    key_files: Array.from({ length: bulk }, (_, i) => `scripts/${id}-file-${i}.js`),
    key_decisions: Array.from({ length: bulk }, (_, i) => `${id} decision ${i}`),
    body: '',
  };
}

// Four entries, oldest → newest, deliberately written to disk in an order that
// does NOT match recency (listFragments sorts by id, so id order is ascending
// here and the recency answer has to come from completed_at).
const FOUR = [
  entry('M001', '2026-01-01T00:00:00Z'),
  entry('M002', '2026-02-01T00:00:00Z'),
  entry('M003', '2026-03-01T00:00:00Z'),
  entry('M004', '2026-04-01T00:00:00Z'),
];

function seedFour(cwd) {
  for (const e of FOUR) ledger.writeFragment(cwd, e);
}

// ── 1. Recency selection, asserted by id (B1) ─────────────────────────────────

test('a budget that forces a cut retains the NEWEST entries and drops the oldest, by id', () => {
  const cwd = withStore('recency');
  seedFour(cwd);

  const full = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.deepStrictEqual(full.included_ids, ['M004', 'M003', 'M002', 'M001'], 'full snapshot is newest-first');
  assert.strictEqual(full.omitted_count, 0);

  // Budget sized to hold roughly half the store, forcing a real cut.
  const half = Math.ceil(countTokens(full.markdown) / 2);
  const cut = projection.renderLedgerSnapshot(cwd, { maxTokens: half });

  assert.ok(cut.included_ids.length > 0, 'cut snapshot kept at least one entry');
  assert.ok(cut.omitted_count > 0, 'cut snapshot actually dropped something');

  // The load-bearing assertion: survivors are the newest, discards the oldest.
  const kept = cut.included_ids;
  const dropped = FOUR.map(e => e.id).filter(id => !kept.includes(id));
  assert.ok(kept.includes('M004'), `newest M004 must survive; kept=${kept.join(',')}`);
  assert.ok(dropped.includes('M001'), `oldest M001 must be discarded; kept=${kept.join(',')}`);
  for (const keptId of kept) {
    for (const droppedId of dropped) {
      assert.ok(keptId > droppedId, `kept ${keptId} must be newer than dropped ${droppedId}`);
    }
  }
  // Body-level proof, independent of the envelope: the dropped id's block is
  // literally absent from the markdown, the kept id's block is present.
  assert.ok(cut.markdown.includes('## M004'));
  assert.ok(!cut.markdown.includes('## M001'));
  assert.strictEqual(cut.omitted_count, dropped.length);
});

test('missing completed_at sorts last (unknown recency is not evidence of recency)', () => {
  const cwd = withStore('undated');
  ledger.writeFragment(cwd, entry('M001', '2026-01-01T00:00:00Z'));
  ledger.writeFragment(cwd, { ...entry('M009', '2026-09-01T00:00:00Z'), completed_at: undefined });
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.deepStrictEqual(snap.included_ids, ['M001', 'M009']);
});

// ── 2. The marker counts ENTRIES and names the command (W1) ───────────────────

test('the marker counts omitted ENTRIES, not sections, and carries the exact command', () => {
  const cwd = withStore('marker');
  seedFour(cwd);

  // Budget tuned so exactly 2 of the 4 entries survive → marker must say 2.
  const full = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  let snap = null;
  for (let budget = 20; budget <= countTokens(full.markdown); budget += 1) {
    const candidate = projection.renderLedgerSnapshot(cwd, { maxTokens: budget });
    if (candidate.omitted_count === 2) { snap = candidate; break; }
  }
  assert.ok(snap, 'found a budget omitting exactly 2 entries');
  assert.strictEqual(snap.included_ids.length, 2);

  const markerLine = snap.markdown.split('\n').filter(Boolean).pop();
  assert.ok(markerLine.startsWith('[...truncated '), `shared marker family: ${markerLine}`);
  assert.ok(/\b2 ledger entries\b/.test(markerLine), `entry count, not section count: ${markerLine}`);
  assert.ok(markerLine.includes('node scripts/forge-projection.js --render ledger'), markerLine);
  // Entry-count vs section-count made observable: each dropped entry carries a
  // '## <id>' heading AND a '---' separator, so a boundary/section counter over
  // the same discarded region would have reported 4, not 2.
  const droppedIds = FOUR.map(e => e.id).filter(id => !snap.included_ids.includes(id));
  const droppedRegion = droppedIds
    .map(id => projection.renderLedgerBlock(ledger.readFragment(cwd, id), id).join('\n'))
    .join('\n');
  const droppedBoundaries = (droppedRegion.match(/^(?:## |---$)/gm) || []).length;
  assert.strictEqual(droppedBoundaries, 4, 'fixture must make section-count differ from entry-count');
  assert.ok(!/\b4 ledger entries\b/.test(markerLine), `marker must count entries, not sections: ${markerLine}`);
});

test('the marker pointer is single-line with POSIX separators', () => {
  const cwd = withStore('pointer');
  seedFour(cwd);
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 60 });
  const markerLine = snap.markdown.split('\n').filter(Boolean).pop();
  assert.ok(!markerLine.includes('\\'), `no backslashes in pointer: ${markerLine}`);
  assert.strictEqual(markerLine.trim(), markerLine);
});

test('no marker at all when every entry fits', () => {
  const cwd = withStore('nomarker');
  seedFour(cwd);
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.ok(!snap.markdown.includes('[...truncated'));
  assert.strictEqual(snap.omitted_count, 0);
});

// ── 3. The marker is charged against the budget it protects (MEM002) ──────────

test('countTokens(snapshot) <= maxTokens across every budget, marker included', () => {
  const cwd = withStore('budget');
  seedFour(cwd);
  const ceiling = countTokens(projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 }).markdown);
  for (let budget = 2; budget <= ceiling + 20; budget += 1) {
    const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: budget });
    assert.ok(
      countTokens(snap.markdown) <= budget,
      `budget=${budget} produced ${countTokens(snap.markdown)} tokens`,
    );
  }
});

test('entries are never cut mid-block — every included id keeps its whole block', () => {
  const cwd = withStore('whole');
  seedFour(cwd);
  const byId = new Map(FOUR.map(e => [e.id, projection.renderLedgerBlock(
    ledger.readFragment(cwd, e.id), e.id,
  ).join('\n')]));
  for (let budget = 10; budget <= 400; budget += 7) {
    const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: budget });
    for (const id of snap.included_ids) {
      assert.ok(snap.markdown.includes(byId.get(id)), `budget=${budget} truncated the block of ${id}`);
    }
  }
});

// ── 4. Empty store and monolith fallback (Key Decision 7) ─────────────────────

test('empty store and no monolith renders (none)', () => {
  const cwd = withStore('empty');
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 1500 });
  assert.strictEqual(snap.markdown, '(none)');
  assert.deepStrictEqual(snap.included_ids, []);
  assert.strictEqual(snap.omitted_count, 0);
  assert.strictEqual(snap.source, 'empty');
});

test('empty store + LEDGER.md falls back to monolith blocks taken from the END (append-only)', () => {
  const cwd = tmpCwd('monolith');
  // Blocks are bulky on purpose: a half-of-full budget must be able to hold
  // some-but-not-all of them, otherwise the cut proves nothing.
  const block = (id, label) => [
    `## ${id}`,
    `**${label}**`,
    '',
    ...Array.from({ length: 10 }, (_, i) => `  - ${id} key file scripts/${id}-file-${i}.js`),
    '',
    '---',
    '',
  ];
  fs.writeFileSync(path.join(cwd, '.gsd', 'LEDGER.md'), [
    '# Forge Project Ledger',
    '',
    ...block('M001', 'Oldest'),
    ...block('M002', 'Middle'),
    ...block('M003', 'Newest'),
  ].join('\n'));

  const full = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.strictEqual(full.source, 'monolith');
  assert.deepStrictEqual(full.included_ids, ['M003', 'M002', 'M001'], 'newest-first display order');

  const cut = projection.renderLedgerSnapshot(cwd, { maxTokens: Math.ceil(countTokens(full.markdown) / 2) });
  assert.ok(cut.included_ids.includes('M003'), `tail of the monolith is the newest: ${cut.included_ids}`);
  assert.ok(!cut.included_ids.includes('M001'), `head of the monolith is the oldest: ${cut.included_ids}`);
  assert.ok(cut.markdown.includes('[...truncated '));
});

test('a populated store never consults the stale monolith', () => {
  const cwd = withStore('store-wins');
  ledger.writeFragment(cwd, entry('M007', '2026-07-01T00:00:00Z'));
  fs.writeFileSync(path.join(cwd, '.gsd', 'LEDGER.md'), '# Forge Project Ledger\n\n## M001\n**Stale projection**\n\n---\n');
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.strictEqual(snap.source, 'fragments');
  assert.deepStrictEqual(snap.included_ids, ['M007']);
  assert.ok(!snap.markdown.includes('Stale projection'));
});

// ── 5. Degradation, never a throw ─────────────────────────────────────────────

test('one unreadable fragment warns and the snapshot still ships the rest', () => {
  const cwd = withStore('degrade');
  ledger.writeFragment(cwd, entry('M001', '2026-01-01T00:00:00Z'));
  ledger.writeFragment(cwd, entry('M002', '2026-02-01T00:00:00Z'));
  // A directory where a fragment file is expected: readFragmentText throws.
  fs.mkdirSync(path.join(ledger.ledgerDir(cwd), 'M003.md'));
  const snap = projection.renderLedgerSnapshot(cwd, { maxTokens: 16000 });
  assert.deepStrictEqual(snap.included_ids, ['M002', 'M001']);
});

test('renderLedger is NOT reordered by this slice — it stays ascending', () => {
  const cwd = withStore('ascending');
  seedFour(cwd);
  const rendered = projection.renderLedger(cwd);
  const order = (rendered.match(/^## (M\d+)$/gm) || []).map(l => l.replace('## ', ''));
  assert.deepStrictEqual(order, ['M001', 'M002', 'M003', 'M004'], 'readLedgerTail contract: oldest first');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const { name, error } of failures) console.error(`\n✗ ${name}\n${error.stack}`);
  process.exit(1);
}
