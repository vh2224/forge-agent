#!/usr/bin/env node
// forge-status.test.js — contract test suite for forge-status.js
// Exercises: parseRoadmap, parsePlanTasks, scanAutonomousTasks, resolveFocus,
// collect, renderTree — plus the pure-read guarantee and the static source
// guard against write-API calls.
// Run: node scripts/forge-status.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const status = require('./forge-status.js');

// ── Harness (copied from forge-ids.test.js) ─────────────────────────────────
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

console.log('\n=== forge-status.js — contract test suite ===\n');

// ── Fixture builder ──────────────────────────────────────────────────────────
const tmpDirs = [];

const ROADMAP_TEXT = [
  '# M-20260101120000-alpha: Alpha Milestone — Roadmap',
  '',
  '- [x] **S01: Done one** `risk:low`',
  '- [ ] **S02: Active one** `risk:high`',
  '- [ ] **S03: Pending one**',
  '',
].join('\n');

const PLAN_TEXT = [
  '# S02 Plan',
  '',
  '- [x] T01: plain done',
  '- [ ] T02: plain active',
  '- [ ] **T03** *(DECOMPOSED into sub-tasks)*',
  '  - [ ] T03.1: sub-task',
  '',
].join('\n');

function stateText(milestoneId, overrides) {
  overrides = overrides || {};
  const nowIso = new Date().toISOString();
  const activeSlice = overrides.active_slice || 'S02';
  const activeTask = overrides.active_task || 'T02';
  const phase = overrides.phase || 'execute-task';
  const autoMode = overrides.auto_mode || 'on';
  const nextAction = overrides.next_action || 'Continue T02';
  return [
    '---',
    `milestone: ${milestoneId}`,
    'kind: milestone',
    `created: ${nowIso}`,
    `last_updated: ${nowIso}`,
    'isolation_mode: shared',
    '---',
    '',
    `# ${milestoneId} State`,
    '',
    `**Active Slice:** ${activeSlice}`,
    `**Active Task:** ${activeTask}`,
    `**Phase:** ${phase}`,
    `**Auto-mode:** ${autoMode}`,
    `**Next Action:** ${nextAction}`,
    '',
  ].join('\n');
}

function runRecord(id, sessionId, startedAt) {
  return {
    kind: 'milestone',
    id,
    session_id: sessionId,
    active: true,
    started_at: startedAt,
    last_heartbeat: startedAt,
    isolation_mode: 'shared',
    milestone_dir: `.gsd/milestones/${id}/`,
  };
}

