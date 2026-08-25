#!/usr/bin/env node
'use strict';

// forge-touch.test.js — the census that never goes mute.
//
// Three properties carry this suite, mirroring forge-run-address.test.js's
// own structure (the direct precedent T01 composes on top of):
//
//   R1  committed + uncommitted derive correctly from REAL git repos, deduped.
//   R2  `readTouched(null)` (never recorded) and `readTouched(recorded, no
//       touches)` are DIFFERENT values — asserted explicitly, not by comment.
//   R3  a repo that cannot be examined (no path, or not a git repo) still
//       APPEARS in `repos[]` with a named reason — it is never dropped.
//
// R7 proves R1 actually bites: the dedup `Set` is mutated away on a source
// copy, the resulting duplicate is observed RED, and the file is restored
// byte-identical. A test never seen failing is not coverage (TASK-021).
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. R5 asserts, via
// mtime of the operator's REAL registry, that this suite never wrote to it.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-touch.js');
const touch = require('./forge-touch.js');
const { collectTouched, recordTouched, readTouched, deriveRepoEntry, TOUCH_REASONS } = touch;
const runs = require('./forge-runs.js');
const hasSvnToolchain = ['svn', 'svnadmin'].every((command) => spawnSync(command, ['--version', '--quiet'], { encoding: 'utf8' }).status === 0);

// ── Runner ──────────────────────────────────────────────────────────────────
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-touch-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function svn(cwd, args) {
  return execFileSync('svn', args, { cwd, encoding: 'utf8' });
}

// ── R5 (see the closing half) ───────────────────────────────────────────────
const REAL_HOME = os.userInfo().homedir;
const LIVE_REGISTRY = path.join(REAL_HOME, '.claude', 'forge-gate-workspaces.json');

// ── Reasons seen across the whole suite — cross-checked against
//    TOUCH_REASONS at the very end (Step 6 of T01-PLAN's steps).
const reasonsSeen = new Set();
function noteReason(r) {
  if (r) reasonsSeen.add(r);
}

// ── git fixture builders ────────────────────────────────────────────────────

/** A clean git repo on branch `main` with one initial commit. Nothing else. */
function makeCleanRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/**
 * A repo where HEAD is a feature branch AHEAD of `main`, plus one uncommitted
 * change — the shape that exercises BOTH halves of `touchedFilesFor` (and,
 * with `shared.txt` present in both halves, the dedup R7 mutates away).
 */
function makeDivergedRepo(dir) {
  makeCleanRepo(dir);
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'v1\n', 'utf8');
  git(dir, ['add', 'shared.txt']);
  git(dir, ['commit', '-q', '-m', 'shared v1']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'x\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'shared.txt'), 'v2\n');
  git(dir, ['add', 'committed.txt', 'shared.txt']);
  git(dir, ['commit', '-q', '-m', 'feature work']);
  // Uncommitted, on top of the feature commit: touches shared.txt AGAIN (so
  // it appears in both the committed diff and `git status --porcelain`) and
  // adds a brand new untracked file.
  fs.appendFileSync(path.join(dir, 'shared.txt'), 'v3-uncommitted\n');
  fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'y\n', 'utf8');
  return dir;
}

/** A repo whose default branch never existed — exercises `no-merge-base`. */
function makeNoMergeBaseRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', 'trunk']); // neither 'main' nor 'master'
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'only.txt'), 'x\n', 'utf8');
  git(dir, ['add', 'only.txt']);
  git(dir, ['commit', '-q', '-m', 'trunk init']);
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'stray\n', 'utf8'); // uncommitted
  return dir;
}

/** A directory with a BROKEN `.git` — exercises `git-command-failed`. */
function makeBrokenGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'not a real git dir\n', 'utf8');
  return dir;
}

/**
 * A workspace fixture wired the same way forge-run-address.test.js's own
 * `makeFixture` is — registry roots + entries, run record in
 * `.gsd/forge/runs/`. `repoDirs` maps a repo NAME (as declared in
 * `entries[0].repos`) to an absolute directory already built by one of the
 * builders above.
 */
