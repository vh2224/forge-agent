#!/usr/bin/env node
// forge-maintenance.test.js — regression suite for the deterministic bucket
// merge engine (S01 of M-20260706152250-maintenance-fragment).
//
// Proves: byte-identity across input orders, hash reproducibility, dry-run
// no-write, re-merge idempotency, mtime immunity, and BOM/CRLF normalization.
//
// Run: node scripts/forge-maintenance.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const crypto        = require('crypto');
const { spawnSync } = require('child_process');

const {
  mergeBucket,
  normalizeText,
  sortKey,
  parseBucket,
  bucketHash,
} = require('./forge-maintenance');

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

// ── Fixtures ──────────────────────────────────────────────────────────────────
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-maintenance-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// seedFrag(dir, id, { title, completedAt, body, bom, crlf }) → absolute fragment path
function seedFrag(dir, id, opts) {
  opts = opts || {};
  const fmLines = ['---'];
  if (opts.title) fmLines.push(`title: ${opts.title}`);
  if (opts.completedAt) fmLines.push(`completed_at: ${opts.completedAt}`);
  fmLines.push('---');
  const body = opts.body != null ? opts.body : `Body for ${id}.`;
  let content = fmLines.join('\n') + '\n' + body + '\n';

  if (opts.crlf) content = content.replace(/\n/g, '\r\n');
  if (opts.bom) content = '﻿' + content;

  const p = path.join(dir, `${id}.md`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== forge-maintenance — regression suite ===\n');

const MAIN_JS = path.join(__dirname, 'forge-maintenance.js');

// ── sortKey unit ──────────────────────────────────────────────────────────────
console.log('sortKey — total order construction');

test('timestamp id ignores writtenAt', () => {
  const k1 = sortKey('M-20260101120000-alpha', '2099-01-01T00:00:00Z');
  const k2 = sortKey('M-20260101120000-alpha', null);
  assert(k1 === k2, `expected same key regardless of writtenAt, got ${k1} vs ${k2}`);
  assert(k1 === '20260101120000|M-20260101120000-alpha', `unexpected key: ${k1}`);
});

test('legacy id uses completed_at normalized to 14 digits', () => {
  const k = sortKey('M001', '2025-06-15T10:00:00Z');
  assert(k === '20250615100000|M001', `unexpected key: ${k}`);
});

test('legacy id with no date falls back to 00000000000000', () => {
  const k = sortKey('TASK-002', null);
  assert(k === '00000000000000|TASK-002', `unexpected key: ${k}`);
});

test('dashed timestamp form yields same ts14 as compact form', () => {
  const k1 = sortKey('M-20260101-120000-x', null);
  const k2 = sortKey('M-20260101120000-x', null);
  // classify() only recognizes [MT]-\d{14} directly as 'timestamp'; the dashed
  // form 8+6 digits is handled by the secondary regex branch in sortKey.
  assert(k1.startsWith('20260101120000|'), `expected ts14 20260101120000, got ${k1}`);
  assert(k1.split('|')[0] === k2.split('|')[0], `expected matching ts14: ${k1} vs ${k2}`);
});

// ── normalizeText ─────────────────────────────────────────────────────────────
console.log('\nnormalizeText — D2 normalization');

test('strips leading BOM', () => {
  assert(normalizeText('﻿abc\n') === 'abc\n');
});

test('CRLF to LF', () => {
  assert(normalizeText('abc\r\ndef\r\n') === 'abc\ndef\n');
});

test('isolated CR to LF', () => {
  assert(normalizeText('abc\rdef') === 'abc\ndef\n');
});

test('bare content gets single trailing newline', () => {
  assert(normalizeText('abc') === 'abc\n');
});

test('collapses multiple trailing newlines to one', () => {
  assert(normalizeText('abc\n\n\n') === 'abc\n');
});

test('empty input becomes single newline', () => {
  assert(normalizeText('') === '\n');
});

// ── Byte-identity oracle ──────────────────────────────────────────────────────
console.log('\nmergeBucket — byte-identity across input order');

test('two input orders produce identical content and hash', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const forward = [pAlpha, pBeta, pM001, pTask2];
    const reverse = [pTask2, pM001, pBeta, pAlpha];

    const r1 = mergeBucket(forward, { type: 'test' });
    const r2 = mergeBucket(reverse, { type: 'test' });

    assert(r1.content === r2.content, 'content differs between input orders');
    assert(r1.hash === r2.hash, 'hash differs between input orders');

    const independentHash = crypto.createHash('sha256').update(r1.content, 'utf8').digest('hex');
    assert(r1.hash === independentHash, 'hash does not match independently recomputed sha256');
  } finally {
    rmrf(tmp);
  }
});

