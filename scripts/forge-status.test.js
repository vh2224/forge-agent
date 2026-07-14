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
const tokens = require('./forge-tokens.js');

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

// ── Token telemetry fixture helper (S02) ────────────────────────────────────
// Writes the global .gsd/forge/events.jsonl and/or the per-milestone
// .gsd/milestones/<id>/<id>-events.jsonl into an EXISTING fixture dir (built
// via makeFixture above). Kept as a standalone helper (not folded into
// makeFixture's opts) per T04-PLAN step 2 — makeFixture's signature stays
// compatible; this just layers telemetry files on top.
function writeEventsFixture(dir, milestoneId, opts) {
  opts = opts || {};
  const forgeDir = path.join(dir, '.gsd', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const msDir = path.join(dir, '.gsd', 'milestones', milestoneId);
  fs.mkdirSync(msDir, { recursive: true });

  if (opts.globalLines) {
    fs.writeFileSync(
      path.join(forgeDir, 'events.jsonl'),
      opts.globalLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
      'utf8'
    );
  }
  if (opts.perMsLines) {
    fs.writeFileSync(
      path.join(msDir, `${milestoneId}-events.jsonl`),
      opts.perMsLines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
      'utf8'
    );
  }
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
  // Split on \r?\n: on a CRLF checkout (core.autocrlf=true) a trailing \r
  // blocks the `$` anchor and the comment would survive the strip.
  const cleaned = raw
    .split(/\r?\n/)
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

// ── 10. aggregate() unit tests (S02) ─────────────────────────────────────────
console.log('10. aggregate() unit tests');

test('aggregate() joins (ts,unit) and sums input/output tokens correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const ts1 = '2026-07-02T19:00:00Z';
  const ts2 = '2026-07-02T19:01:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [
      { ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' },
      { ts: ts2, unit: 'plan-slice/S01', milestone: milestoneId, agent: 'forge-planner', status: 'done' },
    ],
    globalLines: [
      { ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 },
      { ts: ts2, event: 'dispatch', unit: 'plan-slice/S01', input_tokens: 200, output_tokens: 80 },
    ],
  });
  const agg = tokens.aggregate(dir, { milestoneId });
  assertEq(agg.dispatch_count, 2, 'dispatch_count');
  assertEq(agg.total_input, 300, 'total_input');
  assertEq(agg.total_output, 130, 'total_output');
  assertEq(agg.source, 'per-milestone', 'source');
  assert(agg.by_phase['execute-task'] && agg.by_phase['execute-task'].count === 1, 'by_phase execute-task count');
  assert(agg.by_phase['plan-slice'] && agg.by_phase['plan-slice'].count === 1, 'by_phase plan-slice count');
});

test('aggregate() all-zero-tokens case: has_telemetry true, has_token_data false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-zero-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 0, output_tokens: 0 }],
  });
  const agg = tokens.aggregate(dir, { milestoneId });
  assertEq(agg.has_telemetry, true, 'has_telemetry');
  assertEq(agg.has_token_data, false, 'has_token_data');
  assert(agg.dispatch_count > 0, 'dispatch_count > 0');
});

test('aggregate() does NOT sum global log when per-milestone file is missing (R2 regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-fallback-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 10, output_tokens: 5 }],
  });
  const agg = tokens.aggregate(dir, { milestoneId });
  assertEq(agg.source, 'unattributable', 'source unattributable, never global sum without membership');
  assertEq(agg.has_telemetry, false, 'has_telemetry false when unattributable');
  assertEq(agg.dispatch_count, 0, 'dispatch_count 0 when unattributable');
});

test('aggregate() ignores OTHER units in global log when per-milestone file is missing (R2 regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-otherunits-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const ts1 = '2026-07-02T19:00:00Z';
  const forgeDir = path.join(dir, '.gsd', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  // No per-milestone events file at all — global has lines for a DIFFERENT milestone's units.
  fs.writeFileSync(
    path.join(forgeDir, 'events.jsonl'),
    JSON.stringify({ ts: ts1, event: 'dispatch', unit: 'execute-task/T99', input_tokens: 999, output_tokens: 999 }) + '\n',
    'utf8'
  );
  const agg = tokens.aggregate(dir, { milestoneId });
  assertEq(agg.source, 'unattributable', 'source unattributable');
  assertEq(agg.total_input, 0, 'other milestone totals not attributed');
  assertEq(agg.total_output, 0, 'other milestone totals not attributed');
  assertEq(agg.dispatch_count, 0, 'other milestone dispatches not counted');
});

