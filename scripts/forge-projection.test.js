#!/usr/bin/env node
// forge-projection.test.js — regression suite for projection rendering.
//
//   Bug: renderLedger emitted fragments in lexicographic id order. With mixed
//   legacy `M###` and timestamp `M-<ts>-<slug>` ids, '-' (0x2D) < '0' (0x30)
//   puts every legacy id after every timestamp id, so a long-completed legacy
//   milestone (e.g. M013) landed as the LAST block of the projected LEDGER.md.
//   forge-dashboard readLedgerTail takes the file tail as "most recent" and
//   showed the stale milestone as "Last completed" no matter how many
//   timestamp milestones closed after it.
//
// Run: node scripts/forge-projection.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const crypto = require('crypto');
const nodeAssert = require('assert');

const projection = require('./forge-projection');
const dashboard  = require('./forge-dashboard');
const memory     = require('./forge-memory');
const evidence   = require('./forge-memory-evidence');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projection-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function seedFragment(cwd, id, completedAt, title) {
  const dir = path.join(cwd, '.gsd', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    ...(completedAt ? [`completed_at: ${completedAt}`] : []),
    `id: ${id}`,
    'slices: [S01]',
    `title: ${title}`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${id}.md`), fm, 'utf8');
}

function headerOrder(rendered) {
  return rendered.split(/\r?\n/)
    .map(l => l.match(/^##\s+(\S+)/))
    .filter(Boolean)
    .map(m => m[1]);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== forge-projection — regression suite ===\n');

console.log('renderLedger — chronological ordering with mixed id formats');

test('legacy M### completed first does not sort after timestamp ids', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M013',                        '2025-11-30', 'Legacy milestone');
    seedFragment(tmp, 'M-20260522101500-pagamentos', '2026-05-22', 'Pagamentos');
    seedFragment(tmp, 'M-20260527131143-fix',        '2026-05-27', 'Fix feedback');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order.length === 3, `expected 3 blocks, got ${order.length}`);
    assert(order[0] === 'M013', `expected M013 first (oldest), got ${order[0]}`);
    assert(order[2] === 'M-20260527131143-fix',
      `expected M-20260527131143-fix last (newest), got ${order[2]}`);
  } finally { rmrf(tmp); }
});

test('fragment without completed_at sorts first (treated as oldest)', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260522101500-pagamentos', '2026-05-22', 'Pagamentos');
    seedFragment(tmp, 'M099', null, 'Sem data');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order[0] === 'M099', `expected dateless fragment first, got ${order[0]}`);
  } finally { rmrf(tmp); }
});

test('same completed_at falls back to id tiebreaker (deterministic)', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260522101500-b', '2026-05-22', 'B');
    seedFragment(tmp, 'M-20260522093000-a', '2026-05-22', 'A');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order.join(',') === 'M-20260522093000-a,M-20260522101500-b',
      `unexpected tiebreak order: ${order.join(',')}`);
  } finally { rmrf(tmp); }
});

console.log('\nforge-dashboard — "Last completed" reads newest milestone');

test('dashboard shows newest timestamp milestone, not stale legacy id', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M013',                        '2025-11-30', 'Legacy milestone');
    seedFragment(tmp, 'M-20260527131143-fix',        '2026-05-27', 'Fix feedback');

    fs.writeFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), projection.renderLedger(tmp), 'utf8');

    const rendered = dashboard.render(tmp);
    assert(/Last completed: M-20260527131143-fix/.test(rendered),
      `expected "Last completed: M-20260527131143-fix", got:\n${rendered}`);
    assert(!/Last completed: M013/.test(rendered), 'stale M013 still reported as last completed');
  } finally { rmrf(tmp); }
});

// ════════════════════════════════════════════════════════════════════════════
// S03/T02 — Form B: a projection writer re-emits the EOL the file on disk uses.
// The damage this guards is silent: writeAll assembles with LF, so a CRLF
// .gsd/LEDGER.md (Windows-authored, or checked out with core.autocrlf=true) was
// flattened to LF on every regeneration — every line of the file rewritten, with
// nothing in the diff to explain why. Measured at e8c4040: CR 10 → 0.
console.log('\nForm B — projection writers preserve the EOL already on disk');

function countEol(file) {
  const b = fs.readFileSync(file);
  let cr = 0, lf = 0;
  for (let i = 0; i < b.length; i++) { if (b[i] === 13) cr++; if (b[i] === 10) lf++; }
  return { cr, lf };
}

test('writeAll re-renders a CRLF LEDGER.md without zeroing its CR bytes', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260813131121-eol', '2026-08-13', 'EOL probe');
    projection.writeAll(tmp, { force: true });
    const lp = path.join(tmp, '.gsd', 'LEDGER.md');

    // Re-author the projection with explicit CRLF bytes, as a Windows checkout has it.
    fs.writeFileSync(lp, fs.readFileSync(lp, 'utf8').replace(/\r\n?|\n/g, '\r\n'));
    const before = countEol(lp);
    assert(before.cr > 0, 'fixture did not actually contain CR bytes');

    // Form B is "re-emit the EOL of the text the writer READ": the expectation is
    // derived from that same read, not from the bytes this test authored. Under an
    // instrument that rewrites utf8 reads (forge-eol-preload.js, LF arm) writeAll
    // cannot see the CR — asserting its survival there demands the impossible and
    // registers as a false EOL flip. Both branches still bite if Form B is reverted.
    const writerSeesCrlf = /\r\n/.test(fs.readFileSync(lp, 'utf8'));

    seedFragment(tmp, 'M-20260813131122-eol2', '2026-08-14', 'EOL probe 2');
    projection.writeAll(tmp, { force: true });
    const after = countEol(lp);

    if (writerSeesCrlf) {
      assert(after.cr !== 0, `CR count zeroed: ${before.cr} → 0 — the projection was flattened to LF`);
      assert(after.cr === after.lf,
        `mixed EOL after write: cr=${after.cr} lf=${after.lf} — the render was spliced in with LF`);
    } else {
      assert(after.cr === 0,
        `writer read LF but emitted ${after.cr} CR bytes — EOL was invented, not re-emitted`);
      assert(after.lf > 0, 'writer produced no line terminators at all');
    }
  } finally { rmrf(tmp); }
});

test('dashboard.render honours the EOL it is handed, and defaults to LF', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260813131121-eol', '2026-08-13', 'EOL probe');
    fs.writeFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), projection.renderLedger(tmp), 'utf8');

    const lf = dashboard.render(tmp);
    assert(!/\r/.test(lf), 'default render must stay LF — no CR may appear unasked');

    const crlf = dashboard.render(tmp, '\r\n');
    assert(/\r\n/.test(crlf), 'render(cwd, "\\r\\n") did not emit CRLF');
    assert(!/[^\r]\n/.test(crlf), 'render(cwd, "\\r\\n") left bare LF behind — output is half and half');
    // Line-for-line equality, not string equality: the projection embeds a
    // generation timestamp, so two renders taken microseconds apart legitimately
    // differ in one field. What must not differ is the number of lines.
    assert(crlf.split(/\r\n/).length === lf.split(/\n/).length,
      'CRLF render has a different line count than the LF render');
  } finally { rmrf(tmp); }
});

// ── Summary ───────────────────────────────────────────────────────────────────
test('memory projection folds confirmation, promotion, supersede and prune independently', () => {
  const tmp = mkTmp();
  try {
    memory.writeFragment(tmp, {
      unit_id: 'T01',
      facts: [
        { mem_id: 'MEM001', category: 'pattern', text: 'confirmed and promoted', confidence_base: 0.9, created_at: '2026-09-24T00:00:00.000Z' },
        { mem_id: 'MEM002', category: 'gotcha', text: 'superseded', confidence_base: 0.9, created_at: '2026-09-24T00:00:00.000Z' },
        { mem_id: 'MEM003', category: 'gotcha', text: 'pruned', confidence_base: 0.9, created_at: '2026-09-24T00:00:00.000Z' },
        { mem_id: 'MEM004', category: 'architecture', text: 'replacement', confidence_base: 0.9, created_at: '2026-09-24T00:00:00.000Z' },
      ],
      stats: [
        { kind: 'seed', mem_id: 'MEM001', ts: '2026-09-24T00:00:00.000Z', confidence_base: 0.9, hits: 2 },
        { kind: 'confirm', mem_id: 'MEM001', ts: '2026-09-24T00:00:01.000Z' },
        { kind: 'promote', mem_id: 'MEM001', ts: '2026-09-24T00:00:02.000Z', threshold_met: true },
        { kind: 'supersede', old_id: 'MEM002', new_id: 'MEM004', ts: '2026-09-24T00:00:03.000Z' },
        { kind: 'prune', mem_id: 'MEM003', ts: '2026-09-24T00:00:04.000Z', reason: 'cap' },
      ],
    });
    const entries = projection.projectMemoryEntries(tmp, { nowMs: Date.parse('2026-09-24T00:00:05.000Z') });
    const promoted = entries.find(entry => entry.fact.mem_id === 'MEM001');
    assert(promoted && promoted.hits === 3 && promoted.promoted === true,
      'confirm and promote must survive projection');
    assert(!entries.some(entry => entry.fact.mem_id === 'MEM002'), 'superseded fact must be hidden');
    assert(!entries.some(entry => entry.fact.mem_id === 'MEM003'), 'pruned fact must be hidden');
    assert(entries.some(entry => entry.fact.mem_id === 'MEM004'), 'replacement fact must remain visible');
  } finally { rmrf(tmp); }
});

// ════════════════════════════════════════════════════════════════════════════
// S03/T02 — projectMemoryEntries delegates to foldMemoryEvidence. Every fixture
// is published through forge-memory.writeFragment into a temporary root and
// re-read from disk before projection; the clock is always injected.
console.log('\nmemory projection — shared evidence reducer');

const T0 = '2026-10-01T00:00:00.000Z';
const NOW0 = Date.parse(T0);
const DAY_MS = 24 * 60 * 60 * 1000;

function memFact(memId, category, text) {
  return { mem_id: memId, category, text, created_at: T0, source_unit: 'execute-task/T01' };
}

function stat(kind, memId, extra) {
  return { kind, mem_id: memId, ts: T0, ...(extra || {}) };
}

function v2Row(kind, localEventId, overrides) {
  const extractionId = (overrides && overrides.extraction_id) || 'extract-2';
  const base = { kind, evidence_version: 2, event_id: `${extractionId}:v2:${localEventId}`, extraction_id: extractionId,
    local_event_id: localEventId, ts: '2026-10-01T01:00:00.000Z', mem_id: 'MEM001' };
  const bound = { evidence_ref: 'ev', observation_id: `obs-${localEventId}`, source_unit: 'execute-task/T02',
    source_fingerprint: 'sha256:other', observed_kind: kind };
  const extra = kind === 'confirm' ? { independent_ref: 'verify:T02:check-7' }
    : kind === 'utility' ? { outcome_ref: 'out1', outcome_id: 'outcome-T02-pass', outcome_result_ref: 'result:T02:summary' } : {};
  return { ...base, ...(evidence.EVIDENCE_KINDS.includes(kind) ? { ...bound, ...extra } : {}), ...(overrides || {}) };
}

// Purely legacy set: historical seed hits, hit, explicit decay, promotion,
// prune, supersede and a cross-fragment score tie, all at the same instant.
function publishLegacyFixture(cwd) {
  memory.writeFragment(cwd, {
    unit_id: 'T01',
    facts: [
      memFact('MEM001', 'gotcha', 'alpha cache invalidation rule'),
      memFact('MEM002', 'pattern', 'beta cache layering'),
      memFact('MEM003', 'architecture', 'gamma cache gateway'),
      memFact('MEM004', 'convention', 'delta cache naming'),
      memFact('MEM005', 'gotcha', 'epsilon pruned cache'),
      memFact('MEM006', 'gotcha', 'eta superseded cache'),
    ],
    stats: [
      stat('seed', 'MEM001', { confidence_base: 0.9, hits: 2 }), stat('hit', 'MEM001'),
      stat('seed', 'MEM002', { confidence_base: 0.6, hits: 4 }), stat('decay', 'MEM002', { new_confidence: 0.5 }),
      stat('seed', 'MEM003', { confidence_base: 0.8, hits: 0 }), stat('promote', 'MEM003', { threshold_met: true }),
      stat('seed', 'MEM004', { confidence_base: 0.7, hits: 0 }),
      stat('seed', 'MEM005', { confidence_base: 0.9, hits: 9 }), stat('prune', 'MEM005', { reason: 'cap' }),
      { kind: 'supersede', old_id: 'MEM006', new_id: 'MEM004', ts: T0 },
    ],
  });
  memory.writeFragment(cwd, {
    unit_id: 'T02',
    facts: [memFact('MEM001', 'convention', 'zeta cache naming twin')],
    stats: [stat('seed', 'MEM001', { confidence_base: 0.7, hits: 0 })],
  });
}

// v2 rows on top of the legacy fixture; exposure/reobserve/utility only.
const NON_REINFORCING = [
  v2Row('exposure', 'x1', { mem_id: 'MEM004' }), v2Row('exposure', 'x2', { mem_id: 'MEM004' }),
  v2Row('exposure', 'x3', { mem_id: 'MEM004' }), v2Row('reobserve', 'r1', { mem_id: 'MEM004' }),
  v2Row('reobserve', 'r2', { mem_id: 'MEM004' }), v2Row('utility', 'u1', { mem_id: 'MEM004' }),
  v2Row('exposure', 'x4', { mem_id: 'MEM004', observation_id: 'obs-x1' }),
];

function storedFragments(cwd) {
  return memory.listFragments(cwd).filter(entry => entry.unitId !== 'legacy-orphan').map(entry => ({
    milestoneId: entry.milestoneId || null,
    unitId: entry.unitId,
    ...(({ facts, stats }) => ({ facts, stats }))(memory.parseFragment(memory.readFragmentText(cwd, entry))),
  }));
}

function ranking(entries) {
  return entries.map(entry => [entry.identity, entry.hits, entry.confidence, entry.base_confidence,
    entry.lastAccessTs, entry.promoted, entry.promotedAt]);
}

function withoutClock(entries) {
  return entries.map(entry => { const { confidence, ...rest } = entry; return rest; })
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

function near(actual, expected, label) {
  assert(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

test('legacy-only ranking is frozen at a fixed instant (formula and tie-breaks unchanged)', () => {
  const tmp = mkTmp();
  try {
    publishLegacyFixture(tmp);
    const entries = projection.projectMemoryEntries(tmp, { nowMs: NOW0 });
    nodeAssert.deepStrictEqual(entries.map(entry => entry.identity),
      ['T01/MEM001', 'T01/MEM002', 'T01/MEM003', 'T01/MEM004', 'T02/MEM001'],
      'pruned and superseded facts hidden; equal scores fall back to identity');
    nodeAssert.deepStrictEqual(entries.map(entry => entry.hits), [3, 4, 0, 0, 0]);
    [0.92, 0.5, 0.85, 0.7, 0.7].forEach((value, index) => near(entries[index].confidence, value, entries[index].identity));
    assert(entries[2].promoted === true && entries[2].promotedAt === T0, 'historical promotion survives');
    nodeAssert.deepStrictEqual(entries[2].evidence.promotions, [{ ts: T0, origin: 'legacy', basis: 'legacy_ambiguous' }]);
    assert(entries[2].evidence.v2.promoted === false, 'a historical promotion is never declared proven by v2');
    nodeAssert.deepStrictEqual(entries[0].evidence.legacy_ambiguous,
      { label: 'legacy_ambiguous', seed_hits: 2, hit: 1, confirm: 0, promote: 0 });
    assert(entries.every(entry => entry.evidence.hits_basis === 'legacy_ranking' && entry.evidence.model_version === 2));

    const later = projection.projectMemoryEntries(tmp, { nowMs: NOW0 + 30 * DAY_MS });
    later.forEach((entry, index) => near(entry.confidence, entries[index].confidence / 2, `${entry.identity} one half-life`));
    nodeAssert.deepStrictEqual(withoutClock(later), withoutClock(entries), 'only the decayed value depends on the clock');

    const query = projection.queryMemoryEntries(tmp, { unitType: 'execute-task', query: 'cache naming rule', nowMs: NOW0 });
    nodeAssert.deepStrictEqual(query.entries.map(entry => [entry.identity, entry.score, entry.hits]),
      [['T01/MEM001', 232.76, 3], ['T01/MEM004', 220.7, 0], ['T02/MEM001', 220.7, 0]],
      'matched_terms*100 + category*10 + confidence*max(1,hits), identity tie-break');
    nodeAssert.deepStrictEqual(query.entries[0].evidence, {
      model_version: 2, origin: 'legacy_unknown', hits_basis: 'legacy_ranking',
      counters: { exposure: 0, reobserve: 0, independent_confirmation: 0, utility: 0 },
      legacy_ambiguous: { seed_hits: 2, hit: 1, confirm: 0, promote: 0 },
    });
    assert(query.evidence_model_version === 2, 'query output carries the evidence model version');
  } finally { rmrf(tmp); }
});

test('projection state equals the reducer state for the same re-read fragments; decay applied once', () => {
  const tmp = mkTmp();
  try {
    publishLegacyFixture(tmp);
    memory.writeFragment(tmp, { unit_id: 'T01', facts: [], stats: [...NON_REINFORCING, v2Row('confirm', 'c1', { mem_id: 'MEM002' })] });
    const folded = evidence.foldMemoryEvidence(storedFragments(tmp));
    const nowMs = NOW0 + 7 * DAY_MS;
    const state = projection.projectMemoryState(tmp, { nowMs });
    const active = folded.entries.filter(item => !item.pruned);
    nodeAssert.deepStrictEqual(state.entries.map(entry => entry.identity).sort(), active.map(item => item.identity).sort());
    for (const item of active) {
      const entry = state.entries.find(candidate => candidate.identity === item.identity);
      const legacy = item.legacyProjection;
      nodeAssert.deepStrictEqual(
        [entry.hits, entry.base_confidence, entry.lastAccessTs, entry.promoted, entry.promotedAt],
        [legacy.hits, legacy.confidence, legacy.lastAccessTs, legacy.promoted, legacy.promotedAt], item.identity);
      nodeAssert.deepStrictEqual(
        [entry.evidence.origin, entry.evidence.v2, entry.evidence.counters, entry.evidence.legacy_ambiguous, entry.evidence.promotions],
        [item.origin, item.v2, item.counters, item.legacy_ambiguous, item.promotions], item.identity);
      assert(entry.confidence === projection._private.decayConfidence(legacy.confidence, legacy.lastAccessTs, nowMs),
        `${item.identity}: decay must be applied exactly once to the undecayed reducer value`);
    }
    nodeAssert.deepStrictEqual(state.diagnostics.duplicates, folded.duplicates);
    nodeAssert.deepStrictEqual(withoutClock(projection.projectMemoryState(tmp, { nowMs: NOW0 }).entries), withoutClock(state.entries),
      'semantic state is independent of the clock');
  } finally { rmrf(tmp); }
});

test('v2 exposure, reobserve and utility never raise hits/confidence; repeated observation adds nothing', () => {
  const legacyRoot = mkTmp();
  const mixedRoot = mkTmp();
  try {
    publishLegacyFixture(legacyRoot);
    publishLegacyFixture(mixedRoot);
    const result = memory.writeFragment(mixedRoot, { unit_id: 'T01', facts: [], stats: NON_REINFORCING });
    assert(result.created === true, 'v2 rows were published');
    const stored = memory.readFragment(mixedRoot, 'T01').stats.filter(row => row.evidence_version);
    assert(stored.length === NON_REINFORCING.length, 'distinct delivery IDs are retained even for repeated observations');
    nodeAssert.deepStrictEqual(stored.map(row => row.event_id).sort(),
      NON_REINFORCING.map(row => row.event_id).sort(), 'x1 and x4 remain separate delivery identities');
    assert(memory.writeFragment(mixedRoot, { unit_id: 'T01', facts: [], stats: NON_REINFORCING }).created === false,
      'exact replay of stored delivery IDs is a no-op');
    nodeAssert.deepStrictEqual(memory.readFragment(mixedRoot, 'T01').stats.filter(row => row.evidence_version), stored);
    for (const nowMs of [NOW0, NOW0 + 3 * DAY_MS]) {
      const base = projection.projectMemoryEntries(legacyRoot, { nowMs });
      const mixed = projection.projectMemoryEntries(mixedRoot, { nowMs });
      nodeAssert.deepStrictEqual(ranking(mixed), ranking(base), 'ranking inputs and order are untouched');
      const counters = mixed.find(entry => entry.identity === 'T01/MEM004').evidence;
      nodeAssert.deepStrictEqual(
        [counters.counters.exposure.count, counters.counters.reobserve.count, counters.counters.utility.count,
          counters.counters.independent_confirmation.count, counters.v2.independent_confirmation_count, counters.v2.promoted],
        [3, 2, 1, 0, 0, false], 'counted apart, no promotion basis from repetition');
      nodeAssert.deepStrictEqual(counters.counters.utility.outcome_ids, ['outcome-T02-pass']);
    }
    const query = projection.queryMemoryEntries(mixedRoot, { unitType: 'execute-task', query: 'cache naming rule', nowMs: NOW0 });
    nodeAssert.deepStrictEqual(query.entries.map(entry => [entry.identity, entry.score]),
      [['T01/MEM001', 232.76], ['T01/MEM004', 220.7], ['T02/MEM001', 220.7]]);
    nodeAssert.deepStrictEqual(query.entries[1].evidence.counters, { exposure: 3, reobserve: 2, independent_confirmation: 0, utility: 1 });
    assert(query.entries[1].hits === 0, 'hits is not a utility counter');
  } finally { rmrf(legacyRoot); rmrf(mixedRoot); }
});

test('independent v2 confirmation reinforces once; the same observation repackaged does not', () => {
  const tmp = mkTmp();
  try {
    publishLegacyFixture(tmp);
    const confirm = v2Row('confirm', 'c1', { mem_id: 'MEM002' });
    memory.writeFragment(tmp, { unit_id: 'T01', facts: [], stats: [confirm] });
    const repackaged = v2Row('confirm', 'c9', { mem_id: 'MEM002', extraction_id: 'extract-3', event_id: 'extract-3:v2:c9',
      observation_id: 'obs-c1', evidence_ref: 'other', ts: '2026-10-01T02:00:00.000Z' });
    assert(memory.writeFragment(tmp, { unit_id: 'T01', facts: [], stats: [repackaged] }).created === true,
      'a distinct delivery identity is retained without reinforcing the observation twice');
    const stored = memory.readFragment(tmp, 'T01').stats.filter(row => row.evidence_version);
    nodeAssert.deepStrictEqual(stored.map(row => row.event_id).sort(), [confirm.event_id, repackaged.event_id].sort());
    assert(memory.writeFragment(tmp, { unit_id: 'T01', facts: [], stats: [repackaged] }).created === false,
      'exact replay of the repackaged delivery is a no-op');
    nodeAssert.deepStrictEqual(memory.readFragment(tmp, 'T01').stats.filter(row => row.evidence_version), stored);
    const entry = projection.projectMemoryEntries(tmp, { nowMs: NOW0 }).find(item => item.identity === 'T01/MEM002');
    assert(entry.hits === 5, `historical 4 + one independent confirmation, got ${entry.hits}`);
    near(entry.base_confidence, 0.52, 'confirmation nudges the legacy ranking confidence once');
    assert(entry.lastAccessTs === confirm.ts, 'confirmation is a reinforcement access');
    assert(entry.evidence.counters.independent_confirmation.count === 1 && entry.evidence.v2.independent_confirmation_count === 1);
    nodeAssert.deepStrictEqual(entry.evidence.legacy_ambiguous, { label: 'legacy_ambiguous', seed_hits: 4, hit: 0, confirm: 0, promote: 0 },
      'historical seed hits stay legacy_ambiguous next to the v2 count');
  } finally { rmrf(tmp); }
});

test('legacy-orphan fallback, missing targets and conflicting fragments stay explicit', () => {
  const tmp = mkTmp();
  try {
    memory.writeFragment(tmp, {
      unit_id: 'T01', facts: [memFact('MEM001', 'gotcha', 'canonical fact')],
      stats: [stat('seed', 'MEM001', { confidence_base: 0.8, hits: 1 }), stat('hit', 'MEM404'), v2Row('exposure', 'x9', { mem_id: 'MEM999' })],
    });
    fs.writeFileSync(path.join(tmp, '.gsd', 'memory', 'legacy-orphan.md'), [
      '# Legacy orphan memory', '',
      '## [MEM777] gotcha', '- text: orphan cache memory', '- confidence: 0.6', '- hits: 2', `- updated: ${T0}`, '',
      '## [MEM001] gotcha', '- text: shadowed orphan', '- confidence: 0.9', '- hits: 9', '',
    ].join('\n'));
    const conflicting = path.join(tmp, '.gsd', 'memory', 'T03.md');
    const row = v2Row('exposure', 'x1');
    fs.writeFileSync(conflicting, `---\n${memory.serializeFrontmatter({
      unit_id: 'T03', facts: [memFact('MEM001', 'gotcha', 'tampered fragment')],
      stats: [row, { ...row, source_unit: 'execute-task/T99' }],
    })}\n---\n`);

    const state = projection.projectMemoryState(tmp, { nowMs: NOW0 });
    nodeAssert.deepStrictEqual(state.entries.map(entry => entry.identity).sort(), ['T01/MEM001', 'legacy-orphan/MEM777']);
    const orphan = state.entries.find(entry => entry.identity === 'legacy-orphan/MEM777');
    assert(orphan.hits === 2 && orphan.evidence.origin === 'legacy_orphan', 'orphan keeps its historical hits');
    nodeAssert.deepStrictEqual(orphan.evidence.legacy_ambiguous, { label: 'legacy_ambiguous', seed_hits: 2, hit: 0, confirm: 0, promote: 0 });
    assert(orphan.evidence.counters.independent_confirmation.count === 0);
    nodeAssert.deepStrictEqual(state.diagnostics.rejected.map(item => [item.mem_id, item.reason]), [['MEM999', 'unknown-target']]);
    nodeAssert.deepStrictEqual(state.diagnostics.ignored.map(item => [item.mem_id, item.reason]), [['MEM404', 'unknown-target']]);
    nodeAssert.deepStrictEqual(state.diagnostics.skipped_fragments, [{ storage_key: 'T03', reason: 'event-id-conflict' }]);
    const query = projection.queryMemoryEntries(tmp, { query: '', nowMs: NOW0 });
    nodeAssert.deepStrictEqual(query.evidence_diagnostics, { rejected: 1, ignored: 1, replayed: 0, duplicates: 0, skipped_fragments: 1 });
  } finally { rmrf(tmp); }
});

test('parse/serialize/replay cycle preserves projected state and origin', () => {
  const source = mkTmp();
  const copy = mkTmp();
  try {
    publishLegacyFixture(source);
    memory.writeFragment(source, { unit_id: 'T01', facts: [], stats: [...NON_REINFORCING, v2Row('confirm', 'c1', { mem_id: 'MEM002' })] });
    for (const entry of memory.listFragments(source)) {
      const parsed = memory.parseFragment(memory.readFragmentText(source, entry));
      const { body, ...fragment } = parsed;
      const dir = path.join(copy, '.gsd', 'memory');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(entry.path)), `---\n${memory.serializeFrontmatter(fragment)}\n---\n`);
      assert(memory.writeFragment(source, fragment).created === false, `${entry.storageKey}: replaying parsed rows is a no-op`);
    }
    const original = projection.projectMemoryState(source, { nowMs: NOW0 });
    const replayed = projection.projectMemoryState(copy, { nowMs: NOW0 });
    nodeAssert.deepStrictEqual(replayed.entries, original.entries);
    nodeAssert.deepStrictEqual(replayed.diagnostics, original.diagnostics);
    const confirm = memory.readFragment(copy, 'T01').stats.find(row => row.local_event_id === 'c1');
    nodeAssert.deepStrictEqual([confirm.evidence_version, confirm.extraction_id, confirm.source_fingerprint, confirm.observation_id],
      ['2', 'extract-2', 'sha256:other', 'obs-c1']);
  } finally { rmrf(source); rmrf(copy); }
});

test('rendered memory labels counters and version without calling hits utility', () => {
  const tmp = mkTmp();
  try {
    publishLegacyFixture(tmp);
    memory.writeFragment(tmp, { unit_id: 'T01', facts: [], stats: NON_REINFORCING });
    const rendered = projection.renderMemory(tmp);
    assert(rendered.includes('> hits = legacy ranking counter'), 'header explains hits');
    assert(rendered.includes('not a utility measure'), 'header refuses the utility reading of hits');
    const lines = rendered.split(/\r\n|\n|\r/);
    const line = lines.find(text => text.includes('mem_id:MEM004') && text.includes('category:convention'));
    assert(line && line.includes('hits:0 evidence:v2 hits_basis:legacy_ranking exposure:3 reobserve:2 independent_confirmations:0 utility:1'),
      `MEM004 comment carries the counters: ${line}`);
    for (const comment of lines.filter(text => text.startsWith('<!-- gsd-auto-memory '))) {
      assert((comment.match(/hits:/g) || []).length === 1, `one legacy hits token per comment: ${comment}`);
    }
    const migrateRe = /<!--\s*gsd-auto-memory\s+mem_id:(\S+)\s+category:(\S+)\s+confidence:[\d.]+\s+hits:(\d+)/g;
    assert([...rendered.matchAll(migrateRe)].length === 5, 'forge-migrate canonical reader still parses every entry');
  } finally { rmrf(tmp); }
});

test('projection receipts go stale when the renderer, the reducer helper or the contract changes', () => {
  const tmp = mkTmp();
  try {
    publishLegacyFixture(tmp);
    const staleness = () => { const result = projection.isStale(tmp); return [result.ledger, result.decisions, result.memory]; };
    projection.writeAll(tmp, { force: true });
    nodeAssert.deepStrictEqual(staleness(), [false, false, false]);
    const receiptPath = path.join(tmp, projection._private.PROJECTION_STATE);
    const current = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const withVersion = version => {
      const receipt = JSON.parse(JSON.stringify(current));
      receipt.version = version;
      for (const store of Object.values(receipt.stores)) store.version = version;
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    };
    const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const projectionBytes = fs.readFileSync(path.join(__dirname, 'forge-projection.js'));
    const reducerBytes = fs.readFileSync(path.join(__dirname, 'forge-memory-evidence.js'));
    const { rendererVersion, PROJECTION_CONTRACT } = projection._private;
    assert(rendererVersion({ contract: PROJECTION_CONTRACT, projection: projectionBytes, reducer: reducerBytes }) === projection.RENDERER_VERSION,
      'the published version is the recomputable pairing of renderer, reducer and contract');
    const helperOnly = rendererVersion({ contract: PROJECTION_CONTRACT, projection: projectionBytes,
      reducer: Buffer.concat([reducerBytes, Buffer.from('\n// helper-only change\n')]) });
    const contractOnly = rendererVersion({ contract: `${PROJECTION_CONTRACT}-next`, projection: projectionBytes, reducer: reducerBytes });
    for (const [label, version] of [['file-only legacy receipt', sha256(projectionBytes)], ['helper-only change', helperOnly], ['contract-only change', contractOnly]]) {
      assert(version !== projection.RENDERER_VERSION, `${label} must be a different version`);
      withVersion(version);
      nodeAssert.deepStrictEqual(staleness(), [true, true, true], `${label} invalidates every receipt`);
    }
    projection.writeAll(tmp, { force: true });
    assert(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).version === projection.RENDERER_VERSION);
    nodeAssert.deepStrictEqual(staleness(), [false, false, false], 'a fresh render restores freshness');
  } finally { rmrf(tmp); }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f.name} — ${f.error}`);
  process.exit(1);
}
