#!/usr/bin/env node
// forge-smoke — End-to-end smoke test for M004+ multi-run primitives
//
// Runs all the script-level invariants the milestone established:
//   - runs.js CRUD + refresh-legacy-alias
//   - lock.js acquire/release/steal
//   - state.js read/write/migrate-legacy
//   - dashboard.js regen
//   - merger.js promote per-milestone → globals
//   - filelock.js cross-run conflict + steal
//   - repos.js + isolation.js prefs parsing
//   - cli-helpers.js refuse logic
//
// Designed to be cheap (~5s) and self-cleaning. Use as pre-release sanity check.
//
// Usage:
//   node scripts/forge-smoke.js
//   node scripts/forge-smoke.js --keep   # don't cleanup (debugging)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const KEEP = process.argv.includes('--keep');

let passes = 0;
let fails = 0;
const failures = [];

function pass(name) { passes++; process.stdout.write(`  ✓ ${name}\n`); }
function fail(name, detail) {
  fails++;
  failures.push({ name, detail });
  process.stdout.write(`  ✗ ${name}\n    ${detail}\n`);
}

function assert(cond, name, detail) {
  if (cond) pass(name);
  else fail(name, detail || 'assertion failed');
}

function runScript(name, args, opts) {
  opts = opts || {};
  const r = spawnSync('node', [path.join(SCRIPTS, name), ...args], { encoding: 'utf8', ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function mkTmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-smoke-${label}-`));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  if (KEEP) {
    process.stdout.write(`  (kept ${dir})\n`);
    return;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Section 1: forge-runs CRUD ─────────────────────────────────────────────
function smokeRuns() {
  process.stdout.write('\n[1/8] forge-runs\n');
  const dir = mkTmp('runs');

  // list empty
  let r = runScript('forge-runs.js', ['--list', '--cwd', dir]);
  assert(r.status === 0 && r.stdout.trim() === '[]', 'list empty returns []', `got: ${r.stdout}`);

  // add milestone
  r = runScript('forge-runs.js', ['--add', '--id', 'M001', '--kind', 'milestone', '--session', 'sess-a', '--cwd', dir]);
  assert(r.status === 0, 'add M001', r.stderr);
  const m1 = JSON.parse(r.stdout);
  assert(m1.id === 'M001' && m1.kind === 'milestone', 'add returns valid record', JSON.stringify(m1));

  // get
  r = runScript('forge-runs.js', ['--get', 'M001', '--cwd', dir]);
  const g = JSON.parse(r.stdout);
  assert(g.id === 'M001', 'get M001 returns record');

  // refresh-legacy-alias produced auto-mode.json mirror
  const alias = JSON.parse(fs.readFileSync(path.join(dir, '.gsd/forge/auto-mode.json'), 'utf8'));
  assert(alias.active === true && alias.started_at === m1.started_at, 'auto-mode.json mirrors first run');

  // update worker
  r = runScript('forge-runs.js', ['--update', 'M001', '--json', '{"worker":"execute-task/T03"}', '--cwd', dir]);
  assert(r.status === 0, 'update worker', r.stderr);
  const alias2 = JSON.parse(fs.readFileSync(path.join(dir, '.gsd/forge/auto-mode.json'), 'utf8'));
  assert(alias2.worker === 'execute-task/T03', 'alias reflects new worker');

  // remove
  r = runScript('forge-runs.js', ['--remove', 'M001', '--cwd', dir]);
  assert(r.status === 0, 'remove M001');
  const alias3 = JSON.parse(fs.readFileSync(path.join(dir, '.gsd/forge/auto-mode.json'), 'utf8'));
  assert(alias3.active === false, 'alias deactivates when no runs');

  cleanup(dir);
}

// ── Section 2: forge-lock acquire/release/steal ─────────────────────────────
function smokeLock() {
  process.stdout.write('\n[2/8] forge-lock\n');
  const dir = mkTmp('lock');

  let r = runScript('forge-lock.js', ['--acquire', 'DECISIONS.md', '--ttl', '5000', '--cwd', dir]);
  assert(r.status === 0, 'acquire DECISIONS.md', r.stderr);

  r = runScript('forge-lock.js', ['--try-acquire', 'DECISIONS.md', '--ttl', '5000', '--cwd', dir]);
  assert(r.status === 1 && /busy/.test(r.stderr), 'try-acquire returns busy when held');

  r = runScript('forge-lock.js', ['--release', 'DECISIONS.md', '--cwd', dir]);
  assert(r.status === 0, 'release DECISIONS.md');

  r = runScript('forge-lock.js', ['--try-acquire', 'DECISIONS.md', '--ttl', '5000', '--cwd', dir]);
  assert(r.status === 0, 'try-acquire after release succeeds');
  runScript('forge-lock.js', ['--release', 'DECISIONS.md', '--cwd', dir]);

  cleanup(dir);
}

// ── Section 3: forge-state read/write/migrate-legacy ────────────────────────
function smokeState() {
  process.stdout.write('\n[3/8] forge-state + migrate-legacy\n');
  const dir = mkTmp('state');

  // Setup legacy STATE.md
  fs.writeFileSync(path.join(dir, '.gsd/STATE.md'), `# GSD State

**Active Milestone:** M042 — Test legacy
**Active Slice:** S03
**Active Task:** T01
**Phase:** execute-task
**Auto-mode:** on

## Next Action
Continue T01.
`);
  fs.mkdirSync(path.join(dir, '.gsd/milestones/M042'), { recursive: true });

  // Migrate
  let r = runScript('forge-runs.js', ['--migrate-legacy', '--cwd', dir]);
  assert(r.status === 0, 'migrate-legacy executes');
  const mig = JSON.parse(r.stdout);
  assert(mig.migrated === true && mig.milestoneId === 'M042', 'migration created M042-STATE.md');

  // Verify M042-STATE.md
  r = runScript('forge-state.js', ['--read', 'M042', '--cwd', dir]);
  assert(r.status === 0, 'read M042-STATE.md');
  const s = JSON.parse(r.stdout);
  assert(s.active_slice === 'S03' && s.active_task === 'T01' && s.phase === 'execute-task', 'fields preserved through migration');

  cleanup(dir);
}

// ── Section 4: forge-dashboard regen ────────────────────────────────────────
function smokeDashboard() {
  process.stdout.write('\n[4/8] forge-dashboard + cross-reference\n');
  const dir = mkTmp('dash');

  // Setup: 1 run + per-milestone STATE
  fs.mkdirSync(path.join(dir, '.gsd/milestones/M050'), { recursive: true });
  runScript('forge-state.js', [
    '--create', 'M050',
    '--phase', 'execute-task',
    '--next-action', 'continue',
    '--cwd', dir,
  ]);
  // Manually patch state to add active_slice (forge-state --create doesn't)
  const statePath = path.join(dir, '.gsd/milestones/M050/M050-STATE.md');
  let stateRaw = fs.readFileSync(statePath, 'utf8');
  stateRaw = stateRaw.replace('**Active Slice:** —', '**Active Slice:** S02');
  stateRaw = stateRaw.replace('**Active Task:** —', '**Active Task:** T04');
  fs.writeFileSync(statePath, stateRaw);

  runScript('forge-runs.js', ['--add', '--id', 'M050', '--kind', 'milestone', '--session', 'sess-d', '--cwd', dir]);

  let r = runScript('forge-dashboard.js', ['--cwd', dir]);
  assert(r.status === 0, 'dashboard regen exits ok', r.stderr);

  const dashboard = fs.readFileSync(path.join(dir, '.gsd/STATE.md'), 'utf8');
  assert(/AUTO-GENERATED/.test(dashboard), 'dashboard has AUTO-GENERATED header');
  assert(/\*\*M050\*\* — milestone · phase: execute-task/.test(dashboard), 'dashboard shows phase from STATE (not "—")');
  assert(/slice: S02/.test(dashboard), 'dashboard shows active_slice');
  assert(/task: T04/.test(dashboard), 'dashboard shows active_task');

  cleanup(dir);
}

// ── Section 5: forge-merger E2E ─────────────────────────────────────────────
function smokeMerger() {
  process.stdout.write('\n[5/8] forge-merger\n');
  const dir = mkTmp('merger');

  fs.mkdirSync(path.join(dir, '.gsd/milestones/M060'), { recursive: true });

  fs.writeFileSync(path.join(dir, '.gsd/milestones/M060/M060-DECISIONS.md'), `| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-M060-1 | choice X | reason | 2026-05-21 |
| D-M060-2 | choice Y | reason | 2026-05-21 |
`);

  fs.writeFileSync(path.join(dir, '.gsd/milestones/M060/M060-LEDGER-ENTRY.md'), `## M060 — Test milestone · 2026-05-21

One-line description.

**Slices:** S01 — test
**Key files:** a/b.ts
**Key decisions:** choice X · choice Y

---
`);

  fs.writeFileSync(path.join(dir, '.gsd/milestones/M060/M060-events.jsonl'), '{"ts":"2026-05-21T00:00:00Z","status":"done"}\n');

  let r = runScript('forge-merger.js', ['--milestone', 'M060', '--cwd', dir]);
  assert(r.status === 0, 'merger runs successfully', r.stderr);
  const result = JSON.parse(r.stdout);
  assert(result.merged.decisions === 2, '2 decisions merged');
  assert(result.merged.ledger === true, 'ledger merged');
  assert(result.merged.events === 1, '1 event merged');
  assert(result.errors.length === 0, 'no merger errors');

  // Verify globals
  const globalDecisions = fs.readFileSync(path.join(dir, '.gsd/DECISIONS.md'), 'utf8');
  assert(/D-M060-1/.test(globalDecisions) && /D-M060-2/.test(globalDecisions), 'global DECISIONS contains rows');

  const globalLedger = fs.readFileSync(path.join(dir, '.gsd/LEDGER.md'), 'utf8');
  assert(/## M060/.test(globalLedger), 'global LEDGER contains entry');

  cleanup(dir);
}

// ── Section 6: forge-filelock cross-run ─────────────────────────────────────
function smokeFilelock() {
  process.stdout.write('\n[6/8] forge-filelock\n');
  const dir = mkTmp('filelock');

  runScript('forge-runs.js', ['--add', '--id', 'M070', '--kind', 'milestone', '--session', 'sess-x', '--cwd', dir]);
  runScript('forge-runs.js', ['--add', '--id', 'M071', '--kind', 'milestone', '--session', 'sess-y', '--cwd', dir]);

  let r = runScript('forge-filelock.js', ['--acquire', 'src/foo.ts', '--run', 'M070', '--session', 'sess-x', '--cwd', dir]);
  assert(r.status === 0, 'M070 acquires src/foo.ts');
  let res = JSON.parse(r.stdout);
  assert(res.acquired === true, 'acquired:true on fresh acquire');

  r = runScript('forge-filelock.js', ['--acquire', 'src/foo.ts', '--run', 'M071', '--session', 'sess-y', '--cwd', dir]);
  assert(r.status === 1, 'M071 blocked');
  res = JSON.parse(r.stdout);
  assert(res.acquired === false && res.holder.run_id === 'M070', 'holder details surfaced');

  // M070 same-run renew
  r = runScript('forge-filelock.js', ['--acquire', 'src/foo.ts', '--run', 'M070', '--session', 'sess-x', '--cwd', dir]);
  assert(r.status === 0, 'M070 renews own lock');

  // Deactivate M070 → M071 can steal
  runScript('forge-runs.js', ['--update', 'M070', '--json', '{"active":false}', '--cwd', dir]);
  r = runScript('forge-filelock.js', ['--acquire', 'src/foo.ts', '--run', 'M071', '--session', 'sess-y', '--cwd', dir]);
  res = JSON.parse(r.stdout);
  assert(res.acquired === true && res.stolen && res.stolen.reason === 'inactive', 'M071 steals from inactive M070');

  cleanup(dir);
}

// ── Section 7: forge-repos auto-detect ─────────────────────────────────────
function smokeRepos() {
  process.stdout.write('\n[7/8] forge-repos\n');
  const dir = mkTmp('repos');

  fs.mkdirSync(path.join(dir, 'repo-a/.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo-b/.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'not-a-repo'), { recursive: true });

  const r = runScript('forge-repos.js', ['--list', '--cwd', dir]);
  assert(r.status === 0, 'forge-repos --list runs');
  const repos = r.stdout.trim().split('\n').filter(Boolean);
  assert(repos.length === 2, `expected 2 repos found, got ${repos.length}`, repos.join('\n'));
  assert(repos.some(p => /repo-a/.test(p)), 'repo-a discovered');
  assert(repos.some(p => /repo-b/.test(p)), 'repo-b discovered');
  assert(!repos.some(p => /not-a-repo/.test(p)), 'non-git dir excluded');

  cleanup(dir);
}

// ── Section 8: forge-cli-helpers refuse logic ───────────────────────────────
function smokeCliHelpers() {
  process.stdout.write('\n[8/8] forge-cli-helpers\n');
  const dir = mkTmp('cli');

  // 0 active + no arg → legacy
  let r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', '', '--command', 'forge-auto', '--cwd', dir]);
  assert(r.status === 0, 'resolve-args 0/empty runs');
  let res = JSON.parse(r.stdout);
  assert(res.status === 'legacy', '0 active + no arg → legacy');

  // M001 arg → activate-new
  r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', 'M001', '--command', 'forge-auto', '--cwd', dir]);
  res = JSON.parse(r.stdout);
  assert(res.status === 'activate-new' && res.run_id === 'M001', 'M001 → activate-new');

  // Add 2 runs → no arg → refuse
  runScript('forge-runs.js', ['--add', '--id', 'M001', '--kind', 'milestone', '--session', 's1', '--cwd', dir]);
  runScript('forge-runs.js', ['--add', '--id', 'M002', '--kind', 'milestone', '--session', 's2', '--cwd', dir]);

  r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', '', '--command', 'forge-auto', '--cwd', dir]);
  res = JSON.parse(r.stdout);
  assert(res.status === 'refuse', '2+ active + no arg → refuse');
  assert(/M001/.test(res.message) && /M002/.test(res.message), 'refuse message lists active runs');

  // Remove one → resume (1 active)
  runScript('forge-runs.js', ['--remove', 'M002', '--cwd', dir]);
  r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', '', '--command', 'forge-auto', '--cwd', dir]);
  res = JSON.parse(r.stdout);
  assert(res.status === 'resume' && res.run_id === 'M001', '1 active + no arg → resume that one');

  // newTaskId
  r = runScript('forge-cli-helpers.js', ['--new-task-id', '--description', 'fix typo in readme']);
  assert(/^task-fix-typo-in-readme-[a-f0-9]{4}$/.test(r.stdout.trim()), 'newTaskId format');

  cleanup(dir);
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  process.stdout.write('forge-smoke — M004+ multi-run primitives\n');
  process.stdout.write('─'.repeat(50) + '\n');

  const start = Date.now();
  try {
    smokeRuns();
    smokeLock();
    smokeState();
    smokeDashboard();
    smokeMerger();
    smokeFilelock();
    smokeRepos();
    smokeCliHelpers();
  } catch (e) {
    fail('unhandled exception', e.stack || e.message);
  }

  const ms = Date.now() - start;
  process.stdout.write('\n' + '─'.repeat(50) + '\n');
  process.stdout.write(`Results: ${passes} passed, ${fails} failed (${ms}ms)\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  ✗ ${f.name}: ${f.detail}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) main();
