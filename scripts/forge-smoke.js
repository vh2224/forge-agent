#!/usr/bin/env node
// forge-smoke — End-to-end smoke test for M004+ multi-run primitives
//
// Runs all the script-level invariants the milestone established:
//   - runs.js CRUD + refresh-legacy-alias
//   - lock.js acquire/release/steal
//   - state.js read/write/migrate-legacy (legacy M### AND timestamp M-<ts> IDs)
//   - dashboard.js regen
//   - merger.js promote per-milestone → globals
//   - filelock.js cross-run conflict + steal
//   - repos.js + isolation.js prefs parsing
//   - cli-helpers.js refuse logic + timestamp/legacy ID resolution (paired)
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
  process.stdout.write('\n[1/16] forge-runs\n');
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
  process.stdout.write('\n[2/16] forge-lock\n');
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
  process.stdout.write('\n[3/16] forge-state + migrate-legacy\n');
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

  // ── Paired: timestamp M-<ts> migration ──────────────────────────────────
  const dir2 = mkTmp('state-ts');
  const tsId = 'M-20260522143012-oauth';
  fs.writeFileSync(path.join(dir2, '.gsd/STATE.md'), `# GSD State

**Active Milestone:** ${tsId} — Timestamp migration test
**Active Slice:** S01
**Active Task:** T02
**Phase:** execute-task
**Auto-mode:** on

## Next Action
Continue T02.
`);
  fs.mkdirSync(path.join(dir2, `.gsd/milestones/${tsId}`), { recursive: true });

  r = runScript('forge-runs.js', ['--migrate-legacy', '--cwd', dir2]);
  assert(r.status === 0, 'migrate-legacy executes (timestamp id)');
  const mig2 = JSON.parse(r.stdout);
  assert(mig2.migrated === true && mig2.milestoneId === tsId, `migration created ${tsId}-STATE.md`);

  cleanup(dir2);
  cleanup(dir);
}

// ── Section 4: forge-dashboard regen ────────────────────────────────────────
function smokeDashboard() {
  process.stdout.write('\n[4/16] forge-dashboard + cross-reference\n');
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
  process.stdout.write('\n[5/16] forge-merger\n');
  const dir = mkTmp('merger');

  fs.mkdirSync(path.join(dir, '.gsd/milestones/M060'), { recursive: true });

  // Post-D9 (M001/S02–S05): mergeMilestone consumes ONLY events.jsonl. Decisions,
  // memory and checker now live in per-unit fragment stores (.gsd/{decisions,memory,
  // checker-memory}/) and the global monoliths are regenerated via projection in
  // complete-milestone — the merger no longer reads M###-DECISIONS.md / M###-LEDGER-
  // ENTRY.md nor writes .gsd/DECISIONS.md / .gsd/LEDGER.md. We still seed a stale
  // M060-DECISIONS.md to prove the deprecated path stays dormant (merged.decisions=0).
  fs.writeFileSync(path.join(dir, '.gsd/milestones/M060/M060-DECISIONS.md'), `| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-M060-1 | choice X | reason | 2026-05-21 |
| D-M060-2 | choice Y | reason | 2026-05-21 |
`);

  fs.writeFileSync(path.join(dir, '.gsd/milestones/M060/M060-events.jsonl'), '{"ts":"2026-05-21T00:00:00Z","status":"done"}\n');

  let r = runScript('forge-merger.js', ['--milestone', 'M060', '--cwd', dir]);
  assert(r.status === 0, 'merger runs successfully', r.stderr);
  const result = JSON.parse(r.stdout);
  assert(result.merged.events === 1, '1 event merged');
  assert(result.merged.decisions === 0, 'decisions NOT merged (fragment store owns them post-D9)');
  assert(result.merged.memories === 0, 'memories NOT merged (fragment store owns them post-D9)');
  assert(result.errors.length === 0, 'no merger errors');

  // The merger appends per-milestone events to the global event log.
  const globalEventsPath = path.join(dir, '.gsd/forge/events.jsonl');
  assert(fs.existsSync(globalEventsPath), 'global events.jsonl created');
  const globalEvents = fs.readFileSync(globalEventsPath, 'utf8');
  assert(/"status":"done"/.test(globalEvents), 'global events contains merged line');

  // Guard monolith reads behind existsSync so a regression here degrades to a failed
  // assert, never an unhandled ENOENT that aborts the whole smoke run (issue #11).
  // Post-D9 the merger must NOT fabricate these monoliths — they are projection output.
  const globalDecisionsPath = path.join(dir, '.gsd/DECISIONS.md');
  assert(!fs.existsSync(globalDecisionsPath), 'merger does not write global DECISIONS.md (projection owns it)');

  const globalLedgerPath = path.join(dir, '.gsd/LEDGER.md');
  assert(!fs.existsSync(globalLedgerPath), 'merger does not write global LEDGER.md (projection owns it)');

  cleanup(dir);
}

// ── Section 6: forge-filelock cross-run ─────────────────────────────────────
function smokeFilelock() {
  process.stdout.write('\n[6/16] forge-filelock\n');
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
  process.stdout.write('\n[7/16] forge-repos\n');
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
  process.stdout.write('\n[8/16] forge-cli-helpers\n');
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

  // ── Timestamp milestone ID → activate-new (paired with M001 legacy above) ──
  const dir2 = mkTmp('cli-ts');
  const tsMs = 'M-20260522143012-oauth';
  r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', tsMs, '--command', 'forge-auto', '--cwd', dir2]);
  res = JSON.parse(r.stdout);
  assert(res.status === 'activate-new' && res.run_id === tsMs, `${tsMs} → activate-new`);
  assert(res.kind === 'milestone', `${tsMs} recognized as kind:milestone`);

  // Timestamp task ID — register then resolve → kind:task, status:resume
  const tsTask = 'T-20260522143012-fix-typo';
  runScript('forge-runs.js', ['--add', '--id', tsTask, '--kind', 'task', '--session', 'sess-ts', '--cwd', dir2]);
  r = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', tsTask, '--command', 'forge-auto', '--cwd', dir2]);
  res = JSON.parse(r.stdout);
  assert(res.kind === 'task', `${tsTask} recognized as kind:task`);
  assert(res.status === 'resume', `${tsTask} returns resume when registered`);

  cleanup(dir2);

  // newTaskId — format changed in T01: now T-<ts>-<slug> (replaces stale legacy regex)
  // Hermeticity: forge-ids honra a pref global ids.format — pin no formato esperado
  // para o assert não depender do ~/.claude do dev (achado do M-20260604002929).
  r = runScript('forge-ids.js', ['--new-task', 'fix typo in readme', '--format', 'timestamp']);
  assert(/^T-\d{14}(-[a-z0-9-]+)?$/.test(r.stdout.trim()), 'newTaskId format is T-<14digits>-<slug>');

  cleanup(dir);
}

