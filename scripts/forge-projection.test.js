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

const projection = require('./forge-projection');
const dashboard  = require('./forge-dashboard');
const memory     = require('./forge-memory');

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f.name} — ${f.error}`);
  process.exit(1);
}