test('aggregate() dedups identical (ts,unit) dispatch lines in membership (R3 regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-dedup-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [
      { ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 10, output_tokens: 5 },
      { ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 10, output_tokens: 5 },
    ],
  });
  const agg = tokens.aggregate(dir, { milestoneId });
  assertEq(agg.dispatch_count, 1, 'duplicate (ts,unit) counted once');
  assertEq(agg.total_input, 10, 'duplicate input not double-counted');
  assertEq(agg.total_output, 5, 'duplicate output not double-counted');
});

test('aggregate() with no files at all -> has_telemetry false, source none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-none-'));
  tmpDirs.push(dir);
  const agg = tokens.aggregate(dir, { milestoneId: 'M-nonexistent-000000-x' });
  assertEq(agg.has_telemetry, false, 'has_telemetry');
  assertEq(agg.source, 'none', 'source none');
  assertEq(agg.dispatch_count, 0, 'dispatch_count 0');
});

test('aggregate() tolerates torn/malformed JSONL lines without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-tok-torn-'));
  tmpDirs.push(dir);
  const milestoneId = 'M-20260101120000-alpha';
  const forgeDir = path.join(dir, '.gsd', 'forge');
  const msDir = path.join(dir, '.gsd', 'milestones', milestoneId);
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.mkdirSync(msDir, { recursive: true });
  const ts1 = '2026-07-02T19:00:00Z';
  fs.writeFileSync(
    path.join(forgeDir, 'events.jsonl'),
    JSON.stringify({ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 40, output_tokens: 20 }) +
      '\n{"ts":"broken-line-trunc\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(msDir, `${milestoneId}-events.jsonl`),
    JSON.stringify({ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, status: 'done' }) +
      '\n{"unit":"garbage\n',
    'utf8'
  );
  let agg;
  let threw = false;
  try {
    agg = tokens.aggregate(dir, { milestoneId });
  } catch {
    threw = true;
  }
  assert(!threw, 'aggregate() must not throw on torn JSONL');
  assert(agg.dispatch_count >= 1, 'valid line still counted');
  assertEq(agg.total_input, 40, 'torn line ignored, valid line summed');
});

// ── 11. --json CLI (S02) ──────────────────────────────────────────────────────
console.log('11. --json CLI');

test('--json produces parseable JSON with collect() keys, exit 0', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--json', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  let parsed;
  let threw = false;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'stdout must be parseable JSON');
  assert(Object.prototype.hasOwnProperty.call(parsed, 'cwd'), 'has cwd');
  assert(Object.prototype.hasOwnProperty.call(parsed, 'runs'), 'has runs');
  assert(Object.prototype.hasOwnProperty.call(parsed, 'milestone'), 'has milestone');
  assert(Object.prototype.hasOwnProperty.call(parsed, 'autonomous_tasks'), 'has autonomous_tasks');
  assert(Object.prototype.hasOwnProperty.call(parsed, 'warnings'), 'has warnings');
});

test('--json <valid-milestone-id> focuses that id in output', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--json', milestoneId, '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEq(parsed.milestone.id, milestoneId, 'focused id');
});

test('--json <invalid-id> exits 2 (parseArgs boolean-flag regression guard)', () => {
  const { dir } = makeFixture({ milestone: false, runs: [], legacyState: false, autonomousTasks: false });
  const res = spawnSync(process.execPath, [CLI_PATH, '--json', 'not-a-valid-id', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 2, `expected 2 (positional was NOT swallowed by --json), got ${res.status}\nstderr: ${res.stderr}`);
});

test('--json --cwd <no-.gsd> exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-nogsd2-'));
  tmpDirs.push(dir);
  const res = spawnSync(process.execPath, [CLI_PATH, '--json', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 1, `expected 1, got ${res.status}\nstderr: ${res.stderr}`);
});

// ── 12. --tokens CLI (S02) ────────────────────────────────────────────────────
console.log('12. --tokens CLI');

test('--tokens output contains token-usage block with by-phase dispatch counts', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 }],
  });
  const res = spawnSync(process.execPath, [CLI_PATH, '--tokens', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.includes('### Token usage'), 'block header present');
  assert(res.stdout.includes('execute-task'), 'phase name present');
  assert(res.stdout.includes('100'), 'input total present');
  assert(res.stdout.includes('50'), 'output total present');
});

test('--tokens all-zero-tokens fixture shows the "sem dados de token" note', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 0, output_tokens: 0 }],
  });
  const res = spawnSync(process.execPath, [CLI_PATH, '--tokens', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.includes('### Token usage'), 'block header present');
  assert(res.stdout.includes('sem dados de token'), 'all-zero note present');
});

