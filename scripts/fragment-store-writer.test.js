#!/usr/bin/env node
// fragment-store-writer.test.js — S04/T01 proof suite.
//
// Covers:
//   (a) archive read path — renderLedger byte-identical loose vs
//       consolidated-to-.gsd/archive/milestones-rollup.md
//   (b) writeFragment shadow-guard: identical content on a consolidated id
//       → { created: false }, no loose file written
//   (c) writeFragment shadow-guard: divergent content on a consolidated id
//       → throws
//   (d) bucket enumeration memoization: stale until invalidated, fresh after
//       `_invalidateBucketCache` (same-size edit — the case a
//       byte-length-keyed cache alone cannot catch)
//   Mirrors (b)/(c)/(d) for the decisions store.
//
// Exit 0 = all assertions passed. Exit 1 = at least one failure.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('./forge-ledger');
const decisions = require('./forge-decisions');
const { mergeBucket } = require('./forge-maintenance');
const projection = require('./forge-projection');

let allPassed = true;
function assert(label, actual, expected) {
  if (actual === expected) {
    console.log('PASS: ' + label);
  } else {
    console.log('FAIL: ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  got:      ' + JSON.stringify(actual));
    allPassed = false;
  }
}
function assertThrows(label, fn) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  assert(label, threw, true);
}

const tmpBase = path.join(os.tmpdir(), '.gsd-smoke-s04-t01-' + process.pid);

