'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFragment } = require('./forge-memory');
const {
  measureGreen,
  runCli,
  DEFAULT_ALLOWED_RELPATH,
  missKey,
  enumerateMisses,
  collectLiveMemIds,
  resolveAllowedMisses,
  compareMisses,
  computeUnitAxisCriterion,
  computeSubjectReportCriterion,
} = require('./forge-index-green');
const { DETECTOR_VERSION } = require('./forge-index-f2');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function fact(mem_id, text) {
  return { mem_id, category: 'test', text, created_at: '2026-01-01T00:00:00Z', source_unit: 'T01' };
}

// A fact whose text carries a REAL detector signal the extractor cannot cite:
// `~/...` paths are blocked by the extractor's bare-path lookbehind (#107),
// so this always lands in the `missed` bucket — a genuine miss, not the
// EMPTY-DENOMINATOR shortcut the old suite leaned on.
// Uma miss que é miss POR DESIGN, não por acidente. Este helper embrulhava o
// nome em `~/.claude/...`, e a #107 fechou exatamente essa lacuna — a premissa
// do fixture morreu junto com o conserto, e a suíte acusou. `.rst` está no
// REAL_FILE_EXT do detector e deliberadamente FORA do CODE_EXT do extrator
// (alargá-lo para sufixo arbitrário foi medido em 311 -> 972 citações
// fantasma), então esta forma segue sendo miss de propósito e o fixture não
// pode ser invalidado por uma melhora futura de recall.
function missFactText(basename) {
  return `Veja ${basename} para detalhes`;
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idxgreen-'));
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'covered.js'), 'module.exports = 1;');
  return cwd;
}

function allowedPathFor(cwd) {
  return path.join(cwd, DEFAULT_ALLOWED_RELPATH);
}

function writeAllowed(cwd, entries) {
  const target = allowedPathFor(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = typeof entries === 'string' ? entries : JSON.stringify({ allowed: entries }, null, 2);
  fs.writeFileSync(target, body);
}

function entry(mem_id, mention, overrides) {
  return { mem_id, mention, item: '#TEST', reason: 'entrada de teste', ...(overrides || {}) };
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

function snapshotTree(root) {
  const result = [];
  function walk(dir) {
    for (const entryItem of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entryItem.name);
      const stat = fs.statSync(target);
      result.push({ path: path.relative(root, target), size: stat.size, mtime: stat.mtimeMs, isDirectory: entryItem.isDirectory() });
      if (entryItem.isDirectory()) walk(target);
    }
  }
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// ── Section 1: fully green store ────────────────────────────────────────────
console.log('\nSection 1: fully green store — all three criteria pass\n');

test('a store with only covered facts and an empty allow-list is green:true with criteria[] all ok', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, true, 'expected green:true for a fully covered store with empty list');
    assert.strictEqual(report.reasons.length, 0, 'green:true must carry zero reasons');
    assert.strictEqual(report.criteria.length, 3, 'exactly three D-2 criteria');
    for (const c of report.criteria) {
      assert.strictEqual(c.ok, true, `criterion ${c.name} must be ok on a fully green store`);
      assert.ok('measured' in c && 'required' in c, `criterion ${c.name} must carry measured+required even when ok`);
    }
    assert.strictEqual(typeof report.f2_recall, 'number');
    assert.strictEqual(typeof report.measured_at, 'string');
  } finally { cleanup(cwd); }
});

// ── Section 2: the criterion is the LIST, not the percentage ────────────────
console.log('\nSection 2: allowed-misses list replaces the f2_recall threshold as the criterion\n');

test('an unlisted miss fails green, and reasons[] names the exact key', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))],
    });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(report.reasons.includes('unlisted-miss:f-miss::prefs-x.rst'), `expected the miss named by key in ${JSON.stringify(report.reasons)}`);
    const criterion = report.criteria.find((c) => c.name === 'allowed_misses');
    assert.strictEqual(criterion.ok, false);
    assert.deepStrictEqual(report.allowed_misses.new, ['f-miss::prefs-x.rst']);
  } finally { cleanup(cwd); }
});