// ── 13. Combined flags (S02) ─────────────────────────────────────────────────
console.log('13. Combined flags');

test('--json --tokens together still emits pure JSON (no "### Token usage" text)', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 }],
  });
  const res = spawnSync(process.execPath, [CLI_PATH, '--json', '--tokens', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(!res.stdout.includes('### Token usage'), 'no token-usage text mixed into JSON stdout');
  let threw = false;
  try {
    JSON.parse(res.stdout);
  } catch {
    threw = true;
  }
  assert(!threw, 'stdout must still be pure parseable JSON when --tokens is also passed');
});

// ── 14. Pure-read proof for --tokens (S02) ────────────────────────────────────
console.log('14. Pure-read proof (--tokens)');

test('--tokens run leaves .gsd/ byte-for-byte unchanged, creates no .gsd/.locks/', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 }],
  });
  const before = snapshot(dir);
  const res = spawnSync(process.execPath, [CLI_PATH, '--tokens', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(res.status === 0, `expected 0, got ${res.status}\nstderr: ${res.stderr}`);
  const after = snapshot(dir);
  assertEq(after, before, 'snapshot must be identical before/after --tokens run');
  assert(!fs.existsSync(path.join(dir, '.gsd', '.locks')), 'no .gsd/.locks/ created');
});

// ── 15. --watch (bounded via env cap) (S03) ──────────────────────────────────
console.log('15. --watch (bounded via env cap)');

function runWatch(dir, extraArgs, maxFrames) {
  return spawnSync(process.execPath, [CLI_PATH, '--watch=0.05', '--cwd', dir, ...(extraArgs || [])], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
    env: { ...process.env, FORGE_STATUS_WATCH_MAX: String(maxFrames || 2) },
  });
}

test('--watch bounded by FORGE_STATUS_WATCH_MAX exits 0 with exactly N frames, no kill signal', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = runWatch(dir, [], 2);
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.signal == null, `expected no kill signal, got ${res.signal}`);
  const frameCount = res.stdout.split('## Status GSD').length - 1;
  assertEq(frameCount, 2, 'exactly 2 rendered frames');
});

test('--watch appends per-frame divider and never emits clear-screen escapes', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = runWatch(dir, [], 2);
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.includes('refresh #'), 'per-frame divider present');
  assert(!res.stdout.includes('\x1b[2J') && !res.stdout.includes('\x1b[H') && !res.stdout.includes('\x1bc'), 'no clear-screen escape codes');
});

test('--watch bounded run leaves .gsd/ byte-for-byte unchanged, creates no .gsd/.locks/', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const before = snapshot(dir);
  const res = runWatch(dir, [], 3);
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const after = snapshot(dir);
  assertEq(after, before, 'snapshot must be identical before/after --watch run');
  assert(!fs.existsSync(path.join(dir, '.gsd', '.locks')), 'no .gsd/.locks/ created');
});

test('--watch tolerates a torn/truncated ROADMAP across frames, still exits 0', () => {
  const { dir } = makeFixture({
    runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }],
    roadmapText: ROADMAP_TEXT.slice(0, 20),
  });
  const res = runWatch(dir, [], 2);
  assert(res.status === 0, `expected exit 0 despite torn ROADMAP, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.length > 0, 'produced frame output');
});

test('--watch tolerates a missing STATE.md across frames, still exits 0', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  fs.unlinkSync(path.join(dir, '.gsd', 'milestones', milestoneId, `${milestoneId}-STATE.md`));
  const res = runWatch(dir, [], 2);
  assert(res.status === 0, `expected exit 0 despite missing STATE.md, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.stdout.length > 0, 'produced frame output');
});

test('--watch --tokens repeats the token block once per frame, exits 0', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const ts1 = '2026-07-02T19:00:00Z';
  writeEventsFixture(dir, milestoneId, {
    perMsLines: [{ ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, agent: 'forge-executor', status: 'done' }],
    globalLines: [{ ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 }],
  });
  const res = runWatch(dir, ['--tokens'], 2);
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  const blockCount = res.stdout.split('### Token usage').length - 1;
  assertEq(blockCount, 2, 'token block appears once per frame');
});

test('bare --watch (default interval) capped at 1 frame via env still exits 0 quickly', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--watch', '--cwd', dir], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
    env: { ...process.env, FORGE_STATUS_WATCH_MAX: '1' },
  });
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.signal == null, `expected no kill signal, got ${res.signal}`);
  const frameCount = res.stdout.split('## Status GSD').length - 1;
  assertEq(frameCount, 1, 'exactly 1 rendered frame (first frame renders immediately)');
});