// opts:
//   milestone: false to skip building the milestone dir entirely
//   runs: [{ id, sessionId, startedAt }] — literal run JSONs
//   legacyState: true to write a legacy .gsd/STATE.md
//   autonomousTasks: false to skip building .gsd/tasks/
//   milestoneId: override default milestone id
function makeFixture(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-test-'));
  tmpDirs.push(dir);
  const milestoneId = opts.milestoneId || 'M-20260101120000-alpha';

  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });

  if (opts.milestone !== false) {
    const mDir = path.join(dir, '.gsd', 'milestones', milestoneId);
    fs.mkdirSync(path.join(mDir, 'slices', 'S02'), { recursive: true });
    fs.writeFileSync(path.join(mDir, `${milestoneId}-ROADMAP.md`), opts.roadmapText || ROADMAP_TEXT, 'utf8');
    if (opts.state !== false) {
      fs.writeFileSync(path.join(mDir, `${milestoneId}-STATE.md`), stateText(milestoneId, opts.stateOverrides), 'utf8');
    }
    fs.writeFileSync(path.join(mDir, 'slices', 'S02', 'S02-PLAN.md'), opts.planText || PLAN_TEXT, 'utf8');
  }

  if (opts.runs && opts.runs.length > 0) {
    const runsDir = path.join(dir, '.gsd', 'forge', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    for (const r of opts.runs) {
      fs.writeFileSync(
        path.join(runsDir, `${r.id}.json`),
        JSON.stringify(runRecord(r.id, r.sessionId || 'sess-' + r.id, r.startedAt)),
        'utf8'
      );
    }
  }

  if (opts.legacyState) {
    fs.writeFileSync(
      path.join(dir, '.gsd', 'STATE.md'),
      [
        '# Legacy State',
        '',
        `**Active Milestone:** ${milestoneId}`,
        '**Active Slice:** S02',
        '**Active Task:** T02',
        '**Phase:** execute-task',
        '**Auto-mode:** on',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  if (opts.autonomousTasks !== false) {
    const tasksDir = path.join(dir, '.gsd', 'tasks');
    // legacy done
    fs.mkdirSync(path.join(tasksDir, 'TASK-001'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'TASK-001', 'TASK-001-BRIEF.md'), '# TASK-001: Legacy fix\n\nDo the thing.\n', 'utf8');
    fs.writeFileSync(path.join(tasksDir, 'TASK-001', 'TASK-001-SUMMARY.md'), '# Summary\n\nDone.\n', 'utf8');
    // timestamp in_progress
    fs.mkdirSync(path.join(tasksDir, 'T-20260101130000-fix-x'), { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'T-20260101130000-fix-x', 'T-20260101130000-fix-x-BRIEF.md'),
      '# T-20260101130000-fix-x: Fix the x\n\nDetails.\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tasksDir, 'T-20260101130000-fix-x', 'T-20260101130000-fix-x-PLAN.md'),
      '# Plan\n\nSteps.\n',
      'utf8'
    );
    // timestamp pending (BRIEF only)
    fs.mkdirSync(path.join(tasksDir, 'T-20260101140000-docs'), { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'T-20260101140000-docs', 'T-20260101140000-docs-BRIEF.md'),
      '# T-20260101140000-docs: Write docs\n\nDetails.\n',
      'utf8'
    );
  }

  return { dir, milestoneId };
}

// ── Recursive snapshot for pure-read proof ──────────────────────────────────
function snapshot(dir) {
  const results = [];
  function walk(current, rel) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(current, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, relPath);
      } else {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        results.push([relPath, st.mtimeMs, st.size]);
      }
    }
  }
  walk(dir, '');
  results.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return results;
}

// ── 1. Parsers (pure, no fixture) ────────────────────────────────────────────
console.log('1. Parsers (pure)');

test('parseRoadmap extracts title and slices', () => {
  const r = status.parseRoadmap(ROADMAP_TEXT);
  assertEq(r.title, 'Alpha Milestone', 'title');
  assert(r.slices.length === 3, `expected 3 slices, got ${r.slices.length}`);
  assertEq(r.slices[0], { checked: true, id: 'S01', title: 'Done one', risk: 'low' }, 's01');
  assertEq(r.slices[1], { checked: false, id: 'S02', title: 'Active one', risk: 'high' }, 's02');
  assertEq(r.slices[2], { checked: false, id: 'S03', title: 'Pending one', risk: null }, 's03');
});

test('parsePlanTasks handles plain, bold-decomposed and T##.N variants', () => {
  const t = status.parsePlanTasks(PLAN_TEXT);
  assert(t.length === 4, `expected 4 tasks, got ${t.length}`);
  assertEq(t[0], { checked: true, id: 'T01', title: 'plain done' }, 't01');
  assertEq(t[1], { checked: false, id: 'T02', title: 'plain active' }, 't02');
  assert(t[2].id === 'T03' && t[2].checked === false, 't03');
  assert(t[3].id === 'T03.1' && t[3].checked === false, 't03.1');
});

test('parseRoadmap does not truncate title on inner bold emphasis', () => {
  const text = [
    '# M-x: Title',
    '',
    '- [ ] **S02: A **critical** fix** `risk:high`',
    '',
  ].join('\n');
  const r = status.parseRoadmap(text);
  assert(r.slices.length === 1, `expected 1 slice, got ${r.slices.length}`);
  assertEq(r.slices[0].id, 'S02', 'id');
  assertEq(r.slices[0].risk, 'high', 'risk');
  assert(r.slices[0].title === 'A **critical** fix', `title truncated: ${JSON.stringify(r.slices[0].title)}`);
});

test('parseRoadmap tolerates trailing depends:[] tag after risk tag (real ROADMAP format)', () => {
  const text = [
    '# M-x: Title',
    '',
    '- [ ] **S01: Engine core + parser de árvore (read-only)** `risk:high` `depends:[]`',
    '- [x] **S02: Plain done** `risk:low`',
    '',
  ].join('\n');
  const r = status.parseRoadmap(text);
  assert(r.slices.length === 2, `expected 2 slices, got ${r.slices.length}`);
  assertEq(r.slices[0].id, 'S01', 'id');
  assertEq(r.slices[0].risk, 'high', 'risk');
  assert(r.slices[0].title.includes('Engine core'), `title should include "Engine core": ${JSON.stringify(r.slices[0].title)}`);
  assertEq(r.slices[1].id, 'S02', 'id 2');
  assertEq(r.slices[1].checked, true, 'checked');
});