test('a listed miss is green even with f2_recall below the old 0.99 threshold — the percentage no longer gates', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))],
    });
    writeAllowed(cwd, [entry('f-miss', 'prefs-x.rst')]);
    const report = measureGreen(cwd);
    // 1 miss over a denominator of 2 → recall 0.5, far below the old bar.
    // Reverting to the percentage criterion makes this assertion fail — that
    // is the bite proving the criterion moved to the enumerated list.
    assert.ok(typeof report.f2_recall === 'number' && report.f2_recall < 0.99, `recall must be below the old bar (got ${report.f2_recall})`);
    assert.strictEqual(report.green, true, 'a fully enumerated miss set must be green regardless of recall');
    assert.deepStrictEqual(report.allowed_misses.known, ['f-miss::prefs-x.rst']);
  } finally { cleanup(cwd); }
});

test('f2_recall stays REPORTED at the top level but is no longer a criterion', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(typeof report.f2_recall, 'number', 'f2_recall must remain in the report — it is the comparable time series');
    assert.ok(!report.criteria.some((c) => c.name === 'f2_recall'), 'no criterion may be named f2_recall anymore');
    const criterion = report.criteria.find((c) => c.name === 'allowed_misses');
    assert.ok(criterion, 'the list criterion must exist under the name allowed_misses');
  } finally { cleanup(cwd); }
});

// ── Section 3: two-way — a cured entry left listed is red ───────────────────
console.log('\nSection 3: an entry whose mention stopped failing turns the gate red — remova da lista\n');

test('a stale entry (fact alive, mention no longer missing) fails green with a named stale reason and the removal instruction', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    // f-covered exists (not a ghost) but 'prefs-x.rst' is not among its misses.
    writeAllowed(cwd, [entry('f-covered', 'prefs-x.rst')]);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false, 'an allow-list that only ever grows is an inert gate — a cured entry must turn the gate red');
    assert.ok(report.reasons.includes('stale-allowed-entry:f-covered::prefs-x.rst'), `expected stale entry named in ${JSON.stringify(report.reasons)}`);
    assert.deepStrictEqual(report.allowed_misses.stale, ['f-covered::prefs-x.rst']);
    assert.ok(String(report.allowed_misses.stale_action).includes('remova da lista'), 'the report must instruct removal explicitly');
  } finally { cleanup(cwd); }
});

// ── Section 4: ghost entries — the fact is gone entirely ────────────────────
console.log('\nSection 4: an entry pointing at a mem_id that no longer exists is a ghost, not merely stale\n');

test('a ghost entry fails green with ghost-allowed-entry, distinct from stale', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, [entry('MEM-GONE', 'x.md')]);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(report.reasons.includes('ghost-allowed-entry:MEM-GONE::x.md'), `expected ghost named in ${JSON.stringify(report.reasons)}`);
    assert.ok(!report.reasons.includes('stale-allowed-entry:MEM-GONE::x.md'), 'a ghost must never double-report as stale — the distinction is the point');
    assert.deepStrictEqual(report.allowed_misses.ghost, ['MEM-GONE::x.md']);
    assert.deepStrictEqual(report.allowed_misses.stale, []);
  } finally { cleanup(cwd); }
});

test('compareMisses: ghost classification wins over stale for the same entry (isolated)', () => {
  const verdict = compareMisses({
    factsEvaluated: 1,
    misses: [],
    allowedEntries: [{ mem_id: 'GONE', mention: 'a.md', key: missKey('GONE', 'a.md') }],
    liveMemIds: new Set(['ALIVE']),
  });
  assert.strictEqual(verdict.ok, false);
  assert.deepStrictEqual(verdict.ghostEntries, ['GONE::a.md']);
  assert.deepStrictEqual(verdict.staleEntries, [], 'a ghost entry must not also appear stale');
});

// ── Section 5: anti-silence floor — zero facts is never a clean pass ────────
console.log('\nSection 5: zero facts evaluated is a named failure, never green\n');