test('cross-encoding fragment (LF-clean vs BOM+CRLF) produces byte-identical bucket', () => {
  const tmpA = mkTmp();
  const tmpB = mkTmp();
  try {
    const pClean = seedFrag(tmpA, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pDirty = seedFrag(tmpB, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.', bom: true, crlf: true });

    const rClean = mergeBucket([pClean], { type: 'test' });
    const rDirty = mergeBucket([pDirty], { type: 'test' });

    assert(rClean.content === rDirty.content, 'content differs between LF-clean and BOM+CRLF fragment');
    assert(rClean.hash === rDirty.hash, 'hash differs between LF-clean and BOM+CRLF fragment');
  } finally {
    rmrf(tmpA);
    rmrf(tmpB);
  }
});

test('output order: fallback-no-date first, then legacy by completed_at, then timestamp ids ascending', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const r = mergeBucket([pAlpha, pBeta, pM001, pTask2], { type: 'test' });
    const order = r.content.split('\n')
      .map(l => l.match(/^##\s+(\S+)/))
      .filter(Boolean)
      .map(m => m[1]);

    assert(order.length === 4, `expected 4 headers, got ${order.length}`);
    assert(order[0] === 'TASK-002', `expected TASK-002 first (no-date fallback), got ${order[0]}`);
    assert(order[1] === 'M001', `expected M001 second (completed 2025), got ${order[1]}`);
    assert(order[2] === 'M-20260101120000-alpha', `expected alpha third, got ${order[2]}`);
    assert(order[3] === 'T-20260301090000-beta', `expected beta fourth, got ${order[3]}`);
  } finally {
    rmrf(tmp);
  }
});

// ── mtime immunity ────────────────────────────────────────────────────────────
console.log('\nmergeBucket — mtime immunity');

test('perturbing mtimes of all fragments does not change bucket bytes', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const paths = [pAlpha, pBeta, pM001, pTask2];
    const before = mergeBucket(paths, { type: 'test' });

    for (const p of paths) {
      const randomDate = new Date(Date.now() - Math.floor(Math.random() * 1e10));
      fs.utimesSync(p, randomDate, randomDate);
    }

    const after = mergeBucket(paths, { type: 'test' });
    assert(before.content === after.content, 'content changed after mtime perturbation');
    assert(before.hash === after.hash, 'hash changed after mtime perturbation');
  } finally {
    rmrf(tmp);
  }
});

// ── Idempotency ───────────────────────────────────────────────────────────────
console.log('\nmergeBucket — re-merge idempotency');

test('re-merge over existing bucket is byte-identical, no duplicate units', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const paths = [pAlpha, pBeta, pM001, pTask2];
    const first = mergeBucket(paths, { type: 'test' });

    const second = mergeBucket(paths, { type: 'test', existing: first.content });

    assert(second.content === first.content, 're-merge over existing bucket is not byte-identical');
    assert(second.units.length === 4, `expected 4 units, got ${second.units.length}`);
    const uniqueIds = new Set(second.units);
    assert(uniqueIds.size === 4, `expected no duplicate unit ids, got ${second.units.join(', ')}`);
    assert(second.skipped.length === 4, `expected all 4 input fragments in skipped, got ${second.skipped.length}`);
  } finally {
    rmrf(tmp);
  }
});

test('incremental merge: existing has 2 units, input adds 2 more, union is ordered and re-merge is idempotent', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const partial = mergeBucket([pM001, pTask2], { type: 'test' });
    const full = mergeBucket([pAlpha, pBeta], { type: 'test', existing: partial.content });

    assert(full.units.length === 4, `expected union of 4 units, got ${full.units.length}`);

    const rebuiltFromScratch = mergeBucket([pAlpha, pBeta, pM001, pTask2], { type: 'test' });
    assert(full.content === rebuiltFromScratch.content, 'incremental union differs from full merge from scratch');

    const reMerged = mergeBucket([pAlpha, pBeta, pM001, pTask2], { type: 'test', existing: full.content });
    assert(reMerged.content === full.content, 're-merge of the incremental union is not byte-identical');
  } finally {
    rmrf(tmp);
  }
});

// ── parseBucket round-trip ────────────────────────────────────────────────────
console.log('\nparseBucket — round-trip');

test('parseBucket returns 4 units with correct ids and content matching normalizeText of source', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const pM001  = seedFrag(tmp, 'M001', { title: 'Legacy M001', completedAt: '2025-06-15T10:00:00Z', body: 'M001 body.' });
    const pTask2 = seedFrag(tmp, 'TASK-002', { title: 'Task without date', body: 'Task-002 body.' });

    const paths = [pAlpha, pBeta, pM001, pTask2];
    const built = mergeBucket(paths, { type: 'test' });
    const parsed = parseBucket(built.content);

    assert(parsed.type === 'test', `expected type 'test', got ${parsed.type}`);
    assert(parsed.units.length === 4, `expected 4 parsed units, got ${parsed.units.length}`);

    const byId = new Map(parsed.units.map(u => [u.id, u]));
    for (const p of paths) {
      const id = path.basename(p, '.md');
      const raw = fs.readFileSync(p, 'utf8');
      const expected = normalizeText(raw);
      assert(byId.has(id), `parsed units missing id ${id}`);
      assert(byId.get(id).content === expected, `parsed content for ${id} does not match normalizeText(source)`);
    }
  } finally {
    rmrf(tmp);
  }
});

test('parseBucket throws on invalid header line', () => {
  let threw = false;
  try {
    parseBucket('not a valid bucket header\ncontent\n');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'expected parseBucket to throw on invalid header');
});