test('parseRoadmap tolerates malformed / empty input', () => {
  assertEq(status.parseRoadmap(''), { title: null, slices: [] });
  assertEq(status.parseRoadmap(null), { title: null, slices: [] });
  assertEq(status.parseRoadmap(undefined), { title: null, slices: [] });
  assertEq(status.parseRoadmap(12345), { title: null, slices: [] });
});

test('parsePlanTasks tolerates malformed / empty input', () => {
  assertEq(status.parsePlanTasks(''), []);
  assertEq(status.parsePlanTasks(null), []);
  assertEq(status.parsePlanTasks(undefined), []);
  assertEq(status.parsePlanTasks(12345), []);
});

// ── 2. Run resolution ─────────────────────────────────────────────────────────
console.log('2. Run resolution');

test('exactly 1 active run — focused directly', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const focus = status.resolveFocus(dir, null);
  assertEq(focus.focused, milestoneId, 'focused');
  assertEq(focus.note, null, 'note');
  assertEq(focus.error, null, 'error');
});

test('2+ active runs — oldest focused, note populated', () => {
  const { dir } = makeFixture({
    milestoneId: 'M-20260101120000-alpha',
    runs: [
      { id: 'M-20260101120000-alpha', startedAt: 2000 },
      { id: 'M-20260101090000-beta', startedAt: 1000 },
    ],
  });
  // second milestone dir doesn't need full fixture — resolveFocus only reads runs
  const focus = status.resolveFocus(dir, null);
  assertEq(focus.focused, 'M-20260101090000-beta', 'oldest wins');
  assert(typeof focus.note === 'string' && focus.note.length > 0, 'note populated');
});

test('positional milestoneId overrides run resolution', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const focus = status.resolveFocus(dir, milestoneId);
  assertEq(focus.focused, milestoneId, 'focused override');
  assertEq(focus.note, null, 'no note on override');
});

test('positional milestoneId that does not exist yields error, focused null', () => {
  const { dir } = makeFixture({ runs: [] });
  const focus = status.resolveFocus(dir, 'M-20261231235959-ghost');
  assertEq(focus.focused, null, 'focused null');
  assert(typeof focus.error === 'string' && focus.error.includes('não encontrado'), 'error message');
});

test('0 active runs — legacy STATE.md fallback', () => {
  const { dir, milestoneId } = makeFixture({ runs: [], legacyState: true });
  const focus = status.resolveFocus(dir, null);
  assertEq(focus.focused, milestoneId, 'legacy focused');
  assert(typeof focus.note === 'string' && focus.note.includes('legado'), 'note mentions legacy');
});

test('0 active runs + no legacy + no milestones — fully idle, focused null', () => {
  const { dir } = makeFixture({ milestone: false, runs: [], legacyState: false, autonomousTasks: false });
  const focus = status.resolveFocus(dir, null);
  assertEq(focus.focused, null, 'focused null');
  assertEq(focus.note, null, 'no note');
  assertEq(focus.error, null, 'no error');
});

// ── 3. Milestone tree ────────────────────────────────────────────────────────
console.log('3. Milestone tree (collect)');

test('collect builds slice statuses done/active/pending and progress', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const model = status.collect(dir, {});
  assert(model.milestone !== null, 'milestone present');
  const m = model.milestone;
  assertEq(m.id, milestoneId, 'id');
  assertEq(m.progress, { done: 1, total: 3 }, 'progress');
  const bySlice = Object.fromEntries(m.slices.map((s) => [s.id, s]));
  assertEq(bySlice.S01.status, 'done', 's01 status');
  assertEq(bySlice.S02.status, 'active', 's02 status');
  assertEq(bySlice.S03.status, 'pending', 's03 status');
});

test('collect only attaches tasks under the active slice', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const model = status.collect(dir, {});
  const bySlice = Object.fromEntries(model.milestone.slices.map((s) => [s.id, s]));
  assert(bySlice.S02.tasks.length === 4, `expected 4 tasks on S02, got ${bySlice.S02.tasks.length}`);
  assertEq(bySlice.S01.tasks, [], 's01 has no tasks');
  assertEq(bySlice.S03.tasks, [], 's03 has no tasks');
});