test('an empty store with an empty allow-list is green:false with no-facts-evaluated', () => {
  const cwd = fixture();
  try {
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false, 'both sets empty over zero facts must NOT pass — não medi nada é indistinguível de medi e está limpo');
    assert.ok(report.reasons.includes('no-facts-evaluated'), `expected no-facts-evaluated in ${JSON.stringify(report.reasons)}`);
    // The other criteria still report honestly on the empty store.
    assert.strictEqual(report.subject_report_present, true, 'an empty store is honestly reported present with zero subjects, not absent');
  } finally { cleanup(cwd); }
});

test('compareMisses: executedCount floor is a distinct named code, even with both sets empty (isolated)', () => {
  const verdict = compareMisses({ factsEvaluated: 0, misses: [], allowedEntries: [], liveMemIds: new Set() });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'no-facts-evaluated');
});

test('the floor beats default-absent: empty store with NO list file is still red no-facts-evaluated', () => {
  const cwd = fixture();
  try {
    // No fragments, no allowed-misses.json: the empty-list semantics of a
    // missing default must never combine with zero facts into a clean pass.
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(report.reasons.includes('no-facts-evaluated'), `expected no-facts-evaluated in ${JSON.stringify(report.reasons)}`);
    assert.strictEqual(report.allowed_misses.source, 'default-absent');
  } finally { cleanup(cwd); }
});

// ── Section 6: list origin semantics — default-absent vs file vs refusals ───
console.log('\nSection 6: default absent = empty list with named origin; explicit absent, unreadable or invalid REFUSES\n');

test('default path absent + zero misses → green, with the origin named default-absent (never silent)', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    // No allowed-misses.json written on purpose: absence at the DEFAULT path
    // means "this workspace never accepted any miss" — an empty list, which
    // is already fail-closed. Refusing here would break every workspace that
    // is not this repo (measured: forge-sweep-delete.test.js fixtures).
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, true, 'a covered store with no default list must be green — empty list semantics');
    assert.strictEqual(report.allowed_misses.source, 'default-absent', 'the origin must be named, never silent');
  } finally { cleanup(cwd); }
});

test('default path absent + one miss → red unlisted-miss — absence never loosens the gate', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))] });
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false, 'an empty list is fail-closed: any miss is unlisted');
    assert.ok(report.reasons.includes('unlisted-miss:f-miss::prefs-x.rst'), `expected the miss named in ${JSON.stringify(report.reasons)}`);
    assert.strictEqual(report.allowed_misses.source, 'default-absent');
  } finally { cleanup(cwd); }
});

test('an EXPLICIT allowedPath pointing at an absent file still refuses with allowed-misses-file-missing', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    const asked = path.join(cwd, 'no-such-list.json');
    // Asking for a specific file that does not exist is a misconfiguration —
    // the run-tests.js --baseline contract, unchanged by the default-absent
    // semantics.
    const report = measureGreen(cwd, { allowedPath: asked });
    assert.strictEqual(report.green, false, 'an explicitly requested file must exist');
    assert.ok(report.reasons.includes('allowed-misses-file-missing'), `expected allowed-misses-file-missing in ${JSON.stringify(report.reasons)}`);
    assert.ok(report.allowed_misses.errors.some((e) => e.includes(asked)), 'the refusal must name the path it was asked for');
  } finally { cleanup(cwd); }
});

test('a PRESENT file with an empty list → green with source "file", distinct from default-absent', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, true);
    assert.strictEqual(report.allowed_misses.source, 'file', 'an empty list DECLARED in a file must be distinguishable from no file at all');
  } finally { cleanup(cwd); }
});

test('an unreadable allow-list (path is a directory — the SCHEMA-VERSION precedent) refuses with its own named reason', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    fs.mkdirSync(allowedPathFor(cwd), { recursive: true });
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(report.reasons.includes('allowed-misses-file-unreadable'), `expected allowed-misses-file-unreadable in ${JSON.stringify(report.reasons)}`);
  } finally { cleanup(cwd); }
});

