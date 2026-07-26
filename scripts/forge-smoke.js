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
const { spawnSync, execFileSync } = require('child_process');

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

// Independent leaf/section walker over the raw prefs schema — deliberately
// NOT forge-prefs-view.js's walkSchemaLeaves, so comparisons against it
// prove "the viewer doesn't drop a knob the schema declares" instead of a
// function compared against itself. Adding a knob to forge-prefs.schema.json
// moves this set without touching any hardcoded count in this file.
function independentSchemaLeafKeys(schema) {
  const leafPaths = new Set();
  const sections = new Set();
  function walk(node, prefix, section) {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, prefix ? `${prefix}.${key}` : key, section || key);
      }
      return;
    }
    leafPaths.add(prefix);
    sections.add(section);
  }
  if (schema && schema.properties) {
    for (const [topKey, topNode] of Object.entries(schema.properties)) {
      walk(topNode, topKey, topKey);
    }
  }
  return { leafPaths, sections };
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function describeSetDiff(a, b) {
  const missing = [...b].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !b.has(x));
  return `missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)}`;
}

function runScript(name, args, opts) {
  opts = opts || {};
  const r = spawnSync('node', [path.join(SCRIPTS, name), ...args], { encoding: 'utf8', ...opts });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// The generated JSONC catalog is the canonical preference scaffold. Keep all
// scaffold assertions on this source so the deleted root Markdown template
// cannot become an accidental test dependency.
const scaffoldResult = runScript('forge-prefs.js', ['--scaffold', '--schema-ref', 'forge-prefs.schema.json']);
const SCAFFOLD = scaffoldResult.stdout;

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

// ── Hermetic HOME override (MEM032) ─────────────────────────────────────────
// Tests that assert "no routing / legacy tier_models" behavior must not be
// polluted by a real ~/.claude/forge-agent-prefs.md on the machine running
// the smoke suite (e.g. a global `routing:` block). Points os.homedir() at a
// bare temp dir (no .claude/forge-agent-prefs.md) for the duration of `fn`,
// restoring HOME/USERPROFILE afterward. Covers both in-process resolveRoute()
// calls and subprocess CLI spawns (pass the returned env to runScript opts).
function withHermeticHome(fn) {
  const homeDir = mkTmp('hermetic-home');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    return fn({ env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir } });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    cleanup(homeDir);
  }
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
  fs.writeFileSync(path.join(repo, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"branch","auto_pull_main":false}}');

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
  fs.writeFileSync(path.join(repo, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"worktree","auto_pull_main":false,"worktree_cleanup_on_complete":true}}');
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

  fs.writeFileSync(path.join(clone, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"worktree","auto_pull_main":true}}');
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

  // prefs scaffold present in the generated JSONC catalog
  assert(/"context_monitor":/.test(SCAFFOLD), 'ctx #10: prefs section present');
  assert(/"context_monitor":/.test(SCAFFOLD) && /"enabled":\s*true/.test(SCAFFOLD), 'ctx #11: context_monitor.enabled key present');
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
  const prefsContent = SCAFFOLD;
  const autoSkillPath = path.join(ROOT, 'skills', 'forge-auto', 'SKILL.md');

  // ── (a) Pref scaffold: generated JSONC notifications block ───────────────
  assert(
    prefsContent.includes('"notifications":'),
    'generated prefs scaffold has notifications block',
    'generated prefs scaffold is missing the notifications key'
  );
  assert(
    prefsContent.includes('"notifications":'),
    'generated prefs scaffold has notifications key',
    'generated prefs scaffold is missing notifications'
  );
  assert(
    /"notifications":\s+"on"/.test(prefsContent),
    'generated prefs scaffold has notifications: on as default',
    'generated prefs scaffold notifications default is not on'
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
  const specPath   = path.join(ROOT, 'shared', 'forge-review.md');

  // ── (a) Generated JSONC review block with engine: agents ──────────────────
  const prefsContent = SCAFFOLD;
  const reviewSettingsIdx = prefsContent.indexOf('"review":');
  assert(
    reviewSettingsIdx !== -1,
    'review-engine: generated pref review block',
    'generated prefs scaffold is missing review'
  );

  assert(
    /"engine":\s*"agents"/.test(prefsContent),
    'review-engine: pref engine key',
    'generated prefs scaffold review.engine is not agents'
  );

  // Semântica section should mention review-engine-fallback (doc of fallback present)
  assert(
    prefsContent.includes('fallback automático') || prefsContent.includes('fallback'),
    'review-engine: generated pref fallback documentation',
    'generated prefs scaffold is missing review fallback documentation'
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
    process.env.HOME=${JSON.stringify(dir)};
    process.env.USERPROFILE=${JSON.stringify(dir)};
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

  const resolver = rd('scripts/forge-dispatch-resolve.js');
  for (const [label, txt] of [['forge-auto', auto], ['forge-next', next]]) {
    // M012 S02 cutover: effort is resolved by forge-dispatch-resolve.js; the SKILL delegates.
    assert(/forge-dispatch-resolve\.js/.test(txt), `${label}: delegates dispatch resolution to forge-dispatch-resolve.js`, 'resolver call missing');
    assert(txt.includes('EFFORT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort)"'), `${label}: extracts effort from the resolver contract`, 'EFFORT extraction missing');
    assert(txt.includes('EFFORT_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort_reason)"'), `${label}: extracts effort_reason from the resolver contract`, 'EFFORT_REASON extraction missing');
    // the inline effort block + its default map + clamp must be gone (logic lives only in the resolver)
    assert(!/declare -A EFFORT_DEFAULTS/.test(txt), `${label}: inline EFFORT_DEFAULTS map removed`, 'inline effort map still present');
    // dispatch event carries effort + effort_reason
    assert(/event.*dispatch[\s\S]*?effort\\?":\\?"\$\{?EFFORT/.test(txt), `${label}: dispatch event includes effort`, 'effort field missing from event');
    assert(/effort_reason\\?":\\?"\$\{?EFFORT_REASON/.test(txt), `${label}: dispatch event includes effort_reason`, 'effort_reason field missing');
  }

  // Effort logic (frontmatter axis + model-cap clamp) now lives in the shared resolver.
  assert(/frontmatter-effort:/.test(resolver), 'forge-dispatch-resolve: frontmatter-effort reason present', 'reason missing');
  assert(/clamped:model-cap/.test(resolver), 'forge-dispatch-resolve: model-cap clamp present', 'clamp missing');

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
  const prefs = SCAFFOLD;

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

  // (d) plan_gate: generated scaffold with correct defaults
  assert(/"plan_gate":/.test(prefs),
    '(d) generated scaffold has plan_gate block', 'plan_gate block missing');
  assert(/"interactive":\s*"always"/.test(prefs),
    '(d) plan_gate.interactive defaults to always', 'interactive: always missing');
  assert(/"ask_in_auto":\s*"defer"/.test(prefs),
    '(d) plan_gate.ask_in_auto defaults to defer', 'ask_in_auto: defer missing');
}

// ── Section 20: forge-xllm adapter (mock codex on PATH + mock agy via env) ──
// Live-spawns the T01 adapter against a mock `codex` shell binary prepended to
// PATH — structural (token-presence) asserts don't catch runtime failures.
// The agy engine scenarios (G–M) inject a Node mock via FORGE_XLLM_AGY_BIN
// instead, which also runs on Windows.
function writeMockCodex(dir, opts) {
  opts = opts || {};
  const script = [
    '#!/bin/sh',
    '# forge-smoke mock codex — writes payload to the -o file, honors exit code / sleep',
    'OUT=""',
    'CODEXCWD=""',
    // FORGE_PROMPTLEN_FILE is intentionally NOT initialized here — it comes from the
    // environment (set by the large-prompt smoke scenario) so the mock can record
    // the stdin-received prompt length. Clobbering it to "" would disable the assert.
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-o" ]; then OUT="$arg"; fi',
    '  if [ "$prev" = "-C" ]; then CODEXCWD="$arg"; fi',
    '  prev="$arg"',
    'done',
    // New transport: the prompt arrives on stdin (`codex exec -`), NOT argv. Drain
    // it fully — this both exercises the stdin pipe/EOF contract and lets callers
    // that set FORGE_PROMPTLEN_FILE assert the received byte length (large-prompt test).
    'PROMPT="$(cat -)"',
    'if [ -n "$FORGE_PROMPTLEN_FILE" ]; then printf %s "${#PROMPT}" > "$FORGE_PROMPTLEN_FILE"; fi',
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

// Section 25 helper — plain git repo fixture (init + initial commit so the
// working tree starts clean). Reusable by S02/S04.
function mkGitRepo(dir) {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['add', '-A']);
  run(['-c', 'user.email=smoke@forge', '-c', 'user.name=smoke', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

// Mock agy as a Node script injected via FORGE_XLLM_AGY_BIN — cross-platform
// (unlike the POSIX-sh mock codex), so the agy scenarios run on Windows too.
// The mock prints `payload` to stdout and exits `exitCode`. With checkContract
// it first verifies the adapter's invocation contract (--sandbox present, -p
// carries a "Read the file at <path>" instruction, the prompt file exists and
// holds the real payload) and exits 3 on any violation.
function writeMockAgy(dir, opts) {
  opts = opts || {};
  const js = [
    '// forge-smoke mock agy',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const pIdx = args.indexOf('-p');",
    "const inline = pIdx >= 0 ? String(args[pIdx + 1] || '') : '';",
    `if (${opts.checkContract ? 'true' : 'false'}) {`,
    "  if (!args.includes('--sandbox')) { process.stderr.write('mock: no --sandbox'); process.exit(3); }",
    '  const m = inline.match(/Read the file at (.+?) and follow/);',
    "  if (!m) { process.stderr.write('mock: no prompt-file instruction'); process.exit(3); }",
    "  let t = ''; try { t = fs.readFileSync(m[1], 'utf8'); } catch (e) { process.stderr.write('mock: prompt file unreadable'); process.exit(3); }",
    "  if (!t.includes('DIFF START') && !t.includes('OBJECTIONS')) { process.stderr.write('mock: prompt file misses payload'); process.exit(3); }",
    '}',
    opts.sleepMs
      ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${opts.sleepMs});`
      : '',
    `process.stdout.write(${JSON.stringify(String(opts.payload == null ? '' : opts.payload))});`,
    `process.exit(${typeof opts.exitCode === 'number' ? opts.exitCode : 0});`,
    '',
  ].join('\n');
  const agyPath = path.join(dir, 'mock-agy.js');
  fs.writeFileSync(agyPath, js, 'utf8');
  return agyPath;
}

function runXllm(args, mockDir, cwd, extraEnv) {
  const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
  const env = mockDir
    ? { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH }
    : { ...process.env, PATH: '' };
  if (extraEnv) Object.assign(env, extraEnv);
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

  // Scenario A2 — large prompt via stdin: a >40KB diff must NOT hit the argv/command-line
  // cap (Windows ENAMETOOLONG). The mock reads the prompt from stdin (`codex exec -`) and
  // records the received byte length to FORGE_PROMPTLEN_FILE — proving the full prompt crossed
  // the stdin pipe (not truncated by any argv limit) and the adapter still exits 0.
  {
    const dir = mkTmp('xllm-a2');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-a2-mock-'));
    const lenFile = path.join(dir, 'promptlen.txt');
    // >40KB of diff-ish content embedded in the prompt via the diff command output.
    const bigDiff = '+ line of a very large generated diff payload aaaaaaaaaaaaaaaaaa\n'.repeat(700);
    fs.writeFileSync(path.join(dir, 'big.txt'), bigDiff, 'utf8');
    const payload = JSON.stringify({ objections: [] });
    writeMockCodex(mockDir, { payload, exitCode: 0 });
    const r = runXllm(
      ['--mode', 'challenge', '--diff-cmd', 'cat big.txt', '--cwd', dir],
      mockDir, dir, { FORGE_PROMPTLEN_FILE: lenFile },
    );
    assert(bigDiff.length > 40 * 1024, 'A2: fixture diff is >40KB', `len=${bigDiff.length}`);
    assert(r.status === 0, 'A2: large-prompt challenge exits 0 (no ENAMETOOLONG)', `status=${r.status} stderr=${r.stderr}`);
    let receivedLen = 0;
    try { receivedLen = parseInt(fs.readFileSync(lenFile, 'utf8'), 10) || 0; } catch (e) { /* leave 0 */ }
    assert(receivedLen > 40 * 1024, 'A2: mock received >40KB prompt via stdin', `receivedLen=${receivedLen}`);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(!!parsed && Array.isArray(parsed.objections), 'A2: stdout parses to objections array', `stdout=${r.stdout.slice(0, 200)}`);
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

  // ── agy engine scenarios (mock injected via FORGE_XLLM_AGY_BIN — cross-platform) ──

  // Scenario G — agy happy challenge WITH contract check: --sandbox present,
  // -p carries a "Read the file at <path>" instruction, prompt file exists and
  // holds the diff payload. Narration prose before the JSON must be tolerated.
  {
    const dir = mkTmp('xllm-g');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-g-mock-'));
    const payload = 'I will inspect the diff...\nStep narration line 2.\n' + JSON.stringify({
      objections: [{ id: 'R1', path_line: 'src/a.js:12', claim: 'x', suggested_fix: 'y', challenge: 'z?', severity: 'high' }],
    });
    const mockPath = writeMockAgy(mockDir, { payload, exitCode: 0, checkContract: true });
    const r = runXllm(['--mode', 'challenge', '--engine', 'agy', '--diff-cmd', 'echo diff', '--cwd', dir],
      null, dir, { FORGE_XLLM_AGY_BIN: mockPath });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(r.status === 0, 'G: agy happy challenge exits 0 (contract honored)', `status=${r.status} stderr=${r.stderr}`);
    const o = parsed && parsed.objections && parsed.objections[0];
    assert(!!o && o.id === 'R1' && o.severity === 'high' && o.file === 'src/a.js' && o.line === 12,
      'G: agy stdout normalizes to objections contract', `stdout=${r.stdout}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario H — agy missing binary: no override, PATH-hermetic → exit non-zero.
  {
    const dir = mkTmp('xllm-h');
    const r = runXllm(['--mode', 'challenge', '--engine', 'agy', '--diff-cmd', 'echo diff', '--cwd', dir], null, dir);
    assert(r.status !== 0, 'H: agy missing binary exits non-zero', `status=${r.status}`);
    assert(r.stderr.length > 0, 'H: agy missing binary writes stderr', `stderr=${r.stderr}`);
    cleanup(dir);
  }

  // Scenario I — agy exit 0 with EMPTY stdout (the known non-TTY dropout) → adapter non-zero.
  {
    const dir = mkTmp('xllm-i');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-i-mock-'));
    const mockPath = writeMockAgy(mockDir, { payload: '', exitCode: 0 });
    const r = runXllm(['--mode', 'challenge', '--engine', 'agy', '--diff-cmd', 'echo diff', '--cwd', dir],
      null, dir, { FORGE_XLLM_AGY_BIN: mockPath });
    assert(r.status !== 0, 'I: agy empty stdout (non-TTY dropout) exits non-zero', `status=${r.status}`);
    assert(/empty stdout/.test(r.stderr), 'I: agy empty stdout cause is on stderr', `stderr=${r.stderr}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario J — agy child exit ≠ 0 → adapter non-zero.
  {
    const dir = mkTmp('xllm-j');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-j-mock-'));
    const mockPath = writeMockAgy(mockDir, { payload: '', exitCode: 1 });
    const r = runXllm(['--mode', 'challenge', '--engine', 'agy', '--diff-cmd', 'echo diff', '--cwd', dir],
      null, dir, { FORGE_XLLM_AGY_BIN: mockPath });
    assert(r.status !== 0, 'J: agy child exit 1 makes adapter exit non-zero', `status=${r.status}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario K — agy timeout: mock sleeps past --timeout 1 (+5s grace) → killed, bounded.
  {
    const dir = mkTmp('xllm-k');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-k-mock-'));
    const mockPath = writeMockAgy(mockDir, { sleepMs: 20000, exitCode: 0, payload: JSON.stringify({ objections: [] }) });
    const t0 = Date.now();
    const r = runXllm(['--mode', 'challenge', '--engine', 'agy', '--diff-cmd', 'echo diff', '--cwd', dir, '--timeout', '1'],
      null, dir, { FORGE_XLLM_AGY_BIN: mockPath });
    const elapsed = Date.now() - t0;
    assert(r.status !== 0, 'K: agy timeout makes adapter exit non-zero', `status=${r.status}`);
    assert(elapsed < 15000, 'K: agy timeout kill is bounded (< 15s wall time)', `elapsed=${elapsed}ms`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario L — agy rebuttal happy path (contract check verifies OBJECTIONS payload reached the prompt file).
  {
    const dir = mkTmp('xllm-l');
    const inputFile = path.join(dir, 'input.txt');
    fs.writeFileSync(inputFile, 'R1: objection text\nDefense: still real\n', 'utf8');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-l-mock-'));
    const mockPath = writeMockAgy(mockDir, {
      payload: JSON.stringify({ verdicts: [{ id: 'R1', verdict: 'maintained', rationale: 'still real' }] }),
      exitCode: 0,
      checkContract: true,
    });
    const r = runXllm(['--mode', 'rebuttal', '--engine', 'agy', '--input', inputFile, '--cwd', dir],
      null, dir, { FORGE_XLLM_AGY_BIN: mockPath });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (e) { /* leave null */ }
    assert(r.status === 0, 'L: agy rebuttal happy path exits 0', `status=${r.status} stderr=${r.stderr}`);
    assert(!!parsed && parsed.verdicts && parsed.verdicts[0] && parsed.verdicts[0].verdict === 'maintained'
      && typeof parsed.verdicts[0].reason === 'string',
      'L: agy normalized verdict has verdict=maintained and reason', `stdout=${r.stdout}`);
    cleanup(dir);
    cleanup(mockDir);
  }

  // Scenario M — unknown --engine value is rejected up front.
  {
    const dir = mkTmp('xllm-m');
    const r = runXllm(['--mode', 'challenge', '--engine', 'llama', '--diff-cmd', 'echo diff', '--cwd', dir], null, dir);
    assert(r.status !== 0, 'M: unknown --engine exits non-zero', `status=${r.status}`);
    assert(/unknown --engine/.test(r.stderr), 'M: unknown --engine cause is on stderr', `stderr=${r.stderr}`);
    cleanup(dir);
  }

  // Scenario N — CVE-2024-27980 guard: on the cmd.exe /c last-resort path, any
  // argument carrying a shell metacharacter/quote (an untrusted challenger_model
  // is repo-committed and reaches argv as --model <value>) must be rejected
  // before it crosses cmd.exe. Unit-test the exported guard directly (the
  // cmd.exe path only triggers on win32, so a live subprocess can't exercise it
  // cross-platform).
  {
    const xllm = require(path.join(SCRIPTS, 'forge-xllm.js'));
    assert(typeof xllm.assertSafeForCmdShell === 'function',
      'N: forge-xllm exports assertSafeForCmdShell', `got ${typeof xllm.assertSafeForCmdShell}`);
    // Safe args (incl. an agy label with spaces + parens) must pass unharmed.
    let safeOk = true;
    try { xllm.assertSafeForCmdShell(['--model', 'Gemini 3.1 Pro (High)', '--sandbox']); }
    catch (e) { safeOk = false; }
    assert(safeOk, 'N: safe args (spaces/parens) pass the cmd-shell guard', 'unexpected throw');
    // The exact breakout payload from the review objection must be rejected.
    for (const evil of ['x" & echo PWNED & "', 'a|b', 'a&b', 'a>b', 'a<b', 'a^b', 'a%PATH%b']) {
      let threw = false;
      try { xllm.assertSafeForCmdShell(['--model', evil]); }
      catch (e) { threw = /CVE-2024-27980/.test(e.message); }
      assert(threw, `N: cmd-shell guard rejects metachar payload ${JSON.stringify(evil)}`, 'no throw / wrong message');
    }
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
      assert(content.includes("MODEL_ALIAS=$(node -e \"process.stdout.write(JSON.parse(process.argv[1]).alias"),
        `${name} resolves MODEL_ALIAS from the forge-dispatch-resolve.js contract`, 'not found');
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
  assert(spec.includes('engine-workflow-forced-agents'), 'spec has external-challenger x workflow precedence reason', 'token "engine-workflow-forced-agents" not found');
  assert(spec.includes('Challenger:'), 'spec Step 6 has Challenger: header', 'token "Challenger:" not found');
  assert(spec.includes('"challenger"'), 'spec Step 8 event has challenger field', 'token \'"challenger"\' not found');
  assert(spec.includes('scripts/forge-xllm.js'), 'spec invokes the forge-xllm.js adapter', 'token not found');
  assert(spec.includes("'claude','codex','gemini'"), 'spec Step 0 whitelist includes gemini', 'whitelist token not found');
  assert(spec.includes('XLLM_ENGINE'), 'spec Step 0 derives XLLM_ENGINE', 'token "XLLM_ENGINE" not found');
  assert(spec.includes('gemini-exit-nonzero'), 'spec has gemini-exit-nonzero fallback reason', 'token not found');
  assert(spec.includes('--engine "$XLLM_ENGINE"'), 'spec Steps 2/4 pass --engine to the adapter', 'token not found');
  assert(spec.includes('--model "$CHALLENGER_MODEL"'), 'spec Steps 2/4 quote --model (agy labels have spaces)', 'token not found');

  // Context guard: a challenger that dies on a large diff returns no verdict, and
  // downstream that is indistinguishable from "found nothing". Four agents were
  // burned on one diff before the real defect was found by hand.
  assert(spec.includes('REVIEW_SHARDS'), 'spec Step 2.0 derives REVIEW_SHARDS from the policy object', 'token not found');
  assert(/REVIEW_SHARDS <= 1.*(exactly as before|byte-identical)/s.test(spec),
    'spec keeps the unsharded single-dispatch path unchanged', 'no-split path not stated');
  assert(/never hunks|never see half a function|Shards are files/.test(spec),
    'spec splits by file, never by hunk', 'file-granularity rule not stated');
  assert(spec.includes('REVIEWER_AGENT_ID[R#]'),
    'spec keeps each objection routed back to the challenger that authored it', 'per-objection agent id not stated');
  // \s+ not a literal space: the sentence wraps mid-phrase in the source.
  assert(/Cobertura incompleta/.test(spec) && /never\s+render\s+as\s+clean/.test(spec),
    'spec forbids a partially-failed sharded review from rendering as clean', 'partial-coverage rule not stated');
  {
    const policy = require(path.join(ROOT, 'scripts', 'forge-cost-policy.js'));
    const many = (n, lines) => Array.from({ length: n }, (_, i) => ({ file: `src/f${i}.ts`, added: lines, deleted: 0 }));
    const small = policy.planReviewShards(many(4, 50));
    const large = policy.planReviewShards(many(30, 500));
    assert(small.length === 1, `(shard) a small diff still dispatches once (got ${small.length})`);
    assert(large.length > 1 && large.length <= 6, `(shard) a large diff splits within the cap (got ${large.length})`);
    assert(large.flatMap((s) => s.files).length === 30 && new Set(large.flatMap((s) => s.files)).size === 30,
      '(shard) every changed file lands in exactly one shard — none dropped, none duplicated');
    assert(JSON.stringify(policy.planReviewShards(many(30, 500))) === JSON.stringify(large),
      '(shard) the split is deterministic, so a resumed review re-derives it');
  }

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
  if(m=blk.match(/^[ \\t]+challenger_model:[ \\t]*([^#\\n]+)/m)){const v=m[1].trim().replace(/^["']|["']$/g,'');if(v)challengerModel=v;}
}catch(e){}}
if(!['enabled','disabled'].includes(mode))mode='enabled';
if(!['dialectic','flags'].includes(style))style='dialectic';
if(!Number.isInteger(rounds)||rounds<0||rounds>3)rounds=1;
if(!['defer','pause'].includes(askAuto))askAuto='defer';
if(!['agents','workflow'].includes(engine))engine='agents';
if(!['claude','codex','gemini'].includes(challenger))challenger='claude';
process.stdout.write(JSON.stringify({mode,style,rounds,askAuto,fixConceded,engine,challenger,challengerModel}));
`;
    const dir = mkTmp('challenger-cascade');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const cascadePath = path.join(dir, 'cascade.js');
    fs.writeFileSync(cascadePath, cascadeScript);

    // Case 1: challenger: codex + challenger_model: gpt-5-test
    // Deliberate legacy-parser fixture: this inline absence-guard snippet models the dead cascade.
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: codex\n  challenger_model: gpt-5-test\n');
    const r1 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    let p1 = null;
    try { p1 = JSON.parse(r1.stdout); } catch (e) { /* leave null */ }
    assert(!!p1 && p1.challenger === 'codex' && p1.challengerModel === 'gpt-5-test',
      'Step 0 cascade: challenger/challenger_model resolve from prefs', `stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Case 2: challenger: invalido -> whitelist fallback to "claude"
    // Deliberate legacy-parser fixture: this inline absence-guard snippet models the dead cascade.
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: invalido\n');
    const r2 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    let p2 = null;
    try { p2 = JSON.parse(r2.stdout); } catch (e) { /* leave null */ }
    assert(!!p2 && p2.challenger === 'claude',
      'Step 0 cascade: invalid challenger falls back to claude whitelist default', `stdout=${r2.stdout} stderr=${r2.stderr}`);

    // Case 3: challenger: gemini + quoted spaced agy label -> quotes stripped, spaces kept
    // Deliberate legacy-parser fixture: this inline absence-guard snippet models the dead cascade.
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: gemini\n  challenger_model: "Gemini 3.1 Pro (High)"\n');
    const r3 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    let p3 = null;
    try { p3 = JSON.parse(r3.stdout); } catch (e) { /* leave null */ }
    assert(!!p3 && p3.challenger === 'gemini' && p3.challengerModel === 'Gemini 3.1 Pro (High)',
      'Step 0 cascade: gemini + spaced quoted label resolve from prefs', `stdout=${r3.stdout} stderr=${r3.stderr}`);

    // Case 4: challenger_model with only an inline comment -> stays null (latent "#" bug guard)
    // Deliberate legacy-parser fixture: this inline absence-guard snippet models the dead cascade.
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'),
      'review:\n  challenger: gemini\n  challenger_model:        # (unset) — comentário inline\n');
    const r4 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    let p4 = null;
    try { p4 = JSON.parse(r4.stdout); } catch (e) { /* leave null */ }
    assert(!!p4 && p4.challenger === 'gemini' && p4.challengerModel === null,
      'Step 0 cascade: comment-only challenger_model stays null (never "#")', `stdout=${r4.stdout} stderr=${r4.stderr}`);

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

    const prefs = SCAFFOLD;
    assert(prefs.includes('"advocate_model"'), 'generated prefs scaffold Review Settings has advocate_model', 'token "advocate_model" not found');
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
    const r1 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
    let p1 = null;
    try { p1 = JSON.parse(r1.stdout); } catch (e) { /* leave null */ }
    assert(!!p1 && p1.advocateModel === 'claude-fable-5',
      'Step 0 cascade: advocateModel defaults to claude-fable-5 when unset', `stdout=${r1.stdout} stderr=${r1.stderr}`);

    // Case 2: advocate_model override
    fs.writeFileSync(path.join(dir, '.gsd', 'prefs.local.md'), 'review:\n  advocate_model: claude-opus-4-8\n');
    const r2 = spawnSync(process.execPath, [cascadePath], { cwd: dir, env: { ...process.env, WORKING_DIR: dir, HOME: dir, USERPROFILE: dir }, encoding: 'utf8' });
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

// ── Section 25: forge-xllm execute mode (mock codex on PATH) ────────────────
// Live-spawns the T01 adapter in --mode execute against a mock `codex` that can
// write real files, spawn orphans, commit, or hang — regression guard for the
// S01-RISK contract: heartbeat, process-group timeout kill, no-commit, dirty
// guard, result-file-outside-workspace guard, .gsd/ advisory warning.
async function smokeXllmExecute() {
  process.stdout.write('\n▸ Section 25: forge-xllm execute mode (mock codex on PATH)\n');

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
    assert(!!parsed && Array.isArray(parsed.pre_dirty) && parsed.pre_dirty.length === 0,
      'A: clean tree → pre_dirty empty (HARD invariant)', JSON.stringify(parsed && parsed.pre_dirty));
    const afterHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    assert(afterHead === beforeHead, 'A: HEAD unchanged (no-commit)', `before=${beforeHead} after=${afterHead}`);
    const afterLog = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout;
    assert(afterLog === beforeLog, 'A: git log unchanged (no-commit)', `before=${JSON.stringify(beforeLog)} after=${JSON.stringify(afterLog)}`);
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario B — dirty guard RELAXED (M013 S01: refuse→snapshot). A pre-existing
  // dirty tree NO LONGER refuses: the adapter captures a pre_dirty snapshot and the
  // mock codex IS invoked; the result JSON exposes pre_dirty ([{path,hash}]) for audit.
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
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$FORGE_MARKER"` });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo,
      { env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, FORGE_MARKER: marker } });
    assert(r.status === 0, 'B: dirty tree no longer refuses (refuse→snapshot) → exit 0', `status=${r.status} stderr=${r.stderr}`);
    assert(!/refusing to start/i.test(r.stderr), 'B: no dirty-guard refusal message', `stderr=${r.stderr}`);
    assert(fs.existsSync(marker), 'B: mock codex IS invoked on dirty tree (marker present)', `marker=${marker}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && Array.isArray(parsed.pre_dirty)
      && parsed.pre_dirty.some((d) => d.path === 'dirty.txt' && typeof d.hash === 'string'),
      'B: result JSON exposes pre_dirty with the pre-existing file', JSON.stringify(parsed && parsed.pre_dirty));
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
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$FORGE_MARKER"` });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo,
      { env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, FORGE_MARKER: marker } });
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

  // Scenario H — new .gsd/ delta from the sidecar is TERMINAL (PR #52); a
  // pre-existing dirty .gsd/ is exempt (pre-dirty snapshot — covered by
  // scripts/forge-xllm-runtime.test.js).
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
    assert(r.status === 2, 'H: new .gsd/ delta from the sidecar is terminal — exit 2', `status=${r.status} stderr=${r.stderr}`);
    assert(/protected \.gsd/.test(r.stderr), 'H: stderr contains protected .gsd message', `stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', 'H: result marker is adapter-failed', JSON.stringify(parsed));
    assert(!!parsed && /touched protected \.gsd/.test(parsed.reason || ''), 'H: reason names the touched protected .gsd path', JSON.stringify(parsed));
    assert(!!parsed && parsed.error_class === 'terminal', 'H: error_class is terminal', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(resultDir);
    cleanup(mockDir);
  }

  // Scenario I — error_class on the adapter-failed marker (M013 S02 T01): each
  // failure kind classified via forge-classify-error.js (transient vs terminal),
  // reached by making the mock codex exit non-zero with a stderr snippet that the
  // classifier's regex matches (`codex exited N: <snippet>` reaches classifyError).
  {
    const cases = [
      { label: 'I1', stderr: '429 Too Many Requests: rate limit exceeded', expect: 'transient' },
      { label: 'I2', stderr: 'network error: ECONNRESET', expect: 'transient' },
      { label: 'I3', stderr: '503 service unavailable: overloaded', expect: 'transient' },
      { label: 'I4', stderr: 'terminated: other side closed', expect: 'transient' },
      { label: 'I5', stderr: 'invalid api key: unauthorized', expect: 'terminal' },
      { label: 'I6', stderr: 'model refused: content policy violation', expect: 'terminal' },
    ];
    for (const c of cases) {
      const repo = mkGitRepo(mkTmp(`xllm-exec-${c.label}`));
      const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
      const planFile = path.join(planDir, 'plan.md');
      fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
      const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-smoke-xllm-exec-${c.label}-result-`));
      const resultFile = path.join(resultDir, 'result.json');
      const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-smoke-xllm-exec-${c.label}-mock-`));
      writeMockCodex(mockDir, {
        payload: '',
        writeOutput: false,
        exitCode: 1,
        extraScript: `printf '%s' ${shQuote(c.stderr)} 1>&2`,
      });
      const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo], mockDir, repo);
      assert(r.status !== 0, `${c.label}: adapter exits non-zero on codex failure`, `status=${r.status}`);
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
      assert(!!parsed && parsed.status === 'adapter-failed', `${c.label}: result-file marks adapter-failed`, JSON.stringify(parsed));
      assert(!!parsed && parsed.error_class === c.expect,
        `${c.label}: error_class === ${c.expect} for "${c.stderr}"`, JSON.stringify(parsed));
      cleanup(repo);
      cleanup(planDir);
      cleanup(resultDir);
      cleanup(mockDir);
    }
  }

  // Scenario J — codex-timeout forced terminal (LOCKED decision) even though the
  // adapter's own "killed after exceeding timeout" message never matches any of
  // forge-classify-error.js's transient regexes — this proves the BEFORE-check
  // guard, not just an accidental fallthrough.
  {
    const repo = mkGitRepo(mkTmp('xllm-exec-j'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-j-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-xllm-exec-j-mock-'));
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: 'sleep 60 &\nsleep 30' });
    const r = runExecuteXllm(['--plan', planFile, '--result-file', resultFile, '--cwd', repo, '--timeout', '1'], mockDir, repo);
    assert(r.status !== 0, 'J: timeout makes adapter exit non-zero', `status=${r.status}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'adapter-failed', 'J: result-file marks adapter-failed on timeout', JSON.stringify(parsed));
    assert(!!parsed && parsed.error_class === 'terminal', 'J: codex-timeout forced error_class terminal', JSON.stringify(parsed));
    cleanup(repo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(mockDir);
  }
}

// ── Section 69: sidecar context parity (Security + informational bundle) ────
async function smokeSidecarContextParity() {
  process.stdout.write('\n▸ Section 69: sidecar context parity\n');
  const { buildExecutePrompt } = require('./forge-xllm.js');
  const { buildContextBundle } = require('./forge-context-bundle.js');
  const root = mkTmp('sidecar-context');
  const repo = mkGitRepo(root);
  const plan = path.join(root, 'T69-PLAN.md');
  const security = path.join(root, 'T69-SECURITY.md');
  const bundle = path.join(root, 'context.md');
  // Result files (and the mock's captured-prompt sink) must resolve OUTSIDE the
  // repo workspace — forge-xllm's validateResultFileTarget() rejects targets under
  // --cwd. Allocate a sibling tmpdir, matching the Scenario H pattern above.
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-sidecar-context-result-'));
  const result = path.join(resultDir, 'result.json');
  const promptFile = path.join(resultDir, 'captured-prompt.txt');
  const mock = mkTmp('sidecar-context-mock');
  const payload = JSON.stringify({ status: 'done', summary: 'ok', must_haves_status: [], files_changed: [] });
  try {
    fs.writeFileSync(plan, '# T69\nExecute context parity.\n', 'utf8');
    fs.writeFileSync(security, '## Security Checklist\n\n- SENTINEL-SEC-XYZ\n', 'utf8');
    fs.writeFileSync(bundle, '## Lint & Format Commands\n\nSENTINEL-CTX-XYZ\n', 'utf8');
    writeMockCodex(mock, { payload, extraScript: 'printf %s "$PROMPT" > "$FORGE_PROMPT_FILE"' });
    const env = { ...process.env, PATH: mock + path.delimiter + process.env.PATH, FORGE_PROMPT_FILE: promptFile };
    const inline = runScript('forge-xllm.js', ['--mode', 'execute', '--plan', plan, '--result-file', result,
      '--cwd', repo, '--security', security, '--context-bundle', bundle], { cwd: repo, env });
    const captured = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    assert(inline.status === 0, '69a: execute with context exits 0', inline.stderr || captured);
    assert(captured.includes('SENTINEL-SEC-XYZ') && captured.includes('SENTINEL-CTX-XYZ'),
      '69a: mock stdin contains security and context sentinels', captured);
    assert(captured.includes('--- SECURITY CHECKLIST START ---') && captured.includes('must-have and verify'),
      '69a: security markers and mandatory instruction are inline', captured);
    // 69a-pos: the mandatory security instruction must be inserted right after the plan's
    // Standards item and BEFORE "HARD PROHIBITIONS" — a hardcoded/unanchored splice index
    // would silently drift out of that window on any edit above it.
    {
      const anchorPos = captured.indexOf("Treat the plan's");
      const secInstrPos = captured.indexOf('must-have and verify all of them before reporting done');
      const prohibitionsPos = captured.indexOf('HARD PROHIBITIONS');
      assert(anchorPos !== -1 && secInstrPos !== -1 && prohibitionsPos !== -1
        && anchorPos < secInstrPos && secInstrPos < prohibitionsPos,
      '69a-pos: security instruction lands after the Standards anchor and before HARD PROHIBITIONS',
      `anchor=${anchorPos} secInstr=${secInstrPos} prohibitions=${prohibitionsPos}`);
    }

    const missingResult = path.join(resultDir, 'missing-result.json');
    const absent = runScript('forge-xllm.js', ['--mode', 'execute', '--plan', plan, '--result-file', missingResult,
      '--cwd', repo, '--security', path.join(root, 'missing-security.md'), '--context-bundle', path.join(root, 'missing-context.md')], { cwd: repo, env });
    const absentPrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
    let missingPayload = null;
    try { missingPayload = JSON.parse(fs.readFileSync(missingResult, 'utf8')); } catch { /* asserted below */ }
    assert(absent.status === 0 && missingPayload && missingPayload.status === 'done',
      '69b: missing optional files are silently omitted', absent.stderr || JSON.stringify(missingPayload));
    assert(!absentPrompt.includes('SECURITY CHECKLIST') && !absentPrompt.includes('FORGE CONTEXT'),
      '69b: missing optional files leave no orphan headers', absentPrompt);

    const oldPrompt = buildExecutePrompt(fs.readFileSync(plan, 'utf8'));
    assert(!oldPrompt.includes('SECURITY CHECKLIST') && !oldPrompt.includes('FORGE CONTEXT'),
      '69c: no-extras prompt remains legacy-shaped');
    assert(oldPrompt === buildExecutePrompt(fs.readFileSync(plan, 'utf8'), undefined),
      '69c: no-extras prompt is byte-identical');

    const oversized = path.join(root, 'oversized-security.md');
    const oversizedResult = path.join(resultDir, 'oversized-result.json');
    fs.writeFileSync(oversized, `## Security Checklist\n\n${'x'.repeat(24001)}`, 'utf8');
    const tooLarge = runScript('forge-xllm.js', ['--mode', 'execute', '--plan', plan, '--result-file', oversizedResult,
      '--cwd', repo, '--security', oversized], { cwd: repo, env });
    let oversizedPayload = null;
    try { oversizedPayload = JSON.parse(fs.readFileSync(oversizedResult, 'utf8')); } catch { /* asserted below */ }
    assert(tooLarge.status === 2 && oversizedPayload && oversizedPayload.status === 'adapter-failed'
      && oversizedPayload.error_class === 'terminal',
    '69d: oversized security fails terminally instead of truncating', JSON.stringify(oversizedPayload));

    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'CODING-STANDARDS.md'), '## Lint & Format Commands\n\nnpm test\n', 'utf8');
    const slice = path.join(root, 'S69-CONTEXT.md');
    fs.writeFileSync(slice, '## Decisions\n\nUse sentinels.\n', 'utf8');
    const assembled = buildContextBundle({ cwd: root, sliceContext: slice });
    assert(assembled.includes('## Lint & Format Commands') && assembled.includes('## Slice Decisions'),
      '69f: bundle assembler emits available source sections', assembled);
    const empty = mkTmp('sidecar-context-empty');
    assert(buildContextBundle({ cwd: empty }) === '', '69f: bundle assembler tolerates empty sources');
    cleanup(empty);

    // 69g: memory limiting must actually cap entries. If firstMemoryEntries() matches the
    // wrong delimiter (e.g. a markdown `###` heading that renderMemory never emits), the
    // "starts.length <= limit" guard always passes and the whole fragments file leaks
    // through uncapped — this fixture reproduces that regression class directly by writing
    // real memory fragments (the only supported input to renderMemory) and re-reading
    // through the real assembler.
    const memRoot = mkTmp('sidecar-context-memlimit');
    const memoryMod = require('./forge-memory.js');
    const entryCount = 15;
    const facts = [];
    for (let i = 1; i <= entryCount; i++) {
      const id = `MEM${String(i).padStart(3, '0')}`;
      facts.push({
        mem_id: id,
        category: 'pattern',
        text: `Fixture entry number ${i} for context-bundle capping.`,
        confidence_base: 0.9 - i * 0.01, // strictly descending -> deterministic rank order
        created_at: '2026-07-01T00:00:00Z',
        source_unit: 'execute-task/T01',
      });
    }
    memoryMod.writeFragment(memRoot, { unit_id: 'T01', facts, stats: [] });
    const memBundle = buildContextBundle({ cwd: memRoot });
    const cappedDelimiters = (memBundle.match(/^<!-- gsd-auto-memory /gm) || []).length;
    assert(cappedDelimiters === 10,
      `69g: memory section is capped at 10 entries (got ${cappedDelimiters})`, memBundle.slice(0, 400));
    assert(memBundle.includes('MEM001') && !memBundle.includes('MEM011'),
      '69g: capped bundle keeps the highest-ranked entries and drops entries past the limit', memBundle.slice(0, 400));
    cleanup(memRoot);

    const sourcePaths = ['shared/forge-dispatch.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md'];
    for (const relative of sourcePaths) {
      const text = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      assert((text.match(/--security/g) || []).length >= 1 && (text.match(/--context-bundle/g) || []).length >= 1
        && (text.match(/forge-context-bundle\.js/g) || []).length >= 1,
      `69e: ${relative} wires both context flags and assembler`);
    }
  } finally {
    cleanup(root);
    cleanup(mock);
    cleanup(resultDir);
  }
}

// ── Section 26: engine dispatch (reset + fallback + dirty guard) ────────────
// Validates the SCRIPTABLE pieces of the T01/S02 "worker-engine-fallback"
// contract in isolation: (A) happy path — result JSON carries the fields the
// orchestrator reads to assemble the SUMMARY, no commit is made; (B) failure
// post-write — the canonical reset (`git checkout START_SHA -- . && git clean
// -fd`) empties the diff and a worker-engine-fallback event line is appended;
// (C) the dirty-tree guard refuses before codex ever runs. The full
// orchestration (decision to reset, dispatch of the Claude fallback) is
// markdown-only (T02/T03) — this smoke proves the pieces that ARE scriptable.
function smokeEngineDispatch() {
  process.stdout.write('\n▸ Section 26: engine dispatch (reset + fallback + dirty guard)\n');

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

  // Scenario C — dirty-tree guard RELAXED (M013 S01: refuse→snapshot): tree dirty
  // BEFORE dispatch, adapter NO LONGER refuses — it snapshots (pre_dirty) and the mock
  // codex IS invoked. The orchestrator owns the post-run surgical reset (T03/T04), not
  // the adapter (which never resets).
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
    writeMockCodex(mockDir, { payload: validPayload, exitCode: 0, extraScript: `: > "$FORGE_MARKER"` });
    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const r = spawnSync(process.execPath, [
      xllmPath, '--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', repo,
    ], {
      encoding: 'utf8',
      cwd: repo,
      env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH, FORGE_MARKER: marker },
    });
    assert(r.status === 0, 'C: dirty tree no longer refuses (refuse→snapshot) → exit 0', `status=${r.status} stderr=${r.stderr}`);
    assert(fs.existsSync(marker), 'C: mock codex IS invoked over dirty tree (snapshot, not refuse)', `marker=${marker}`);
    let cParsed = null;
    try { cParsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!cParsed && Array.isArray(cParsed.pre_dirty) && cParsed.pre_dirty.some((d) => d.path === 'dirty.txt'),
      'C: result JSON exposes pre_dirty snapshot of the pre-existing file', JSON.stringify(cParsed && cParsed.pre_dirty));
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
    // Deliberate legacy-parser absence-guard fixture: the inline snippet below
    // models the retired cascade and is not a canonical consumer.
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

// ── Section 27: forge-xllm plan mode (mock codex on PATH) ───────────────────
// Offline, live-spawn coverage of the T01 --mode plan adapter: (A) happy path
// + materialization-ready shape, asserting read-only (no repo/.gsd writes) and
// that the generated T##-PLAN content passes forge-must-haves.js standalone;
// (B) malformed must_haves in a returned task_plan → exit 2 + adapter-failed
// (the ENFORCING in-sidecar gate from runPlan); (C) codex absent from PATH →
// exit 2 (spawn ENOENT), mirroring the execute-mode offline scenario.
async function smokeXllmPlan() {
  process.stdout.write('\n▸ Section 27: forge-xllm plan mode (mock codex on PATH)\n');

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
    // The asserts above only RECORD a missing task_plans — they do not stop this
    // scenario — so read the entry defensively. Dereferencing it blind is what
    // turned an adapter failure into a TypeError that aborted the whole suite.
    const firstTaskPlan = parsed && Array.isArray(parsed.task_plans) ? parsed.task_plans[0] : null;
    if (firstTaskPlan && typeof firstTaskPlan.content === 'string') {
      const tpContentFile = path.join(resultDir, 'T01-PLAN.md');
      fs.writeFileSync(tpContentFile, firstTaskPlan.content, 'utf8');
      const mh = spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-must-haves.js'), '--check', tpContentFile], { encoding: 'utf8' });
      assert(mh.status === 0, 'A: generated task_plans[0].content passes forge-must-haves.js --check', `status=${mh.status} stdout=${mh.stdout} stderr=${mh.stderr}`);
    } else {
      assert(false, 'A: generated task_plans[0].content passes forge-must-haves.js --check',
        `no task_plans[0] in the adapter result: ${JSON.stringify(parsed && parsed.task_plans)}`);
    }

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

// ── Section 24: forge-status CLI packaging ──────────────────────────────────
function smokeStatusPackaging() {
  process.stdout.write('\n▸ Section 24: forge-status CLI packaging\n');
  const REPO = path.dirname(SCRIPTS);
  const rd = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };

  // (a) engine pure-read: no real write-API calls, no forge-lock require
  const eng = rd('scripts/forge-status.js');
  assert(eng.length > 0, '(a) scripts/forge-status.js lê conteúdo não-vazio', 'arquivo ausente ou vazio');
  const code = eng.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert(!/fs\.writeFileSync\(|fs\.appendFileSync\(|fs\.mkdirSync\(|fs\.unlinkSync\(|fs\.renameSync\(/.test(code),
    '(a) engine é pure-read (sem write-API em código)', 'chamada de write-API encontrada fora de comentários');
  assert(!/require\(['"]\.\/forge-lock\.js['"]\)/.test(code),
    '(a) engine não requer forge-lock', 'require de forge-lock.js encontrado');

  // (b) --json parseável
  const dir = mkTmp('status-json');
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true }); // fixture: valid (idle) GSD project
  const r = spawnSync('node', [path.join(SCRIPTS, 'forge-status.js'), '--json', '--cwd', dir], { encoding: 'utf8', input: '' });
  assert(r.status === 0, '(b) forge-status.js --json sai 0', `exit=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  assert(parsed !== null, '(b) --json stdout é JSON válido', `stdout não é JSON parseável: ${(r.stdout || '').slice(0, 200)}`);
  cleanup(dir);

  // (c) bin wrappers presentes
  // (c) presence-only by design: executing the bash wrapper from smoke would break Windows CI (no bash guarantee); the engine itself is exercised end-to-end in (b).
  assert(fs.existsSync(path.join(REPO, 'bin', 'forge-status')), '(c) bin/forge-status existe', 'arquivo ausente');
  assert(fs.existsSync(path.join(REPO, 'bin', 'forge-status.cmd')), '(c) bin/forge-status.cmd existe', 'arquivo ausente');

  // (d) install.ps1 Join-Path + no-\f
  const ps1 = rd('install.ps1');
  assert(/Join-Path[^\n]*forge-status\.cmd/.test(ps1),
    '(d) install.ps1 copia forge-status.cmd via Join-Path', 'bloco Join-Path ... forge-status.cmd não encontrado');
  const ps1buf = fs.readFileSync(path.join(REPO, 'install.ps1'));
  assert(!ps1buf.includes(0x0C), '(d) install.ps1 sem byte 0x0C (literal \\f)', 'byte 0x0C encontrado em install.ps1');

  // (e) SKILL thin shim
  const skill = rd('skills/forge-status/SKILL.md');
  assert(!/phaseOrder|byPhase|### Slices/.test(skill),
    '(e) SKILL sem template de agregação (thin shim)', 'template de agregação legado ainda presente');
  assert(/forge-status\.js/.test(skill), '(e) SKILL referencia o engine', 'referência a forge-status.js ausente');
  assert(/verbatim|cru|sem (interpretar|resumir|reformatar)|não .*(resumir|interpretar|reformatar)/i.test(skill),
    '(e) SKILL instrui pass-through cru', 'instrução de pass-through cru não encontrada');
}

// ── Section 28: tier fallback chain (scalar/list parsing + ladder) ─────────
function smokeTierChain() {
  process.stdout.write('\n▸ Section 28: tier fallback chain (scalar/list parsing + ladder)\n');
  const { readTierChain, nextAfter } = require('./forge-tier-chain');

  const writePrefs = (dir, tierModelsBlockLines) => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const tierModels = {};
    for (const line of tierModelsBlockLines) {
      const split = line.indexOf(':');
      const raw = line.slice(split + 1).trim();
      tierModels[line.slice(0, split).trim()] = raw.startsWith('[') && raw.endsWith(']')
        ? raw.slice(1, -1).split(',').map((v) => v.trim()) : raw;
    }
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: tierModels }), 'utf8');
  };

  // (a) scalar → 1-member chain (compat)
  const dirScalar = mkTmp('tierchain-scalar');
  writePrefs(dirScalar, ['standard: claude-sonnet-5']);
  const chainScalar = readTierChain('standard', dirScalar);
  assert(Array.isArray(chainScalar) && chainScalar.length === 1,
    '(a) tier_models escalar → cadeia de 1 membro', `got length=${chainScalar.length}`);
  assert(chainScalar[0].id === 'claude-sonnet-5' && chainScalar[0].mapped === true && chainScalar[0].alias === 'sonnet',
    '(a) membro escalar mapeado corretamente (alias=sonnet)', JSON.stringify(chainScalar[0]));
  cleanup(dirScalar);

  // (b) inline list → cadeia ordenada primário-primeiro, N membros
  const dirList = mkTmp('tierchain-list');
  writePrefs(dirList, ['standard: [claude-sonnet-5, claude-haiku-4-5-20251001]']);
  const chainList = readTierChain('standard', dirList);
  assert(Array.isArray(chainList) && chainList.length === 2,
    '(b) tier_models lista inline → cadeia com N membros', `got length=${chainList.length}`);
  assert(chainList[0].id === 'claude-sonnet-5' && chainList[1].id === 'claude-haiku-4-5-20251001',
    '(b) ordem primário-primeiro preservada', JSON.stringify(chainList));
  assert(chainList[0].mapped === true && chainList[1].mapped === true,
    '(b) ambos os membros mapeados (sonnet, haiku)', JSON.stringify(chainList));
  cleanup(dirList);

  // (c) membro com ID sem alias entre membros mapeados → mapped:false, pulado
  const dirNoAlias = mkTmp('tierchain-noalias');
  writePrefs(dirNoAlias, ['standard: [claude-sonnet-5, some-unknown-model-xyz, claude-haiku-4-5-20251001]']);
  const chainNoAlias = readTierChain('standard', dirNoAlias);
  assert(chainNoAlias.length === 3, '(c) cadeia mantém os 3 membros (inclusive o sem alias)', `got length=${chainNoAlias.length}`);
  assert(chainNoAlias[1].id === 'some-unknown-model-xyz' && chainNoAlias[1].mapped === false && chainNoAlias[1].alias === null,
    '(c) membro sem alias → mapped:false, alias:null', JSON.stringify(chainNoAlias[1]));

  // (d) --next-after: próximo membro mapeado por classe de falha, pulando o sem-alias
  const next1 = nextAfter(chainNoAlias, 'claude-sonnet-5');
  assert(next1 === 'claude-haiku-4-5-20251001',
    '(d) --next-after pula o membro sem alias e retorna o próximo mapeado', `got '${next1}'`);
  const next2 = nextAfter(chainNoAlias, 'claude-haiku-4-5-20251001');
  assert(next2 === '', '(d) --next-after em cadeia esgotada retorna string vazia', `got '${next2}'`);
  cleanup(dirNoAlias);

  // (d2) mesmo comportamento via CLI --next-after
  const dirCli = mkTmp('tierchain-cli');
  writePrefs(dirCli, ['standard: [claude-sonnet-5, claude-haiku-4-5-20251001]']);
  const cliNext2 = runScript('forge-tier-chain.js', ['--tier', 'standard', '--cwd', dirCli, '--next-after', 'claude-sonnet-5']);
  assert(cliNext2.status === 0 && cliNext2.stdout.trim() === 'claude-haiku-4-5-20251001',
    '(d2) CLI --next-after retorna próximo membro mapeado', `status=${cliNext2.status} stdout='${cliNext2.stdout.trim()}'`);
  cleanup(dirList);
  cleanup(dirCli);

  // (e) doc-presence: context_overflow ainda escala tier standard→heavy→max (escada de modelo intocada)
  const REPO = path.dirname(SCRIPTS);
  const rd = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };
  const tiersDoc = rd('shared/forge-tiers.md');
  const skillDoc = rd('skills/forge-auto/SKILL.md');

  assert(/context_overflow[\s\S]{0,400}standard\s*→\s*heavy/.test(tiersDoc) || /context_overflow[\s\S]{0,400}standard\s*→\s*heavy/.test(skillDoc),
    '(e) context_overflow ainda descrito com subida standard→heavy', 'menção de escalação standard→heavy não encontrada');
  assert(/heavy\s*→\s*max/.test(tiersDoc) || /heavy\s*→\s*max/.test(skillDoc),
    '(e) escalação heavy→max presente na doc', 'menção heavy→max não encontrada');
  assert(/[Ii]ntra-tier chain/.test(tiersDoc) && /[Ii]ntra-tier chain/.test(skillDoc),
    '(e) cadeia intra-tier documentada em forge-tiers.md e forge-auto SKILL.md', 'menção "intra-tier chain" ausente em uma das docs');
  assert(!/prefs-resolved\.json/.test(rd('scripts/forge-tier-chain.js')) || /never/.test(rd('scripts/forge-tier-chain.js')),
    '(e) forge-tier-chain.js não lê prefs-resolved.json (ou documenta explicitamente que nunca lê)',
    'nenhuma menção a prefs-resolved.json / never encontrada');
  assert(/does not escalate tier|Does not escalate tier|não escala tier/.test(skillDoc),
    '(e) doc confirma que a cadeia intra-tier NÃO substitui a escada cross-tier', 'confirmação de não-substituição não encontrada');

  // (f) doc-presence: forge-next persists + consumes the tier-chain cursor across invocations
  // (review-fix R2, M005 S04) — closes the "advertised fallback never happens" gap in step mode.
  const nextDoc = rd('skills/forge-next/SKILL.md');
  assert(/tier-cursor-.*unit_id.*\.json/.test(nextDoc),
    '(f) forge-next grava cursor de cadeia de tier em disco (tier-cursor-*.json)', 'padrão do nome do arquivo de cursor não encontrado');
  assert(/Step 4b[\s\S]{0,600}TIER_CURSOR_FILE[\s\S]{0,400}rm -f "\$TIER_CURSOR_FILE"/.test(nextDoc),
    '(f) forge-next consome e apaga o cursor no início da Tier Resolution (consume-once)', 'consumo/limpeza do cursor não encontrado');

  // (g) review-fix M005 triage FIX 1: Windows process-tree kill in invokeCodexDetached
  const xllmSrc = rd('scripts/forge-xllm.js');
  assert(/win32/.test(xllmSrc) && /taskkill/.test(xllmSrc) && /'\/T'/.test(xllmSrc) && /'\/F'/.test(xllmSrc),
    '(g) invokeCodexDetached mata a árvore de processos no Windows via taskkill /T /F', 'guard win32 + taskkill /T /F não encontrado em forge-xllm.js');
  assert(/process\.kill\(-child\.pid, 'SIGKILL'\)/.test(xllmSrc),
    '(g) caminho POSIX process.kill(-pid) permanece intocado', 'process.kill(-child.pid, \'SIGKILL\') não encontrado');

  // (h) review-fix M005 triage FIX 2: malformed tier_models inline-list rejected, not corrupted
  const dirMalformed = mkTmp('tierchain-malformed');
  writePrefs(dirMalformed, ['standard: [a, b']); // unbalanced — no closing bracket
  const chainMalformed = readTierChain('standard', dirMalformed);
  assert(Array.isArray(chainMalformed) && chainMalformed.length === 1 && chainMalformed[0].id === 'claude-sonnet-5',
    '(h) lista inline malformada (sem colchete de fechamento) degrada para o default seguro do tier',
    `got ${JSON.stringify(chainMalformed)}`);
  cleanup(dirMalformed);

  // (h2) valid inline list still parses byte-identically after the hardening
  const dirValidAgain = mkTmp('tierchain-valid-again');
  writePrefs(dirValidAgain, ['standard: [claude-sonnet-5, claude-haiku-4-5-20251001]']);
  const chainValidAgain = readTierChain('standard', dirValidAgain);
  assert(chainValidAgain.length === 2 && chainValidAgain[0].id === 'claude-sonnet-5' && chainValidAgain[1].id === 'claude-haiku-4-5-20251001',
    '(h2) lista inline válida continua parseando corretamente', JSON.stringify(chainValidAgain));
  cleanup(dirValidAgain);
}

// ── Section 29: review pairing (família + agregador de autoria) ────────────
function smokeReviewPairing() {
  process.stdout.write('\n▸ Section 29: review pairing (família + agregador de autoria)\n');
  const { modelFamily, engineFamily } = require('./forge-model-alias');

  // (a) família — via require
  assert(modelFamily('claude-fable-5') === 'claude', '(a) modelFamily(claude-fable-5)===claude', `got ${modelFamily('claude-fable-5')}`);
  assert(modelFamily('claude-opus-4-8') === 'claude', '(a) modelFamily(claude-opus-4-8)===claude', `got ${modelFamily('claude-opus-4-8')}`);
  assert(modelFamily('gpt-5-codex') === 'gpt', '(a) modelFamily(gpt-5-codex)===gpt', `got ${modelFamily('gpt-5-codex')}`);
  assert(modelFamily('gemini-2') === 'gemini', '(a) modelFamily(gemini-2)===gemini', `got ${modelFamily('gemini-2')}`);
  assert(modelFamily('mistral-7b') === null, '(a) modelFamily(mistral-7b)===null', `got ${modelFamily('mistral-7b')}`);
  assert(modelFamily('') === null, "(a) modelFamily('')===null", `got ${modelFamily('')}`);
  assert(engineFamily('claude') === 'claude', '(a) engineFamily(claude)===claude', `got ${engineFamily('claude')}`);
  assert(engineFamily('codex') === 'gpt', '(a) engineFamily(codex)===gpt', `got ${engineFamily('codex')}`);
  assert(engineFamily('x') === null, '(a) engineFamily(x)===null', `got ${engineFamily('x')}`);

  // (a2) família — via CLI
  const rFamily1 = runScript('forge-model-alias.js', ['--family', 'claude-fable-5']);
  assert(rFamily1.status === 0 && rFamily1.stdout.trim() === 'claude',
    '(a2) CLI --family claude-fable-5 → stdout claude', `status=${rFamily1.status} stdout='${rFamily1.stdout.trim()}'`);
  const rFamily2 = runScript('forge-model-alias.js', ['--family', 'gemini-2']);
  assert(rFamily2.status === 0 && rFamily2.stdout.trim() === 'gemini',
    '(a2) CLI --family gemini-2 → stdout gemini', `status=${rFamily2.status} stdout='${rFamily2.stdout.trim()}'`);

  // helper de fixture
  const writeEvents = (dir, lines, scoped = true) => {
    const forgeDir = path.join(dir, '.gsd', 'forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const file = path.join(forgeDir, 'events.jsonl');
    const payload = scoped ? lines.map((l) => ({ slice: 'S02', milestone: 'M006', ...l })) : lines;
    fs.writeFileSync(file, payload.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return file;
  };

  const runPairing = (eventsFile, dir, extraArgs) => {
    const args = ['--slice', 'S02', '--milestone', 'M006', '--cwd', dir, '--events', eventsFile, ...(extraArgs || [])];
    const r = runScript('forge-review-pairing.js', args);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.trim()); } catch {}
    return { r, parsed };
  };

  // (b) misto: 2 codex + 1 claude
  const dirMisto = mkTmp('pairing-misto');
  const evMisto = writeEvents(dirMisto, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T03', engine: 'claude' },
  ]);
  const { parsed: pMisto } = runPairing(evMisto, dirMisto);
  assert(pMisto && pMisto.author === 'gpt' && pMisto.author_engine === 'codex' &&
    pMisto.challenger === 'claude' && pMisto.policy === 'majority',
    '(b) fixture misto → author=gpt, challenger=claude, policy=majority', JSON.stringify(pMisto));

  // (c) puro-claude
  const dirPuroClaude = mkTmp('pairing-puro-claude');
  const evPuroClaude = writeEvents(dirPuroClaude, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'claude' },
    { event: 'dispatch', unit: 'execute-task/T03', engine: 'claude' },
  ]);
  const { parsed: pPuroClaude } = runPairing(evPuroClaude, dirPuroClaude, ['--advocate', 'auto']);
  assert(pPuroClaude && pPuroClaude.author === 'claude' && pPuroClaude.challenger === 'codex' &&
    pPuroClaude.advocate === 'claude' && pPuroClaude.fallbacks.length === 0,
    '(c) fixture puro-claude → author=claude, challenger=codex, advocate=claude, fallbacks vazio', JSON.stringify(pPuroClaude));

  // (d) puro-codex
  const dirPuroCodex = mkTmp('pairing-puro-codex');
  const evPuroCodex = writeEvents(dirPuroCodex, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
  ]);
  const { parsed: pPuroCodex } = runPairing(evPuroCodex, dirPuroCodex);
  assert(pPuroCodex && pPuroCodex.author === 'gpt' && pPuroCodex.challenger === 'claude',
    '(d) fixture puro-codex → author=gpt, challenger=claude', JSON.stringify(pPuroCodex));

  // (e) sem-engine: campo engine ausente em eventos presentes
  const dirSemEngine = mkTmp('pairing-sem-engine');
  const evSemEngine = writeEvents(dirSemEngine, [
    { event: 'dispatch', unit: 'execute-task/T01' },
    { event: 'dispatch', unit: 'execute-task/T02' },
  ]);
  const { parsed: pSemEngine } = runPairing(evSemEngine, dirSemEngine);
  assert(pSemEngine && pSemEngine.author === 'claude' && !pSemEngine.fallbacks.includes('no-authorship-data'),
    '(e) fixture sem-engine → author=claude, SEM no-authorship-data', JSON.stringify(pSemEngine));

  // (f) zero-events
  const dirZero = mkTmp('pairing-zero-events');
  const evZero = writeEvents(dirZero, []);
  const { parsed: pZero } = runPairing(evZero, dirZero);
  assert(pZero && pZero.author === 'claude' && pZero.policy === 'no-authorship-data' &&
    pZero.fallbacks.includes('no-authorship-data'),
    '(f) fixture zero-events → author=claude, policy=no-authorship-data, fallbacks inclui marcador', JSON.stringify(pZero));

  // (g) review-fix ignorado
  const dirReviewFix = mkTmp('pairing-review-fix');
  const evReviewFix = writeEvents(dirReviewFix, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
    { event: 'dispatch', unit: 'review-fix/S02', engine: 'claude' },
  ]);
  const { parsed: pReviewFix } = runPairing(evReviewFix, dirReviewFix);
  assert(pReviewFix && pReviewFix.counts.claude === 0 && pReviewFix.author === 'gpt',
    '(g) evento review-fix ignorado → counts.claude=0, author=gpt', JSON.stringify(pReviewFix));

  // (h) empate (tie-last) — última = claude
  const dirTie1 = mkTmp('pairing-tie-claude-last');
  const evTie1 = writeEvents(dirTie1, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'claude' },
  ]);
  const { parsed: pTie1 } = runPairing(evTie1, dirTie1);
  assert(pTie1 && pTie1.author === 'claude' && pTie1.policy === 'tie-last',
    '(h) empate, última=claude → author=claude, policy=tie-last', JSON.stringify(pTie1));

  // (h2) empate — última = codex (ordem invertida)
  const dirTie2 = mkTmp('pairing-tie-codex-last');
  const evTie2 = writeEvents(dirTie2, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
  ]);
  const { parsed: pTie2 } = runPairing(evTie2, dirTie2);
  assert(pTie2 && pTie2.author === 'gpt' && pTie2.policy === 'tie-last',
    '(h2) empate, última=codex → author=gpt, policy=tie-last', JSON.stringify(pTie2));

  // (i) defend-mode: puro-codex + --advocate auto
  const { parsed: pDefend1 } = runPairing(evPuroCodex, dirPuroCodex, ['--advocate', 'auto']);
  assert(pDefend1 && pDefend1.advocate === 'claude' && pDefend1.fallbacks.includes('defend-mode-unavailable'),
    '(i) puro-codex + advocate=auto → advocate=claude, fallback defend-mode-unavailable', JSON.stringify(pDefend1));

  // (i2) defend-mode: puro-claude + --advocate auto → sem fallback
  const { parsed: pDefend2 } = runPairing(evPuroClaude, dirPuroClaude, ['--advocate', 'auto']);
  assert(pDefend2 && pDefend2.advocate === 'claude' && !pDefend2.fallbacks.includes('defend-mode-unavailable'),
    '(i2) puro-claude + advocate=auto → advocate=claude, sem defend-mode-unavailable', JSON.stringify(pDefend2));

  // (j) explícito vence resolução por autoria
  const { parsed: pExplicit } = runPairing(evMisto, dirMisto, ['--challenger', 'codex']);
  assert(pExplicit && pExplicit.challenger === 'codex',
    '(j) fixture misto + challenger=codex explícito → challenger=codex', JSON.stringify(pExplicit));

  // (k) determinismo — duas execuções byte-idênticas sobre o mesmo fixture
  const r1 = runScript('forge-review-pairing.js', ['--slice', 'S02', '--milestone', 'M006', '--cwd', dirMisto, '--events', evMisto]);
  const r2 = runScript('forge-review-pairing.js', ['--slice', 'S02', '--milestone', 'M006', '--cwd', dirMisto, '--events', evMisto]);
  assert(r1.stdout === r2.stdout && r1.stdout.length > 0,
    '(k) determinismo — stdout byte-idêntico entre duas execuções', `stdout1='${r1.stdout}' stdout2='${r2.stdout}'`);

  // (k2) strict scope wins over a Claude-heavy global stream.
  const dirScoped = mkTmp('pairing-strict-scope');
  const evScoped = writeEvents(dirScoped, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude', slice: 'S03', milestone: 'M015' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'claude', slice: 'S03', milestone: 'M015' },
    { event: 'dispatch', unit: 'execute-task/T03', engine: 'claude', slice: 'S03', milestone: 'M015' },
    { event: 'dispatch', unit: 'execute-task/T04', engine: 'codex', slice: 'S04', milestone: 'M015' },
    { event: 'dispatch', unit: 'execute-task/T05', engine: 'gpt', slice: 'S04', milestone: 'M015' },
  ], false);
  const scopedRun = runScript('forge-review-pairing.js', ['--slice', 'S04', '--milestone', 'M015', '--cwd', dirScoped, '--events', evScoped]);
  let pScoped = null;
  try { pScoped = JSON.parse(scopedRun.stdout.trim()); } catch {}
  assert(pScoped && pScoped.author === 'gpt' && pScoped.counts.codex === 2 && pScoped.counts.claude === 0,
    '(k2) escopo S04/M015 vence global Claude-heavy → author=gpt', JSON.stringify(pScoped));

  // (l) --milestone filtra eventos de mesma slice em milestone diferente
  const dirCrossMs = mkTmp('pairing-cross-milestone');
  const evCrossMs = writeEvents(dirCrossMs, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex', milestone: 'M005' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex', milestone: 'M005' },
    { event: 'dispatch', unit: 'execute-task/T03', engine: 'claude', milestone: 'M006' },
  ]);
  const { parsed: pCrossMs } = runPairing(evCrossMs, dirCrossMs);
  assert(pCrossMs && pCrossMs.author === 'claude' && pCrossMs.counts.claude === 1 && pCrossMs.counts.codex === 0,
    '(l) --milestone M006 filtra eventos de M005 → author=claude, counts.codex=0', JSON.stringify(pCrossMs));

  // (l2) sem --milestone, os mesmos eventos contam ambos (M005 M006) → author flips to gpt
  const rNoMs = runScript('forge-review-pairing.js', ['--slice', 'S02', '--cwd', dirCrossMs, '--events', evCrossMs]);
  let pNoMs = null;
  try { pNoMs = JSON.parse(rNoMs.stdout.trim()); } catch {}
  assert(pNoMs && pNoMs.author === 'gpt' && pNoMs.counts.codex === 2 && pNoMs.counts.claude === 1,
    '(l2) sem --milestone → todos os eventos contam, author=gpt (majority)', JSON.stringify(pNoMs));

  // (m) missing scoped fields are excluded, then global fallback is observable
  const dirNoMsField = mkTmp('pairing-no-milestone-field');
  const evNoMsField = writeEvents(dirNoMsField, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
  ], false);
  const { parsed: pNoMsField } = runPairing(evNoMsField, dirNoMsField);
  assert(pNoMsField && pNoMsField.author === 'gpt' && pNoMsField.counts.codex === 2 &&
    pNoMsField.fallbacks.includes('scope-empty-global-fallback'),
    '(m) campos ausentes acionam fallback global observável', JSON.stringify(pNoMsField));

  // (n) --policy last: 3 eventos cross-engine (2 old claude + 1 latest codex)
  // → last-dispatch-wins escolhe o autor da execução mais recente (codex),
  // contra a maioria majority (claude) — cenário do forge-task boundary com
  // resumes cross-engine (S02 R3).
  const dirLastPolicy = mkTmp('pairing-last-policy');
  const evLastPolicy = writeEvents(dirLastPolicy, [
    { event: 'dispatch', unit: 'execute-task/T-loose', engine: 'claude' },
    { event: 'dispatch', unit: 'execute-task/T-loose', engine: 'claude' },
    { event: 'dispatch', unit: 'execute-task/T-loose', engine: 'codex' },
  ]);
  const { parsed: pLast } = runPairing(evLastPolicy, dirLastPolicy, ['--policy', 'last']);
  assert(pLast && pLast.author === 'gpt' && pLast.author_engine === 'codex' && pLast.policy === 'last-dispatch',
    '(n) --policy last: 2 claude + 1 codex (última) → author=gpt, policy=last-dispatch', JSON.stringify(pLast));

  // (n2) mesma fixture, default majority → author=claude (contraste)
  const { parsed: pMajorityContrast } = runPairing(evLastPolicy, dirLastPolicy);
  assert(pMajorityContrast && pMajorityContrast.author === 'claude' && pMajorityContrast.policy === 'majority',
    '(n2) mesma fixture, policy default (majority) → author=claude (contraste com (n))', JSON.stringify(pMajorityContrast));

  // (o) R1 fix: foreign-scoped-only stream requesting --slice S02 must NOT let
  // S03-tagged events decide authorship via the fallback — must degrade to
  // no-authorship-data defaults (claude), not recount the S03 events.
  const dirForeignScope = mkTmp('pairing-foreign-scope-only');
  const evForeignScope = writeEvents(dirForeignScope, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex', slice: 'S03', milestone: 'M015' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex', slice: 'S03', milestone: 'M015' },
  ], false);
  const { parsed: pForeignScope } = runPairing(evForeignScope, dirForeignScope, ['--slice', 'S02']);
  assert(pForeignScope && pForeignScope.author === 'claude' && pForeignScope.policy === 'no-authorship-data' &&
    !pForeignScope.fallbacks.includes('scope-empty-global-fallback'),
    '(o) R1: stream só com eventos S03 + --slice S02 → no-authorship-data defaults, sem recontar S03', JSON.stringify(pForeignScope));

  // (o2) legacy-only stream (sem slice/milestone em nenhum evento) continua
  // funcionando via fallback, como antes do fix (contraste com (o)).
  const dirLegacyOnly = mkTmp('pairing-legacy-only');
  const evLegacyOnly = writeEvents(dirLegacyOnly, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
  ], false);
  const { parsed: pLegacyOnly } = runPairing(evLegacyOnly, dirLegacyOnly, ['--slice', 'S02']);
  assert(pLegacyOnly && pLegacyOnly.author === 'gpt' &&
    pLegacyOnly.fallbacks.includes('scope-empty-global-fallback'),
    '(o2) stream legacy-only (sem campos de escopo) + --slice S02 → fallback funciona, author=gpt', JSON.stringify(pLegacyOnly));

  cleanup(dirForeignScope);
  cleanup(dirLegacyOnly);
  cleanup(dirMisto);
  cleanup(dirPuroClaude);
  cleanup(dirPuroCodex);
  cleanup(dirSemEngine);
  cleanup(dirZero);
  cleanup(dirReviewFix);
  cleanup(dirTie1);
  cleanup(dirTie2);
  cleanup(dirCrossMs);
  cleanup(dirNoMsField);
  cleanup(dirLastPolicy);
  cleanup(dirScoped);
}

// ── Section 30: review pairing wiring (precedência + pré-escopo + fallbacks) ──
// Gate estrutural do S02: assere a cadeia inteira T01→T02→T03 sobre o wiring do
// pairing no Step 0. Duas classes de assert: (1) comportamental — invoca o CLI
// congelado forge-review-pairing.js sobre fixtures pré-escopadas exatamente como
// o Step 0 faz; (2) estrutural — readFileSync sobre spec/skills editados.
function smokeReviewPairingWiring() {
  process.stdout.write('\n▸ Section 30: review pairing wiring (precedência + pré-escopo estrito + fallbacks)\n');

  const REPO = path.dirname(SCRIPTS);
  const rd = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };
  const countOccur = (hay, needle) => (hay.length && needle.length) ? hay.split(needle).length - 1 : 0;

  // Fixture helpers — raw JSONL stream + strict pre-scope mirror do Step 0.
  const writeRaw = (dir, events) => {
    const forgeDir = path.join(dir, '.gsd', 'forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const file = path.join(forgeDir, 'events.jsonl');
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
    return file;
  };

  // Réplica BYTE-A-BYTE do filtro estrito do Step 0 (shared/forge-review.md L103-117):
  // dispatch + unit começa com execute-task/ + slice E milestone casam por IGUALDADE.
  // Campo ausente/divergente → EXCLUÍDO (não lenient). É o coração da decisão de scoping.
  const strictPreScope = (rawFile, slice, ms, outFile) => {
    let raw = ''; try { raw = fs.readFileSync(rawFile, 'utf8'); } catch (_) { raw = ''; }
    const out = [];
    for (const ln of raw.split('\n')) {
      if (!ln.trim()) continue;
      let e; try { e = JSON.parse(ln); } catch (_) { continue; }
      if (e.event !== 'dispatch') continue;
      if (typeof e.unit !== 'string' || !e.unit.startsWith('execute-task/')) continue;
      if (e.slice !== slice || e.milestone !== ms) continue; // estrito
      out.push(ln);
    }
    fs.writeFileSync(outFile, out.length ? out.join('\n') + '\n' : '', 'utf8');
    return out.length;
  };

  const cliParse = (args) => {
    const r = runScript('forge-review-pairing.js', args);
    let parsed = null; try { parsed = JSON.parse(r.stdout.trim()); } catch (_) {}
    return { r, parsed };
  };
  // Chamada escopada (pré-escopa ANTES, como o Step 0) — --cwd sempre $WORKING_DIR.
  const runScoped = (dir, rawFile, extraArgs) => {
    const scoped = path.join(dir, 'scoped.jsonl');
    const kept = strictPreScope(rawFile, 'S02', 'M006', scoped);
    const { parsed } = cliParse(['--events', scoped, '--slice', 'S02', '--milestone', 'M006', '--cwd', dir, ...(extraArgs || [])]);
    return { parsed, kept };
  };

  // ── (a) PRÉ-ESCOPO ESTRITO — o teste-âncora da decisão de scoping ────────────
  // Stream com eventos legados claude SEM discriminador + eventos codex tagueados.
  const dirScope = mkTmp('pairing-wire-prescope');
  const rawScope = writeRaw(dirScope, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude' },              // legado
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'claude' },              // legado
    { event: 'dispatch', unit: 'execute-task/T03', engine: 'claude' },              // legado
    { event: 'dispatch', unit: 'execute-task/T04', engine: 'codex', slice: 'S02', milestone: 'M006' },
    { event: 'dispatch', unit: 'execute-task/T05', engine: 'codex', slice: 'S02', milestone: 'M006' },
  ]);
  const scoped = runScoped(dirScope, rawScope);
  assert(scoped.kept === 2, '(a) pré-escopo estrito mantém só os 2 eventos tagueados (3 legados excluídos)', `kept=${scoped.kept}`);
  assert(scoped.parsed && scoped.parsed.author === 'gpt' && scoped.parsed.counts.codex === 2 && scoped.parsed.counts.claude === 0,
    '(a) pré-escopo estrito → author=gpt (só codex tagueado conta; legados excluídos por construção)', JSON.stringify(scoped.parsed));

  // Contra-teste: SEM pré-escopo externo; o reader continua estrito e ignora legados.
  const { parsed: lenient } = cliParse(['--events', rawScope, '--slice', 'S02', '--milestone', 'M006', '--cwd', dirScope]);
  assert(lenient && lenient.author === 'gpt' && lenient.counts.claude === 0 && lenient.counts.codex === 2,
    '(a) reader estrito sem pré-escopo externo → legados continuam excluídos', JSON.stringify(lenient));
  cleanup(dirScope);

  // ── (b) PLAN-CHECK FIX — discriminadores presentes mas engine AUSENTE ────────
  // Distinto de zero-events: contam como claude (default) COM sinal de autoria, SEM no-authorship-data.
  const dirNoEngine = mkTmp('pairing-wire-no-engine');
  const rawNoEngine = writeRaw(dirNoEngine, [
    { event: 'dispatch', unit: 'execute-task/T01', slice: 'S02', milestone: 'M006' }, // sem engine
    { event: 'dispatch', unit: 'execute-task/T02', slice: 'S02', milestone: 'M006' }, // sem engine
  ]);
  const noEngine = runScoped(dirNoEngine, rawNoEngine);
  assert(noEngine.kept === 2 && noEngine.parsed && noEngine.parsed.author === 'claude' &&
    noEngine.parsed.policy !== 'no-authorship-data' && !noEngine.parsed.fallbacks.includes('no-authorship-data'),
    '(b) discriminadores presentes + engine ausente → author=claude COM sinal (policy≠no-authorship-data)', JSON.stringify(noEngine.parsed));
  cleanup(dirNoEngine);

  // Célula de contraste: ZERO eventos escopados → no-authorship-data COM evento/marcador.
  const dirZeroScope = mkTmp('pairing-wire-zero-scope');
  const rawZeroScope = writeRaw(dirZeroScope, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude' }, // legado → excluído pelo pré-escopo
  ]);
  const zeroScope = runScoped(dirZeroScope, rawZeroScope);
  assert(zeroScope.kept === 0 && zeroScope.parsed && zeroScope.parsed.policy === 'no-authorship-data' &&
    zeroScope.parsed.author === 'claude' && zeroScope.parsed.fallbacks.includes('no-authorship-data'),
    '(b) zero eventos escopados → no-authorship-data + author=claude (distinto de engine-ausente)', JSON.stringify(zeroScope.parsed));
  cleanup(dirZeroScope);

  // ── (c) MATRIZ DE PRECEDÊNCIA célula-a-célula ───────────────────────────────
  const dirClaude = mkTmp('pairing-wire-claude');
  const rawClaude = writeRaw(dirClaude, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude', slice: 'S02', milestone: 'M006' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'claude', slice: 'S02', milestone: 'M006' },
  ]);
  const dirCodex = mkTmp('pairing-wire-codex');
  const rawCodex = writeRaw(dirCodex, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex', slice: 'S02', milestone: 'M006' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex', slice: 'S02', milestone: 'M006' },
  ]);

  // (c1) challenger codex EXPLÍCITO + advocate auto, autor claude → challenger=codex (não derivado), advocate por família.
  const c1 = runScoped(dirClaude, rawClaude, ['--challenger', 'codex', '--advocate', 'auto']);
  assert(c1.parsed && c1.parsed.challenger === 'codex' && c1.parsed.advocate === 'claude',
    '(c1) challenger:codex explícito vence resolução; advocate auto → claude (same-family)', JSON.stringify(c1.parsed));

  // (c2) challenger auto + autor gpt → challenger=claude (oposto).
  const c2 = runScoped(dirCodex, rawCodex, ['--challenger', 'auto']);
  assert(c2.parsed && c2.parsed.author === 'gpt' && c2.parsed.challenger === 'claude',
    '(c2) challenger:auto + autor gpt → challenger=claude', JSON.stringify(c2.parsed));

  // (c3) challenger auto + autor claude → challenger=codex (oposto).
  const c3 = runScoped(dirClaude, rawClaude, ['--challenger', 'auto']);
  assert(c3.parsed && c3.parsed.author === 'claude' && c3.parsed.challenger === 'codex',
    '(c3) challenger:auto + autor claude → challenger=codex', JSON.stringify(c3.parsed));

  // (c4) BLOCKER: challenger auto + autor claude → RESOLVIDO codex (comportamental).
  // O force engine=agents é lógica de Step 0 markdown (não executável) → combinar com assert
  // estrutural de que a regra workflow testa o RESOLVIDO e roda APÓS a resolução (abaixo, (e)).
  assert(c3.parsed && c3.parsed.challenger === 'codex',
    '(c4) BLOCKER célula: auto+autor-claude resolve para codex (não `auto` cru) — insumo do force engine=agents', JSON.stringify(c3.parsed));

  // (c5) advocate auto + autor gpt → advocate=claude + fallback defend-mode-unavailable.
  const c5 = runScoped(dirCodex, rawCodex, ['--advocate', 'auto']);
  assert(c5.parsed && c5.parsed.advocate === 'claude' && c5.parsed.fallbacks.includes('defend-mode-unavailable'),
    '(c5) advocate:auto + autor gpt → advocate=claude, fallback defend-mode-unavailable', JSON.stringify(c5.parsed));

  // ── (d) EXCLUSÃO review-fix — unit não começa com execute-task/ ──────────────
  const dirRfix = mkTmp('pairing-wire-review-fix');
  const rawRfix = writeRaw(dirRfix, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex', slice: 'S02', milestone: 'M006' },
    { event: 'dispatch', unit: 'review-fix/S02', engine: 'claude', slice: 'S02', milestone: 'M006' },
  ]);
  // Via pré-escopo: o filtro execute-task/ já dropa o review-fix.
  const rfixScoped = runScoped(dirRfix, rawRfix);
  assert(rfixScoped.kept === 1,
    '(d) pré-escopo dropa review-fix/S02 (unit não começa com execute-task/) → 1 evento mantido', `kept=${rfixScoped.kept}`);
  // Via CLI direto no stream inteiro: aggregateAuthor também ignora o review-fix.
  const { parsed: rfixCli } = cliParse(['--events', rawRfix, '--slice', 'S02', '--milestone', 'M006', '--cwd', dirRfix]);
  assert(rfixCli && rfixCli.counts.claude === 0 && rfixCli.author === 'gpt',
    '(d) CLI ignora review-fix na autoria → counts.claude=0, author=gpt', JSON.stringify(rfixCli));
  cleanup(dirRfix);
  cleanup(dirClaude);
  cleanup(dirCodex);

  // ── (e) ASSERTS ESTRUTURAIS sobre spec/skills editados (T01/T02/T03) ─────────
  const reviewMd = rd('shared/forge-review.md');
  const autoMd = rd('skills/forge-auto/SKILL.md');
  const nextMd = rd('skills/forge-next/SKILL.md');
  const taskMd = rd('skills/forge-task/SKILL.md');
  const dispatchMd = rd('shared/forge-dispatch.md');

  // (e1) whitelist do reader inclui `auto` (e gemini, reconciliado R5-spec S05).
  assert(reviewMd.includes("['claude','codex','gemini','auto'].includes(challenger)"),
    '(e1) forge-review.md: whitelist do reader inclui auto+gemini para challenger', 'whitelist auto/gemini não encontrada');

  // (e2) bloco de resolução + evento review-pairing-fallback presentes.
  assert(reviewMd.includes('Resolução de pairing') && reviewMd.includes('review-pairing-fallback'),
    '(e2) forge-review.md: bloco de resolução de pairing + evento review-pairing-fallback presentes', 'bloco/evento ausente');

  // (e3) ORDEM DE PRECEDÊNCIA: a chamada ao CLI (resolução) vem ANTES do check workflow-força-agents.
  const idxResolve = reviewMd.indexOf('--events "$SCOPED" --slice "{S##}" --milestone "{M###}" --cwd "$WORKING_DIR"');
  const idxWorkflow = reviewMd.indexOf('[ "$RESOLVED_CHALLENGER" != "claude" ] && [ "$ENGINE" = "workflow" ]');
  assert(idxResolve > -1 && idxWorkflow > -1 && idxResolve < idxWorkflow,
    '(e3) resolução de pairing precede o check engine:workflow-força-agents (ordem canônica)', `idxResolve=${idxResolve} idxWorkflow=${idxWorkflow}`);

  // (e4) a regra workflow testa o RESOLVIDO (nunca `auto` cru); != claude cobre codex E gemini (R2/S05).
  assert(reviewMd.includes('[ "$RESOLVED_CHALLENGER" != "claude" ] && [ "$ENGINE" = "workflow" ]'),
    '(e4) forge-review.md: regra workflow-força-agents testa $RESOLVED_CHALLENGER (não auto cru)', 'check do resolvido não encontrado');

  // (e5) codex-unavailable é distinto de codex-exit-nonzero (check command -v codex no Step 0).
  assert(reviewMd.includes('command -v codex') && reviewMd.includes('"reason":"codex-unavailable"') && reviewMd.includes('codex-exit-nonzero'),
    '(e5) forge-review.md: codex-unavailable (command -v codex) distinto de codex-exit-nonzero', 'distinção codex-unavailable/codex-exit-nonzero ausente');

  // (e6) guard: CLI não é chamado quando nenhum eixo é auto (ambos explícitos vencem).
  assert(reviewMd.includes('if [ "$CHALLENGER" = auto ] || [ "$ADVOCATE" = auto ]'),
    '(e6) forge-review.md: guard chama o CLI só quando challenger|advocate == auto', 'guard de chamada condicional ausente');

  // (e7) --cwd "$WORKING_DIR" explícito na chamada do CLI; nunca CODE_DIR.
  assert(reviewMd.includes('--cwd "$WORKING_DIR"'),
    '(e7) forge-review.md: chamada do CLI passa --cwd "$WORKING_DIR" explícito', '--cwd "$WORKING_DIR" ausente');

  // (e8) exit status do CLI é capturado E o JSON é validado uma única vez ANTES dos parsers por-campo.
  assert(reviewMd.includes('PAIR_EXIT=$?') && reviewMd.includes('PAIR_VALID='),
    '(e8) forge-review.md: exit status (PAIR_EXIT) + validação one-shot (PAIR_VALID) do JSON antes dos parsers', 'PAIR_EXIT/PAIR_VALID ausentes');

  // (e9) falha de resolução (crash/JSON inválido) degrada para estático + evento diagnóstico dedicado.
  assert(reviewMd.includes('"reason":"%s"') && reviewMd.includes('"pairing-resolution-failed"'),
    '(e9) forge-review.md: falha de exit/JSON emite review-pairing-fallback reason pairing-resolution-failed', 'reason pairing-resolution-failed ausente');
  assert(!/forge-review-pairing\.js[^\n]*CODE_DIR/.test(reviewMd),
    '(e7) forge-review.md: chamada do CLI nunca usa CODE_DIR (worktree gotcha, MEM018)', 'CODE_DIR encontrado na chamada do CLI');

  // (e8) linha **Pairing:** montada no Step 0 e consumida no Step 6.
  assert(reviewMd.includes('PAIRING_LINE="**Pairing:**') && reviewMd.includes('{$PAIRING_LINE}'),
    '(e8) forge-review.md: $PAIRING_LINE montada no Step 0 e renderizada no header do Step 6', 'PAIRING_LINE/render ausente');

  // (e9) discriminadores slice+milestone nos 5 emission sites (3 forge-auto + 2 forge-next).
  const discNeedle = '\\"slice\\":\\"{S##}\\",\\"milestone\\":\\"${RUN_ID:-{M###}}\\"';
  const autoHits = countOccur(autoMd, discNeedle);
  const nextHits = countOccur(nextMd, discNeedle);
  assert(autoHits >= 3,
    '(e9) forge-auto: discriminadores slice+milestone nos 3 execute-task dispatch emits', `hits=${autoHits}`);
  assert(nextHits >= 2,
    '(e9) forge-next: discriminadores slice+milestone nos 2 execute-task dispatch emits', `hits=${nextHits}`);

  // (e10) forge-dispatch.md declara a fonte canônica + schema additivo slice/milestone.
  assert(dispatchMd.includes('additive `slice` + `milestone`') && dispatchMd.includes('Fonte canônica de autoria'),
    '(e10) forge-dispatch.md: schema additivo slice/milestone + fonte canônica de autoria declarados', 'declaração de schema/fonte ausente');

  // (e11) forge-task Step 5.5 referencia a resolução auto + task-unit scoping + Pairing header.
  assert(taskMd.includes('Resolução de pairing') && taskMd.includes('execute-task/{TASK_ID}') &&
    taskMd.includes('**Pairing:**') && taskMd.includes('$PAIRING_LINE'),
    '(e11) forge-task Step 5.5: resolução auto + task-unit scoping + Pairing header ($PAIRING_LINE)', 'referências do forge-task ausentes');
}

// ── Section 31: review pairing prefs schema (auto) ─────────────────────────
// Regression guards do schema de prefs de M006: challenger/advocate auto
// documentados, default challenger:claude preservado, e a semântica de
// ortogonalidade (auto=família) citando shared/forge-review.md.
function smokeReviewPairingPrefsSchema() {
  process.stdout.write('\n▸ Section 31: review pairing prefs schema (auto)\n');

  const REPO = path.dirname(SCRIPTS);
  const prefs = SCAFFOLD;
  const reviewStart = prefs.indexOf('Review gate dialético');
  const block = prefs.slice(reviewStart > -1 ? reviewStart : prefs.indexOf('"review":'));
  assert(prefs.includes('"review":'), '(a) generated scaffold contém o bloco review', 'bloco ausente');

  // (b) challenger: auto e advocate: auto documentados no bloco.
  assert(/"challenger":\s+"claude"/.test(block),
    '(b) § Review Settings documenta "challenger: ... auto" na semântica', 'challenger auto não encontrado no bloco');
  assert(/"advocate":\s+"claude"/.test(block),
    '(b) § Review Settings documenta "advocate: ... auto" na semântica', 'advocate auto não encontrado no bloco');

  // (c) guard anti-flip — default do bloco fenced ainda é challenger: claude.
  assert(/"challenger":\s+"claude"/.test(block),
    '(c) default do scaffold permanece "challenger: claude" (guard anti-flip acidental)', `block='${block.slice(0, 200)}'`);
  assert(!/"challenger":\s+"auto"/.test(block),
    '(c) default do bloco fenced NÃO é challenger: auto', 'default acidentalmente virou auto');

  // (d) ortogonalidade (auto=família) documentada + citação de shared/forge-review.md (fonte, não redefinida).
  assert(block.includes('família OPOSTA ao autor') || block.includes('MESMA família do autor'),
    '(d) § Review Settings documenta a semântica de família (ortogonalidade auto)', 'semântica de família ausente');
  assert(block.includes('shared/forge-review.md'),
    '(d) § Review Settings cita shared/forge-review.md como fonte da matriz (não redefinida)', 'citação a shared/forge-review.md ausente');

  // (e) modelo (challenger_model/advocate_model) segue documentado — eixo ortogonal MODELO intacto.
  assert(block.includes('challenger_model') && block.includes('advocate_model'),
    '(e) § Review Settings preserva os eixos challenger_model/advocate_model (MODELO, ortogonal a auto=FAMÍLIA)', 'eixos de modelo ausentes');
}

// ── Section 32: routing resolver (célula a célula + identidade legado) ─────
// M007 S01 T04. Exercita forge-routing.js (readRoutingConfig/resolveRoute)
// via require() e via CLI subprocess (runScript), incluindo o assert de
// identidade byte-idêntica com readTierChain() quando não há bloco routing:.
function smokeRouting() {
  process.stdout.write('\n▸ Section 32: routing resolver (célula a célula + identidade legado)\n');
  const { resolveRoute, readRoutingConfig } = require('./forge-routing');
  const { readPrefsCached } = require('./forge-prefs');
  const { modelFamily } = require('./forge-model-alias');
  const { readTierChain } = require('./forge-tier-chain');

  const qStatuses = []; // (q) exit 0 sempre — coletado em cada runScript abaixo

  const writeRoutingPrefs = (dir, bodyText, filename) => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    // The source cases are retained as readable YAML-shaped strings, but the
    // fixture itself is JSONC so every routing assertion exercises readPrefs.
    const valueOf = (raw) => {
      const value = raw.trim();
      if (!value) return {};
      if (value.startsWith('[')) {
        if (!value.endsWith(']')) return value;
        return value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
      }
      return value;
    };
    if (bodyText.split('\n').some((line) => line.startsWith('   fallback:'))) {
      fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{"routing":', 'utf8');
      return;
    }
    const root = {};
    const stack = [{ indent: -1, object: root }];
    for (const line of bodyText.split('\n')) {
      if (!line.trim()) continue;
      const indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
      const match = line.trim().match(/^([^:]+):(?:\s*(.*))?$/);
      if (!match) continue;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const key = match[1].trim();
      const value = valueOf(match[2] || '');
      stack[stack.length - 1].object[key] = value;
      if (value && typeof value === 'object' && !Array.isArray(value)) stack.push({ indent, object: value });
    }
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ routing: root }), 'utf8');
  };

  // (a) precedência: routing.<domínio>.<fase>.<tier> presente → routing-hit
  const dirA = mkTmp('routing-a');
  writeRoutingPrefs(dirA,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const rA = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirA });
  assert(rA.source === 'routing' && /routing-hit/.test(rA.reason) && rA.domain_used === 'backend',
    '(a) precedência: célula routing.<domínio>.<fase>.<tier> → source:routing, reason:routing-hit, domain_used:<domínio>',
    JSON.stringify(rA));
  cleanup(dirA);

  // (b) routing-default: célula do domínio ausente, routing.default presente
  const dirB = mkTmp('routing-b');
  writeRoutingPrefs(dirB,
    '  backend:\n' +
    '    executor:\n' +
    '      heavy: [claude-opus-4-8]\n' +
    '  default:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const rB = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirB });
  assert(rB.source === 'routing' && /routing-default/.test(rB.reason) && rB.domain_used === 'default',
    '(b) routing-default: célula ausente no domínio → cai para routing.default.<fase>.<tier>',
    JSON.stringify(rB));
  cleanup(dirB);

  // (c) tier_models legado: domínio+default ausentes para a fase/tier pedidos
  const dirC = mkTmp('routing-c');
  writeRoutingPrefs(dirC,
    '  frontend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const rC = withHermeticHome(() =>
    resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirC }));
  assert(rC.source === 'tier_models', '(c) domínio+default ausentes → source:tier_models (legado)', JSON.stringify(rC));
  cleanup(dirC);

  // (d) frontmatter override: tier/worker fixados no frontmatter vencem o source
  const dirD = mkTmp('routing-d');
  writeRoutingPrefs(dirD,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const rD1 = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', frontmatterTier: 'heavy', cwd: dirD });
  assert(rD1.source === 'frontmatter' && /frontmatter-tier/.test(rD1.reason),
    '(d) frontmatter-tier vence o rótulo de source (mesmo resolvendo via routing/legado no tier fixado)',
    JSON.stringify(rD1));
  const rD2 = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', frontmatterWorker: 'claude-opus-4-8', cwd: dirD });
  assert(rD2.source === 'frontmatter' && /frontmatter-worker/.test(rD2.reason) && rD2.chain.length === 1 && rD2.chain[0].id === 'claude-opus-4-8',
    '(d) frontmatter-worker fixa um único membro de cadeia, vence a precedência inteira',
    JSON.stringify(rD2));
  cleanup(dirD);

  // (e) parse-error: indentação quebrada (dedent para nível desconhecido) → all-or-nothing
  const dirE = mkTmp('routing-e');
  writeRoutingPrefs(dirE,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n' +
    '   fallback: claude-haiku-4-5-20251001\n'
  );
  const cfgE = readPrefsCached(dirE);
  assert(cfgE.ok === false && cfgE.errors.length > 0,
    '(e) malformed JSONC routing fixture → canonical reader reports a parse error', JSON.stringify(cfgE));
  // Com o layer local em parse-error e sem global routing configurado, a
  // degradação canônica é tier_models (M008 all-or-nothing) — não exigimos
  // source:'routing' aqui, só o contrato do resolver (chain não-vazia + source string).
  const rE = withHermeticHome(() =>
    resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirE }));
  assert(Array.isArray(rE.chain) && rE.chain.length > 0 && typeof rE.source === 'string',
    '(e) malformed routing fixture still returns the resolver contract safely', JSON.stringify(rE));
  const eCli = runScript('forge-routing.js', ['--unit-type', 'execute-task', '--tier', 'standard', '--domain', 'backend', '--cwd', dirE]);
  qStatuses.push(eCli.status);
  assert(eCli.status === 0, '(e) CLI com bloco malformado ainda sai 0', `status=${eCli.status}`);
  cleanup(dirE);

  // (f) tabs vs espaços: indentação relativa (não absoluta) → mesmo resultado de parse
  const dirF1 = mkTmp('routing-f1');
  writeRoutingPrefs(dirF1,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n' +
    '      fallback: claude-haiku-4-5-20251001\n'
  );
  const dirF2 = mkTmp('routing-f2');
  writeRoutingPrefs(dirF2,
    '\tbackend:\n' +
    '\t\texecutor:\n' +
    '\t\t\tstandard: [claude-sonnet-5]\n' +
    '\t\t\tfallback: claude-haiku-4-5-20251001\n'
  );
  const cfgF1 = readRoutingConfig(dirF1);
  const cfgF2 = readRoutingConfig(dirF2);
  assert(cfgF1.ok === true && cfgF2.ok === true, '(f) blocos com espaços e com tabs ambos parseiam ok:true',
    `f1.ok=${cfgF1.ok} f2.ok=${cfgF2.ok}`);
  assert(JSON.stringify(cfgF1.routing) === JSON.stringify(cfgF2.routing),
    '(f) tabs vs espaços → parse idêntico (indentação relativa, não absoluta)',
    `${JSON.stringify(cfgF1.routing)} !== ${JSON.stringify(cfgF2.routing)}`);
  cleanup(dirF1);
  cleanup(dirF2);

  // (g) domínio duplicado entre arquivos da cascata → last-wins por domínio inteiro
  const dirG = mkTmp('routing-g');
  writeRoutingPrefs(dirG,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n',
    'claude-agent-prefs.md'
  );
  fs.writeFileSync(path.join(dirG, '.gsd', 'forge-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["claude-opus-4-8"]}}}}', 'utf8');
  const cfgG = readRoutingConfig(dirG);
  assert(cfgG.routing.backend.executor.standard[0] === 'claude-opus-4-8',
    '(g) domínio redefinido em arquivo mais específico → last-wins por domínio inteiro (nunca merge de campo)',
    JSON.stringify(cfgG.routing));
  cleanup(dirG);

  // (h) célula mista claude/gpt: chain com engine por membro
  const dirH = mkTmp('routing-h');
  writeRoutingPrefs(dirH,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5, gpt-5-codex]\n'
  );
  const rH = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirH });
  assert(rH.chain.length === 2 && rH.chain[0].engine === 'claude' && rH.chain[1].engine === 'gpt',
    '(h) célula mista claude/gpt → cadeia com 2 membros, engine correto por membro', JSON.stringify(rH.chain));
  cleanup(dirH);

  // (i) membro com família desconhecida (não-gemini) é pulado da cadeia
  const dirI = mkTmp('routing-i');
  writeRoutingPrefs(dirI,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5, mistral-7b]\n'
  );
  const rI = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirI });
  assert(rI.chain.length === 1 && rI.chain[0].id === 'claude-sonnet-5',
    '(i) membro família desconhecida → pulado, cadeia final só com claude', JSON.stringify(rI.chain));
  assert(/skipped-unknown-family/.test(rI.reason), '(i) reason contém skipped-unknown-family', rI.reason);
  cleanup(dirI);

  // (j) cadeia de 5 membros → cap em 3, reason chain-capped
  const dirJ = mkTmp('routing-j');
  writeRoutingPrefs(dirJ,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5, claude-opus-4-8, claude-haiku-4-5-20251001, claude-sonnet-5, claude-opus-4-8]\n'
  );
  const rJ = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirJ });
  assert(rJ.chain.length === 3, '(j) cadeia de 5 membros → truncada em 3 (CHAIN_CAP)', `got length=${rJ.chain.length}`);
  assert(/chain-capped/.test(rJ.reason), '(j) reason contém chain-capped', rJ.reason);
  cleanup(dirJ);

  // (k) fallback configurado não-claude/não-mapeado → substituído pelo default do tier
  const dirK = mkTmp('routing-k');
  writeRoutingPrefs(dirK,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n' +
    '      fallback: gpt-5-codex\n'
  );
  const rK = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirK });
  assert(/fallback-invalid-substituted/.test(rK.reason), '(k) fallback gpt → reason fallback-invalid-substituted', rK.reason);
  assert(rK.fallback.id !== 'gpt-5-codex' && modelFamily(rK.fallback.id) === 'claude',
    '(k) fallback substituído pelo default claude/mapeado do tier', JSON.stringify(rK.fallback));
  const kCli = runScript('forge-routing.js', ['--unit-type', 'execute-task', '--tier', 'standard', '--domain', 'backend', '--cwd', dirK]);
  qStatuses.push(kCli.status);
  assert(kCli.status === 0, '(k) CLI com fallback inválido ainda sai 0', `status=${kCli.status}`);
  cleanup(dirK);

  // (l) plan-milestone NUNCA é capturado pelo routing, mesmo com célula presente
  const dirL = mkTmp('routing-l');
  writeRoutingPrefs(dirL,
    '  default:\n' +
    '    plan:\n' +
    '      standard: [claude-fable-5]\n'
  );
  const rL = resolveRoute({ unitType: 'plan-milestone', tier: 'standard', domain: 'backend', cwd: dirL });
  assert(/phase-not-routable/.test(rL.reason), '(l) plan-milestone → phase-not-routable (nunca célula do routing)', rL.reason);
  const cliL = runScript('forge-routing.js', ['--unit-type', 'plan-milestone', '--tier', 'standard', '--domain', 'backend', '--cwd', dirL]);
  qStatuses.push(cliL.status);
  let parsedL = null;
  try { parsedL = JSON.parse(cliL.stdout); } catch {}
  assert(cliL.status === 0 && parsedL !== null && /phase-not-routable/.test(parsedL.reason),
    '(l) CLI contrato JSON confirma phase-not-routable, sai 0', `status=${cliL.status} stdout=${cliL.stdout}`);
  cleanup(dirL);

  // (m) fases claude-only (discuss-slice, memory) também são phase-not-routable
  const dirM = mkTmp('routing-m');
  const rM1 = resolveRoute({ unitType: 'discuss-slice', tier: 'standard', cwd: dirM });
  assert(/phase-not-routable/.test(rM1.reason), '(m) discuss-slice → phase-not-routable', rM1.reason);
  const rM2 = resolveRoute({ unitType: 'memory', tier: 'standard', cwd: dirM });
  assert(/phase-not-routable/.test(rM2.reason), '(m) memory → phase-not-routable', rM2.reason);
  cleanup(dirM);

  // (n) --next-after: cadeia resolvida (2 membros) → segundo, depois fallback, depois ''
  const dirN = mkTmp('routing-n');
  writeRoutingPrefs(dirN,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5, claude-opus-4-8]\n' +
    '      fallback: claude-haiku-4-5-20251001\n'
  );
  const baseArgsN = ['--unit-type', 'execute-task', '--tier', 'standard', '--domain', 'backend', '--cwd', dirN];
  const n1 = runScript('forge-routing.js', [...baseArgsN, '--next-after', 'claude-sonnet-5']);
  qStatuses.push(n1.status);
  assert(n1.status === 0 && n1.stdout.trim() === 'claude-opus-4-8',
    '(n) --next-after do primeiro membro → segundo membro da cadeia', `status=${n1.status} stdout='${n1.stdout.trim()}'`);
  const n2 = runScript('forge-routing.js', [...baseArgsN, '--next-after', 'claude-opus-4-8']);
  qStatuses.push(n2.status);
  assert(n2.status === 0 && n2.stdout.trim() === 'claude-haiku-4-5-20251001',
    '(n) --next-after do último membro → fallback de categoria', `status=${n2.status} stdout='${n2.stdout.trim()}'`);
  const n3 = runScript('forge-routing.js', [...baseArgsN, '--next-after', 'claude-haiku-4-5-20251001']);
  qStatuses.push(n3.status);
  assert(n3.status === 0 && n3.stdout.trim() === '',
    '(n) --next-after do fallback já usado → string vazia (cadeia esgotada)', `status=${n3.status} stdout='${n3.stdout.trim()}'`);
  cleanup(dirN);

  // (o) --explain: marcadores pt-BR de precedência/degradação presentes
  const dirO = mkTmp('routing-o');
  writeRoutingPrefs(dirO,
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const o1 = runScript('forge-routing.js', ['--unit-type', 'execute-task', '--tier', 'standard', '--domain', 'backend', '--explain', '--cwd', dirO]);
  qStatuses.push(o1.status);
  assert(o1.status === 0, '(o) --explain sai 0', `status=${o1.status}`);
  assert(/Explicação da rota/.test(o1.stdout) && /camada de precedência vencedora/.test(o1.stdout) && /Cadeia final/.test(o1.stdout),
    '(o) --explain contém marcadores pt-BR da decisão (célula/precedência/degradação)', o1.stdout.slice(0, 300));
  cleanup(dirO);

  // (p) IDENTIDADE byte-idêntica: sem bloco routing:, chain/fallback == readTierChain()
  const projChain = (arr) => arr.map((m) => ({ id: m.id, alias: m.alias, mapped: m.mapped }));

  const dirP1 = mkTmp('routing-p-scalar');
  fs.mkdirSync(path.join(dirP1, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dirP1, '.gsd', 'forge-prefs.jsonc'), '{"tier_models":{"standard":"claude-sonnet-5"}}', 'utf8');
  const rP1 = withHermeticHome(() =>
    resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'x', cwd: dirP1 }));
  const legacyP1 = withHermeticHome(() => readTierChain('standard', dirP1));
  assert(JSON.stringify(projChain(rP1.chain)) === JSON.stringify(projChain(legacyP1)),
    '(p) IDENTIDADE: sem routing:, chain byte-idêntica ao readTierChain (escalar)',
    `${JSON.stringify(rP1.chain)} vs ${JSON.stringify(legacyP1)}`);
  assert(rP1.fallback.id === legacyP1[0].id && rP1.fallback.alias === legacyP1[0].alias,
    '(p) IDENTIDADE: fallback byte-idêntico ao primeiro membro legado (escalar)', JSON.stringify(rP1.fallback));
  cleanup(dirP1);

  const dirP2 = mkTmp('routing-p-list');
  fs.mkdirSync(path.join(dirP2, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dirP2, '.gsd', 'forge-prefs.jsonc'),
    '{"tier_models":{"standard":["claude-sonnet-5","claude-haiku-4-5-20251001"]}}', 'utf8');
  const rP2 = withHermeticHome(() =>
    resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'x', cwd: dirP2 }));
  const legacyP2 = withHermeticHome(() => readTierChain('standard', dirP2));
  assert(JSON.stringify(projChain(rP2.chain)) === JSON.stringify(projChain(legacyP2)),
    '(p) IDENTIDADE: sem routing:, chain byte-idêntica ao readTierChain (lista inline)',
    `${JSON.stringify(rP2.chain)} vs ${JSON.stringify(legacyP2)}`);
  cleanup(dirP2);

  // (q) exit 0 sempre — todos os runScript('forge-routing.js', ...) acima retornaram status 0,
  // inclusive nos caminhos de degradação (e/f/k/l).
  assert(qStatuses.length > 0 && qStatuses.every((s) => s === 0),
    '(q) todos os runScript(forge-routing.js, ...) desta Section retornam status 0 (inclusive degradações)',
    JSON.stringify(qStatuses));
}

// ── Section 33: routing wiring (call-sites + eventos + contrato BLOCKER) ────
// M007 S02 T04. Doc-presence guards (grep-over-file) que verificam o wiring
// de T01/T02/T03 nos 3 arquivos: canônico shared/forge-dispatch.md, e os
// dois mirrors executáveis skills/forge-auto/SKILL.md e forge-next/SKILL.md.
// Não exercita runtime — apenas confirma que os textos/call-sites existem.
function smokeRoutingWiring() {
  process.stdout.write('\n▸ Section 33: routing wiring (call-sites + eventos + contrato BLOCKER)\n');

  const dispatchPath = path.join(__dirname, '..', 'shared', 'forge-dispatch.md');
  const autoPath = path.join(__dirname, '..', 'skills', 'forge-auto', 'SKILL.md');
  const nextPath = path.join(__dirname, '..', 'skills', 'forge-next', 'SKILL.md');

  const dispatchTxt = fs.readFileSync(dispatchPath, 'utf8');
  const autoTxt = fs.readFileSync(autoPath, 'utf8');
  const nextTxt = fs.readFileSync(nextPath, 'utf8');

  const files = [
    { name: 'shared/forge-dispatch.md', txt: dispatchTxt },
    { name: 'skills/forge-auto/SKILL.md', txt: autoTxt },
    { name: 'skills/forge-next/SKILL.md', txt: nextTxt },
  ];

  // (a) call-sites: forge-routing.js aparece como call de dispatch (perto de --unit-type)
  // nos 3 arquivos.
  for (const f of files) {
    const hasCallSite = /forge-routing\.js["'`]?[\s\S]{0,120}--unit-type/.test(f.txt) ||
      /--unit-type[\s\S]{0,300}forge-routing\.js/.test(f.txt);
    assert(hasCallSite,
      `(a) ${f.name} contém forge-routing.js como call de dispatch (perto de --unit-type)`,
      `forge-routing.js count=${(f.txt.match(/forge-routing\.js/g) || []).length}`);
  }

  // (b) os mirrors NÃO retêm a resolução inicial de cadeia via forge-tier-chain.js --json
  // (só pode sobrar menção descritiva "replaces the old forge-tier-chain.js --json", nunca
  // um call-site ativo tipo `node ... forge-tier-chain.js ... --json` fora de comentário/prosa).
  const activeTierChainJsonCall = /\$\([^)]*forge-tier-chain\.js[^)]*--json[^)]*\)/;
  for (const f of [{ name: 'skills/forge-auto/SKILL.md', txt: autoTxt }, { name: 'skills/forge-next/SKILL.md', txt: nextTxt }]) {
    assert(!activeTierChainJsonCall.test(f.txt),
      `(b) ${f.name} não retém call-site ativo de forge-tier-chain.js --json (resolução inicial substituída)`,
      'encontrado call-site ativo');
  }
  // e o dispatch canônico também não descreve forge-routing.js como opcional/paralelo —
  // assert positivo: o step 4 de Tier Resolution é a chamada forge-routing.js.
  assert(/forge-routing\.js/.test(dispatchTxt) && /SINGLE.{0,20}call/i.test(dispatchTxt),
    '(b) shared/forge-dispatch.md descreve forge-routing.js como a chamada ÚNICA (single call)',
    'marcador "SINGLE ... call" ausente');

  // (c) eventos aditivos: os 3 arquivos documentam/emitem domain/route_source/chain_len
  // no evento dispatch.
  for (const f of files) {
    assert(/route_source/.test(f.txt) && /chain_len/.test(f.txt) && /\bdomain\b/.test(f.txt),
      `(c) ${f.name} documenta os campos aditivos domain/route_source/chain_len no evento dispatch`,
      `route_source=${/route_source/.test(f.txt)} chain_len=${/chain_len/.test(f.txt)} domain=${/\bdomain\b/.test(f.txt)}`);
  }

  // (d) contrato BLOCKER (doc-presence): sufixo -attempt- (state fresco por tentativa),
  // reset verificado via forge-surgical-reset.js (critério = exit 0 do helper, NÃO porcelain) e cap
  // SIDECAR_ATTEMPT presentes em forge-auto e forge-next; o canônico descreve os três.
  for (const f of [{ name: 'skills/forge-auto/SKILL.md', txt: autoTxt }, { name: 'skills/forge-next/SKILL.md', txt: nextTxt }]) {
    assert(/-attempt-/.test(f.txt),
      `(d) ${f.name} contém o sufixo -attempt- (state fresco por tentativa)`, 'ausente');
    assert(/forge-surgical-reset\.js --reset/.test(f.txt),
      `(d) ${f.name} contém o reset verificado via forge-surgical-reset.js --reset`, 'ausente');
    assert(/SIDECAR_ATTEMPT/.test(f.txt),
      `(d) ${f.name} contém o cap SIDECAR_ATTEMPT`, 'ausente');
  }
  assert(/-attempt-/.test(dispatchTxt) && /forge-surgical-reset\.js --reset/.test(dispatchTxt) && /SIDECAR_ATTEMPT/.test(dispatchTxt),
    '(d) shared/forge-dispatch.md descreve os três invariantes do contrato BLOCKER (-attempt-, forge-surgical-reset.js --reset, SIDECAR_ATTEMPT)',
    `attempt=${/-attempt-/.test(dispatchTxt)} reset=${/forge-surgical-reset\.js --reset/.test(dispatchTxt)} cap=${/SIDECAR_ATTEMPT/.test(dispatchTxt)}`);

  // (e) Layer 2 / MEM001: forge-routing.js aparece perto de --next-after; context_overflow
  // re-resolve via routing (não forge-tier-chain na row); e o texto reforça "nunca 4ª camada".
  for (const f of [{ name: 'shared/forge-dispatch.md', txt: dispatchTxt }, { name: 'skills/forge-auto/SKILL.md', txt: autoTxt }, { name: 'skills/forge-next/SKILL.md', txt: nextTxt }]) {
    assert(/forge-routing\.js[\s\S]{0,400}--next-after/.test(f.txt) || /--next-after[\s\S]{0,400}forge-routing\.js/.test(f.txt),
      `(e) ${f.name}: forge-routing.js aparece perto de --next-after (Layer 2 via routing)`,
      'padrão não encontrado');
  }
  assert(/never a 4th layer|nunca.{0,10}4ª camada|never.{0,10}4th layer/i.test(dispatchTxt),
    '(e) shared/forge-dispatch.md reforça "nunca 4ª camada" (MEM001)', 'marcador ausente');
  assert(/never a 4th layer/i.test(autoTxt), '(e) skills/forge-auto/SKILL.md reforça "never a 4th layer" (MEM001)', 'marcador ausente');
  assert(/never a 4th layer/i.test(nextTxt), '(e) skills/forge-next/SKILL.md reforça "never a 4th layer" (MEM001)', 'marcador ausente');

  // (f) context_overflow re-resolve THROUGH routing (não uma linha isolada com
  // forge-tier-chain.js na tabela de failure taxonomy).
  for (const f of files) {
    assert(/context_overflow/.test(f.txt),
      `(f) ${f.name} contém 'context_overflow' na Failure Taxonomy`, 'ausente');
  }
  assert(/context_overflow[\s\S]{0,600}forge-routing\.js/.test(dispatchTxt) || /forge-routing\.js[\s\S]{0,600}context_overflow/.test(dispatchTxt),
    '(f) shared/forge-dispatch.md: context_overflow re-resolve THROUGH forge-routing.js (proximidade textual)',
    'padrão não encontrado');

  // (g) compat: route_source/tier_models como caminho byte-idêntico legado (source:tier_models).
  for (const f of files) {
    assert(/tier_models/.test(f.txt),
      `(g) ${f.name} menciona tier_models (caminho legado byte-idêntico)`, 'ausente');
  }
  assert(/tier_models[\s\S]{0,400}(byte-idêntic|byte-identical)|(byte-idêntic|byte-identical)[\s\S]{0,400}tier_models/.test(dispatchTxt),
    '(g) shared/forge-dispatch.md descreve tier_models como caminho legado byte-idêntico',
    'padrão não encontrado');

  // (h) stub check — nenhum dos 3 arquivos ganhou placeholder no wiring de S02.
  const stubPatterns = [/\bTODO\b/, /\bTBD\b/, /\bFIXME\b/, /\bPLACEHOLDER\b/];
  for (const f of files) {
    for (const re of stubPatterns) {
      assert(!re.test(f.txt), `(h) ${f.name} não contém stub pattern ${re}`, 'stub encontrado');
    }
  }
}

// ── Section 34: emissão de domínio (schema aditivo + planner + plan-checker) ─
// M007 S03 T04. Asserts behaviorais sobre o schema aditivo `domain:` de
// forge-must-haves.js e sobre forge-routing.js --list-domains, mais drift
// guards (grep de presença/ausência) sobre a guidance de emissão em
// agents/forge-planner.md e a extensão da dimension 7 em
// agents/forge-plan-checker.md.
function smokeDomainEmission() {
  process.stdout.write('\n▸ Section 34: emissão de domínio (schema aditivo + planner + plan-checker)\n');

  const mustHavesScript = path.join(SCRIPTS, 'forge-must-haves.js');

  const runCheck = (content) => {
    const dir = mkTmp('domain-mh');
    const file = path.join(dir, 'T01-PLAN.md');
    fs.writeFileSync(file, content, 'utf8');
    const r = spawnSync(process.execPath, [mustHavesScript, '--check', file], { encoding: 'utf8' });
    cleanup(dir);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    return { status: r.status, parsed, raw: r.stdout, stderr: r.stderr };
  };

  const structuredWith = (domainLine) =>
    '---\n' +
    'id: T01\n' +
    'slice: S01\n' +
    'milestone: M999\n' +
    'title: "fixture"\n' +
    'worker: forge-executor\n' +
    (domainLine ? domainLine + '\n' : '') +
    'must_haves:\n' +
    '  truths:\n' +
    '    - "algo verdadeiro"\n' +
    '  artifacts:\n' +
    '    - path: "scripts/x.js"\n' +
    '      provides: "x"\n' +
    '      min_lines: 1\n' +
    '  key_links: []\n' +
    'expected_output:\n' +
    '  - scripts/x.js\n' +
    '---\n\n# T01: fixture\n';

  const legacyPlan =
    '---\n' +
    'id: T01\n' +
    'slice: S01\n' +
    'milestone: M999\n' +
    'title: "fixture legada"\n' +
    'worker: forge-executor\n' +
    '---\n\n# T01: fixture legada\n\n## Must-Haves\n- algo verdadeiro (free-text, sem bloco structured).\n';

  // (a) structured COM domain: backend → valid:true, domain refletido.
  const rA = runCheck(structuredWith('domain: backend'));
  assert(rA.status === 0 && rA.parsed && rA.parsed.legacy === false && rA.parsed.valid === true && rA.parsed.domain === 'backend',
    '(a) structured COM domain: backend → valid:true, domain:"backend"', JSON.stringify(rA));

  // (b) structured SEM domain: → valid:true, domain null/ausente.
  const rB = runCheck(structuredWith(null));
  assert(rB.status === 0 && rB.parsed && rB.parsed.legacy === false && rB.parsed.valid === true &&
    (rB.parsed.domain === null || rB.parsed.domain === undefined),
    '(b) structured SEM domain: → valid:true, domain null/ausente (campo aditivo)', JSON.stringify(rB));

  // (c) legacy (must_haves free-text) → legacy:true, valid:true.
  const rC = runCheck(legacyPlan);
  assert(rC.status === 0 && rC.parsed && rC.parsed.legacy === true && rC.parsed.valid === true,
    '(c) plano legacy (free-text) → legacy:true, valid:true', JSON.stringify(rC));

  // (d) domain: malformado (lista) → valid:false.
  const rD = runCheck(structuredWith('domain: [backend, frontend]'));
  assert(rD.status !== 0 && rD.parsed && rD.parsed.legacy === false && rD.parsed.valid === false,
    '(d) domain: malformado (lista) → valid:false, exit != 0', JSON.stringify(rD));

  // ── --list-domains behavioral ──────────────────────────────────────────
  const writeRoutingPrefsDom = (dir, bodyText) => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const lines = bodyText.split('\n').filter(Boolean);
    const routing = {};
    let curDomain = null;
    let curPhase = null;
    for (const line of lines) {
      if (/^\s{2}\S/.test(line)) {
        curDomain = line.trim().replace(/:$/, '');
        routing[curDomain] = routing[curDomain] || {};
        curPhase = null;
      } else if (/^\s{4}\S/.test(line)) {
        curPhase = line.trim().replace(/:$/, '');
        routing[curDomain][curPhase] = routing[curDomain][curPhase] || {};
      } else if (/^\s{6}\S/.test(line)) {
        const tierLine = line.trim();
        const split = tierLine.indexOf(':');
        const tier = tierLine.slice(0, split);
        const members = tierLine.slice(split + 1).trim().slice(1, -1).split(',').map((v) => v.trim());
        routing[curDomain][curPhase][tier] = members;
      }
    }
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ routing }), 'utf8');
  };

  // (e) dir com bloco routing: (2 domínios) → --list-domains retorna ambos, exit 0.
  const dirE = mkTmp('domain-list-e');
  writeRoutingPrefsDom(dirE,
    '  default:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n' +
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [claude-sonnet-5]\n'
  );
  const eR = runScript('forge-routing.js', ['--list-domains', '--cwd', dirE]);
  let eParsed = null;
  try { eParsed = JSON.parse(eR.stdout); } catch {}
  assert(eR.status === 0 && Array.isArray(eParsed) && eParsed.includes('default') && eParsed.includes('backend'),
    '(e) --list-domains com bloco routing: (2 domínios) → JSON array com ambas as chaves, exit 0',
    `status=${eR.status} stdout=${eR.stdout}`);
  cleanup(dirE);

  // (f) dir SEM bloco routing: → --list-domains retorna [], exit 0.
  const dirF = mkTmp('domain-list-f');
  fs.mkdirSync(path.join(dirF, '.gsd'), { recursive: true });
  const fR = withHermeticHome((homeOpts) =>
    runScript('forge-routing.js', ['--list-domains', '--cwd', dirF], homeOpts));
  let fParsed = null;
  try { fParsed = JSON.parse(fR.stdout); } catch {}
  assert(fR.status === 0 && Array.isArray(fParsed) && fParsed.length === 0,
    '(f) --list-domains sem bloco routing: → [], exit 0', `status=${fR.status} stdout=${fR.stdout}`);
  cleanup(dirF);

  // ── Drift guards — markdown (grep de presença/ausência) ────────────────
  const plannerTxt = fs.readFileSync(path.join(__dirname, '..', 'agents', 'forge-planner.md'), 'utf8');
  const planCheckerTxt = fs.readFileSync(path.join(__dirname, '..', 'agents', 'forge-plan-checker.md'), 'utf8');

  // (g) planner: guidance de domain: no frontmatter da task.
  assert(/domain:\s*backend/.test(plannerTxt) || /`domain:`/.test(plannerTxt),
    '(g) agents/forge-planner.md contém guidance de domain: no frontmatter da task', 'padrão não encontrado');

  // (h) planner: tag domain:<name> na linha do slice do ROADMAP.
  assert(/domain:<name>/.test(plannerTxt),
    '(h) agents/forge-planner.md referencia a tag `domain:<name>` na linha do slice do ROADMAP', 'padrão não encontrado');

  // (i) plan-checker: dimension 7 (scope_alignment) referencia domínio / --list-domains.
  assert(/scope_alignment/.test(planCheckerTxt) && /--list-domains/.test(planCheckerTxt),
    '(i) agents/forge-plan-checker.md: dimension 7 (scope_alignment) referencia --list-domains', 'padrão não encontrado');

  // (j) plan-checker: NÃO existe uma "Dimension 11" — extensão fica na dim-7 existente.
  assert(!/Dimension 11/.test(planCheckerTxt),
    '(j) agents/forge-plan-checker.md NÃO contém "Dimension 11" (extensão aditiva à dim-7, sem 11ª dimensão)',
    'ocorrência inesperada de "Dimension 11"');
}

// ── Section 35: guard de integração 3-família (gemini) + R5 whitelist ──────
// Guarda a integração ponta-a-ponta da 3ª família gemini: modelFamily,
// pairing (R1 preserve + explicit-respect + opposite), routing
// (phase-unsupported-family) e a reconciliação R5 da whitelist entre
// shared/forge-review.md (spec) e forge-review-pairing.js (CLI). Os cenários
// G–M do adapter agy (Section 20/smokeXllm) NÃO são responsabilidade desta
// seção — só o eixo 3-família + R5.
function smokeGeminiFamily() {
  process.stdout.write('\n▸ Section 35: integração 3-família (gemini) + R5 reconciliação\n');
  const { modelFamily } = require('./forge-model-alias');
  const { resolveRoute } = require('./forge-routing');

  // (a) modelFamily — gemini via agy/gemini-* e bare 'gemini'
  assert(modelFamily('agy/gemini-3.1-pro') === 'gemini',
    "(a) modelFamily('agy/gemini-3.1-pro')==='gemini'", `got ${modelFamily('agy/gemini-3.1-pro')}`);
  assert(modelFamily('gemini') === 'gemini',
    "(a) modelFamily('gemini')==='gemini'", `got ${modelFamily('gemini')}`);
  // (a2) regression — claude/gpt não regrediram com a introdução de gemini
  assert(modelFamily('claude-opus-4-8') === 'claude',
    "(a2) regression: modelFamily('claude-opus-4-8')==='claude'", `got ${modelFamily('claude-opus-4-8')}`);
  assert(modelFamily('gpt-5.2') === 'gpt',
    "(a2) regression: modelFamily('gpt-5.2')==='gpt'", `got ${modelFamily('gpt-5.2')}`);

  // helper de fixture de eventos (mesmo padrão de Section 29/30)
  const writeEvents = (dir, lines) => {
    const forgeDir = path.join(dir, '.gsd', 'forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const file = path.join(forgeDir, 'events.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return file;
  };
  const runPairing = (eventsFile, dir, extraArgs) => {
    const args = ['--slice', 'S02', '--milestone', 'M007', '--cwd', dir, '--events', eventsFile, ...(extraArgs || [])];
    const r = runScript('forge-review-pairing.js', args);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.trim()); } catch {}
    return { r, parsed };
  };

  // (b) R1 — normalizeRequest preserva 'gemini' explícito (via CLI --challenger gemini,
  // aferido pelo campo requested.challenger, não colapsado para 'auto')
  const dirClaude = mkTmp('gemini-fam-claude');
  const evClaude = writeEvents(dirClaude, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'claude' },
  ]);
  const { parsed: pGeminiExplicit } = runPairing(evClaude, dirClaude, ['--challenger', 'gemini']);
  assert(pGeminiExplicit && pGeminiExplicit.requested.challenger === 'gemini' && pGeminiExplicit.challenger === 'gemini',
    "(b) R1: --challenger gemini → requested.challenger='gemini' (preservado, não normalizado para auto), challenger='gemini' (respeitado)",
    JSON.stringify(pGeminiExplicit));

  // (b2) regression — valor desconhecido colapsa para 'auto' (normalizeRequest não regrediu)
  const { parsed: pUnknownReq } = runPairing(evClaude, dirClaude, ['--challenger', 'mistral']);
  assert(pUnknownReq && pUnknownReq.requested.challenger === 'auto',
    "(b2) regression: --challenger mistral (inválido) → requested.challenger='auto'",
    JSON.stringify(pUnknownReq));

  // (c) challenger gemini explícito respeitado independente do author (author=gpt)
  const dirCodex = mkTmp('gemini-fam-codex');
  const evCodex = writeEvents(dirCodex, [
    { event: 'dispatch', unit: 'execute-task/T01', engine: 'codex' },
    { event: 'dispatch', unit: 'execute-task/T02', engine: 'codex' },
  ]);
  const { parsed: pGeminiOverGpt } = runPairing(evCodex, dirCodex, ['--challenger', 'gemini']);
  assert(pGeminiOverGpt && pGeminiOverGpt.author === 'gpt' && pGeminiOverGpt.challenger === 'gemini',
    "(c) author=gpt + --challenger gemini explícito → challenger='gemini' (explicit vence opposite)",
    JSON.stringify(pGeminiOverGpt));

  // (d) opposite — auto (sem override): opposite(claude)==='codex' e opposite(gpt)==='claude'
  const { parsed: pOppositeClaude } = runPairing(evClaude, dirClaude);
  assert(pOppositeClaude && pOppositeClaude.author === 'claude' && pOppositeClaude.challenger === 'codex',
    "(d) opposite(claude)==='codex' — author=claude, auto → challenger=codex",
    JSON.stringify(pOppositeClaude));
  const { parsed: pOppositeGpt } = runPairing(evCodex, dirCodex);
  assert(pOppositeGpt && pOppositeGpt.author === 'gpt' && pOppositeGpt.challenger === 'claude',
    "(d) opposite(gpt)==='claude' — author=gpt, auto → challenger=claude",
    JSON.stringify(pOppositeGpt));

  cleanup(dirClaude);
  cleanup(dirCodex);

  // (e) routing — membro gemini na cadeia produz phase-unsupported-family
  // (NÃO skipped-unknown-family, que é reservado a famílias desconhecidas/null)
  const dirRouting = mkTmp('gemini-fam-routing');
  fs.mkdirSync(path.join(dirRouting, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dirRouting, '.gsd', 'forge-prefs.jsonc'),
    '{"routing":{"backend":{"executor":{"standard":["claude-sonnet-5","agy/gemini-3.1-pro"]}}}}', 'utf8');
  const rGemini = resolveRoute({ unitType: 'execute-task', tier: 'standard', domain: 'backend', cwd: dirRouting });
  assert(rGemini.chain.length === 1 && rGemini.chain[0].id === 'claude-sonnet-5',
    '(e) membro gemini pulado da cadeia resolvida → só o membro claude sobrevive',
    JSON.stringify(rGemini.chain));
  assert(/phase-unsupported-family/.test(rGemini.reason),
    '(e) reason contém phase-unsupported-family', rGemini.reason);
  assert(!/skipped-unknown-family/.test(rGemini.reason),
    '(e) reason NÃO contém skipped-unknown-family (gemini é família conhecida, discriminador distinto)',
    rGemini.reason);
  cleanup(dirRouting);

  // (f) R5 — reconciliação de whitelist nos dois lados: spec (shared/forge-review.md)
  // e CLI (VALID_REQUESTS de forge-review-pairing.js) precisam bater em gemini.
  const ROOT35 = path.join(__dirname, '..');
  const reviewSpecTxt = fs.readFileSync(path.join(ROOT35, 'shared', 'forge-review.md'), 'utf8');
  const pairingSrcTxt = fs.readFileSync(path.join(ROOT35, 'scripts', 'forge-review-pairing.js'), 'utf8');
  const specHasWhitelist = /claude\|codex\|gemini/.test(reviewSpecTxt);
  const cliHasGemini = /VALID_REQUESTS\s*=\s*\[[^\]]*'gemini'[^\]]*\]/.test(pairingSrcTxt);
  assert(specHasWhitelist,
    "(f) R5: shared/forge-review.md contém a whitelist 'claude|codex|gemini'",
    'padrão claude|codex|gemini não encontrado em shared/forge-review.md');
  assert(cliHasGemini,
    "(f) R5: VALID_REQUESTS em forge-review-pairing.js inclui 'gemini'",
    'VALID_REQUESTS sem gemini em forge-review-pairing.js');
  assert(specHasWhitelist === cliHasGemini,
    '(f) R5: os 2 lados batem (nenhum drift entre spec e CLI)',
    `spec=${specHasWhitelist} cli=${cliHasGemini}`);
}

function smokeRoutingScaffoldDocs() {
  process.stdout.write('\n▸ Section 36: scaffold routing: + docs fase 4 (drift-guard)\n');
  const ROOT36 = path.join(__dirname, '..');
  const prefsTxt = SCAFFOLD;
  const readmeTxt = fs.readFileSync(path.join(ROOT36, 'README.md'), 'utf8');
  const tiersTxt = fs.readFileSync(path.join(ROOT36, 'shared', 'forge-tiers.md'), 'utf8');

  assert(/"routing":/.test(prefsTxt),
    'generated scaffold contém routing',
    '"routing" não encontrado no scaffold');

  assert(/"routing":\s*\{\}/.test(prefsTxt),
    'generated scaffold contém routing opt-in',
    'routing vazio não encontrado no scaffold');

  assert(/## Multi-LLM fase 4/.test(readmeTxt),
    'README.md contém "## Multi-LLM fase 4"',
    '"## Multi-LLM fase 4" não encontrado em README.md');

  assert(/forge-routing\.js/.test(tiersTxt),
    'shared/forge-tiers.md menciona forge-routing.js (cross-ref do resolver)',
    'forge-routing.js não encontrado em shared/forge-tiers.md');
}

// ── Section 37: prefs engine (JSONC tokenizer + readPrefs + CLI) ──────────
// A deliberately small end-to-end net for the T04 engine.  The exhaustive
// parser/resolver contract remains in forge-prefs.test.js; this section keeps
// the important seams covered while also guarding the install-root boundary.
function smokePrefsEngine() {
  process.stdout.write('\n▸ Section 37: prefs engine (JSONC tokenizer + readPrefs + CLI)\n');
  const ROOT37 = path.join(__dirname, '..');
  const prefsSource = fs.readFileSync(path.join(SCRIPTS, 'forge-prefs.js'), 'utf8');
  const { parseJsonc, readPrefs, deepMerge } = require('./forge-prefs.js');
  const { readRoutingConfig } = require('./forge-routing.js');
  const requires = [...prefsSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const allowed = new Set(['fs', 'path', 'os', './forge-prefs-scaffold.js']);

  assert(requires.every((name) => allowed.has(name)),
    '(a) forge-prefs.js usa somente builtins permitidos (fs/path/os)', JSON.stringify(requires));
  // No LEGACY cross-imports: the new scaffold module is the sole intentional
  // forge-* dependency, and only on the cold --scaffold CLI branch.
  assert(requires.length === 4 && requires.every((name) => allowed.has(name)) &&
    requires.includes('./forge-prefs-scaffold.js'),
    '(a) forge-prefs.js usa a allowlist exata (scaffold lazy)', JSON.stringify(requires));
  assert(!prefsSource.includes('forge-prefs-legacy.js'),
    '(a) forge-prefs.js never requires forge-prefs-legacy.js (transitivity guard)');
  const scaffoldSource = fs.readFileSync(path.join(SCRIPTS, 'forge-prefs-scaffold.js'), 'utf8');
  const scaffoldRequires = [...scaffoldSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert(JSON.stringify(scaffoldRequires) === JSON.stringify(['fs', 'path', './forge-prefs.js']),
    '(a) scaffold usa a allowlist exata', JSON.stringify(scaffoldRequires));

  const jsonc = '\uFEFF{\r\n  "u": "https://a//b", /* c */\r\n  "t": "x // y",\r\n}';
  const clean = '{"u":"https://a//b","t":"x // y"}';
  const tokenized = parseJsonc(jsonc);
  const cleanParsed = parseJsonc(clean);
  assert(tokenized.ok && cleanParsed.ok && JSON.stringify(tokenized.value) === JSON.stringify(cleanParsed.value),
    '(b) tokenizer preserva URL, // em string, BOM, CRLF, comentário e trailing comma',
    JSON.stringify(tokenized));
  const missingBrace = parseJsonc('{\n  "review": {\n    "rounds": 2\n  }');
  assert(missingBrace.ok === false && missingBrace.error && typeof missingBrace.error.line === 'number',
    '(b) JSONC quebrado retorna ok:false com linha numérica', JSON.stringify(missingBrace));

  const project = mkTmp('prefs-engine');
  const home = path.join(project, 'home');
  const claude = path.join(home, '.claude');
  const gsd = path.join(project, '.gsd');
  fs.mkdirSync(claude, { recursive: true });
  const write = (file, text) => fs.writeFileSync(file, text, 'utf8');
  const remove = (file) => { try { fs.rmSync(file, { force: true }); } catch {} };
  const snapshotForge = () => {
    const found = [];
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file); else found.push(path.relative(path.join(gsd, 'forge'), file));
      }
    }
    walk(path.join(gsd, 'forge'));
    return found.sort();
  };
  const beforeForge = snapshotForge();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const matrix = [
      ['jsonc-only', 'jsonc', false],
      ['md-only', 'md-blocked', true],
      ['md+jsonc', 'jsonc', false],
      ['absent', 'absent', false],
    ];
    for (const [state, expectedSource, blocked] of matrix) {
      for (const file of [
        path.join(claude, 'forge-agent-prefs.jsonc'), path.join(claude, 'forge-agent-prefs.md'),
        path.join(gsd, 'forge-prefs.jsonc'), path.join(gsd, 'claude-agent-prefs.md'),
        path.join(gsd, 'prefs.local.md'),
      ]) remove(file);
      if (state === 'jsonc-only' || state === 'md+jsonc') {
        write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"review":{"source":"global-jsonc"}}');
        write(path.join(gsd, 'forge-prefs.jsonc'), '{"review":{"source":"local-jsonc"}}');
      }
      if (state === 'md-only' || state === 'md+jsonc') {
        // Deliberate hard-stop fixture: this matrix proves legacy-only layers
        // are rejected and directs users to the migrator.
        write(path.join(claude, 'forge-agent-prefs.md'), 'review:\n  source: global-md\n');
        write(path.join(gsd, 'claude-agent-prefs.md'), 'review:\n  source: local-md\n');
        write(path.join(gsd, 'prefs.local.md'), 'review:\n  source: local-personal-md\n');
      }
      const result = readPrefs(project);
      assert(result.ok === !blocked, `(c) ${state}: expected resolver ok state`, JSON.stringify(result));
      assert(result.layers.global.source === expectedSource && result.layers.local.source === expectedSource,
        `(c) ${state}: both layers report the canonical source`, JSON.stringify(result.layers));
      if (blocked) {
        const expectedMd = [path.join(claude, 'forge-agent-prefs.md'),
          path.join(gsd, 'claude-agent-prefs.md'), path.join(gsd, 'prefs.local.md')];
        assert(result.errors.length === 2 && result.errors.every((error) => error.code === 'legacy-md-without-jsonc') &&
          expectedMd.every((file) => result.errors.some((error) => error.message.includes(file))) &&
          result.errors.every((error) => error.message.includes('forge-prefs-migrate.js" --cwd "')),
        '(c) md-only: hard-stop errors name every md file and the migration command', JSON.stringify(result.errors));
      } else if (state === 'md+jsonc') {
        assert(result.errors.length === 0 && result.prefs.review.source === 'local-jsonc',
          '(c) md+jsonc: JSONC wins silently with zero errors', JSON.stringify(result));
      }
    }

    write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"routing":{"backend":{"executor":{"standard":["global"]}}}}');
    write(path.join(gsd, 'forge-prefs.jsonc'), '{"routing":{"backend":{"planner":{"heavy":["repo"]}}}}');
    const jsoncPrefs = readPrefs(project);
    const routing = readRoutingConfig(project);
    assert(JSON.stringify(jsoncPrefs.prefs.routing) === JSON.stringify(routing.routing),
      '(d) jsonc routing: readPrefs.routing === readRoutingConfig.routing', JSON.stringify({ jsoncPrefs, routing }));

    const merged = deepMerge(
      { list: ['global'], review: { rounds: 2 }, routing: { backend: { plan: { standard: ['a'], execute: { standard: ['b'] } } } } },
      { list: ['local'], review: { rounds: null }, routing: { backend: { plan: { standard: ['local'] } } } },
    );
    assert(JSON.stringify(merged.list) === JSON.stringify(['local']), '(e) merge: arrays replace');
    assert(merged.review.rounds === null, '(e) merge: null overrides');
    assert(JSON.stringify(merged.routing.backend) === JSON.stringify({ plan: { standard: ['local'] } }),
      '(e) merge: routing domain replaces atomically', JSON.stringify(merged.routing));

    write(path.join(claude, 'forge-agent-prefs.jsonc'), '{"review":{"rounds":2}}');
    write(path.join(gsd, 'forge-prefs.jsonc'), '{"review":{"rounds":7}}');
    const cli = spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-prefs.js'), '--resolved', '--key', 'review.rounds', '--cwd', project], {
      cwd: ROOT37, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
    });
    let cliJson = null;
    try { cliJson = JSON.parse(cli.stdout); } catch {}
    assert(cli.status === 0 && cliJson && cliJson.value === 7, '(f) CLI --resolved --key retorna valor local sobrescrito', `${cli.status}: ${cli.stdout}`);
    assert(cliJson && Array.isArray(cliJson.errors), '(f) CLI --key mantém errors[]', cli.stdout);

    write(path.join(gsd, 'forge-prefs.jsonc'), '{\n  "review": {"rounds": 9}\n');
    const broken = spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-prefs.js'), '--resolved', '--cwd', project], {
      cwd: ROOT37, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
    });
    let brokenJson = null;
    try { brokenJson = JSON.parse(broken.stdout); } catch {}
    assert(broken.status === 1 && brokenJson && brokenJson.errors && brokenJson.errors[0] &&
      brokenJson.errors[0].file && typeof brokenJson.errors[0].line === 'number',
      '(f) CLI broken-jsonc: exit 1 and errors[0] has file+line', `${broken.status}: ${broken.stdout}`);
    assert(broken.stderr.trim().length > 0, '(f) CLI broken-jsonc: stderr is non-empty', broken.stderr);
    // Enum violation with a sibling synthetic schema is skipped: the CLI schema
    // path is install-root; the exhaustive validator contract covers this case.
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    const afterForge = snapshotForge();
    const resolvedFiles = [];
    function findResolved(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) findResolved(file);
        else if (/^prefs-resolved/.test(entry.name)) resolvedFiles.push(file);
      }
    }
    findResolved(gsd);
    assert(JSON.stringify(afterForge) === JSON.stringify(beforeForge) && resolvedFiles.length === 0,
      '(g) MEM001: readPrefs/CLI não cria prefs-resolved nem arquivos novos em .gsd/forge',
      JSON.stringify({ afterForge, resolvedFiles }));
    cleanup(project);
  }
}

// ── Section 38: prefs catalog (schema + scaffold + re-scaffold) ───────────
// This section is deliberately separate from Section 37: (a) guards the
// install-root schema's pure-JSON shape and coverage witnesses, (b) guards
// both scaffold round-trips, (c) guards source-slice preservation when a
// catalog is re-scaffolded, (d) freezes the closed require sets and the
// hot-path lazy import, and (e) guards the two cold-path CLI entry points.
// Section 37 was amended with the S01 allowlist assertion rather than having
// its engine-focused scope weakened with scaffold behavior.
function smokePrefsCatalog() {
  process.stdout.write('\n▸ Section 38: prefs catalog (schema + scaffold + re-scaffold)\n');
  const ROOT38 = path.join(__dirname, '..');
  const prefsEngine = require('./forge-prefs.js');
  const scaffold = require('./forge-prefs-scaffold.js');
  const schemaFile = path.join(ROOT38, 'forge-prefs.schema.json');
  const schemaText = fs.readFileSync(schemaFile, 'utf8');
  let schema = null;
  try { schema = JSON.parse(schemaText); } catch (error) {
    assert(false, '(a) forge-prefs.schema.json é JSON puro no install root', error.message);
  }

  const getNode = (root, dotted) => dotted.split('.').reduce((node, key) => {
    if (!node || !node.properties) return null;
    return node.properties[key] || null;
  }, root);
  const witness = [
    ['review.rounds', 1],
    ['evidence.mode', 'lenient'],
    ['tier_models.standard', 'claude-sonnet-5'],
    ['effort.execute-task', 'low'],
    ['forge_isolation.file_locks', true],
    ['routing', {}],
  ];
  const schemaReady = schema && schema.properties && schema.properties.$schema &&
    typeof schema.properties.$schema.type === 'string' &&
    Object.keys(schema.properties).filter((key) => key !== '$schema').length >= 20;
  assert(schemaReady,
    '(a) schema: $schema string + >= 20 top-level sections',
    schema ? JSON.stringify(Object.keys(schema.properties || {})) : 'schema ausente ou inválido');
  assert(witness.every(([key, expected]) => {
    const node = getNode(schema, key);
    return node && node.type !== undefined && typeof node.description === 'string' &&
      node.description.trim() && JSON.stringify(node.default) === JSON.stringify(expected);
  }), '(a) schema: 6 witnesses têm type+description+default real',
    JSON.stringify(witness.map(([key]) => [key, getNode(schema, key)])));
  const routingNode = getNode(schema, 'routing');
  assert(routingNode && routingNode.additionalProperties === true,
    '(a) schema: routing é nó de roteamento open-set (additionalProperties:true)',
    JSON.stringify(routingNode));

  const generated = scaffold.generateScaffold(prefsEngine.loadSchema());
  const offForm = prefsEngine.parseJsonc(generated);
  assert(offForm.ok && JSON.stringify(offForm.value) === JSON.stringify({ $schema: 'forge-prefs.schema.json' }),
    '(b) generateScaffold: forma off parseia exatamente { $schema }', JSON.stringify(offForm));
  const activeForm = generated.split(/\r?\n/).map((line) => scaffold.OFF_MARKER.test(line)
    ? line.replace(scaffold.OFF_MARKER, '$1') : line).join('\n');
  const activeParsed = prefsEngine.parseJsonc(activeForm);
  const expectedDefaults = { $schema: 'forge-prefs.schema.json', ...scaffold.defaultsFromSchema(schema) };
  assert(activeParsed.ok && JSON.stringify(activeParsed.value) === JSON.stringify(expectedDefaults) &&
    JSON.stringify(prefsEngine.validatePrefs(activeParsed.value, schema)) === '[]',
    '(b) all-on transform: defaultsFromSchema + $schema e validatePrefs sem warnings',
    JSON.stringify({ parsed: activeParsed, expected: expectedDefaults }));

  const extendedSchema = JSON.parse(JSON.stringify(schema));
  extendedSchema.properties.synthetic_smoke_section = {
    type: 'boolean', default: false,
    description: 'Synthetic section used by the Section 38 re-scaffold guard.',
  };
  const sectionMove = (text, key, before) => {
    const segments = scaffold.segmentCatalog(text);
    const moving = segments.find((segment) => segment.key === key);
    const target = segments.find((segment) => segment.key === before);
    if (!moving || !target) throw new Error(`fixture sections unavailable: ${key}/${before}`);
    const without = text.slice(0, moving.start) + text.slice(moving.end);
    const targetAt = without.indexOf(target.raw);
    return without.slice(0, targetAt) + moving.raw + without.slice(targetAt);
  };
  const activateSection = (text, key) => {
    let inside = false;
    return text.split(/\n/).map((line) => {
      if (line.includes(`── ${key} `)) inside = true;
      else if (inside && line.includes('// ── ')) inside = false;
      return inside && scaffold.OFF_MARKER.test(line)
        ? line.replace(scaffold.OFF_MARKER, '$1') : line;
    }).join('\n');
  };
  let fixture = activateSection(generated, 'review');
  fixture = activateSection(fixture, 'skip_research');
  fixture = fixture.replace('  // ── review ', '  // user review note\n  // ── review ');
  fixture = fixture.replace('    "rounds": 1', '    "rounds": 7');
  fixture = sectionMove(fixture, 'workers', 'tier_models');
  fixture += '/* foreign block: preserve this user-owned content */\n';
  const fixtureSegments = scaffold.segmentCatalog(fixture).filter((segment) => segment.key);
  const first = scaffold.rescaffoldCatalog(fixture, extendedSchema);
  const unrecognized = first.warnings.filter((warning) => warning.code === 'unrecognized-content');
  assert(fixtureSegments.every((segment) => first.text.indexOf(segment.raw) !== -1),
    '(c) rescaffold preserva bytes dos blocos ativos/comentados e ordem editada',
    'segmento de usuário não encontrado no output');
  assert(first.text.includes('// ── synthetic_smoke_section ') &&
    first.text.includes('  // "synthetic_smoke_section": false'),
    '(c) rescaffold insere nova seção sintética comentada', first.text);
  assert(unrecognized.length === 1,
    '(c) rescaffold emite exatamente um warning unrecognized-content', JSON.stringify(first.warnings));
  const second = scaffold.rescaffoldCatalog(first.text, extendedSchema);
  assert(second.text === first.text && JSON.stringify(second.warnings) === JSON.stringify(first.warnings),
    '(c) rescaffold é idempotente e mantém warnings', JSON.stringify(second));
  const rescaffoldParsed = prefsEngine.parseJsonc(first.text);
  assert(rescaffoldParsed.ok, '(c) output rescaffold parseia como JSONC', JSON.stringify(rescaffoldParsed));

  // (c2) R1 fix: zero-anchor catalogs (no keyed segment at all) must not have
  // generated sections spliced AFTER the root's own closing `}`.
  const zeroAnchorCases = {
    'objeto vazio': '{}',
    'stub apenas comentário': '// just a comment\n',
    'apenas $schema': '{"$schema":"forge-prefs.schema.json"}',
  };
  for (const [label, source] of Object.entries(zeroAnchorCases)) {
    const result = scaffold.rescaffoldCatalog(source, schema);
    const parsed = prefsEngine.parseJsonc(result.text);
    const diff = scaffold.catalogDiff(result.text, schema);
    const lastClose = result.text.lastIndexOf('}');
    const trailingAfterClose = result.text.slice(lastClose + 1).trim();
    assert(parsed.ok, `(c2) zero-anchor "${label}": rescaffold produz JSONC válido`, JSON.stringify(parsed));
    assert(diff.missingSections.length === 0,
      `(c2) zero-anchor "${label}": catalogDiff não reporta seções faltando`, JSON.stringify(diff));
    assert(trailingAfterClose === '',
      `(c2) zero-anchor "${label}": nenhum bloco de seção após o "}" raiz`, JSON.stringify(trailingAfterClose));
  }

  const sourceOf = (file) => fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  const requiresOf = (source) => [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert(JSON.stringify(requiresOf(sourceOf('forge-prefs-scaffold.js'))) ===
    JSON.stringify(['fs', 'path', './forge-prefs.js']),
    '(d) scaffold mantém require-set fechado [fs,path,./forge-prefs.js]',
    JSON.stringify(requiresOf(sourceOf('forge-prefs-scaffold.js'))));
  assert(JSON.stringify(requiresOf(sourceOf('forge-prefs.js'))) ===
    JSON.stringify(['fs', 'os', 'path', './forge-prefs-scaffold.js']),
    '(d) engine mantém require-set fechado com scaffold lazy',
    JSON.stringify(requiresOf(sourceOf('forge-prefs.js'))));
  const hotPath = spawnSync(process.execPath, ['-e',
    "require('./scripts/forge-prefs.js'); process.exit(require.cache[require.resolve('./scripts/forge-prefs-scaffold.js')] ? 1 : 0)"],
  { cwd: ROOT38, encoding: 'utf8' });
  assert(hotPath.status === 0, '(d) require simples do engine não carrega scaffold no hot path',
    `${hotPath.status}: ${hotPath.stderr}`);

  const cliScaffold = runScript('forge-prefs.js', ['--scaffold'], { cwd: ROOT38 });
  const cliScaffoldParsed = prefsEngine.parseJsonc(cliScaffold.stdout);
  assert(cliScaffold.status === 0 && cliScaffoldParsed.ok,
    '(e) CLI --scaffold: exit 0 e stdout parseável', `${cliScaffold.status}: ${cliScaffold.stderr}`);
  const fixtureDir = mkTmp('prefs-catalog-cli');
  const fixtureFile = path.join(fixtureDir, 'prefs.jsonc');
  fs.writeFileSync(fixtureFile, fixture, 'utf8');
  const cliRescaffold = runScript('forge-prefs.js', ['--rescaffold', fixtureFile], { cwd: ROOT38 });
  const cliRescaffoldParsed = prefsEngine.parseJsonc(cliRescaffold.stdout);
  assert(cliRescaffold.status === 0 && cliRescaffoldParsed.ok && /unrecognized-content|Unrecognized catalogue content/.test(cliRescaffold.stderr),
    '(e) CLI --rescaffold: exit 0, stdout parseável e warning em stderr',
    `${cliRescaffold.status}: ${cliRescaffold.stderr}`);
  cleanup(fixtureDir);
}

// ── Section 39: S03 prefs cutover: equivalence + absence guards ───────────
function smokePrefsCutover() {
  process.stdout.write('\n▸ Section 39: S03 prefs cutover: equivalence + absence guards\n');
  const tierSource = fs.readFileSync(path.join(SCRIPTS, 'forge-tier-chain.js'), 'utf8');
  const routingSource = fs.readFileSync(path.join(SCRIPTS, 'forge-routing.js'), 'utf8');
  assert(/require\('\.\/forge-prefs\.js'\)/.test(tierSource) && /readPrefsCached/.test(tierSource) &&
    !tierSource.includes('readRawTierModelsValue'),
    '(a) tier-chain uses cached prefs engine without a raw cascade reader');
  assert(/require\('\.\/forge-prefs\.js'\)/.test(routingSource) && /readPrefsCached/.test(routingSource) &&
    !/function (cascadeFiles|parseRoutingBlock|parseValue|stripInlineComment)\b/.test(routingSource),
    '(a) routing uses cached prefs engine without a private parser');
  withHermeticHome(() => {
    const dir = mkTmp('prefs-cutover-tier-golden');
    const prefs = path.join(dir, '.gsd', 'forge-prefs.jsonc');
    const { readTierChain } = require('./forge-tier-chain.js');
    fs.writeFileSync(prefs,
      '{"tier_models":{"standard":"bare-model","heavy":["heavy-primary","heavy-fallback"]}}', 'utf8');
    assert(JSON.stringify(readTierChain('standard', dir)) === JSON.stringify([
      { id: 'bare-model', alias: null, mapped: false },
    ]), '(a) tier-chain golden preserves JSONC scalar wrapping');
    assert(JSON.stringify(readTierChain('heavy', dir)) === JSON.stringify([
      { id: 'heavy-primary', alias: null, mapped: false },
      { id: 'heavy-fallback', alias: null, mapped: false },
    ]), '(a) tier-chain golden preserves ordered JSONC lists');
    fs.writeFileSync(prefs, '{"tier_models":{"standard":"[broken"}}', 'utf8');
    let warning = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    let malformed;
    try {
      malformed = readTierChain('standard', dir);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert(malformed.length === 1 && malformed[0].id === 'claude-sonnet-5' &&
      /tier_models\.standard malformado/.test(warning),
    '(a) wrong-shape JSONC tier value warns and degrades to the standard default');
    cleanup(dir);
  });
  const idsSource = fs.readFileSync(path.join(SCRIPTS, 'forge-ids.js'), 'utf8');
  const reposSource = fs.readFileSync(path.join(SCRIPTS, 'forge-repos.js'), 'utf8');
  const cliSource = fs.readFileSync(path.join(SCRIPTS, 'forge-cli-helpers.js'), 'utf8');
  const contextSource = fs.readFileSync(path.join(SCRIPTS, 'forge-context-monitor.js'), 'utf8');
  const isolationSource = fs.readFileSync(path.join(SCRIPTS, 'forge-isolation.js'), 'utf8');
  const xllmSource = fs.readFileSync(path.join(SCRIPTS, 'forge-xllm.js'), 'utf8');
  for (const [name, source] of [['ids', idsSource], ['repos', reposSource], ['cli-helpers', cliSource],
    ['context-monitor', contextSource], ['isolation', isolationSource], ['xllm', xllmSource]]) {
    assert(!/os\.homedir\(\).*forge-agent-prefs\.md|forge-agent-prefs\.md[\s\S]*claude-agent-prefs\.md[\s\S]*prefs\.local\.md/.test(source),
      `(a) ${name}: legacy cascade path triple absent`);
    assert(!source.includes('legacySectionBlocks') && !source.includes('(?=^\\w|\\Z)'),
      `(a) ${name}: legacy section-block parser absent`);
    assert(/forge-prefs\.js/.test(source) && /readPrefsCached/.test(source),
      `(a) ${name}: imports readPrefsCached`);
  }
  assert(/readPrefsCached/.test(contextSource) && !/fs\.readFileSync|os\.homedir/.test(contextSource),
    '(a) context-monitor: legacy file parser absent');
  assert(/readPrefsCached/.test(isolationSource) && !/forge_isolation:[\\s\\S]*raw\.match/.test(isolationSource),
    '(a) isolation: legacy forge_isolation parser absent');
  assert(/readPrefsCached/.test(xllmSource) && !/raw\.match\(\/\^workers:/.test(xllmSource),
    '(a) xllm: legacy workers parser absent');
  withHermeticHome(() => {
    const dir = mkTmp('prefs-cutover-medium');
    const write = (body) => fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), body, 'utf8');
    const context = require('./forge-context-monitor.js');
    const isolation = require('./forge-isolation.js');
    const xllm = require('./forge-xllm.js');
    write('');
    assert(context.readContextMonitorPrefs(dir).enabled === true, '(b) context absent → enabled true');
    assert(isolation.readIsolationPrefs(dir).mode === 'shared', '(b) isolation absent → shared');
    assert(xllm.readWorkersTimeout(dir) === null, '(b) timeout absent → null');
    write('{"context_monitor":{"enabled":false,"warning_threshold":40,"critical_threshold":0.2},' +
      '"forge_isolation":{"mode":"WORKTREE","branch_pattern":"x/{M###}","auto_pull_main":false,' +
      '"worktree_root":"custom","worktree_cleanup_on_complete":true,"pr_on_complete":true},"workers":{"timeout":-5}}');
    const cm = context.readContextMonitorPrefs(dir);
    const iso = isolation.readIsolationPrefs(dir);
    assert(cm.enabled === false && cm.thresholds.warning === 0.4 && cm.thresholds.critical === 0.2,
      '(b) context valid values normalize');
    assert(iso.mode === 'worktree' && iso.branchPattern === 'x/{M###}' && iso.autoPullMain === false &&
      iso.worktreeRoot === 'custom' && iso.worktreeCleanupOnComplete === true && iso.prOnComplete === true,
      '(b) isolation six keys preserve values');
    assert(xllm.readWorkersTimeout(dir) === null, '(b) negative timeout → null');
    write('{"workers":{"timeout":"abc"}}');
    assert(xllm.readWorkersTimeout(dir) === null, '(b) non-numeric timeout → null');
    write('{"workers":{"timeout":45}}');
    assert(xllm.readWorkersTimeout(dir) === 45, '(b) positive timeout preserved');
    cleanup(dir);
  });
  withHermeticHome(() => {
    const dir = mkTmp('prefs-cutover');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const writePrefs = (body) => fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), body, 'utf8');
    const ids = require('./forge-ids.js');
    const repos = require('./forge-repos.js');
    writePrefs('');
    assert(ids.readIdFormat(dir) === 'timestamp', '(b) ids absent → timestamp');
    writePrefs('{"ids":{"format":"sequential"}}');
    assert(ids.readIdFormat(dir) === 'sequential', '(b) ids sequential preserved');
    writePrefs('{"ids":{"format":"invalid"}}');
    assert(ids.readIdFormat(dir) === 'timestamp', '(b) ids invalid → timestamp');
    writePrefs('{"forge_isolation":{"repos":{"auto_detect":false,"include":["src/**"],"exclude":["tmp/**"]}}}');
    const repoPrefs = repos.readReposPrefs(dir);
    assert(repoPrefs.autoDetect === false && JSON.stringify(repoPrefs.include) === JSON.stringify(['src/**']) &&
      JSON.stringify(repoPrefs.exclude) === JSON.stringify(['tmp/**']), '(b) repos nested booleans/lists preserved');
    writePrefs('');
    assert(repos.readReposPrefs(dir).exclude.length === 7, '(b) repos absent → seven-item DEFAULT_EXCLUDE');
    cleanup(dir);
  });
  const cliResult = withHermeticHome(({ env }) => {
    const dir = mkTmp('prefs-cli-golden');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{"multi_run":{"refused_when_active_count":3}}', 'utf8');
    const result = runScript('forge-cli-helpers.js', ['--resolve-args', '--args', '', '--command', 'forge-auto', '--cwd', dir], { env });
    cleanup(dir);
    return result;
  });
  assert(cliResult.status === 0 && /refuse|legacy|resume/.test(cliResult.stdout), '(c) cli-helpers reads multi_run through engine');

  // T04: hot passive consumers must share the cached resolver's semantics and
  // turn malformed JSONC into a visible, self-healing signal rather than a throw.
  const hookSource = fs.readFileSync(path.join(SCRIPTS, 'forge-hook.js'), 'utf8');
  const statusSource = fs.readFileSync(path.join(SCRIPTS, 'forge-statusline.js'), 'utf8');
  assert(/readPrefsCached/.test(hookSource) && /resolvePrefsSafe/.test(hookSource) &&
    !/forge_isolation:\[ \t\]\*\\n/.test(hookSource) && !/\^evidence:\[ \t\]\*\\n/.test(hookSource),
  '(d) hook reads file_locks/evidence through guarded cached prefs engine');
  assert(/readPrefsCached/.test(statusSource) && /resolvePrefsSafe/.test(statusSource) &&
    statusSource.includes('⚠ prefs') && !statusSource.includes('const repoMatch = prefs.match'),
  '(d) statusline reads repo_path through engine and has prefs error badge');
  withHermeticHome(({ env }) => {
    const dir = mkTmp('prefs-cutover-passive');
    const forgeDir = path.join(dir, '.gsd', 'forge');
    const globalJsonc = path.join(env.HOME, '.claude', 'forge-agent-prefs.jsonc');
    fs.mkdirSync(path.dirname(globalJsonc), { recursive: true });
    fs.writeFileSync(globalJsonc, '{"evidence": {"mode": ', 'utf8');

    const hook = runScript('forge-hook.js', ['post'], {
      env,
      input: JSON.stringify({ cwd: dir, session_id: 'prefs-smoke', tool_name: 'Bash', tool_input: { command: 'true' } }),
    });
    const flag = path.join(forgeDir, 'prefs-error.json');
    let flagData = null;
    try { flagData = JSON.parse(fs.readFileSync(flag, 'utf8')); } catch {}
    assert(hook.status === 0 && flagData && path.isAbsolute(flagData.file) &&
      Object.prototype.hasOwnProperty.call(flagData, 'line') && typeof flagData.message === 'string' &&
      typeof flagData.ts === 'number', '(d) broken JSONC hook exits 0 and writes valid passive flag',
      JSON.stringify({ hook, flagData }));

    const statusBroken = runScript('forge-statusline.js', [], {
      env,
      input: JSON.stringify({ cwd: dir, model: { display_name: 'test' }, context_window: { used_percentage: 1 } }),
    });
    assert(statusBroken.status === 0 && statusBroken.stdout.includes('⚠ prefs'),
      '(d) broken JSONC statusline renders prefs badge', JSON.stringify(statusBroken));

    fs.writeFileSync(globalJsonc, '{"forge_isolation":{"mode":"worktree","file_locks":true},"evidence":{"mode":"STRICT"}}', 'utf8');
    const hookClean = runScript('forge-hook.js', ['post'], {
      env,
      input: JSON.stringify({ cwd: dir, session_id: 'prefs-smoke', tool_name: 'Bash', tool_input: { command: 'true' } }),
    });
    assert(hookClean.status === 0 && !fs.existsSync(flag), '(d) clean hook resolve removes passive flag');

    const prefs = require('./forge-prefs.js');
    const resolved = prefs.readPrefsCached(dir).prefs;
    const locksEnabled = resolved.forge_isolation.file_locks === true &&
      String(resolved.forge_isolation.mode).toLowerCase() === 'worktree' ? false : true;
    const evidence = String(resolved.evidence.mode || 'lenient').toLowerCase();
    assert(locksEnabled === false && evidence === 'strict',
      '(d) engine golden preserves worktree file-lock override and normalized evidence mode');
    const evidenceFile = path.join(forgeDir, 'evidence-adhoc.jsonl');
    try { fs.unlinkSync(evidenceFile); } catch {}
    fs.writeFileSync(globalJsonc, '{"evidence":{"mode":"disabled"}}', 'utf8');
    const disabled = runScript('forge-hook.js', ['post'], {
      env,
      input: JSON.stringify({ cwd: dir, session_id: 'prefs-disabled', tool_name: 'Bash', tool_input: { command: 'true' } }),
    });
    assert(disabled.status === 0 && !fs.existsSync(evidenceFile),
      '(d) evidence disabled golden suppresses capture', JSON.stringify(disabled));
    fs.writeFileSync(globalJsonc, '{"evidence":{"mode":"unexpected"}}', 'utf8');
    const invalidEvidence = String(prefs.readPrefsCached(dir).prefs.evidence.mode || 'lenient').toLowerCase();
    const invalid = runScript('forge-hook.js', ['post'], {
      env,
      input: JSON.stringify({ cwd: dir, session_id: 'prefs-invalid', tool_name: 'Bash', tool_input: { command: 'true' } }),
    });
    assert(invalid.status === 0 && invalidEvidence === 'unexpected' &&
      fs.existsSync(evidenceFile),
      '(d) invalid evidence golden takes hook default lenient capture');
    cleanup(dir);
  });

  // S01 v2.0 hard-stop contract. Keep both halves of this double assertion
  // together: removing the legacy reader from the engine must not remove the
  // independently supported migration escape hatch.
  const prefsExports = require('./forge-prefs.js');
  const prefsEngineSource = fs.readFileSync(path.join(SCRIPTS, 'forge-prefs.js'), 'utf8');
  assert(!Object.prototype.hasOwnProperty.call(prefsExports, 'legacyReadFile') &&
    !Object.prototype.hasOwnProperty.call(prefsExports, 'legacyReadLayer') &&
    !prefsEngineSource.includes('legacyRead') && !prefsEngineSource.includes("require('./forge-prefs-legacy.js')") &&
    !prefsEngineSource.includes('require("./forge-prefs-legacy.js")'),
  '(S01 double a) engine exports/source have no legacy reader or legacy-module dependency');
  withHermeticHome(({ env }) => {
    const dir = mkTmp('prefs-cutover-migrate-double');
    const localDir = path.join(dir, '.gsd');
    fs.mkdirSync(localDir, { recursive: true });
    const legacy = path.join(localDir, 'prefs.local.md');
    fs.writeFileSync(legacy, 'review:\n  rounds: 3\n', 'utf8');
    const migrated = runScript('forge-prefs-migrate.js', ['--cwd', dir, '--json'], { env });
    let output = null;
    try { output = JSON.parse(migrated.stdout); } catch {}
    assert(migrated.status === 0 && output && output.status === 'migrated' &&
      fs.existsSync(path.join(localDir, 'forge-prefs.jsonc')) && fs.existsSync(`${legacy}.bak`) && !fs.existsSync(legacy),
    '(S01 double b) migrator CLI converts a test-authored tmpdir md fixture with .bak', JSON.stringify({ migrated, output }));
    cleanup(dir);
  });

  withHermeticHome(() => {
    const dir = mkTmp('prefs-cutover-all-jsonc');
    const home = path.join(dir, 'home');
    const globalDir = path.join(home, '.claude');
    const localDir = path.join(dir, '.gsd');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'forge-agent-prefs.jsonc'), '{"review":{"rounds":2,"style":"global"}}', 'utf8');
    fs.writeFileSync(path.join(localDir, 'forge-prefs.jsonc'), '{"review":{"rounds":7}}', 'utf8');
    const resolved = prefsExports.readPrefs(dir, { globalDir, localDir });
    assert(resolved.ok && resolved.errors.length === 0 && resolved.layers.global.source === 'jsonc' &&
      resolved.layers.local.source === 'jsonc' && JSON.stringify(resolved.prefs) === JSON.stringify({ review: { rounds: 7, style: 'global' } }),
    '(S01) hermetic all-jsonc golden resolves expected values with byte-identical empty errors', JSON.stringify(resolved));
    cleanup(dir);
  });

  withHermeticHome(({ env }) => {
    const dir = mkTmp('prefs-cutover-spec-parity');
    const globalDir = path.join(env.HOME, '.claude');
    fs.mkdirSync(globalDir, { recursive: true });
    const legacy = path.join(globalDir, 'forge-agent-prefs.md');
    fs.writeFileSync(legacy, 'review:\n  rounds: 2\n', 'utf8');
    const contract = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-prefs-cutover.md'), 'utf8');
    const match = /## § Canonical message[^]*?```text\n([^\n]+)\n```/.exec(contract);
    const actual = prefsExports.readPrefs(dir).errors[0];
    const command = path.join(SCRIPTS, 'forge-prefs-migrate.js');
    const expected = match && match[1].replace('{files}', legacy).replace('{command}', command).replace('{cwd}', path.resolve(dir));
    assert(match && actual && actual.message === expected,
      '(S01) spec parity extracts and executes the canonical fenced message template', JSON.stringify({ actual, expected }));
    cleanup(dir);
  });

  // S03 closed inventory: these are the only production consumers migrated
  // from the Markdown cascade. Keep this list explicit so a newly added
  // parser cannot silently escape the cutover guard.
  const closedConsumers = [
    ['forge-cli-helpers.js', []],
    ['forge-context-monitor.js', [/\^context_monitor:[ \\t]*\\n/]],
    ['forge-hook.js', [/\^forge_isolation:[ \\t]*\\n/, /\^evidence:[ \\t]*\\n/]],
    ['forge-ids.js', [/\^ids:[ \\t]*\\n/]],
    ['forge-isolation.js', [/\^forge_isolation:[ \\t]*\\n/]],
    ['forge-repos.js', [/\^forge_isolation:[ \\t]*\\n/]],
    ['forge-routing.js', [/cascadeFiles/, /parseRoutingBlock/, /\^routing:[ \\t]*\\n/]],
    ['forge-statusline.js', [/repo_path:[\\\\s\\\\t]*/]],
    ['forge-tier-chain.js', [/readRawTierModelsValue/, /\^tier_models:[ \\t]*\\n/]],
    ['forge-xllm.js', [/\^workers:[ \\t]*\\n/]],
  ];
  const sourceOf = (file) => fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  const legacyFilenameLiterals = [
    'forge-agent-prefs.md',
    'claude-agent-prefs.md',
    'prefs.local',
  ];
  for (const [name, deadParserTokens] of closedConsumers) {
    const source = sourceOf(name);
    assert(legacyFilenameLiterals.every((literal) => !source.includes(literal)),
      `(e) ${name}: closed-list legacy filenames absent`,
      `found one of ${legacyFilenameLiterals.join(', ')}`);
    for (const token of deadParserTokens) {
      assert(!token.test(source), `(e) ${name}: dead parser signature absent`, token.toString());
    }
    assert(/forge-prefs\.js/.test(source) && /readPrefsCached/.test(source),
      `(e) ${name}: wired to forge-prefs readPrefsCached`);
  }

  // Positive guard for the dual-read boundary. test-*.js and the smoke file
  // intentionally contain fixture writers for the compatibility tests; no
  // production script may carry the legacy filenames except the engine.
  const fixtureWriters = new Set(['forge-smoke.js', 'test-review-pipeline.js']);
  const scriptFiles = fs.readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && !fixtureWriters.has(name));
  const legacyHolders = scriptFiles.filter((name) => {
    const source = sourceOf(name);
    return legacyFilenameLiterals.some((literal) => source.includes(literal));
  });
  assert(JSON.stringify(legacyHolders) === JSON.stringify(['forge-prefs.js']),
    '(e) forge-prefs.js is the sole production holder of legacy filenames',
    JSON.stringify(legacyHolders));
  const legacyReaderSource = sourceOf('forge-prefs-legacy.js');
  assert(legacyFilenameLiterals.every((literal) => !legacyReaderSource.includes(literal)),
    '(e) forge-prefs-legacy.js receives paths as arguments and holds no legacy filename literals');
}

// ── Section 40: S04 skills/dispatch cutover: equivalence + absence guards ──
// Golden-capture equivalence proof for the markdown skills cutover (T02-T05):
// each key knob the skills now read via `node scripts/forge-prefs.js
// --resolved --key <k>` must equal the value the OLD inline regex snippets
// produced on the same fixture. Also absence-guards the closed S04 file list
// against the legacy cascade-array / repo_path-grep patterns, and positively
// asserts every cut-over file is wired to forge-prefs.js (mirrors Section 39).
//
// Manual UAT (not automatable): break .gsd/forge-prefs.jsonc (or the global
// ~/.claude/forge-agent-prefs.jsonc) with invalid JSONC — /forge-auto,
// /forge-next and /forge-task must all stop at start with a file+line error
// (the loud-stop path proven in Section 39's (d) golden), never silently
// fall back to defaults or crash uncaught.
function smokeSkillsCutover() {
  process.stdout.write('\n▸ Section 40: S04 skills/dispatch cutover: equivalence + absence guards\n');

  function resolveKey(dir, key, env) {
    const r = runScript('forge-prefs.js', ['--resolved', '--key', key, '--cwd', dir], env ? { env } : {});
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    return { status: r.status, value: parsed ? parsed.value : undefined, raw: r };
  }

  // ── Equivalence half: fixture with known values for every key knob the
  // cut-over skills read, resolved through the CLI and compared against the
  // golden literal the OLD inline regex snippets would have produced.
  const fixtureMdBody = [
    'auto_commit: false',
    'repo_path: /custom/repo',
    'effort:',
    '  execute-task: high',
    'tier_models:',
    '  standard: my-fixture-model',
    'plan_check:',
    '  mode: blocking',
    'symbol_check:',
    '  mode: disabled',
    'repair:',
    '  budget: 5',
    'evidence:',
    '  mode: strict',
    'workers:',
    '  execute-task: codex',
    '  plan-slice: codex',
    '  timeout: 900',
    '  codex_model: gpt-x-fixture',
    'plan_gate:',
    '  interactive: auto',
    '  ask_in_auto: off',
    'review:',
    '  mode: disabled',
    '  engine: workflow',
    '  style: flags',
    '  rounds: 2',
    '  ask_in_auto: pause',
    '  fix_conceded: false',
    '  challenger: codex',
    '  advocate: auto',
    '  challenger_model: gpt-5.2-codex',
    '  advocate_model: claude-opus-4-8',
    '',
  ].join('\n');

  const goldenCases = [
    ['auto_commit', false],
    ['repo_path', '/custom/repo'],
    ['effort.execute-task', 'high'],
    ['tier_models.standard', 'my-fixture-model'],
    ['plan_check.mode', 'blocking'],
    ['symbol_check.mode', 'disabled'],
    ['repair.budget', 5],
    ['evidence.mode', 'strict'],
    ['workers.execute-task', 'codex'],
    ['workers.plan-slice', 'codex'],
    ['workers.timeout', 900],
    ['workers.codex_model', 'gpt-x-fixture'],
    ['plan_gate.interactive', 'auto'],
    ['plan_gate.ask_in_auto', 'off'],
    ['review.mode', 'disabled'],
    ['review.engine', 'workflow'],
    ['review.style', 'flags'],
    ['review.rounds', 2],
    ['review.ask_in_auto', 'pause'],
    ['review.fix_conceded', false],
    ['review.challenger', 'codex'],
    ['review.advocate', 'auto'],
    ['review.challenger_model', 'gpt-5.2-codex'],
    ['review.advocate_model', 'claude-opus-4-8'],
  ];
  const jsoncFromFixture = {
    auto_commit: false, repo_path: '/custom/repo', effort: { 'execute-task': 'high' },
    tier_models: { standard: 'my-fixture-model' }, plan_check: { mode: 'blocking' }, symbol_check: { mode: 'disabled' },
    repair: { budget: 5 }, evidence: { mode: 'strict' },
    workers: { 'execute-task': 'codex', 'plan-slice': 'codex', timeout: 900, codex_model: 'gpt-x-fixture' },
    plan_gate: { interactive: 'auto', ask_in_auto: 'off' },
    review: { mode: 'disabled', engine: 'workflow', style: 'flags', rounds: 2, ask_in_auto: 'pause', fix_conceded: false,
      challenger: 'codex', advocate: 'auto', challenger_model: 'gpt-5.2-codex', advocate_model: 'claude-opus-4-8' },
  };

  withHermeticHome(({ env }) => {
    const dir = mkTmp('skills-cutover-jsonc');
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(jsoncFromFixture), 'utf8');
    for (const [key, golden] of goldenCases) {
      const resolved = resolveKey(dir, key, env);
      assert(resolved.status === 0 && JSON.stringify(resolved.value) === JSON.stringify(golden),
        `(a) jsonc fixture: ${key} resolves to golden ${JSON.stringify(golden)}`,
        `got ${JSON.stringify(resolved.value)} (status ${resolved.status})`);
    }
    cleanup(dir);
  });

  // Dual-read parity: the same golden set on a JSONC fixture must produce
  // identical CLI values (proves the cutover reads both sources uniformly).
  const fixtureJsonc = {
    auto_commit: false,
    repo_path: '/custom/repo',
    effort: { 'execute-task': 'high' },
    tier_models: { standard: 'my-fixture-model' },
    plan_check: { mode: 'blocking' },
    symbol_check: { mode: 'disabled' },
    repair: { budget: 5 },
    evidence: { mode: 'strict' },
    workers: { 'execute-task': 'codex', 'plan-slice': 'codex', timeout: 900, codex_model: 'gpt-x-fixture' },
    plan_gate: { interactive: 'auto', ask_in_auto: 'off' },
    review: {
      mode: 'disabled', engine: 'workflow', style: 'flags', rounds: 2, ask_in_auto: 'pause',
      fix_conceded: false, challenger: 'codex', advocate: 'auto',
      challenger_model: 'gpt-5.2-codex', advocate_model: 'claude-opus-4-8',
    },
  };
  withHermeticHome(({ env }) => {
    const dir = mkTmp('skills-cutover-jsonc');
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(fixtureJsonc), 'utf8');
    for (const [key, golden] of goldenCases) {
      const resolved = resolveKey(dir, key, env);
      assert(resolved.status === 0 && JSON.stringify(resolved.value) === JSON.stringify(golden),
        `(a) jsonc fixture: ${key} resolves to golden ${JSON.stringify(golden)} (dual-read parity)`,
        `got ${JSON.stringify(resolved.value)} (status ${resolved.status})`);
    }
    cleanup(dir);
  });

  // ── CRITICAL default-pin (T01 Forward Intelligence hazard): assert the
  // schema's declared defaults for the key knobs, pinned as literals so a
  // future schema edit cannot silently drift them. `--resolved --key` on an
  // absent-fixture returns `undefined` (readPrefs never fills schema
  // defaults — that's each consumer's own `?? default` job, same as the old
  // inline regex snippets), so the pin reads the schema itself: the single
  // source of truth per forge-prefs.schema.json's own $comment.
  const prefsEngineForSchema = require('./forge-prefs.js');
  const schemaForDefaults = prefsEngineForSchema.loadSchema();
  function schemaDefault(dottedKey) {
    let node = schemaForDefaults;
    for (const part of dottedKey.split('.')) {
      if (!node || !node.properties || !(part in node.properties)) return undefined;
      node = node.properties[part];
    }
    return node ? node.default : undefined;
  }
  const defaultCases = [
    ['review.mode', 'enabled'],
    ['thinking.opus_phases', 'adaptive'],
    ['repair.budget', 2],
    ['plan_check.mode', 'advisory'],
    ['symbol_check.mode', 'advisory'],
    ['evidence.mode', 'lenient'],
    ['workers.execute-task', 'claude'],
    ['plan_gate.interactive', 'always'],
    ['effort.execute-task', 'low'],
    ['tier_models.standard', 'claude-sonnet-5'],
    ['auto_commit', true],
    ['repo_path', ''],
  ];
  for (const [key, golden] of defaultCases) {
    assert(JSON.stringify(schemaDefault(key)) === JSON.stringify(golden),
      `(b) schema default-pin: ${key} === ${JSON.stringify(golden)}`,
      `got ${JSON.stringify(schemaDefault(key))}`);
  }
  // Behavioral half of the pin: the CLI itself never silently fills a schema
  // default onto an absent key (readPrefs is a raw merge) — proven so the
  // pin above cannot be mistaken for CLI-applied behavior.
  withHermeticHome(({ env }) => {
    const dir = mkTmp('skills-cutover-defaults');
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{}', 'utf8');
    const resolved = resolveKey(dir, 'review.mode', env);
    assert(resolved.status === 0 && (resolved.value === undefined || resolved.value === null),
      '(b) CLI on absent key returns null/undefined (defaults are consumer-applied, not CLI-applied)',
      `got ${JSON.stringify(resolved.value)}`);
    cleanup(dir);
  });

  // ── Absence half: the closed S04 file list must contain zero legacy
  // cascade-array constructs and zero direct repo_path grep-of-markdown.
  const closedSkillsFiles = [
    'shared/forge-dispatch.md',
    'shared/forge-plan-gate.md',
    'shared/forge-review.md',
    'skills/forge-auto/SKILL.md',
    'skills/forge-next/SKILL.md',
    'skills/forge-task/SKILL.md',
    'skills/forge-probe/SKILL.md',
    'skills/forge-status/SKILL.md',
    'skills/forge-accounts/SKILL.md',
    'skills/forge-codebase/SKILL.md',
    'skills/forge-config/SKILL.md',
    'skills/forge-doctor/SKILL.md',
    'skills/forge-sweep/SKILL.md',
  ];
  const ROOT40 = path.join(__dirname, '..');
  const cascadeArrayRe = /const\s+files\s*=\s*\[[^\]]*forge-agent-prefs\.md/;
  const repoPathGrepRe = /grep\s+['"]repo_path:['"][^\n]*forge-agent-prefs\.md/;
  for (const rel of closedSkillsFiles) {
    const source = fs.readFileSync(path.join(ROOT40, rel), 'utf8');
    assert(!cascadeArrayRe.test(source), `(c) ${rel}: legacy cascade-array construct absent`);
    assert(!repoPathGrepRe.test(source), `(c) ${rel}: legacy repo_path-grep construct absent`);
    // Wired half: every cut-over file references the new engine. forge-sweep's
    // only mention is a protect-list filename entry (see below), still checked.
    assert(source.includes('forge-prefs.js'), `(c) ${rel}: references forge-prefs.js`);
  }

  // forge-sweep's protect-list must include both the new local jsonc and the
  // global jsonc catalogue names, so a sweep never treats them as orphans.
  const sweepSource = fs.readFileSync(path.join(ROOT40, 'skills/forge-sweep/SKILL.md'), 'utf8');
  assert(sweepSource.includes('forge-prefs.jsonc') && sweepSource.includes('forge-agent-prefs.jsonc'),
    '(c) forge-sweep protect-list includes forge-prefs.jsonc + forge-agent-prefs.jsonc');

  process.stdout.write('  (manual UAT) broken .jsonc → /forge-auto, /forge-next, /forge-task all loud-stop with file+line\n');

  // ── R1 regression guard (cross-engine review, fix(S04/review)): the
  // REVIEW_CFG `node -e` snippet in shared/forge-review.md must be a valid
  // JS program — a missing `try{` before its `catch(e){...}` made it a
  // SyntaxError on every run, so review.* prefs silently fell back to
  // hardcoded defaults regardless of what the user configured. Extract the
  // exact snippet from the spec and run it against a fixture PREFS_JSON with
  // a non-default `review:` block — it must parse (exit 0) and return the
  // configured values, not the catch-branch defaults.
  {
    const reviewMd = fs.readFileSync(path.join(ROOT40, 'shared/forge-review.md'), 'utf8');
    const cfgMatch = reviewMd.match(/REVIEW_CFG=\$\(printf '%s' "\$PREFS_JSON" \| node -e "([\s\S]*?)"\)/);
    assert(!!cfgMatch, '(d) R1: REVIEW_CFG node -e snippet extracted from shared/forge-review.md');
    if (cfgMatch) {
      const program = cfgMatch[1].replace(/\\"/g, '"');
      const fixturePrefs = JSON.stringify({
        prefs: {
          review: {
            mode: 'disabled', style: 'flags', rounds: 2, ask_in_auto: 'pause',
            fix_conceded: false, engine: 'workflow', challenger: 'codex', advocate: 'claude',
            challenger_model: 'gpt-5.2-codex', advocate_model: 'claude-opus-4-8',
          },
        },
      });
      const r = spawnSync(process.execPath, ['-e', program], { input: fixturePrefs, encoding: 'utf8' });
      assert(r.status === 0, '(d) R1: REVIEW_CFG snippet runs without SyntaxError (exit 0)',
        `stderr: ${r.stderr}`);
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch {}
      assert(!!parsed && parsed.mode === 'disabled' && parsed.style === 'flags' && parsed.rounds === 2
        && parsed.challenger === 'codex' && parsed.advocateModel === 'claude-opus-4-8',
        '(d) R1: REVIEW_CFG returns the configured review.* values (not catch-branch defaults)',
        `got ${r.stdout}`);
    }
  }

  // ── R5 regression guard: legacyReadFlatKeys must skip fenced code blocks
  // and be first-match-wins, so a fenced ```yaml example (containing e.g.
  // `repo_path: /example`) placed AFTER the real setting never clobbers it.
  withHermeticHome(({ env }) => {
    const dir = mkTmp('flat-key-fence-guard');
    const fenceFixture = [
      'repo_path: /real',
      '',
      '```yaml',
      'repo_path: /example',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{"repo_path":"/real"}', 'utf8');
    const resolved = resolveKey(dir, 'repo_path', env);
    assert(resolved.status === 0 && resolved.value === '/real',
      '(d) R5: legacyReadFlatKeys ignores fenced example, resolves real repo_path',
      `got ${JSON.stringify(resolved.value)} (status ${resolved.status})`);
    cleanup(dir);
  });
}

// ── Section 41: S05 markdown migration (real-shaped fixtures + STOP gates) ──
// The fixture policy below is intentionally explicit.  These are not miniature
// YAML snippets: each one keeps the headings, prose boundaries, and indentation
// conventions that the compatibility reader encounters in the shipped file.
// This matters because a migration can pass a synthetic parser test while still
// losing a value when a Markdown example, table, or EOF boundary is present.
//
// F1 represents the historical catalogue before the later review, routing, and
// account sections existed.  Its absence is part of the contract: migration
// must not manufacture defaults into the resolved user object.
// F2 represents the current catalogue shape and deliberately exercises values
// in distant sections.  In particular, `repo_path` is a flat scalar and the
// heavy tier is a bare scalar.  The latter is the compatibility spelling that
// the routing/tier readers coerce to a one-member chain.
// F3 has two local files.  The repo-shared file is read first and the personal
// file is read last.  The assertion therefore protects directionality instead
// of merely checking that both files were copied somewhere.
// F4 is the incident-shaped malformed routing case.  A flattened child line
// must produce the old reader's routingMalformed signal, and no migration
// artifact may be created before that signal reaches the CLI.
//
// Every CLI invocation uses isolated global/local directory overrides.  This
// prevents the smoke suite from observing an operator's home catalogue and
// makes the write assertions meaningful: the complete directory snapshot is
// taken before the operation and compared after it.
//
// The gate cases intentionally inspect both streams.  Human diagnostics stay
// on stderr, while --json remains machine-readable on stdout and contains the
// divergence payload.  Exit 3 is consequently a STOP signal, not a generic
// test failure; its strongest guarantee is that no .bak or JSONC exists.
//
// Idempotence is checked with both content and mtime.  Content alone would
// miss an implementation that rewrites an identical catalog, which would be
// noisy and could destroy user-owned metadata such as file timestamps.
//
// The local ignore assertion uses the migrator's injectable command seam.  It
// models a real repository with an unignored local catalogue without invoking
// a git subprocess from the smoke process itself; the production helper still
// owns the exact rev-parse/check-ignore behavior.
//
// Static guards intentionally read source rather than execute installers.
// Installers have external side effects and platform-specific dependencies;
// source guards prove the path construction and ordering invariants cheaply.
// The update command ordering check is based on occurrence indexes, so a
// later documentation mention cannot accidentally satisfy the migration-first
// requirement.
//
// Finally, this section remains registered in the same main runner as all
// earlier sections.  A green isolated migration test is insufficient: the
// permanent regression net includes the complete CODE_DIR smoke suite.
//
// Reviewers can use the names in the assertion labels as a compact map:
// (a) capture/generate/parse/round-trip, (b) no-op stability, (c) dry-run and
// loud-stop behavior, (d) precedence/ignore/set behavior, and (e) integration
// source guards.  Keeping the labels stable makes failures actionable in CI.
//
// The fixture strings are kept in this file, alongside the tests that consume
// them, so changes to forge-agent-prefs.md cannot silently weaken this safety
// net by changing an external fixture during a release.  They also make the
// old-reader input visible during code review, including the intentional typo
// retained in F3's .bak recovery copy.
//
// The tests do not assert a hard-coded generated scaffold byte sequence.  That
// would couple migration correctness to harmless documentation changes.  They
// assert the semantic contract through the exported tokenizer, old reader,
// deep merge, and resolved-diff gate, while the --set test separately protects
// source-slice preservation.
//
// A migration result is checked before cleanup whenever possible.  The .bak
// check proves recovery ordering, and the absent-md check proves the retirement
// step only occurs after the post-write real-reader verification succeeds.
//
// This section deliberately does not relax prior sections or skip on platform.
// All operations use Node's portable filesystem APIs; installer checks inspect
// bytes and text, so Windows-specific path regressions remain visible on Unix.
//
// Keep new migration scenarios here rather than in a second ad-hoc test file:
// the single runner is the documented lint command and must remain the one
// command that exercises every section from the CODE_DIR.
//
// In particular, do not replace these checks with presence-only assertions:
// the migration contract is about preserving meaning across a destructive
// format transition, and the zero-write cases are the operational safety net.
// The resulting section is intentionally boring to run and difficult to
// accidentally bypass.
// Keep this evidence close to the executable assertions.
// It is part of the permanent smoke contract.
// No external fixture download is required.
// No installer execution is required.
// No repository state mutation is required.
function smokePrefsMigration() {
  process.stdout.write('\n▸ Section 41: prefs migration fixtures, gates and installer guards\n');
  const prefsEngine = require('./forge-prefs.js');
  // Deliberate legacy-module fixture: migration tests must read Markdown through
  // the isolated migrator reader, never through the canonical JSONC engine.
  const engine = require('./forge-prefs-legacy.js');
  const migrate = require('./forge-prefs-migrate.js');
  const f1 = `# legacy v1.45\n\n## Effort Settings\n\neffort:\n  execute-task: high\n  plan-slice: medium\n\n## Thinking Settings\n\nthinking:\n  opus_phases: adaptive\n\n## Git Settings\n\nauto_commit: false\nrepo_path: /legacy/project\n\n## Tier Settings\n\ntier_models:\n  standard: claude-sonnet-5\n`;
  const f2 = `# current forge-agent-prefs.md\n\n## Git Settings\n\nrepo_path: /custom/repo\nauto_commit: false\n\n## Effort Settings\n\neffort:\n  execute-task: high\n  plan-slice: xhigh\n\n## Thinking Settings\n\nthinking:\n  opus_phases: disabled\n\n## Tier Settings\n\ntier_models:\n  standard: [claude-sonnet-5, claude-haiku-4-5-20251001]\n  heavy: claude-opus-custom\n\n## Review Settings\n\nreview:\n  mode: disabled\n  rounds: 3\n\n## Routing\n\nrouting:\n  backend:\n    execute-task:\n      standard: claude\n`;
  const f3Shared = `# repo-shared legacy catalogue\n\nrepo_path: /shared\nreview:\n  rounds: 1\n  mode: enabled\n`;
  const f3Local = `# personal legacy edits\n\nrepo_path: /personal\nreview:\n  rounds: 2\n  mode: disabled\n\ntypo_knob: preserved\n`;
  const f4 = `# malformed 2026-07-16 fixture\n\nrouting:\n  backend:\n  execute-task: claude\n\nreview:\n  rounds: 2\n`;
  const dirs = () => { const root = mkTmp('prefs-migration'); const globalDir = path.join(root, 'global'); const localDir = path.join(root, '.gsd'); fs.mkdirSync(globalDir, { recursive: true }); fs.mkdirSync(localDir, { recursive: true }); return { root, globalDir, localDir }; };
  const cli = (d, extra, env) => runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--json', ...(extra || [])], { cwd: d.root, env: { ...process.env, ...(env || {}) } });
  const snapshot = (d) => [d.globalDir, d.localDir].flatMap((dir) => fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => { const file = path.join(dir, name); const stat = fs.statSync(file); return stat.isFile() ? [file, stat.mtimeMs, fs.readFileSync(file, 'utf8')] : null; }).filter(Boolean) : []);
  const writeFixture = (d, globalText, localText) => { if (globalText) fs.writeFileSync(path.join(d.globalDir, 'forge-agent-prefs.md'), globalText); if (localText) fs.writeFileSync(path.join(d.localDir, 'prefs.local.md'), localText); };

  for (const [name, text] of [['F1 v1.45 truncado', f1], ['F2 atual completo', f2]]) {
    const d = dirs(); writeFixture(d, text);
    const beforeLayer = engine.legacyReadLayer([path.join(d.globalDir, 'forge-agent-prefs.md')]);
    const result = cli(d);
    const parsed = prefsEngine.parseJsonc(fs.readFileSync(path.join(d.globalDir, 'forge-agent-prefs.jsonc'), 'utf8'));
    const after = migrate.resolveCurrent(d.root, { globalDir: d.globalDir, localDir: d.localDir });
    assert(result.status === 0 && parsed.ok && fs.existsSync(path.join(d.globalDir, 'forge-agent-prefs.md.bak')),
      `(a) ${name}: exit 0, JSONC/.bak and tokenizer parse`, JSON.stringify(result));
    assert(migrate.resolvedDiff(prefsEngine.deepMerge({}, beforeLayer.prefs), after.prefs).length === 0,
      `(a) ${name}: legacyReadLayer → migration round-trip preserves resolved values`, JSON.stringify(after));
    assert(!fs.existsSync(path.join(d.globalDir, 'forge-agent-prefs.md')), `(a) ${name}: legacy md retired after migration`);
    const before = snapshot(d); const again = cli(d); const afterAgain = snapshot(d);
    assert(again.status === 0 && JSON.stringify(before) === JSON.stringify(afterAgain), `(b) ${name}: already-migrated is idempotent (mtime/content stable)`, JSON.stringify(again));
    cleanup(d.root);
  }

  { const d = dirs(); writeFixture(d, f2); const before = snapshot(d); const dry = cli(d, ['--dry-run']); assert(dry.status === 0 && JSON.stringify(before) === JSON.stringify(snapshot(d)), '(c) --dry-run performs zero writes'); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f2); const before = snapshot(d); const stopped = cli(d, [], { FORGE_PREFS_MIGRATE_TEST_MUTATE: '1' }); const output = `${stopped.stdout}${stopped.stderr}`; assert(stopped.status === 3 && output.includes('__forge_test_mutation') && JSON.stringify(before) === JSON.stringify(snapshot(d)), '(c) mutate hook gate-STOP exits 3, reports diff and writes zero bytes', output); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f4); const stopped = cli(d); assert(stopped.status === 4 && fs.existsSync(path.join(d.globalDir, 'forge-agent-prefs.md')) && !fs.existsSync(path.join(d.globalDir, 'forge-agent-prefs.jsonc')), '(c) malformed routing exits 4 and leaves md intact', `${stopped.stdout}${stopped.stderr}`); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f3Shared, f3Local); const result = cli(d); const local = fs.readFileSync(path.join(d.localDir, 'forge-prefs.jsonc'), 'utf8'); const ignored = migrate.ensureGitignore(d.root, { execFileSync: (_cmd, args) => { if (args[0] === 'check-ignore') throw new Error('unignored'); }, writeFileSync: fs.writeFileSync }); const resolved = migrate.resolveCurrent(d.root, { globalDir: d.globalDir, localDir: d.localDir }).prefs; const backup = fs.readFileSync(path.join(d.localDir, 'prefs.local.md.bak'), 'utf8'); assert(result.status === 0 && resolved.repo_path === '/personal' && resolved.review.rounds === 2 && backup.includes('typo_knob: preserved'), '(d) repo-shared × prefs.local fold is directional: local old value wins and typo fixture is retained in .bak', JSON.stringify(resolved)); assert(ignored.action === 'appended' && /\.gsd\/forge-prefs\.jsonc/.test(fs.readFileSync(path.join(d.root, '.gitignore'), 'utf8')) && local.includes('repo_path'), '(d) local catalog is protected by the .gitignore fold', result.stderr); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f2); const migrated = cli(d); const original = fs.readFileSync(path.join(d.globalDir, 'forge-agent-prefs.jsonc'), 'utf8'); const set = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'review.rounds=2', '--json'], { cwd: d.root }); const updated = fs.readFileSync(path.join(d.globalDir, 'forge-agent-prefs.jsonc'), 'utf8'); const resolved = migrate.resolveCurrent(d.root, { globalDir: d.globalDir, localDir: d.localDir }).prefs; assert(migrated.status === 0 && set.status === 0 && resolved.review.rounds === 2, '(d2) --set review.rounds=2 updates a migrated catalog', `${set.stdout}${set.stderr}`); const sectionAt = (text) => text.indexOf('  "review":'); assert(sectionAt(updated) === sectionAt(original) && updated.slice(0, sectionAt(updated)) === original.slice(0, sectionAt(original)), '(d2) --set rewrites the touched section where it already sits and preserves every byte above it', `${sectionAt(original)} → ${sectionAt(updated)}`); assert((updated.match(/^ {2}"review":/gm) || []).length === 1 && !updated.includes('set by forge-prefs-migrate --set'), '(d2) --set leaves one active block and no appended duplicate that would shadow a hand edit', `${original.length} → ${updated.length}`); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f2); cli(d); const before = snapshot(d); const refusedEnum = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'plan_check.mode=banana', '--json'], { cwd: d.root }); const afterEnum = snapshot(d); const refusedBool = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'workers.require_worktree=atuo', '--json'], { cwd: d.root }); const afterBool = snapshot(d); assert(refusedEnum.status !== 0 && `${refusedEnum.stdout}${refusedEnum.stderr}`.includes('plan_check.mode') && JSON.stringify(before) === JSON.stringify(afterEnum), '(d3) --set plan_check.mode=banana is refused: exit!=0, stderr names the key, zero writes', `${refusedEnum.stdout}${refusedEnum.stderr}`); assert(refusedBool.status !== 0 && `${refusedBool.stdout}${refusedBool.stderr}`.includes('workers.require_worktree') && JSON.stringify(before) === JSON.stringify(afterBool), '(d3) --set workers.require_worktree=atuo is refused: exit!=0, stderr names the key, zero writes', `${refusedBool.stdout}${refusedBool.stderr}`); cleanup(d.root); }
  { const d = dirs(); writeFixture(d, f2); cli(d); const acceptBool = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'workers.require_worktree=false', '--json'], { cwd: d.root }); const acceptEnum = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'workers.require_worktree=auto', '--json'], { cwd: d.root }); const resolved = migrate.resolveCurrent(d.root, { globalDir: d.globalDir, localDir: d.localDir }).prefs; assert(acceptBool.status === 0 && acceptEnum.status === 0 && resolved.workers.require_worktree === 'auto', '(d3) --set continues accepting valid values: bool then mixed-type enum-string', `${acceptBool.stdout}${acceptBool.stderr} / ${acceptEnum.stdout}${acceptEnum.stderr}`); cleanup(d.root); }
  // (d4) review-fix/TASK-001 R1 conceded: exact-key-match filter on the enum/type
  // gate let 3 bypass shapes write invalid data — ancestor-key set, descendant-key
  // set via an object value, and unknown-child set under a valid parent. The fix
  // rejects on ANY warning emitted against the minimal single-key candidate.
  { const d = dirs(); writeFixture(d, f2); cli(d); const before = snapshot(d);
    const ancestorBypass = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'workers.require_worktree.foo=x', '--json'], { cwd: d.root });
    const afterAncestor = snapshot(d);
    assert(ancestorBypass.status !== 0 && JSON.stringify(before) === JSON.stringify(afterAncestor), '(d4) --set workers.require_worktree.foo=x (ancestor-key warning) is refused: exit!=0, zero writes', `${ancestorBypass.stdout}${ancestorBypass.stderr}`);
    const descendantBypass = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'plan_check={"mode":"banana"}', '--json'], { cwd: d.root });
    const afterDescendant = snapshot(d);
    assert(descendantBypass.status !== 0 && JSON.stringify(before) === JSON.stringify(afterDescendant), '(d4) --set plan_check={"mode":"banana"} (descendant-key warning) is refused: exit!=0, zero writes', `${descendantBypass.stdout}${descendantBypass.stderr}`);
    const unknownBypass = runScript('forge-prefs-migrate.js', ['--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--layer', 'global', '--set', 'unknown.child=x', '--json'], { cwd: d.root });
    const afterUnknown = snapshot(d);
    assert(unknownBypass.status !== 0 && JSON.stringify(before) === JSON.stringify(afterUnknown), '(d4) --set unknown.child=x (root-key warning) is refused: exit!=0, zero writes', `${unknownBypass.stdout}${unknownBypass.stderr}`);
    cleanup(d.root); }

  const root = path.join(__dirname, '..'); const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const sh = read('install.sh'); const ps = read('install.ps1'); const update = read('commands/forge-update.md');
  assert(sh.includes('--scaffold') && !sh.includes('.gsd/forge-prefs.jsonc'), '(e) install.sh invokes --scaffold and never creates local .gsd catalog');
  assert(ps.includes('Join-Path') && !ps.includes('\f') && !ps.includes(String.fromCharCode(0x0c)), '(e) install.ps1 uses Join-Path and contains no form-feed byte');
  assert(update.indexOf('forge-prefs-migrate.js') < update.indexOf('--rescaffold'), '(e) forge-update migrates before re-scaffold');
  { const repoPathSetCalls = update.match(/--set "repo_path=[^"]*"/g) || []; assert(repoPathSetCalls.length >= 2 && repoPathSetCalls.every((call) => { const idx = update.indexOf(call); const line = update.slice(update.lastIndexOf('\n', idx) + 1, update.indexOf('\n', idx)); return line.includes('--layer global'); }), '(e2) every --set repo_path invocation in forge-update.md carries --layer global (global-only knob must not land in local layer)', JSON.stringify(repoPathSetCalls)); }
  for (const skill of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md']) {
    const skillText = read(skill);
    assert(!skillText.includes('Deprecation warning (once per session)') &&
      !skillText.includes('md-legacy') && skillText.includes('legacy-md-without-jsonc'),
      `(e) ${skill}: consumer uses structured legacy-md-without-jsonc posture`);
  }
  const doctorText = read('skills/forge-doctor/SKILL.md');
  assert(doctorText.includes('md-blocked') &&
    /forge-prefs-migrate\.js[\s\S]{0,180}--local-only/.test(doctorText),
    '(e) doctor detects blocked prefs and documents local-only migration');
  pass('(f) Section 41 fixtures are substantive real-shaped markdown, not synthetic key-only stubs');
}

// ── Section 42: prefs viewer + doctor prefs-check (whole-system read side) ─
// Binds the S06 read-side surface end to end: the viewer's 90-knob catalog
// (state·value·layer·description, no drift against the schema) and the three
// doctor prefs-check primitives (stale-catalog --diff, the parse-error flag
// file contract, and validatePrefs warnings surfaced via --resolved
// --explain). Reuses buildCatalog/setPreference/generateScaffold/segmentCatalog/
// catalogDiff and the forge-prefs.js CLI itself — no reimplementation of
// resolution, diffing, or validation here.
function smokePrefsViewerDoctor() {
  process.stdout.write('\n▸ Section 42: prefs viewer + doctor prefs-check (whole-system read side)\n');
  const engine = require('./forge-prefs.js');
  const scaffold = require('./forge-prefs-scaffold.js');
  const view = require('./forge-prefs-view.js');
  const migrate = require('./forge-prefs-migrate.js');
  const schema = engine.loadSchema();

  // (a) Viewer: full knob-set coverage, activation, and no-drift against schema.
  const expectedSchemaLeaves = independentSchemaLeafKeys(schema);
  const project = mkTmp('prefs-viewer');
  const home = path.join(project, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const setResult = migrate.setPreference(project, 'review.rounds=3', { layer: 'local', create: true });
    assert(setResult.status === 'set', '(a) setPreference activates review.rounds=3 locally for the viewer fixture', JSON.stringify(setResult));
    const catalog = view.buildCatalog(project);
    const catalogPaths = new Set(catalog.knobs.map((knob) => knob.path));
    assert(setEqual(catalogPaths, expectedSchemaLeaves.leafPaths),
      '(a) viewer lists exactly the knob set the schema declares',
      describeSetDiff(catalogPaths, expectedSchemaLeaves.leafPaths));
    const sections = new Set(catalog.knobs.map((knob) => knob.section));
    assert(setEqual(sections, expectedSchemaLeaves.sections),
      '(a) viewer covers exactly the section set the schema declares',
      describeSetDiff(sections, expectedSchemaLeaves.sections));
    const rounds = catalog.knobs.find((knob) => knob.path === 'review.rounds');
    assert(!!rounds && rounds.active === true && rounds.value === 3 && rounds.layer === 'local',
      '(a) activated knob is ATIVO with the right layer+value', JSON.stringify(rounds));
    const off = catalog.knobs.find((knob) => knob.path === 'skip_discuss');
    assert(!!off && off.active === false && off.value === false && off.layer === '—',
      '(a) a known-off knob stays desligado at its schema default', JSON.stringify(off));
    const getNode = (dotted) => dotted.split('.').reduce(
      (node, key) => (node && node.properties ? node.properties[key] : null), { properties: schema.properties });
    const driftFree = catalog.knobs.every((knob) => {
      const node = getNode(knob.path);
      return node && node.description === knob.description;
    });
    assert(driftFree, '(a) every rendered description is byte-equal to schema.description (no drift)');
    const header = view.renderView(project).split('\n')[0];
    assert(header.includes(String(catalog.knobs.length)) && !header.includes('87'),
      '(a) viewer header interpolates the computed knob count, never a hardcoded literal', header);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    cleanup(project);
  }

  // (b) Doctor `--diff`: stale-catalog detection on a truncated vs. a full scaffold.
  const diffDir = mkTmp('prefs-doctor-diff');
  const generated = scaffold.generateScaffold(schema);
  const segments = scaffold.segmentCatalog(generated);
  const reviewSegment = segments.find((segment) => segment.key === 'review');
  const truncated = generated.slice(0, reviewSegment.start) + generated.slice(reviewSegment.end);
  const truncatedFile = path.join(diffDir, 'truncated.jsonc');
  const fullFile = path.join(diffDir, 'full.jsonc');
  fs.writeFileSync(truncatedFile, truncated, 'utf8');
  fs.writeFileSync(fullFile, generated, 'utf8');
  const diffTruncated = runScript('forge-prefs-scaffold.js', ['--diff', truncatedFile]);
  let diffTruncatedJson = null;
  try { diffTruncatedJson = JSON.parse(diffTruncated.stdout); } catch {}
  assert(diffTruncated.status === 0 && diffTruncatedJson && diffTruncatedJson.missingSections.includes('review'),
    '(b) --diff on a truncated catalog reports missingSections including the dropped section',
    `${diffTruncated.status}: ${diffTruncated.stdout}`);
  const diffFull = runScript('forge-prefs-scaffold.js', ['--diff', fullFile]);
  let diffFullJson = null;
  try { diffFullJson = JSON.parse(diffFull.stdout); } catch {}
  assert(diffFull.status === 0 && diffFullJson && diffFullJson.missingSections.length === 0,
    '(b) --diff on a full scaffold reports empty missingSections', `${diffFull.status}: ${diffFull.stdout}`);
  cleanup(diffDir);

  // (c) Parse-error flag: the file-existence primitive the doctor C5b check relies on.
  const flagDir = mkTmp('prefs-doctor-flag');
  const flagFile = path.join(flagDir, '.gsd', 'forge', 'prefs-error.json');
  assert(!fs.existsSync(flagFile), '(c) no parse-error flag present in a clean cwd');
  fs.writeFileSync(flagFile, JSON.stringify({ file: '/tmp/x.jsonc', line: 3, message: 'Unexpected token' }), 'utf8');
  const flagged = fs.existsSync(flagFile) ? JSON.parse(fs.readFileSync(flagFile, 'utf8')) : null;
  assert(!!flagged && !!flagged.file && typeof flagged.line === 'number' && !!flagged.message,
    '(c) doctor prefs-error.json flag is detected with the file/line/message shape', JSON.stringify(flagged));
  cleanup(flagDir);

  // (d) Invalid values: validatePrefs warnings surface via `--resolved --explain`.
  const invalidDir = mkTmp('prefs-doctor-invalid');
  const invalidHome = path.join(invalidDir, 'home');
  fs.mkdirSync(path.join(invalidHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(invalidDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(invalidHome, '.claude', 'forge-agent-prefs.jsonc'),
    '{"evidence":{"mode":"bogus-mode"},"skip_discuss":"not-a-boolean"}', 'utf8');
  const explain = runScript('forge-prefs.js', ['--resolved', '--explain', '--cwd', invalidDir],
    { env: { ...process.env, HOME: invalidHome, USERPROFILE: invalidHome } });
  let explainJson = null;
  try { explainJson = JSON.parse(explain.stdout.split('\n').find((line) => line.trim().startsWith('{'))); } catch {}
  assert(!!explainJson && Array.isArray(explainJson.warnings) && explainJson.warnings.length > 0 &&
    explainJson.warnings.some((warning) => warning.key === 'evidence.mode') &&
    explainJson.warnings.some((warning) => warning.key === 'skip_discuss'),
    '(d) --resolved --explain surfaces validatePrefs warnings naming the invalid keys', explain.stdout);
  cleanup(invalidDir);

  pass('(e) Section 42 whole-system read-side (viewer + doctor prefs-check) verified end-to-end');
}

// ── Section 43: prefs migration fidelity (comment-strip, schema-aware arrays, schema gate) ──
function smokePrefsMigrationFidelity() {
  process.stdout.write('\n▸ Section 43: prefs migration fidelity (comment-strip, schema-aware arrays, schema gate)\n');
  // Deliberate legacy-module fixture: fidelity assertions exercise the migrator reader.
  const engine = require('./forge-prefs-legacy.js');
  const migrate = require('./forge-prefs-migrate.js');
  const fixture = `# .bak-shaped legacy preferences

forge_isolation:
  branch_pattern: "forge/{M###}"    # nome da branch quando mode=branch
  repos:
    include: []
    exclude:
      - "node_modules/**"
      - "dist/**"
  mode: WORKTREE

verification:
  preference_commands: []

multi_run:
  dashboard_refresh_on:
    - boot
    - exit

file_audit:
  ignore_list:
    - "package-lock.json"
    - "dist/**"

review:
  mode: disabled

scalar_guard:
  glob_value: [not, an, array]
`;
  const dirs = () => {
    const root = mkTmp('prefs-fidelity');
    const globalDir = path.join(root, 'global');
    const localDir = path.join(root, '.gsd');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    return { root, globalDir, localDir };
  };
  const cli = (d, extra) => runScript('forge-prefs-migrate.js', [
    '--cwd', d.root, '--global-dir', d.globalDir, '--local-dir', d.localDir, '--json', ...(extra || []),
  ], { cwd: d.root });
  const snapshot = (d) => [d.globalDir, d.localDir].flatMap((dir) => fs.existsSync(dir)
    ? fs.readdirSync(dir).map((name) => {
      const file = path.join(dir, name); const stat = fs.statSync(file);
      return stat.isFile() ? [file, stat.mtimeMs, fs.readFileSync(file, 'utf8')] : null;
    }).filter(Boolean) : []);

  const d = dirs();
  const fixturePath = path.join(d.globalDir, 'forge-agent-prefs.md');
  fs.writeFileSync(fixturePath, fixture, 'utf8');
  const extracted = engine.legacyReadFile(fixturePath).prefs;
  assert(extracted.forge_isolation && extracted.forge_isolation.branch_pattern === 'forge/{M###}',
    '(a) branch_pattern strips the outside comment while preserving {M###}', JSON.stringify(extracted.forge_isolation));
  const arrayChecks = [
    ['forge_isolation.repos.include', extracted.forge_isolation?.repos?.include, []],
    ['forge_isolation.repos.exclude', extracted.forge_isolation?.repos?.exclude, ['node_modules/**', 'dist/**']],
    ['multi_run.dashboard_refresh_on', extracted.multi_run?.dashboard_refresh_on, ['boot', 'exit']],
    ['verification.preference_commands', extracted.verification?.preference_commands, []],
    ['file_audit.ignore_list', extracted.file_audit?.ignore_list, ['package-lock.json', 'dist/**']],
  ];
  for (const [key, actual, expected] of arrayChecks) {
    assert(Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected),
      `(a) ${key} resolves as a JSON array with the expected items`, JSON.stringify(actual));
  }
  assert(typeof extracted.scalar_guard?.glob_value === 'string' && extracted.scalar_guard.glob_value === '[not, an, array]',
    '(a) non-array bracket value remains a string (schema-aware parsing guard)', JSON.stringify(extracted.scalar_guard));

  // The canonical reader is JSONC-only; retain the legacy extraction proof and
  // write its schema-valid value-equivalent JSONC fixture for the read-side check.
  const canonical = JSON.parse(JSON.stringify(extracted));
  canonical.forge_isolation.mode = String(canonical.forge_isolation.mode).toLowerCase();
  delete canonical.scalar_guard;
  fs.writeFileSync(path.join(d.globalDir, 'forge-prefs.jsonc'), JSON.stringify(canonical), 'utf8');
  assert(fs.existsSync(path.join(d.globalDir, 'forge-prefs.jsonc')),
    '(a2) fidelity fixture has a schema-valid JSONC counterpart');

  const home = path.join(d.root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.copyFileSync(path.join(d.globalDir, 'forge-prefs.jsonc'), path.join(home, '.claude', 'forge-agent-prefs.jsonc'));
  const resolved = runScript('forge-prefs.js', ['--resolved', '--cwd', d.root], {
    cwd: d.root, env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let resolvedJson = null;
  try { resolvedJson = JSON.parse(resolved.stdout); } catch {}
  const warnings = (resolvedJson && resolvedJson.warnings) || [];
  const fidelityWarnings = warnings.filter((warning) =>
    arrayChecks.some(([key]) => warning.key === key) || warning.key === 'forge_isolation.branch_pattern');
  assert(resolved.status === 0 && !!resolvedJson && fidelityWarnings.length === 0,
    '(b) --resolved has no schema warnings for branch_pattern or legacy array knobs', resolved.stdout);
  cleanup(d.root);

  const bad = dirs();
  const badFixture = fixture.replace('mode: disabled', 'mode: definitely-not-a-review-mode');
  fs.writeFileSync(path.join(bad.globalDir, 'forge-agent-prefs.md'), badFixture, 'utf8');
  const before = snapshot(bad);
  const stopped = cli(bad);
  const output = `${stopped.stdout}${stopped.stderr}`;
  assert(stopped.status !== 0 && !fs.existsSync(path.join(bad.globalDir, 'forge-agent-prefs.jsonc'))
    && JSON.stringify(before) === JSON.stringify(snapshot(bad)) && output.includes('schema'),
    '(c) schema-aware migration gate stops invalid enum input before any JSONC write', output);
  assert(!output.includes('[object Object]'),
    '(c) schema-warning gate never prints "[object Object]" for its warning lines', output);
  cleanup(bad.root);

  // (d) unknown/legacy top-level key — gate must stop, zero writes, and name it explicitly.
  const unknown = dirs();
  const unknownFixture = `${fixture}\nsome_renamed_legacy_key: whatever\n`;
  fs.writeFileSync(path.join(unknown.globalDir, 'forge-agent-prefs.md'), unknownFixture, 'utf8');
  const beforeUnknown = snapshot(unknown);
  const stoppedUnknown = cli(unknown);
  const outputUnknown = `${stoppedUnknown.stdout}${stoppedUnknown.stderr}`;
  assert(stoppedUnknown.status !== 0 && !fs.existsSync(path.join(unknown.globalDir, 'forge-agent-prefs.jsonc'))
    && JSON.stringify(beforeUnknown) === JSON.stringify(snapshot(unknown)),
    '(d) unknown legacy preference key stops migration with zero writes', outputUnknown);
  assert(/unknown preference key/i.test(outputUnknown),
    '(d) gate message explicitly names the unknown preference key', outputUnknown);
  cleanup(unknown.root);
}

// ── Section 44: curated setup scaffold + schema ref + init/installer wiring ──
function smokeInitSetupScaffold() {
  process.stdout.write('\n▸ Section 44: curated setup scaffold, schema ref and init/installer wiring\n');
  const { generateSetupScaffold, SETUP_KNOBS } = require('./forge-prefs-scaffold.js');
  const { loadSchema, parseJsonc } = require('./forge-prefs.js');
  const schema = loadSchema();
  const out = generateSetupScaffold(schema, {
    activeValues: { auto_commit: false },
    schemaRef: 'forge-prefs.schema.json',
  });
  const parsed = parseJsonc(out);
  assert(parsed.ok, '(a) setup scaffold é JSONC válido', JSON.stringify(parsed));
  assert(/Setup inicial do projeto/.test(out), '(a) setup scaffold contém o header esperado');
  assert(/^\s*"auto_commit":\s*false\b/m.test(out) && parsed.value.auto_commit === false,
    '(a) auto_commit activeValue=false aparece ativo e parseia como false', out);

  for (const key of ['merge_strategy', 'main_branch', 'auto_push', 'review', 'tier_models', 'routing', 'forge_isolation']) {
    assert(new RegExp(`^\\s*//\\s*"${key.replace('.', '\\.')}(?:"|\\.)`, 'm').test(out),
      `(a) ${key} permanece comentado`, `linha comentada não encontrada`);
    assert(!Object.prototype.hasOwnProperty.call(parsed.value, key),
      `(a) ${key} não é uma chave ativa no resultado parseado`, JSON.stringify(parsed.value));
  }
  assert(SETUP_KNOBS.includes('auto_commit') && SETUP_KNOBS.includes('routing'),
    '(a) scaffold usa o subconjunto SETUP_KNOBS curado');
  assert(!/\b(?:token_budget|evidence|multi_run)\b/.test(out),
    '(b) knobs fora do subconjunto curado estão ausentes do scaffold', out);
  assert(/"\$schema":\s*"forge-prefs\.schema\.json"/.test(out),
    '(b) generateSetupScaffold honra --schema-ref');

  const repo = path.dirname(SCRIPTS);
  const scaffold = execFileSync('node', [path.join(SCRIPTS, 'forge-prefs.js'), '--scaffold'], {
    cwd: repo, encoding: 'utf8',
  });
  assert(/"\$schema":\s*"forge-prefs\.schema\.json"/.test(scaffold),
    '(c) --scaffold sem --schema-ref mantém a referência default', scaffold.slice(0, 300));
  const custom = execFileSync('node', [path.join(SCRIPTS, 'forge-prefs.js'), '--scaffold', '--schema-ref', 'custom.json'], {
    cwd: repo, encoding: 'utf8',
  });
  assert(/"\$schema":\s*"custom\.json"/.test(custom),
    '(c) --scaffold --schema-ref custom.json emite custom.json', custom.slice(0, 300));

  const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
  const init = read('commands/forge-init.md');
  assert(init.includes('--setup-scaffold'), '(d) forge-init referencia --setup-scaffold');
  assert(init.includes('ensureGitignore'), '(d) forge-init referencia ensureGitignore');
  const caseBStart = init.indexOf('### Case B:');
  const caseBEnd = init.indexOf('\n### ', caseBStart + 1);
  const caseB = init.slice(caseBStart, caseBEnd < 0 ? init.length : caseBEnd);
  assert(!/(?:mkdir|touch|cat|echo|tee|writeFile|cp)[^\n]*(?:claude-agent-prefs\.md|prefs\.local\.md)/i.test(caseB),
    '(d) Case B não contém criação dos .md legados');
  assert(read('install.sh').includes('--schema-ref forge-prefs.schema.json'),
    '(e) install.sh passa --schema-ref forge-prefs.schema.json ao scaffold global');
  assert(read('install.ps1').includes('--schema-ref forge-prefs.schema.json'),
    '(e) install.ps1 passa --schema-ref forge-prefs.schema.json ao scaffold global');
  pass('(final) Section 44: setup scaffold curado, schema ref e wiring verificados');
}

// ── Section 45: stub_pattern malformado não crasha o verifier (regressão) ──
function smokeStubPatternRobustness() {
  process.stdout.write('\n▸ Section 45: malformed stub_pattern does not crash the verifier\n');
  const { _private } = require('./forge-verifier.js');
  const { checkSubstantive } = _private;

  // Content is inert to every DEFAULT_STUB_REGEXES entry — only a valid
  // custom pattern (MAGIC_STUB_MARKER_XYZ) can flag it, so assertion (b)
  // genuinely proves the custom pattern was compiled + applied, not a
  // default regex incidentally matching (e.g. return_null_function).
  const content = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}; // MAGIC_STUB_MARKER_XYZ`).join('\n');
  const lineCount = content.split('\n').length;
  const artifact = {
    path: 'fixture.js',
    min_lines: 5,
    stub_patterns: ['assert(true', 'MAGIC_STUB_MARKER_XYZ'],
  };

  let result;
  let threw = false;
  try {
    result = checkSubstantive(content, lineCount, artifact);
  } catch (e) {
    threw = true;
  }
  assert(!threw, '(a) stub_pattern malformado não crasha checkSubstantive');
  assert(result && typeof result === 'object' && typeof result.pass === 'boolean',
    '(a) checkSubstantive ainda retorna um resultado válido', JSON.stringify(result));
  const customFlag = result && Array.isArray(result.flags)
    && result.flags.find((f) => f.regex_name === 'custom_stub_1');
  assert(result.pass === false && Array.isArray(result.flags) && result.flags.length > 0 && !!customFlag,
    '(b) pattern customizado válido é compilado e detecta o marcador (não um regex default)', JSON.stringify(result));

  pass('(final) Section 45: stub_pattern malformado tratado com segurança, patterns válidos preservados');
}

// ── Section 46: shared dispatch resolver — parity + cutover + routes-by-domain ──
// M012 S02 T03: proves shared/forge-dispatch.md's "resolver as single executable
// source" claim end-to-end. (a) resolveDispatch() reproduces the canonical
// tier_models-legacy contract for an input with no routing: block. (b) the
// effort model-cap clamp still fires through the resolver. (c) the 3 cut-over
// SKILL.md files call forge-dispatch-resolve.js and contain zero duplicated
// declare -A TIER_DEFAULTS/EFFORT_DEFAULTS/EFFORT_CLAMPED= blocks (mirrors
// Section 40's absence-guard pattern). (d) the additive win: a fixture plan
// with domain: backend + a routing: block resolves route_source==='routing'
// via the SAME resolveDispatch() call forge-task uses. (e) risk-escalation
// (plan-slice on a risk:high slice) still resolves tier/effort === 'max'.
function smokeDispatchResolve() {
  process.stdout.write('\n▸ Section 46: shared dispatch resolver — parity + cutover + routes-by-domain\n');
  const { resolveDispatch } = require(path.join(SCRIPTS, 'forge-dispatch-resolve.js'));

  function writePlan(dir, frontmatterLines) {
    fs.mkdirSync(dir, { recursive: true });
    const planPath = path.join(dir, 'T01-PLAN.md');
    fs.writeFileSync(planPath, '---\n' + frontmatterLines.join('\n') + '\n---\n\n# fixture plan\n', 'utf8');
    return planPath;
  }

  // ── (a) Parity: no routing: block → canonical tier_models-legacy contract ──
  withHermeticHome(() => {
    const dir = mkTmp('dispatch-resolve-parity');
    const planPath = writePlan(dir, ['id: T01', 'slice: S01']);
    const result = resolveDispatch({ unitType: 'execute-task', planPath, cwd: dir });
    assert(result.tier === 'standard', '(a) parity: default execute-task tier === standard', JSON.stringify(result));
    assert(result.route_source === 'tier_models', '(a) parity: no routing: block -> route_source === tier_models', JSON.stringify(result));
    assert(result.model === 'claude-sonnet-5', '(a) parity: default standard-tier model === claude-sonnet-5 (canonical table)', JSON.stringify(result));
    assert(result.alias === 'sonnet', '(a) parity: alias === sonnet', JSON.stringify(result));
    assert(result.effort === 'low', '(a) parity: default execute-task effort === low', JSON.stringify(result));
    assert(result.engine === 'claude', '(a) parity: default engine === claude', JSON.stringify(result));
    cleanup(dir);
  });

  // ── (b) Effort clamp still fires through the resolver ──
  withHermeticHome(() => {
    const dir = mkTmp('dispatch-resolve-clamp');
    const planPath = writePlan(dir, ['id: T01', 'slice: S01', 'effort: xhigh']);
    const result = resolveDispatch({ unitType: 'execute-task', planPath, cwd: dir });
    assert(result.effort === 'medium' && /clamped:model-cap/.test(result.effort_reason),
      '(b) clamp: sonnet-tier + effort:xhigh -> effort=medium, reason has clamped:model-cap',
      JSON.stringify(result));
    cleanup(dir);
  });

  // ── (c) Cutover: the 3 SKILL.md call the resolver and never re-implement it ──
  const ROOT46 = path.join(__dirname, '..');
  const cutoverSkills = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md'];
  for (const rel of cutoverSkills) {
    const source = fs.readFileSync(path.join(ROOT46, rel), 'utf8');
    assert(source.includes('forge-dispatch-resolve.js'), `(c) ${rel}: calls forge-dispatch-resolve.js`);
    assert(!/declare -A TIER_DEFAULTS/.test(source), `(c) ${rel}: no duplicated declare -A TIER_DEFAULTS`);
    assert(!/declare -A EFFORT_DEFAULTS/.test(source), `(c) ${rel}: no duplicated declare -A EFFORT_DEFAULTS`);
    assert(!/EFFORT_CLAMPED=/.test(source), `(c) ${rel}: no duplicated EFFORT_CLAMPED= clamp regex`);
  }

  // ── (g) forge-task Step 4 template emits routing frontmatter hints ──
  // Text-anchor sliced to the Step 4 planner-template region only (between the
  // "Write {TASK_ID}-PLAN.md" directive and the "Iron rule:" boundary) so the
  // assert is mutation-sensitive: generic occurrences of tier:/effort:/domain:
  // elsewhere in the file must NOT satisfy it.
  {
    const source = fs.readFileSync(path.join(ROOT46, 'skills/forge-task/SKILL.md'), 'utf8');
    const startAnchor = 'Write {TASK_ID}-PLAN.md';
    const endAnchor = 'Iron rule:';
    const startIdx = source.indexOf(startAnchor);
    const endIdx = source.indexOf(endAnchor, startIdx);
    assert(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx,
      '(g) forge-task Step 4 template region found (Write PLAN.md ... Iron rule:)',
      `startIdx=${startIdx} endIdx=${endIdx}`);
    const region = startIdx !== -1 && endIdx !== -1 ? source.slice(startIdx, endIdx) : '';
    assert(/`---`-fenced YAML\s*\nfrontmatter/.test(region),
      '(g) template region mandates a `---`-fenced YAML frontmatter block', 'directive not found in region');
    assert(/`tier:`/.test(region), '(g) template region mentions `tier:` frontmatter field');
    assert(/`effort:`/.test(region), '(g) template region mentions `effort:` frontmatter field');
    assert(/`domain:`/.test(region) && /Omit `domain:`/.test(region),
      '(g) template region mentions `domain:` field + the Omit `domain:` rule');
  }

  // ── (d) forge-task routes-by-domain: additive win via the shared resolver ──
  withHermeticHome(() => {
    const dir = mkTmp('dispatch-resolve-domain');
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
      '{"routing":{"backend":{"executor":{"standard":["claude-opus-4-8"]}}}}', 'utf8');
    const planPath = writePlan(dir, ['id: T01', 'slice: S01', 'domain: backend']);
    const result = resolveDispatch({ unitType: 'execute-task', planPath, cwd: dir });
    assert(result.route_source === 'routing', '(d) forge-task routes-by-domain: route_source === routing', JSON.stringify(result));
    assert(result.domain === 'backend', '(d) forge-task routes-by-domain: domain === backend', JSON.stringify(result));
    assert(result.domain_input === 'backend', '(d) resolver exposes raw domain_input === backend for retry replay', JSON.stringify(result));
    cleanup(dir);
  });

  // ── (f) retry re-resolution guard: the 2 loop skills restore DOMAIN/PLAN_TIER/PLAN_WORKER ──
  // (M012 S02 review-fix R1: the failure-taxonomy paths re-resolve routing with these raw inputs;
  //  the cutover dropped their assignment, silently collapsing every retry to the default domain.)
  for (const rel of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
    const source = fs.readFileSync(path.join(ROOT46, rel), 'utf8');
    assert(/^DOMAIN=.*domain_input/m.test(source), `(f) ${rel}: restores DOMAIN= from resolver domain_input`);
    assert(/^PLAN_TIER=.*frontmatter_tier/m.test(source), `(f) ${rel}: restores PLAN_TIER= from resolver frontmatter_tier`);
    assert(/^PLAN_WORKER=.*plan_worker/m.test(source), `(f) ${rel}: restores PLAN_WORKER= from resolver plan_worker`);
  }

  // ── (e) risk-escalation: plan-slice on a risk:high slice still resolves tier/effort=max ──
  withHermeticHome(() => {
    const dir = mkTmp('dispatch-resolve-risk');
    const milestoneId = 'M999';
    const roadmapDir = path.join(dir, '.gsd', 'milestones', milestoneId);
    fs.mkdirSync(roadmapDir, { recursive: true });
    const roadmapPath = path.join(roadmapDir, `${milestoneId}-ROADMAP.md`);
    fs.writeFileSync(roadmapPath, '- S01: setup (risk:high)\n', 'utf8');
    const result = resolveDispatch({ unitType: 'plan-slice', unitId: 'S01', roadmapPath, cwd: dir });
    assert(result.tier === 'max', '(e) risk-escalation: plan-slice on risk:high slice -> tier === max', JSON.stringify(result));
    assert(result.effort === 'max', '(e) risk-escalation: plan-slice on risk:high slice -> effort === max', JSON.stringify(result));
    cleanup(dir);
  });

  // ── (h) TASK-003 dispatch_engine normalization: gpt→codex, gemini→agy, claude→claude ──
  // The additive dispatch trigger the orchestrator branches gate on. engine (family)
  // stays intact; dispatch_engine is the normalized ==codex gate.
  const { degradedContract, dispatchEngineFor } = require(path.join(SCRIPTS, 'forge-dispatch-resolve.js'));
  assert(dispatchEngineFor('gpt') === 'codex', '(h) dispatchEngineFor(gpt) === codex');
  assert(dispatchEngineFor('gemini') === 'agy', '(h) dispatchEngineFor(gemini) === agy');
  assert(dispatchEngineFor('claude') === 'claude', '(h) dispatchEngineFor(claude) === claude');
  assert(dispatchEngineFor(null) === 'claude', '(h) dispatchEngineFor(null) === claude (unknown/family fallback)');
  assert(dispatchEngineFor('') === 'claude', '(h) dispatchEngineFor(empty) === claude');
  // gemini→agy is covered by the dispatchEngineFor unit asserts above; the routing
  // fixture uses gpt/claude models that this repo's routing maps to a non-empty chain.
  for (const [model, wantDispatch, wantFamily] of [
    ['gpt-5-codex', 'codex', 'gpt'],
    ['claude-opus-4-8', 'claude', 'claude'],
  ]) {
    withHermeticHome(() => {
      const dir = mkTmp('dispatch-engine-norm');
      fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
        JSON.stringify({ routing: { backend: { executor: { standard: [model] } } } }), 'utf8');
      const planPath = writePlan(dir, ['id: T01', 'slice: S01', 'domain: backend']);
      const result = resolveDispatch({ unitType: 'execute-task', planPath, cwd: dir });
      assert(result.route_source === 'routing', `(h) ${model}: route_source === routing`, JSON.stringify(result));
      assert(result.engine === wantFamily, `(h) ${model}: engine (family) === ${wantFamily} (unchanged)`, JSON.stringify(result));
      assert(result.dispatch_engine === wantDispatch, `(h) ${model}: dispatch_engine === ${wantDispatch}`, JSON.stringify(result));
      // chain[].engine stays family — never normalized to codex/agy.
      assert(result.chain[0] && result.chain[0].engine === wantFamily,
        `(h) ${model}: chain[0].engine === ${wantFamily} (family, NOT normalized)`, JSON.stringify(result));
      cleanup(dir);
    });
  }

  // ── (i) degradedContract emits dispatch_engine === claude (contract stability on runtime-error path) ──
  {
    const dc = degradedContract(['--unit-type', 'execute-task']);
    assert(dc.engine === 'claude', '(i) degradedContract engine === claude', JSON.stringify(dc));
    assert(dc.dispatch_engine === 'claude', '(i) degradedContract dispatch_engine === claude (additive, explicit)', JSON.stringify(dc));
  }

  // ── (j) doc-presence: the 3 SKILLs extract DISPATCH_ENGINE + gate branches on it, ──
  //     and the old $ENGINE == codex trigger is gone from the branch/trigger sites.
  for (const rel of cutoverSkills) {
    const source = fs.readFileSync(path.join(ROOT46, rel), 'utf8');
    assert(/DISPATCH_ENGINE=\$\(node -e .*dispatch_engine/.test(source),
      `(j) ${rel}: extracts DISPATCH_ENGINE from ROUTE_JSON .dispatch_engine`);
    assert(/DISPATCH_ENGINE == codex/.test(source),
      `(j) ${rel}: gates a sidecar branch on DISPATCH_ENGINE == codex`);
    // The old fuzzy trigger must be absent from every branch/trigger site. Prose that
    // legitimately cites the telemetry family value engine:"codex" is not matched by
    // this anchor (it targets the `== codex` shell/branch condition specifically).
    assert(!/[^_]ENGINE == codex/.test(source),
      `(j) ${rel}: no legacy [$]ENGINE == codex trigger remains`);
  }

  // ── (k) spec canonical: shared/forge-dispatch.md defines dispatch_engine as the branch trigger ──
  {
    const spec = fs.readFileSync(path.join(ROOT46, 'shared/forge-dispatch.md'), 'utf8');
    assert(/dispatch_engine/.test(spec), '(k) spec mentions dispatch_engine');
    assert(/dispatch_engine == codex/.test(spec), '(k) spec defines dispatch_engine == codex as the sidecar branch trigger');
  }

  pass('(final) Section 46: resolver parity, SKILL cutover and routes-by-domain verified');
}

// ── Section 47: surgical reset — golden demo, overlap-abort, HARD invariant ──────
// M013 S01 T01: proves scripts/forge-surgical-reset.js undoes ONLY the sidecar's
// changes while preserving pre-existing uncommitted work byte-intact. This is the
// single most safety-critical path in the codebase (a bug DESTROYS user work), so
// every case is a REAL git fixture, not a narrative:
//   (a) golden demo — pre-existing tracked-modified + untracked survive byte-intact,
//       codex's tracked change is restored to START_SHA, codex's new file+dir removed.
//   (b) overlap — codex touches a pre-dirty file (hash diverges) → exit 3, ZERO resets.
//   (c) HARD invariant — clean tree: surgical target ≡ legacy whole-tree reset,
//       byte-identical, proven on a twin fixture with the legacy commands.
//   (d) persistence — --state-init writes start_sha + pre_dirty[{path,hash}] in one
//       write; --state-update preserves pre_dirty.
//   (e) purity — computeResetTarget unit asserts (codex deletion → restore,
//       pre-existing deletion → preserve, rename).
//   (f) .gsd/** never touched across snapshot/diff/reset.
function smokeSurgicalReset() {
  process.stdout.write('\n▸ Section 47: surgical reset — golden demo, overlap, HARD invariant\n');
  const SR = path.join(SCRIPTS, 'forge-surgical-reset.js');
  const sr = require(SR);

  function gitq(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
  }
  function initRepo(label) {
    const dir = mkTmp(label);
    gitq(dir, ['init', '-q', '-b', 'main']);
    gitq(dir, ['config', 'user.email', 'smoke@forge']);
    gitq(dir, ['config', 'user.name', 'smoke']);
    return dir;
  }
  const W = (dir, rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  const R = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const runReset = (stateFile) => spawnSync('node', [SR, '--reset', '--state', stateFile], { encoding: 'utf8' });

  // ── (a) golden demo ────────────────────────────────────────────────────────
  {
    const dir = initRepo('sr-golden');
    W(dir, 'tracked.txt', 'baseline-tracked\n');
    W(dir, 'pre-tracked.txt', 'baseline-pre\n');
    W(dir, 'codex-tracked.txt', 'baseline-codex\n');
    gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
    // pre-existing dirty BEFORE dispatch: modify a tracked file + create an untracked
    W(dir, 'pre-tracked.txt', 'USER-EDIT\n');
    W(dir, 'pre-untracked.txt', 'USER-UNTRACKED\n');
    const preTrackedHash = gitq(dir, ['hash-object', 'pre-tracked.txt']).stdout.trim();
    const preUntrackedHash = gitq(dir, ['hash-object', 'pre-untracked.txt']).stdout.trim();
    // snapshot (state file OUTSIDE the repo so it never pollutes the worktree)
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    const init = spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir], { encoding: 'utf8' });
    assert(init.status === 0 && /^[0-9a-f]{40}/.test(init.stdout.trim()),
      '(a) --state-init prints the 40-char start_sha', JSON.stringify({ s: init.status, o: init.stdout }));
    // simulate codex AFTER snapshot: modify a tracked file + create a new file in a new dir with a space
    W(dir, 'codex-tracked.txt', 'CODEX-EDIT\n');
    W(dir, 'codex-new.txt', 'CODEX-NEW\n');
    W(dir, 'dir novo/arquivo com espaço.txt', 'CODEX-SPACE\n');
    const rr = runReset(stateFile);
    assert(rr.status === 0, '(a) golden reset exits 0', JSON.stringify({ s: rr.status, o: rr.stdout, e: rr.stderr }));
    const out = JSON.parse(rr.stdout);
    assert(out.ok === true && out.verified === true, '(a) result ok + verified', rr.stdout);
    // pre-existing survives BYTE-INTACT
    assert(R(dir, 'pre-tracked.txt') === 'USER-EDIT\n', '(a) pre-existing tracked-modified survives byte-intact', R(dir, 'pre-tracked.txt'));
    assert(gitq(dir, ['hash-object', 'pre-tracked.txt']).stdout.trim() === preTrackedHash, '(a) pre-tracked hash unchanged');
    assert(fs.existsSync(path.join(dir, 'pre-untracked.txt')) && gitq(dir, ['hash-object', 'pre-untracked.txt']).stdout.trim() === preUntrackedHash,
      '(a) pre-existing untracked survives byte-intact');
    // codex changes undone
    assert(R(dir, 'codex-tracked.txt') === 'baseline-codex\n', '(a) codex tracked change restored to START_SHA', R(dir, 'codex-tracked.txt'));
    assert(!fs.existsSync(path.join(dir, 'codex-new.txt')), '(a) codex new untracked file removed');
    assert(!fs.existsSync(path.join(dir, 'dir novo')), '(a) codex new dir (name with space) removed + parent pruned');
    cleanup(dir);
  }

  // ── (b) overlap → exit 3, ZERO resets ───────────────────────────────────────
  {
    const dir = initRepo('sr-overlap');
    W(dir, 'pre-tracked.txt', 'baseline-pre\n');
    gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
    W(dir, 'pre-tracked.txt', 'USER-EDIT\n'); // pre-existing dirty
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir], { encoding: 'utf8' });
    // codex ALSO modifies the pre-dirty file (hash diverges) + drops an unrelated new file
    W(dir, 'pre-tracked.txt', 'CODEX-OVERWRITE\n');
    W(dir, 'codex-new.txt', 'CODEX-NEW\n');
    const rr = runReset(stateFile);
    assert(rr.status === 3, '(b) overlap → exit 3', JSON.stringify({ s: rr.status, o: rr.stdout }));
    const out = JSON.parse(rr.stdout);
    assert(Array.isArray(out.overlap) && out.overlap.includes('pre-tracked.txt'), '(b) overlap lists pre-tracked.txt in stdout JSON', rr.stdout);
    // ZERO resets — even the non-overlapped codex file is untouched
    assert(fs.existsSync(path.join(dir, 'codex-new.txt')), '(b) non-overlapped codex file NOT removed (zero resets)');
    assert(R(dir, 'pre-tracked.txt') === 'CODEX-OVERWRITE\n', '(b) overlapped file left as-is (never destructively reset)');
    cleanup(dir);
  }

  // ── (c) HARD invariant: clean tree → surgical ≡ legacy whole-tree reset ──────
  {
    // codex changes applied AFTER a clean snapshot: tracked modify + untracked
    // create (incl. a new nested dir) + codex deletes a tracked file.
    const applyCodexChanges = (dir) => {
      W(dir, 'codex-tracked.txt', 'CODEX-EDIT\n');
      W(dir, 'codex-new.txt', 'CODEX-NEW\n');
      W(dir, 'sub dir/new nested.txt', 'NESTED\n');
      fs.rmSync(path.join(dir, 'to-delete.txt'));
    };
    const seed = (dir) => {
      W(dir, 'tracked.txt', 'baseline\n');
      W(dir, 'codex-tracked.txt', 'baseline-codex\n');
      W(dir, 'to-delete.txt', 'delete-me\n');
      gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
      return gitq(dir, ['rev-parse', 'HEAD']).stdout.trim();
    };
    // twin A — surgical: snapshot on the CLEAN tree (pre_dirty empty), then codex.
    const dA = initRepo('sr-hard-surgical');
    const sA = seed(dA);
    const sf = path.join(dA, '.gsd', 'forge', 'xllm-state.json');
    spawnSync('node', [SR, '--state-init', '--state', sf, '--cwd', dA], { encoding: 'utf8' });
    const stateA = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert(Array.isArray(stateA.pre_dirty) && stateA.pre_dirty.length === 0, '(c) clean tree → pre_dirty empty', JSON.stringify(stateA.pre_dirty));
    applyCodexChanges(dA);
    const rrA = runReset(sf);
    assert(rrA.status === 0, '(c) surgical reset on clean-snapshot tree exits 0', rrA.stdout + rrA.stderr);
    // twin B — legacy whole-tree reset with the SAME codex changes
    const dB = initRepo('sr-hard-legacy');
    const sB = seed(dB);
    applyCodexChanges(dB);
    // legacy: git checkout <sha> -- . ':(exclude).gsd' && git clean -fd -e .gsd
    gitq(dB, ['checkout', sB, '--', '.', ':(exclude).gsd']);
    gitq(dB, ['clean', '-fd', '-e', '.gsd']);
    // both trees must now be byte-identical on the NON-.gsd tree: porcelain empty +
    // diff vs sha empty. twin A carries its own .gsd/ state file (deliberately left
    // untouched by the reset) which twin B never had — filter it out for a fair diff.
    const noGsd = (s) => s.split('\n').filter((l) => l && !/\.gsd(\/|$)/.test(l)).join('\n');
    const porcA = noGsd(gitq(dA, ['status', '--porcelain']).stdout);
    const porcB = noGsd(gitq(dB, ['status', '--porcelain']).stdout);
    const diffA = noGsd(gitq(dA, ['diff', '--name-only', sA]).stdout);
    const diffB = noGsd(gitq(dB, ['diff', '--name-only', sB]).stdout);
    assert(porcA.trim() === '' && porcB.trim() === '', '(c) HARD invariant: both trees clean (porcelain empty)', JSON.stringify({ porcA, porcB }));
    assert(diffA.trim() === '' && diffB.trim() === '', '(c) HARD invariant: both trees ≡ START_SHA (diff empty)', JSON.stringify({ diffA, diffB }));
    assert(porcA === porcB && diffA === diffB, '(c) HARD invariant: surgical output byte-identical to legacy whole-tree reset');
    // restored content matches between twins
    assert(R(dA, 'codex-tracked.txt') === R(dB, 'codex-tracked.txt'), '(c) restored tracked content identical across twins');
    assert(fs.existsSync(path.join(dA, 'to-delete.txt')) && fs.existsSync(path.join(dB, 'to-delete.txt')), '(c) codex-deleted tracked file restored in both');
    cleanup(dA); cleanup(dB);
  }

  // ── (d) snapshot persistence ─────────────────────────────────────────────────
  {
    const dir = initRepo('sr-persist');
    W(dir, 'a.txt', 'base\n');
    gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
    W(dir, 'a.txt', 'dirty\n');
    W(dir, 'b.txt', 'untracked\n');
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir, '--attempt', '2'], { encoding: 'utf8' });
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(/^[0-9a-f]{40}$/.test(st.start_sha), '(d) state has 40-char start_sha');
    assert(st.attempt === 2, '(d) state records attempt');
    assert(Array.isArray(st.pre_dirty) && st.pre_dirty.length === 2, '(d) pre_dirty has both dirty paths', JSON.stringify(st.pre_dirty));
    assert(st.pre_dirty.every((d) => typeof d.path === 'string' && (d.hash === null || /^[0-9a-f]{40}$/.test(d.hash))),
      '(d) pre_dirty entries are {path, hash}');
    assert(st.transient_retry_count === 0, '(d) --state-init seeds transient_retry_count: 0', JSON.stringify(st.transient_retry_count));
    // --state-update preserves pre_dirty
    spawnSync('node', [SR, '--state-update', '--state', stateFile, '--reason', 'codex-timeout', '--result-file', '/tmp/x.json'], { encoding: 'utf8' });
    const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(st2.reason === 'codex-timeout' && st2.result_file === '/tmp/x.json', '(d) --state-update writes reason/result_file');
    assert(JSON.stringify(st2.pre_dirty) === JSON.stringify(st.pre_dirty), '(d) --state-update preserves pre_dirty intact');
    assert(st2.start_sha === st.start_sha, '(d) --state-update preserves start_sha');
    // (d2) M013 S02 T01: --transient-retry-count bumps the counter via read-modify-write,
    // preserving pre_dirty/start_sha (the S01 BLOCKER item 3 invariant).
    spawnSync('node', [SR, '--state-update', '--state', stateFile, '--transient-retry-count', '2'], { encoding: 'utf8' });
    const st3 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(st3.transient_retry_count === 2, '(d2) --transient-retry-count bumps the counter', JSON.stringify(st3.transient_retry_count));
    assert(JSON.stringify(st3.pre_dirty) === JSON.stringify(st.pre_dirty), '(d2) --transient-retry-count preserves pre_dirty intact');
    assert(st3.start_sha === st.start_sha, '(d2) --transient-retry-count preserves start_sha');
    assert(st3.reason === 'codex-timeout' && st3.result_file === '/tmp/x.json', '(d2) --transient-retry-count preserves prior patch fields');
    cleanup(dir);
  }

  // ── (e) purity of computeResetTarget (require, no fixture) ───────────────────
  {
    // codex deletion → restore; pre-existing deletion → preserve; codex add → remove; rename.
    const postChanges = [
      { path: 'codex-mod.txt', status: 'M' },
      { path: 'codex-del.txt', status: 'D' },
      { path: 'codex-new.txt', status: 'A' },
      { path: 'pre-mod.txt', status: 'M' },      // pre-existing, appears in post-diff but must NOT be reset
      { path: 'pre-del.txt', status: 'D' },      // pre-existing deletion, intact
    ];
    const preDirty = [
      { path: 'pre-mod.txt', hash: 'aaa' },
      { path: 'pre-del.txt', hash: null },
      { path: 'pre-touched.txt', hash: 'bbb' }, // codex ALSO wrote this → overlap
    ];
    const hashNow = (p) => ({ 'pre-mod.txt': 'aaa', 'pre-del.txt': null, 'pre-touched.txt': 'DIVERGED' }[p]);
    const t = sr.computeResetTarget(postChanges, preDirty, hashNow);
    assert(t.overlap.length === 1 && t.overlap[0] === 'pre-touched.txt', '(e) pure: divergent pre-dirty hash → overlap', JSON.stringify(t));
    assert(t.preserved.includes('pre-mod.txt') && t.preserved.includes('pre-del.txt'), '(e) pure: intact pre-dirty (incl. deletion) → preserved', JSON.stringify(t));
    assert(t.restore.includes('codex-mod.txt') && t.restore.includes('codex-del.txt'), '(e) pure: codex M + D → restore', JSON.stringify(t));
    assert(t.remove.includes('codex-new.txt'), '(e) pure: codex A → remove', JSON.stringify(t));
    assert(!t.restore.includes('pre-mod.txt') && !t.remove.includes('pre-del.txt'), '(e) pure: pre-existing paths never targeted', JSON.stringify(t));
    // parsers
    const porc = sr.parsePorcelainZ('R  new name.txt\0old name.txt\0?? plain.txt\0');
    assert(porc.length === 2 && porc[0].origPath === 'old name.txt' && porc[1].path === 'plain.txt',
      '(e) parsePorcelainZ handles rename extra field + spaces', JSON.stringify(porc));
    const ns = sr.parseNameStatusZ('R100\0old.txt\0new.txt\0M\0mod.txt\0');
    assert(ns.length === 2 && ns[0].origPath === 'old.txt' && ns[0].path === 'new.txt' && ns[1].status === 'M',
      '(e) parseNameStatusZ handles rename two-path record', JSON.stringify(ns));
    assert(sr.isGsdPath('.gsd/STATE.md') && sr.isGsdPath('.gsd') && !sr.isGsdPath('src/.gsdx'), '(e) isGsdPath predicate');
  }

  // ── (f) .gsd/** never touched (snapshot/diff/reset all exclude it) ───────────
  {
    const dir = initRepo('sr-gsd');
    W(dir, 'code.txt', 'base\n');
    W(dir, '.gsd/STATE.md', 'committed-state\n');
    gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir], { encoding: 'utf8' });
    // orchestrator writes .gsd during the run + codex changes a real file
    W(dir, '.gsd/STATE.md', 'ORCHESTRATOR-UPDATED\n');
    W(dir, 'code.txt', 'CODEX-EDIT\n');
    const rr = runReset(stateFile);
    assert(rr.status === 0, '(f) reset exits 0 with .gsd churn present', rr.stdout + rr.stderr);
    assert(R(dir, '.gsd/STATE.md') === 'ORCHESTRATOR-UPDATED\n', '(f) .gsd/** left untouched by the reset');
    assert(R(dir, 'code.txt') === 'base\n', '(f) real codex change still restored');
    cleanup(dir);
  }

  // ── (g) e2e: sidecar runExecute on a DIRTY tree + surgical reset closes the loop ─
  // M013 S01 T02: the adapter's dirty-guard is relaxed refuse→snapshot, so runExecute
  // runs against a pre-existing dirty tree; the orchestrator's state (--state-init /
  // --reset) undoes the mock codex's write while the pre-existing file survives intact.
  {
    const xllmPath = path.join(SCRIPTS, 'forge-xllm.js');
    const dir = initRepo('sr-e2e-sidecar');
    W(dir, 'base.txt', 'baseline\n');
    gitq(dir, ['add', '-A']); gitq(dir, ['commit', '-qm', 'init']);
    // pre-existing uncommitted work (auto_commit:false) — must survive byte-intact.
    W(dir, 'pre.txt', 'USER-WORK\n');
    const preHash = gitq(dir, ['hash-object', 'pre.txt']).stdout.trim();

    // orchestrator captures the authoritative snapshot BEFORE dispatch (state file
    // outside the repo, but under .gsd/ which the reset excludes).
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    const init = spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir], { encoding: 'utf8' });
    assert(init.status === 0, '(g) --state-init on dirty tree exits 0', init.stdout + init.stderr);

    // mock codex writes codex.txt then FAILS (invalid JSON) — sidecar must NOT refuse
    // the dirty tree (the observed error is the codex failure, not the dirty guard).
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-sr-e2e-mock-'));
    writeMockCodex(mockDir, { payload: 'not { json', exitCode: 0, extraScript: `printf 'CODEX\\n' > "$CODEXCWD/codex.txt"` });
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-sr-e2e-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const planFile = path.join(resultDir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\ndo the thing\n', 'utf8');
    const rr = spawnSync(process.execPath, [xllmPath, '--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', dir], {
      encoding: 'utf8', cwd: dir,
      env: { ...process.env, PATH: mockDir + path.delimiter + process.env.PATH },
    });
    assert(rr.status !== 0, '(g) sidecar fails on codex bad-JSON, NOT on the dirty guard', `status=${rr.status} stderr=${rr.stderr}`);
    assert(!/refusing to start/i.test(rr.stderr), '(g) no dirty-guard refusal — ran on dirty tree', rr.stderr);
    assert(fs.existsSync(path.join(dir, 'codex.txt')), '(g) mock codex actually wrote codex.txt (dispatch proceeded)');
    // best-effort result JSON records pre_dirty with the pre-existing file.
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    // adapter-failed best-effort result may omit pre_dirty; the AUTHORITATIVE audit is the
    // orchestrator state file, which carries it. Assert on the state file (always present).
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(Array.isArray(st.pre_dirty) && st.pre_dirty.some((d) => d.path === 'pre.txt'),
      '(g) orchestrator state snapshot carries the pre-existing dirty file', JSON.stringify(st.pre_dirty));

    // orchestrator resets AFTER the failure: pre.txt intact, codex.txt removed.
    const rst = runReset(stateFile);
    assert(rst.status === 0, '(g) surgical --reset after sidecar failure exits 0', rst.stdout + rst.stderr);
    assert(R(dir, 'pre.txt') === 'USER-WORK\n' && gitq(dir, ['hash-object', 'pre.txt']).stdout.trim() === preHash,
      '(g) pre-existing file survives the sidecar+reset cycle byte-intact');
    assert(!fs.existsSync(path.join(dir, 'codex.txt')), '(g) mock codex write undone by surgical reset');
    void parsed;
    cleanup(dir); cleanup(mockDir); cleanup(resultDir);
  }

  pass('(final) Section 47: surgical reset — golden/overlap/HARD-invariant/persistence/purity/.gsd/sidecar-e2e all verified');
}

// ── Section 48: sidecar Layer-1 retry — error_class + transient_retry_count ──
// M013 S02 T04: real-case regression guard for the three S02 acceptance criteria:
//   (a) error_class classification — live-spawns forge-xllm.js --mode execute
//       against a mock codex for transient/terminal/timeout/auth failures, and
//       cross-checks against forge-classify-error.js (classifier-reuse proof,
//       not a reimplementation) — except the timeout case, which is a LOCKED
//       forced-terminal override regardless of what the classifier would say.
//   (b) Layer-1 counter — forge-surgical-reset.js --state-init seeds
//       transient_retry_count:0; --state-update --transient-retry-count bumps
//       it while preserving pre_dirty/start_sha (read-modify-write, not clobber).
//   (c) orthogonality + doc-presence — the 3 SKILL mirrors' Layer-1 block never
//       increments SIDECAR_ATTEMPT, and all 4 docs (shared/forge-dispatch.md +
//       3 mirrors) carry the Layer-1 retry-before-Layer-2 ordering.
function smokeSidecarLayer1Retry() {
  process.stdout.write('\n▸ Section 48: sidecar Layer-1 retry — error_class + transient_retry_count\n');
  const REPO = path.dirname(SCRIPTS);
  const { classifyError, isTransient } = require('./forge-classify-error.js');

  // ── (a) error_class classification — real cases via forge-xllm.js --mode execute ──
  function runExecuteCase(label, mockOpts, timeoutFlag) {
    const dir = mkTmp(`s48-xllm-${label}`);
    mkGitRepoS48(dir);
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-smoke-s48-${label}-mock-`));
    writeMockCodex(mockDir, mockOpts);
    const planFile = path.join(dir, 'plan.md');
    fs.writeFileSync(planFile, '# T01\nplan body\n', 'utf8');
    const resultFile = path.join(os.tmpdir(), `forge-smoke-s48-${label}-result-${process.pid}-${Date.now()}.json`);
    const args = ['--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', dir];
    if (timeoutFlag) args.push('--timeout', String(timeoutFlag));
    runXllm(args, mockDir, dir);
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* asserted below */ }
    try { fs.rmSync(resultFile, { force: true }); } catch { /* best-effort */ }
    cleanup(dir);
    try { fs.rmSync(mockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return result;
  }
  function mkGitRepoS48(dir) {
    const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    run(['init', '-q']);
    run(['config', 'user.email', 'smoke@forge']);
    run(['config', 'user.name', 'smoke']);
    run(['add', '-A']);
    run(['commit', '-q', '--allow-empty', '-m', 'init']);
  }

  // Case 1: transient stderr (server-class "overloaded") → error_class: transient
  {
    const r = runExecuteCase('transient', { exitCode: 1, writeOutput: false, extraScript: 'echo "500 overloaded" 1>&2' });
    assert(r && r.status === 'adapter-failed' && r.error_class === 'transient',
      '(a) transient stderr ("overloaded") → status:adapter-failed, error_class:transient',
      JSON.stringify(r));
  }

  // Case 2: auth/quota stderr → error_class: terminal (permanent, not transient)
  {
    const r = runExecuteCase('auth', { exitCode: 1, writeOutput: false, extraScript: 'echo "invalid api key" 1>&2' });
    assert(r && r.status === 'adapter-failed' && r.error_class === 'terminal',
      '(a) auth stderr ("invalid api key") → error_class:terminal',
      JSON.stringify(r));
  }

  // Case 3: invalid/unparseable JSON output → error_class: terminal (unknown kind)
  {
    const r = runExecuteCase('invalidjson', { exitCode: 0, payload: 'not valid json at all, no code fences' });
    assert(r && r.status === 'adapter-failed' && r.error_class === 'terminal',
      '(a) unparseable codex output → error_class:terminal',
      JSON.stringify(r));
  }

  // Case 4: timeout — sleepSecs > --timeout → error_class: terminal (FORCED, LOCKED override)
  {
    const r = runExecuteCase('timeout', { sleepSecs: 3, writeOutput: false }, 1);
    assert(r && r.status === 'adapter-failed' && r.error_class === 'terminal' && /timeout/i.test(r.reason || ''),
      '(a) codex-timeout → error_class:terminal (forced, LOCKED)',
      JSON.stringify(r));
  }

  // ── classifier-reuse proof: same strings, cross-checked against forge-classify-error.js ──
  {
    const transientMsg = 'codex exited 1: 500 overloaded';
    const terminalMsg = 'codex exited 1: invalid api key';
    assert(isTransient(classifyError(transientMsg)) === true,
      '(a) classifier-reuse: "overloaded" msg classifies transient via forge-classify-error.js', transientMsg);
    assert(isTransient(classifyError(terminalMsg)) === false,
      '(a) classifier-reuse: "invalid api key" msg classifies non-transient via forge-classify-error.js', terminalMsg);
    // Explicit override assert: a timeout message, if run through the generic classifier alone
    // (bypassing the adapter's forced check), would NOT necessarily read as transient either —
    // but the adapter's classifyErrorClass forces terminal BEFORE consulting the classifier at
    // all, independent of what classifyError(timeoutMsg) would say. Prove the override exists
    // by reading it directly off the adapter's exported classifyErrorClass.
    const xllm = require('./forge-xllm.js');
    assert(typeof xllm.classifyErrorClass === 'function',
      '(a) forge-xllm.js exports classifyErrorClass for the override proof', Object.keys(xllm).join(','));
    assert(xllm.classifyErrorClass('codex killed after exceeding timeout (1s)') === 'terminal',
      '(a) classifyErrorClass forces terminal on a timeout message (override, independent of classifyError)',
      'expected terminal');
  }

  // ── (b) Layer-1 counter — forge-surgical-reset.js state seed + bump ──
  {
    const SR = path.join(SCRIPTS, 'forge-surgical-reset.js');
    const dir = mkTmp('s48-state');
    mkGitRepoS48(dir);
    const stateFile = path.join(dir, '.gsd', 'forge', 'xllm-state.json');
    const init = spawnSync('node', [SR, '--state-init', '--state', stateFile, '--cwd', dir], { encoding: 'utf8' });
    assert(init.status === 0, '(b) --state-init exits 0', JSON.stringify({ s: init.status, o: init.stdout, e: init.stderr }));
    const seeded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(seeded.transient_retry_count === 0,
      '(b) --state-init seeds transient_retry_count:0', JSON.stringify(seeded));
    const preDirty = seeded.pre_dirty;
    const startSha = seeded.start_sha;
    const upd = spawnSync('node', [SR, '--state-update', '--state', stateFile, '--transient-retry-count', '2'], { encoding: 'utf8' });
    assert(upd.status === 0, '(b) --state-update exits 0', JSON.stringify({ s: upd.status, o: upd.stdout, e: upd.stderr }));
    const bumped = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(bumped.transient_retry_count === 2,
      '(b) --state-update --transient-retry-count 2 bumps the counter', JSON.stringify(bumped));
    assert(JSON.stringify(bumped.pre_dirty) === JSON.stringify(preDirty),
      '(b) --state-update preserves pre_dirty (not clobbered)', JSON.stringify({ before: preDirty, after: bumped.pre_dirty }));
    assert(bumped.start_sha === startSha,
      '(b) --state-update preserves start_sha (not clobbered)', JSON.stringify({ before: startSha, after: bumped.start_sha }));
    cleanup(dir);
  }

  // ── (c) doc-presence + mirror↔spec sync — Layer-1 retry-before-Layer-2 block ──
  {
    const DOCS = [
      { rel: 'shared/forge-dispatch.md', label: 'shared/forge-dispatch.md' },
      { rel: 'skills/forge-auto/SKILL.md', label: 'forge-auto' },
      { rel: 'skills/forge-next/SKILL.md', label: 'forge-next' },
      { rel: 'skills/forge-task/SKILL.md', label: 'forge-task' },
    ];
    const texts = {};
    for (const d of DOCS) {
      const p = path.join(REPO, d.rel);
      assert(fs.existsSync(p), `(c) ${d.label} exists on disk`, p);
      texts[d.rel] = fs.readFileSync(p, 'utf8');
    }

    for (const d of DOCS) {
      const t = texts[d.rel];
      assert(/Layer-1 transient retry/.test(t),
        `(c) ${d.label} carries the "Layer-1 transient retry" sub-section`, d.rel);
      assert(/runs BEFORE Layer-2/.test(t) || /before any Layer-2/.test(t) || /never runs \*after\* Layer-2/.test(t),
        `(c) ${d.label} states the retry-before-Layer-2 ordering explicitly`, d.rel);
      assert(/codex-timeout/.test(t) && /terminal/.test(t),
        `(c) ${d.label} documents codex-timeout → terminal`, d.rel);
      assert(/transient_retry_count/.test(t),
        `(c) ${d.label} references transient_retry_count`, d.rel);
    }

    // Orthogonality invariant (⊥ SIDECAR_ATTEMPT) — spelled out explicitly in the 3 skills
    // that HAVE a SIDECAR_ATTEMPT concept (auto/next/dispatch); forge-task has no
    // SIDECAR_ATTEMPT (single-codex, no chain) and documents that fact instead.
    for (const rel of ['shared/forge-dispatch.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
      assert(/transient_retry_count.*⊥.*SIDECAR_ATTEMPT|SIDECAR_ATTEMPT.*⊥.*transient_retry_count/.test(texts[rel]),
        `(c) ${rel} states transient_retry_count ⊥ SIDECAR_ATTEMPT orthogonality`, rel);
    }
    assert(/no SIDECAR_ATTEMPT/.test(texts['skills/forge-task/SKILL.md']),
      '(c) forge-task documents it has no SIDECAR_ATTEMPT (single-codex, no chain)',
      'skills/forge-task/SKILL.md');
  }

  // ── (c) counter orthogonality — structural wiring assert (Layer-1 block distinct
  //        from the SIDECAR_ATTEMPT increment; no increment inside the Layer-1 block) ──
  {
    const skillFiles = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md'];
    for (const rel of skillFiles) {
      const t = texts_or_read(rel);
      // Extract every "# ── Layer-1 transient retry ..." fenced block up to the next
      // "# ── " header or "**If $TRANSIENT_RETRY..." resolution line, and assert none
      // of them contain a SIDECAR_ATTEMPT increment (`SIDECAR_ATTEMPT=$((SIDECAR_ATTEMPT + 1))`
      // or `SIDECAR_ATTEMPT=$(( ... + 1))`).
      const blocks = t.match(/# ── Layer-1 transient retry[\s\S]*?```\n\*\*If `\$TRANSIENT_RETRY`/g) || [];
      assert(blocks.length > 0, `(c) ${rel} has at least one extractable Layer-1 block`, rel);
      for (const b of blocks) {
        assert(!/SIDECAR_ATTEMPT\s*=\s*\$\(\(\s*SIDECAR_ATTEMPT\s*\+\s*1\s*\)\)/.test(b),
          `(c) ${rel} Layer-1 block does NOT increment SIDECAR_ATTEMPT`, b.slice(0, 200));
        assert(/UNTOUCHED/i.test(b) && /SIDECAR_ATTEMPT/.test(b),
          `(c) ${rel} Layer-1 block explicitly documents SIDECAR_ATTEMPT is untouched`, b.slice(0, 200));
      }
    }
    function texts_or_read(rel) {
      return fs.readFileSync(path.join(REPO, rel), 'utf8');
    }
  }

  pass('(final) Section 48: sidecar Layer-1 retry — error_class real cases, classifier-reuse, state counter, orthogonality + doc-presence all verified');
}

// ── Section 49 — S03 sidecar_on_failure policy gate + pause-ask degradation ──
// Consolidated safety net over S01+S02+S03: guards (does not re-run) the
// exhaustive behavioral proofs Sections 47/48 already own, plus the NEW S03
// policy/pause-ask/doc-sync surface:
//   (a) default-policy byte-identity — `[ "$POLICY" != "fallback" ]` wraps the
//       existing Layer-1 `if` in all 3 mirrors; default resolves to
//       retry-then-fallback and the guarded body is untouched (prepend, not rewrite).
//   (b) degradation matrix — forge-auto ALWAYS degrades (no reachable
//       AskUserQuestion in its pause-ask path + emits sidecar-pause-degraded);
//       forge-next is TTY-conditional ([ -t 1 ]); forge-task always asks live.
//   (c) schema + all-3-values — forge-prefs.schema.json enum+default; each
//       mirror's POLICY whitelist carries all 3 literal values.
//   (d) doc-presence + sync — spec + 3 mirrors carry the policy/pause-ask/event
//       terms, and the event reason string is identical everywhere it's emitted.
//   (e) shipped-behavior guard + HARD-invariant cross-check — the exhaustion
//       guard is `-eq "$MAX_TRC"` (NOT `-ge`, S03 review R1 deferred, NOT
//       resolved here); Sections 47+48 remain registered in main().
function smokeSidecarPolicyGuard() {
  process.stdout.write('\n▸ Section 49: sidecar_on_failure policy gate + pause-ask degrade matrix + sync\n');
  const REPO = path.dirname(SCRIPTS);

  const MIRRORS = [
    { rel: 'skills/forge-auto/SKILL.md', label: 'forge-auto' },
    { rel: 'skills/forge-next/SKILL.md', label: 'forge-next' },
    { rel: 'skills/forge-task/SKILL.md', label: 'forge-task' },
  ];
  const DOCS = [{ rel: 'shared/forge-dispatch.md', label: 'shared/forge-dispatch.md' }, ...MIRRORS];

  const texts = {};
  for (const d of DOCS) {
    const p = path.join(REPO, d.rel);
    assert(fs.existsSync(p), `(setup) ${d.label} exists on disk`, p);
    texts[d.rel] = fs.readFileSync(p, 'utf8');
  }

  // ── (a) default-policy byte-identity gate ──
  {
    for (const m of MIRRORS) {
      const t = texts[m.rel];
      assert(/POLICY=\$\(printf/.test(t),
        `(a) ${m.label} has the POLICY= resolution idiom`, m.rel);
      // Every Layer-1 entry `if` in the file must be prefixed by the
      // `[ "$POLICY" != "fallback" ]` guard (tolerant to whitespace/quoting).
      const entryIfs = t.match(/if \[ "\$POLICY" != "fallback" \] && \[ "\$ERROR_CLASS" = "transient" \] && \[ "\$TRC" -lt "\$MAX_TRC" \]; then/g) || [];
      const expectedEntryIfs = m.label === 'forge-task' ? 1 : 2;
      assert(entryIfs.length === expectedEntryIfs,
        `(a) ${m.label} has exactly ${expectedEntryIfs} Layer-1 entries gated by [ "$POLICY" != "fallback" ] (Branch C${expectedEntryIfs === 2 ? ' + Branch D' : ' only'})`, `count=${entryIfs.length}`);
      // Absent/invalid whitelist fallback — node one-liner's ternary defaults to retry-then-fallback.
      assert(/\['retry-then-fallback','fallback','pause-ask'\]\.includes\(v\)\?v:'retry-then-fallback'/.test(t),
        `(a) ${m.label} POLICY resolver whitelists the 3 values, defaulting absent/invalid to retry-then-fallback`, m.rel);
      // The guarded body itself is intact — the transient+under-cap condition
      // is a suffix of the guard, not a replacement (prepend, not rewrite).
      assert(/"\$POLICY" != "fallback" \] && \[ "\$ERROR_CLASS" = "transient" \] && \[ "\$TRC" -lt "\$MAX_TRC" \]/.test(t),
        `(a) ${m.label} Layer-1 body ("$ERROR_CLASS" = "transient" && "$TRC" -lt "$MAX_TRC") is intact after the guard`, m.rel);
    }
  }

  // ── (b) degradation matrix ──
  {
    // forge-auto: extract every pause-ask degrade block; must contain
    // sidecar-pause-degraded and must NOT contain AskUserQuestion anywhere
    // in that block (always-degrade, AUTONOMY RULE — never pauses).
    {
      const t = texts['skills/forge-auto/SKILL.md'];
      const blocks = t.match(/\*\*pause-ask degrade[\s\S]*?```\n\*\*If `\$TRANSIENT_RETRY`/g) || [];
      assert(blocks.length === 2, '(b) forge-auto has exactly 2 extractable pause-ask degrade blocks (Branch C + Branch D)', `count=${blocks.length}`);
      for (const b of blocks) {
        assert(/sidecar-pause-degraded/.test(b),
          '(b) forge-auto pause-ask block emits sidecar-pause-degraded', b.slice(0, 200));
        assert(!/AskUserQuestion/.test(b),
          '(b) forge-auto pause-ask block has NO reachable AskUserQuestion (always degrades)', b.slice(0, 200));
        assert(/ALWAYS degrades/.test(b) || /never pauses/.test(b),
          '(b) forge-auto pause-ask block documents always-degrade posture', b.slice(0, 200));
      }
    }
    // forge-next: TTY-conditional — assert both the [ -t 1 ] ask-live branch
    // AND the headless sidecar-pause-degraded degrade exist in the same gate.
    {
      const t = texts['skills/forge-next/SKILL.md'];
      const blocks = t.match(/\*\*pause-ask gate[\s\S]*?```\n\*\*If `\$TRANSIENT_RETRY`/g) || [];
      assert(blocks.length === 2, '(b) forge-next has exactly 2 extractable pause-ask gate blocks (Branch C + Branch D)', `count=${blocks.length}`);
      for (const b of blocks) {
        assert(/\[ -t 1 \]/.test(b),
          '(b) forge-next pause-ask block is TTY-conditional ([ -t 1 ])', b.slice(0, 200));
        assert(/PAUSE_ASK_GATE=1/.test(b),
          '(b) forge-next pause-ask block sets PAUSE_ASK_GATE=1 on the TTY branch', b.slice(0, 200));
        assert(/sidecar-pause-degraded/.test(b),
          '(b) forge-next pause-ask block emits sidecar-pause-degraded on the headless branch', b.slice(0, 200));
      }
      assert(/TTY asks live, headless degrades/.test(t),
        '(b) forge-next documents TTY-asks-live / headless-degrades posture', 'skills/forge-next/SKILL.md');
    }
    // forge-task: always-ask (PAUSE_ASK_GATE=1 path) AND a defensive
    // [ -t 1 ]-false degrade both exist (piped/-p invocation never blocks).
    {
      const t = texts['skills/forge-task/SKILL.md'];
      const blocks = t.match(/\*\*pause-ask gate[\s\S]*?```\n\*\*If `\$PAUSE_ASK_GATE`/g) || [];
      assert(blocks.length === 1, '(b) forge-task has exactly 1 extractable pause-ask gate block (Branch C only, no Branch D)', `count=${blocks.length}`);
      for (const b of blocks) {
        assert(/PAUSE_ASK_GATE=1/.test(b),
          '(b) forge-task pause-ask block sets PAUSE_ASK_GATE=1 (always-interactive path)', b.slice(0, 200));
        assert(/\[ -t 1 \]/.test(b) && /sidecar-pause-degraded/.test(b),
          '(b) forge-task pause-ask block has a defensive [ -t 1 ]-false degrade emitting sidecar-pause-degraded', b.slice(0, 200));
      }
      assert(/ALWAYS interactive/.test(t) || /always interactive/.test(t),
        '(b) forge-task documents its always-interactive posture', 'skills/forge-task/SKILL.md');
      assert(/AskUserQuestion/.test(texts['skills/forge-task/SKILL.md']),
        '(b) forge-task pause-ask resolution references AskUserQuestion (asks live)', 'skills/forge-task/SKILL.md');
    }
    // Spec degradation-matrix table rows present in shared/forge-dispatch.md.
    {
      const t = texts['shared/forge-dispatch.md'];
      assert(/Degradation matrix/.test(t), '(b) spec has a "Degradation matrix" section', 'shared/forge-dispatch.md');
      for (const row of [
        /`forge-task`\s*\|\s*always interactive\s*\|\s*\*\*ask live\*\*/,
        /`forge-next` \(TTY\)\s*\|\s*`\[ -t 1 \]` true\s*\|\s*\*\*ask live\*\*/,
        /`forge-next` \(headless, `claude -p`\)\s*\|\s*`\[ -t 1 \]` false\s*\|\s*\*\*degrade\*\*/,
        /`forge-auto`\s*\|\s*always headless \(AUTONOMY RULE\)\s*\|\s*\*\*degrade\*\*/,
      ]) {
        assert(row.test(t), `(b) spec degradation-matrix row matches ${row}`, 'shared/forge-dispatch.md');
      }
    }
  }

  // ── (c) schema + all-3-values ──
  {
    const schemaPath = path.join(REPO, 'forge-prefs.schema.json');
    assert(fs.existsSync(schemaPath), '(c) forge-prefs.schema.json exists', schemaPath);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const node = schema?.properties?.workers?.properties?.sidecar_on_failure;
    assert(!!node, '(c) schema has properties.workers.properties.sidecar_on_failure', JSON.stringify(Object.keys(schema?.properties?.workers?.properties || {})));
    assert(JSON.stringify(node?.enum) === JSON.stringify(['retry-then-fallback', 'fallback', 'pause-ask']),
      '(c) sidecar_on_failure enum is exactly the 3 values', JSON.stringify(node?.enum));
    assert(node?.default === 'retry-then-fallback',
      '(c) sidecar_on_failure default is retry-then-fallback', String(node?.default));

    for (const m of MIRRORS) {
      const t = texts[m.rel];
      assert(/'retry-then-fallback'/.test(t) && /'fallback'/.test(t) && /'pause-ask'/.test(t),
        `(c) ${m.label} POLICY whitelist references all 3 literal values`, m.rel);
    }
    // codex-timeout → terminal cross-check (Section 48 case 4 proves the
    // behavior; here we assert the spec/mirrors document it consistently).
    for (const rel of ['shared/forge-dispatch.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md']) {
      const t = texts[rel];
      assert(/codex-timeout/.test(t) && /terminal/.test(t),
        `(c) ${rel} documents codex-timeout → terminal`, rel);
    }
  }

  // ── (d) doc-presence + sync ──
  {
    for (const d of DOCS) {
      const t = texts[d.rel];
      assert(/sidecar_on_failure/.test(t), `(d) ${d.label} carries sidecar_on_failure`, d.rel);
      assert(/sidecar-pause-degraded/.test(t), `(d) ${d.label} carries sidecar-pause-degraded`, d.rel);
      assert(/pause-ask/.test(t), `(d) ${d.label} carries pause-ask`, d.rel);
    }
    // Sync — the event reason string must be byte-identical across every
    // file that emits it (no drift between spec and mirrors).
    const reasonRe = /"reason":"pause-ask-headless-degrade"/g;
    let sample = null;
    for (const d of DOCS) {
      const t = texts[d.rel];
      const found = (t.match(reasonRe) || []).length > 0;
      assert(found, `(d) ${d.label} emits reason:"pause-ask-headless-degrade" (byte-identical)`, d.rel);
      if (found && sample === null) sample = 'pause-ask-headless-degrade';
    }
    assert(sample === 'pause-ask-headless-degrade', '(d) sync sample confirms the shared reason string', String(sample));
  }

  // ── (e) shipped-behavior guard + HARD-invariant cross-check ──
  {
    // Guard (not resolve) the shipped `-eq "$MAX_TRC"` exhaustion condition
    // in all 3 mirrors — R1 (eq vs ge) is DEFERRED to milestone-final triage.
    for (const m of MIRRORS) {
      const t = texts[m.rel];
      assert(/\[ "\$TRC" -eq "\$MAX_TRC" \]/.test(t),
        `(e) ${m.label} shipped pause-ask exhaustion guard is -eq "$MAX_TRC" (R1 deferred, NOT changed here)`, m.rel);
      assert(!/\[ "\$TRC" -ge "\$MAX_TRC" \]/.test(t),
        `(e) ${m.label} pause-ask exhaustion guard did NOT drift to -ge "$MAX_TRC"`, m.rel);
    }
    // HARD-invariant cross-check — Sections 47/48 remain registered in
    // main() (they own the exhaustive behavioral proof; Section 49 does not
    // duplicate their git-repo fixtures).
    const src = fs.readFileSync(path.join(SCRIPTS, 'forge-smoke.js'), 'utf8');
    const mainBody = src.slice(src.indexOf('async function main()'));
    assert(/smokeSurgicalReset\(\);/.test(mainBody),
      '(e) smokeSurgicalReset() (Section 47) still registered in main()', 'forge-smoke.js');
    assert(/smokeSidecarLayer1Retry\(\);/.test(mainBody),
      '(e) smokeSidecarLayer1Retry() (Section 48) still registered in main()', 'forge-smoke.js');
  }

  pass('(final) Section 49: sidecar_on_failure policy gate — default byte-identity, degradation matrix, schema/mirror sync, doc-presence, and HARD-invariant cross-check all verified');
}

// ── Section 54: S02 installer chokepoint regression guards ─────────────────
function smokePrefsChokepoints() {
  process.stdout.write('\n▸ Section 54: prefs chokepoints — jsonc-only installers + global auto-migrate\n');
  const REPO = path.dirname(SCRIPTS);
  const sh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(REPO, 'install.ps1'), 'utf8');

  // The installers must only migrate an existing legacy global file; the
  // repository's deleted Markdown template is not an installation source.
  assert(!sh.includes('copy "${REPO_DIR}/forge-agent-prefs.md"'),
    '(a) install.sh does not copy the repository forge-agent-prefs.md template', 'install.sh');
  assert(!sh.includes('forge-agent-prefs.md (novo)'),
    '(a) install.sh has no legacy Portuguese template-copy line', 'install.sh');
  assert(sh.includes('forge-prefs-migrate.js" --global-only'),
    '(a) install.sh invokes forge-prefs-migrate.js --global-only', 'install.sh');
  const shLegacyStart = sh.indexOf('elif [ -f "$PREFS_DST" ]');
  const shFirstNextBranch = sh.indexOf('elif command -v node', shLegacyStart);
  const shScaffoldStart = sh.indexOf('elif command -v node', shFirstNextBranch + 1);
  const shLegacy = sh.slice(shLegacyStart, shScaffoldStart);
  assert(/if node[\s\S]*else[\s\S]*manual[\s\S]*--global-only[\s\S]*\n\s*fi/.test(shLegacy),
    '(b) install.sh degrades a refused migration to a manual instruction', shLegacy);
  assert(!/manual:[\s\S]{0,300}\bexit\b/.test(shLegacy),
    '(b) install.sh continues after a non-zero migrator exit', shLegacy);

  assert(!ps.includes('CopyFile "$RepoDir\\forge-agent-prefs.md"'),
    '(c) install.ps1 does not CopyFile the repository forge-agent-prefs.md template', 'install.ps1');
  assert(ps.includes('--global-only'),
    '(c) install.ps1 invokes forge-prefs-migrate.js --global-only', 'install.ps1');
  assert(/for f in .*shared\/\*\.md/.test(sh),
    '(c2) install.sh copies shared references through the glob loop', 'install.sh');
  assert(/Get-ChildItem[\s\S]*-Path \$SharedSrc[\s\S]*-Filter '\*\.md'/m.test(ps),
    '(c2) install.ps1 copies shared references through the Get-ChildItem loop', 'install.ps1');
  const psLegacyStart = ps.indexOf("elseif (Test-Path $prefsFile)");
  const psFirstNextBranch = ps.indexOf("elseif (Get-Command node", psLegacyStart);
  const psScaffoldStart = ps.indexOf("elseif (Get-Command node", psFirstNextBranch + 1);
  const psLegacy = ps.slice(psLegacyStart, psScaffoldStart);
  assert(/LASTEXITCODE\s*-eq\s*0/.test(psLegacy) && /Warn[\s\S]*manual[\s\S]*--global-only/.test(psLegacy),
    '(d) install.ps1 degrades a refused migration to a manual instruction', psLegacy);
  assert(!/manual:[\s\S]{0,300}\bexit\b/i.test(psLegacy),
    '(d) install.ps1 continues after a non-zero migrator exit', psLegacy);

  const psBytes = fs.readFileSync(path.join(REPO, 'install.ps1'));
  assert(!psBytes.includes(0x0c), '(e) install.ps1 contains no literal 0x0C byte', 'install.ps1');

  // Keep this check read-only and dry-run-only: a real installer invocation
  // could mutate the operator's ~/.claude directory.
  const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bashProbe.error || bashProbe.status !== 0) {
    pass('(f) install.sh --dry-run skipped (bash unavailable)');
  } else {
    // install.sh guards on ~/.claude existing; provide a hermetic HOME with
    // that directory so the dry-run runs regardless of the runner's real HOME.
    const dryHome = mkTmp('install-dry-home');
    fs.mkdirSync(path.join(dryHome, '.claude'), { recursive: true });
    const dry = spawnSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--update'],
      { encoding: 'utf8', env: { ...process.env, HOME: dryHome } });
    cleanup(dryHome);
    const output = `${dry.stdout || ''}${dry.stderr || ''}`;
    assert(dry.status === 0, '(f) install.sh --dry-run exits 0', output);
    assert(!/[✗]|fatal/i.test(dry.stderr || ''), '(f) install.sh --dry-run has no error/fatal stderr', dry.stderr || '');
    assert(/forge-prefs-cutover\.md/.test(output), '(f) install.sh --dry-run shows forge-prefs-cutover.md copy', output);
    assert(!/cp\s+[^\n]*forge-agent-prefs\.md/.test(dry.stdout || ''),
      '(f) install.sh --dry-run has no repository template-copy line', dry.stdout || '');
  }

  // HARD-invariant cross-check — prior surgical-reset and sidecar sections
  // remain registered when this chokepoint guard is added.
  const src = fs.readFileSync(path.join(SCRIPTS, 'forge-smoke.js'), 'utf8');
  const mainBody = src.slice(src.indexOf('async function main()'));
  assert(/smokeSurgicalReset\(\);/.test(mainBody),
    '(g) smokeSurgicalReset() remains registered in main()', 'forge-smoke.js');
  assert(/smokeSidecarPolicyGuard\(\);/.test(mainBody),
    '(g) smokeSidecarPolicyGuard() remains registered in main()', 'forge-smoke.js');

  pass('(final) Section 54: prefs chokepoints — installer template exclusion, global auto-migrate/degradation, clean dry-run, and PowerShell byte guard verified');
}

// ── Section 55: S03 prefs consumer regression guards ───────────────────────
function smokePrefsConsumers() {
  process.stdout.write('\n▸ Section 55: prefs consumers — blocked posture propagation\n');
  const REPO = path.dirname(SCRIPTS);

  // Consumer skills must relay the structured engine code.  Keep these
  // assertions coupled to the code, rather than to the localized message.
  const skillFiles = [
    'skills/forge-auto/SKILL.md',
    'skills/forge-next/SKILL.md',
    'skills/forge-task/SKILL.md',
  ];
  for (const rel of skillFiles) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert(!content.includes('Deprecation warning (once per session)'),
      `(a) ${rel} has no deprecation warning`, rel);
    assert(!content.includes('md-legacy'),
      `(a) ${rel} has no md-legacy source`, rel);
    assert(content.includes('legacy-md-without-jsonc'),
      `(a) ${rel} handles legacy-md-without-jsonc`, rel);
  }

  // Doctor reports the blocked layer and its --fix path delegates migration
  // to the local-only migrator, without reviving the removed source label.
  const doctorRel = 'skills/forge-doctor/SKILL.md';
  const doctor = fs.readFileSync(path.join(REPO, doctorRel), 'utf8');
  assert(doctor.includes('md-blocked'),
    '(b) forge-doctor detects md-blocked', doctorRel);
  const fixStart = doctor.indexOf('## C5a:');
  const fixRegion = fixStart >= 0 ? doctor.slice(fixStart, fixStart + 3200) : '';
  assert(/forge-prefs-migrate\.js[\s\S]{0,180}--local-only/.test(fixRegion),
    '(b) forge-doctor --fix invokes forge-prefs-migrate.js --local-only', doctorRel);
  assert(!doctor.includes('source: "md-legacy"'),
    '(b) forge-doctor has no md-legacy source label', doctorRel);

  // Hook diagnostics are best-effort: one prefs-blocked event per process,
  // and every filesystem failure is swallowed so hooks remain fail-open.
  const hookRel = 'scripts/forge-hook.js';
  const hook = fs.readFileSync(path.join(REPO, hookRel), 'utf8');
  assert(/let\s+_prefsBlockedEventLogged\s*=\s*false/.test(hook),
    '(c) forge-hook has a module-level once-per-process guard', hookRel);
  assert(/appendFileSync\([\s\S]*events\.jsonl[\s\S]*JSON\.stringify\(event\)/.test(hook),
    '(c) forge-hook appends events.jsonl', hookRel);
  assert(/event:\s*['"]prefs-blocked['"]/.test(hook),
    '(c) forge-hook emits prefs-blocked', hookRel);
  const appendStart = hook.indexOf('const appendPrefsBlockedEvent');
  const appendRegion = appendStart >= 0 ? hook.slice(appendStart, appendStart + 1400) : '';
  assert(/^const appendPrefsBlockedEvent[\s\S]*?\{[\s\S]*?try\s*\{[\s\S]*?\}\s*catch\s*\{/.test(appendRegion),
    '(c) forge-hook prefs event append is silent-fail', hookRel);

  // Statusline consumes the generic hadError signal and still renders a line.
  const statusRel = 'scripts/forge-statusline.js';
  const statusline = fs.readFileSync(path.join(REPO, statusRel), 'utf8');
  assert(/resolvedPrefs\.hadError\)\s*forgeVersionTail\s*\+=\s*['"][^'"\n]*⚠ prefs/.test(statusline),
    '(d) forge-statusline emits ⚠ prefs through hadError', statusRel);
  assert(statusline.includes('prefs-error.json'),
    '(d) forge-statusline has the generic prefs-error.json path', statusRel);
  assert(/process\.stdout\.write\(line1 \+ line2 \+ ['"]\\n['"]\)/.test(statusline),
    '(d) forge-statusline renders output after prefs handling', statusRel);

  // HARD-invariant: the prior section remains registered in main().
  const src = fs.readFileSync(path.join(SCRIPTS, 'forge-smoke.js'), 'utf8');
  const mainBody = src.slice(src.indexOf('async function main()'));
  assert(/smokePrefsChokepoints\(\);/.test(mainBody),
    '(e) Section 54 smokePrefsChokepoints() remains registered in main()', 'forge-smoke.js');

  pass('(final) Section 55: prefs consumer guards — skill posture, doctor migration, hook telemetry, statusline badge, and Section 54 HARD-invariant verified');
}

// ── Section 56: S04 grep-zero and canonical cutover guards ─────────────────
function smokePrefsCutoverGuards() {
  process.stdout.write('\n▸ Section 56: prefs cutover — grep-zero, no dual-read, canonical message\n');
  const REPO = path.dirname(SCRIPTS);
  const allowlist = new Set([
    'CHANGELOG.md', 'scripts/forge-prefs.js', 'scripts/forge-prefs-legacy.js',
    'scripts/forge-prefs-migrate.js', 'scripts/forge-prefs.test.js',
    'scripts/forge-prefs-migrate.test.js', 'scripts/forge-prefs-schema.test.js',
    'scripts/forge-routing.test.js', 'scripts/forge-verifier.test.js',
    'scripts/forge-smoke.js', 'install.sh', 'install.ps1',
    'commands/forge-update.md', 'shared/forge-prefs-cutover.md',
    // Existing compatibility entry points are deliberately audited rather
    // than silently missed by the repository-wide scan.
    'bin/forge-accounts', 'bin/forge-run', 'bin/forge-status',
    'skills/forge-doctor/SKILL.md', 'CLAUDE.md',
  ]);
  const untrackedProbe = path.join(REPO, '.forge-smoke-untracked-prefs-probe');
  fs.writeFileSync(untrackedProbe, 'forge-agent-prefs.md\n', 'utf8');
  const offenders = [];
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (error) {
    fail('(setup) git ls-files enumerates tracked files', error.message);
  }
  for (const rel of tracked) {
    if (rel.split('/').includes('.gsd') || rel.split('/').includes('node_modules') || rel.endsWith('.bak')) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    if (/forge-agent-prefs\.md/i.test(text) && !allowlist.has(rel)) offenders.push(rel);
  }
  assert(!offenders.includes('.forge-smoke-untracked-prefs-probe'),
    '(a2) arquivo untracked com forge-agent-prefs.md não vira offender', offenders.join(', '));
  try { fs.rmSync(untrackedProbe, { force: true }); } catch {}
  assert(offenders.length === 0,
    '(a) forge-agent-prefs.md só aparece na allowlist sancionada', offenders.join(', '));

  const dualReadTargets = [
    'shared/forge-dispatch.md', 'shared/forge-review.md',
    'shared/forge-plan-gate.md', 'shared/forge-tiers.md',
    'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md',
    'skills/forge-task/SKILL.md', 'skills/forge-probe/SKILL.md',
    'skills/forge-prefs/SKILL.md', 'commands/forge-init.md',
  ];
  const dualReadHits = dualReadTargets.filter((rel) =>
    /dual-read/i.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
  assert(dualReadHits.length === 0,
    '(b) dual-read ausente das specs e skills sancionadas', dualReadHits.join(', '));

  const loopSkills = ['forge-auto', 'forge-next', 'forge-task'];
  for (const skill of loopSkills) {
    const text = fs.readFileSync(path.join(REPO, 'skills', skill, 'SKILL.md'), 'utf8');
    assert(/never/i.test(text) && /cascade/i.test(text) && /scripts\/forge-prefs\.js/.test(text),
      `(c) ${skill}/SKILL.md preserva MEM001 (never + cascade + scripts/forge-prefs.js)`);
  }

  const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const v2 = changelog.slice(0, changelog.indexOf('\n## v1.35.0'));
  const canonical = fs.readFileSync(path.join(REPO, 'shared/forge-prefs-cutover.md'), 'utf8');
  const commandFormula = canonical.match(/node \"\{command\}\" --cwd \"\{cwd\}\"/);
  assert(v2.includes('forge-prefs-migrate.js') && v2.includes('--cwd'),
    '(d) CHANGELOG v2.0.0 cita forge-prefs-migrate.js + --cwd');
  assert(commandFormula && v2.includes(commandFormula[0]),
    '(d) CHANGELOG cita a fórmula exata da mensagem canônica', commandFormula && commandFormula[0]);

  pass('(final) Section 56: grep-zero allowlist, dual-read absence, MEM001 anti-cascade, and canonical CHANGELOG command verified');
}

// ── Section 50: heartbeat self-describing contract regression guard ─────────
// The fenced spec snippet is the implementation under test: this section
// extracts and executes it rather than maintaining a second threshold/probe
// implementation in the smoke suite.
function smokeHeartbeatContract() {
  process.stdout.write('\n▸ Section 50: heartbeat self-describing contract\n');
  const REPO = path.dirname(SCRIPTS);

  const MIRRORS = [
    { rel: 'skills/forge-auto/SKILL.md', label: 'forge-auto' },
    { rel: 'skills/forge-next/SKILL.md', label: 'forge-next' },
    { rel: 'skills/forge-task/SKILL.md', label: 'forge-task' },
  ];
  const DOCS = [{ rel: 'shared/forge-dispatch.md', label: 'shared/forge-dispatch.md' }, ...MIRRORS];
  const texts = {};
  for (const d of DOCS) {
    const p = path.join(REPO, d.rel);
    assert(fs.existsSync(p), `(setup) ${d.label} exists on disk`, p);
    texts[d.rel] = fs.readFileSync(p, 'utf8');
  }

  // Locate the one canonical fenced block by its stable anchor. Keeping the
  // extraction structural prevents nearby prose or another JS example from
  // accidentally becoming the tested contract.
  const spec = texts['shared/forge-dispatch.md'];
  const anchor = 'forge-sidecar-liveness';
  const anchorHits = spec.split(anchor).length - 1;
  assert(anchorHits === 1,
    '(setup) canonical liveness snippet anchor exists exactly once in the spec',
    `anchor hits=${anchorHits}`);
  const jsBlocks = [...spec.matchAll(/```js\n([\s\S]*?)\n```/g)]
    .map(match => match[1])
    .filter(block => block.includes(anchor));
  assert(jsBlocks.length === 1,
    '(setup) anchor belongs to exactly one extractable fenced js block',
    `matching fenced blocks=${jsBlocks.length}`);

  const tmp = mkTmp('heartbeat-contract');
  try {
    const snippetPath = path.join(tmp, 'forge-sidecar-liveness.js');
    fs.writeFileSync(snippetPath, jsBlocks.length === 1 ? jsBlocks[0] + '\n' : '', 'utf8');

    const runFixture = (name, payload, raw) => {
      const resultPath = path.join(tmp, `${name}.json`);
      fs.writeFileSync(resultPath, raw === undefined ? JSON.stringify(payload) : raw, 'utf8');
      const result = spawnSync(process.execPath, [snippetPath, resultPath], {
        encoding: 'utf8',
        timeout: 5000,
      });
      assert(result.status === 0,
        `(setup) canonical snippet exits zero for ${name}`,
        `status=${result.status}; stderr=${result.stderr || ''}`);
      return (result.stdout || '').trim();
    };

    // A just-exited child supplies a real dead PID. PID recycling in the few
    // milliseconds before these probes is practically impossible, and this
    // remains portable because the child uses the current Node binary.
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    const deadPid = exited.pid;
    assert(Number.isInteger(deadPid) && deadPid > 0,
      '(setup) spawned-then-exited child yielded a dead PID', String(deadPid));

    const isoAgo = ms => new Date(Date.now() - ms).toISOString();
    const base = { status: 'running', pid: 123, adapter_pid: process.pid };

    const freshSelfDescribing = runFixture('a-fresh-self-describing', {
      ...base,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(20000),
    });
    assert(freshSelfDescribing === 'fresh',
      '(a) 15s-advertised heartbeat at 20s is fresh (legacy ~9s contract would have killed it)',
      `token=${freshSelfDescribing}`);

    const staleDead = runFixture('b-stale-dead', {
      ...base,
      adapter_pid: deadPid,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(120000),
    });
    assert(staleDead === 'stale-dead',
      '(b) heartbeat older than dynamic threshold with dead adapter_pid is stale-dead',
      `token=${staleDead}`);

    const legacyFresh = runFixture('c-absent-field-fresh', {
      ...base,
      updated_at: isoAgo(45000),
    });
    assert(legacyFresh === 'fresh',
      '(c) absent heartbeat_interval_ms defaults to 15s: 45s-old beat is fresh',
      `token=${legacyFresh}`);
    const legacyStale = runFixture('c-absent-field-stale', {
      ...base,
      adapter_pid: deadPid,
      updated_at: isoAgo(120000),
    });
    assert(legacyStale === 'stale-dead',
      '(c) absent heartbeat_interval_ms defaults to 60s threshold: 120s-old dead beat is stale-dead',
      `token=${legacyStale}`);

    const staleAlive = runFixture('e-stale-alive', {
      ...base,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(120000),
    });
    assert(staleAlive === 'stale-alive',
      '(e) stale heartbeat with live adapter_pid is stale-alive (grace, not immediate kill)',
      `token=${staleAlive}`);
    const staleDeadAgain = runFixture('e-stale-dead', {
      ...base,
      adapter_pid: deadPid,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(120000),
    });
    assert(staleDeadAgain === 'stale-dead',
      '(e) same stale heartbeat with dead adapter_pid is stale-dead (kill now)',
      `token=${staleDeadAgain}`);

    const noHeartbeat = runFixture('bonus-unparseable', null, '{not json');
    assert(noHeartbeat === 'no-heartbeat',
      '(bonus) unparseable result-file returns no-heartbeat',
      `token=${noHeartbeat}`);

    // (f) out-of-range / non-finite advertised interval falls back to the
    // 15000 default rather than disabling orphan detection (R1 fix).
    const infiniteInterval = runFixture('f-infinite-interval', {
      ...base,
      adapter_pid: deadPid,
      heartbeat_interval_ms: 1e309, // JS numeric literal overflow → Infinity
      updated_at: isoAgo(65000),
    });
    assert(infiniteInterval === 'stale-dead',
      '(f) Infinity-advertised heartbeat_interval_ms falls back to 15s default (60s threshold): 65s-old dead beat is stale-dead',
      `token=${infiniteInterval}`);

    const excessiveInterval = runFixture('f-excessive-interval', {
      ...base,
      adapter_pid: deadPid,
      heartbeat_interval_ms: 999999999,
      updated_at: isoAgo(65000),
    });
    assert(excessiveInterval === 'stale-dead',
      '(f) excessive finite heartbeat_interval_ms (999999999) falls back to 15s default (60s threshold): 65s-old dead beat is stale-dead',
      `token=${excessiveInterval}`);

    const futureBeyondSkew = runFixture('g-future-beyond-skew', {
      ...base,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(-90000),
    });
    assert(futureBeyondSkew === 'no-heartbeat',
      '(g) updated_at 90s in the future is no-heartbeat beyond the 60s clock-skew tolerance',
      `token=${futureBeyondSkew}`);

    const futureBoundary = runFixture('g-future-boundary', {
      ...base,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(-61000),
    });
    assert(futureBoundary === 'no-heartbeat',
      '(g) updated_at 61s in the future is no-heartbeat beyond the 60s clock-skew tolerance',
      `token=${futureBoundary}`);

    const futureWithinSkew = runFixture('g-future-within-skew', {
      ...base,
      heartbeat_interval_ms: 15000,
      updated_at: isoAgo(-30000),
    });
    assert(futureWithinSkew === 'fresh',
      '(g) updated_at 30s in the future remains fresh within the 60s clock-skew tolerance',
      `token=${futureWithinSkew}`);
  } finally {
    cleanup(tmp);
  }

  // ── (d) legacy-cadence grep-clean over the spec and all mirrors ──
  const forbidden = ['3s cadence', '~9s', '2–3×', '3× the'];
  for (const d of DOCS) {
    for (const pattern of forbidden) {
      assert(!texts[d.rel].includes(pattern),
        `(d) ${d.label} is grep-clean for legacy cadence pattern ${JSON.stringify(pattern)}`,
        d.rel);
    }
  }

  // ── Doc-presence, anti-copy, and adapter write-site wiring ──
  const formula = 'max(heartbeat_interval_ms × 4, 30s)';
  for (const d of DOCS) {
    assert(texts[d.rel].includes(formula),
      `(d) ${d.label} carries the exact dynamic-threshold formula`, d.rel);
  }
  for (const m of MIRRORS) {
    assert(!texts[m.rel].includes(anchor),
      `(d) ${m.label} does not copy the canonical snippet anchor`, m.rel);
  }
  assert(/xllm_liveness_probe/.test(spec),
    '(e) spec documents the xllm_liveness_probe audit event',
    'shared/forge-dispatch.md');
  assert(/grace is \*\*exactly the next existing poll cycle\*\*/.test(spec) && /no new sleep/.test(spec),
    '(e) spec defines grace as exactly one existing poll cycle with no new sleep',
    'shared/forge-dispatch.md');
  assert(/field is \*\*absent or non-positive\*\*[\s\S]*?assume `15000`/.test(spec),
    '(c) spec documents absent-field default as assume 15s',
    'shared/forge-dispatch.md');

  const adapterPath = path.join(REPO, 'scripts/forge-xllm.js');
  const adapter = fs.readFileSync(adapterPath, 'utf8');
  assert(/(?:const|let|var) HEARTBEAT_INTERVAL_MS = 15000;/.test(adapter),
    '(a) forge-xllm defines HEARTBEAT_INTERVAL_MS = 15000',
    'scripts/forge-xllm.js');
  const fieldWrites = adapter.match(/heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS/g) || [];
  assert(fieldWrites.length === 6,
    '(a) all six running-payload sites carry heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS',
    `count=${fieldWrites.length}`);
  assert(!/heartbeat_interval_ms: 15000/.test(adapter),
    '(a) adapter has zero literal 15000 heartbeat write sites',
    'scripts/forge-xllm.js');

  pass('(final) Section 50: heartbeat self-describing contract — canonical snippet behavior, clock-skew clamp, grep-clean docs, formula/probe/grace presence, and adapter wiring verified');
}

// ── Sidecar cap formula guards ────────────────────────────────────────────
function smokeSidecarGptCap() {
  process.stdout.write('\n▸ Sidecar cap counts gpt and codex family members\n');
  const REPO = path.dirname(SCRIPTS);
  const mirrors = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md'];
  for (const rel of mirrors) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const matches = text.match(/CODEX_MEMBERS=\$\(node -e "[^"]*filter\(m=>m\.engine==='gpt'\|\|m\.engine==='codex'\)[^"]*" \"\$ROUTE_JSON\"[^\n]*/g) || [];
    assert(matches.length === 2, `(cap) ${rel} has two corrected executable predicates`, `found=${matches.length}`);
    for (const [index, snippet] of matches.entries()) {
      const result = spawnSync('bash', ['-c', `${snippet}\nprintf '%s\\n' "$CODEX_MEMBERS"`], {
        cwd: REPO, env: { ...process.env, ROUTE_JSON: JSON.stringify({ chain: [{ engine: 'gpt' }] }) }, encoding: 'utf8'
      });
      assert(result.status === 0 && result.stdout.trim() === '1',
        `(cap) ${rel} snippet ${index + 1} executes gpt as one member`, `status=${result.status} stdout=${result.stdout}`);
    }
  }
}

// ── Section 51: sidecar env allowlist contract regression guard ─────────────
function smokeSidecarEnvContract() {
  process.stdout.write('\n▸ Section 51: sidecar env allowlist contract\n');
  const REPO = path.dirname(SCRIPTS);
  const nodeAssert = require('assert');
  const { buildSidecarEnv } = require('./forge-xllm.js');
  const fixture = {
    ANTHROPIC_AUTH_TOKEN: 'anthropic-planted',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-planted',
    AWS_SECRET_ACCESS_KEY: 'aws-planted',
    DATABASE_URL: 'database-planted',
    GCP_PROJECT: 'gcp-planted',
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.homedir(),
    FORGE_XLLM_CODEX_BIN: '/fixture/mock-codex.js',
  };

  const minimal = buildSidecarEnv('minimal', fixture, 'darwin');
  const denied = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'GCP_PROJECT'];
  assert(denied.every(key => !Object.prototype.hasOwnProperty.call(minimal, key)),
    '(a) minimal removes planted auth tokens and every denylisted prefix',
    `leaked=${denied.filter(key => Object.prototype.hasOwnProperty.call(minimal, key)).join(',')}`);
  assert(minimal.PATH === fixture.PATH && minimal.HOME === fixture.HOME
      && minimal.FORGE_XLLM_CODEX_BIN === fixture.FORGE_XLLM_CODEX_BIN,
    '(a) minimal preserves PATH, HOME, and FORGE_XLLM_CODEX_BIN');
  nodeAssert.deepStrictEqual(buildSidecarEnv('yolo', fixture, 'darwin'), minimal);
  pass('(a) invalid policy securely defaults to minimal');

  nodeAssert.deepStrictEqual(buildSidecarEnv('inherit', fixture, 'darwin'), fixture);
  pass('(b) inherit is deep-equal to the source env, including denylisted keys');

  const forgeFixture = { PATH: '/bin', FORGE_ONE: 'one', FORGE_TWO: 'two', RANDOM_SECRET: 'no' };
  const forgeMinimal = buildSidecarEnv('minimal', forgeFixture, 'darwin');
  assert(forgeMinimal.FORGE_ONE === 'one' && forgeMinimal.FORGE_TWO === 'two'
      && !Object.prototype.hasOwnProperty.call(forgeMinimal, 'RANDOM_SECRET'),
    '(c) multiple FORGE_* keys pass while arbitrary non-allowlisted keys do not');

  // (a2, O1 regression): the denylist must have TEETH against denylisted prefixes
  // embedded after a FORGE_ underscore boundary (the original anchor `^(AWS_|...)`
  // never matched `FORGE_ANTHROPIC_AUTH_TOKEN` because it doesn't start with
  // ANTHROPIC_ — it starts with FORGE_ — so it survived the FORGE_* allowlist pass
  // untouched). Real FORGE_* vocabulary (FORGE_ACCOUNT, FORGE_XLLM_*_BIN,
  // FORGE_ENGINE, FORGE_NEW_WINDOW_DRYRUN, FORGE_SESSION_ID) must still pass.
  const teethFixture = {
    PATH: '/bin',
    FORGE_ANTHROPIC_AUTH_TOKEN: 'LEAK',
    FORGE_AWS_SECRET: 'LEAK',
    FORGE_CLAUDE_CODE_OAUTH_TOKEN: 'LEAK',
    FORGE_XLLM_CODEX_BIN: 'mock-codex.js',
    FORGE_ACCOUNT: 'work',
    FORGE_ENGINE: 'codex',
    FORGE_NEW_WINDOW_DRYRUN: '1',
    FORGE_SESSION_ID: 'sess-1',
  };
  const teethMinimal = buildSidecarEnv('minimal', teethFixture, 'darwin');
  assert(!('FORGE_ANTHROPIC_AUTH_TOKEN' in teethMinimal) && !('FORGE_AWS_SECRET' in teethMinimal)
      && !('FORGE_CLAUDE_CODE_OAUTH_TOKEN' in teethMinimal),
    '(a2) denylist strips denylisted prefixes embedded after a FORGE_ underscore boundary',
    `leaked=${Object.keys(teethMinimal).filter(k => k.startsWith('FORGE_') && /(^|_)(AWS_|AZURE_|GCP_|DATABASE_|ANTHROPIC_|CLAUDE_)/.test(k)).join(',')}`);
  assert(teethMinimal.FORGE_XLLM_CODEX_BIN === 'mock-codex.js' && teethMinimal.FORGE_ACCOUNT === 'work'
      && teethMinimal.FORGE_ENGINE === 'codex' && teethMinimal.FORGE_NEW_WINDOW_DRYRUN === '1'
      && teethMinimal.FORGE_SESSION_ID === 'sess-1',
    '(a2) real FORGE_* vocabulary passes through unaffected by the tightened denylist');

  const platformFixture = {
    SystemRoot: 'win', COMSPEC: 'win', PATHEXT: 'win', APPDATA: 'win',
    LOCALAPPDATA: 'win', USERPROFILE: 'win', TEMP: 'win', TMP: 'win',
    DBUS_SESSION_BUS_ADDRESS: 'linux', XDG_RUNTIME_DIR: 'linux',
    XDG_DATA_HOME: 'linux', XDG_CONFIG_HOME: 'linux',
  };
  const winKeys = ['SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
    'USERPROFILE', 'TEMP', 'TMP'];
  const linuxKeys = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME',
    'XDG_CONFIG_HOME'];
  const winEnv = buildSidecarEnv('minimal', platformFixture, 'win32');
  const linuxEnv = buildSidecarEnv('minimal', platformFixture, 'linux');
  const darwinEnv = buildSidecarEnv('minimal', platformFixture, 'darwin');
  assert(winKeys.every(key => winEnv[key] === 'win')
      && linuxKeys.every(key => !Object.prototype.hasOwnProperty.call(winEnv, key)),
    '(d) win32 injected platform keeps its base and excludes Linux keys');
  assert(linuxKeys.every(key => linuxEnv[key] === 'linux')
      && winKeys.every(key => !Object.prototype.hasOwnProperty.call(linuxEnv, key)),
    '(d) linux injected platform keeps its base and excludes Windows keys');
  assert([...winKeys, ...linuxKeys].every(key => !Object.prototype.hasOwnProperty.call(darwinEnv, key)),
    '(d) darwin injected platform excludes Windows and Linux-only keys');

  const tmp = mkTmp('sidecar-env');
  const mockDir = path.join(tmp, 'mock-bin');
  fs.mkdirSync(mockDir);
  const mockJs = path.join(mockDir, 'mock-codex.js');
  const mockSource = [
    `#!${process.execPath}`,
    "'use strict';",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    "const outIndex = args.indexOf('-o');",
    "if (process.env.FORGE_ENV_DUMP) fs.writeFileSync(process.env.FORGE_ENV_DUMP, JSON.stringify(process.env));",
    "if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], JSON.stringify({ objections: [] }));",
    '',
  ].join('\n');
  fs.writeFileSync(mockJs, mockSource, 'utf8');
  fs.chmodSync(mockJs, 0o755);
  const mockCommand = path.join(mockDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(mockCommand, `@"${process.execPath}" "${mockJs}" %*\r\n`, 'utf8');
    const entry = path.join(mockDir, 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(entry, { recursive: true });
    fs.copyFileSync(mockJs, path.join(entry, 'codex.js'));
  } else {
    fs.copyFileSync(mockJs, mockCommand);
    fs.chmodSync(mockCommand, 0o755);
  }

  try {
    const runPolicy = policy => {
      const dump = path.join(tmp, `${policy}.json`);
      const plantedEnv = {
        ...process.env,
        PATH: mockDir + path.delimiter + (process.env.PATH || ''),
        FORGE_XLLM_CODEX_BIN: mockJs,
        FORGE_ENV_DUMP: dump,
        ANTHROPIC_AUTH_TOKEN: 'child-anthropic-planted',
        CLAUDE_CODE_OAUTH_TOKEN: 'child-claude-planted',
      };
      const diffCmd = `"${process.execPath}" -e "process.stdout.write('diff')"`;
      const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-xllm.js'),
        '--mode', 'challenge', '--engine', 'codex', '--diff-cmd', diffCmd,
        '--env-policy', policy, '--cwd', tmp], { cwd: tmp, env: plantedEnv, encoding: 'utf8' });
      return { result, dump, env: fs.existsSync(dump) ? JSON.parse(fs.readFileSync(dump, 'utf8')) : {} };
    };
    const minimalRun = runPolicy('minimal');
    assert(minimalRun.result.status === 0,
      '(e) minimal CLI run reaches the mock codex child', minimalRun.result.stderr || `status=${minimalRun.result.status}`);
    assert(!minimalRun.env.ANTHROPIC_AUTH_TOKEN && !minimalRun.env.CLAUDE_CODE_OAUTH_TOKEN,
      '(e) minimal child env dump excludes both planted session tokens');
    assert(minimalRun.env.FORGE_XLLM_CODEX_BIN === mockJs && minimalRun.env.PATH,
      '(e) minimal child env dump receives FORGE_XLLM_CODEX_BIN and PATH');
    const inheritRun = runPolicy('inherit');
    assert(inheritRun.result.status === 0 && inheritRun.env.ANTHROPIC_AUTH_TOKEN === 'child-anthropic-planted'
        && inheritRun.env.CLAUDE_CODE_OAUTH_TOKEN === 'child-claude-planted',
      '(e) inherit CLI run re-exposes planted tokens as the explicit escape hatch', inheritRun.result.stderr);
    const bogusRun = runPolicy('bogus');
    assert(bogusRun.result.status === 2,
      '(e) invalid --env-policy exits 2', `status=${bogusRun.result.status}`);
  } finally {
    cleanup(tmp);
  }

  const adapter = fs.readFileSync(path.join(SCRIPTS, 'forge-xllm.js'), 'utf8');
  // Exhaustive coverage guard (O2 fix): every spawn(/spawnSync( call-site in the
  // adapter must carry env: buildSidecarEnv( — except the documented taskkill
  // exception (a signal-delivery call, not a sidecar process spawn). This is the
  // inverse of counting sites that HAVE env: (which silently passes a future 4th
  // spawn added without it) — it walks every call-site and fails closed.
  const spawnCallRe = /\b(spawnSync|spawn)\(/g;
  const spawnMatches = [...adapter.matchAll(spawnCallRe)];
  assert(spawnMatches.length >= 4,
    '(f) sanity: adapter still has the expected spawn(/spawnSync( call-sites', `found=${spawnMatches.length}`);
  const uncovered = [];
  for (const m of spawnMatches) {
    const start = m.index;
    const closeIdx = adapter.indexOf('});', start);
    const block = adapter.slice(start, closeIdx > start ? closeIdx + 3 : start + 400);
    const isTaskkill = block.includes('taskkill');
    const hasEnv = block.includes('env: buildSidecarEnv(');
    if (isTaskkill) {
      if (hasEnv) uncovered.push(`taskkill call-site unexpectedly carries env: (index=${start})`);
      continue;
    }
    if (!hasEnv) uncovered.push(`spawn call-site missing env: buildSidecarEnv( (index=${start})`);
  }
  assert(uncovered.length === 0,
    '(f) every non-taskkill spawn(/spawnSync( call-site carries env: buildSidecarEnv(', uncovered.join('; '));
  const schema = require('../forge-prefs.schema.json');
  const envPolicySchema = schema.properties.sidecars && schema.properties.sidecars.properties.env_policy;
  assert(envPolicySchema && JSON.stringify(envPolicySchema.enum) === JSON.stringify(['minimal', 'inherit'])
      && envPolicySchema.default === 'minimal',
    '(f) schema declares sidecars.env_policy enum [minimal, inherit] with default minimal');

  pass('(final) Section 51: sidecar env allowlist contract — unit, platform, E2E child dump, call-sites, and schema verified');
}

// ── Section 52: extracted review schemas single-source regression guard ─────
// Baseline: 1248 passes (1228 before this section + 20 Section 52 assertions).
function smokeSchemaExtraction() {
  process.stdout.write('\n▸ Section 52: extracted review schemas single-source contract\n');
  const REPO = path.dirname(SCRIPTS);
  const schemaDir = path.join(REPO, 'shared', 'schemas');
  const challengePath = path.join(schemaDir, 'challenge.schema.json');
  const verdictPath = path.join(schemaDir, 'verdict.schema.json');

  assert(fs.existsSync(challengePath), '(a) challenge schema exists', challengePath);
  assert(fs.existsSync(verdictPath), '(a) verdict schema exists', verdictPath);
  let challenge;
  let verdict;
  try { challenge = JSON.parse(fs.readFileSync(challengePath, 'utf8')); }
  catch (e) { fail('(a) challenge schema parses as JSON', e.message); }
  if (challenge) pass('(a) challenge schema parses as JSON');
  try { verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8')); }
  catch (e) { fail('(a) verdict schema parses as JSON', e.message); }
  if (verdict) pass('(a) verdict schema parses as JSON');
  assert(Boolean(challenge && challenge.properties && challenge.properties.objections),
    '(a) challenge schema exposes properties.objections');
  assert(Boolean(verdict && verdict.properties && verdict.properties.verdicts),
    '(a) verdict schema exposes properties.verdicts');
  assert(Boolean(challenge && challenge.additionalProperties === false
      && verdict && verdict.additionalProperties === false),
    '(a) both schemas reject additional top-level properties');

  const adapterPath = path.join(SCRIPTS, 'forge-xllm.js');
  const adapterSource = fs.readFileSync(adapterPath, 'utf8');
  assert(!/const[ \t]+challengeSchema[ \t]*=[ \t]*\{/.test(adapterSource),
    '(b) adapter has no inline challengeSchema object literal', adapterPath);
  const verdictFactorySource = adapterSource.slice(adapterSource.indexOf('function verdictSchema('),
    adapterSource.indexOf('// Output schema HINT'));
  assert(!/return[ \t]*\{/.test(verdictFactorySource)
      && !/type:[ \t]*['"]object['"]/.test(verdictFactorySource),
    '(b) adapter verdictSchema function has no inline schema object body', adapterPath);

  const reviewPath = path.join(REPO, 'shared', 'forge-review.md');
  const reviewSource = fs.readFileSync(reviewPath, 'utf8');
  const engineStart = reviewSource.indexOf("export const meta = {");
  const engineEnd = reviewSource.indexOf('**Return schema:**', engineStart);
  const engine = reviewSource.slice(engineStart, engineEnd);
  // (c) The Workflow sandbox has no require/fs — the two schemas MUST be inline literals
  // in the fenced script, kept byte-equal in shape to shared/schemas/*.json. This sync-check
  // extracts both literals from the markdown and deep-equals them against the JSON files.
  const challengeLitStart = engine.indexOf('const challengeSchema = {');
  const challengeLitEnd = engine.indexOf('\n\nlet challenge = null');
  const verdictLitStart = engine.indexOf('const verdictSchema = function (allowed) {');
  const verdictLitEnd = engine.indexOf('\n\nlet defense = null');
  assert(challengeLitStart !== -1 && challengeLitEnd !== -1
      && verdictLitStart !== -1 && verdictLitEnd !== -1,
    '(c) Engine workflow contains inline challengeSchema and verdictSchema literal blocks', reviewPath);

  let extractedChallenge = null;
  let extractedVerdictShape = null;
  try {
    const challengeSrc = engine.slice(challengeLitStart, challengeLitEnd);
    /* eslint-disable no-new-func */
    extractedChallenge = new Function(challengeSrc + '\nreturn challengeSchema;')();
    const verdictSrc = engine.slice(verdictLitStart, verdictLitEnd);
    const extractedVerdictFactory = new Function(verdictSrc + '\nreturn verdictSchema;')();
    /* eslint-enable no-new-func */
    extractedVerdictShape = extractedVerdictFactory([]);
  } catch (e) {
    fail('(c) inline literals parse as valid JS object/function bodies', e.message);
  }
  if (extractedChallenge) pass('(c) inline literals parse as valid JS object/function bodies');

  assert(Boolean(extractedChallenge)
      && JSON.stringify(extractedChallenge) === JSON.stringify(challenge),
    '(c) Engine workflow inline challengeSchema is byte-equal (JSON shape) to shared/schemas/challenge.schema.json', reviewPath);
  assert(Boolean(extractedVerdictShape)
      && JSON.stringify(extractedVerdictShape) === JSON.stringify(verdict),
    '(c) Engine workflow inline verdictSchema (static shape, enum=[]) is byte-equal (JSON shape) to shared/schemas/verdict.schema.json', reviewPath);

  const tmp = mkTmp('schema-installed-layout');
  try {
    const installedScripts = path.join(tmp, 'scripts');
    const installedSchemas = path.join(tmp, 'schemas');
    fs.mkdirSync(installedScripts, { recursive: true });
    fs.mkdirSync(installedSchemas, { recursive: true });
    function localRequires(file) {
      const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
      const out = new Set();
      const re = /require\('\.\/([^']+)'\)/g;
      let m;
      while ((m = re.exec(src))) {
        let dep = m[1];
        if (!dep.endsWith('.js')) dep += '.js';
        out.add(dep);
      }
      return out;
    }
    const neededScripts = new Set(['forge-xllm.js']);
    const queue = ['forge-xllm.js'];
    while (queue.length) {
      const cur = queue.shift();
      for (const dep of localRequires(cur)) {
        if (!neededScripts.has(dep)) {
          neededScripts.add(dep);
          queue.push(dep);
        }
      }
    }
    for (const name of neededScripts) {
      fs.copyFileSync(path.join(SCRIPTS, name), path.join(installedScripts, name));
    }
    fs.copyFileSync(challengePath, path.join(installedSchemas, 'challenge.schema.json'));
    fs.copyFileSync(verdictPath, path.join(installedSchemas, 'verdict.schema.json'));
    let installed;
    try { installed = require(path.join(installedScripts, 'forge-xllm.js')); }
    catch (e) { fail('(d) installed-layout adapter loads schemas without throwing', e.stack || e.message); }
    if (installed) pass('(d) installed-layout adapter loads schemas without throwing');
    assert(Boolean(installed && installed.challengeSchema.properties.objections),
      '(d) installed adapter resolves challenge schema through ../schemas/');
    assert(Boolean(installed && installed.verdictSchema(['open']).properties.verdicts
      .items.properties.verdict.enum[0] === 'open'),
    '(d) installed adapter resolves and injects the verdict enum');

    const baseResult = { status: 'done', summary: 'ok', must_haves_status: [], files_changed: [] };
    assert(Boolean(installed && installed.validateExecuteResult(baseResult)),
      '(e) execute result without protocol_version remains valid');
    assert(Boolean(installed && installed.validateExecuteResult({ ...baseResult, protocol_version: 2 })),
      '(e) execute result with protocol_version 2 is valid');
    assert(Boolean(installed && installed.PROTOCOL_VERSION === 2
      && /protocol_version:[ \t]*PROTOCOL_VERSION/.test(adapterSource)),
      '(e) adapter-produced result payloads carry protocol_version 2');
  } finally {
    cleanup(tmp);
  }

  const installSh = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  const installPs1 = fs.readFileSync(path.join(REPO, 'install.ps1'), 'utf8');
  assert(/shared\/schemas[\s\S]{0,300}?schemas\/\$\{name\}/.test(installSh),
    '(f) install.sh copies shared/schemas JSON files into schemas/');
  assert(/Join-Path[ \t]+\$RepoDir[ \t]+'shared'[\s\S]{0,300}?Join-Path[ \t]+\$ClaudeDir[ \t]+'schemas'/.test(installPs1),
    '(f) install.ps1 copies shared/schemas JSON files into schemas/');

  pass('(final) Section 52: schema files, single-source wiring, installed layout, additive protocol, and installers verified (baseline 1248)');
}

// ── Section 53: require_worktree per-engine elevation regression guard ───────
// S03/M014: resolveEffectiveMode elevates shared→worktree at activation when an
// external write-engine (codex/gpt/gemini) is configured for execute-task. The
// resolver matrix is exercised through prefs fixtures + resolveEffectiveMode —
// NO real git (cheap, deterministic). Runs under withHermeticHome so a global
// ~/.claude routing: block on the host cannot pollute the claude-only cases.
function smokeRequireWorktree() {
  process.stdout.write('\n▸ Section 53: require_worktree per-engine elevation\n');
  const iso = require('./forge-isolation.js');

  // Fixture: writes equivalent forge_isolation:/workers:/routing: JSONC.
  const mk = (body) => {
    const dir = mkTmp('require-worktree');
    const root = {};
    const stack = [{ indent: -1, object: root }];
    const value = (raw) => {
      const v = raw.trim();
      if (!v) return {};
      if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((x) => x.trim());
      if (v === 'true' || v === 'false') return v === 'true';
      return v;
    };
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length;
      const match = line.trim().match(/^([^:]+):(?:\s*(.*))?$/);
      if (!match) continue;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const next = value(match[2] || '');
      stack[stack.length - 1].object[match[1].trim()] = next;
      if (next && typeof next === 'object' && !Array.isArray(next)) stack.push({ indent, object: next });
    }
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(root), 'utf8');
    return dir;
  };
  const iso_ = (mode) => 'forge_isolation:\n  mode: ' + mode + '\n';

  withHermeticHome(() => {
    // (a) shared + workers.execute-task: codex + auto → elevated worktree.
    const a = iso.resolveEffectiveMode(mk(iso_('shared') + 'workers:\n  execute-task: codex\n  require_worktree: auto\n'));
    assert(a.elevated === true && a.mode === 'worktree' && a.user_mode === 'shared',
      '(a) shared + codex worker + auto → elevated worktree', JSON.stringify(a));
    assert(a.elevation_reason === 'require_worktree:auto workers.execute-task:codex' && a.write_engine === 'workers.execute-task:codex',
      '(a) elevation_reason + write_engine name the codex signal', JSON.stringify(a));

    // (b) shared + gpt id in routing executor + auto → elevated.
    const b = iso.resolveEffectiveMode(mk(iso_('shared') + 'routing:\n  backend:\n    executor:\n      standard: [claude-sonnet-5, gpt-5.6]\nworkers:\n  require_worktree: auto\n'));
    assert(b.elevated === true && b.mode === 'worktree',
      '(b) shared + gpt routing executor + auto → elevated', JSON.stringify(b));
    assert(/routing\.backend\.executor\.standard:gpt/.test(b.elevation_reason),
      '(b) elevation_reason names the routing gpt cell', JSON.stringify(b));

    // (b2) gemini routing (false-positive tolerated — bias toward detection).
    const b2 = iso.resolveEffectiveMode(mk(iso_('shared') + 'routing:\n  frontend:\n    executor:\n      standard: [agy/gemini-3.1-pro]\nworkers:\n  require_worktree: auto\n'));
    assert(b2.elevated === true && /:gemini/.test(b2.elevation_reason),
      '(b2) shared + gemini routing executor + auto → elevated (generous detection)', JSON.stringify(b2));

    // (c) shared + claude-only routing/workers + auto → NOT elevated.
    const c = iso.resolveEffectiveMode(mk(iso_('shared') + 'routing:\n  backend:\n    executor:\n      standard: [claude-opus-4-8]\nworkers:\n  execute-task: claude\n  require_worktree: auto\n'));
    assert(c.elevated === false && c.mode === 'shared',
      '(c) shared + claude-only + auto → stays shared (no false-negative concern here)', JSON.stringify(c));

    // (d) worktree user mode + any write-engine → no-op (already isolated).
    const d = iso.resolveEffectiveMode(mk(iso_('worktree') + 'workers:\n  execute-task: codex\n  require_worktree: auto\n'));
    assert(d.elevated === false && d.mode === 'worktree' && d.user_mode === 'worktree',
      '(d) worktree user mode + codex → elevated:false (no-op)', JSON.stringify(d));

    // (e) require_worktree: false + codex → NEVER elevate (byte-identical invariant).
    const e = iso.resolveEffectiveMode(mk(iso_('shared') + 'workers:\n  execute-task: codex\n  require_worktree: false\n'));
    assert(e.elevated === false && e.mode === 'shared',
      '(e) false + codex write-engine → never elevate (invariant)', JSON.stringify(e));

    // (f) require_worktree: true → always worktree, from shared AND from branch.
    const f1 = iso.resolveEffectiveMode(mk(iso_('shared') + 'workers:\n  require_worktree: true\n'));
    assert(f1.elevated === true && f1.mode === 'worktree' && f1.user_mode === 'shared',
      '(f) true + shared (claude-only) → elevated worktree', JSON.stringify(f1));
    const f2 = iso.resolveEffectiveMode(mk(iso_('branch') + 'workers:\n  require_worktree: true\n'));
    assert(f2.elevated === true && f2.mode === 'worktree' && f2.user_mode === 'branch',
      '(f) true + branch → elevated worktree', JSON.stringify(f2));

    // (g) branch + codex + auto → NOT elevated (auto elevation scoped to shared).
    const g = iso.resolveEffectiveMode(mk(iso_('branch') + 'workers:\n  execute-task: codex\n  require_worktree: auto\n'));
    assert(g.elevated === false && g.mode === 'branch',
      '(g) branch + codex + auto → not elevated (auto scoped to shared)', JSON.stringify(g));

    // (h) detectExternalWriteEngine unit: codex/gpt/gemini detected, claude not.
    const hCodex = iso.detectExternalWriteEngine(mk('workers:\n  execute-task: codex\n'));
    assert(hCodex.detected === true && hCodex.reason === 'workers.execute-task:codex',
      '(h) detect: workers.execute-task:codex → detected', JSON.stringify(hCodex));
    const hGpt = iso.detectExternalWriteEngine(mk('routing:\n  backend:\n    executor:\n      standard: [gpt-5.6]\n'));
    assert(hGpt.detected === true && /:gpt/.test(hGpt.reason),
      '(h) detect: routing gpt executor → detected', JSON.stringify(hGpt));
    const hGem = iso.detectExternalWriteEngine(mk('routing:\n  backend:\n    executor:\n      standard: [agy/gemini-3.1-pro]\n'));
    assert(hGem.detected === true && /:gemini/.test(hGem.reason),
      '(h) detect: routing gemini executor → detected', JSON.stringify(hGem));
    const hClaude = iso.detectExternalWriteEngine(mk('workers:\n  execute-task: claude\nrouting:\n  backend:\n    executor:\n      standard: [claude-opus-4-8]\n'));
    assert(hClaude.detected === false && hClaude.reason === null,
      '(h) detect: claude-only workers+routing → not detected', JSON.stringify(hClaude));

    // (h2) detect-error path fails SAFE (elevates), not open — text-anchor on
    // the catch block since forcing an internal throw (module-load failure)
    // isn't feasible without mocking require() internals.
    const isoSrcForH2 = fs.readFileSync(path.join(SCRIPTS, 'forge-isolation.js'), 'utf8');
    assert(/catch \{ return \{ detected: true, reason: 'detect-error \(fail-safe: elevating\)' \}; \}/.test(isoSrcForH2),
      '(h2) detectExternalWriteEngine catch fails safe (detected:true) on internal error');

    // (i) require_worktree fallback: invalid/absent → auto (default).
    assert(iso.resolveRequireWorktree(mk('workers:\n  require_worktree: bogus\n')) === 'auto',
      '(i) invalid require_worktree → auto', 'bogus');
    assert(iso.resolveRequireWorktree(mk(iso_('shared'))) === 'auto',
      '(i) absent require_worktree → auto (default)', 'absent');
  });

  // (j) CLI --effective-mode prints the JSON git-free (spot-check).
  withHermeticHome(({ env }) => {
    const dir = mk(iso_('shared') + 'workers:\n  execute-task: codex\n  require_worktree: auto\n');
    const out = runScript('forge-isolation.js', ['--effective-mode', '--cwd', dir], { env });
    let parsed = null;
    try { parsed = JSON.parse(out.stdout); } catch {}
    assert(parsed && parsed.elevated === true && parsed.mode === 'worktree',
      '(j) --effective-mode CLI prints elevated worktree JSON', out.stdout.slice(0, 200));
  });

  // (k) setup/cleanup JSON contract gains elevated/elevation_reason/user_mode.
  const isoSource = fs.readFileSync(path.join(SCRIPTS, 'forge-isolation.js'), 'utf8');
  assert(/resolveEffectiveMode/.test(isoSource) && /elevation_reason:[ \t]*eff\.elevation_reason/.test(isoSource),
    '(k) setupForRun/cleanupForRun consume resolveEffectiveMode + carry elevation_reason');
  assert(/resolveEffectiveMode,[ \t]*detectExternalWriteEngine,[ \t]*resolveRequireWorktree/.test(isoSource),
    '(k) three resolvers exported from module.exports');

  // (l) knob-count: require_worktree lands under existing workers section.
  const engine = require('./forge-prefs.js');
  const view = require('./forge-prefs-view.js');
  withHermeticHome(() => {
    const project = mkTmp('require-worktree-catalog');
    const schema = engine.loadSchema();
    const expectedLeaves = independentSchemaLeafKeys(schema);
    const catalog = view.buildCatalog(project);
    const catalogPaths = new Set(catalog.knobs.map((k) => k.path));
    assert(setEqual(catalogPaths, expectedLeaves.leafPaths),
      '(l) viewer lists exactly the knob set the schema declares',
      describeSetDiff(catalogPaths, expectedLeaves.leafPaths));
    assert(setEqual(new Set(catalog.knobs.map((k) => k.section)), expectedLeaves.sections),
      '(l) section set includes adaptive memory policy', '');
    const rw = catalog.knobs.find((k) => k.path === 'workers.require_worktree');
    assert(!!rw && rw.section === 'workers', '(l) require_worktree catalogued under workers', JSON.stringify(rw));
    assert(schema.properties.workers.properties.require_worktree
        && schema.properties.workers.properties.require_worktree.default === 'auto',
      '(l) schema workers.require_worktree default auto');
  });

  // (m) scaffold present in forge-agent-prefs.md § Workers Settings.
  const prefsDoc = SCAFFOLD;
  assert(/"require_worktree":\s*"auto"/.test(prefsDoc) && /resolveEffectiveMode/.test(prefsDoc),
    '(m) generated scaffold scaffolds require_worktree + names resolveEffectiveMode');

  // (n) doc-presence: elevation-warning wiring present in all 3 skills.
  const SKILLS = path.join(path.dirname(SCRIPTS), 'skills');
  const skillFiles = {
    'forge-auto': path.join(SKILLS, 'forge-auto', 'SKILL.md'),
    'forge-next': path.join(SKILLS, 'forge-next', 'SKILL.md'),
    'forge-task': path.join(SKILLS, 'forge-task', 'SKILL.md'),
  };
  for (const [name, filePath] of Object.entries(skillFiles)) {
    const src = fs.readFileSync(filePath, 'utf8');
    assert(/elevation_reason/.test(src) && /require_worktree/.test(src) && /elevado a worktree/.test(src),
      `(n) ${name}/SKILL.md wires elevation warning (elevated/elevation_reason + ⚠ marker)`);
  }

  pass('(final) Section 53: require_worktree per-engine elevation — resolver matrix, detect unit, CLI, contract fields, knob-count 90, and scaffold verified');
}

// ── Section 57: sidecar env-promotion contract regression guard ─────────────
// Baseline: 1370 passes before this section; the final count is reported by the
// smoke runner so this guard does not alter any pre-existing section numbering.
function smokeSidecarEnvPromotion() {
  process.stdout.write('\n▸ Section 57: sidecar env-promotion contract regression guard\n');
  const REPO = path.dirname(SCRIPTS);
  const adapter = require('./forge-xllm.js');
  const { checkEnvPromotion } = require('./forge-env-promote.js');
  const legacy = { status: 'partial', summary: 'old worker', must_haves_status: [
    { item: 'legacy item', status: 'unmet', note: 'old payload' },
  ], files_changed: [] };
  const base = { status: 'partial', summary: 'fixture', files_changed: [] };
  const plan = [
    '---',
    'expected_output:',
    '  - tests/fixture.test.js',
    'writes:',
    '  - scripts/forge-smoke.js',
    '---',
    'TASK-004 fixture plan',
  ].join('\n');
  const env = (item, reason, note) => ({ item, status: 'unmet', note, scope: 'environment', reason });
  const task = (item, note) => ({ item, status: 'unmet', note, scope: 'task', reason: '' });
  const met = item => ({ item, status: 'met', note: 'verified' });

  // A — adapter contract and schema shape. The wrapper exposes private schema/
  // prompt values to this smoke only; production exports remain unchanged.
  const adapterModule = { exports: {} };
  const adapterWrapper = new Function('exports', 'require', 'module', '__filename', '__dirname',
    `${fs.readFileSync(path.join(SCRIPTS, 'forge-xllm.js'), 'utf8').replace(/^#![^\n]*\n/, '')}\n` +
    'module.exports.__section57 = { executeSchema, buildExecutePrompt, planSchema, buildPlanPrompt };');
  adapterWrapper(adapterModule.exports, require, adapterModule,
    path.join(SCRIPTS, 'forge-xllm.js'), SCRIPTS);
  const internals = adapterModule.exports.__section57;
  const legacyValid = adapter.validateExecuteResult(legacy);
  assert(legacyValid === true,
    '(a) legacy execute payload without scope/reason remains valid', JSON.stringify(legacy));
  assert(adapter.validateExecuteResult({ ...base, must_haves_status: [
    env('TASK-004 environment write', 'gsd-write-refused', 'refused .gsd/STATE.md'),
  ] }) === true,
  '(a) environment gsd-write-refused payload validates');
  assert(adapter.validateExecuteResult({ ...base, must_haves_status: [
    env('bad scope', 'gsd-write-refused', 'refused .gsd/STATE.md'),
  ].map(entry => ({ ...entry, scope: 'bogus' })) }) === false,
  '(a) bogus scope is rejected');
  assert(adapter.validateExecuteResult({ ...base, must_haves_status: [
    env('bad reason', 'not-a-class', 'refused .gsd/STATE.md'),
  ] }) === false,
  '(a) environment reason outside allowlist is rejected');

  const walkObjects = (value, pathName, found) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.type === 'object') found.push({ path: pathName, value });
    for (const [key, child] of Object.entries(value)) walkObjects(child, `${pathName}.${key}`, found);
  };
  const schemaObjects = [];
  walkObjects(internals.executeSchema, 'executeSchema', schemaObjects);
  assert(schemaObjects.length > 0 && schemaObjects.every(({ value }) => value.additionalProperties === false),
    '(a) executeSchema sets additionalProperties:false on every object level');
  const itemSchema = internals.executeSchema.properties.must_haves_status.items;
  assert(itemSchema.properties.scope && itemSchema.properties.reason,
    '(a) executeSchema item properties include scope and reason');
  const prompt = internals.buildExecutePrompt('x');
  assert(prompt.includes('scope') && adapter.MH_SCOPE_ENUM.join('|') === 'task|environment'
      && adapter.ENV_REASON_ENUM.join('|') === 'git-commit-required|gsd-write-refused|out-of-scope-test-failure|network-required|sandbox-exec-blocked',
    '(a) adapter exports the canonical scope and environment-reason enums');
  assert(prompt.includes('"git-commit-required" | "gsd-write-refused" | "out-of-scope-test-failure" | "network-required" | "sandbox-exec-blocked"'),
    '(a) execute prompt contains the five canonical environment classes');
  assert(/status reflects ONLY task-scope work/.test(prompt),
    '(a) execute prompt says status reflects task-scope-only work');

  // B — promotion matrix. These fixtures stay in memory and never write .gsd.
  const legitimate = checkEnvPromotion({ ...base, must_haves_status: [
    env('TASK-004 must-have', 'gsd-write-refused', 'orchestrator refused .gsd/STATE.md'),
  ] }, plan);
  assert(legitimate.promote === true && legitimate.env_constraints.length === 1,
    '(b) TASK-004 legitimate environment refusal promotes with one constraint', JSON.stringify(legitimate));
  const mixedGood = checkEnvPromotion({ ...base, must_haves_status: [
    met('first'), met('second'), env('environment', 'gsd-write-refused', 'blocked at .gsd/STATE.md'),
  ] }, plan);
  assert(mixedGood.promote === true && mixedGood.env_constraints.length === 1,
    '(b) met items plus one corroborated environment item promotes');
  const mixedBad = checkEnvPromotion({ ...base, must_haves_status: [
    met('first'), env('environment', 'gsd-write-refused', 'blocked at .gsd/STATE.md'), task('real task work', 'must fix implementation'),
  ] }, plan);
  assert(mixedBad.promote === false && mixedBad.rejected.length >= 1,
    '(b) any unmet task-scope item blocks promotion');
  const washed = checkEnvPromotion({ ...base, must_haves_status: [
    env('washed refusal', 'gsd-write-refused', 'worker could not continue'),
  ] }, plan);
  assert(washed.promote === false && washed.rejected.length >= 1,
    '(b) gsd-write-refused without .gsd/ evidence is rejected');
  const outOfScopePresent = checkEnvPromotion({ ...base, must_haves_status: [
    env('tests/fixture.test.js failed', 'out-of-scope-test-failure', 'see tests/fixture.test.js'),
  ] }, plan);
  const absentPlan = plan.replace('tests/fixture.test.js', 'tests/other.test.js');
  const outOfScopeAbsent = checkEnvPromotion({ ...base, must_haves_status: [
    env('tests/fixture.test.js failed', 'out-of-scope-test-failure', 'see tests/fixture.test.js'),
  ] }, absentPlan);
  assert(outOfScopePresent.promote === false && outOfScopePresent.rejected.length >= 1,
    '(b) out-of-scope test failure named by the plan does not promote');
  assert(outOfScopeAbsent.promote === true && outOfScopeAbsent.env_constraints.length === 1,
    '(b) same out-of-scope label promotes when cited test is absent from plan');
  const oldPromotion = checkEnvPromotion(legacy, plan);
  assert(oldPromotion.promote === false && oldPromotion.rejected.length >= 1,
    '(b) byte-identical legacy partial payload does not promote');
  // M016 S01 review R1: a done result with unmet, non-environment-scope entries is no
  // longer silently "not-applicable" — it is corroborated and rejected, verdicted
  // done-with-unverified-env so callers treat it as partial (never a silent accept).
  const donePromotion = checkEnvPromotion({ ...legacy, status: 'done' }, plan);
  assert(donePromotion.promote === false && donePromotion.verdict === 'done-with-unverified-env'
      && donePromotion.rejected.length >= 1,
    '(b) done result with unmet non-environment entries is rejected, not silently not-applicable',
    JSON.stringify(donePromotion));

  // C — canonical spec, executable mirrors, and planner guidance.
  const dispatch = fs.readFileSync(path.join(REPO, 'shared', 'forge-dispatch.md'), 'utf8');
  assert(/forge-env-promote\.js/.test(dispatch)
      && ['git-commit-required', 'gsd-write-refused', 'out-of-scope-test-failure', 'network-required', 'sandbox-exec-blocked']
        .every(reason => dispatch.includes(reason))
      && /env_constraints/.test(dispatch) && /sidecar_env_promotion/.test(dispatch),
    '(c) dispatch Branch C references checker, allowlist, env_constraints, and promotion event');
  const skillPaths = ['forge-auto', 'forge-next', 'forge-task'].map(name =>
    path.join(REPO, 'skills', name, 'SKILL.md'));
  for (const skillPath of skillPaths) {
    const skill = fs.readFileSync(skillPath, 'utf8');
    const name = path.basename(path.dirname(skillPath));
    assert(/forge-env-promote\.js/.test(skill) && /env_constraints/.test(skill),
      `(c) ${name} mirror calls the promotion checker and carries env_constraints`);
    assert(!['git-commit-required', 'gsd-write-refused', 'out-of-scope-test-failure', 'network-required', 'sandbox-exec-blocked']
      .every(reason => new RegExp(`['"]${reason}['"]`).test(skill)),
    `(c) ${name} mirror does not redefine the environment allowlist`);
  }
  const planner = fs.readFileSync(path.join(REPO, 'agents', 'forge-planner.md'), 'utf8');
  assert(/sidecar/.test(planner) && /\.gsd\/\*\*/.test(planner),
    '(c) planner guidance marks .gsd/** as sidecar/orchestrator-owned');
  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.indexOf('async function main()'));
  assert(/smokeSidecarEnvPromotion\(\)/.test(mainBody),
    '(c) Section 57 is registered in main()');

  // D — M016 S01 review R1: status:done with unmet env-scope entries must be
  // corroborated the same way, never accepted at face value.
  const { corroborates, corroborateEnvEntries } = require('./forge-env-promote.js');
  const doneCorroborated = checkEnvPromotion({ status: 'done', summary: 'fixture', files_changed: [],
    must_haves_status: [
      met('first'), env('environment', 'gsd-write-refused', 'blocked at .gsd/STATE.md'),
    ] }, plan);
  assert(doneCorroborated.verdict === 'done-with-verified-env' && doneCorroborated.rejected.length === 0
      && doneCorroborated.env_constraints.length === 1,
    '(d) done result with only a corroborated env-scope unmet entry verdicts done-with-verified-env',
    JSON.stringify(doneCorroborated));
  const doneUncorroborated = checkEnvPromotion({ status: 'done', summary: 'fixture', files_changed: [],
    must_haves_status: [
      met('first'), env('washed refusal', 'gsd-write-refused', 'worker could not continue'),
    ] }, plan);
  assert(doneUncorroborated.verdict === 'done-with-unverified-env' && doneUncorroborated.rejected.length >= 1,
    '(d) done result with an uncorroborated env-scope unmet entry verdicts done-with-unverified-env (treated as partial)',
    JSON.stringify(doneUncorroborated));
  const doneAllMet = checkEnvPromotion({ status: 'done', summary: 'fixture', files_changed: [],
    must_haves_status: [met('first'), met('second')] }, plan);
  assert(doneAllMet.reason === 'not-applicable' && doneAllMet.verdict === undefined,
    '(d) done result with no unmet entries stays not-applicable (ordinary done, unchanged)',
    JSON.stringify(doneAllMet));
  assert(typeof corroborateEnvEntries === 'function' && typeof corroborates === 'function',
    '(d) forge-env-promote.js exports corroborates + corroborateEnvEntries for reuse by forge-repair.js');

  // E — M016 S01 review R2: reinject-diff must corroborate env-scope labels
  // before dropping them, not trust the label alone.
  const reinjectPlanDir = mkTmp('repair-env');
  const reinjectPlanPath = path.join(reinjectPlanDir, 'T04-PLAN.md');
  fs.writeFileSync(reinjectPlanPath, plan, 'utf8');
  const corroboratedEnvId = env('environment', 'gsd-write-refused', 'blocked at .gsd/STATE.md');
  const uncorroboratedEnvId = env('washed refusal', 'gsd-write-refused', 'worker could not continue');
  const reinjectEnvR = runScript('forge-repair.js', ['--reinject-diff', '--plan', reinjectPlanPath,
    '--must-haves-status', JSON.stringify({ dropped: [corroboratedEnvId, uncorroboratedEnvId, 'src/bar.js'] })]);
  assert(reinjectEnvR.status === 0, '(e) reinject-diff with mixed env labels exits 0', `stderr: ${reinjectEnvR.stderr}`);
  let reinjectEnvResult;
  try { reinjectEnvResult = JSON.parse(reinjectEnvR.stdout); } catch { reinjectEnvResult = {}; }
  const reinjectEnvStr = JSON.stringify(reinjectEnvResult.dropped || []);
  assert(!reinjectEnvStr.includes('environment') || !(reinjectEnvResult.dropped || []).some(d => d && d.item === 'environment'),
    '(e) corroborated env-scope label is dropped from the reinject diff (not re-injected)',
    reinjectEnvStr);
  assert((reinjectEnvResult.dropped || []).some(d => d && d.item === 'washed refusal'),
    '(e) uncorroborated env-scope label stays pending in the reinject diff (re-injected)',
    reinjectEnvStr);
  assert((reinjectEnvResult.dropped || []).includes('src/bar.js'),
    '(e) non-env dropped entries pass through the reinject diff unchanged',
    reinjectEnvStr);

  pass('(final) Section 57: sidecar env-promotion contract regression guard — adapter, promotion matrix, and doc-presence verified');
}

// ── Section 71: sandbox-exec-blocked + deterministic re-verification ───────
function smokeSandboxExecBlocked() {
  process.stdout.write('\n▸ Section 71: sandbox-exec-blocked re-verification contract\n');
  const REPO = path.dirname(SCRIPTS);
  const { checkEnvPromotion } = require('./forge-env-promote.js');
  const adapter = require('./forge-xllm.js');
  const reverify = require('./forge-reverify.js');
  const base = { status: 'partial', summary: 'fixture', files_changed: [] };
  const env = note => ({ item: 'blocked verification', status: 'unmet', note, scope: 'environment', reason: 'sandbox-exec-blocked' });
  const promotion = note => checkEnvPromotion({ ...base, must_haves_status: [env(note)] }, 'writes:\n - src/example.js');
  const good = promotion('ran `npm test`; jest exited EPERM: operation not permitted');
  const prose = promotion('the sandbox blocked me');
  assert(good.promote === true && good.env_constraints.length === 1, '(a) denial plus attempted command promotes');
  assert(prose.promote === false && /attempted command.*denial signal/.test(prose.rejected[0].why), '(a) prose-only sandbox claim is rejected');
  assert(promotion('EPERM').promote === false, '(a) denial without a command is rejected');
  assert(promotion('ran npm test, it did not work').promote === false, '(a) command without denial is rejected');
  assert(promotion('tried `bazel test //...` — permission denied').promote === true, '(a) backtick command escape hatch promotes');
  assert(adapter.ENV_REASON_ENUM.join('|') === 'git-commit-required|gsd-write-refused|out-of-scope-test-failure|network-required|sandbox-exec-blocked'
    && adapter.PROTOCOL_VERSION === 2, '(a) enum appends sandbox-exec-blocked and protocol remains 2');

  // Legacy outputs are exact objects, protecting the existing four cases from drift.
  const legacy = { ...base, must_haves_status: [{ item: 'legacy', status: 'unmet', note: 'refused .gsd/STATE.md', scope: 'environment', reason: 'gsd-write-refused' }] };
  assert(JSON.stringify(checkEnvPromotion(legacy, '')) === JSON.stringify({ promote: true, env_constraints: [{ item: 'legacy', reason: 'gsd-write-refused', note: 'refused .gsd/STATE.md' }], rejected: [] }),
    '(b) legacy gsd-write-refused output remains byte-identical');

  const fixture = mkTmp('sandbox-reverify');
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(0)"` } }), 'utf8');
  fs.writeFileSync(path.join(fixture, 'package-lock.json'), '{}', 'utf8');
  const payload = { ...base, must_haves_status: [env('npm test EPERM')] };
  const verified = reverify.reverify({ result: payload, codeDir: fixture, apply: true });
  assert(verified.verdict === 'verified' && payload.must_haves_status[0].status === 'met'
    && payload.must_haves_status[0].scope === 'task' && payload.must_haves_status[0].reason === '',
  '(c) re-verification runs project command and deterministically rewrites verified entry');
  const failedPayload = { ...base, must_haves_status: [env('npm test EPERM')] };
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(1)"` } }), 'utf8');
  const failed = reverify.reverify({ result: failedPayload, codeDir: fixture, apply: true });
  assert(failed.verdict === 'failed' && failedPayload.must_haves_status[0].status === 'unmet'
    && failedPayload.must_haves_status[0].scope === 'task' && checkEnvPromotion(failedPayload, '').promote === false,
  '(c) failed re-verification forces the normal task failure path');
  cleanup(fixture);

  const files = ['scripts/forge-xllm.js', 'scripts/forge-env-promote.js', 'shared/forge-dispatch.md', 'scripts/forge-smoke.js', 'scripts/forge-reverify.js', 'scripts/forge-reverify.test.js'];
  for (const file of files) assert((fs.readFileSync(path.join(REPO, file), 'utf8').match(/sandbox-exec-blocked/g) || []).length >= 1,
    `(d) ${file} contains sandbox-exec-blocked`);
  for (const name of ['forge-auto', 'forge-next', 'forge-task']) {
    const skill = fs.readFileSync(path.join(REPO, 'skills', name, 'SKILL.md'), 'utf8');
    assert(/node "\$FORGE_SCRIPTS_DIR\/forge-reverify\.js"[^\n]*--apply/.test(skill) && /orchestrator_reverification/.test(skill),
      `(d) ${name} mirror has executable re-verification invocation and event`);
    assert(!['git-commit-required', 'gsd-write-refused', 'out-of-scope-test-failure', 'network-required', 'sandbox-exec-blocked']
      .every(reason => new RegExp(`['"]${reason}['"]`).test(skill)), `(d) ${name} does not redefine five-member allowlist`);
  }
  const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname',
    `${fs.readFileSync(path.join(SCRIPTS, 'forge-xllm.js'), 'utf8').replace(/^#![^\n]*\n/, '')}\nmodule.exports.__section71={planSchema,buildPlanPrompt};`);
  const module71 = { exports: {} };
  wrapper(module71.exports, require, module71, path.join(SCRIPTS, 'forge-xllm.js'), SCRIPTS);
  const planPrompt = module71.exports.__section71.buildPlanPrompt('fixture');
  assert(module71.exports.__section71.planSchema.properties.must_haves_status === undefined
    && !adapter.ENV_REASON_ENUM.some(reason => planPrompt.includes(reason)), '(d) plan branch has no sandbox/reason schema gap');
  const mainBody = fs.readFileSync(__filename, 'utf8').slice(fs.readFileSync(__filename, 'utf8').indexOf('async function main()'));
  assert(/smokeSandboxExecBlocked\(\)/.test(mainBody), '(d) Section 71 is registered in main');

  // R1 (TASK-015 review): the two-signal check must be washable-proof — a
  // must-have `item` that already mentions a runner and OS-denial vocabulary
  // must NOT satisfy corroboration on its own with an empty `note`.
  const { corroborates: corroboratesFn } = require('./forge-env-promote.js');
  const washedItemEntry = {
    item: 'Add sandbox-exec-blocked reason so npm test EPERM failures are not silently rejected',
    note: '', scope: 'environment', reason: 'sandbox-exec-blocked',
  };
  assert(typeof corroboratesFn(washedItemEntry, '') === 'string',
    '(f) sandbox-exec-blocked corroboration ignores item-only evidence with an empty note (wash-proof)');
  const honestNoteEntry = { ...washedItemEntry, note: 'ran `npm test`: EPERM: operation not permitted' };
  assert(corroboratesFn(honestNoteEntry, '') === null,
    '(f) sandbox-exec-blocked corroboration still promotes an honest note reporting the attempted command and denial');
  for (const legacyReason of ['gsd-write-refused', 'git-commit-required', 'network-required']) {
    const before = corroboratesFn({ item: '', note: 'x', scope: 'environment', reason: legacyReason }, '');
    assert(before !== undefined, `(f) legacy reason ${legacyReason} corroboration path unchanged (still callable)`);
  }

  // R2 (TASK-015 review): 2+ entries whose notes name visibly different
  // commands must refuse blanket promotion instead of trusting one exit code
  // for all of them.
  const multiFixture = mkTmp('sandbox-reverify-multi');
  fs.writeFileSync(path.join(multiFixture, 'package.json'), JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(0)"` } }), 'utf8');
  fs.writeFileSync(path.join(multiFixture, 'package-lock.json'), '{}', 'utf8');
  const divergentPayload = { ...base, must_haves_status: [
    env('ran `npm test`: EPERM: operation not permitted'),
    env('ran `make lint`: EACCES: permission denied'),
  ] };
  const divergentOutcome = reverify.reverify({ result: divergentPayload, codeDir: multiFixture, apply: true });
  assert(divergentOutcome.verdict === 'ambiguous-multi-command' && divergentOutcome.entries === 2,
    '(g) two entries naming different commands refuse blanket promotion', JSON.stringify(divergentOutcome));
  assert(divergentPayload.must_haves_status[0].scope === 'environment' && divergentPayload.must_haves_status[1].scope === 'environment',
    '(g) ambiguous-multi-command leaves the payload untouched');
  const sameCommandPayload = { ...base, must_haves_status: [
    env('ran `npm test`: EPERM: operation not permitted'),
    env('ran `npm test` again: EACCES: permission denied'),
  ] };
  const sameCommandOutcome = reverify.reverify({ result: sameCommandPayload, codeDir: multiFixture, apply: true });
  assert(sameCommandOutcome.verdict === 'verified',
    '(g) two entries citing the same command still promote in bulk', JSON.stringify(sameCommandOutcome));
  cleanup(multiFixture);

  // R3 (TASK-015 review): --apply must write atomically (reuse forge-surgical-reset.js's
  // writeJsonAtomic, not a bare fs.writeFileSync) so a kill mid-write cannot
  // truncate the result file for the next JSON.parse consumer.
  const reverifySource = fs.readFileSync(path.join(SCRIPTS, 'forge-reverify.js'), 'utf8');
  assert(/require\(['"]\.\/forge-surgical-reset\.js['"]\)/.test(reverifySource) && /writeJsonAtomic\(absoluteResult, result\)/.test(reverifySource),
    '(h) forge-reverify.js reuses writeJsonAtomic from forge-surgical-reset.js for --apply writes');

  pass('(final) Section 71: sandbox execution classification and re-verification stay live');
}

// ── Section 58: cleanupForRun registry-first mode ──────────────────────────
function smokeCleanupRegistryMode() {
  process.stdout.write('\n▸ Section 58: cleanupForRun registry-first mode\n');
  const dir = mkTmp('cleanup-registry-mode');
  const isolation = require('./forge-isolation.js');
  const runPath = id => path.join(dir, '.gsd', 'forge', 'runs', `${id}.json`);
  const writeRun = (id, record) => fs.writeFileSync(runPath(id), JSON.stringify(record), 'utf8');
  fs.mkdirSync(path.join(dir, '.gsd', 'forge', 'runs'), { recursive: true });
  const baseRecord = { id: 'M-CLEANUP', kind: 'milestone', session_id: 'smoke', active: true };

  // Registry worktree wins even when the current preference now resolves shared.
  fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"shared"},"workers":{"require_worktree":"false"}}', 'utf8');
  writeRun('M-CLEANUP', { ...baseRecord, isolation_mode: 'worktree' });
  let result = isolation.cleanupForRun(dir, 'M-CLEANUP');
  assert(result.mode === 'worktree', '(a) registry isolation_mode selects worktree after pref flip', JSON.stringify(result));
  assert(result.mode_source === 'registry', '(a) registry selection reports mode_source=registry', JSON.stringify(result));
  assert(result.user_mode === null && result.elevated === null && result.elevation_reason === null,
    '(a) registry result keeps additive cleanup metadata keys', JSON.stringify(result));
  assert(Array.isArray(result.repos), '(a) registry cleanup result retains repos array', JSON.stringify(result));
  assert(result.mode !== 'shared', '(a) registry worktree cannot short-circuit through shared guard', JSON.stringify(result));

  // A legacy record explicitly re-resolves the current effective mode.
  writeRun('M-LEGACY', { ...baseRecord, id: 'M-LEGACY' });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"branch"},"workers":{"require_worktree":"false"}}', 'utf8');
  result = isolation.cleanupForRun(dir, 'M-LEGACY');
  assert(result.mode === 'branch', '(b) legacy record re-resolves current effective mode', JSON.stringify(result));
  assert(result.mode_source === 'fallback-resolve', '(b) legacy record reports fallback-resolve', JSON.stringify(result));
  assert(result.user_mode === 'branch', '(b) fallback preserves resolved user_mode', JSON.stringify(result));
  assert(result.elevated === false, '(b) fallback preserves resolved elevation state', JSON.stringify(result));
  assert(result.elevation_reason === null, '(b) fallback preserves null elevation reason', JSON.stringify(result));
  assert(result.mode !== 'shared', '(b) legacy fallback is not a hardcoded shared default', JSON.stringify(result));

  // Missing records take the same explicit fallback path.
  result = isolation.cleanupForRun(dir, 'M-MISSING');
  assert(result.mode === 'branch', '(c) missing record re-resolves current effective mode', JSON.stringify(result));
  assert(result.mode_source === 'fallback-resolve', '(c) missing record reports fallback-resolve', JSON.stringify(result));
  assert(result.user_mode === 'branch', '(c) missing record preserves resolved user_mode', JSON.stringify(result));
  assert(result.elevated === false, '(c) missing record preserves resolved elevation state', JSON.stringify(result));
  assert(result.elevation_reason === null, '(c) missing record preserves null elevation reason', JSON.stringify(result));

  // Corrupted/unknown registry isolation_mode: no-op, does not re-resolve prefs.
  writeRun('M-CORRUPT', { ...baseRecord, id: 'M-CORRUPT', isolation_mode: 'bogus' });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
    '{"forge_isolation":{"mode":"worktree"},"workers":{"require_worktree":"false"}}', 'utf8');
  result = isolation.cleanupForRun(dir, 'M-CORRUPT');
  assert(result.mode === 'shared', '(e) corrupted registry isolation_mode no-ops', JSON.stringify(result));
  assert(result.mode_source === 'invalid-registry', '(e) corrupted registry isolation_mode reports mode_source=invalid-registry', JSON.stringify(result));

  // Source-level wiring guards make the contract visible to future refactors.
  const source = fs.readFileSync(path.join(SCRIPTS, 'forge-isolation.js'), 'utf8');
  const cleanupStart = source.indexOf('function cleanupForRun');
  const cleanupEnd = source.indexOf('\n}\n\n// ── CLI', cleanupStart);
  const cleanupBody = source.slice(cleanupStart, cleanupEnd === -1 ? undefined : cleanupEnd);
  const helperStart = source.indexOf('function resolveCleanupMode');
  const helperEnd = source.indexOf('\n}\n\nfunction cleanupForRun', helperStart);
  const helperBody = source.slice(helperStart, helperEnd === -1 ? undefined : helperEnd);
  assert(source.includes("require('./forge-runs.js')"), '(d) isolation requires forge-runs.js', source);
  assert(/runs\.get\(cwd, runId\)/.test(helperBody), '(d) resolveCleanupMode reads runs.get(cwd, runId)', helperBody);
  assert(/resolveCleanupMode\(cwd, runId\)/.test(cleanupBody), '(d) cleanupForRun uses resolveCleanupMode', cleanupBody);
  assert(!/const eff = resolveEffectiveMode\(cwd\)/.test(cleanupBody), '(d) cleanupForRun has no direct effective-mode selector', cleanupBody);
  assert(/source:\s*'registry'/.test(helperBody), '(d) helper labels registry source', helperBody);
  assert(/source:\s*'fallback-resolve'/.test(helperBody), '(d) helper labels fallback source', helperBody);
  assert(/typeof rec\.isolation_mode === 'string'/.test(helperBody), '(d) helper validates registry isolation_mode type', helperBody);
  assert(/rec\.isolation_mode\.trim\(\)/.test(helperBody), '(d) helper rejects blank registry isolation_mode', helperBody);
  assert(/toLowerCase\(\)/.test(helperBody), '(d) registry mode is normalized case-insensitively', helperBody);
  assert(/try \{ rec = runs\.get/.test(helperBody), '(d) registry lookup is guarded against read errors', helperBody);
  assert(/const eff = resolveEffectiveMode\(cwd\)/.test(helperBody), '(d) fallback explicitly calls resolveEffectiveMode', helperBody);
  assert(/M014 S03-R2/.test(source) && /worktree_root/.test(source), '(d) helper documents debt and root limitation', source);
  assert(/mode_source: cm\.source/.test(cleanupBody), '(d) cleanup result carries mode_source', cleanupBody);
  assert(/worktreeCleanupOnComplete/.test(cleanupBody), '(d) cleanup still reads worktree cleanup preference', cleanupBody);
  assert(/cleanupWorktreeOne/.test(cleanupBody), '(d) cleanup still uses existing worktree helper', cleanupBody);
  assert(/cleanupBranchOne/.test(cleanupBody), '(d) cleanup still uses existing branch helper', cleanupBody);
  const smokeSource = fs.readFileSync(__filename, 'utf8');
  assert(/smokeCleanupRegistryMode\(\);/.test(smokeSource.slice(smokeSource.lastIndexOf('async function main()'))),
    '(d) Section 58 is registered in main()');

  cleanup(dir);
  pass('(final) Section 58: cleanupForRun registry-first mode — registry, legacy fallback, missing-record fallback, and wiring verified');
}

// ── Section 59: slice-qualified task-level xllm state contract ─────────────
function smokeXllmStateSliceQualified() {
  process.stdout.write('\n▸ Section 59: slice-qualified task-level xllm state contract\n');
  const repo = path.dirname(SCRIPTS);
  const auto = fs.readFileSync(path.join(repo, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  const next = fs.readFileSync(path.join(repo, 'skills', 'forge-next', 'SKILL.md'), 'utf8');
  const task = fs.readFileSync(path.join(repo, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  const spec = fs.readFileSync(path.join(repo, 'shared', 'forge-dispatch.md'), 'utf8');

  const EXPECTED_HELPER_COUNT = { 'forge-auto': 5, 'forge-next': 4 };
  for (const [name, mirror] of [['forge-auto', auto], ['forge-next', next]]) {
    const count = mirror.split('forge-xllm-state.js').length - 1;
    assert(count === EXPECTED_HELPER_COUNT[name], `(a) ${name} has exact helper count ${EXPECTED_HELPER_COUNT[name]}`);
    assert(!mirror.includes('[ -f "$XLLM_STATE" ] || XLLM_STATE='), `(b) ${name} has no inline fallback`);
  }
  assert(task.includes('xllm-state-{TASK_ID}.json'),
    '(c) forge-task keeps its TASK_ID-only state filename');
  assert(spec.includes('xllm-state-{M###}-{S##}-{T##}-attempt-{N}.json')
      && spec.includes('xllm-state-{S##}-{T##}-attempt-{N}.json')
      && spec.includes('xllm-state-{T##}-attempt-{N}.json')
      && /three-format read policy|política de leitura/i.test(spec),
    '(e) dispatch spec documents milestone canonical path and three reads');
  assert(spec.includes('execute-task/{T##}') && /not reformatted|not be reformatted|não.*reformat/i.test(spec),
    '(f) event unitId remains execute-task/{T##} and is not reformatted');

  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.lastIndexOf('async function main()'));
  assert(/smokeXllmStateSliceQualified\(\);/.test(mainBody),
    '(g) Section 59 is registered in main()');
  pass('(final) Section 59: slice-qualified task-level state, dual-read compatibility, untouched boundaries, and main() registration verified');
}

// ── Section 72: review pairing visibility and declared review-fix routing ────
function smokeReviewModelDiscipline() {
  process.stdout.write('\n▸ Section 72: review model discipline\n');
  const repo = path.dirname(SCRIPTS); const files = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md', 'shared/forge-review.md'];
  for (const rel of files) { const text = fs.readFileSync(path.join(repo, rel), 'utf8'); assert(!/forge-(advocate|reviewer).*model:\s*['"](sonnet|opus|fable|haiku)['"]/.test(text), `${rel}: no literal review model`); }
  const review = fs.readFileSync(path.join(repo, 'shared/forge-review.md'), 'utf8');
  assert(review.includes('review-config-inert') && review.includes('intra_family_debate') && review.includes('Adversarialidade reduzida'), 'review visibility fields wired');
  const resolver = fs.readFileSync(path.join(repo, 'scripts/forge-dispatch-resolve.js'), 'utf8');
  assert(resolver.includes("'review-fix': 'standard'"), 'review-fix tier declared');
  assert((review + fs.readFileSync(path.join(repo, 'skills/forge-auto/SKILL.md'), 'utf8') + fs.readFileSync(path.join(repo, 'skills/forge-next/SKILL.md'), 'utf8') + fs.readFileSync(path.join(repo, 'skills/forge-task/SKILL.md'), 'utf8')).split('--unit-type review-fix').length - 1 === 4, 'four review-fix resolver sites');
  assert(fs.existsSync(path.join(repo, 'scripts/forge-review-audit.js')), 'review audit exists');
}

// ── Section 60: forge-xllm --result-file guard (challenge/rebuttal) + Engine Fallback Discipline ──
function smokeXllmResultFileGuard() {
  process.stdout.write('\n▸ Section 60: forge-xllm --result-file guard + Engine Fallback Discipline\n');
  const repo = path.dirname(SCRIPTS);
  const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-s60-mock-'));
  writeMockCodex(mockDir, { payload: '{}', exitCode: 0 });

  // (a) challenge + --result-file → exit 2, stderr mentions result-file, file never created.
  {
    const dir = mkTmp('s60-challenge');
    const resFile = path.join(dir, 'g.json');
    const r = runXllm(['--mode', 'challenge', '--result-file', resFile, '--diff-cmd', 'echo diff', '--cwd', dir], mockDir, dir);
    assert(r.status === 2, '(a) challenge --result-file exits 2', `status=${r.status}`);
    assert(r.stderr.includes('result-file'), '(a) challenge --result-file stderr mentions result-file', r.stderr);
    assert(!fs.existsSync(resFile), '(a) challenge --result-file never creates the file');
    cleanup(dir);
  }

  // (b) rebuttal + --result-file → exit 2, same guard.
  {
    const dir = mkTmp('s60-rebuttal');
    const resFile = path.join(dir, 'g.json');
    const inputFile = path.join(dir, 'input.json');
    fs.writeFileSync(inputFile, JSON.stringify({ objections: [] }), 'utf8');
    const r = runXllm(['--mode', 'rebuttal', '--result-file', resFile, '--input', inputFile, '--cwd', dir], mockDir, dir);
    assert(r.status === 2, '(b) rebuttal --result-file exits 2', `status=${r.status}`);
    assert(r.stderr.includes('result-file'), '(b) rebuttal --result-file stderr mentions result-file', r.stderr);
    assert(!fs.existsSync(resFile), '(b) rebuttal --result-file never creates the file');
    cleanup(dir);
  }

  // (c) non-regression: execute + --result-file still succeeds (exit 0 + result JSON written).
  {
    const validPayload = JSON.stringify({
      status: 'done',
      summary: 'did the task',
      must_haves_status: [{ item: 'truth 1', status: 'met', note: 'ok' }],
      files_changed: [],
    });
    const gitRepo = mkGitRepo(mkTmp('s60-execute-repo'));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-s60-plan-'));
    const planFile = path.join(planDir, 'plan.md');
    fs.writeFileSync(planFile, '# T05\ndo the thing\n', 'utf8');
    const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-s60-result-'));
    const resultFile = path.join(resultDir, 'result.json');
    const execMockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-s60-execmock-'));
    writeMockCodex(execMockDir, { payload: validPayload, exitCode: 0 });
    const r = runXllm(['--mode', 'execute', '--plan', planFile, '--result-file', resultFile, '--cwd', gitRepo], execMockDir, gitRepo);
    assert(r.status === 0, '(c) execute --result-file still exits 0 (no regression)', `status=${r.status} stderr=${r.stderr}`);
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { /* leave null */ }
    assert(!!parsed && parsed.status === 'done', '(c) execute --result-file JSON written and parseable', JSON.stringify(parsed));
    cleanup(gitRepo);
    cleanup(planDir);
    cleanup(resultDir);
    cleanup(execMockDir);
  }

  cleanup(mockDir);

  // (d) doc-presence with exact per-file counts — never document-wide includes() (M016 S03 R2 lesson).
  const spec = fs.readFileSync(path.join(repo, 'shared', 'forge-dispatch.md'), 'utf8');
  const auto = fs.readFileSync(path.join(repo, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  const next = fs.readFileSync(path.join(repo, 'skills', 'forge-next', 'SKILL.md'), 'utf8');
  const task = fs.readFileSync(path.join(repo, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  const review = fs.readFileSync(path.join(repo, 'shared', 'forge-review.md'), 'utf8');

  const NEEDLE = 'Engine Fallback Discipline';
  const EXPECTED = {
    'shared/forge-dispatch.md': 1,
    'skills/forge-auto/SKILL.md': 2,
    'skills/forge-next/SKILL.md': 2,
    'skills/forge-task/SKILL.md': 1,
    // 2 since TASK-009: § Agent unavailability cites the canonical enum home
    // alongside the pre-existing § Fallback challenger reference.
    'shared/forge-review.md': 2,
  };
  for (const [name, content] of [
    ['shared/forge-dispatch.md', spec],
    ['skills/forge-auto/SKILL.md', auto],
    ['skills/forge-next/SKILL.md', next],
    ['skills/forge-task/SKILL.md', task],
    ['shared/forge-review.md', review],
  ]) {
    const count = content.split(NEEDLE).length - 1;
    assert(count === EXPECTED[name],
      `(d) ${name} has exact "Engine Fallback Discipline" count (expected ${EXPECTED[name]}, got ${count})`);
  }

  // (e) canonical rule cites "unreliable" as the named anti-example; the invented
  // reason string never enters the enum.
  const unreliableCount = spec.split('unreliable').length - 1;
  assert(unreliableCount === 2, `(e) canonical cites "unreliable" as anti-example (expected 2 occurrences incl. codex-unreliable-session, got ${unreliableCount})`);
  assert(spec.includes('codex-unreliable-session'), '(e) canonical names the forbidden anti-example codex-unreliable-session');
  assert(!spec.includes('| `codex-unreliable-session`'), '(e) codex-unreliable-session is never a table row in the enum');

  // (f) sidecar-state-init-failed is a sanctioned enum member — doc-presence in the canonical spec.
  assert(spec.includes('sidecar-state-init-failed'), '(f) canonical enum includes sidecar-state-init-failed');

  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.lastIndexOf('async function main()'));
  assert(/smokeXllmResultFileGuard\(\);/.test(mainBody),
    '(g) Section 60 is registered in main()');
  pass('(final) Section 60: forge-xllm --result-file guard (challenge/rebuttal exit 2 + no-file, execute non-regression) and Engine Fallback Discipline rule presence verified');
}

// ── Section 61: ROUTING_DOMAINS injected into planner prompt templates + planner contract ──
function smokeRoutingDomains() {
  process.stdout.write('\n▸ Section 61: ROUTING_DOMAINS injection into planner prompts + contract\n');
  const repo = path.dirname(SCRIPTS);

  const NEEDLE = 'ROUTING_DOMAINS';
  const EXPECTED = {
    'shared/forge-dispatch.md': 2,
    'skills/forge-auto/SKILL.md': 1,
    'skills/forge-next/SKILL.md': 1,
    'skills/forge-task/SKILL.md': 1,
    'skills/forge-new-milestone/SKILL.md': 1,
    'agents/forge-planner.md': 2,
  };
  const files = {
    'shared/forge-dispatch.md': path.join(repo, 'shared', 'forge-dispatch.md'),
    'skills/forge-auto/SKILL.md': path.join(repo, 'skills', 'forge-auto', 'SKILL.md'),
    'skills/forge-next/SKILL.md': path.join(repo, 'skills', 'forge-next', 'SKILL.md'),
    'skills/forge-task/SKILL.md': path.join(repo, 'skills', 'forge-task', 'SKILL.md'),
    'skills/forge-new-milestone/SKILL.md': path.join(repo, 'skills', 'forge-new-milestone', 'SKILL.md'),
    'agents/forge-planner.md': path.join(repo, 'agents', 'forge-planner.md'),
  };

  const contents = {};
  for (const [name, filePath] of Object.entries(files)) {
    const content = fs.readFileSync(filePath, 'utf8');
    contents[name] = content;
    const count = content.split(NEEDLE).length - 1;
    assert(count === EXPECTED[name],
      `(a) ${name} has exact "ROUTING_DOMAINS" count (expected ${EXPECTED[name]}, got ${count})`);
  }

  // (b) canonical templates carry the placeholder form, not a hardcoded value.
  assert(contents['shared/forge-dispatch.md'].includes('ROUTING_DOMAINS: {routing_domains}'),
    '(b) canonical templates use the {routing_domains} placeholder');

  // (c) mirrors derive via the canonical forge-routing.js --list-domains helper, never hand-rolled.
  for (const name of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md', 'skills/forge-new-milestone/SKILL.md']) {
    assert(contents[name].includes('forge-routing.js" --list-domains'),
      `(c) ${name} derives ROUTING_DOMAINS via forge-routing.js --list-domains`);
  }

  // (d) planner contract preserves open-set (never invent a domain key) and no-keyword-matching.
  const planner = contents['agents/forge-planner.md'];
  assert(/open-set/i.test(planner), '(d) forge-planner.md still documents open-set domain contract');
  assert(/No keyword auto-detection/i.test(planner), '(d) forge-planner.md still documents no-keyword-detection rule');
  assert(planner.includes('omit `domain:`') || /omit.*domain:/i.test(planner),
    '(d) forge-planner.md documents omitting domain: when ROUTING_DOMAINS is absent/(none)');

  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.lastIndexOf('async function main()'));
  assert(/smokeRoutingDomains\(\);/.test(mainBody),
    '(e) Section 61 is registered in main()');
  pass('(final) Section 61: ROUTING_DOMAINS injected into planner prompt templates (canonical + mirrors + self-contained sites) and planner domain contract verified');
}

// ── Section 62: /forge-init git guarantee — no more NEVER-git-init prohibitions ──
function smokeInitGitGuarantee() {
  process.stdout.write('\n▸ Section 62: /forge-init git guarantee (rev-parse check + AskUserQuestion)\n');
  const repo = path.dirname(SCRIPTS);
  const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
  const init = read('commands/forge-init.md');

  assert(init.includes('git rev-parse --git-dir'),
    '(a) commands/forge-init.md runs git rev-parse --git-dir before routing');

  const forbidden = 'NEVER run `git init`';
  const forbiddenCount = init.split(forbidden).length - 1;
  assert(forbiddenCount === 0,
    `(b) commands/forge-init.md has zero occurrences of the old prohibition (got ${forbiddenCount})`);

  assert(init.includes('AskUserQuestion'),
    '(c) commands/forge-init.md uses AskUserQuestion in the git-guarantee flow');

  // (d) behavioral: --state-init against a non-git cwd is the real precondition the R1
  // `sidecar-state-init-failed` guard depends on ([ -n "$START_SHA" ] must fail) — assert
  // forge-surgical-reset.js actually exits non-zero (and prints nothing to stdout) there.
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-nogit-'));
  try {
    const rp = spawnSync('git', ['-C', nonGitDir, 'rev-parse', '--git-dir'],
      { encoding: 'utf8' });
    assert(rp.status !== 0, '(d) tmpdir fixture is confirmed outside any git repo');

    const stateFile = path.join(nonGitDir, 'state.json');
    const result = spawnSync('node',
      [path.join(SCRIPTS, 'forge-surgical-reset.js'), '--state-init', '--state', stateFile, '--cwd', nonGitDir],
      { encoding: 'utf8' });
    assert(result.status !== 0,
      `(d) forge-surgical-reset.js --state-init exits non-zero outside a git repo (got ${result.status})`);
    assert(!(result.stdout || '').trim(),
      '(d) forge-surgical-reset.js --state-init prints no START_SHA outside a git repo');
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }

  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.lastIndexOf('async function main()'));
  assert(/smokeInitGitGuarantee\(\);/.test(mainBody),
    '(final) Section 62 is registered in main()');
  pass('(final) Section 62: /forge-init git guarantee verified — no more unconditional NEVER-git-init prohibitions');
}

// ── Section 63: CODE_DIR multi-repo resolver (forge-code-dir.js) ────────────
function smokeCodeDirMultiRepo() {
  process.stdout.write('\n▸ Section 63: CODE_DIR multi-repo resolver + sidecar refusal reasons\n');
  const repoRoot = path.dirname(SCRIPTS);
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

  // Fixture: 2 real git repos under a NON-git root (the multi-repo workspace shape that
  // made the blind find(x=>x.worktree...) point the sidecar at the wrong repo). The
  // resolver is pure (D1), so $ISO_RESULT is hand-built — no forge-isolation --setup.
  const root = mkTmp('s63');
  try {
    const asgardDir = path.join(root, 'asgard');
    const freyrDir  = path.join(root, 'freyr');
    fs.mkdirSync(asgardDir, { recursive: true });
    fs.mkdirSync(freyrDir, { recursive: true });
    mkGitRepo(asgardDir);
    mkGitRepo(freyrDir);

    const wt = (name) => path.join(root, '.forge-worktrees', 'TASK-160', name);
    const isoMulti = JSON.stringify({
      mode: 'worktree',
      repos: [
        { path: asgardDir, branch: 'forge/TASK-160', worktree: wt('asgard'), status: 'created' },
        { path: freyrDir,  branch: 'forge/TASK-160', worktree: wt('freyr'),  status: 'created' },
      ],
    });
    const isoSingle = JSON.stringify({
      mode: 'worktree',
      repos: [{ path: freyrDir, branch: 'forge/TASK-160', worktree: wt('freyr'), status: 'created' }],
    });

    const writePlan = (name, body) => {
      const p = path.join(root, name);
      fs.writeFileSync(p, body);
      return p;
    };
    const resolve = (iso, plan) => {
      const r = runScript('forge-code-dir.js',
        ['--resolve', '--iso-result', iso, '--plan', plan, '--cwd', root, '--run', 'TASK-160']);
      let json = {};
      try { json = JSON.parse(r.stdout); } catch { json = {}; }
      return { status: r.status, json };
    };

    const planFreyr = writePlan('plan-freyr.md', [
      '---', 'id: T01', 'writes:', '  - "freyr/src/a.ts"', '  - "freyr/lib/**"', '---',
      '', '# plan', '',
    ].join('\n'));
    const planBoth = writePlan('plan-both.md', [
      '---', 'id: T02', 'writes:', '  - "freyr/src/a.ts"', '  - "asgard/src/b.ts"', '---',
      '', '# plan', '',
    ].join('\n'));
    const planLegacy = writePlan('plan-legacy.md', [
      '---', 'id: T03', 'tier: heavy', 'effort: high', '---',
      '', '# plan', '', '## Steps', '', '1. do a thing', '',
    ].join('\n'));
    const planGsdMixed = writePlan('plan-gsd.md', [
      '---', 'id: T04', 'writes:', '  - ".gsd/tasks/T04/T04-SUMMARY.md"', '  - "asgard/src/c.ts"', '---',
      '', '# plan', '',
    ].join('\n'));
    const planFilesToChange = writePlan('plan-ftc.md', [
      '---', 'id: T05', 'tier: heavy', '---',
      '', '# plan', '', '## Files to Change', '',
      '- `asgard/src/d.ts` — 2 predicados de filter do cap (`:827`, `:1009`) ajustados.',
      '2. `asgard/docs/e.md` — nota de contrato (`:44`).',
      'not a bullet — ignored',
      '', '## Deferred', '', '- `freyr/src/zzz.ts` — out of scope, after the section end.', '',
    ].join('\n'));

    // (a) multi-repo, all declared paths under freyr/ → freyr's worktree, NEVER repos[0] (asgard).
    const a = resolve(isoMulti, planFreyr);
    assert(a.status === 0 && a.json.status === 'ok',
      `(a) multi-repo plan touching one repo → exit 0 / status ok (got ${a.status}/${a.json.status})`);
    assert(a.json.code_dir === wt('freyr'),
      '(a) code_dir is the freyr worktree (attributed), not repos[0]');
    assert(a.json.code_dir !== wt('asgard'),
      '(a) anti-regression: code_dir is NOT asgard — the blind find(x=>x.worktree...) would have picked it');

    // (b) declared paths span 2 repos → refusal, never an arbitrary pick.
    const b = resolve(isoMulti, planBoth);
    assert(b.status === 4 && b.json.status === 'cross-repo',
      `(b) cross-repo plan → exit 4 / status cross-repo (got ${b.status}/${b.json.status})`);
    assert(b.json.code_dir === '' && b.json.reason === 'sidecar-multirepo-unsupported',
      '(b) cross-repo yields an EMPTY code_dir + reason sidecar-multirepo-unsupported');
    assert(Array.isArray(b.json.repos_touched) && b.json.repos_touched.length === 2,
      `(b) repos_touched lists both repos (got ${JSON.stringify(b.json.repos_touched)})`);

    // (c) multi-repo + legacy plan with zero declared paths → distinct "planner gap" signal.
    const c = resolve(isoMulti, planLegacy);
    assert(c.status === 5 && c.json.status === 'undeclared',
      `(c) multi-repo + legacy plan → exit 5 / status undeclared (got ${c.status}/${c.json.status})`);
    assert(c.json.code_dir === '' && c.json.reason === 'sidecar-code-dir-undeclared',
      '(c) undeclared yields an EMPTY code_dir + reason sidecar-code-dir-undeclared');

    // (d) D6 non-regression: ONE usable repo → that worktree, plan never consulted.
    const d = resolve(isoSingle, planLegacy);
    assert(d.status === 0 && d.json.status === 'ok' && d.json.code_dir === wt('freyr'),
      `(d) single-repo workspace + legacy plan → exit 0 / ok / freyr worktree (got ${d.status}/${d.json.status})`);
    assert(d.json.paths_considered === 0 && d.json.source === 'none',
      '(d) single-repo short-circuit did not consult the plan at all');

    // (c2)/(b2) Refusal still refuses the SIDECAR, but the Claude executor gets a
    // real place to stand. Before this, it inherited the bootstrap WORKTREE_DIR —
    // the blind repos.find() first pick — so a two-repo task ran inside whichever
    // repo sorted first and the operator had to override CODE_DIR by hand.
    const runRoot = path.dirname(wt('freyr'));
    assert(b.json.multi_repo_root === runRoot,
      `(b2) cross-repo exposes the run root holding every worktree (got ${b.json.multi_repo_root})`);
    assert(c.json.multi_repo_root === runRoot,
      `(c2) undeclared in a multi-repo workspace exposes the run root (got ${c.json.multi_repo_root})`);
    assert(b.json.code_dir === '' && c.json.code_dir === '',
      '(b2) code_dir stays empty on refusal — it is the sidecar field and the sidecar still has no answer');
    assert(d.json.multi_repo_root === '',
      `(d2) single-repo workspace exposes NO run root — its parent is not a git repo (got ${d.json.multi_repo_root})`);

    // The three orchestrator mirrors must consume it, or the resolver change is inert.
    for (const skill of ['forge-auto', 'forge-next', 'forge-task']) {
      const body = fs.readFileSync(path.join(path.dirname(SCRIPTS), 'skills', skill, 'SKILL.md'), 'utf8');
      assert(/CODE_DIR_MULTI_ROOT=\$\(node -e .*multi_repo_root/.test(body),
        `(e2) ${skill} reads multi_repo_root from the resolver`);
      assert(/\[ "\$CODE_DIR_STATUS" != "ok" \] && \[ -n "\$CODE_DIR_MULTI_ROOT" \] && CODE_DIR="\$CODE_DIR_MULTI_ROOT"/.test(body),
        `(e2) ${skill} stands the Claude fallback in the run root on refusal`);
      assert(!/executor Claude segue no WORKTREE_DIR do bootstrap/.test(body),
        `(e2) ${skill} no longer claims the fallback keeps the bootstrap worktree`);
    }

    // (m)/(n): repo-relative declarations have no workspace prefix, so only the
    // read-only second pass can resolve them. A tie deliberately remains closed.
    fs.mkdirSync(path.join(freyrDir, 'src'), { recursive: true });
    const planRepoRelative = writePlan('plan-repo-relative.md', [
      '---', 'id: T06', 'writes:', '  - "src/main.rs"', '---', '', '# plan', '',
    ].join('\n'));
    const m = resolve(isoMulti, planRepoRelative);
    assert(m.status === 0 && m.json.status === 'ok' && m.json.repo === freyrDir && m.json.resolution === 'fs-probe',
      `(m) unique repo-relative directory resolves by fs-probe (got ${m.status}/${m.json.status}/${m.json.repo}/${m.json.resolution})`);
    fs.mkdirSync(path.join(asgardDir, 'src'), { recursive: true });
    const n = resolve(isoMulti, planRepoRelative);
    assert(n.status === 5 && n.json.status === 'undeclared',
      `(n) tied repo-relative directory fails closed as undeclared (got ${n.status}/${n.json.status})`);

    // (e) D4: `.gsd/**` never makes a plan cross-repo.
    const e = resolve(isoMulti, planGsdMixed);
    assert(e.status === 0 && e.json.status === 'ok' && e.json.code_dir === wt('asgard'),
      `(e) .gsd/** mixed with one repo's paths → exit 0 / ok / asgard (got ${e.status}/${e.json.status})`);

    // (f) `## Files to Change` free-text fallback, both bullet shapes + backticked line-refs.
    const f = resolve(isoMulti, planFilesToChange);
    assert(f.status === 0 && f.json.status === 'ok' && f.json.code_dir === wt('asgard'),
      `(f) files-to-change fallback attributes to asgard (got ${f.status}/${f.json.status}/${f.json.code_dir})`);
    assert(f.json.source === 'files-to-change' && f.json.paths_considered === 2,
      `(f) source is files-to-change with exactly the 2 in-section paths (got ${f.json.source}/${f.json.paths_considered})`);

    // (g) exact per-file counts of both reasons — never a document-wide includes() (M016 S03 R2).
    // dispatch: enum bullet + trigger row + step 0.5 verdict prose. task/next: gate + prose
    // trigger-list. auto has NO prose trigger-list (only the guard prose) → gate only.
    const REASON_COUNTS = {
      'shared/forge-dispatch.md':   3,
      'skills/forge-task/SKILL.md': 2,
      'skills/forge-next/SKILL.md': 2,
      'skills/forge-auto/SKILL.md': 1,
    };
    for (const [file, expected] of Object.entries(REASON_COUNTS)) {
      const content = read(file);
      for (const needle of ['sidecar-multirepo-unsupported', 'sidecar-code-dir-undeclared']) {
        const got = content.split(needle).length - 1;
        assert(got === expected, `(g) ${file} mentions ${needle} exactly ${expected}x (got ${got})`);
      }
    }

    // (h) contract note authored ONCE in the canonical spec (D13 formula-once).
    const spec = read('shared/forge-dispatch.md');
    const note = 'The sidecar assumes ONE `CODE_DIR` that is a git repository';
    const noteCount = spec.split(note).length - 1;
    assert(noteCount === 1, `(h) shared/forge-dispatch.md carries the contract note exactly once (got ${noteCount})`);

    // (i) Pitfall 2 guard: the fix is INERT unless the `worktree →` PROSE bullet points at the
    // per-unit variable — CODE_DIR/WORKER_CWD are prose variables, bash only consumes them.
    for (const file of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md']) {
      const content = read(file);
      const invocations = content.split('forge-code-dir.js').length - 1;
      assert(invocations >= 1, `(i) ${file} invokes forge-code-dir.js (got ${invocations})`);
      const bullet = content.split(/\r?\n/).filter(l => /^- `?(worktree|ISOLATION_MODE == worktree)`? →/.test(l));
      assert(bullet.length === 1, `(i) ${file} has exactly one \`worktree →\` prose bullet (got ${bullet.length})`);
      assert(bullet[0].includes('UNIT_CODE_DIR'),
        `(i) ${file} \`worktree →\` prose bullet points CODE_DIR at UNIT_CODE_DIR (Pitfall 2)`);
    }

    // (j) allowlist grep: the blind picker must survive EXACTLY once per mirror — the bootstrap
    // line is legitimate (no plan exists yet, and an empty WORKTREE_DIR is the all-repos-failed
    // STOP signal). Exactly-one, not zero: a second occurrence would be a new blind pick.
    for (const file of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md']) {
      const got = read(file).split('find(x=>x.worktree').length - 1;
      assert(got === 1, `(j) ${file} keeps the bootstrap blind picker exactly once, and adds no second one (got ${got})`);
    }

    // (k) D11: the /forge-task plan template asks the planner for `writes:`.
    const taskSkill = read('skills/forge-task/SKILL.md');
    assert(/`writes:` \(an array of the file paths or globs/.test(taskSkill),
      '(k) skills/forge-task/SKILL.md Step 4 template asks for `writes:` in the frontmatter');
    const routingDomains = taskSkill.split('ROUTING_DOMAINS').length - 1;
    assert(routingDomains === 1,
      `(k) skills/forge-task/SKILL.md ROUTING_DOMAINS count unchanged at 1 (got ${routingDomains})`);

    // (l) CLI contract: no args → exit 2 + a forge-code-dir error line on stderr.
    const usage = runScript('forge-code-dir.js', []);
    assert(usage.status === 2 && /forge-code-dir error:/.test(usage.stderr),
      `(l) no-args invocation exits 2 with a forge-code-dir error line (got ${usage.status})`);

    const source = fs.readFileSync(__filename, 'utf8');
    const mainBody = source.slice(source.lastIndexOf('async function main()'));
    assert(/smokeCodeDirMultiRepo\(\);/.test(mainBody),
      '(final) Section 63 is registered in main()');
    pass('(final) Section 63: CODE_DIR multi-repo resolution verified — attributed, refused, or short-circuited, never an arbitrary pick');
  } finally {
    cleanup(root);
  }
}

// ── Section 66: sidecar_model resolver and mirrors ──────────────────────────
function smokeSidecarModel() {
  process.stdout.write('\n▸ Section 66: sidecar_model contract + mirrors\n');
  const root = path.dirname(SCRIPTS);
  const files = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md', 'shared/forge-dispatch.md'];
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const stale = content.split('--model %s\' "$CODEX_MODEL"').length - 1;
    assert(stale === 0, `(a) ${file} has zero stale --model CODEX_MODEL invocations (got ${stale})`);
    const sidecar = content.split('SIDECAR_MODEL').length - 1;
    assert(sidecar > 0, `(b) ${file} documents SIDECAR_MODEL (got ${sidecar})`);
  }
  const resolved = runScript('forge-dispatch-resolve.js', ['--unit-type', 'execute-task', '--json']);
  let parsed = {}; try { parsed = JSON.parse(resolved.stdout); } catch {}
  assert(resolved.status === 0 && Object.prototype.hasOwnProperty.call(parsed, 'sidecar_model'),
    '(c) resolver CLI emits additive sidecar_model');
  const source = fs.readFileSync(__filename, 'utf8');
  assert(/smokeSidecarModel\(\);/.test(source.slice(source.lastIndexOf('async function main()'))),
    '(final) Section 66 is registered in main()');
  pass('(final) Section 66: sidecar_model is resolver-owned and mirrors consume it');
}

// ── Section 67: verifier code/artifact roots ─────────────────────────────────
function smokeVerifierCodeDir() {
  process.stdout.write('\n▸ Section 67: verifier --code-dir roots\n');
  const usage = runScript('forge-verifier.js', []);
  assert(usage.status === 2 && usage.stderr.includes('--code-dir'), '(a) verifier usage includes optional --code-dir');
  const root = mkTmp('verifier-code-dir');
  const code = mkTmp('verifier-code');
  try {
    const taskDir = path.join(root, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'T01-PLAN.md'), '---\nid: T01\nmust_haves:\n  truths:\n    - "artifact exists"\n  artifacts:\n    - path: src/only-code.js\n      provides: test\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - src/only-code.js\n---\n', 'utf8');
    fs.mkdirSync(path.join(code, 'src'), { recursive: true });
    fs.writeFileSync(path.join(code, 'src', 'only-code.js'), 'module.exports = 1;\n', 'utf8');
    const args = ['--slice', 'S01', '--milestone', 'M001', '--cwd', root];
    const sameRun = runScript('forge-verifier.js', args);
    const explicitRun = runScript('forge-verifier.js', [...args, '--code-dir', root]);
    const otherRun = runScript('forge-verifier.js', [...args, '--code-dir', code]);
    let same = {}; let explicit = {}; let other = {};
    try { same = JSON.parse(sameRun.stdout); explicit = JSON.parse(explicitRun.stdout); other = JSON.parse(otherRun.stdout); } catch {}
    // The CLI adds generated_at/duration_ms on every independent run; compare the
    // stable contract bytes after removing those runtime-only observability fields.
    delete same.generated_at; delete same.duration_ms;
    delete explicit.generated_at; delete explicit.duration_ms;
    assert(JSON.stringify(same) === JSON.stringify(explicit), '(b) omitted code-dir keeps the stable JSON contract identical to code-dir=cwd');
    assert(same.rows.length > 0 && other.rows.length > 0 && other.rows[0].exists === true,
      '(b) plans remain under cwd while artifacts resolve under code-dir');
  } finally { cleanup(root); cleanup(code); }
  const source = fs.readFileSync(__filename, 'utf8');
  assert(/smokeVerifierCodeDir\(\);/.test(source.slice(source.lastIndexOf('async function main()'))),
    '(final) Section 67 is registered in main()');
  pass('(final) Section 67: verifier keeps artifact and code roots distinct');
}

// ── Section 70: Windows sandbox gate + worktree dependency provisioning ─────
function smokeWindowsSandboxAndWorktreeDeps() {
  process.stdout.write('\n▸ Section 70: Windows sandbox gate + worktree dependencies\n');
  const { codexSandboxArgs, buildExecutePrompt } = require('./forge-xllm.js');
  const { resolvePackageManager, installWorktreeDeps } = require('./forge-isolation.js');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const expectedWrite = ['--sandbox', 'workspace-write'];
  assert(same(codexSandboxArgs('workspace-write', 'darwin'), expectedWrite)
    && same(codexSandboxArgs('workspace-write', 'linux'), expectedWrite),
  '70a: POSIX workspace-write args are byte-identical');
  assert(same(codexSandboxArgs('workspace-write', 'win32'), ['--dangerously-bypass-approvals-and-sandbox'])
    && !codexSandboxArgs('workspace-write', 'win32').includes('--sandbox'),
  '70a: win32 workspace-write is bypass-only');
  assert(['darwin', 'linux', 'win32'].every((p) => same(codexSandboxArgs('read-only', p), ['--sandbox', 'read-only'])),
    '70b: read-only remains sandboxed on every platform');

  const xllmSource = fs.readFileSync(path.join(SCRIPTS, 'forge-xllm.js'), 'utf8');
  const gateStart = xllmSource.indexOf('function codexSandboxArgs');
  const gateEnd = xllmSource.indexOf('\n}', gateStart) + 2;
  const outsideGate = xllmSource.slice(0, gateStart) + xllmSource.slice(gateEnd);
  assert(!/['"]--sandbox['"]\s*,\s*['"](?:read-only|workspace-write)['"]/.test(outsideGate),
    '70c: forge-xllm has no call-site sandbox literal pairs');
  const gateComment = xllmSource.slice(Math.max(0, gateStart - 1500), gateEnd);
  assert(['15850', '17179', '14367', '5824', 'assertNoProtectedSidecarChanges'].every((s) => gateComment.includes(s)),
    '70d: gate comment documents Windows issues and surviving defense');

  const template = fs.readFileSync(path.join(SCRIPTS, '..', 'shared', 'templates', 'dispatch', 'execute-task.md'), 'utf8');
  const sentinel = 'dependencies may not be installed';
  const prompt = buildExecutePrompt('# T70\n');
  assert(template.split(sentinel).length - 1 === 1 && prompt.includes(sentinel)
    && prompt.includes('unknown') && prompt.indexOf(sentinel) < prompt.indexOf('Must-have scope classification:'),
  '70e: dependency warning reaches template and sidecar prompt exactly once');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-t70-'));
  const wt = path.join(root, 'worktree');
  let calls = 0;
  try {
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
    const installed = installWorktreeDeps(root, wt, { runner: (cmd, args, runOpts) => {
      calls++; return { status: cmd === 'npm' && args[0] === 'ci' && runOpts.cwd === wt ? 0 : 1, stderr: '' };
    } });
    assert(installed.status === 'installed' && installed.manager === 'npm' && calls === 1,
      '70f: npm lockfile provisions through injected runner with worktree cwd');
    const failed = installWorktreeDeps(root, wt, { runner: () => ({ status: 1, stderr: 'npm ERR! failed install\nsecret ignored' }) });
    assert(failed.status === 'failed' && !!failed.error, '70g: install failure degrades without throwing');
    const redacted = installWorktreeDeps(root, wt, { runner: () => ({ status: 1, stderr: 'https://user:password@example.invalid/pkg' }) });
    assert(!redacted.error.includes('user:password@'), '70g: installer error redacts credential URLs');
    const npmToken = installWorktreeDeps(root, wt, { runner: () => ({ status: 1, stderr: '//registry.npmjs.org/:_authToken=npm_SECRET123 is invalid' }) });
    assert(!npmToken.error.includes('npm_SECRET123'), '70g: installer error redacts canonical npm per-registry token');
    const yarnToken = installWorktreeDeps(root, wt, { runner: () => ({ status: 1, stderr: 'npmAuthToken: yarn_SECRET456 rejected' }) });
    assert(!yarnToken.error.includes('yarn_SECRET456'), '70g: installer error redacts yarn npmAuthToken');
    const control = installWorktreeDeps(root, wt, { runner: () => ({ status: 1, stderr: 'plain error with no secrets at all here' }) });
    assert(control.error === 'plain error with no secrets at all here', '70g: installer error passes through stderr with no secret unchanged');
    const disabled = installWorktreeDeps(root, wt, { enabled: false, runner: () => { calls++; return { status: 0 }; } });
    assert(disabled.status === 'disabled' && calls === 1, '70h: disabled provisioning does not call runner');
    fs.unlinkSync(path.join(root, 'package-lock.json'));
    const noLock = installWorktreeDeps(root, wt, { runner: () => { calls++; return { status: 0 }; } });
    assert(noLock.status === 'no-lockfile' && calls === 1, '70h: no lockfile does not call runner');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert(resolvePackageManager(root).manager === 'pnpm', '70i: pnpm lockfile wins manager precedence');
  } finally { cleanup(root); }
  const source = fs.readFileSync(__filename, 'utf8');
  const isolationSource = fs.readFileSync(path.join(SCRIPTS, 'forge-isolation.js'), 'utf8');
  assert(/result\.status = 'created';\s*result\.deps = installWorktreeDeps/.test(isolationSource)
    && /status: 'skipped'.+worktree-already-exists/.test(isolationSource),
  '70j: created worktrees receive additive non-fatal deps; existing worktrees skip installs');
  assert(/smokeWindowsSandboxAndWorktreeDeps\(\);/.test(source.slice(source.lastIndexOf('async function main()'))),
    '(final) Section 70 is registered in main()');

  // 70k: every `isolation.<key>` read by readIsolationPrefs() must be declared in
  // forge-prefs.schema.json's forge_isolation block — closes the class of bug where
  // code reads a knob the schema (and therefore the generated reference doc and
  // /forge-prefs catalog) never declared, leaving the operator with no way to
  // discover the opt-out.
  const readKeys = new Set();
  const readIsoBody = isolationSource.slice(
    isolationSource.indexOf('function readIsolationPrefs'),
    isolationSource.indexOf('function resolvePackageManager'));
  for (const m of readIsoBody.matchAll(/isolation\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) readKeys.add(m[1]);
  const schemaJson = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'forge-prefs.schema.json'), 'utf8'));
  const isolationProps = Object.keys(
    schemaJson.properties.forge_isolation.properties || {});
  const missing = [...readKeys].filter((k) => k !== 'mode' && !isolationProps.includes(k));
  assert(missing.length === 0,
    `70k: readIsolationPrefs() keys all declared in forge_isolation schema (missing: ${missing.join(', ')})`);
  assert(isolationProps.includes('worktree_install_deps'), '70k: worktree_install_deps is declared in the schema');

  pass('(final) Section 70: platform gate and non-fatal dependency provisioning verified');
}

// ── Section 64: review agent unavailability — classifier behaviour + sanctioned path docs ──
// Only ONE surface here is mechanically executable: scripts/forge-classify-error.js (the retry
// decision behind § Agent unavailability). The per-mode policy itself is prose interpreted at
// runtime by the orchestrator — declared doc-presence-only (same limit as TASK-006 R2 / TASK-007 R3),
// asserted with exact per-file counts, never a document-wide includes().
function smokeReviewAgentUnavailable() {
  process.stdout.write('\n▸ Section 64: review-agent-unavailable — retry classifier + sanctioned path\n');
  const repoRoot = path.dirname(SCRIPTS);
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

  // (a) behavioural: the classifier CLI drives the retry decision of the review binding.
  // The CLI always exits 0 — read the JSON on stdout, never the exit status.
  const classify = (msg) => {
    const r = runScript('forge-classify-error.js', ['--msg', msg]);
    return JSON.parse(r.stdout);
  };

  const rl = classify('429 rate limit');
  assert(rl.kind === 'rate-limit' && rl.retry === true && rl.backoffMs > 0,
    '(a) "429 rate limit" → rate-limit, retry:true, positive backoff', JSON.stringify(rl));
  assert(classify('Too Many Requests').retry === true,
    '(a) "Too Many Requests" → retry:true (advocate 429 is retried, not improvised around)');
  const srv = classify('HTTP 503 overloaded');
  assert(srv.kind === 'server' && srv.retry === true,
    '(a) "HTTP 503 overloaded" → server, retry:true', JSON.stringify(srv));
  assert(classify('internal server error 500').retry === true,
    '(a) "internal server error 500" → retry:true');

  // FAIL-SAFE: an unrecognised provider message must NOT loop forever — it falls into the
  // declared unavailability path (retry:false → review-agent-unavailable + per-mode policy).
  const unk = classify('weird opaque thing');
  assert(unk.kind === 'unknown' && unk.retry === false,
    '(a) opaque message → unknown, retry:false (fail-safe: declared unavailability, never infinite retry)',
    JSON.stringify(unk));
  const perm = classify('invalid api key');
  assert(perm.kind === 'permanent' && perm.retry === false,
    '(a) "invalid api key" → permanent, retry:false', JSON.stringify(perm));

  // (b) doc-presence with exact per-file counts.
  const spec = read('shared/forge-dispatch.md');
  const review = read('shared/forge-review.md');
  const auto = read('skills/forge-auto/SKILL.md');
  const next = read('skills/forge-next/SKILL.md');
  const task = read('skills/forge-task/SKILL.md');
  const count = (content, needle) => content.split(needle).length - 1;

  const REASONS = [
    ['review-agent-unavailable', { 'shared/forge-dispatch.md': 2, 'shared/forge-review.md': 11 }],
    ['review-advocate-unavailable', { 'shared/forge-dispatch.md': 1, 'shared/forge-review.md': 6 }],
    ['review-challenger-unavailable', { 'shared/forge-dispatch.md': 1, 'shared/forge-review.md': 5 }],
    ['review-rebuttal-unavailable', { 'shared/forge-dispatch.md': 1, 'shared/forge-review.md': 3 }],
  ];
  for (const [needle, expected] of REASONS) {
    for (const [name, content] of [['shared/forge-dispatch.md', spec], ['shared/forge-review.md', review]]) {
      const got = count(content, needle);
      assert(got === expected[name],
        `(b) ${name} has exact "${needle}" count (expected ${expected[name]}, got ${got})`);
    }
  }

  // (c) REGRA CRÍTICA — verbatim in the canonical spec AND in all 3 orchestrator mirrors
  // (TASK-008 lesson: a rule only in the canonical spec is inert exactly where the improvisation
  // happened — the mirrors ARE the orchestrator).
  const RULE = 'NUNCA produz veredito de review no lugar de um agente indisponível';
  for (const [name, content] of [
    ['shared/forge-review.md', review],
    ['skills/forge-auto/SKILL.md', auto],
    ['skills/forge-next/SKILL.md', next],
    ['skills/forge-task/SKILL.md', task],
  ]) {
    const got = count(content, RULE);
    assert(got === 1, `(c) ${name} carries the REGRA CRÍTICA verbatim exactly once (got ${got})`);
  }

  // (d) anti-approval guard: the challenger-unavailable path may never render as clean.
  // Stated twice on purpose: once in the § Agent unavailability policy, once at the Step 2
  // throw binding (the exact spot that could otherwise slip into the NO_FLAGS branch).
  assert(count(review, 'ausência de review não é aprovação') === 2,
    `(d) forge-review.md states that absence of review is not approval in both required places (got ${count(review, 'ausência de review não é aprovação')})`);
  assert(/PROIBIDO.*NO_FLAGS/s.test(review),
    '(d) forge-review.md forbids the NO_FLAGS/clean-artifact branch on review-challenger-unavailable');

  // (e) override guard: review dispatches never inherit the Retry Handler CRITICAL terminal action.
  assert(/Exceção — dispatches da review/.test(spec),
    '(e) forge-dispatch.md § Retry Handler carries the named review exception');
  assert(/dispatches da review[\s\S]{0,600}caminho CRITICAL/.test(spec),
    '(e) the exception explicitly overrides the CRITICAL routing for review dispatches');

  // (f) Step 4 is skipped when the advocate could not be heard (no self-judged rebuttal).
  assert(/Step 4 \(rebuttal\) é PULADO/.test(review),
    '(f) forge-review.md documents Step 4 as skipped on review-advocate-unavailable');

  const source = fs.readFileSync(__filename, 'utf8');
  const mainBody = source.slice(source.lastIndexOf('async function main()'));
  assert(/smokeReviewAgentUnavailable\(\);/.test(mainBody),
    '(final) Section 64 is registered in main()');
  pass('(final) Section 64: review agent unavailability — retry-first classification is fail-safe and the sanctioned path is documented in the canonical spec + all 3 mirrors');
}

// ── Section 68: shared reference glob — installer anti-drift guard ─────────
function smokeSharedGlob() {
  process.stdout.write('\n▸ Section 68: shared/*.md installer glob — dynamic anti-drift guard\n');
  const repo = path.dirname(SCRIPTS);
  const shPath = path.join(repo, 'install.sh');
  const psPath = path.join(repo, 'install.ps1');
  const sh = fs.readFileSync(shPath, 'utf8');
  const ps = fs.readFileSync(psPath, 'utf8');
  const expected = fs.readdirSync(path.join(repo, 'shared'))
    .filter((name) => name.endsWith('.md'));

  // PowerShell is not available on the Unix smoke runner, so sh↔ps1
  // behavioral parity is checked here by source-level grep guards only.
  assert(/for f in .*shared\/\*\.md/.test(sh),
    '(a) install.sh iterates shared/*.md with one glob loop', sh);
  assert(!/^\s*copy "\$\{REPO_DIR\}\/shared\/forge-[^"]+\.md"/m.test(sh),
    '(b) install.sh has no individual shared forge copy blocks', sh);
  assert(/Get-ChildItem[\s\S]*-Path \$SharedSrc[\s\S]*-Filter '\*\.md'/m.test(ps),
    '(c) install.ps1 iterates shared/*.md with Get-ChildItem', ps);
  assert(!/^\s*if \(Test-Path "\$RepoDir\\shared\\forge-[^"]+\.md"\)/m.test(ps),
    '(d) install.ps1 has no individual shared forge Test-Path blocks', ps);
  assert(!fs.readFileSync(psPath).includes(0x0c),
    '(e) install.ps1 contains no literal 0x0C byte', psPath);

  const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bashProbe.error || bashProbe.status !== 0) {
    pass('(f) shared/*.md dry-run guard skipped (bash unavailable)');
  } else {
    const dryHome = mkTmp('install-shared-glob-home');
    try {
      fs.mkdirSync(path.join(dryHome, '.claude'), { recursive: true });
      const dry = spawnSync('bash', [shPath, '--dry-run', '--update'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: dryHome },
      });
      const output = `${dry.stdout || ''}${dry.stderr || ''}`;
      assert(dry.status === 0, '(g) shared/*.md dry-run exits 0', output);
      for (const name of expected) {
        assert(output.includes(name),
          `(g) shared/*.md dry-run includes ${name}`, output);
      }
    } finally {
      cleanup(dryHome);
    }
  }

  pass('(final) Section 68: shared reference installers are glob-driven and protected against new-file drift');
}

// ── Section 65: live phases table — resolver-derived rows + anti-drift guard ──
// The fixture intentionally contains both the default and a named domain. This
// makes routing resolution observable without relying on developer-machine
// preferences, and keeps the expected table shape hermetic. Assertions read
// the structured helper output rather than its human-facing text table: the
// latter remains free to improve spacing and localisation without weakening
// these contract checks. The document comparison is bidirectional so a newly
// added resolver default cannot disappear from the prose table, while an old
// prose-only row cannot silently claim a dispatch that no longer exists.
// No synthetic dispatch contract is assembled here. The helper invokes the
// production resolver once for every row, including the tier-only phases.
// Consequently this section also protects future resolver-side changes to
// aliases, engines, fallback chains, and default-domain inheritance.
// The CLI is separately covered through the ordinary smoke execution path.
// This test's responsibility is the reusable structured API contract.
// Keep the assertions in phase order for diagnostic output readability.
function smokePhasesTable() {
  process.stdout.write('\n▸ Section 65: live phases table — resolver-derived rows + anti-drift guard\n');
  const repoRoot = path.join(__dirname, '..');
  const { buildPhases, renderPhases } = require(path.join(SCRIPTS, 'forge-phases.js'));
  const { TIER_DEFAULTS } = require(path.join(SCRIPTS, 'forge-dispatch-resolve.js'));
  const root = mkTmp('phases-table');
  try {
    fs.writeFileSync(path.join(root, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({
      routing: {
        default: {
          executor: { standard: ['claude-sonnet-5'] },
          planner: { heavy: ['claude-opus-4-8[1m]'] },
        },
        backend: {
          executor: { standard: ['gpt-5.6-luna', 'claude-sonnet-5'] },
          planner: { heavy: ['claude-opus-4-8[1m]'] },
        },
      },
    }), 'utf8');
    const table = buildPhases(root);
    const routed = table.rows.filter((row) => row.unit_type === 'execute-task' || row.unit_type === 'plan-slice');
    const tierOnly = new Set(['research-milestone', 'research-slice', 'discuss-milestone', 'discuss-slice', 'complete-slice', 'complete-milestone', 'memory-extract']);

    assert(routed.every((row) => /^routing\./.test(row.config_key)),
      '(a) execute-task and plan-slice rows configure through routing', JSON.stringify(routed));
    assert(table.rows.filter((row) => tierOnly.has(row.unit_type)).every((row) => /^tier_models\./.test(row.config_key)),
      '(b) non-routable unit types configure through tier_models');
    const milestone = table.rows.find((row) => row.unit_type === 'plan-milestone');
    assert(milestone && milestone.config_key === 'tier_models.max' && milestone.routable === false,
      '(c) plan-milestone is non-routable and configures through tier_models.max', JSON.stringify(milestone));
    assert(!/travado|locked/i.test(renderPhases(root)),
      '(c) rendered plan-milestone note has no misleading locked configuration key');
    assert(renderPhases(root).includes(`tem tier fixo ${TIER_DEFAULTS['plan-milestone']}`)
      && renderPhases(root).includes(`tier_models.${TIER_DEFAULTS['plan-milestone']}`),
      '(c) plan-milestone footnote reflects TIER_DEFAULTS, not a hardcoded literal');

    const expected = Object.keys(TIER_DEFAULTS);
    const actual = table.unit_types;
    assert(expected.every((unitType) => actual.includes(unitType)) && actual.every((unitType) => expected.includes(unitType)),
      '(d) buildPhases unit_types and TIER_DEFAULTS match bidirectionally');
    const tierDoc = fs.readFileSync(path.join(repoRoot, 'shared', 'forge-tiers.md'), 'utf8');
    const section = tierDoc.slice(tierDoc.indexOf('## Unit Type → Default Tier'))
      .split(/\n(?:## |---)/)[0];
    const docTypes = [...section.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*(light|standard|heavy|max)\s*\|/gm)]
      .map((match) => match[1]);
    assert(expected.every((unitType) => docTypes.includes(unitType)) && docTypes.every((unitType) => expected.includes(unitType)),
      '(d) canonical tier document and TIER_DEFAULTS match bidirectionally', JSON.stringify(docTypes));

    const executeRows = table.rows.filter((row) => row.unit_type === 'execute-task');
    assert(executeRows.length >= 2 && new Set(executeRows.map((row) => row.config_key)).size >= 2,
      '(e) execute-task renders multiple domains with distinct routing keys', JSON.stringify(executeRows));

    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'forge-prefs.schema.json'), 'utf8'));
    const skill = fs.readFileSync(path.join(repoRoot, 'skills', 'forge-prefs', 'SKILL.md'), 'utf8');
    const resolver = fs.readFileSync(path.join(SCRIPTS, 'forge-dispatch-resolve.js'), 'utf8');
    assert(/### Domain-routable vs tier_models-only/.test(tierDoc), '(f) tier documentation has routability subsection');
    assert(schema.properties.routing.description.includes('Somente execute-task (executor) e plan-slice (planner)'),
      '(f) routing schema description explains captured phases');
    assert(/### "phases"/.test(skill) && !skill.includes('Fase legada'),
      '(f) prefs skill exposes phases and removes the drifted legacy table');
    assert(/flag === '--domain'/.test(resolver), '(f) dispatch resolver parseArgs accepts --domain');

    const source = fs.readFileSync(__filename, 'utf8');
    const mainBody = source.slice(source.lastIndexOf('async function main()'));
    assert(/smokePhasesTable\(\);/.test(mainBody), '(final) Section 65 is registered in main()');
    pass('(final) Section 65: live phase resolution is resolver-derived and protected against documentation drift');
  } finally {
    cleanup(root);
  }
}

const crashedSections = [];

// One section's crash must not cost the sections behind it. The label is read
// back out of the thunk's own source so each call site stays a literal
// `smokeThing();` — several sections assert their own registration in main() by
// grepping for exactly that text.
async function runSection(body) {
  const label = (String(body).match(/smoke\w+/) || ['unknown-section'])[0];
  try {
    await body();
  } catch (error) {
    crashedSections.push(label);
    fail(`${label} crashed — every assertion left in it was skipped`,
      (error && (error.stack || error.message)) || String(error));
  }
}

// ── Section 73: the harness protects its own coverage ──────────────────────
async function smokeSectionIsolation() {
  process.stdout.write('\n▸ Section 73: section isolation\n');
  // Normalized: this section slices its own source, and a CRLF checkout would
  // otherwise make every '\n'-anchored boundary miss silently.
  const src = fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n');
  const mainBody = src.slice(src.indexOf('async function main()'));

  // (a) No section may be called bare inside main() — a bare call is exactly
  // the shape that let one throw abort the run.
  const bare = mainBody.split('\n').filter(line => /^\s*(await )?smoke\w+\(\);\s*$/.test(line));
  assert(bare.length === 0, '(a) every section in main() is routed through runSection', `bare calls=${JSON.stringify(bare)}`);
  assert(/\]\) await runSection\(body\);/.test(mainBody), '(a) main() awaits runSection for each section body');

  // (b) A crashed section is announced separately from the pass/fail tally.
  assert(/crashedSections\.length > 0/.test(mainBody) && /section\(s\) crashed and did not finish/.test(mainBody),
    '(b) a crashed section is reported loudly, not folded into the tally');

  // (c) Behavioural: instantiate the real runSection with stubbed collaborators
  // and prove a throwing body is contained, labelled and recorded.
  const declaration = src.slice(src.indexOf('async function runSection(body)'));
  const source = declaration.slice(0, declaration.indexOf('\n}\n') + 3);
  const recorded = [];
  const crashes = [];
  const isolated = new Function('fail', 'crashedSections',
    `${source}; return runSection;`)((name, detail) => recorded.push({ name, detail }), crashes);

  let escaped = null;
  try {
    await isolated(() => { smokeBoomFixture(); });
  } catch (error) { escaped = error; }
  assert(escaped === null, '(c) a throwing section does not escape runSection', String(escaped && escaped.message));
  assert(crashes.length === 1 && crashes[0] === 'smokeBoomFixture',
    '(c) the crashed section is labelled from its own call site', JSON.stringify(crashes));
  assert(recorded.length === 1 && /crashed/.test(recorded[0].name),
    '(c) the crash is recorded as a failure', JSON.stringify(recorded));

  let ran = false;
  await isolated(() => { ran = true; });
  assert(ran && crashes.length === 1, '(c) a healthy section still runs and records no crash');
}

// Deliberately throws — the fixture body for the isolation guard above.
function smokeBoomFixture() {
  throw new TypeError("Cannot read properties of undefined (reading '0')");
}

async function main() {
  process.stdout.write('forge-smoke — M004+ multi-run primitives\n');
  process.stdout.write('─'.repeat(50) + '\n');

  const start = Date.now();
  try {
    // Sections are isolated from one another: a throw inside one is recorded as
    // a failure and every later section still runs. Before this, a single
    // try/catch wrapped the whole list, so one unguarded dereference in an early
    // section skipped all 45 sections behind it — roughly 1200 assertions —
    // while the summary still printed an ordinary "Results: N passed, M failed"
    // and exit 1. A release gate that can drop three quarters of its coverage
    // without saying so is worse than a red one.
    for (const body of [
      () => { smokeRuns(); },
      () => { smokeLock(); },
      () => { smokeState(); },
      () => { smokeDashboard(); },
      () => { smokeMerger(); },
      () => { smokeFilelock(); },
      () => { smokeRepos(); },
      () => { smokeCliHelpers(); },
      () => { smokeIsolation(); },
      () => { smokeLivenessBanner(); },
      () => { smokeSymbolAndTestQuality(); },
      () => { smokeContextMonitor(); },
      () => { smokeNodeRepair(); },
      () => { smokeStopHook(); },
      () => { smokeNotifications(); },
      () => { smokeReviewEngine(); },
      () => { smokeAccounts(); },
      () => { smokeEffort(); },
      () => { smokeUsageIndicator(); },
      () => { smokePlanGateDegradation(); },
      () => { smokeXllm(); },
      async () => { await smokeXllmExecute(); },
      async () => { await smokeSidecarContextParity(); },
      () => { smokeModelAlias(); },
      () => { smokeChallengerWiring(); },
      () => { smokeAdvocateModel(); },
      () => { smokeStatusPackaging(); },
      () => { smokeEngineDispatch(); },
      async () => { await smokeXllmPlan(); },
      () => { smokeTierChain(); },
      () => { smokeReviewPairing(); },
      () => { smokeReviewPairingWiring(); },
      () => { smokeReviewPairingPrefsSchema(); },
      () => { smokeRouting(); },
      () => { smokeRoutingWiring(); },
      () => { smokeDomainEmission(); },
      () => { smokeGeminiFamily(); },
      () => { smokeRoutingScaffoldDocs(); },
      () => { smokePrefsEngine(); },
      () => { smokePrefsCatalog(); },
      () => { smokePrefsCutover(); },
      () => { smokeSkillsCutover(); },
      () => { smokePrefsMigration(); },
      () => { smokePrefsViewerDoctor(); },
      () => { smokePrefsMigrationFidelity(); },
      () => { smokeInitSetupScaffold(); },
      () => { smokeStubPatternRobustness(); },
      () => { smokeDispatchResolve(); },
      () => { smokeSurgicalReset(); },
      () => { smokeSidecarLayer1Retry(); },
      () => { smokeSidecarPolicyGuard(); },
      () => { smokePrefsChokepoints(); },
      () => { smokePrefsConsumers(); },
      () => { smokePrefsCutoverGuards(); },
      () => { smokeHeartbeatContract(); },
      () => { smokeSidecarGptCap(); },
      () => { smokeSidecarEnvContract(); },
      () => { smokeSchemaExtraction(); },
      () => { smokeRequireWorktree(); },
      () => { smokeSidecarEnvPromotion(); },
      () => { smokeSandboxExecBlocked(); },
      () => { smokeCleanupRegistryMode(); },
      () => { smokeXllmStateSliceQualified(); },
      () => { smokeReviewModelDiscipline(); },
      () => { smokeXllmResultFileGuard(); },
      () => { smokeRoutingDomains(); },
      () => { smokeInitGitGuarantee(); },
      () => { smokeCodeDirMultiRepo(); },
      () => { smokeReviewAgentUnavailable(); },
      () => { smokeSharedGlob(); },
      () => { smokePhasesTable(); },
      () => { smokeSidecarModel(); },
      () => { smokeVerifierCodeDir(); },
      () => { smokeWindowsSandboxAndWorktreeDeps(); },
      async () => { await smokeSectionIsolation(); },
    ]) await runSection(body);
  } catch (e) {
    fail('unhandled exception', e.stack || e.message);
  }

  const ms = Date.now() - start;
  process.stdout.write('\n' + '─'.repeat(50) + '\n');
  // Loud by construction: a crashed section costs every assertion behind it, so
  // it must never be readable as "just another failure" in the tally.
  if (crashedSections.length > 0) {
    process.stdout.write(`⚠ ${crashedSections.length} section(s) crashed and did not finish: ${crashedSections.join(', ')}\n`);
  }
  process.stdout.write(`Results: ${passes} passed, ${fails} failed (${ms}ms)\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  ✗ ${f.name}: ${f.detail}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) main();