test('collect derives task statuses done/active/pending', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const model = status.collect(dir, {});
  const s02 = model.milestone.slices.find((s) => s.id === 'S02');
  const byTask = Object.fromEntries(s02.tasks.map((t) => [t.id, t]));
  assertEq(byTask.T01.status, 'done', 't01');
  assertEq(byTask.T02.status, 'active', 't02 (matches active_task)');
  assertEq(byTask['T03'].status, 'pending', 't03');
  assertEq(byTask['T03.1'].status, 'pending', 't03.1');
});

// ── 4. Autonomous tasks ───────────────────────────────────────────────────────
console.log('4. Autonomous tasks');

test('scanAutonomousTasks finds all 3 fixture entries with correct format+status', () => {
  const { dir } = makeFixture({ runs: [] });
  const tasks = status.scanAutonomousTasks(dir);
  assert(tasks.length === 3, `expected 3 tasks, got ${tasks.length}`);
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  assertEq(byId['TASK-001'].format, 'legacy', 'legacy format');
  assertEq(byId['TASK-001'].status, 'done', 'legacy status');
  assertEq(byId['T-20260101130000-fix-x'].format, 'timestamp', 'timestamp format');
  assertEq(byId['T-20260101130000-fix-x'].status, 'in_progress', 'timestamp in_progress');
  assertEq(byId['T-20260101140000-docs'].format, 'timestamp', 'timestamp format 2');
  assertEq(byId['T-20260101140000-docs'].status, 'pending', 'timestamp pending');
});

test('scanAutonomousTasks on missing .gsd/tasks returns empty array', () => {
  const { dir } = makeFixture({ autonomousTasks: false, runs: [] });
  const tasks = status.scanAutonomousTasks(dir);
  assertEq(tasks, [], 'empty');
});

// ── 5. Torn reads ─────────────────────────────────────────────────────────────
console.log('5. Torn reads');

test('truncated runs JSON does not throw and is skipped', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const runsDir = path.join(dir, '.gsd', 'forge', 'runs');
  fs.writeFileSync(path.join(runsDir, 'M-20260101120000-alpha.json'), '{"active":tru', 'utf8');
  let model;
  let threw = false;
  try {
    model = status.collect(dir, {});
  } catch {
    threw = true;
  }
  assert(!threw, 'collect must not throw on torn run JSON');
  assert(model !== undefined, 'model returned');
  // No active runs parsed from the truncated file -> fully idle or legacy fallback,
  // either way collect() must degrade gracefully without throwing.
  assertEq(model.runs.active, [], 'no active runs parsed from torn JSON');
});

test('truncated ROADMAP + missing STATE produces a model with warnings, no throw', () => {
  const { dir, milestoneId } = makeFixture({
    runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }],
    roadmapText: ROADMAP_TEXT.slice(0, 20), // mid-line truncation
  });
  // Remove STATE.md (test-side, not engine) so collect() also hits the
  // "estado não encontrado" warning path alongside the torn ROADMAP.
  fs.unlinkSync(path.join(dir, '.gsd', 'milestones', milestoneId, `${milestoneId}-STATE.md`));

  let model;
  let threw = false;
  try {
    model = status.collect(dir, {});
  } catch {
    threw = true;
  }
  assert(!threw, 'collect must not throw on truncated ROADMAP + missing STATE');
  assert(model.milestone !== null, 'milestone still resolved');
  assert(Array.isArray(model.milestone.slices), 'slices array present');
  // Truncated roadmap yields zero or partial slices — never throws, degrades gracefully.
  assert(model.milestone.slices.length <= 3, 'degraded slice count');
  assert(model.warnings.length > 0, 'warnings populated');
});

// ── 6. Pure-read proof ────────────────────────────────────────────────────────
console.log('6. Pure-read proof');

test('collect()+renderTree() leaves the fixture .gsd/ byte-for-byte untouched', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const before = snapshot(dir);
  const model1 = status.collect(dir, {});
  status.renderTree(model1);
  const model2 = status.collect(dir, {});
  status.renderTree(model2);
  const after = snapshot(dir);
  assertEq(after, before, 'snapshot must be identical before/after two full collect+render cycles');
  assert(!fs.existsSync(path.join(dir, '.gsd', '.locks')), 'no .gsd/.locks/ created');
});