test('an invalid-JSON allow-list refuses with allowed-misses-invalid — in BOTH modes (readable garbage is always a refusal)', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, '{ not json');
    const viaDefault = measureGreen(cwd);
    assert.strictEqual(viaDefault.green, false);
    assert.ok(viaDefault.reasons.includes('allowed-misses-invalid'), `expected allowed-misses-invalid in ${JSON.stringify(viaDefault.reasons)}`);
    const viaExplicit = measureGreen(cwd, { allowedPath: allowedPathFor(cwd) });
    assert.strictEqual(viaExplicit.green, false);
    assert.ok(viaExplicit.reasons.includes('allowed-misses-invalid'), 'explicit mode must refuse garbage identically');
  } finally { cleanup(cwd); }
});

test('an entry without an owner (item) is invalid and the error names the entry — ownerless red is scenery', () => {
  const resolved = resolveAllowedMisses(JSON.stringify({ allowed: [{ mem_id: 'M1', mention: 'a.md', reason: 'sem dono' }] }));
  assert.strictEqual(resolved.ok, false);
  assert.ok(resolved.errors.some((e) => e.includes('M1::a.md') && e.includes('item')), `error must name key and missing owner field: ${JSON.stringify(resolved.errors)}`);
});

test('resolveAllowedMisses: validation is enumerated — duplicates, missing reason, unknown keys, non-array (isolated)', () => {
  const dup = resolveAllowedMisses(JSON.stringify({ allowed: [
    { mem_id: 'M1', mention: 'a.md', item: '#1', reason: 'x' },
    { mem_id: 'M1', mention: 'a.md', item: '#1', reason: 'x' },
  ] }));
  assert.strictEqual(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes('duas vezes')));

  const noReason = resolveAllowedMisses(JSON.stringify({ allowed: [{ mem_id: 'M1', mention: 'a.md', item: '#1' }] }));
  assert.strictEqual(noReason.ok, false);
  assert.ok(noReason.errors.some((e) => e.includes('reason')));

  const unknownKey = resolveAllowedMisses(JSON.stringify({ allowed: [], extra: true }));
  assert.strictEqual(unknownKey.ok, false);
  assert.ok(unknownKey.errors.some((e) => e.includes('extra')));

  const notArray = resolveAllowedMisses(JSON.stringify({ allowed: 'nope' }));
  assert.strictEqual(notArray.ok, false);

  const withComment = resolveAllowedMisses(JSON.stringify({ _comment: 'annotation keys are allowed', allowed: [] }));
  assert.strictEqual(withComment.ok, true);
  assert.deepStrictEqual(withComment.entries, []);
});

// ── Section 7: key stability under neighboring writes ───────────────────────
console.log('\nSection 7: a NEW fact in a neighboring fragment never changes the key of an existing miss\n');

test('writing a new fact into a sibling fragment leaves existing miss keys byte-identical', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))],
    });
    writeAllowed(cwd, []);
    const before = measureGreen(cwd);
    assert.deepStrictEqual(before.allowed_misses.new, ['f-miss::prefs-x.rst']);
    // Neighboring write: a brand-new fact in a DIFFERENT fragment. Keys derive
    // from mem_id + the miss's own normalized mention — never from line
    // numbers, read order, or sibling content — so the existing key must not
    // move.
    writeFragment(cwd, { unit_id: 'T02', facts: [fact('f-new', 'novo fato citando `scripts/covered.js` aqui')] });
    const after = measureGreen(cwd);
    assert.deepStrictEqual(after.allowed_misses.new, before.allowed_misses.new, 'existing miss keys must survive neighboring writes unchanged');
  } finally { cleanup(cwd); }
});

test('a green gate with the miss listed stays green after a neighboring write', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))],
    });
    writeAllowed(cwd, [entry('f-miss', 'prefs-x.rst')]);
    assert.strictEqual(measureGreen(cwd).green, true);
    writeFragment(cwd, { unit_id: 'T02', facts: [fact('f-new', 'novo fato citando `scripts/covered.js` aqui')] });
    const after = measureGreen(cwd);
    assert.strictEqual(after.green, true, 'a new well-formed memory must not re-redden a gate whose misses are all enumerated');
  } finally { cleanup(cwd); }
});