function makeFixture(repoDirs, opts) {
  opts = opts || {};
  const extraRun = opts.run || {};
  const tmp = mktmp();
  const home = path.join(tmp, 'home');
  const dev = path.join(home, 'Development');
  const wsDir = path.join(dev, 'ws');

  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  const runId = opts.runId || 'M-20260803120000-touch-fixture';

  const repoNames = Object.keys(repoDirs);
  for (const name of repoNames) {
    const target = path.join(wsDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(repoDirs[name], target);
  }

  // Written AFTER the repos land at their final paths so `opts.run` (a
  // function of `wsDir`) can name them — `worktrees[].repo` is a repo PATH,
  // not a name, and a fixture that guessed it would not be exercising the
  // shape the orchestrator actually writes.
  writeJson(path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`), Object.assign({
    kind: 'milestone',
    id: runId,
    session_id: 'sess-fixture',
    active: true,
    started_at: 1785763253000,
    last_heartbeat: 1785763253000,
    worker: null,
    worker_started: null,
    isolation_mode: 'branch',
    milestone_dir: `.gsd/milestones/${runId}/`,
    cwd: wsDir,
  }, typeof extraRun === 'function' ? extraRun(wsDir) : extraRun));

  writeJson(path.join(home, '.claude', 'forge-gate-workspaces.json'), {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [{ path: 'ws', root: '~/Development', kind: 'workspace', repos: repoNames }],
    quarantine: [],
  });

  return { tmp, home, dev, wsDir, runId };
}

console.log('\n=== forge-touch.js — touch-recording suite ===\n');

// ── R1 — committed + uncommitted, deduped, sorted ───────────────────────────

test('R1: committed and uncommitted files both appear, deduped and sorted', () => {
  const repo = makeDivergedRepo(mktmp('forge-touch-diverged-'));
  const fx = makeFixture({ 'repo-a': repo });

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(t.examined, 1, 'one addressed repo');
  assertEqual(t.repos.length, 1, 'one repo entry');
  const r = t.repos[0];
  assertEqual(r.status, 'ok', 'clean derivation');
  noteReason(r.reason);
  assertEqual(r.files.join(','), 'committed.txt,shared.txt,uncommitted.txt',
    'committed + uncommitted union, deduped (shared.txt appears once), sorted');
});

// ── R2 — never-recorded vs recorded-and-empty are DIFFERENT ─────────────────

test('R2: readTouched(null-record) vs readTouched(recorded, no touches) never collapse', () => {
  const clean = makeCleanRepo(mktmp('forge-touch-clean-'));
  const fx = makeFixture({ 'repo-a': clean });

  const before = readTouched(runs.get(fx.wsDir, fx.runId));
  assertEqual(before, null, 'never recorded -> null');

  const touched = recordTouched(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(touched.examined, 1, 'one repo examined');
  assertEqual(touched.repos[0].status, 'ok', 'clean repo, no touches');
  assertEqual(touched.repos[0].files.length, 0, 'no committed/uncommitted diff on a clean repo');

  const after = readTouched(runs.get(fx.wsDir, fx.runId));
  assert(after !== null, 'recorded-and-empty must NOT read back as null');
  assertEqual(after.examined, 1, 'examined > 0 survives the round trip');
  assertEqual(after.repos[0].files.length, 0, 'repos[].files stays empty, not omitted');
  assert(JSON.stringify(before) !== JSON.stringify(after), 'the two states are not equal, explicitly');
});

// ── R3 — a repo that cannot be examined still APPEARS, never dropped ────────

test('R3a: path:null -> skipped/repo-path-unresolved, reachable directly (resolveRunAddress never emits it today)', () => {
  const entry = deriveRepoEntry({ name: 'ghost', path: null });
  assertEqual(entry.status, 'skipped');
  assertEqual(entry.reason, 'repo-path-unresolved');
  assertEqual(entry.files.length, 0);
  noteReason(entry.reason);
});

test('R3b: a resolved path with no .git -> skipped/repo-not-git, and the repo stays IN repos[]', () => {
  const notGit = mktmp('forge-touch-notgit-');
  const fx = makeFixture({ 'repo-a': notGit });

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(t.repos.length, 1, 'entry present, not dropped');
  assertEqual(t.repos[0].status, 'skipped');
  assertEqual(t.repos[0].reason, 'repo-not-git');
  noteReason(t.repos[0].reason);
});

test('SVN-004: a real SVN WC reports modified and unversioned paths without invoking Git', () => {
  if (!hasSvnToolchain) return;
  const root = mktmp('forge-touch-svn-');
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  execFileSync('svnadmin', ['create', repo], { encoding: 'utf8' });
  const url = `file:///${repo.replace(/\\/g, '/')}`;
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'tracked.txt'), 'base\n');
  svn(root, ['import', seed, url, '-m', 'initial import', '--quiet']);
  svn(root, ['checkout', url, wc, '--quiet']);
  assert(!fs.existsSync(path.join(wc, '.git')), 'SVN fixture must not contain .git');
  fs.appendFileSync(path.join(wc, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(wc, 'new file.txt'), 'new\n');

  const entry = deriveRepoEntry({ name: 'svn-repo', path: wc });
  assertEqual(entry.status, 'ok', 'SVN WC must be examined, not skipped as repo-not-git');
  assertEqual(entry.reason, 'svn-working-copy', 'SVN scope limitation must be named');
  assertEqual(JSON.stringify(entry.files), JSON.stringify(['new file.txt', 'tracked.txt']), 'SVN changes are sorted and complete');
  noteReason(entry.reason);
});

