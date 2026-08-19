#!/usr/bin/env node
'use strict';

// forge-slice-git-guard — post-hoc check that a `complete-slice` unit did not
// integrate branches.
//
// Why this exists (incident 2026-08-14, item I-20260814114608): the dispatch
// prompt for `complete-slice` said "Do NOT squash-merge" and the completer
// performed a NON-squash merge of the milestone branch into master, then left
// the checkout on master.  It appears to have read the prohibition as specific
// to *squash*.  Prohibiting by prompt is fragile; the durable fix removes the
// merge step from every surface the completer reads AND leaves this guard so a
// violation is *reported* rather than discovered at push time.
//
// Scope: `complete-slice` only.  Branch integration is `complete-milestone`'s
// competence and this guard is never invoked there.
//
// The invariants are chosen so that a legitimate `complete-slice` with
// `auto_commit: true` passes: it may `git add` + `git commit` summaries onto
// the branch it is already on.  It may not change which branch is checked out,
// move the default branch, or create a merge commit.
//
// Usage:
//   node forge-slice-git-guard.js --snapshot --cwd <dir> --unit complete-slice/S05 \
//        --gsd-dir <workspace>/.gsd --run <RUN_ID>
//   node forge-slice-git-guard.js --verify   --cwd <dir> --unit complete-slice/S05 \
//        --gsd-dir <workspace>/.gsd --run <RUN_ID>
//
// WHAT THIS GUARD DOES NOT SEE (item #112, documented rather than fixed, so a
// clean verdict is never read as more than it is):
//   * `git push` — no remote state is consulted at all, so the template's
//     prohibition on pushing is unverifiable from here.
//   * `rebase` / `pull --rebase` of the run branch — the branch name does not
//     move and no merge commit appears, so all three checks stay clean.
//   * `reset --hard` that DISCARDS commits — check 1 compares branch NAMES and
//     check 3 asks `rev-list old..new`, which is empty when history rewinds.
// So `clean` means "none of the three measured violations happened", never
// "the repository was not touched".
//
// The snapshot is persisted to disk (.gsd/forge/), never carried in a shell
// variable: shell state does not survive between orchestrator Bash calls (the
// `auto-mode started_at` pitfall).
//
// Exit codes: 0 = clean or inconclusive, 3 = violation, 2 = usage/IO error.
// `inconclusive` is NEVER reported as `clean` — a checker that reports its own
// inactivity as good news is indistinguishable from a broken one.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { gitDefaultBranch, gitCurrentBranch } = require('./forge-isolation.js');

const VERDICTS = Object.freeze({ CLEAN: 'clean', VIOLATION: 'violation', INCONCLUSIVE: 'inconclusive' });
const EXIT = Object.freeze({ OK: 0, ERROR: 2, VIOLATION: 3 });

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!r || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

function revParse(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
}

function isGitRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function slug(value, fallback) {
  return String(value || fallback).replace(/[^A-Za-z0-9._-]+/g, '-');
}

// Two facts decide this path, and both were wrong before (item #112).
//
// WHERE. Callers pass `--cwd "$CODE_DIR"`, so under `worktree` isolation this
// wrote `.gsd/` INSIDE the worktree — against the standing convention that
// `.gsd/**` always lives in the original workspace, and creating an untracked
// file that can make `cleanupWorktreeOne`'s dirty-check report `skipped (dirty)`
// in a project that does not gitignore `.gsd/`. `--gsd-dir` is the same seam
// TASK-020 added to `forge-reverify`, with the same meaning: the path OF the
// `.gsd` directory, not of the workspace above it.
//
// WHICH RUN. The name carried the unit and nothing else, so two runs closing
// the same `S##` in one workspace wrote the same file — one run's baseline
// silently answering for the other's. `--run` scopes it. Omitting the flag
// reproduces the previous name byte for byte, so a caller with no run id is
// never forced to invent one.
function snapshotPath(cwd, unit, opts = {}) {
  const gsdDir = opts.gsdDir ? path.resolve(opts.gsdDir) : path.join(cwd, '.gsd');
  const run = opts.run ? slug(opts.run, 'run') + '-' : '';
  return path.join(gsdDir, 'forge', 'slice-git-snapshot-' + run + slug(unit, 'unit') + '.json');
}

// ---------------------------------------------------------------- snapshot

function snapshot(cwd, unit) {
  if (!isGitRepo(cwd)) {
    return { unit, vcs: null, reason: 'not-a-git-repo', taken_at: new Date().toISOString() };
  }
  // '' means detached HEAD (git branch --show-current prints nothing); null
  // means the command failed.  They are different facts and stay different.
  const branch = gitCurrentBranch(cwd);
  const def = gitDefaultBranch(cwd);
  return {
    unit,
    vcs: 'git',
    branch: branch === '' ? null : branch,
    detached: branch === '',
    head: revParse(cwd, 'HEAD'),
    default_branch: def,
    default_head: revParse(cwd, def),
    taken_at: new Date().toISOString(),
  };
}

