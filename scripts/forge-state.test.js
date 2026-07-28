#!/usr/bin/env node
// forge-state.test.js — regression suite for forge-state.js section parsing
//
// Guards the silent data-loss bug where extractSection's lookahead ended on `$`
// under the `m` flag: `$` matches end-of-LINE there, so a section was parsed as
// its first line only. Because write() reserializes the whole file from the
// parsed object, every write path (--update, --push-recent) persisted that
// truncation with exit 0 and no warning.
//
// Run: node scripts/forge-state.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const state = require('./forge-state.js');

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
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// ── Fixture ───────────────────────────────────────────────────────────────────
const MILESTONE = 'M999';

const RECENT_3 = [
  'plan-slice S03 — planejado em 4 tasks (forge-planner, claude-fable-5)',
  'execute-task T01 — baseline canonico (forge-executor, claude-sonnet-5)',
  'execute-task T02 — bateria FINAL 18/18 (forge-executor, claude-sonnet-5)',
];
const NOTES_3 = [
  'primeira linha das notas',
  'segunda linha das notas',
  'terceira linha das notas',
];

function fixture({ recent = RECENT_3, notes = NOTES_3 } = {}) {
  const lines = [
    '---',
    `milestone: ${MILESTONE}`,
    'kind: milestone',
    'created: 2026-07-28T10:00:00.000Z',
    'last_updated: 2026-07-28T10:00:00.000Z',
    'isolation_mode: shared',
    '---',
    '',
    `# ${MILESTONE} State`,
    '',
    '**Active Slice:** S03',
    '**Active Task:** T03',
    '**Phase:** execute-task',
    '**Auto-mode:** on',
    '**Next Action:** executar T04',
    '',
  ];
  if (recent.length) lines.push('## Recent units (last 10)', '', ...recent, '');
  if (notes.length)  lines.push('## Notes', '', ...notes, '');
  return lines.join('\n');
}

// Each test gets its own sandbox so writes cannot leak between cases.
function withSandbox(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-state-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gsd', 'milestones', MILESTONE), { recursive: true });
    fs.writeFileSync(state.statePath(dir, MILESTONE), fixture(opts), 'utf8');
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Read the section back off DISK, not from the returned object — the bug was
// only observable by re-reading the file.
function sectionFromDisk(dir, heading) {
  const raw = fs.readFileSync(state.statePath(dir, MILESTONE), 'utf8');
  const start = raw.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const after = raw.slice(start + heading.length + 3);
  const end = after.indexOf('\n## ');
  return (end === -1 ? after : after.slice(0, end)).trim();
}

// ── read(): sections must survive parsing whole ───────────────────────────────
test('read: Recent units keeps all 3 lines (not just the first)', () => {
  withSandbox(dir => {
    assertEq(state.read(dir, MILESTONE).recent_units, RECENT_3.join('\n'));
  });
});

test('read: multi-line Notes keeps all 3 lines', () => {
  withSandbox(dir => {
    assertEq(state.read(dir, MILESTONE).notes, NOTES_3.join('\n'));
  });
});

test('read: last section in the file is not truncated by end-of-string', () => {
  // Notes is last — its lookahead alternative is the end-of-input branch.
  withSandbox({ recent: [] }, dir => {
    assertEq(state.read(dir, MILESTONE).notes, NOTES_3.join('\n'));
  });
});

test('read: single-line section still parses', () => {
  withSandbox({ recent: [RECENT_3[0]], notes: [NOTES_3[0]] }, dir => {
    const s = state.read(dir, MILESTONE);
    assertEq(s.recent_units, RECENT_3[0]);
    assertEq(s.notes, NOTES_3[0]);
  });
});

test('read: absent sections stay null', () => {
  withSandbox({ recent: [], notes: [] }, dir => {
    const s = state.read(dir, MILESTONE);
    assertEq(s.recent_units, null);
    assertEq(s.notes, null);
  });
});

// ── pushRecentUnit(): the reported repro ──────────────────────────────────────
test('pushRecentUnit: 3 lines in → 4 lines on disk, chronological order', () => {
  withSandbox(dir => {
    const entry = 'execute-task T03 — nova entrada';
    state.pushRecentUnit(dir, MILESTONE, entry);

    const onDisk = sectionFromDisk(dir, 'Recent units (last 10)').split('\n');
    assertEq(onDisk.length, 4, 'expected 4 lines in Recent units on disk');
    assertEq(onDisk, RECENT_3.concat(entry), 'expected prior lines preserved, new entry last');
  });
});

test('pushRecentUnit: does not truncate the Notes section as a side effect', () => {
  withSandbox(dir => {
    state.pushRecentUnit(dir, MILESTONE, 'execute-task T03 — nova entrada');
    assertEq(sectionFromDisk(dir, 'Notes').split('\n').length, 3);
  });
});

test('pushRecentUnit: still caps at the last 10 entries', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `execute-task T${String(i + 1).padStart(2, '0')} — entrada`);
  withSandbox({ recent: twelve }, dir => {
    state.pushRecentUnit(dir, MILESTONE, 'execute-task T13 — entrada');
    const onDisk = sectionFromDisk(dir, 'Recent units (last 10)').split('\n');
    assertEq(onDisk.length, 10, 'expected the last-10 cap to hold');
    assertEq(onDisk[0], 'execute-task T04 — entrada');
    assertEq(onDisk[9], 'execute-task T13 — entrada');
  });
});

// ── updateFields(): any write path must round-trip sections intact ────────────
test('updateFields: unrelated field update preserves both sections', () => {
  withSandbox(dir => {
    state.updateFields(dir, MILESTONE, { active_task: 'T04', next_action: 'executar T05' });

    assertEq(sectionFromDisk(dir, 'Recent units (last 10)'), RECENT_3.join('\n'));
    assertEq(sectionFromDisk(dir, 'Notes'), NOTES_3.join('\n'));

    const s = state.read(dir, MILESTONE);
    assertEq(s.active_task, 'T04');
    assertEq(s.next_action, 'executar T05');
  });
});

test('updateFields: repeated writes do not erode the sections', () => {
  withSandbox(dir => {
    for (let i = 0; i < 5; i++) state.updateFields(dir, MILESTONE, { phase: 'execute-task' });
    assertEq(sectionFromDisk(dir, 'Recent units (last 10)').split('\n').length, 3);
    assertEq(sectionFromDisk(dir, 'Notes').split('\n').length, 3);
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