// ── CLI ────────────────────────────────────────────────────────────────────────
console.log('\nCLI — dry-run, real merge, idempotency, error paths');

test('CLI --dry-run writes nothing and reports the same hash as the library', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });

    const libResult = mergeBucket([pAlpha, pBeta], { type: 'test' });

    const before = fs.readdirSync(tmp).sort();
    const outPath = path.join(tmp, 'bucket.md');

    const res = spawnSync(process.execPath, [
      MAIN_JS, '--merge', '--dry-run', '--out', outPath, '--type', 'test', pAlpha, pBeta,
    ], { encoding: 'utf8' });

    assert(res.status === 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert(json.dryRun === true, 'expected dryRun:true in CLI output');
    assert(json.hash === libResult.hash, `expected CLI hash ${libResult.hash}, got ${json.hash}`);
    assert(!fs.existsSync(outPath), 'bucket.md should not exist after --dry-run');

    const after = fs.readdirSync(tmp).sort();
    assert(JSON.stringify(before) === JSON.stringify(after), 'directory snapshot changed after --dry-run');
  } finally {
    rmrf(tmp);
  }
});

test('CLI real merge writes matching bytes, second run is idempotent (created:false)', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const pBeta  = seedFrag(tmp, 'T-20260301090000-beta', { title: 'Beta', body: 'Beta body.' });
    const outPath = path.join(tmp, 'bucket.md');

    const libResult = mergeBucket([pAlpha, pBeta], { type: 'test' });

    const res1 = spawnSync(process.execPath, [
      MAIN_JS, '--merge', '--out', outPath, '--type', 'test', pAlpha, pBeta,
    ], { encoding: 'utf8' });
    assert(res1.status === 0, `expected exit 0 on first run, got ${res1.status}. stderr: ${res1.stderr}`);
    assert(fs.existsSync(outPath), 'bucket.md should exist after real merge');
    const bytes1 = fs.readFileSync(outPath, 'utf8');
    assert(bytes1 === libResult.content, 'bucket.md bytes do not match library mergeBucket content');

    const res2 = spawnSync(process.execPath, [
      MAIN_JS, '--merge', '--out', outPath, '--type', 'test', pAlpha, pBeta,
    ], { encoding: 'utf8' });
    assert(res2.status === 0, `expected exit 0 on second run, got ${res2.status}. stderr: ${res2.stderr}`);
    const json2 = JSON.parse(res2.stdout);
    assert(json2.created === false, `expected created:false on idempotent re-run, got ${JSON.stringify(json2)}`);
    const bytes2 = fs.readFileSync(outPath, 'utf8');
    assert(bytes2 === bytes1, 'bucket.md bytes changed after idempotent re-run');

    const hashRes = spawnSync(process.execPath, [MAIN_JS, '--hash', outPath], { encoding: 'utf8' });
    assert(hashRes.status === 0, `expected exit 0 for --hash, got ${hashRes.status}`);
    const hashJson = JSON.parse(hashRes.stdout);
    assert(hashJson.hash === libResult.hash, `expected --hash to report ${libResult.hash}, got ${hashJson.hash}`);
  } finally {
    rmrf(tmp);
  }
});

test('CLI --merge without --out exits 2', () => {
  const tmp = mkTmp();
  try {
    const pAlpha = seedFrag(tmp, 'M-20260101120000-alpha', { title: 'Alpha', body: 'Alpha body.' });
    const res = spawnSync(process.execPath, [MAIN_JS, '--merge', pAlpha], { encoding: 'utf8' });
    assert(res.status === 2, `expected exit 2, got ${res.status}`);
  } finally {
    rmrf(tmp);
  }
});

test('CLI --merge with nonexistent fragment exits 1', () => {
  const tmp = mkTmp();
  try {
    const outPath = path.join(tmp, 'bucket.md');
    const res = spawnSync(process.execPath, [
      MAIN_JS, '--merge', '--out', outPath, path.join(tmp, 'does-not-exist.md'),
    ], { encoding: 'utf8' });
    assert(res.status === 1, `expected exit 1, got ${res.status}`);
  } finally {
    rmrf(tmp);
  }
});

// ── Noisy error ────────────────────────────────────────────────────────────────
console.log('\nmergeBucket — duplicate id error');

test('two input paths with same basename id throws', () => {
  const tmpA = mkTmp();
  const tmpB = mkTmp();
  try {
    const pA = seedFrag(tmpA, 'M-20260101120000-alpha', { title: 'Alpha', body: 'A' });
    const pB = seedFrag(tmpB, 'M-20260101120000-alpha', { title: 'Alpha dup', body: 'B' });

    let threw = false;
    try {
      mergeBucket([pA, pB], { type: 'test' });
    } catch (e) {
      threw = true;
      assert(/duplicate/i.test(e.message), `expected duplicate-id error message, got: ${e.message}`);
    }
    assert(threw, 'expected mergeBucket to throw on duplicate input ids');
  } finally {
    rmrf(tmpA);
    rmrf(tmpB);
  }
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