test('SVN-004 failure is named and never becomes an empty successful census', () => {
  const result = touch.touchedFilesForSvn(mktmp('forge-touch-broken-svn-'));
  assertEqual(result.status, 'skipped');
  assertEqual(result.reason, 'svn-command-failed');
  noteReason(result.reason);
});

test('R3c: no default-branch match -> no-merge-base, uncommitted still reported (never invents a base)', () => {
  const repo = makeNoMergeBaseRepo(mktmp('forge-touch-nomergebase-'));
  const fx = makeFixture({ 'repo-a': repo });

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  const r = t.repos[0];
  assertEqual(r.status, 'ok', 'still an ok derivation, degraded to uncommitted-only');
  assertEqual(r.reason, 'no-merge-base');
  assertEqual(r.files.join(','), 'stray.txt', 'only the uncommitted file, no invented committed diff');
  noteReason(r.reason);
});

test('R3d: a broken .git -> skipped/git-command-failed, run continues (one sick repo never kills the collection)', () => {
  const broken = makeBrokenGitRepo(mktmp('forge-touch-broken-'));
  const clean = makeCleanRepo(mktmp('forge-touch-broken-sibling-'));
  const fx = makeFixture({ 'repo-a': broken, 'repo-b': clean });

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(t.examined, 2, 'both repos examined');
  const byName = Object.fromEntries(t.repos.map((r) => [r.name, r]));
  assertEqual(byName['repo-a'].status, 'skipped');
  assertEqual(byName['repo-a'].reason, 'git-command-failed');
  assertEqual(byName['repo-b'].status, 'ok', 'the sibling repo is unaffected');
  noteReason(byName['repo-a'].reason);
});