// ── 7. Render ──────────────────────────────────────────────────────────────────
console.log('7. Render');

test('renderTree output contains expected section markers', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const model = status.collect(dir, {});
  const out = status.renderTree(model);
  assert(out.includes('## Status GSD'), 'header');
  assert(out.includes('### Slices'), 'slices header');
  assert(out.includes('← ativo'), 'active marker');
  assert(out.includes('### Próxima ação'), 'next action header');
  assert(out.includes('### Tasks autônomas'), 'autonomous tasks header');
  assert(out.includes('✓ TASK-001'), 'done autonomous task icon');
});

test('renderTree on idle model shows "Nenhum run ativo"', () => {
  const { dir } = makeFixture({ milestone: false, runs: [], legacyState: false, autonomousTasks: false });
  const model = status.collect(dir, {});
  const out = status.renderTree(model);
  assert(out.includes('Nenhum run ativo'), 'idle message');
});

test('renderTree omits "Tasks autônomas" section when there are none', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }], autonomousTasks: false });
  const model = status.collect(dir, {});
  const out = status.renderTree(model);
  assert(!out.includes('### Tasks autônomas'), 'section absent');
});

// ── 8. Source guard ────────────────────────────────────────────────────────────
console.log('8. Source guard (static analysis of forge-status.js)');

test('forge-status.js source contains zero write-API call sites', () => {
  const srcPath = path.join(__dirname, 'forge-status.js');
  const raw = fs.readFileSync(srcPath, 'utf8');
  // Strip `//` line comments so the documented CONTRACT header (which names
  // these APIs on purpose) does not trigger a false positive.
  const cleaned = raw
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  const writeApiRe = /\b(writeFileSync|appendFileSync|mkdirSync|unlinkSync|renameSync)\s*\(/g;
  const matches = cleaned.match(writeApiRe) || [];
  assertEq(matches, [], `expected zero write-API call sites, found: ${JSON.stringify(matches)}`);

  const forbiddenRequireRe = /require\(\s*['"][^'"]*forge-(lock|dashboard)[^'"]*['"]\s*\)/g;
  const reqMatches = cleaned.match(forbiddenRequireRe) || [];
  assertEq(reqMatches, [], `expected zero forge-lock/forge-dashboard requires, found: ${JSON.stringify(reqMatches)}`);
});

// ── 9. CLI exit codes ─────────────────────────────────────────────────────────
console.log('9. CLI exit codes');

const CLI_PATH = path.join(__dirname, 'forge-status.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
}

test('CLI exits 0 for a valid fixture + idle project', () => {
  const { dir } = makeFixture({ milestone: false, runs: [], legacyState: false, autonomousTasks: false });
  const res = runCli(['--cwd', dir]);
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
});

test('CLI exits 1 for --cwd pointing at a dir without .gsd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-nogsd-'));
  tmpDirs.push(dir);
  const res = runCli(['--cwd', dir]);
  assert(res.status === 1, `expected exit 1, got ${res.status}\nstderr: ${res.stderr}`);
});

test('CLI exits 2 for an invalid positional id', () => {
  const { dir } = makeFixture({ milestone: false, runs: [], legacyState: false, autonomousTasks: false });
  const res = runCli(['not-a-valid-id', '--cwd', dir]);
  assert(res.status === 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
});

test('CLI exits 0 for --help', () => {
  const res = runCli(['--help']);
  assert(res.status === 0, `expected exit 0, got ${res.status}`);
  assert(res.stdout.includes('forge-status'), 'help text present');
});

test('CLI exits 2 for --cwd given without a following value', () => {
  const res = runCli(['--cwd']);
  assert(res.status === 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
});

test('CLI regression: milestone-with-missing-STATE via positional id does NOT exit 2', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  fs.unlinkSync(path.join(dir, '.gsd', 'milestones', milestoneId, `${milestoneId}-STATE.md`));
  const res = runCli([milestoneId, '--cwd', dir]);
  assert(res.status === 0, `expected exit 0 (degraded render, not not-found), got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.includes(milestoneId), 'stdout mentions milestone id');
});

// ── Cleanup ────────────────────────────────────────────────────────────────────
for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