// ── Section 8: enumeration/extraction pure helpers ──────────────────────────
console.log('\nSection 8: enumerateMisses and collectLiveMemIds derive from the F2 report, deduplicated\n');

test('enumerateMisses covers missed AND partial buckets, deduplicated by key (isolated)', () => {
  const f2 = {
    facts_missed_total: [{ mem_id: 'M1', missing_mentions: [{ normalized: 'a.md' }, { normalized: 'a.md' }] }],
    facts_missed_partial: [{ mem_id: 'M1', missing_mentions: [{ normalized: 'a.md' }, { normalized: 'b.md' }] }],
  };
  const misses = enumerateMisses(f2);
  assert.deepStrictEqual(misses.map((m) => m.key).sort(), ['M1::a.md', 'M1::b.md']);
});

test('collectLiveMemIds spans all four fact buckets (isolated)', () => {
  const f2 = {
    facts_covered: [{ mem_id: 'A' }],
    facts_missed_total: [{ mem_id: 'B' }],
    facts_missed_partial: [{ mem_id: 'C' }],
    facts_no_mention: [{ mem_id: 'D' }, { mem_id: null }],
  };
  assert.deepStrictEqual([...collectLiveMemIds(f2)].sort(), ['A', 'B', 'C', 'D']);
});

// ── Section 9: unit axis incomplete (fragment lost) ─────────────────────────
console.log('\nSection 9: fragment lost to a read failure → unit_axis fails, never silently\n');

test('an unreadable sibling fragment never yields green:true, and the failure is a named reason', () => {
  const cwd = fixture();
  writeFragment(cwd, { unit_id: 'T01', facts: [fact('mem-ok', '`scripts/covered.js`')] });
  writeFragment(cwd, { unit_id: 'T02', facts: [fact('mem-broken', '`scripts/covered.js`')] });
  writeAllowed(cwd, []);
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').includes('/.gsd/memory/') && /T02/.test(p)) {
      throw new Error('EACCES: simulated unreadable fragment');
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const report = measureGreen(cwd);
    // NOTE: buildFileIndex (used by the unit/subject axes) degrades a per-
    // fragment read failure into coverage.unreadable_fragments, but measureF2
    // (reused unmodified — out of this task's scope) does NOT wrap its
    // per-fragment read loop, so the same failure surfaces here as an
    // uncaught exception that measureGreen's outer try/catch turns into a
    // gate-error. Both paths are honest failures of the same underlying
    // event; the isolated computeUnitAxisCriterion tests below prove the
    // 'unit-axis-incomplete' reason directly, on the axis shape it actually
    // gates on, independent of measureF2's narrower error handling.
    assert.strictEqual(report.green, false, 'a store that lost a fragment cannot be green');
    assert.ok(report.reasons.length >= 1, `green:false must name a reason: ${JSON.stringify(report.reasons)}`);
  } finally {
    fs.readFileSync = realReadFileSync;
    cleanup(cwd);
  }
});

test('computeUnitAxisCriterion: counts matching but a lost fragment still fails (isolated)', () => {
  const axis = {
    coverage: { facts_with_unit: 1, facts_total: 1, facts_not_read: { unreadable_fragments: 1, fragments_skipped_by_store: 0 } },
    fragment_listing_failed: null,
    partial: false,
  };
  const criterion = computeUnitAxisCriterion(axis);
  assert.strictEqual(criterion.ok, false);
  assert.strictEqual(criterion.countsMatch, true);
  assert.strictEqual(criterion.noLostFragments, false);
});

test('computeUnitAxisCriterion: mismatched counts fail even with zero lost fragments (isolated)', () => {
  const axis = {
    coverage: { facts_with_unit: 1, facts_total: 2, facts_not_read: { unreadable_fragments: 0, fragments_skipped_by_store: 0 } },
    fragment_listing_failed: null,
    partial: false,
  };
  const criterion = computeUnitAxisCriterion(axis);
  assert.strictEqual(criterion.ok, false);
  assert.strictEqual(criterion.countsMatch, false);
});