test('R3e: a run addressed to zero repos still yields a named census entry, never a bare []', () => {
  const tmp = mktmp('forge-touch-norepos-');
  const home = path.join(tmp, 'home');
  const wsDir = path.join(home, 'Development', 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  const runId = 'M-20260803120000-norepos';
  writeJson(path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`), {
    kind: 'milestone', id: runId, session_id: 's', active: true,
    started_at: 1, last_heartbeat: 1, worker: null, worker_started: null,
    isolation_mode: 'branch', milestone_dir: `.gsd/milestones/${runId}/`, cwd: wsDir,
  });
  writeJson(path.join(home, '.claude', 'forge-gate-workspaces.json'), {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [{ path: 'ws', root: '~/Development', kind: 'workspace', repos: [] }],
    quarantine: [],
  });

  const t = collectTouched(wsDir, runId, { home });
  assertEqual(t.examined, 0, 'zero repos examined');
  assertEqual(t.repos.length, 1, 'still ONE entry — the census is never mute');
  assertEqual(t.repos[0].status, 'skipped');
  assertEqual(t.repos[0].reason, 'run-has-no-repos');
  noteReason(t.repos[0].reason);
});

// ── R8 — worktree isolation: derive from where the run ACTUALLY worked ──────
//
// The bug this replaces: `collectTouched` resolved repos exclusively through
// `resolveRunAddress`, which returns REGISTRY-derived checkout paths, and the
// module contained zero references to `worktrees`. In `worktree` isolation the
// run's HEAD is `forge/{id}` inside `.forge-worktrees/{RUN}/<repo>`, so the
// registered checkout answers with an empty committed diff plus whatever
// unrelated dirt the main tree happens to carry. The assertions below fail
// against that code: `files` came back `[]` (or the main tree's dirt) and
// `source` was the hardcoded `'address'`.

/**
 * Cut a real `git worktree` on `forge/run` from an ALREADY-PLACED repo and
 * commit `files` inside it.
 *
 * Called after `makeFixture` has moved the repo to its final path, never
 * before: a worktree's `.git` file records an absolute gitdir, so renaming the
 * repo underneath it severs the link and every git call in the worktree dies
 * with `not a git repository` — a fixture artifact that would masquerade as
 * the very skip this suite is trying to disprove.
 */
function addWorktree(repoDir, wtDir, files) {
  git(repoDir, ['worktree', 'add', '-q', wtDir, '-b', 'forge/run', 'main']);
  git(wtDir, ['config', 'user.email', 'fixture@example.com']);
  git(wtDir, ['config', 'user.name', 'Fixture']);
  for (const f of files) fs.writeFileSync(path.join(wtDir, f), 'work\n', 'utf8');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'worktree work']);
  return wtDir;
}

test('R8a: with a registered worktree, files come from the WORKTREE and source says so', () => {
  const staging = mktmp('forge-touch-wt-');
  const wtDir = path.join(staging, 'wt');
  const fx = makeFixture({ 'repo-a': makeCleanRepo(path.join(staging, 'repo')) }, {
    run: (wsDir) => ({
      isolation_mode: 'worktree',
      branch: 'forge/run',
      worktrees: [{ repo: path.join(wsDir, 'repo-a'), path: wtDir }],
    }),
  });
  const placed = path.join(fx.wsDir, 'repo-a');
  addWorktree(placed, wtDir, ['wt-only.ts']);

  // Dirt in the MAIN checkout that belongs to nobody — the old code reported
  // exactly this and called it the run's work.
  fs.writeFileSync(path.join(placed, 'main-tree-dirt.txt'), 'dirt\n', 'utf8');

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  const r = t.repos[0];
  assertEqual(r.status, 'ok', 'the worktree derives cleanly');
  assertEqual(r.source, 'worktree', 'the census states WHICH tree was read');
  assertEqual(r.path, wtDir, 'path names the tree actually examined');
  assertEqual(r.files.join(','), 'wt-only.ts', "the worktree's committed work, and NOT the main checkout's dirt");
  assert(!r.files.includes('main-tree-dirt.txt'), 'main-checkout dirt is never attributed to the run');
  noteReason(r.reason);
});

test('R8b: repo_id is checkout-invariant — a worktree and its main checkout share one identity', () => {
  const staging = mktmp('forge-touch-id-');
  const repoStage = makeCleanRepo(path.join(staging, 'repo'));
  const wtDir = addWorktree(repoStage, path.join(staging, 'wt'), ['a.ts']);

  const idMain = touch.repoIdentity(repoStage);
  const idWt = touch.repoIdentity(wtDir);
  assert(idMain && idWt, 'both identities resolve');
  assertEqual(idWt, idMain, 'a worktree and its main checkout are the SAME repository');

  // ...and an independent repo is NOT that repository.
  const other = makeCleanRepo(path.join(staging, 'other'));
  assert(touch.repoIdentity(other) !== idMain, 'an unrelated repo has a different identity');
});

test('R8c: worktrees[] is keyed by repo PATH, so a basename collision never mismaps', () => {
  const staging = mktmp('forge-touch-collide-');
  const wtA = path.join(staging, 'wt-apps-norns');

  // Both repos are named `norns` at their basename — the operator's default case.
  const fx = makeFixture({
    'apps/norns': makeCleanRepo(path.join(staging, 'apps-norns')),
    'services/norns': makeCleanRepo(path.join(staging, 'services-norns')),
  }, {
    run: (wsDir) => ({
      isolation_mode: 'worktree',
      // ONLY apps/norns has a worktree. A name-keyed index would hand this
      // worktree to services/norns as well.
      worktrees: [{ repo: path.join(wsDir, 'apps', 'norns'), path: wtA }],
    }),
  });
  addWorktree(path.join(fx.wsDir, 'apps', 'norns'), wtA, ['apps-side.ts']);
  fs.writeFileSync(path.join(fx.wsDir, 'services', 'norns', 'services-side.ts'), 's\n', 'utf8');

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  const byPathTail = Object.fromEntries(t.repos.map((r) => [r.source, r]));
  assertEqual(t.repos.length, 2, 'both same-named repos are present');
  assertEqual(t.repos.filter((r) => r.source === 'worktree').length, 1, 'exactly ONE repo maps to the worktree');
  assertEqual(byPathTail.worktree.files.join(','), 'apps-side.ts', 'the worktree work lands on the repo that owns it');
  assertEqual(byPathTail.address.files.join(','), 'services-side.ts', 'the sibling keeps its own registered-checkout derivation');
});

test('R8d: a registered-but-absent worktree is SKIPPED with a name, never silently re-pointed at the checkout', () => {
  const staging = mktmp('forge-touch-wtgone-');
  const repoStage = makeCleanRepo(path.join(staging, 'repo'));
  fs.writeFileSync(path.join(repoStage, 'checkout-dirt.txt'), 'd\n', 'utf8');
  const ghostWt = path.join(staging, 'never-existed');
  const fx = makeFixture({ 'repo-a': repoStage }, {
    run: (wsDir) => ({
      isolation_mode: 'worktree',
      worktrees: [{ repo: path.join(wsDir, 'repo-a'), path: ghostWt }],
    }),
  });

  const t = collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  const r = t.repos[0];
  assertEqual(r.status, 'skipped', 'unknowable is skipped, not guessed');
  assertEqual(r.reason, 'worktree-path-missing');
  assertEqual(r.files.length, 0, 'the registered checkout is NOT substituted');
  assert(!r.files.includes('checkout-dirt.txt'), 'no fallback to the wrong tree');
  noteReason(r.reason);
});

// ── F2 — repoIdentity uses the SHARED canonicalizer, not a private realpath ──
//
// Measured on the Windows CI runner: os.tmpdir() hands paths in 8.3 short form
// (C:\Users\RUNNER~1\...) while git prints the long form — a repoIdentity that
// realpaths privately with plain fs.realpathSync (which does not expand 8.3)
// minted TWO identities for one repo, so worktree/checkout matching matched
// nothing. repoIdentity now delegates to realpathCanonical from
// forge-isolation.js; the source guard proving no private fs.realpathSync(
// call survives in this file lives in forge-isolation.test.js (F2), next to
// the helper, and bites on every platform.

test('F2: repoIdentity converges two spellings of one repo (symlink here; the Windows-only 8.3 divergence is covered by the shared helper\'s own test)', () => {
  if (process.platform === 'win32') {
    console.log('  (skip: on Windows the divergent spelling is an 8.3 short name, not a symlink, and symlink creation needs elevation — the 8.3 case is exercised against the SAME realpathCanonical helper in forge-isolation.test.js, so this is a declared platform split, not a silent pass)');
    return;
  }
  const base = mktmp('forge-touch-canon-');
  const real = path.join(base, 'real-repo');
  makeCleanRepo(real);
  const link = path.join(base, 'link-repo');
  fs.symlinkSync(real, link);

  const idReal = touch.repoIdentity(real);
  const idLink = touch.repoIdentity(link);
  assert(idReal !== null && idLink !== null, 'both spellings must yield an identity');
  assertEqual(idLink, idReal,
    'one repo reached through two spellings must yield ONE identity — two identities is the exact CI failure shape');
  // Non-vacuous: a repoIdentity regressed to lexical path.resolve would keep
  // the link spelling and the equality above would go red.
  assert(path.resolve(link, '.git') !== idLink,
    'sanity: the lexical spelling of the link\'s .git must differ from the canonical identity, or this test cannot bite');
});

// ── R4 — TOUCH_REASONS: every value reachable, nothing unreachable emitted ──

test('R4: every emitted reason belongs to TOUCH_REASONS, and every TOUCH_REASONS value was actually seen', () => {
  for (const r of reasonsSeen) {
    assert(TOUCH_REASONS.includes(r), `emitted reason "${r}" is not declared in TOUCH_REASONS`);
  }
  for (const r of TOUCH_REASONS.filter((reason) => hasSvnToolchain || reason !== 'svn-working-copy')) {
    assert(reasonsSeen.has(r), `TOUCH_REASONS value "${r}" was never actually emitted by any test`);
  }
});

// ── R6 — idempotency ─────────────────────────────────────────────────────────

test('R6: two recordTouched calls over the same git state produce identical repos (only `at` differs)', () => {
  const repo = makeDivergedRepo(mktmp('forge-touch-idem-'));
  const fx = makeFixture({ 'repo-a': repo });

  const first = recordTouched(fx.wsDir, fx.runId, { home: fx.home });
  const second = recordTouched(fx.wsDir, fx.runId, { home: fx.home });

  assertEqual(JSON.stringify(first.repos), JSON.stringify(second.repos), 'repos[] identical across two recordings of the same tree');
  assert(typeof first.at === 'number' && typeof second.at === 'number', 'at is a timestamp both times');
});

// ── R7 — mutation: prove the dedup actually bites ───────────────────────────

test('R7: removing the Set-dedup turns the shared.txt duplicate RED (mutação em memória — o fonte real nunca é escrito)', () => {
  const pristine = fs.readFileSync(MODULE);
  const pristineMtime = fs.statSync(MODULE).mtimeMs;
  const source = pristine.toString('utf8');

  const ORIGINAL = [
    '  const set = new Set();',
    "  for (const f of committed) set.add(f.split(path.sep).join('/'));",
    "  for (const f of uncommitted) set.add(f.split(path.sep).join('/'));",
    '  const files = Array.from(set).sort();',
  ].join('\n');
  const MUTATED = [
    "  const files = committed.concat(uncommitted).map((f) => f.split(path.sep).join('/')).sort();",
  ].join('\n');

  const occurrences = source.split(ORIGINAL).length - 1;
  assertEqual(occurrences, 1, 'the dedup block must appear exactly once (mutation target)');

  // A mutação é compilada EM MEMÓRIA, nunca gravada em disco.
  //
  // A versão anterior escrevia o fonte mutado por cima do
  // `scripts/forge-touch.js` REAL e restaurava no finally. O restore era
  // correto, mas durante a janela entre escrever e restaurar o arquivo ficava
  // divergente — e esta suíte roda em paralelo com 169 outras. Quem digere a
  // árvore de fontes do repo nessa janela lê bytes diferentes: o
  // `forge-release-gate` chama `packaging.build({repo})` DUAS vezes e afirma
  // que os dois hashes são iguais, e o `forge-package` digere a mesma árvore.
  // Ou seja, este teste era o ESCRITOR CONCORRENTE que tornava os vizinhos
  // flaky — a mesma família do item I-20260814142227, vista do outro lado.
  //
  // `Module._compile` com o filename real preserva a resolução dos requires
  // relativos internos, então o mutante roda idêntico sem tocar o disco.
  const NodeModule = require('module');
  const mutantModule = new NodeModule(MODULE, null);
  mutantModule.filename = MODULE;
  mutantModule.paths = NodeModule._nodeModulePaths(path.dirname(MODULE));
  mutantModule._compile(source.replace(ORIGINAL, MUTATED), MODULE);
  const mutant = mutantModule.exports;

  const repo = makeDivergedRepo(mktmp('forge-touch-mutant-'));
  const fx = makeFixture({ 'repo-a': repo });
  const t = mutant.collectTouched(fx.wsDir, fx.runId, { home: fx.home });
  const files = t.repos[0].files;
  const dupCount = files.filter((f) => f === 'shared.txt').length;

  assert(dupCount > 1, 'MUTATION SURVIVED: shared.txt did not duplicate without the dedup — R1 is not testing what it claims');
  // O fonte real nunca foi escrito — não há janela para vizinho nenhum ver.
  assert(fs.readFileSync(MODULE).equals(pristine), 'o fonte real não pode ser escrito por este teste');
  assertEqual(fs.statSync(MODULE).mtimeMs, pristineMtime, 'nem sequer o mtime do fonte real pode mudar');
});

// ── R5 (closing half) — this suite never wrote to the operator's live registry ──

// R5 proves this suite never writes the operator's workspace registry.
//
// The previous version watched the operator's LIVE
// `~/.claude/forge-gate-workspaces.json` (mtime/size at module load vs at the
// end). That cannot prove the property: the live registry is legitimately
// written by the app and by any concurrent forge process, so the assert only
// passed on an idle machine — item I-20260814142227, the same pathology
// S06/T02 (4cc3533) fixed in run-overlap. Worse, the header's claim of a
// "SYNTHETIC $HOME" was aspirational: nothing in the suite ever set one, so
// the guard was observational rather than structural.
//
// Now the isolation is REAL and the measurement is on a copy: a real-shaped
// registry is placed in a synthetic home, the CLI runs against it with HOME /
// USERPROFILE pointed there, and only that copy is compared. Concurrent
// writes to the operator's live file cannot reach the snapshot.
test('R5: uma registry real-shaped num HOME sintético nunca é escrita (cópia isolada + controle positivo)', () => {
  const isoHome = mktmp('touch-r5-home');
  const claudeDir = path.join(isoHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const target = path.join(claudeDir, 'forge-gate-workspaces.json');

  // Prefer the operator's real registry SHAPE; fall back to a minimal valid
  // one so the assert still runs on a fresh checkout / CI instead of skipping.
  let shape = 'synthetic';
  if (fs.existsSync(LIVE_REGISTRY)) {
    fs.copyFileSync(LIVE_REGISTRY, target);
    shape = 'real-shaped';
  } else {
    writeJson(target, { version: 1, roots: [], entries: [] });
  }

  const stamp = () => {
    const st = fs.statSync(target);
    return `${st.mtimeMs}:${st.size}:${require('crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  };

  // A repo for --record to act on, so the run is a real exercise of the CLI.
  const repo = mktmp('touch-r5-repo');
  git(repo, ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-qm', 'init']);

  const before = stamp();
  const env = { ...process.env, HOME: isoHome, USERPROFILE: isoHome };
  try {
    execFileSync(process.execPath, [MODULE, '--record', 'R5-run', '--cwd', repo, '--json'],
      { encoding: 'utf8', env, stdio: 'pipe' });
  } catch {
    // --record may legitimately refuse (no such run registered). The property
    // under test is that it did not WRITE the registry either way.
  }
  assertEqual(stamp(), before, `a registry ${shape} no HOME sintético não pode ser escrita`);

  // Positive control: the same comparator must bite.
  fs.appendFileSync(target, '\n');
  assert(stamp() !== before, 'controle positivo: uma escrita deliberada deve ser detectada pelo mesmo comparador');
});

// ── summary ──────────────────────────────────────────────────────────────────
cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