function writeSnapshot(cwd, unit, opts = {}) {
  const snap = snapshot(cwd, unit);
  const file = snapshotPath(cwd, unit, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n', 'utf8');
  return { snapshot: snap, file };
}

function readSnapshot(cwd, unit, opts = {}) {
  try { return JSON.parse(fs.readFileSync(snapshotPath(cwd, unit, opts), 'utf8')); }
  catch { return null; }
}

// A snapshot is a baseline for exactly ONE verify, and it is spent by being
// read. Leaving it on disk is what let a skipped snapshot step be answered by
// an older session's baseline — the caller cannot tell a fresh reading from a
// stale one, and the guard reported `clean` against a world that had moved.
//
// Consumption is preferred over an age threshold on `taken_at` because there is
// no measured number to put in one: a `complete-slice` worker legitimately runs
// for minutes, and any cutoff would be invented rather than derived. Removing
// the file turns "stale baseline" into `snapshot-missing`, which this module
// already reports as `inconclusive` — the direction this repo always errs in.
// The age is still reported, so a reader can see how old the baseline was.
function consumeSnapshot(cwd, unit, opts = {}) {
  const file = snapshotPath(cwd, unit, opts);
  const snap = readSnapshot(cwd, unit, opts);
  let removed = false;
  if (snap !== null) {
    try { fs.unlinkSync(file); removed = true; } catch { /* best effort: the verdict never depends on it */ }
  }
  return { snapshot: snap, file, removed };
}

// `null` when the snapshot carries no usable `taken_at` — absent and unparseable
// are the same fact here (we cannot say how old it is) and neither of them is 0.
function snapshotAgeMs(snap, now = Date.now()) {
  if (!snap || !snap.taken_at) return null;
  const taken = Date.parse(snap.taken_at);
  return Number.isFinite(taken) ? now - taken : null;
}

// ------------------------------------------------------------------ verify

function mergeCommitsSince(cwd, from, to) {
  if (!from || !to) return null;
  const out = git(cwd, ['rev-list', '--min-parents=2', `${from}..${to}`]);
  if (out === null) return null;
  return out ? out.split('\n').filter(Boolean) : [];
}

// Each check reports its own verdict and a named reason.  A check that could
// not run is `inconclusive` and is enumerated — never dropped silently.
function verify(cwd, snap) {
  const checks = [];

  if (!snap) {
    checks.push({ name: 'snapshot-present', verdict: VERDICTS.INCONCLUSIVE, reason: 'snapshot-missing' });
    return finalize(checks);
  }
  if (snap.vcs !== 'git' || !isGitRepo(cwd)) {
    checks.push({ name: 'snapshot-present', verdict: VERDICTS.INCONCLUSIVE, reason: snap.reason || 'not-a-git-repo' });
    return finalize(checks);
  }

  const nowBranchRaw = gitCurrentBranch(cwd);
  const nowBranch = nowBranchRaw === '' ? null : nowBranchRaw;
  const nowHead = revParse(cwd, 'HEAD');

  // 1. The checkout must be where it started.  This is the check that would
  //    have caught the incident's second damage: the completer left the
  //    checkout on master, which would have landed the whole next slice
  //    outside the isolation branch.
  if (!snap.branch || nowBranchRaw === null) {
    checks.push({
      name: 'current-branch-unchanged',
      verdict: VERDICTS.INCONCLUSIVE,
      reason: !snap.branch ? 'snapshot-branch-unknown' : 'current-branch-unreadable',
    });
  } else if (nowBranch !== snap.branch) {
    checks.push({
      name: 'current-branch-unchanged',
      verdict: VERDICTS.VIOLATION,
      reason: 'checkout-moved',
      detail: `checkout left ${snap.branch} for ${nowBranch || '(detached HEAD)'}`,
    });
  } else {
    checks.push({ name: 'current-branch-unchanged', verdict: VERDICTS.CLEAN, reason: 'branch-identical' });
  }

  // 2. The default branch must not have advanced.  This is the incident
  //    itself: master went 27 commits ahead by absorbing the milestone branch.
  const nowDefaultHead = revParse(cwd, snap.default_branch);
  if (!snap.default_head || !nowDefaultHead) {
    checks.push({
      name: 'default-branch-head-unchanged',
      verdict: VERDICTS.INCONCLUSIVE,
      reason: snap.default_head ? 'default-branch-unresolved-now' : 'default-branch-unresolved-at-snapshot',
      detail: `default branch: ${snap.default_branch}`,
    });
  } else if (snap.branch && snap.branch === snap.default_branch) {
    // Working directly on the default branch: commits there are the unit's
    // own legitimate summary commits, so head movement proves nothing.
    // Check 3 still covers merges.
    checks.push({
      name: 'default-branch-head-unchanged',
      verdict: VERDICTS.INCONCLUSIVE,
      reason: 'slice-runs-on-default-branch',
    });
  } else if (nowDefaultHead !== snap.default_head) {
    checks.push({
      name: 'default-branch-head-unchanged',
      verdict: VERDICTS.VIOLATION,
      reason: 'default-branch-advanced',
      detail: `${snap.default_branch}: ${snap.default_head.slice(0, 8)} → ${nowDefaultHead.slice(0, 8)}`,
    });
  } else {
    checks.push({ name: 'default-branch-head-unchanged', verdict: VERDICTS.CLEAN, reason: 'default-head-identical' });
  }

  // 3. No merge commit created anywhere the unit could reach.  Catches a merge
  //    INTO the slice branch, which checks 1 and 2 both miss.
  const merges = [];
  let mergeMeasured = false;
  for (const [label, from, to] of [
    ['HEAD', snap.head, nowHead],
    [snap.default_branch, snap.default_head, nowDefaultHead],
  ]) {
    const found = mergeCommitsSince(cwd, from, to);
    if (found === null) continue;
    mergeMeasured = true;
    for (const sha of found) merges.push(`${label}:${sha.slice(0, 8)}`);
  }
  if (!mergeMeasured) {
    checks.push({ name: 'no-merge-commit-created', verdict: VERDICTS.INCONCLUSIVE, reason: 'rev-list-unavailable' });
  } else if (merges.length) {
    checks.push({
      name: 'no-merge-commit-created',
      verdict: VERDICTS.VIOLATION,
      reason: 'merge-commit-created',
      detail: merges.join(', '),
    });
  } else {
    checks.push({ name: 'no-merge-commit-created', verdict: VERDICTS.CLEAN, reason: 'no-new-merge-commits' });
  }

  return finalize(checks);
}

function finalize(checks) {
  const violations = checks.filter(c => c.verdict === VERDICTS.VIOLATION);
  const conclusive = checks.filter(c => c.verdict !== VERDICTS.INCONCLUSIVE);
  let verdict;
  if (violations.length) verdict = VERDICTS.VIOLATION;
  // Floor: `clean` is a claim about work performed.  Zero conclusive checks
  // means nothing was measured, which is not the same as nothing was wrong.
  else if (conclusive.length === 0) verdict = VERDICTS.INCONCLUSIVE;
  else verdict = VERDICTS.CLEAN;
  return {
    verdict,
    checks,
    violations,
    census: {
      checks_run: checks.length,
      checks_conclusive: conclusive.length,
      checks_inconclusive: checks.length - conclusive.length,
    },
  };
}

// --------------------------------------------------------------------- CLI

function parseArgv(argv) {
  const out = { mode: null, cwd: process.cwd(), unit: 'complete-slice', gsdDir: null, run: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot') out.mode = 'snapshot';
    else if (a === '--verify') out.mode = 'verify';
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--unit') out.unit = argv[++i];
    else if (a === '--gsd-dir') out.gsdDir = argv[++i];
    else if (a === '--run') out.run = argv[++i];
  }
  return out;
}

function main(argv) {
  const opts = parseArgv(argv);
  if (!opts.mode) {
    process.stderr.write('usage: forge-slice-git-guard.js --snapshot|--verify --cwd <dir> --unit <unit> [--gsd-dir <dir>] [--run <id>]\n');
    return EXIT.ERROR;
  }
  const cwd = path.resolve(opts.cwd);
  const where = { gsdDir: opts.gsdDir, run: opts.run };
  if (opts.mode === 'snapshot') {
    const res = writeSnapshot(cwd, opts.unit, where);
    process.stdout.write(JSON.stringify(res) + '\n');
    return EXIT.OK;
  }
  // Consumed, not merely read: see consumeSnapshot. `snapshot_removed` is
  // reported so a failure to remove is visible rather than assumed.
  const taken = consumeSnapshot(cwd, opts.unit, where);
  const result = verify(cwd, taken.snapshot);
  result.unit = opts.unit;
  result.snapshot_file = taken.file;
  result.snapshot_removed = taken.removed;
  result.snapshot_age_ms = snapshotAgeMs(taken.snapshot);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.verdict === VERDICTS.VIOLATION) {
    for (const v of result.violations) {
      process.stderr.write(`forge-slice-git-guard: VIOLATION ${v.name} — ${v.reason}${v.detail ? ' — ' + v.detail : ''}\n`);
    }
    process.stderr.write('forge-slice-git-guard: complete-slice must not integrate branches. Inspect before pushing.\n');
    return EXIT.VIOLATION;
  }
  return EXIT.OK;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { VERDICTS, EXIT, snapshot, writeSnapshot, readSnapshot, consumeSnapshot, snapshotAgeMs, snapshotPath, verify, main };