// ── Section 10: subject report absent ───────────────────────────────────────
console.log('\nSection 10: subject report presence — no threshold, presence only\n');

test('computeSubjectReportCriterion: a well-formed axis with coverage.facts_total is present (isolated)', () => {
  const criterion = computeSubjectReportCriterion({ coverage: { facts_total: 0 } });
  assert.strictEqual(criterion.ok, true, 'presence never requires a minimum count — D-2 forbids a subject threshold');
});

test('computeSubjectReportCriterion: a missing/malformed axis is reported absent, never silently true (isolated)', () => {
  assert.strictEqual(computeSubjectReportCriterion(null).ok, false);
  assert.strictEqual(computeSubjectReportCriterion({}).ok, false);
  assert.strictEqual(computeSubjectReportCriterion({ coverage: {} }).ok, false);
});

// ── Section 11: criteria[] is unconditional ─────────────────────────────────
console.log('\nSection 11: criteria[] always carries the three entries, pass or fail\n');

test('criteria[] always has exactly allowed_misses, unit_axis, subject_report_present — in every scenario', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-miss', missFactText('prefs-x.rst'))] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.deepStrictEqual(report.criteria.map((c) => c.name), ['allowed_misses', 'unit_axis', 'subject_report_present']);
    for (const c of report.criteria) assert.ok('ok' in c && 'measured' in c && 'required' in c);
  } finally { cleanup(cwd); }
});

// ── Section 12: green:false always names a reason ───────────────────────────
console.log('\nSection 12: green:false never ships without a named reason\n');

test('every green:false report carries at least one entry in reasons[]', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-miss', missFactText('prefs-x.rst'))] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(Array.isArray(report.reasons) && report.reasons.length >= 1);
  } finally { cleanup(cwd); }
});

// ── Section 13: read-only ───────────────────────────────────────────────────
console.log('\nSection 13: the gate is read-only — no --write path exists, tree is untouched\n');

test('measureGreen never mutates the store tree nor the allow-list file', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const before = snapshotTree(cwd);
    measureGreen(cwd);
    const after = snapshotTree(cwd);
    assert.deepStrictEqual(before, after, 'the filesystem tree must be byte-identical before/after the gate runs');
  } finally { cleanup(cwd); }
});

test('the module never exposes a --write flag on its CLI', () => {
  // S02 R6 (review-fix): escopado ao bloco de parsing do argv (precedente:
  // forge-index-f2.test.js). Sobre o arquivo inteiro, um comentário legítimo
  // que mencionasse `--write` quebraria o teste com o contrato intacto.
  const source = fs.readFileSync(path.join(__dirname, 'forge-index-green.js'), 'utf8');
  const start = source.indexOf('function parseCliArgs');
  const end = source.indexOf('function renderMarkdown');
  assert.ok(start >= 0 && end > start, 'parseCliArgs must precede renderMarkdown — guard anchors moved');
  const argvBlock = source.slice(start, end);
  assert.ok(!/--write/.test(argvBlock), 'forge-index-green.js must never accept --write — this gate is read-only by contract');
});

// ── Section 14: determinism ─────────────────────────────────────────────────
console.log('\nSection 14: determinism — two runs over the same store agree on every field but measured_at\n');

test('two consecutive runs produce identical fields except measured_at', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-miss', missFactText('prefs-x.rst'))] });
    writeAllowed(cwd, [entry('f-miss', 'prefs-x.rst')]);
    const first = measureGreen(cwd);
    const second = measureGreen(cwd);
    const strip = (r) => { const { measured_at, ...rest } = r; return rest; };
    assert.deepStrictEqual(strip(first), strip(second));
  } finally { cleanup(cwd); }
});

// ── Section 15: CLI ─────────────────────────────────────────────────────────
console.log('\nSection 15: CLI — exit 0 always, JSON single line, --allowed honored, invalid arg exits 2\n');