// ── R1 fix: --watch= (empty value) must enter watch mode, not fall through ──
test('R1: --watch= (empty value) enters watch mode (bounded frames), not single-shot', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--watch=', '--cwd', dir], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
    env: { ...process.env, FORGE_STATUS_WATCH_MAX: '2' },
  });
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.signal == null, `expected no kill signal, got ${res.signal}`);
  assert(res.stdout.includes('refresh #'), 'watch-mode per-frame divider present (not single-shot)');
  const frameCount = res.stdout.split('## Status GSD').length - 1;
  assertEq(frameCount, 2, 'exactly 2 rendered frames (watch mode honored default interval)');
});

test('R1: --watch=abc (non-numeric) is rejected with exit 2', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--watch=abc', '--cwd', dir], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
  });
  assert(res.status === 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
});

// ── R3 fix: FORGE_STATUS_WATCH_MAX=0 must render zero frames, exit 0, no hang ──
test('R3: FORGE_STATUS_WATCH_MAX=0 exits 0 with ZERO frames rendered, no hang', () => {
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const res = spawnSync(process.execPath, [CLI_PATH, '--watch=0.05', '--cwd', dir], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
    env: { ...process.env, FORGE_STATUS_WATCH_MAX: '0' },
  });
  assert(res.status === 0, `expected exit 0, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.signal == null, `expected no kill signal (would indicate hang/timeout), got ${res.signal}`);
  const frameCount = res.stdout.split('## Status GSD').length - 1;
  assertEq(frameCount, 0, 'zero milestone-header renders');
});

// ── R4 fix: --watch <bad-id> must fail fast (exit 2), not loop forever ──
test('R4: --watch <valid-format-but-nonexistent-id> exits 2, not a hang, not exit 0', () => {
  const res = spawnSync(process.execPath, [
    CLI_PATH, 'M-20990101000000-ghost', '--watch=0.05', '--cwd', makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] }).dir,
  ], {
    encoding: 'utf8',
    input: '',
    timeout: 10000,
    env: { ...process.env, FORGE_STATUS_WATCH_MAX: '3' },
  });
  assert(res.status === 2, `expected exit 2, got ${res.status}\nstderr: ${res.stderr}`);
  assert(res.signal == null, `expected no kill signal (would indicate hang/timeout), got ${res.signal}`);
  assert(res.stderr.includes('não encontrado'), 'stderr carries the not-found pt-BR message');
});

// ── R2: SIGINT handler — real spawn + signal, guarded on win32 ──────────────
// NOTE: `test()` in this harness is synchronous (fn() is called and awaited
// inline, no Promise support) — so this test must block synchronously too,
// via a shell script that backgrounds the child, sleeps, sends SIGINT, and
// waits, all inside one spawnSync call. Guarded off entirely on win32 (no
// POSIX `sh`/`kill`, and child.kill('SIGINT') is unreliable there anyway).
test('R2: --watch child process exits cleanly on SIGINT', () => {
  if (process.platform === 'win32') {
    console.log('      (skipped — SIGINT test skipped on win32, unreliable via child.kill; verify manually via UAT)');
    passed++;
    return;
  }
  const { dir } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const nodeBin = process.execPath;
  const script = `"${nodeBin}" "${CLI_PATH}" --watch=0.5 --cwd "${dir}" >/dev/null 2>&1 & pid=$!; sleep 0.2; kill -INT $pid; wait $pid; echo "EXIT:$?"`;
  const res = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', timeout: 8000 });
  const m = (res.stdout || '').match(/EXIT:(\d+)/);
  assert(m, `expected EXIT:<code> marker in stdout, got: ${res.stdout}\nstderr: ${res.stderr}`);
  assertEq(m[1], '0', 'child exited with code 0 after SIGINT');
});

test('--watch=0.05 in-process: collect()+renderTree() reflects an external STATE change across two calls', () => {
  const { dir, milestoneId } = makeFixture({ runs: [{ id: 'M-20260101120000-alpha', startedAt: 1000 }] });
  const r1 = status.renderTree(status.collect(dir, {}));
  fs.writeFileSync(
    path.join(dir, '.gsd', 'milestones', milestoneId, `${milestoneId}-STATE.md`),
    stateText(milestoneId, { active_task: 'T03', next_action: 'Changed' }),
    'utf8'
  );
  const r2 = status.renderTree(status.collect(dir, {}));
  assert(r1 !== r2, 'render reflects external STATE change');
  assert(r2.includes('Changed'), 'new next_action rendered');
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