try {
  fs.mkdirSync(path.join(tmpBase, '.gsd', 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, '.gsd', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(tmpBase, '.gsd', 'archive'), { recursive: true });

  // ── (a) Archive read path — lossless projection ─────────────────────────
  const milestoneIds = [
    'M-20260101000001-t01-a',
    'M-20260101000002-t01-b',
    'M-20260101000003-t01-c',
  ];
  const milestoneEntries = milestoneIds.map((id, i) => ({
    id,
    title: `Milestone T01 fixture ${i}`,
    completed_at: `2026-01-0${i + 1}T00:00:00Z`,
    slices: ['S01'],
    key_files: ['scripts/forge-ledger.js'],
    key_decisions: ['fixture decision'],
    body: `Body for ${id}.`,
  }));
  for (const e of milestoneEntries) {
    ledger.writeFragment(tmpBase, e);
  }

  const renderedBefore = projection.renderLedger(tmpBase);
  assert('(a) renderLedger non-empty before consolidation', renderedBefore.length > 0, true);
  for (const id of milestoneIds) {
    assert(`(a) rendered-before contains ${id}`, renderedBefore.includes(id), true);
  }

  const loosePaths = milestoneIds.map(id => ledger.fragmentPath(tmpBase, id));
  const merged = mergeBucket(loosePaths, { type: 'ledger' });
  const archiveRollupPath = path.join(tmpBase, '.gsd', 'archive', 'milestones-rollup.md');
  fs.writeFileSync(archiveRollupPath, merged.content, 'utf8');

  // Delete loose files — units now exist ONLY inside the archive bucket.
  for (const p of loosePaths) fs.unlinkSync(p);

  ledger._invalidateBucketCache(tmpBase);
  const renderedAfter = projection.renderLedger(tmpBase);
  assert('(a) renderLedger byte-identical loose vs archive-consolidated', renderedAfter, renderedBefore);

  // ── (b)/(c) writeFragment shadow-guard on ledger ────────────────────────
  const consolidatedId = milestoneIds[0];
  const consolidatedEntry = milestoneEntries[0];

  const idempotentResult = ledger.writeFragment(tmpBase, consolidatedEntry);
  assert('(b) ledger shadow-guard: identical content → created:false', idempotentResult.created, false);
  assert('(b) ledger shadow-guard: no loose file written', fs.existsSync(ledger.fragmentPath(tmpBase, consolidatedId)), false);

  assertThrows('(c) ledger shadow-guard: divergent content throws', () => {
    ledger.writeFragment(tmpBase, Object.assign({}, consolidatedEntry, { title: 'DIVERGENT TITLE' }));
  });
  assert('(c) ledger shadow-guard: no loose file written after throw', fs.existsSync(ledger.fragmentPath(tmpBase, consolidatedId)), false);

  // ── (d) Ledger memo: stale until invalidated, fresh after invalidate ────
  // Rewrite the archive bucket with a same-BYTE-LENGTH edit (swap two ASCII
  // letters in a title so total size is unchanged) — the case the
  // size-keyed cache alone cannot catch; only the explicit invalidate does.
  const preEditContent = fs.readFileSync(archiveRollupPath, 'utf8');
  assert('(d) pre-edit: fixture title present', preEditContent.includes('fixture 0'), true);
  const editedContent = preEditContent.split('fixture 0').join('fixture X'); // same length, all occurrences
  assert('(d) edit preserves byte length', Buffer.byteLength(editedContent, 'utf8'), Buffer.byteLength(preEditContent, 'utf8'));
  fs.writeFileSync(archiveRollupPath, editedContent, 'utf8');

  const staleRender = projection.renderLedger(tmpBase);
  assert('(d) memo stale before invalidate: still shows old title', staleRender.includes('fixture 0'), true);
  assert('(d) memo stale before invalidate: does not yet show new title', staleRender.includes('fixture X'), false);

  ledger._invalidateBucketCache(tmpBase);
  const freshRender = projection.renderLedger(tmpBase);
  assert('(d) memo fresh after invalidate: shows new title', freshRender.includes('fixture X'), true);
  assert('(d) memo fresh after invalidate: no longer shows old title', freshRender.includes('fixture 0'), false);

  // Restore original content so later assertions in this run are unaffected.
  fs.writeFileSync(archiveRollupPath, preEditContent, 'utf8');
  ledger._invalidateBucketCache(tmpBase);

  // ── Decisions mirror: (b)/(c)/(d) ────────────────────────────────────────
  const decisionUnitId = 'T-20260101000004-t01-decisions';
  const decisionFragment = {
    unit_id: decisionUnitId,
    decisions: [
      { when: '2026-01-04', scope: 'S04', decision: 'Use bucket memo', choice: 'mtime-free key', rationale: 'MEM002', revisable: 'no' },
    ],
  };
  const decisionsWriteResult = decisions.writeFragment(tmpBase, decisionFragment);
  assert('decisions: fixture write created', decisionsWriteResult.created, true);

  const decisionsLoosePath = decisions.fragmentPath(tmpBase, decisionUnitId);
  const decisionsMerged = mergeBucket([decisionsLoosePath], { type: 'decisions' });
  const decisionsRollupPath = path.join(tmpBase, '.gsd', 'decisions', '_rollup-2026-q1.md');
  fs.writeFileSync(decisionsRollupPath, decisionsMerged.content, 'utf8');
  fs.unlinkSync(decisionsLoosePath);
  decisions._invalidateBucketCache(tmpBase);

  const decisionsRenderedAfter = projection.renderDecisions(tmpBase);
  assert('decisions: renderDecisions still contains consolidated decision', decisionsRenderedAfter.includes('Use bucket memo'), true);

  const decisionsIdempotent = decisions.writeFragment(tmpBase, decisionFragment);
  assert('(b) decisions shadow-guard: identical content → created:false', decisionsIdempotent.created, false);
  assert('(b) decisions shadow-guard: no loose file written', fs.existsSync(decisionsLoosePath), false);

  assertThrows('(c) decisions shadow-guard: divergent content throws', () => {
    decisions.writeFragment(tmpBase, {
      unit_id: decisionUnitId,
      decisions: [
        { when: '2026-01-04', scope: 'S04', decision: 'DIVERGENT DECISION', choice: 'x', rationale: 'y', revisable: 'no' },
      ],
    });
  });
  assert('(c) decisions shadow-guard: no loose file written after throw', fs.existsSync(decisionsLoosePath), false);

  // (d) decisions memo: same-size edit, stale until invalidate
  const decisionsPreEdit = fs.readFileSync(decisionsRollupPath, 'utf8');
  const decisionsEdited = decisionsPreEdit.replace('bucket memo', 'BUCKET-memo'); // same length
  assert('decisions (d) edit preserves byte length', Buffer.byteLength(decisionsEdited, 'utf8'), Buffer.byteLength(decisionsPreEdit, 'utf8'));
  fs.writeFileSync(decisionsRollupPath, decisionsEdited, 'utf8');

  const decisionsStale = projection.renderDecisions(tmpBase);
  assert('decisions (d) memo stale before invalidate', decisionsStale.includes('Use bucket memo'), true);

  decisions._invalidateBucketCache(tmpBase);
  const decisionsFresh = projection.renderDecisions(tmpBase);
  assert('decisions (d) memo fresh after invalidate', decisionsFresh.includes('BUCKET-memo'), true);

} finally {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}

if (allPassed) {
  console.log('\nPASS: all fragment-store-writer checks passed');
  process.exit(0);
} else {
  console.log('\nFAIL: one or more fragment-store-writer checks failed');
  process.exit(1);
}