test('CLI --cwd --json exits 0 and prints one JSON document', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 1, 'expected exactly one JSON document on stdout');
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(typeof parsed.green, 'boolean');
    assert.ok(Array.isArray(parsed.criteria));
  } finally { cleanup(cwd); }
});

test('CLI --allowed <file> overrides the default cwd-relative list location', () => {
  const cwd = fixture();
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idxgreen-list-'));
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-miss', missFactText('prefs-x.rst'))] });
    const custom = path.join(listDir, 'my-allowed.json');
    fs.writeFileSync(custom, JSON.stringify({ allowed: [entry('f-miss', 'prefs-x.rst')] }));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd, '--allowed', custom, '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.green, true, 'the custom list must be the one consulted');
    assert.strictEqual(parsed.allowed_misses.path, custom);
  } finally { cleanup(cwd); cleanup(listDir); }
});

test('CLI --allowed pointing at a missing file refuses (exit still 0, reason named in JSON)', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd, '--allowed', path.join(cwd, 'nope.json'), '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.green, false);
    assert.ok(parsed.reasons.includes('allowed-misses-file-missing'));
  } finally { cleanup(cwd); }
});

test('CLI without --json prints markdown that names the criterion and marks f2_recall informational', () => {
  const cwd = fixture();
  try {
    writeAllowed(cwd, []);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('# Gate: índice verde'));
    assert.ok(result.stdout.includes('lista enumerada'), 'markdown must state the criterion is now the enumerated list');
    assert.ok(result.stdout.includes('informativo'), 'markdown must mark f2_recall as informational, not gating');
  } finally { cleanup(cwd); }
});

test('CLI unknown flag exits 2', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
});

test('runCli() exit code is always 0 for a valid, even failing, measurement', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-miss', missFactText('prefs-x.rst'))] });
    writeAllowed(cwd, []);
    const realWrite = process.stdout.write;
    process.stdout.write = () => true;
    let code;
    try { code = runCli(['--cwd', cwd, '--json']); } finally { process.stdout.write = realWrite; }
    assert.strictEqual(code, 0);
  } finally { cleanup(cwd); }
});

// ── Section 16: internal exception still exits 0 with a named reason ────────
console.log('\nSection 16: an internal exception never escapes as a non-zero exit — it becomes gate-error\n');

test('a cwd that does not exist as a real project still yields green:false with a gate-error reason, exit 0', () => {
  const missing = path.join(os.tmpdir(), `idxgreen-missing-${Date.now()}`);
  const realWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  let code;
  try { code = runCli(['--cwd', missing, '--json']); } finally { process.stdout.write = realWrite; }
  assert.strictEqual(code, 0, 'the gate must never fail the process, even on an unusable cwd');
  const parsed = JSON.parse(captured.trim());
  assert.strictEqual(typeof parsed.green, 'boolean');
});

// ── Section 17: the repo's own list stays well-formed and owned ─────────────
console.log('\nSection 17: the versioned allow-list of THIS repo validates and every entry has an owner\n');

test('scripts/fixtures/index-green/allowed-misses.json resolves clean and every entry names an item', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'index-green', 'allowed-misses.json'), 'utf8');
  const resolved = resolveAllowedMisses(text);
  assert.strictEqual(resolved.ok, true, `the repo list must validate: ${JSON.stringify(resolved.errors || [])}`);
  for (const e of resolved.entries) {
    assert.ok(e.item && e.item.trim() !== '', `entry ${e.key} must name an owner`);
  }
  const legacyMd = resolved.entries.filter((entry) => entry.mention === '.md');
  assert.strictEqual(legacyMd.length, 2, 'a migração desta fixture preserva hoje os dois misses legados; rederivações futuras podem mudar o conjunto');
  assert.ok(legacyMd.every((entry) => entry.item === '#126'), 'todo miss .md legado presente deve pertencer à #126');
  assert.ok(legacyMd.every((entry) => /proveniência/.test(entry.reason)), 'a razão deve nomear a lacuna real de proveniência');
});