// ── Section 9: forge-isolation prefs + setup/cleanup ────────────────────────
function smokeIsolation() {
  process.stdout.write('\n[9/16] forge-isolation\n');
  const dir = mkTmp('iso');
  // Isolate HOME so the operator's real ~/.claude/forge-agent-prefs.md never leaks in
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };

  function git(args, cwd) {
    return spawnSync('git', args, { cwd, encoding: 'utf8', env });
  }

  // Sandbox git repo
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.gsd'), { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  git(['add', 'a.txt'], repo);
  git(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], repo);

  // Prefs block at END OF FILE on purpose — regression guard for the `\Z` regex bug
  // (JS has no \Z; blocks at EOF were silently ignored and mode stayed "shared")
  fs.writeFileSync(path.join(repo, '.gsd', 'prefs.local.md'),
    'forge_isolation:\n  mode: branch\n  auto_pull_main: false\n');

  let r = runScript('forge-isolation.js', ['--prefs', '--cwd', repo], { env });
  let res = JSON.parse(r.stdout);
  assert(res.mode === 'branch', 'prefs block at EOF is parsed (regex \\Z regression)', r.stdout);

  // branch mode: setup creates + checks out forge/{run}
  r = runScript('forge-isolation.js', ['--setup', '--run', 'M-SMOKE', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  assert(res.mode === 'branch' && res.repos[0] && res.repos[0].status === 'created', 'branch setup creates forge/M-SMOKE', r.stdout);
  let cur = git(['branch', '--show-current'], repo).stdout.trim();
  assert(cur === 'forge/M-SMOKE', 'repo is on forge/M-SMOKE after setup', cur);

  // idempotent re-run
  r = runScript('forge-isolation.js', ['--setup', '--run', 'M-SMOKE', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  assert(res.repos[0].status === 'already-on-branch', 'branch setup is idempotent', r.stdout);

  // cleanup: back to default, branch preserved
  r = runScript('forge-isolation.js', ['--cleanup', '--run', 'M-SMOKE', '--cwd', repo], { env });
  cur = git(['branch', '--show-current'], repo).stdout.trim();
  assert(cur === 'main', 'branch cleanup checks out default', cur);
  const branches = git(['branch', '--list'], repo).stdout;
  assert(/forge\/M-SMOKE/.test(branches), 'forge branch preserved after cleanup (PR-able)', branches);

  // worktree mode: setup creates physical worktree; cleanup respects pref
  fs.writeFileSync(path.join(repo, '.gsd', 'prefs.local.md'),
    'forge_isolation:\n  mode: worktree\n  auto_pull_main: false\n  worktree_cleanup_on_complete: true\n');
  r = runScript('forge-isolation.js', ['--setup', '--run', 'M-SMOKE-WT', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  const wt = res.repos[0] && res.repos[0].worktree;
  assert(res.mode === 'worktree' && wt && fs.existsSync(wt), 'worktree setup creates physical worktree', r.stdout);

  r = runScript('forge-isolation.js', ['--cleanup', '--run', 'M-SMOKE-WT', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  assert(res.repos[0].status === 'removed' && !fs.existsSync(wt), 'worktree cleanup removes when pref true', r.stdout);

  // dirty worktree: cleanup must SKIP and preserve uncommitted work even with pref true
  // (regression guard — 2026-06-10 incident: --force removal discarded an uncommitted milestone)
  r = runScript('forge-isolation.js', ['--setup', '--run', 'M-SMOKE-WT2', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  const wt2 = res.repos[0] && res.repos[0].worktree;
  assert(wt2 && fs.existsSync(wt2), 'worktree setup creates second worktree', r.stdout);
  fs.writeFileSync(path.join(wt2, 'uncommitted.txt'), 'work in progress\n');
  r = runScript('forge-isolation.js', ['--cleanup', '--run', 'M-SMOKE-WT2', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  assert(/^skipped \(dirty\)/.test(res.repos[0].status) && fs.existsSync(wt2),
    'dirty worktree cleanup skips removal and preserves uncommitted work', r.stdout);
  // after committing, the same cleanup removes the now-clean worktree
  git(['add', 'uncommitted.txt'], wt2);
  git(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-qm', 'wip'], wt2);
  r = runScript('forge-isolation.js', ['--cleanup', '--run', 'M-SMOKE-WT2', '--cwd', repo], { env });
  res = JSON.parse(r.stdout);
  assert(res.repos[0].status === 'removed' && !fs.existsSync(wt2), 'clean worktree cleanup removes after commit', r.stdout);

  // auto_pull_main: worktree must branch from FRESH origin/<def>, not the stale
  // local main (2026-06-17 incident: forge/M099 forked from a local main that was
  // 13 commits behind origin because nobody ran `git pull` on it). Setup:
  //   bare origin ← clone ← advance origin by one commit (local main stays behind)
  // then a worktree setup with auto_pull_main:true must contain the new commit.
  const origin = path.join(dir, 'origin.git');
  git(['init', '-q', '--bare', '-b', 'main', origin], dir);
  const clone = path.join(dir, 'clone');
  git(['clone', '-q', origin, clone], dir);
  fs.mkdirSync(path.join(clone, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'base.txt'), 'v1\n');
  git(['add', 'base.txt'], clone);
  git(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-qm', 'v1'], clone);
  git(['push', '-q', 'origin', 'main'], clone);
  // Advance origin from a SEPARATE checkout so the clone's local main stays behind.
  const pusher = path.join(dir, 'pusher');
  git(['clone', '-q', origin, pusher], dir);
  fs.writeFileSync(path.join(pusher, 'fresh.txt'), 'from-origin\n');
  git(['add', 'fresh.txt'], pusher);
  git(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-qm', 'fresh-on-origin'], pusher);
  git(['push', '-q', 'origin', 'main'], pusher);
  // Sanity: the clone's local main does NOT have fresh.txt yet (never pulled).
  const localHasFresh = fs.existsSync(path.join(clone, 'fresh.txt'));
  assert(!localHasFresh, 'clone local main is stale before setup (no fresh.txt)', String(localHasFresh));

  fs.writeFileSync(path.join(clone, '.gsd', 'prefs.local.md'),
    'forge_isolation:\n  mode: worktree\n  auto_pull_main: true\n');
  r = runScript('forge-isolation.js', ['--setup', '--run', 'M-FRESH', '--cwd', clone], { env });
  res = JSON.parse(r.stdout);
  const wtF = res.repos[0] && res.repos[0].worktree;
  assert(res.repos[0].base === 'origin/main', 'worktree base is origin/main, not local main', r.stdout);
  assert(wtF && fs.existsSync(path.join(wtF, 'fresh.txt')),
    'worktree branches from fresh origin/main (contains commit local main lacked)', r.stdout);

  cleanup(dir);
}

// ── Section 11: symbol-check (MISSING + greenfield) + test-quality (it.skip) ─
const { auditTestQuality } = require('./forge-verifier');

function smokeSymbolAndTestQuality() {
  process.stdout.write('\n[11/16] symbol-check + test-quality\n');
  const dir = mkTmp('s02');

  // Create a small code file with a known function
  fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'code', 'real.js'),
    'function knownFn() { return 1; }\nmodule.exports = { knownFn };\n'
  );

  // ── Assert #1: MISSING — ghostFn referenced but not defined anywhere ─────
  // Plan references `ghostFn` in ## Steps; ghostFn is NOT in artifacts/expected_output
  // → should appear in symbols[] with state MISSING
  const planMissingContent = `---
must_haves:
  truths:
    - "knownFn exists"
  artifacts:
    - path: "code/real.js"
      provides: "knownFn function"
      min_lines: 1
  key_links:
    - from: "code/real.js"
      to: "code/real.js"
      via: "knownFn"
expected_output:
  - code/real.js
---

## Steps

Use \`ghostFn\` to do the thing. Also use \`knownFn\` from real.js.
`;
  const planMissingPath = path.join(dir, 'plan-missing.md');
  fs.writeFileSync(planMissingPath, planMissingContent);

  let r = runScript('forge-symbol-check.js', ['--check', planMissingPath, '--cwd', dir]);
  let symbolResult;
  try { symbolResult = JSON.parse(r.stdout); } catch (e) { symbolResult = null; }
  assert(symbolResult !== null, 'symbol-check #1 returns valid JSON', `stderr: ${r.stderr} stdout: ${r.stdout}`);
  assert(
    symbolResult !== null && symbolResult.symbols && symbolResult.symbols.some(s => s.symbol === 'ghostFn' && s.state === 'MISSING'),
    'symbol-check #1: ghostFn detected as MISSING',
    `symbols: ${JSON.stringify(symbolResult && symbolResult.symbols)}`
  );

  // ── Assert #2: greenfield — newThing declared as artifact → NOT MISSING ───
  // artifacts[].path = 'code/newThing.js' → basename 'newThing' is greenfield
  // Plan references `newThing`; it's absent from code/ but should NOT appear as MISSING
  const planGreenfieldContent = `---
must_haves:
  truths:
    - "newThing module exists"
  artifacts:
    - path: "code/newThing.js"
      provides: "newThing module"
      min_lines: 10
  key_links: []
expected_output:
  - code/newThing.js
---

## Steps

Implement \`newThing\` in code/newThing.js.
`;
  const planGreenfieldPath = path.join(dir, 'plan-greenfield.md');
  fs.writeFileSync(planGreenfieldPath, planGreenfieldContent);

  r = runScript('forge-symbol-check.js', ['--check', planGreenfieldPath, '--cwd', dir]);
  let gfResult;
  try { gfResult = JSON.parse(r.stdout); } catch (e) { gfResult = null; }
  assert(gfResult !== null, 'symbol-check #2 returns valid JSON', `stderr: ${r.stderr}`);
  assert(
    gfResult !== null && !(gfResult.symbols || []).some(s => s.symbol === 'newThing' && s.state === 'MISSING'),
    'symbol-check #2: newThing NOT listed as MISSING (greenfield excluded)',
    `symbols: ${JSON.stringify(gfResult && gfResult.symbols)}`
  );

  // ── Assert #3: test-quality — it.skip triggers disabled-test flag ─────────
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  const testContent = `describe('foo', () => {
  it('passes normally', () => {
    expect(1 + 1).toBe(2);
  });
  it.skip('this is skipped', () => {
    expect(true).toBe(true);
  });
});
`;
  fs.writeFileSync(path.join(dir, 'tests', 'foo.test.js'), testContent);

  const artifact = { path: 'tests/foo.test.js', provides: 'test', min_lines: 1 };
  const tqResult = auditTestQuality(testContent, artifact);
  assert(
    tqResult && tqResult.flags && tqResult.flags.some(f => f.level === 'test-quality' && f.reason === 'disabled-test'),
    'test-quality #3: it.skip triggers disabled-test flag',
    `flags: ${JSON.stringify(tqResult && tqResult.flags)}`
  );

  cleanup(dir);
}

// ── Section 10: Spawn Liveness Banner presence ──────────────────────────────
function smokeLivenessBanner() {
  process.stdout.write('\n[10/16] liveness-banner\n');
  const root = path.join(SCRIPTS, '..');

  // Assert canonical phrase + section in shared/forge-dispatch.md
  const dispatchPath = path.join(root, 'shared', 'forge-dispatch.md');
  const dispatch = fs.readFileSync(dispatchPath, 'utf8');
  assert(
    /roda em subagente/.test(dispatch),
    'canonical liveness phrase present in forge-dispatch.md',
    'expected "roda em subagente" substring in shared/forge-dispatch.md'
  );
  assert(
    /## Spawn Liveness Banner/.test(dispatch),
    'Spawn Liveness Banner section exists in forge-dispatch.md',
    'expected "## Spawn Liveness Banner" heading in shared/forge-dispatch.md'
  );

  // Assert each spawn-point SKILL.md references the banner
  const spawnSkills = ['forge-auto', 'forge-next', 'forge-task', 'forge-new-milestone'];
  for (const skill of spawnSkills) {
    const skillPath = path.join(root, 'skills', skill, 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    assert(
      /Spawn Liveness Banner/.test(content),
      `${skill} SKILL.md references Spawn Liveness Banner`,
      `expected "Spawn Liveness Banner" in skills/${skill}/SKILL.md`
    );
  }
}

// ── Section 12: context-monitor (bridge severity + stale + debounce + prefs) ─
const cm = require('./forge-context-monitor');

function smokeContextMonitor() {
  process.stdout.write('\n[12/16] context-monitor\n');

  // severity from bridge fixtures
  assert(cm.severityFor(0.20) === 'critical', 'ctx #1: 0.20 remaining → critical', `got ${cm.severityFor(0.20)}`);
  assert(cm.severityFor(0.50) === 'none', 'ctx #2: 0.50 remaining → none (silence)', `got ${cm.severityFor(0.50)}`);
  assert(cm.severityFor(0.30) === 'warning', 'ctx #3: 0.30 remaining → warning', `got ${cm.severityFor(0.30)}`);
  // R5 (review S03): override de thresholds — mesmo call pattern do hook (prefs.thresholds)
  const customT = { warning: 0.50, critical: 0.40 };
  assert(cm.severityFor(0.45, customT) === 'warning', 'ctx #3b: 0.45 com warning=0.50 custom → warning', `got ${cm.severityFor(0.45, customT)}`);
  assert(cm.severityFor(0.30, customT) === 'critical', 'ctx #3c: 0.30 com critical=0.40 custom → critical', `got ${cm.severityFor(0.30, customT)}`);

  // stale
  const now = Date.now();
  assert(cm.isStale(now - 61_000, now) === true, 'ctx #4: ts 61s old → stale (ignored)');
  assert(cm.isStale(now - 30_000, now) === false, 'ctx #5: ts 30s old → fresh');

  // debounce + escalation
  const warmUp = cm.shouldInject('warning', { lastSeverity: 'none', toolUsesSinceLast: 0 });
  assert(warmUp.inject === true, 'ctx #6: first warning injects');
  const debounced = cm.shouldInject('warning', { lastSeverity: 'warning', toolUsesSinceLast: 2 });
  assert(debounced.inject === false, 'ctx #7: warning within debounce window suppressed');
  const escalated = cm.shouldInject('critical', { lastSeverity: 'warning', toolUsesSinceLast: 1 });
  assert(escalated.inject === true, 'ctx #8: warning→critical escalation pierces debounce');

  // additionalContext content
  assert(/continue\.md/.test(cm.buildAdditionalContext('critical')) && /partial/.test(cm.buildAdditionalContext('critical')),
    'ctx #9: critical additionalContext mentions continue.md + partial');

  // prefs scaffold present in forge-agent-prefs.md
  const prefs = fs.readFileSync(path.join(SCRIPTS, '..', 'forge-agent-prefs.md'), 'utf8');
  assert(/## Context Monitor Settings/.test(prefs), 'ctx #10: prefs section present');
  assert(/context_monitor:/.test(prefs) && /enabled:/.test(prefs), 'ctx #11: context_monitor.enabled key present');
}

// ── Main ────────────────────────────────────────────────────────────────────
// ── Section 13: node-repair invariants ────────────────────────────────────────

function smokeNodeRepair() {
  process.stdout.write('\n[13/16] node-repair\n');

  const dispatchPath = path.join(path.dirname(SCRIPTS), 'shared', 'forge-dispatch.md');
  const parallelismPath = path.join(SCRIPTS, 'forge-parallelism.js');
  const plannerPath = path.join(path.dirname(SCRIPTS), 'agents', 'forge-planner.md');
  const autoSkillPath = path.join(path.dirname(SCRIPTS), 'skills', 'forge-auto', 'SKILL.md');

  // B1 — Precedence: forge-dispatch.md has ## Node Repair + 3 layers named + context_overflow + NEVER near PRUNE
  const dispatch = fs.readFileSync(dispatchPath, 'utf8');
  assert(dispatch.includes('## Node Repair'), 'dispatch has ## Node Repair section');
  assert(dispatch.includes('Retry Handler'), 'dispatch names layer 1: Retry Handler');
  assert(dispatch.includes('Failure Taxonomy'), 'dispatch names layer 2: Failure Taxonomy');
  assert(dispatch.includes('Node Repair'), 'dispatch names layer 3: Node Repair');
  assert(dispatch.includes('context_overflow'), 'dispatch mentions context_overflow');
  // PRUNE must not be triggered for context_overflow — check NEVER/NUNCA near PRUNE in the section
  const nodeRepairSection = dispatch.slice(dispatch.indexOf('## Node Repair'));
  // R8 (review S04): bound ao(s) parágrafo(s) que mencionam context_overflow —
  // um NEVER em frase não relacionada da seção não pode satisfazer este guard.
  const coParagraphs = nodeRepairSection
    .split(/\n[ \t]*\n/)
    .filter(par => par.includes('context_overflow'))
    .join('\n\n');
  assert(
    coParagraphs.includes('NEVER') || coParagraphs.includes('NUNCA') ||
    coParagraphs.toLowerCase().includes('never') || coParagraphs.includes('silently discard'),
    'dispatch Node Repair: parágrafo(s) de context_overflow contém guard NEVER/NUNCA→PRUNE'
  );

  // B1 — Critical suppression: classify with severity:critical + decompose signals → strategy blocked
  const criticalInput = JSON.stringify({
    failure_shape: 'missing_artifacts',
    severity: 'critical',
    worker_explained: false,
    signals: { missing_artifacts: 2, substantive_false: 1, wired_false: 0, symbol_missing: 0,
      test_quality: { disabled: 0, weak: 0 }, is_large_task: false }
  });
  const classifyCritical = runScript('forge-repair.js', ['--classify', criticalInput]);
  assert(classifyCritical.status === 0, 'classify with critical severity exits 0');
  let critResult;
  try { critResult = JSON.parse(classifyCritical.stdout); } catch { critResult = {}; }
  assert(critResult.strategy === 'blocked',
    'critical severity forces strategy=blocked (no DECOMPOSE/PRUNE under low context)',
    `got strategy=${critResult.strategy}`);

  // B2/MEM009 — Budget cap: repair_count in plan frontmatter is incremented BEFORE dispatch
  const autoSkill = fs.readFileSync(autoSkillPath, 'utf8');
  assert(
    autoSkill.includes('before dispatch') || autoSkill.includes('BEFORE dispatch') ||
    autoSkill.includes('antes de despachar') || autoSkill.includes('before dispatch') ||
    autoSkill.includes('increment') || autoSkill.includes('repair_count'),
    'forge-auto SKILL.md documents repair_count increment before dispatch'
  );
  // classify with non-critical input → strategy is NOT blocked (budget logic is orchestrator-side)
  const normalInput = JSON.stringify({
    failure_shape: 'missing_artifacts',
    severity: 'low',
    worker_explained: false,
    signals: { missing_artifacts: 2, substantive_false: 1, wired_false: 0, symbol_missing: 0,
      test_quality: { disabled: 0, weak: 0 }, is_large_task: false }
  });
  const classifyNormal = runScript('forge-repair.js', ['--classify', normalInput]);
  assert(classifyNormal.status === 0, 'classify with normal severity exits 0');
  let normalResult;
  try { normalResult = JSON.parse(classifyNormal.stdout); } catch { normalResult = {}; }
  assert(normalResult.strategy !== undefined, 'classify returns a strategy for normal input',
    `stdout: ${classifyNormal.stdout}`);
  // doc: budget >= 2 spec is in dispatch
  assert(dispatch.includes('repair.budget') || dispatch.includes('budget: 2') || dispatch.includes('budget'),
    'dispatch documents repair budget');

  // B2 — Idempotency: forge-planner.md has T##.1-PLAN.md + ABORT + already decomposed
  const planner = fs.readFileSync(plannerPath, 'utf8');
  assert(planner.includes('T##.1-PLAN.md'), 'forge-planner has T##.1-PLAN.md guard');
  assert(planner.includes('ABORT') || planner.includes('abort'), 'forge-planner has ABORT on existing sub-task');
  assert(planner.includes('already decomposed'), 'forge-planner has "already decomposed" guard message');

  // B2 — Sub-task discovery: forge-parallelism.js regex supports T##.N (sub-task IDs)
  const parallelism = fs.readFileSync(parallelismPath, 'utf8');
  assert(
    parallelism.includes('\\.\\d+') || parallelism.includes('(\\.\\d+)'),
    'forge-parallelism.js regex supports sub-task IDs (e.g. T03.1)',
    'regex .\\d+ not found'
  );

  // B3 — reinject-diff from structured source: dropped contains missing must_have, not the pruned one, cap works
  const dir = mkTmp('repair');
  try {
    // Create a plan with 2 artifacts
    const planPath = path.join(dir, 'T01-PLAN.md');
    const planContent = [
      '---',
      'id: T01',
      'must_haves:',
      '  truths: []',
      '  artifacts:',
      '    - path: "src/foo.js"',
      '      provides: "foo module"',
      '      min_lines: 10',
      '    - path: "src/bar.js"',
      '      provides: "bar module"',
      '      min_lines: 10',
      '  key_links: []',
      'expected_output:',
      '  - src/foo.js',
      '  - src/bar.js',
      '---',
      '# T01: test'
    ].join('\n');
    fs.writeFileSync(planPath, planContent, 'utf8');

    // Verification says only src/foo.js was substantively delivered
    const verPath = path.join(dir, 'S01-VERIFICATION.md');
    const verContent = [
      '| Source | Artifact | Exists | Substantive | Wired | Flags |',
      '|--------|----------|--------|-------------|-------|-------|',
      '| T01 | src/foo.js | ✓ | ✓ | ✓ | — |',
      '| T01 | src/bar.js | ✓ | ✗ | ✗ | — |'
    ].join('\n');
    fs.writeFileSync(verPath, verContent, 'utf8');

    // Reinject-diff: bar.js not delivered, foo.js delivered → bar.js should be in dropped
    const reinjectR = runScript('forge-repair.js',
      ['--reinject-diff', '--plan', planPath, '--verification', verPath]);
    assert(reinjectR.status === 0, 'reinject-diff exits 0 with valid fixtures',
      `stderr: ${reinjectR.stderr}`);
    let reinjectResult;
    try { reinjectResult = JSON.parse(reinjectR.stdout); } catch {
      fail('reinject-diff output is valid JSON', `stdout: ${reinjectR.stdout}`);
      return;
    }
    assert(Array.isArray(reinjectResult.dropped), 'reinject-diff returns dropped array');
    const droppedStr = reinjectResult.dropped.join('\n');
    assert(droppedStr.includes('src/bar.js'), 'reinject-diff dropped includes undelivered artifact (bar.js)',
      `dropped: ${JSON.stringify(reinjectResult.dropped)}`);
    assert(!droppedStr.includes('src/foo.js'), 'reinject-diff dropped excludes delivered artifact (foo.js)',
      `dropped: ${JSON.stringify(reinjectResult.dropped)}`);

    // Test that pruned items are excluded from dropped
    const reinjectPrunedR = runScript('forge-repair.js',
      ['--reinject-diff', '--plan', planPath, '--verification', verPath,
       '--pruned', 'src/bar.js']);
    assert(reinjectPrunedR.status === 0, 'reinject-diff with --pruned exits 0');
    let prunedResult;
    try { prunedResult = JSON.parse(reinjectPrunedR.stdout); } catch { prunedResult = {}; }
    const prunedDropped = (prunedResult.dropped || []).join('\n');
    assert(!prunedDropped.includes('src/bar.js'),
      'reinject-diff excludes pruned items from dropped',
      `dropped with pruned: ${JSON.stringify(prunedResult.dropped)}`);

    // Test cap: build a plan with >10 undelivered artifacts
    const bigPlanPath = path.join(dir, 'T02-PLAN.md');
    const artifacts = Array.from({ length: 12 }, (_, i) => [
      `    - path: "src/art${i}.js"`,
      `      provides: "art${i}"`,
      `      min_lines: 5`
    ].join('\n')).join('\n');
    const bigPlanContent = [
      '---',
      'id: T02',
      'must_haves:',
      '  truths: []',
      '  artifacts:',
      artifacts,
      '  key_links: []',
      'expected_output: []',
      '---',
      '# T02: big'
    ].join('\n');
    fs.writeFileSync(bigPlanPath, bigPlanContent, 'utf8');

    const emptyVerPath = path.join(dir, 'S02-VERIFICATION.md');
    fs.writeFileSync(emptyVerPath, '| Source | Artifact | Exists | Substantive | Wired | Flags |\n|--------|----------|--------|-------------|-------|-------|\n', 'utf8');

    const capR = runScript('forge-repair.js',
      ['--reinject-diff', '--plan', bigPlanPath, '--verification', emptyVerPath]);
    assert(capR.status === 0, 'reinject-diff cap test exits 0');
    let capResult;
    try { capResult = JSON.parse(capR.stdout); } catch { capResult = {}; }
    assert(Array.isArray(capResult.dropped) && capResult.dropped.length <= 10,
      'reinject-diff caps dropped at 10 items',
      `got ${capResult.dropped && capResult.dropped.length} items`);
    assert(capResult.capped === true, 'reinject-diff sets capped=true when >10 items overflow');
  } finally {
    cleanup(dir);
  }
}

// ── Section 14: stop-hook registration + exit anchors + stop branch regression ─
function smokeStopHook() {
  process.stdout.write('\n[14/16] stop-hook\n');

  const ROOT = path.dirname(SCRIPTS);
  const mergeSettingsPath = path.join(SCRIPTS, 'merge-settings.js');
  const autoSkillPath     = path.join(ROOT, 'skills', 'forge-auto', 'SKILL.md');
  const taskSkillPath     = path.join(ROOT, 'skills', 'forge-task', 'SKILL.md');

  // ── (a) Behavioural: merge-settings registers Stop in LIFECYCLE_HOOKS ──────
  const dir = mkTmp('stop-hook');
  try {
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, '{}', 'utf8');

    // Run merge the same way smokeMerger runs forge-merger: via runScript / spawnSync
    const mergeResult = spawnSync(
      'node', [mergeSettingsPath, settingsFile],
      { encoding: 'utf8' }
    );
    assert(
      mergeResult.status === 0,
      'merge-settings exits 0 on empty settings',
      mergeResult.stderr
    );

    let merged;
    try { merged = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {
      fail('merge-settings produces valid JSON', String(e));
      return;
    }

    const stopHooks = (merged.hooks && merged.hooks.Stop) || [];
    const stopEntry = stopHooks.find(
      e => e.hooks && e.hooks.some(
        h => h.command && h.command.includes('forge-hook.js') && /\bstop$/.test(h.command.trim())
      )
    );
    assert(
      !!stopEntry,
      'LIFECYCLE_HOOKS missing Stop entry (merge-settings.js line ~35)',
      `hooks.Stop = ${JSON.stringify(stopHooks)}`
    );
  } finally {
    cleanup(dir);
  }

  // ── (b) Exit anchor heuristic — Anchor Contract from S01-PLAN ─────────────
  // Regex: /forge-runs\.js[^\n]*--update[\s\S]{0,300}?["']active["']\s*:\s*false/
  // Heuristic over markdown — if this fails after a legit rephrase, update the
  // anchor list here. Failure message names the file + exit (not opaque).
  const ANCHOR_RE = /forge-runs\.js[^\n]*--update[\s\S]{0,300}?["']active["']\s*:\s*false/;

  // Window: find an anchor text in the file; extract the next ~1000 chars (~30 lines);
  // assert ANCHOR_RE. Heuristic over markdown — if this fails after a legit rephrase,
  // update the anchor list here.
  function assertExitAnchor(filePath, fileName, exitLabel, anchorText, windowSize) {
    windowSize = windowSize || 1000;
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      fail(`${fileName} readable`, `file not found or unreadable: ${filePath} — ${e.message}`);
      return;
    }
    const idx = content.indexOf(anchorText);
    if (idx === -1) {
      fail(
        `${fileName} exit '${exitLabel}' anchor text found`,
        `anchor text not found: "${anchorText.slice(0, 80)}"`
      );
      return;
    }
    const window = content.slice(idx, idx + windowSize);
    assert(
      ANCHOR_RE.test(window),
      `${fileName} exit '${exitLabel}' has run-deactivation anchor`,
      `${fileName} exit '${exitLabel}' lost run-deactivation anchor — check region around: "${anchorText.slice(0, 60)}"`
    );
  }

  // forge-auto exits to audit (per T04-PLAN § Step 2b)
  // Anchors chosen to be within ~30 lines before the forge-runs.js --update call
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'plan-check non-decreasing',
    'reason: `non-decreasing`');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'plan-check exhausted',
    'terminated-exhausted');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'Agent() dispatch failure',
    'CRITICAL — Agent() dispatch failure');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'parallel_dispatch_backgrounded',
    'Fail-fast check (execute BEFORE processing any result)');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'pause',
    'Deactivate THIS run only');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'status: partial',
    'emit compact signal');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', 'status: blocked',
    'deactivate run NOW');
  assertExitAnchor(autoSkillPath, 'forge-auto/SKILL.md', '## Deactivate auto-mode indicator',
    '## Deactivate auto-mode indicator');

  // forge-task exits to audit
  assertExitAnchor(taskSkillPath, 'forge-task/SKILL.md', 'status: done',
    '`status: done`');
  assertExitAnchor(taskSkillPath, 'forge-task/SKILL.md', 'status: partial',
    '`status: partial`');
  assertExitAnchor(taskSkillPath, 'forge-task/SKILL.md', 'status: blocked',
    '`status: blocked`');

  // ── (c) Branch stop regression: forge-hook-stop.test.js passes ─────────────
  const stopTest = runScript('forge-hook-stop.test.js', []);
  assert(
    stopTest.status === 0,
    'forge-hook-stop.test.js failed — stop branch regression',
    stopTest.stderr || stopTest.stdout
  );
}

// ── Section 15: notifications pref + PushNotification probe + call-sites ─────
function smokeNotifications() {
  process.stdout.write('\n[15/16] notifications\n');

  const ROOT = path.dirname(SCRIPTS);
  const prefsPath    = path.join(ROOT, 'forge-agent-prefs.md');
  const autoSkillPath = path.join(ROOT, 'skills', 'forge-auto', 'SKILL.md');

  // ── (a) Pref scaffold: forge-agent-prefs.md has ## Notification Settings ───
  // Heuristic over markdown — if this fails after a legit rephrase, update the
  // anchor strings here. Failure message names the file + block (not opaque).
  let prefsContent;
  try {
    prefsContent = fs.readFileSync(prefsPath, 'utf8');
  } catch (e) {
    fail('forge-agent-prefs.md readable', `file not found or unreadable: ${prefsPath} — ${e.message}`);
    return;
  }

  assert(
    prefsContent.includes('## Notification Settings'),
    'forge-agent-prefs.md has ## Notification Settings block',
    'forge-agent-prefs.md is missing "## Notification Settings" — T01 pref scaffold may have been removed'
  );
  assert(
    prefsContent.includes('notifications:'),
    'forge-agent-prefs.md has notifications: key',
    'forge-agent-prefs.md is missing "notifications:" key in Notification Settings block'
  );
  assert(
    /notifications:\s+on/.test(prefsContent),
    'forge-agent-prefs.md has notifications: on as default',
    'forge-agent-prefs.md "notifications:" default is not "on" — check ## Notification Settings block'
  );

  // ── (b) Probe + pref read in SKILL.md ────────────────────────────────────
  // Heuristic over markdown — if this fails after a legit rephrase, update the
  // anchor strings here. Failure message names the file + what is missing.
  let skillContent;
  try {
    skillContent = fs.readFileSync(autoSkillPath, 'utf8');
  } catch (e) {
    fail('skills/forge-auto/SKILL.md readable', `file not found or unreadable: ${autoSkillPath} — ${e.message}`);
    return;
  }

  assert(
    skillContent.includes('ToolSearch') && skillContent.includes('PushNotification'),
    'forge-auto/SKILL.md has PushNotification ToolSearch probe',
    'forge-auto/SKILL.md is missing ToolSearch or PushNotification — probe may have been removed'
  );
  assert(
    skillContent.includes('select:PushNotification'),
    'forge-auto/SKILL.md has select:PushNotification anchor',
    'forge-auto/SKILL.md is missing "select:PushNotification" — ToolSearch probe anchor may have been removed'
  );
  assert(
    /NOTIFICATIONS_ON/.test(skillContent),
    'forge-auto/SKILL.md reads notifications pref (NOTIFICATIONS_ON)',
    'forge-auto/SKILL.md is missing NOTIFICATIONS_ON pref read — T01 pref-read scaffold may have been removed'
  );

  // ── (c) 3 call-sites: count "fire push" invocations in SKILL.md ──────────
  // Heuristic: call-sites are written as "fire push (call-site N)" using the Push helper.
  // The Push helper definition has PushNotification({...}); the call-sites reference
  // "fire push" or "Push helper". Count "fire push (call-site" occurrences — should be ≥3.
  // If a legit rephrase reduces count, update this threshold and the anchor list below.
  const firePushRe = /fire push \(call-site/g;
  const firePushMatches = skillContent.match(firePushRe) || [];
  assert(
    firePushMatches.length >= 3,
    `forge-auto/SKILL.md has ≥3 push call-sites (found ${firePushMatches.length})`,
    `forge-auto/SKILL.md has only ${firePushMatches.length} "fire push (call-site" entries — expected ≥3 (blocker, review triage, Final Report)`
  );

  // Verify each of the 3 anchor regions contains a push invocation reference.
  // Heuristic over markdown: find each anchor text, extract surrounding window,
  // assert "fire push" or "Push helper" appears nearby. Failure names the call-site.
  const PUSH_INVOKE_RE = /fire push|Push helper/;

  function assertPushCallSite(anchorText, callSiteLabel, windowSize) {
    windowSize = windowSize || 2000;
    const idx = skillContent.indexOf(anchorText);
    if (idx === -1) {
      fail(
        `forge-auto/SKILL.md call-site '${callSiteLabel}' anchor found`,
        `anchor text not found: "${anchorText.slice(0, 80)}" — call-site may have moved or anchor needs update`
      );
      return;
    }
    const window = skillContent.slice(Math.max(0, idx - 100), idx + windowSize);
    assert(
      PUSH_INVOKE_RE.test(window),
      `forge-auto/SKILL.md call-site '${callSiteLabel}' has push invoke`,
      `forge-auto/SKILL.md call-site '${callSiteLabel}' lost push invoke — check region around: "${anchorText.slice(0, 60)}"`
    );
  }

  // Call-site 1: blocker/partial (deactivate run NOW)
  assertPushCallSite('deactivate run NOW', 'blocker/partial');
  // Call-site 2: review triage gate (before complete-milestone)
  assertPushCallSite('Review triage gate', 'review triage gate');
  // Call-site 3: Final Report (milestone complete)
  assertPushCallSite('## Final Report', 'Final Report');
}

function smokeReviewEngine() {
  process.stdout.write('\n[16/16] review-engine\n');

  const ROOT = path.dirname(SCRIPTS);
  const prefsPath  = path.join(ROOT, 'forge-agent-prefs.md');
  const specPath   = path.join(ROOT, 'shared', 'forge-review.md');

  // ── (a) forge-agent-prefs.md: Review Settings block with engine: agents ────
  // Heuristic over markdown — if this fails after a legit rephrase of the pref
  // block, update the anchor and regex here. Failure message names file + what.
  let prefsContent;
  try {
    prefsContent = fs.readFileSync(prefsPath, 'utf8');
  } catch (e) {
    fail('review-engine: forge-agent-prefs.md readable', `file not found or unreadable: ${prefsPath} — ${e.message}`);
    return;
  }

  // Extract fenced block under ## Review Settings and check for engine: agents line
  const reviewSettingsIdx = prefsContent.indexOf('## Review Settings');
  assert(
    reviewSettingsIdx !== -1,
    'review-engine: pref ## Review Settings block',
    `forge-agent-prefs.md is missing "## Review Settings" — T01 pref scaffold may have been removed`
  );

  // Look for the fenced block (```) after ## Review Settings (within 2000 chars)
  const reviewSettingsWindow = prefsContent.slice(reviewSettingsIdx, reviewSettingsIdx + 2000);
  const fenceStart = reviewSettingsWindow.indexOf('```');
  const fenceEnd   = fenceStart !== -1 ? reviewSettingsWindow.indexOf('```', fenceStart + 3) : -1;
  const fencedBlock = (fenceStart !== -1 && fenceEnd !== -1)
    ? reviewSettingsWindow.slice(fenceStart, fenceEnd + 3)
    : '';

  assert(
    /^\s*engine:\s*agents/m.test(fencedBlock),
    'review-engine: pref engine key',
    `forge-agent-prefs.md review: fenced block missing "engine: agents" line — T01 engine key may have been removed`
  );

  // Semântica section should mention review-engine-fallback (doc of fallback present)
  assert(
    prefsContent.includes('review-engine-fallback'),
    'review-engine: pref review-engine-fallback doc',
    `forge-agent-prefs.md is missing "review-engine-fallback" — T01 fallback documentation may have been removed`
  );

  // ── (b) shared/forge-review.md: presence asserts ────────────────────────────
  // Heuristic over markdown — update anchor strings if legitimate refactor changes them.
  let specContent;
  try {
    specContent = fs.readFileSync(specPath, 'utf8');
  } catch (e) {
    fail('review-engine: shared/forge-review.md readable', `file not found or unreadable: ${specPath} — ${e.message}`);
    return;
  }

  const workflowPresent = specContent.includes('## Engine workflow');
  assert(
    workflowPresent,
    'review-engine: spec workflow section',
    `shared/forge-review.md is missing "## Engine workflow" heading — T02 engine workflow section may have been removed`
  );
  if (!workflowPresent) {
    // Absence asserts below depend on extracting the ## Engine workflow section.
    // Skipping them to avoid vacuous passes when the section does not exist.
    return;
  }

  assert(
    specContent.includes('export const meta'),
    'review-engine: spec export const meta literal',
    `shared/forge-review.md is missing "export const meta" — T02 meta literal in Engine workflow may have been removed`
  );

  assert(
    specContent.includes("agentType: 'forge-reviewer'"),
    'review-engine: spec agentType forge-reviewer',
    `shared/forge-review.md is missing "agentType: 'forge-reviewer'" — T02 reviewer agentType may have been removed`
  );

  assert(
    specContent.includes("agentType: 'forge-advocate'"),
    'review-engine: spec agentType forge-advocate',
    `shared/forge-review.md is missing "agentType: 'forge-advocate'" — T02 advocate agentType may have been removed`
  );

  assert(
    specContent.includes('review-engine-fallback'),
    'review-engine: spec review-engine-fallback event',
    `shared/forge-review.md is missing "review-engine-fallback" — T02 fallback event may have been removed`
  );

  // Step 0 parse: engine array ['agents','workflow'] — tolerant to quotes/spacing
  assert(
    /\[\s*'agents'\s*,\s*'workflow'\s*\]/.test(specContent),
    "review-engine: spec Step 0 engine parse ['agents','workflow']",
    `shared/forge-review.md is missing "['agents','workflow']" array in Step 0 — T02 engine detection snippet may have been removed`
  );

  // ── (c) shared/forge-review.md: absence asserts (S03-RISK Blocker 2 guard) ──
  // The Engine workflow script MUST NOT contain clock/random primitives — the
  // Workflow runtime throws on these and they also break deterministic resume.
  // Scoped to the ## Engine workflow section only: the PROHIBITED doc line in that
  // section lists these patterns in backtick-quoted text (e.g. `Date.now()`), so
  // we scan only the JS code block(s) inside the section, not the prose. We extract
  // from the section heading to the next ## heading (or EOF) and strip markdown
  // code fences to check only fenced code content.
  const engineWorkflowIdx = specContent.indexOf('## Engine workflow');
  const nextSectionIdx = specContent.indexOf('\n## ', engineWorkflowIdx + 1);
  const engineSection = engineWorkflowIdx !== -1
    ? specContent.slice(engineWorkflowIdx, nextSectionIdx !== -1 ? nextSectionIdx : undefined)
    : '';

  // Extract only fenced code blocks (``` ... ```) from the section
  const fencedCodeRe = /```(?:\w*\n)?([\s\S]*?)```/g;
  let engineCode = '';
  let fm;
  while ((fm = fencedCodeRe.exec(engineSection)) !== null) {
    engineCode += fm[1] + '\n';
  }

  assert(
    !/Date\.now\s*\(/.test(engineCode),
    'review-engine: spec no Date.now() (Blocker 2)',
    `shared/forge-review.md Engine workflow code block contains "Date.now(" — prohibited; breaks Workflow runtime resume`
  );

  assert(
    !/new Date\s*\(/.test(engineCode),
    'review-engine: spec no new Date() (Blocker 2)',
    `shared/forge-review.md Engine workflow code block contains "new Date(" — prohibited; breaks Workflow runtime resume`
  );

  assert(
    !/Math\.random\s*\(/.test(engineCode),
    'review-engine: spec no Math.random() (Blocker 2)',
    `shared/forge-review.md Engine workflow code block contains "Math.random(" — prohibited; breaks Workflow runtime resume`
  );

  // 2026-06-10 dogfood: a wrapped body never parses — runtime only accepts the
  // meta export; everything else must be top-level statements in async context.
  assert(
    !/export\s+default/.test(engineCode),
    'review-engine: script body at top level (no export default wrapper)',
    `shared/forge-review.md Engine workflow code block contains "export default" — the Workflow runtime throws SyntaxError on any export besides meta`
  );
}

// ── Section 16: forge-accounts (shell-init, identity match, run-aware launch) ─
function smokeAccounts() {
  process.stdout.write('\n▸ Section 16: forge-accounts\n');
  const ENGINE = path.join(SCRIPTS, 'forge-accounts.js');
  const acct = require(ENGINE);

  // shell-init (zsh/bash) emits valid shell + handles the --account override
  const sh = acct.shellInit();
  const bn = spawnSync('bash', ['-n'], { input: sh, encoding: 'utf8' });
  assert(bn.status === 0, 'shell-init emits valid bash', bn.stderr);
  assert(/--account\)/.test(sh) && /launch-prep/.test(sh), 'shell-init handles --account via launch-prep');

  // shell-init-pwsh emits a claude() function with the managed marker
  const ps = acct.shellInitPwsh();
  assert(/function claude/.test(ps) && /forge-accounts shell-init/.test(ps), 'shell-init-pwsh emits claude() with marker');

  // Precedence fix (Claude Code ≥2.1.x): every launch path must inject the token
  // via ANTHROPIC_AUTH_TOKEN — CLAUDE_CODE_OAUTH_TOKEN loses to the macOS Keychain
  // login, silently defeating the per-account switch (verified empirically; see
  // forge-accounts.js TOKEN_ENV header). Guard against a regression to the old var.
  const launchPaths = [
    ['shell-init',      sh],
    ['shell-init-pwsh', ps],
    ['launch-cmd',      acct.launchCommand('demo')],
  ];
  for (const [label, p] of launchPaths) {
    assert(/ANTHROPIC_AUTH_TOKEN/.test(p), `${label} injects ANTHROPIC_AUTH_TOKEN`);
    assert(!/CLAUDE_CODE_OAUTH_TOKEN/.test(p), `${label} does not use CLAUDE_CODE_OAUTH_TOKEN`);
  }

  // matchAccount: uuid preferred, email case-insensitive, miss → null
  const reg = { accounts: { a: { account_uuid: 'U1', email: 'A@x.com' }, b: { email: 'b@x.com' } } };
  assert(acct.matchAccount(reg, { uuid: 'U1' }) === 'a', 'matchAccount by uuid');
  assert(acct.matchAccount(reg, { email: 'B@X.COM' }) === 'b', 'matchAccount by email (case-insensitive)');
  assert(acct.matchAccount(reg, { uuid: 'ZZ', email: 'no@x.com' }) === null, 'matchAccount miss → null');

  // recordIdentity anti-clobber (child process: registry path is read at module load)
  const dir = mkTmp('accounts');
  const regFile = path.join(dir, 'reg.json');
  fs.writeFileSync(regFile, JSON.stringify({ version: 1, active: 'a', accounts: { a: { account_uuid: 'U9' }, b: {} } }));
  const evalRI = `
    process.env.FORGE_ACCOUNTS_REGISTRY=${JSON.stringify(regFile)};
    const a=require(${JSON.stringify(ENGINE)});
    const clobber=a.recordIdentity('b',{uuid:'U9',email:'x@y.com'});
    const ok=a.recordIdentity('b',{uuid:'U-new',email:'b@y.com'});
    process.stdout.write(JSON.stringify({clobber,ok}));`;
  let r = spawnSync('node', ['-e', evalRI], { encoding: 'utf8' });
  const ri = JSON.parse(r.stdout || '{}');
  assert(ri.clobber === false, "recordIdentity refuses to clobber another account's uuid");
  assert(ri.ok === true, 'recordIdentity stamps a fresh uuid');

  // resolveLaunch → null when the account has no token
  r = spawnSync('node', ['-e', `
    process.env.FORGE_ACCOUNTS_REGISTRY=${JSON.stringify(regFile)};
    const a=require(${JSON.stringify(ENGINE)});
    process.stdout.write(String(a.resolveLaunch('nope')===null));`], { encoding: 'utf8' });
  assert(r.stdout.trim() === 'true', 'resolveLaunch(no token) → null');

  // run-aware: forgeAutoArgsFor resumes only with exactly one active run
  const proj = mkTmp('accounts-runs');
  const runsD = path.join(proj, '.gsd', 'forge', 'runs');
  fs.mkdirSync(runsD, { recursive: true });
  const argsFor = () => JSON.parse(spawnSync('node', ['-e',
    `const a=require(${JSON.stringify(ENGINE)});process.stdout.write(JSON.stringify(a.forgeAutoArgsFor(${JSON.stringify(proj)})));`],
    { encoding: 'utf8' }).stdout || 'null');
  assert(JSON.stringify(argsFor()) === '[]', 'forgeAutoArgsFor: 0 runs → []');
  fs.writeFileSync(path.join(runsD, 'M1.json'), JSON.stringify({ id: 'M1', kind: 'milestone', active: true }));
  assert(argsFor()[0] === '/forge-auto M1', 'forgeAutoArgsFor: 1 run → /forge-auto M1');
  fs.writeFileSync(path.join(runsD, 'M2.json'), JSON.stringify({ id: 'M2', kind: 'milestone', active: true }));
  assert(JSON.stringify(argsFor()) === '[]', 'forgeAutoArgsFor: 2 runs → [] (ambiguous)');

  cleanup(dir); cleanup(proj);
}

// ── Section 17: dynamic effort resolution ──────────────────────────────────
function smokeEffort() {
  process.stdout.write('\n▸ Section 17: dynamic effort\n');
  const REPO = path.dirname(SCRIPTS);
  const rd = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };

  const auto = rd('skills/forge-auto/SKILL.md');
  const next = rd('skills/forge-next/SKILL.md');
  const disp = rd('shared/forge-dispatch.md');
  const planner = rd('agents/forge-planner.md');

  for (const [label, txt] of [['forge-auto', auto], ['forge-next', next]]) {
    assert(/Effort Resolution \(after Tier Resolution/.test(txt), `${label}: has Effort Resolution block`, 'block missing');
    assert(/PLAN_EFFORT=\$\(node/.test(txt), `${label}: parses effort: from T##-PLAN frontmatter`, 'PLAN_EFFORT parse missing');
    assert(/frontmatter-effort:/.test(txt), `${label}: frontmatter-effort reason present`, 'reason missing');
    assert(/clamped:model-cap/.test(txt), `${label}: model-cap clamp present`, 'clamp missing');
    // dispatch event carries effort + effort_reason
    assert(/event.*dispatch[\s\S]*?effort\\?":\\?"\$\{?EFFORT/.test(txt), `${label}: dispatch event includes effort`, 'effort field missing from event');
    assert(/effort_reason\\?":\\?"\$\{?EFFORT_REASON/.test(txt), `${label}: dispatch event includes effort_reason`, 'effort_reason field missing');
    // old naive resolver must be gone
    assert(!/EFFORT_MAP\[unit_type\] or \("medium" if opus/.test(txt), `${label}: legacy naive effort resolver removed`, 'naive resolver still present');
  }

  assert(/### Effort Resolution/.test(disp), 'forge-dispatch: canonical Effort Resolution section', 'section missing');
  assert(/low < medium < high < xhigh < max/.test(disp), 'forge-dispatch: documents ordered effort scale', 'scale missing');
  assert(/## Effort & Tier Hints/.test(planner), 'forge-planner: Effort & Tier Hints section', 'planner guidance missing');

  // Behavioural: the clamp one-liner used in the SKILLs
  const clamp = (model, e) => spawnSync('node', ['-e',
    `const r={low:0,medium:1,high:2,xhigh:3,max:4};const m='${model}';const cap=(/^claude-(haiku|sonnet)/.test(m))?'medium':'max';let e='${e}';if(!(e in r))e='medium';process.stdout.write(r[e]>r[cap]?cap:e)`
  ], { encoding: 'utf8' }).stdout;
  assert(clamp('claude-sonnet-5', 'xhigh') === 'medium', 'clamp: sonnet xhigh → medium', 'no clamp');
  assert(clamp('claude-haiku-4-5-20251001', 'high') === 'medium', 'clamp: haiku high → medium', 'no clamp');
  assert(clamp('claude-opus-4-8', 'xhigh') === 'xhigh', 'clamp: opus xhigh → xhigh (no clamp)', 'wrongly clamped');
  assert(clamp('claude-fable-5', 'max') === 'max', 'clamp: fable max → max', 'wrongly clamped');
  assert(clamp('claude-sonnet-5', 'bogus') === 'medium', 'clamp: invalid effort → medium fallback', 'no fallback');
}

// Section 18: usage indicator (5h/weekly bars + handoff under token auth).
// Guards the poller (fetchUsage + unified-* headers + adaptive cadence), the
// statusline (bridge fallback-read + 70% gate + poll trigger), the hook spawn,
// the multi-account dashboard, and the headroom-aware account selector with its
// cooldown fallback intact.
function smokeUsageIndicator() {
  process.stdout.write('\n▸ Section 18: usage indicator (token-auth 5h/weekly)\n');
  const poll = fs.readFileSync(path.join(SCRIPTS, 'forge-usage-poll.js'), 'utf8');
  const sl   = fs.readFileSync(path.join(SCRIPTS, 'forge-statusline.js'), 'utf8');
  const hook = fs.readFileSync(path.join(SCRIPTS, 'forge-hook.js'), 'utf8');
  const acct = require(path.join(SCRIPTS, 'forge-accounts.js'));
  const pollMod = require(path.join(SCRIPTS, 'forge-usage-poll.js'));

  // Poller: exports fetchUsage, reads the unified-* headers, self-throttles adaptively.
  assert(typeof pollMod.fetchUsage === 'function', 'forge-usage-poll exports fetchUsage');
  assert(/anthropic-ratelimit-unified-/.test(poll), 'poller reads unified-* headers');
  assert(/maxUtil >= 70 \? 120000/.test(poll), 'poller has adaptive cadence');

  // Statusline: reads the bridge when rate_limits absent, gates at 70%, triggers the poll.
  assert(/forge-ratelimit-/.test(sl), 'statusline reads ratelimit bridge (token-auth fallback)');
  assert(/DISPLAY_THRESHOLD\s*=\s*70/.test(sl), 'statusline gates display at 70%');
  assert(/forge-usage-poll\.js/.test(sl), 'statusline triggers the poll');

  // Hook: spawns the poll on PostToolUse under token auth (covers headless forge-auto).
  assert(/forge-usage-poll\.js/.test(hook) && /ANTHROPIC_AUTH_TOKEN/.test(hook),
    'hook spawns poll under token auth');

  // Multi-account dashboard + headroom-aware selector (cooldown fallback intact).
  assert(fs.existsSync(path.join(SCRIPTS, 'forge-usage.js')), 'forge-usage.js dashboard present');
  assert(typeof acct.nextAccountByUsage === 'function', 'forge-accounts exports nextAccountByUsage');
  assert(typeof acct.nextAccount === 'function', 'cooldown-based nextAccount retained as fallback');
}

// ── Section 19: plan gate degradation (forge-auto never conducts) ───────────
function smokePlanGateDegradation() {
  process.stdout.write('\n▸ Section 19: plan gate degradation (forge-auto never conducts)\n');
  const REPO = path.dirname(SCRIPTS);
  const rd = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };

  const gate  = rd('shared/forge-plan-gate.md');
  const task  = rd('skills/forge-task/SKILL.md');
  const next  = rd('skills/forge-next/SKILL.md');
  const auto  = rd('skills/forge-auto/SKILL.md');
  const prefs = rd('forge-agent-prefs.md');

  // (a) shared/forge-plan-gate.md exists + references both consumers + has Degradation by mode section
  assert(fs.existsSync(path.join(REPO, 'shared/forge-plan-gate.md')),
    '(a) shared/forge-plan-gate.md exists', 'file missing');
  assert(/forge-task/.test(gate) && /forge-next/.test(gate),
    '(a) forge-plan-gate.md references both consumers (forge-task, forge-next)', 'consumer reference missing');
  assert(/## Degradation by mode/.test(gate),
    '(a) forge-plan-gate.md has "## Degradation by mode" section', 'section missing');

  // (b) forge-task and forge-next consume shared/forge-plan-gate.md and conduct interactively
  for (const [label, txt] of [['forge-task', task], ['forge-next', next]]) {
    assert(/shared\/forge-plan-gate\.md/.test(txt),
      `(b) ${label}/SKILL.md references shared/forge-plan-gate.md`, 'reference missing');
    assert(/MODE = interactive/.test(txt),
      `(b) ${label}/SKILL.md has MODE = interactive (conducts interactively)`, 'interactive mode missing');
  }

  // (c) forge-auto does NOT conduct the interactive plan gate — negative + positive guards
  assert((auto.match(/Plan gate \(interactive\)/g) || []).length === 0,
    '(c) forge-auto SKILL does NOT conduct the interactive plan gate',
    `found ${(auto.match(/Plan gate \(interactive\)/g) || []).length} occurrences`);
  // R1: if forge-auto mentions shared/forge-plan-gate.md it MUST carry the "NEVER conducts" qualifier
  assert(!/shared\/forge-plan-gate\.md/.test(auto) || /NEVER conducts|NUNCA conduz/i.test(auto),
    '(c) forge-auto: if it references shared/forge-plan-gate.md it must carry NEVER conducts/NUNCA conduz qualifier',
    'forge-auto references forge-plan-gate.md without the required NEVER-conducts qualifier');
  assert(/Plan gate — degradação no modo auto/.test(auto),
    '(c) forge-auto has the auditable degradation guard heading', 'guard heading missing');
  assert(/Plan-gate degradation \(auditable\) — forge-auto NEVER conducts the interactive handshake/.test(auto),
    '(c) forge-auto has the grep-anchor phrase (NEVER conducts)', 'anchor phrase missing');
  // R3: extract the degradation guard block and test the three key terms WITHIN it (block-scoped)
  {
    const guardStart = auto.indexOf('### Plan gate — degradação no modo auto');
    const guardEnd   = guardStart === -1 ? -1 : (() => {
      const afterStart = auto.indexOf('\n###', guardStart + 1);
      return afterStart === -1 ? auto.length : afterStart;
    })();
    const guardBlock = guardStart === -1 ? '' : auto.slice(guardStart, guardEnd);
    const hasModeAuto      = /MODE = auto/.test(guardBlock);
    const hasNeverConducts = /never conducts/.test(guardBlock);
    const hasAskInAuto     = /ask_in_auto: defer/.test(guardBlock);
    const missing = [
      !hasModeAuto      && 'MODE=auto',
      !hasNeverConducts && 'never conducts',
      !hasAskInAuto     && 'ask_in_auto:defer',
    ].filter(Boolean).join(', ');
    assert(hasModeAuto && hasNeverConducts && hasAskInAuto,
      '(c) forge-auto degradation guard block has all three key terms (MODE=auto, never conducts, ask_in_auto:defer)',
      guardStart === -1 ? 'guard block not found' : `missing in block: ${missing}`);
  }

  // (d) plan_gate: pref scaffolded in forge-agent-prefs.md with correct defaults
  // R2: guard missing file distinctly from missing key
  assert(fs.existsSync(path.join(REPO, 'forge-agent-prefs.md')),
    '(d) forge-agent-prefs.md exists', 'file missing');
  assert(/^plan_gate:/m.test(prefs),
    '(d) forge-agent-prefs.md has plan_gate: block', 'plan_gate block missing');
  assert(/plan_gate:[\s\S]*?interactive:\s*always/.test(prefs),
    '(d) plan_gate.interactive defaults to always', 'interactive: always missing');
  assert(/plan_gate:[\s\S]*?ask_in_auto:\s*defer/.test(prefs),
    '(d) plan_gate.ask_in_auto defaults to defer', 'ask_in_auto: defer missing');
}

// ── Section 20: forge-xllm adapter (mock codex on PATH) ─────────────────────
// Live-spawns the T01 adapter against a mock `codex` shell binary prepended to
// PATH — structural (token-presence) asserts don't catch runtime failures.
function writeMockCodex(dir, opts) {
  opts = opts || {};
  const script = [
    '#!/bin/sh',
    '# forge-smoke mock codex — writes payload to the -o file, honors exit code / sleep',
    'OUT=""',
    'CODEXCWD=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-o" ]; then OUT="$arg"; fi',
    '  if [ "$prev" = "-C" ]; then CODEXCWD="$arg"; fi',
    '  prev="$arg"',
    'done',
    opts.sleepSecs ? `sleep ${opts.sleepSecs}` : '',
    // extraScript runs BEFORE the -o write — same default byte-shape for
    // Section 20–23 callers that never pass it (opts.extraScript undefined).
    opts.extraScript || '',
    opts.writeOutput === false
      ? ''
      : `if [ -n "$OUT" ]; then printf '%s' ${shQuote(opts.payload || '')} > "$OUT"; fi`,
    `exit ${typeof opts.exitCode === 'number' ? opts.exitCode : 0}`,
    '',
  ].join('\n');
  const codexPath = path.join(dir, 'codex');
  fs.writeFileSync(codexPath, script, 'utf8');
  fs.chmodSync(codexPath, 0o755);
  return dir;
}

function shQuote(s) {
  // single-quote for POSIX sh, escaping embedded single quotes
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Section 24 helper — plain git repo fixture (init + initial commit so the
// working tree starts clean). Reusable by S02/S04.
function mkGitRepo(dir) {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['add', '-A']);
  run(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function runXllm(args, mockDir, cwd) {
  const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
  const env = mockDir
    ? { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH }
    : { ...process.env, PATH: '' };
  const r = spawnSync(process.execPath, [xllmPath, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    env,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function smokeXllm() {
  process.stdout.write('\n▸ Section 20: forge-xllm adapter (mock codex on PATH)\n');

  // Scenario A — happy challenge: prose + valid JSON extraction, normalized shape.
  {
    const dir = mkTmp('xllm-a');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-a-mock-'));
    const payload = 'Some prose from codex...\n' + JSON.stringify({
      objections: [{ id: 'R1', path_line: 'src/a.js:12', claim: 'x', suggested_fix: 'y', challenge: 'z?', severity: 'high' }],
    });
    writeMockCodex(mockDir, { payload, exitCode: 0 });
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir], mockDir, dir);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(r.status === 0, 'A: happy challenge exits 0', `status=${r.status} stderr=${r.stderr}`);
    assert(!!parsed && Array.isArray(parsed.objections) && parsed.objections.length === 1,
      'A: stdout parses to objections array', `stdout=${r.stdout}`);
    const o = parsed && parsed.objections && parsed.objections[0];
    assert(!!o && o.id === 'R1' && o.severity === 'high' && o.file === 'src/a.js' && o.line === 12
      && typeof o.issue === 'string' && typeof o.fix === 'string',
      'A: normalized objection has id/severity/file/line/issue/fix', `objection=${JSON.stringify(o)}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario B — missing binary: PATH-hermetic (no codex, no process.env.PATH) → exit non-zero.
  // R1: mockDir must be falsy so runXllm takes the empty-PATH branch — a truthy
  // (even empty) dir here would still fall back to process.env.PATH, which on a
  // host with a real codex binary installed would spawn it for real.
  {
    const dir = mkTmp('xllm-b');
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir], null, dir);
    assert(r.status !== 0, 'B: missing binary exits non-zero', `status=${r.status}`);
    assert(r.stderr.length > 0, 'B: missing binary writes stderr', `stderr=${r.stderr}`);
    cleanup(dir);
  }

  // Scenario C — child exit ≠ 0: mock exits 1 without writing -o.
  {
    const dir = mkTmp('xllm-c');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-c-mock-'));
    writeMockCodex(mockDir, { exitCode: 1, writeOutput: false });
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir], mockDir, dir);
    assert(r.status !== 0, 'C: child exit 1 makes adapter exit non-zero', `status=${r.status}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario D — malformed JSON in the -o file.
  {
    const dir = mkTmp('xllm-d');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-d-mock-'));
    writeMockCodex(mockDir, { payload: 'this is not { json at all', exitCode: 0 });
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir], mockDir, dir);
    assert(r.status !== 0, 'D: malformed JSON makes adapter exit non-zero', `status=${r.status}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario E — timeout: mock sleeps longer than --timeout 1 → killed, bounded wall time.
  {
    const dir = mkTmp('xllm-e');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-e-mock-'));
    writeMockCodex(mockDir, { sleepSecs: 5, exitCode: 0, payload: JSON.stringify({ objections: [] }) });
    const t0 = Date.now();
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir, '--timeout', '1'], mockDir, dir);
    const elapsed = Date.now() - t0;
    assert(r.status !== 0, 'E: timeout makes adapter exit non-zero', `status=${r.status}`);
    assert(elapsed < 10000, 'E: timeout kill is bounded (< 10s wall time)', `elapsed=${elapsed}ms`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario F — rebuttal happy path + out-of-enum verdict rejection.
  {
    const dir = mkTmp('xllm-f');
    const inputFile = path.join(dir, 'input.txt');
    fs.writeFileSync(inputFile, 'R1: objection text\nDefense: still real\n', 'utf8');

    const mockDirOk = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-f-ok-'));
    writeMockCodex(mockDirOk, {
      payload: JSON.stringify({ verdicts: [{ id: 'R1', verdict: 'maintained', rationale: 'still real' }] }),
      exitCode: 0,
    });
    const rOk = runXllm(['--mode', 'rebuttal', '--input', inputFile, '--cwd', dir], mockDirOk, dir);
    let parsedOk = null;
    try { parsedOk = JSON.parse(rOk.stdout); } catch (e) { /* leave null */ }
    assert(rOk.status === 0, 'F: rebuttal happy path exits 0', `status=${rOk.status} stderr=${rOk.stderr}`);
    assert(!!parsedOk && Array.isArray(parsedOk.verdicts) && parsedOk.verdicts[0]
      && parsedOk.verdicts[0].verdict === 'maintained' && typeof parsedOk.verdicts[0].reason === 'string',
      'F: normalized verdict has verdict=maintained and reason', `stdout=${rOk.stdout}`);
    cleanup(mockDirOk);

    const mockDirBad = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-f-bad-'));
    writeMockCodex(mockDirBad, {
      payload: JSON.stringify({ verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'nope' }] }),
      exitCode: 0,
    });
    const rBad = runXllm(['--mode', 'rebuttal', '--input', inputFile, '--cwd', dir], mockDirBad, dir);
    assert(rBad.status !== 0, 'F: out-of-enum verdict makes adapter exit non-zero', `status=${rBad.status}`);
    cleanup(mockDirBad);

    cleanup(dir);
  }
}

// ── Section 21: model ID→alias map (live) ────────────────────────────────
// Exercises scripts/forge-model-alias.js live via spawnSync — the mapping
// logic must live only in that file; this section calls the helper, it
// never reimplements the fable/haiku/sonnet/opus regex table.
function aliasCli(id, extraArgs) {
  const args = [path.join(SCRIPTS, 'forge-model-alias.js'), '--id', id];
  if (extraArgs) args.push(...extraArgs);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { stdout: (r.stdout || '').trim(), status: r.status };
}

function smokeModelAlias() {
  process.stdout.write('\n▸ Section 21: model ID→alias map (live)\n');

  const cases = [
    ['claude-opus-4-8[1m]', 'opus'],
    ['claude-fable-5', 'fable'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-sonnet-5', 'sonnet'],
    ['gpt-5', ''],
    ['modelo-desconhecido', ''],
  ];

  for (const [id, expected] of cases) {
    const r = aliasCli(id);
    assert(r.status === 0, `CLI --id '${id}' exits 0`, `status=${r.status}`);
    assert(r.stdout === expected, `CLI --id '${id}' prints '${expected}'`, `got='${r.stdout}'`);
  }

  // --json shape
  {
    const r = aliasCli('claude-opus-4-8[1m]', ['--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.alias === 'opus' && parsed.mapped === true,
      '--json prints {alias:"opus", mapped:true}', `stdout=${r.stdout}`);
  }
  {
    const r = aliasCli('gpt-5', ['--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.alias === null && parsed.mapped === false,
      '--json prints {alias:null, mapped:false} for unmapped', `stdout=${r.stdout}`);
  }

  // require()-level check — modelToAlias exists and returns the right shape
  {
    const { modelToAlias } = require(path.join(SCRIPTS, 'forge-model-alias.js'));
    const res = modelToAlias('claude-fable-5');
    assert(typeof modelToAlias === 'function', 'modelToAlias is exported as a function', typeof modelToAlias);
    assert(res && res.alias === 'fable' && res.mapped === true,
      'require()d modelToAlias("claude-fable-5") -> {alias:"fable", mapped:true}', JSON.stringify(res));
  }

  // Structural wiring — dispatch sites call the helper, pass model:$MODEL_ALIAS,
  // record model_applied, and never reimplement the alias map inline.
  {
    const ROOT = path.join(__dirname, '..');
    const files = {
      'skills/forge-auto/SKILL.md': fs.readFileSync(path.join(ROOT, 'skills/forge-auto/SKILL.md'), 'utf8'),
      'skills/forge-next/SKILL.md': fs.readFileSync(path.join(ROOT, 'skills/forge-next/SKILL.md'), 'utf8'),
      'shared/forge-dispatch.md': fs.readFileSync(path.join(ROOT, 'shared/forge-dispatch.md'), 'utf8'),
    };

    for (const [name, content] of Object.entries(files)) {
      assert(content.includes('forge-model-alias.js'),
        `${name} calls forge-model-alias.js`, 'not found');
      assert(content.includes('model_applied'),
        `${name} records model_applied`, 'not found');
      assert(!/indexOf\(['"]fable['"]\)/.test(content),
        `${name} does not reimplement the alias map inline`, 'suspicious inline map reimplementation found');
    }

    for (const name of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
      const content = files[name];
      assert(content.includes('model: $MODEL_ALIAS'),
        `${name} passes model: $MODEL_ALIAS to Agent()`, 'not found');
      assert(content.includes('MODEL_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$MODEL_ID")'),
        `${name} resolves MODEL_ALIAS via the canonical helper invocation`, 'not found');
    }
  }

  // Live bash reproduction of the MODEL_APPLIED_JSON glue + event line assembly —
  // catches malformed-JSON regressions that pure substring asserts miss (R2 fix).
  {
    const buildAndParse = (modelAlias) => {
      const script = [
        `MODEL_ALIAS='${modelAlias}'`,
        `MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')`,
        `echo "{\\"ts\\":\\"2026-01-01T00:00:00Z\\",\\"event\\":\\"dispatch\\",\\"unit\\":\\"execute-task/T01\\",\\"model\\":\\"claude-sonnet-5\\",\\"input_tokens\\":1,\\"output_tokens\\":1,\\"tier\\":\\"standard\\",\\"reason\\":\\"default\\",\\"effort\\":\\"low\\",\\"effort_reason\\":\\"default\\",\\"model_applied\\":$MODEL_APPLIED_JSON}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch (e) { /* leave null */ }
      return { raw: (r.stdout || '').trim(), parsed };
    };

    const withAlias = buildAndParse('sonnet');
    assert(!!withAlias.parsed, 'MODEL_APPLIED_JSON glue produces valid JSON when MODEL_ALIAS non-empty', withAlias.raw);
    assert(withAlias.parsed && withAlias.parsed.model_applied === 'sonnet',
      'model_applied === "sonnet" when MODEL_ALIAS="sonnet"', JSON.stringify(withAlias.parsed));

    const withoutAlias = buildAndParse('');
    assert(!!withoutAlias.parsed, 'MODEL_APPLIED_JSON glue produces valid JSON when MODEL_ALIAS empty', withoutAlias.raw);
    assert(withoutAlias.parsed && withoutAlias.parsed.model_applied === null,
      'model_applied === null when MODEL_ALIAS=""', JSON.stringify(withoutAlias.parsed));
  }
}

// ── Section 22: review challenger wiring (spec invariants + live adapter parse) ──
// Guards T01's Codex challenger wiring in shared/forge-review.md: structural
// token asserts over the spec text, plus a live re-run of the Section 20
// harness in --mode challenge to lock the {objections:[...]} contract the
// spec's Codex branch actually consumes.
function smokeChallengerWiring() {
  process.stdout.write('\n▸ Section 22: review challenger wiring (spec invariants + live adapter parse)\n');

  const ROOT = path.join(__dirname, '..');
  const spec = fs.readFileSync(path.join(ROOT, 'shared', 'forge-review.md'), 'utf8');

  assert(spec.includes('challenger:'), 'spec Step 0 reads challenger:', 'token "challenger:" not found');
  assert(spec.includes('challenger_model'), 'spec Step 0 reads challenger_model', 'token "challenger_model" not found');
  assert(spec.includes('review-challenger-fallback'), 'spec defines review-challenger-fallback event', 'token not found');
  assert(spec.includes('engine-workflow-forced-agents'), 'spec has codex x workflow precedence reason', 'token "engine-workflow-forced-agents" not found');
  assert(spec.includes('Challenger:'), 'spec Step 6 has Challenger: header', 'token "Challenger:" not found');
  assert(spec.includes('"challenger"'), 'spec Step 8 event has challenger field', 'token \'"challenger"\' not found');
  assert(spec.includes('scripts/forge-xllm.js'), 'spec invokes the forge-xllm.js adapter', 'token not found');

  // Live scenario — reuse the Section 20 mock-codex harness in challenge mode
  // and assert the normalized {objections:[...]} contract the spec's Codex
  // branch parses (path_line -> file/line, claim/suggested_fix -> issue/fix).
  {
    const dir = mkTmp('challenger-wiring');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-challenger-mock-'));
    const payload = 'Some prose from codex...\n' + JSON.stringify({
      objections: [{ id: 'R1', path_line: 'src/x.js:3', claim: 'c', suggested_fix: 'f', challenge: 'q?', severity: 'high' }],
    });
    writeMockCodex(mockDir, { payload, exitCode: 0 });
    const r = runXllm(['--mode', 'challenge', '--diff-cmd', 'echo diff', '--cwd', dir], mockDir, dir);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(r.status === 0, 'live challenge: adapter exits 0 with mock codex', `status=${r.status} stderr=${r.stderr}`);
    assert(!!parsed && Array.isArray(parsed.objections) && parsed.objections.length === 1,
      'live challenge: stdout parses to objections array', `stdout=${r.stdout}`);
    const o = parsed && parsed.objections && parsed.objections[0];
    assert(!!o && o.id === 'R1' && o.severity === 'high' && o.file === 'src/x.js' && o.line === 3
      && typeof o.issue === 'string' && typeof o.fix === 'string' && typeof o.challenge === 'string',
      'live challenge: normalized objection shape matches spec contract', `objection=${JSON.stringify(o)}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Live scenario — run the actual Step 0 cascade script (mirrors the node -e
  // in shared/forge-review.md Step 0) against a temp prefs file, asserting
  // challenger/challengerModel resolve correctly and invalid challenger falls
  // back to the "claude" whitelist default (regression guard for the \Z/regex
  // class of bugs on the new cascade lines).
  {
    const cascadeScript = `
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let mode='enabled',style='dialectic',rounds=1,askAuto='defer',fixConceded=true,engine='agents',challenger='claude',challengerModel=null;
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^review:[ \\t]*\\n((?:[ \\t]+.*\\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \\t]+mode:[ \\t]*(\\w+)/m))mode=m[1].toLowerCase();
  if(m=blk.match(/^[ \\t]+style:[ \\t]*(\\w+)/m))style=m[1].toLowerCase();
  if(m=blk.match(/^[ \\t]+rounds:[ \\t]*(\\d+)/m))rounds=parseInt(m[1],10);
  if(m=blk.match(/^[ \\t]+ask_in_auto:[ \\t]*(\\w+)/m))askAuto=m[1].toLowerCase();
  if(m=blk.match(/^[ \\t]+fix_conceded:[ \\t]*(\\w+)/m))fixConceded=m[1].toLowerCase()!=='false';
  if(m=blk.match(/^[ \\t]+engine:[ \\t]*(\\w+)/m))engine=m[1].toLowerCase();
  if(m=blk.match(/^[ \\t]+challenger:[ \\t]*(\\w+)/m))challenger=m[1].toLowerCase();
  if(m=blk.match(/^[ \\t]+challenger_model:[ \\t]*(\\S+)/m))challengerModel=m[1];
}catch(e){}}
if(!['enabled','disabled'].includes(mode))mode='enabled';
if(!['dialectic','flags'].includes(style))style='dialectic';
if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
if(!['defer','pause'].includes(askAuto))askAuto='defer';
if(!['agents','workflow'].includes(engine))engine='agents';
if(!['claude','codex'].includes(challenger))challenger='claude';
process.stdout.write(JSON.stringify({mode,style,rounds,askAuto,fixConceded,engine,challenger,challengerModel}));
`;
    const dir = mkTmp('challenger-cascade');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const cascadePath = path.join(dir, 'cascade.js');
    fs.writeFileSync(cascadePath, cascadeScript);

    // Case 1: challenger: codex + challenger_model: gpt-5-test
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: codex\n  challenger_model: gpt-5-test\n');
    const r1 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir }, encoding: 'utf8' });
    let p1 = null;
    try { p1 = JSON.parse(r1.stdout); } catch (e) { /* leave null */ }
    assert(!!p1 && p1.challenger === 'codex' && p1.challengerModel === 'gpt-5-test',
      'Step 0 cascade: challenger/challenger_model resolve from prefs', `stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Case 2: challenger: invalido -> whitelist fallback to "claude"
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: invalido\n');
    const r2 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir }, encoding: 'utf8' });
    let p2 = null;
    try { p2 = JSON.parse(r2.stdout); } catch (e) { /* leave null */ }
    assert(!!p2 && p2.challenger === 'claude',
      'Step 0 cascade: invalid challenger falls back to claude whitelist default', `stdout=${r2.stdout} stderr=${r2.stderr}`);

    cleanup(dir);
  }
}

// ── Section 23: advocate model (spec invariants + live cascade + alias CLI) ──
// Guards T01's advocate_model wiring in shared/forge-review.md +
// agents/forge-advocate.md + forge-agent-prefs.md: structural token asserts,
// plus a live re-run of the Section 22 Step 0 cascade harness extended with
// the advocate_model line, plus the forge-model-alias.js CLI round-trip.
function smokeAdvocateModel() {
  process.stdout.write('\n▸ Section 23: advocate model (spec invariants + live cascade + alias CLI)\n');

  const ROOT = path.join(__dirname, '..');

  // Block A — structural asserts
  {
    const spec = fs.readFileSync(path.join(ROOT, 'shared', 'forge-review.md'), 'utf8');
    assert(spec.includes('advocate_model'), 'spec Step 0 reads advocate_model', 'token "advocate_model" not found');
    assert(spec.includes('ADVOCATE_MODEL'), 'spec derives ADVOCATE_MODEL', 'token "ADVOCATE_MODEL" not found');
    assert(spec.includes('forge-model-alias.js'), 'spec invokes forge-model-alias.js for the advocate', 'token "forge-model-alias.js" not found');
    assert(spec.includes('"advocate"'), 'spec Step 8 event has advocate field', 'token \'"advocate"\' not found');

    const agentSpec = fs.readFileSync(path.join(ROOT, 'agents', 'forge-advocate.md'), 'utf8');
    assert(agentSpec.includes('model: claude-fable-5'), 'forge-advocate.md frontmatter has model: claude-fable-5', 'token "model: claude-fable-5" not found');
    assert(agentSpec.includes('thinking: adaptive'), 'forge-advocate.md frontmatter has thinking: adaptive', 'token "thinking: adaptive" not found');
    assert(!agentSpec.includes('thinking: disabled'), 'forge-advocate.md frontmatter does NOT have thinking: disabled', 'token "thinking: disabled" found');

    const prefs = fs.readFileSync(path.join(ROOT, 'forge-agent-prefs.md'), 'utf8');
    assert(prefs.includes('advocate_model'), 'forge-agent-prefs.md Review Settings has advocate_model', 'token "advocate_model" not found');
  }

  // Block B — live round-trip of the Step 0 cascade, extended with advocate_model
  {
    const cascadeScript = `
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let challengerModel=null,advocateModel='claude-fable-5';
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^review:[ \\t]*\\n((?:[ \\t]+.*\\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \\t]+challenger_model:[ \\t]*(\\S+)/m))challengerModel=m[1];
  if(m=blk.match(/^[ \\t]+advocate_model:[ \\t]*(\\S+)/m))advocateModel=m[1];
}catch(e){}}
process.stdout.write(JSON.stringify({challengerModel,advocateModel}));
`;
    const dir = mkTmp('advocate-cascade');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const cascadePath = path.join(dir, 'cascade.js');
    fs.writeFileSync(cascadePath, cascadeScript);

    // Case 1: no advocate_model pref -> default claude-fable-5
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'), 'review:\n  mode: enabled\n');
    const r1 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir }, encoding: 'utf8' });
    let p1 = null;
    try { p1 = JSON.parse(r1.stdout); } catch (e) { /* leave null */ }
    assert(!!p1 && p1.advocateModel === 'claude-fable-5',
      'Step 0 cascade: advocateModel defaults to claude-fable-5 when unset', `stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Case 2: advocate_model override
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'), 'review:\n  advocate_model: claude-opus-4-8\n');
    const r2 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir }, encoding: 'utf8' });
    let p2 = null;
    try { p2 = JSON.parse(r2.stdout); } catch (e) { /* leave null */ }
    assert(!!p2 && p2.advocateModel === 'claude-opus-4-8',
      'Step 0 cascade: advocate_model override resolves', `stdout=${r2.stdout} stderr=${r2.stderr}`);

    cleanup(dir);
  }

  // Block C — forge-model-alias.js CLI round-trip
  {
    const r1 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'forge-model-alias.js'), '--id', 'claude-fable-5'], { encoding: 'utf8' });
    assert(r1.stdout.trim() === 'fable', 'forge-model-alias.js --id claude-fable-5 -> "fable"', `stdout="${r1.stdout}" stderr=${r1.stderr}`);

    const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'forge-model-alias.js'), '--id', 'foo-model-inexistente'], { encoding: 'utf8' });
    assert(r2.stdout.trim() === '', 'forge-model-alias.js --id foo-model-inexistente -> ""', `stdout="${r2.stdout}" stderr=${r2.stderr}`);
  }

  // Block D — live bash reproduction of the "advocate" event-line glue
  // (mirrors the Section 8 event assembly in shared/forge-review.md), asserting
  // valid JSON + advocate === "fable" / null (mirror of Section 21's
  // model_applied glue test, R2 fix).
  {
    const buildAndParse = (advocateAlias) => {
      const script = [
        `ADVOCATE_ALIAS='${advocateAlias}'`,
        `echo "{\\"ts\\":\\"2026-01-01T00:00:00Z\\",\\"event\\":\\"review\\",\\"unit\\":\\"S04\\",\\"challenger\\":\\"claude\\",\\"advocate\\":$([ -n "$ADVOCATE_ALIAS" ] && printf '"%s"' "$ADVOCATE_ALIAS" || printf 'null')}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch (e) { /* leave null */ }
      return { raw: (r.stdout || '').trim(), parsed };
    };

    const withAlias = buildAndParse('fable');
    assert(!!withAlias.parsed, 'advocate event-line glue produces valid JSON when ADVOCATE_ALIAS non-empty', withAlias.raw);
    assert(withAlias.parsed && withAlias.parsed.advocate === 'fable',
      'advocate === "fable" when ADVOCATE_ALIAS="fable"', JSON.stringify(withAlias.parsed));

    const withoutAlias = buildAndParse('');
    assert(!!withoutAlias.parsed, 'advocate event-line glue produces valid JSON when ADVOCATE_ALIAS empty', withoutAlias.raw);
    assert(withoutAlias.parsed && withoutAlias.parsed.advocate === null,
      'advocate === null when ADVOCATE_ALIAS=""', JSON.stringify(withoutAlias.parsed));
  }
}

// ── Section 24: forge-xllm execute mode (mock codex on PATH) ────────────────
// Live-spawns the T01 adapter in --mode execute against a mock `codex` that can
// write real files, spawn orphans, commit, or hang — regression guard for the
// S01-RISK contract: heartbeat, process-group timeout kill, no-commit, dirty
// guard, result-file-outside-workspace guard, .gsd/ advisory warning.
async function smokeXllmExecute() {
  process.stdout.write('\n▸ Section 24: forge-xllm execute mode (mock codex on PATH)\n');

  const validPayload = JSON.stringify({
    status: 'done',
    summary: 'did the task',
    must_haves_status: [{ item: 'truth 1', status: 'met', note: 'ok' }],
    files_changed: ['task-file.txt'],
  });

  function runExecuteXllm(args, mockDir, cwd, opts) {
    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const env = mockDir
      ? { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH }
      : { ...process.env, PATH: '' };
    const r = spawnSync(process.execPath, [xllmPath, '--mode', 'execute', ...args], {
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      env,
      ...(opts || {}),
    });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
  }

  // Scenario A — happy path: real file write in the repo, no-commit, exit 0.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-a'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-a-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-a-mock-'));
    writeMockCodex(mockDir, {
      payload: validPayload,
      exitCode: 0,
      extraScript: `printf 'x' > "$CODEXCWD/task-file.txt"`,
    });
    const beforeLog = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout;
    const beforeHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 0, 'A: happy execute exits 0', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'done', 'A: result-file has status done', JSON.stringify(parsed));
    assert(!!parsed && Array.isArray(parsed.files_changed)
      && parsed.files_changed.some((f) => f.path === 'task-file.txt' && f.status === 'A'),
      'A: files_changed derived includes real write (status A)', JSON.stringify(parsed && parsed.files_changed));
    assert(!!parsed && parsed.start_sha === beforeHead, 'A: start_sha matches pre-run HEAD', `start_sha=${parsed && parsed.start_sha} beforeHead=${beforeHead}`);
    const afterHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    assert(afterHead === beforeHead, 'A: HEAD unchanged (no-commit)', `before=${beforeHead} after=${afterHead}`);
    const afterLog = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(afterLog === beforeLog, 'A: git log unchanged (no-commit)', `before=${JSON.stringify(beforeLog)} after=${JSON.stringify(afterLog)}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario B — dirty guard: sujar o repo antes de rodar; mock never invoked.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-b'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n', 'utf8'); // dirties the tree
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-b-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-b-marker-'));
    const marker = path.join(markerDir, 'invoked.marker');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-b-mock-'));
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$MARKER"` });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo,
      { env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, MARKER: marker } });
    assert(r.status !== 0, 'B: dirty tree makes adapter exit non-zero', `status=${r.status}`);
    assert(/dirty/i.test(r.stderr), 'B: dirty guard message mentions dirty', `stderr=${r.stderr}`);
    assert(!fs.existsSync(marker), 'B: mock codex never invoked (marker absent)', `marker=${marker}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(markerDir);
    cleanup(mockDir);
  }

  // Scenario C — timeout with an orphaned background child: adapter still
  // returns in bounded time (codex#7852 mitigation — group SIGKILL).
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-c'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-c-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-c-mock-'));
    writeMockCodex(mockDir, {
      payload: validPayload,
      exitCode: 0,
      extraScript: 'sleep 60 &\nsleep 30',
    });
    const t0 = Date.now();
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo, '--timeout', '1'], mockDir, repo);
    const elapsed = Date.now() - t0;
    assert(r.status !== 0, 'C: timeout with orphan makes adapter exit non-zero', `status=${r.status}`);
    assert(elapsed < 10000, 'C: timeout kill is bounded (< 10s wall time)', `elapsed=${elapsed}ms`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario D — malformed JSON payload → adapter-failed best-effort result-file.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-d'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-d-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-d-mock-'));
    writeMockCodex(mockDir, { payload: 'not { json', exitCode: 0 });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status !== 0, 'D: malformed JSON makes adapter exit non-zero', `status=${r.status}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', 'D: result-file best-effort adapter-failed', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario E — no-commit violated: mock commits inside CODEXCWD → invariant error.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-e'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-e-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-e-mock-'));
    writeMockCodex(mockDir, {
      payload: validPayload,
      exitCode: 0,
      extraScript: `git -C "$CODEXCWD" -c user.email=m@m -c user.name=m commit -q --allow-empty -m sneaky`,
    });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status !== 0, 'E: sneaky commit makes adapter exit non-zero', `status=${r.status}`);
    assert(/commit|HEAD/i.test(r.stderr), 'E: stderr mentions commit/HEAD invariant', `stderr=${r.stderr}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario F — result-file inside the repo → refused before codex is invoked.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-f'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultFile = path.join(repo, 'result.json'); // INSIDE cwd — must be refused
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-f-marker-'));
    const marker = path.join(markerDir, 'invoked.marker');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-f-mock-'));
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$MARKER"` });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo,
      { env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, MARKER: marker } });
    assert(r.status !== 0, 'F: result-file inside workspace makes adapter exit non-zero', `status=${r.status}`);
    assert(!fs.existsSync(marker), 'F: mock codex never invoked (marker absent)', `marker=${marker}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(markerDir);
    cleanup(mockDir);
  }

  // Scenario G — heartbeat mid-run: async spawn + poll result-file for status
  // 'running' + numeric pid before the final JSON lands.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-g'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-g-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-g-mock-'));
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, sleepSecs: 3 });

    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const env = { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH };
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [
      xllmPath, '--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', repo,
    ], { cwd: repo, env });

    let sawRunningHeartbeat = false;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 15000) {
      if (fs.existsSync(resultFile)) {
        try {
          const j = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          if (j && j.status === 'running' && typeof j.pid === 'number') {
            sawRunningHeartbeat = true;
            break;
          }
        } catch (e) { /* file mid-write — retry */ }
      }
      // Busy-poll with a tiny synchronous sleep (Atomics.wait keeps this smoke test
      // dependency-free — no extra package for an async sleep).
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, 200);
    }
    assert(sawRunningHeartbeat, 'G: heartbeat observed with status running + numeric pid', `resultFile=${fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '(missing)'}`);

    // Wait for the real 'exit' event via a Promise + setTimeout bound — NOT the
    // Atomics.wait busy-poll used above: Atomics.wait blocks the JS thread
    // synchronously (no libuv turns), so the child's 'exit' event (delivered via
    // SIGCHLD -> libuv) would never be processed while busy-polling. Awaiting
    // lets the event loop run and actually deliver it.
    const exitResult = await new Promise((resolve) => {
      let done = false;
      const finish = (code) => { if (!done) { done = true; resolve(code); } };
      child.on('exit', (code) => finish(code));
      setTimeout(() => finish(null), 15000).unref?.();
    });
    assert(exitResult !== null, 'G: adapter process exits within bound', `exitResult=${exitResult}`);
    assert(exitResult === 0, 'G: adapter exits 0 on final settle', `exitResult=${exitResult}`);
    let finalParsed = null;
    try { finalParsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!finalParsed && finalParsed.status === 'done', 'G: final result-file has status done', JSON.stringify(finalParsed));
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario H — .gsd/ warning: advisory only, run still succeeds.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-h'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-h-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-h-mock-'));
    writeMockCodex(mockDir, {
      payload: validPayload,
      exitCode: 0,
      extraScript: `mkdir -p "$CODEXCWD/.gsd" && printf 'x' > "$CODEXCWD/.gsd/x.md"`,
    });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 0, 'H: .gsd/ touch is advisory only — exit 0', `status=${r.status} stderr=${r.stderr}`);
    assert(/\.gsd/.test(r.stderr) && /warn/i.test(r.stderr), 'H: stderr contains .gsd warning', `stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'done', 'H: run still completes normally (status done)', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(resultDir);
    cleanup(mockDir);
  }
}

// ── Section 25: engine dispatch (reset + fallback + dirty guard) ────────────
// Validates the SCRIPTABLE pieces of the T01/S02 "worker-engine-fallback"
// contract in isolation: (A) happy path — result JSON carries the fields the
// orchestrator reads to assemble the SUMMARY, no commit is made; (B) failure
// post-write — the canonical reset (`git checkout START_SHA -- . && git clean
// -fd`) empties the diff and a worker-engine-fallback event line is appended;
// (C) the dirty-tree guard refuses before codex ever runs. The full
// orchestration (decision to reset, dispatch of the Claude fallback) is
// markdown-only (T02/T03) — this smoke proves the pieces that ARE scriptable.
function smokeEngineDispatch() {
  process.stdout.write('\n▸ Section 25: engine dispatch (reset + fallback + dirty guard)\n');

  const validPayload = JSON.stringify({
    status: 'done',
    summary: 'did the task',
    must_haves_status: [{ item: 'truth 1', status: 'met', note: 'ok' }],
    files_changed: ['task-file.txt'],
  });

  // Scenario A — happy: mock codex writes a real file + valid result JSON.
  // Orchestrator-readable fields present, no commit made.
  {
    const repo = mkGitRepo(mkTmp('engine-a'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-a-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T04\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-a-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-a-mock-'));
    writeMockCodex(mockDir, {
      payload: validPayload,
      exitCode: 0,
      extraScript: `printf 'x' > "$CODEXCWD/task-file.txt"`,
    });
    const startSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const beforeLog = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout;
    const r = runXllm(['--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 0, 'A: happy execute exits 0', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'done', 'A: result JSON has status', JSON.stringify(parsed));
    assert(!!parsed && typeof parsed.summary === 'string' && parsed.summary.length > 0,
      'A: result JSON has summary', JSON.stringify(parsed));
    assert(!!parsed && Array.isArray(parsed.must_haves_status),
      'A: result JSON has must_haves_status array', JSON.stringify(parsed));
    assert(!!parsed && Array.isArray(parsed.files_changed)
      && parsed.files_changed.some((f) => f.path === 'task-file.txt' && f.status === 'A'),
      'A: result JSON has files_changed with real write', JSON.stringify(parsed && parsed.files_changed));
    const afterLog = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(afterLog === beforeLog, 'A: git log unchanged (no-commit)', `before=${JSON.stringify(beforeLog)} after=${JSON.stringify(afterLog)}`);
    const diffNames = spawnSync('git', ['diff', '--name-status', startSha], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(!/\.gsd\//.test(diffNames), 'A: no .gsd/ path in diff against START_SHA', diffNames);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario B — failure post-write: mock writes a real file then fails; the
  // canonical reset (checkout START_SHA -- . && clean -fd) must fully restore
  // the tree, and a worker-engine-fallback event line must be appended.
  {
    const repo = mkGitRepo(mkTmp('engine-b'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-b-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T04\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-b-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-b-mock-'));
    writeMockCodex(mockDir, {
      writeOutput: false,
      exitCode: 1,
      extraScript: `printf 'dirty' > "$CODEXCWD/leftover.txt"`,
    });
    const startSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const r = runXllm(['--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status !== 0, 'B: codex failure makes adapter exit non-zero', `status=${r.status}`);
    // Confirm the tree was actually dirtied before applying the reset.
    const dirtyStatus = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(dirtyStatus.trim().length > 0, 'B: tree is dirty pre-reset (mock wrote leftover.txt)', dirtyStatus);

    // Canonical reset — shared/forge-dispatch.md § Fallback, Action sequence.
    spawnSync('git', ['checkout', startSha, '--', '.'], { cwd: repo, encoding: 'utf8' });
    spawnSync('git', ['clean', '-fd'], { cwd: repo, encoding: 'utf8' });

    const diffAfterReset = spawnSync('git', ['diff', '--name-only', startSha], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(diffAfterReset.trim() === '', 'B: git diff --name-only START_SHA is empty after reset', diffAfterReset);
    const statusAfterReset = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(statusAfterReset.trim() === '', 'B: git status --porcelain is empty after reset', statusAfterReset);

    // worker-engine-fallback event — shared/forge-dispatch.md § Fallback.
    const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-b-events-'));
    const eventsFile = path.join(eventsDir, 'events.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: 'worker-engine-fallback',
      milestone: 'M005',
      slice: 'S02',
      unit: 'execute-task/T04',
      reason: 'codex-exit-nonzero',
    });
    fs.appendFileSync(eventsFile, line + '\n', 'utf8');
    const eventsRaw = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    let eventParsed = null;
    try { eventParsed = JSON.parse(eventsRaw[eventsRaw.length - 1]); } catch (e) { /* leave null */ }
    assert(!!eventParsed && eventParsed.event === 'worker-engine-fallback',
      'B: events.jsonl has a worker-engine-fallback line', JSON.stringify(eventParsed));
    assert(!!eventParsed && eventParsed.reason === 'codex-exit-nonzero',
      'B: fallback event reason is codex-exit-nonzero', JSON.stringify(eventParsed));

    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
    cleanup(eventsDir);
  }

  // Scenario C — dirty-tree guard: tree dirty BEFORE dispatch, adapter refuses
  // (exit != 0) proving the orchestrator never resets/dispatches over
  // uncommitted work.
  {
    const repo = mkGitRepo(mkTmp('engine-c'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-c-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T04\ndo the thing\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n', 'utf8'); // dirties tree pre-dispatch
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-c-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-c-marker-'));
    const marker = path.join(markerDir, 'invoked.marker');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-c-mock-'));
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$MARKER"` });
    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const r = spawnSync(process.execPath, [
      xllmPath, '--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', repo,
    ], {
      encoding: 'utf8',
      cwd: repo,
      env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, MARKER: marker },
    });
    assert(r.status !== 0, 'C: dirty tree pre-dispatch makes adapter exit non-zero', `status=${r.status}`);
    assert(!fs.existsSync(marker), 'C: mock codex never invoked (marker absent — dirty-tree-guard)', `marker=${marker}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(markerDir);
    cleanup(mockDir);
  }

  // Scenario D — prefs reader (R2): env vars must be passed PREFIX form so `node -e`
  // receives them via process.env (postfix form after the closing quote becomes ignored
  // argv). Round-trips the canonical reader over a temp prefs that sets ONLY
  // workers.plan-slice — asserting it does NOT leak to workers.execute-task.
  {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-d-wd-'));
    fs.mkdirSync(path.join(wd, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(wd, '.gsd', 'claude-agent-prefs.md'),
      'workers:\n  plan-slice: codex\n', 'utf8');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-d-home-'));
    const readerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-d-reader-'));
    const readerFile = path.join(readerDir, 'reader.js');
    // Canonical reader body (un-bash-escaped) — mirror of the WORKERS_CFG node -e in
    // shared/forge-dispatch.md + the three SKILL.md mirrors.
    fs.writeFileSync(readerFile, [
      "const fs=require('fs'),path=require('path'),os=require('os');",
      "const wd=process.env.WORKING_DIR||process.cwd();",
      "const unit=process.env.UNIT_TYPE||'execute-task';",
      "const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),",
      "             path.join(wd,'.gsd','claude-agent-prefs.md'),",
      "             path.join(wd,'.gsd','prefs.local.md')];",
      "let engine=null,timeout=1800,codexModel=null;",
      "for(const f of files){try{",
      "  const r=fs.readFileSync(f,'utf8');",
      "  const blk=(r.match(/^workers:[ \\t]*\\n((?:[ \\t]+.*\\n?)*)/m)||[])[1]||'';",
      "  let m;",
      "  const unitRe=new RegExp('^[ \\\\t]+'+unit.replace(/[-]/g,'\\\\-')+':[ \\\\t]*(\\\\w+)','m');",
      "  if(m=blk.match(unitRe)){const v=m[1].toLowerCase();if(v==='claude'||v==='codex')engine=v;}",
      "  if(m=blk.match(/^[ \\t]+timeout:[ \\t]*(\\d+)/m))timeout=parseInt(m[1],10);",
      "  if(m=blk.match(/^[ \\t]+codex_model:[ \\t]*(\\S+)/m))codexModel=m[1];",
      "}catch(e){}}",
      "if(engine!=='claude'&&engine!=='codex')engine='claude';",
      "if(!Number.isInteger(timeout)||timeout<=0)timeout=1800;",
      "process.stdout.write(JSON.stringify({engine,timeout,codexModel}));",
    ].join('\n'), 'utf8');
    const runReader = (unitType) => {
      const rr = spawnSync(process.execPath, [readerFile], {
        encoding: 'utf8',
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, WORKING_DIR: wd, UNIT_TYPE: unitType },
      });
      try { return JSON.parse(rr.stdout); } catch (e) { return null; }
    };
    const execCfg = runReader('execute-task');
    const planCfg = runReader('plan-slice');
    assert(!!execCfg && execCfg.engine === 'claude',
      'D: workers.plan-slice does NOT leak to execute-task (engine=claude)', JSON.stringify(execCfg));
    assert(!!planCfg && planCfg.engine === 'codex',
      'D: workers.plan-slice reads back for plan-slice (engine=codex, prefix-form env passed)', JSON.stringify(planCfg));
    cleanup(wd);
    cleanup(homeDir);
    cleanup(readerDir);
  }

  // Scenario E — durable sidecar state (R1): the state file persisted at dispatch
  // must round-trip start_sha/result_file/code_dir from disk (shell vars do not
  // survive the poll loop across Bash invocations).
  {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-engine-e-'));
    const stateFile = path.join(stateDir, 'xllm-state-T04.json');
    const startSha = 'abc123def456';
    const codeDir = '/some/code/dir';
    const resultFile = '/tmp/forge-xllm-result.XXXX.json';
    fs.writeFileSync(stateFile,
      JSON.stringify({ start_sha: startSha, reason: '', result_file: resultFile, code_dir: codeDir }) + '\n', 'utf8');
    const readField = (field) => spawnSync(process.execPath,
      ['-pe', `JSON.parse(require('fs').readFileSync('${stateFile}','utf8')).${field}`],
      { encoding: 'utf8' }).stdout.trim();
    assert(readField('start_sha') === startSha, 'E: start_sha round-trips from state file', readField('start_sha'));
    assert(readField('code_dir') === codeDir, 'E: code_dir round-trips from state file', readField('code_dir'));
    assert(readField('result_file') === resultFile, 'E: result_file round-trips from state file', readField('result_file'));
    cleanup(stateDir);
  }

  // Scenario F — scoped reset (R4): the fallback reset must exclude .gsd/ so the
  // orchestrator's own .gsd writes (events.jsonl / evidence) made during the poll
  // survive even when .gsd is committed (user projects may commit it).
  {
    const repo = mkGitRepo(mkTmp('engine-f'));
    const startSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    // Simulate codex-authored source change + orchestrator's own .gsd writes during the poll.
    fs.writeFileSync(path.join(repo, 'src.txt'), 'codex change\n', 'utf8');
    fs.mkdirSync(path.join(repo, '.gsd', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.gsd', 'forge', 'events.jsonl'), '{"event":"dispatch"}\n', 'utf8');
    // Scoped reset — shared/forge-dispatch.md § Fallback (R4): exclude .gsd/.
    spawnSync('git', ['checkout', startSha, '--', '.', ':(exclude).gsd'], { cwd: repo, encoding: 'utf8' });
    spawnSync('git', ['clean', '-fd', '-e', '.gsd'], { cwd: repo, encoding: 'utf8' });
    assert(!fs.existsSync(path.join(repo, 'src.txt')), 'F: codex source change reverted by scoped reset', 'src.txt still present');
    assert(fs.existsSync(path.join(repo, '.gsd', 'forge', 'events.jsonl')),
      'F: .gsd/ writes survive the scoped reset (events.jsonl preserved)', '.gsd events.jsonl was wiped');
    cleanup(repo);
  }
}

// ── Section 26: forge-xllm plan mode (mock codex on PATH) ───────────────────
// Offline, live-spawn coverage of the T01 --mode plan adapter: (A) happy path
// + materialization-ready shape, asserting read-only (no repo/.gsd writes) and
// that the generated T##-PLAN content passes forge-must-haves.js standalone;
// (B) malformed must_haves in a returned task_plan → exit 2 + adapter-failed
// (the ENFORCING in-sidecar gate from runPlan); (C) codex absent from PATH →
// exit 2 (spawn ENOENT), mirroring the execute-mode offline scenario.
async function smokeXllmPlan() {
  process.stdout.write('\n▸ Section 26: forge-xllm plan mode (mock codex on PATH)\n');

  function runPlanXllm(args, mockDir, cwd) {
    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const env = mockDir
      ? { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH }
      : { ...process.env, PATH: '' };
    const r = spawnSync(process.execPath, [xllmPath, '--mode', 'plan', ...args], {
      encoding: 'utf8',
      cwd: cwd || process.cwd(),
      env,
    });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
  }

  // A valid T##-PLAN.md body — frontmatter carries a well-formed must_haves
  // block (mirrors the schema this task's own T04-PLAN.md uses).
  const validTaskPlanContent = [
    '---',
    'id: T01',
    'slice: S99',
    'milestone: M999',
    'must_haves:',
    '  truths:',
    '    - "the thing works"',
    '  artifacts:',
    '    - path: "src/thing.js"',
    '      provides: "the thing"',
    '      min_lines: 5',
    '  key_links:',
    '    - from: "src/thing.js"',
    '      to: "src/other.js"',
    '      via: "import"',
    'expected_output:',
    '  - src/thing.js',
    '---',
    '',
    '# T01: do the thing',
    '',
    '## Steps',
    '1. Do the thing.',
    '',
  ].join('\n');

  // Malformed variant — artifacts[0] is missing min_lines (required number field).
  const invalidTaskPlanContent = [
    '---',
    'id: T01',
    'slice: S99',
    'milestone: M999',
    'must_haves:',
    '  truths:',
    '    - "the thing works"',
    '  artifacts:',
    '    - path: "src/thing.js"',
    '      provides: "the thing"',
    '  key_links: []',
    'expected_output:',
    '  - src/thing.js',
    '---',
    '',
    '# T01: do the thing (broken)',
    '',
  ].join('\n');

  function planPayload(taskPlanContent) {
    return JSON.stringify({
      status: 'done',
      summary: 'planned the slice',
      slice_plan: { filename: 'S99-PLAN.md', content: '# S99: slice plan\n\ntasks: T01\n' },
      task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: taskPlanContent }],
    });
  }

  // Scenario A — happy path + materialization-ready shape, read-only.
  {
    const repo = mkGitRepo(mkTmp('xllm-plan-a'));
    const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-ctx-'));
    const ctxFile = path.join(ctxDir, 'plan-context.md');
    fs.writeFileSync(ctxFile, '# Slice context\nplan the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-a-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-a-mock-'));
    writeMockCodex(mockDir, { payload: planPayload(validTaskPlanContent), exitCode: 0 });
    const beforeStatus = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    const r = runPlanXllm(['--plan-context', ctxFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 0, 'A: happy plan exits 0', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'done', 'A: result-file has status done', JSON.stringify(parsed));
    assert(!!parsed && !!parsed.slice_plan && typeof parsed.slice_plan.content === 'string' && parsed.slice_plan.content.length > 0,
      'A: slice_plan.content is non-empty', JSON.stringify(parsed && parsed.slice_plan));
    assert(!!parsed && Array.isArray(parsed.task_plans) && parsed.task_plans.length >= 1,
      'A: task_plans has at least one entry', JSON.stringify(parsed && parsed.task_plans));
    const afterStatus = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(afterStatus === beforeStatus && afterStatus.trim() === '', 'A: repo working tree stays clean (read-only)', `before=${JSON.stringify(beforeStatus)} after=${JSON.stringify(afterStatus)}`);
    // mkTmp() pre-seeds .gsd/forge/ (committed by mkGitRepo's init commit), so
    // .gsd/ existing is expected — the read-only invariant is that git status
    // stays clean (asserted above), i.e. no NEW file lands under .gsd/ either.

    // Assert the generated T##-PLAN content passes forge-must-haves.js standalone.
    const tpContentFile = path.join(resultDir, 'T01-PLAN.md');
    fs.writeFileSync(tpContentFile, parsed.task_plans[0].content, 'utf8');
    const mh = spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-must-haves.js'), '--check', tpContentFile], { encoding: 'utf8' });
    assert(mh.status === 0, 'A: generated task_plans[0].content passes forge-must-haves.js --check', `status=${mh.status} stdout=${mh.stdout} stderr=${mh.stderr}`);

    cleanup(repo);
    cleanup(ctxDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario B — malformed must_haves in the returned task_plan → exit 2 + adapter-failed.
  {
    const repo = mkGitRepo(mkTmp('xllm-plan-b'));
    const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-ctx-'));
    const ctxFile = path.join(ctxDir, 'plan-context.md');
    fs.writeFileSync(ctxFile, '# Slice context\nplan the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-b-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-b-mock-'));
    writeMockCodex(mockDir, { payload: planPayload(invalidTaskPlanContent), exitCode: 0 });
    const r = runPlanXllm(['--plan-context', ctxFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 2, 'B: malformed must_haves makes adapter exit 2', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', 'B: result-file marks status adapter-failed', JSON.stringify(parsed));
    assert(!!parsed && /must_haves|T01/i.test(parsed.reason || ''), 'B: adapter-failed reason mentions must_haves/T01', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(ctxDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario C — codex absent from PATH (offline) → exit 2.
  {
    const repo = mkGitRepo(mkTmp('xllm-plan-c'));
    const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-ctx-'));
    const ctxFile = path.join(ctxDir, 'plan-context.md');
    fs.writeFileSync(ctxFile, '# Slice context\nplan the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-c-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const r = runPlanXllm(['--plan-context', ctxFile, '--result-file', resultFile, '--cwd', repo], null, repo);
    assert(r.status === 2, 'C: codex absent (offline) makes adapter exit 2', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', 'C: result-file marks status adapter-failed on offline failure', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(ctxDir);
    cleanup(resultDir);
  }

  // Path-traversal + empty-summary guards (validatePlanResult defense-in-depth).
  // id/filename are untrusted codex output that Branch D concatenates into a
  // filesystem path with mkdir -p; validatePlanResult must reject anything that
  // isn't a bare task id / plain .md basename before materialization.
  function badPlanPayload({ id, filename, summary } = {}) {
    return JSON.stringify({
      status: 'done',
      summary: summary !== undefined ? summary : 'planned the slice',
      slice_plan: { filename: 'S99-PLAN.md', content: '# S99: slice plan\n\ntasks: T01\n' },
      task_plans: [{
        id: id !== undefined ? id : 'T01',
        filename: filename !== undefined ? filename : 'T01-PLAN.md',
        content: validTaskPlanContent,
      }],
    });
  }
  const traversalCases = [
    { name: 'D: task_plan id="../evil" rejected', payload: badPlanPayload({ id: '../evil' }) },
    { name: 'D: task_plan id with slash rejected', payload: badPlanPayload({ id: 'T01/../../x' }) },
    { name: 'E: filename="../x.md" rejected', payload: badPlanPayload({ filename: '../x.md' }) },
    { name: 'E: filename with slash rejected', payload: badPlanPayload({ filename: 'a/b.md' }) },
    { name: 'F: empty summary rejected', payload: badPlanPayload({ summary: '   ' }) },
  ];
  for (let i = 0; i < traversalCases.length; i++) {
    const tc = traversalCases[i];
    const repo = mkGitRepo(mkTmp(`xllm-plan-guard-${i}`));
    const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-ctx-'));
    const ctxFile = path.join(ctxDir, 'plan-context.md');
    fs.writeFileSync(ctxFile, '# Slice context\nplan the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-guard-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-plan-guard-mock-'));
    writeMockCodex(mockDir, { payload: tc.payload, exitCode: 0 });
    const r = runPlanXllm(['--plan-context', ctxFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
    assert(r.status === 2, tc.name + ' → adapter exit 2', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', tc.name + ' → result-file adapter-failed', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(ctxDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }
}

async function main() {
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
    smokeIsolation();
    smokeLivenessBanner();
    smokeSymbolAndTestQuality();
    smokeContextMonitor();
    smokeNodeRepair();
    smokeStopHook();
    smokeNotifications();
    smokeReviewEngine();
    smokeAccounts();
    smokeEffort();
    smokeUsageIndicator();
    smokePlanGateDegradation();
    smokeXllm();
    await smokeXllmExecute();
    smokeModelAlias();
    smokeChallengerWiring();
    smokeAdvocateModel();
    smokeEngineDispatch();
    await smokeXllmPlan();
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