test('#126 index-green propaga sem inferir a identidade da taxonomia F2', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.detector_version, DETECTOR_VERSION);
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'detector_version'));
  } finally { cleanup(cwd); }
});


// ── Section 18: search order — .gsd first, repo fixture as fallback ─────────
//
// The list is PER-WORKSPACE data (keys are this store's mem_ids), so `.gsd/` is
// its canonical home: consumer projects commit `.gsd/`, which versions the list
// exactly where the misses live. This repo keeps the fixture fallback alive
// because its own `.gsd/` is gitignored dogfood.

console.log('\nSection 18: allow-list search order and its floor\n');

function gsdListPath(cwd) { return path.join(cwd, '.gsd', 'index-green-allowed-misses.json'); }
function writeGsdList(cwd, body) {
  const target = gsdListPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify({ allowed: body }, null, 2));
}

test('the .gsd list WINS over the repo fixture — and the report names which file answered', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    writeAllowed(cwd, []);       // repo-shaped fallback, present
    writeGsdList(cwd, []);       // workspace list, present — must win
    const report = measureGreen(cwd);
    assert.strictEqual(report.allowed_misses.source, 'file');
    assert.strictEqual(report.allowed_misses.path, gsdListPath(cwd),
      'the report must name the file that ANSWERED, not the one we hoped for');
  } finally { cleanup(cwd); }
});

test('with no .gsd list, the repo fixture answers — the fallback is not dead code', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    writeAllowed(cwd, []);
    const report = measureGreen(cwd);
    assert.strictEqual(report.allowed_misses.source, 'file');
    assert.strictEqual(report.allowed_misses.path, allowedPathFor(cwd));
  } finally { cleanup(cwd); }
});

test('neither candidate present → default-absent, and the report ENUMERATES where it looked', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    const report = measureGreen(cwd);
    assert.strictEqual(report.allowed_misses.source, 'default-absent');
    assert.strictEqual(report.allowed_misses.path, null, 'no file answered, so no file is named');
    assert.deepStrictEqual(report.allowed_misses.searched,
      [path.join('.gsd', 'index-green-allowed-misses.json'),
       path.join('scripts', 'fixtures', 'index-green', 'allowed-misses.json')],
      'a search that reports nothing about where it looked is indistinguishable from one that never ran');
  } finally { cleanup(cwd); }
});

test('absence does NOT loosen the gate: default-absent + one miss is still red', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', missFactText('prefs-x.rst'))] });
    const report = measureGreen(cwd);
    assert.strictEqual(report.allowed_misses.source, 'default-absent');
    assert.strictEqual(report.green, false, 'an empty list accepts nothing — every miss is unlisted');
    assert.ok(report.reasons.some((r) => r.startsWith('unlisted-miss:')), report.reasons.join(', '));
  } finally { cleanup(cwd); }
});

test('a BROKEN first candidate refuses naming itself — it never falls through to the second', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    writeAllowed(cwd, []);            // a perfectly good fallback sits behind it...
    writeGsdList(cwd, 'nao-e-json');  // ...and must NOT be reached
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.strictEqual(report.allowed_misses.code, 'allowed-misses-invalid',
      'readable garbage is a refusal wherever it sits — falling through would silently weaken the posture');
    assert.ok(report.reasons.includes('allowed-misses-invalid'), report.reasons.join(', '));
  } finally { cleanup(cwd); }
});

test('an EXPLICIT path still refuses when absent — the search order does not soften --allowed', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'M-20260101000000-x', facts: [fact('MEM001', 'cita `scripts/covered.js`')] });
    writeGsdList(cwd, []);  // a valid workspace list exists — must be IGNORED when a path is asked for
    const report = measureGreen(cwd, { allowedPath: path.join(cwd, 'nao-existe.json') });
    assert.strictEqual(report.green, false);
    assert.strictEqual(report.allowed_misses.code, 'allowed-misses-file-missing');
    assert.strictEqual(report.allowed_misses.source, 'explicit');
  } finally { cleanup(cwd); }
});

console.log(`\n${passed} passed`);
