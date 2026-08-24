#!/usr/bin/env node
// forge-touch — record which repos/files a run touched, straight from git.
//
// ── Why git, not the evidence log (S07 design contract §1) ─────────────────
//
// The evidence log (`.gsd/forge/evidence-{unitId}.jsonl`) records TOOL CALLS,
// not tree state. A file written then reverted counts as a touch there and
// should not; a file changed by a Bash `sed` never shows up there at all. The
// question this module answers is "what did this branch change relative to
// its base" — the exact question a future merge would ask — and git is the
// only source that answers it correctly. See S07-PLAN.md § Design contract.
//
// ── Where the signal lives ──────────────────────────────────────────────────
//
// An ADDITIVE `touched` field on the `RunRecord`, written via `runs.update`.
// Nothing migrates: a record written before this field existed stays
// byte-identical on disk until `--record` gives it a real reason to change.
// This mirrors `withAddressDefaults` (forge-runs.js, S06/T03) exactly, down
// to the one property that matters: `null` (never recorded) and
// `{ repos: [] }` (recorded, found nothing) are DIFFERENT facts and must
// never collapse. A comparator that treats them alike reports "nothing to
// report" when the honest answer is "nobody looked" — that confusion is the
// anti-silence defect this whole milestone exists to remove (TASK-021).
//
// ── Composition, not reimplementation ───────────────────────────────────────
//
//   run -> repos[]     forge-run-address.resolveRunAddress   (S06, cwd-invariant)
//   default branch     forge-isolation.gitDefaultBranch
//   persistence        forge-runs.get / forge-runs.update
//
// A fourth implementation of any of those relations is the defect, not the
// feature (S07-PLAN.md § Standards).
//
// ── Posture ──────────────────────────────────────────────────────────────
//
// Advisory collector. Read-only git only (diff, status, merge-base, symbolic-
// ref, rev-parse) — never add/commit/fetch/checkout. `exit 0` always,
// including when every repo was skipped.
//
// CLI:
//   node forge-touch.js --record <run-id> [--json] [--cwd <dir>]
//   node forge-touch.js --show   <run-id> [--json] [--cwd <dir>]

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveRunAddress } = require('./forge-run-address.js');
const { gitDefaultBranch, realpathCanonical } = require('./forge-isolation.js');
const vcsApi = require('./forge-vcs.js');
const runs = require('./forge-runs.js');

// ── Reasons ──────────────────────────────────────────────────────────────
//
// Enumerated and cross-checked by test against what the code actually
// produces (S07-PLAN.md § Steps 2 and 6; lesson of TASK-021: a comment that
// misdescribes its own reachable cases IS the defect). Each value below says
// exactly WHEN it is reachable — no aspirational entries, no dead ones.
const TOUCH_REASONS = [
  'repo-path-unresolved', // addr.repos[i].path is null — address could not resolve a path for this repo (e.g. discoverRepos' one-level-deep limit, item I-20260803060030)
  'repo-not-git',         // path resolved but `<path>/.git` does not exist — not a git repo
  'svn-working-copy',     // SVN has no run branch: report the honest current WC delta only
  'svn-command-failed',   // SVN was detected but its read-only status query failed
  'git-command-failed',   // a git invocation for this repo threw (corrupt repo, permissions, etc.) — the repo is skipped, the run for other repos continues
  'no-merge-base',        // `git merge-base HEAD <default>` failed — no committed diff is computed; uncommitted files are still reported, never invented as "no touches"
  'run-has-no-repos',     // resolveRunAddress returned addr.repos.length === 0 — the census still emits one entry rather than an empty, silent array
  'worktree-path-missing',// the run REGISTERS a worktree for this repo but the directory is gone (removed, pruned, moved). Skipped on purpose — see `deriveRepoEntry`: falling back to the registered checkout would answer a question nobody asked.
];

// ── Where the run's work actually lives (review-fix R1) ────────────────────
//
// In `worktree` isolation the worker's HEAD is `forge/{run-id}` inside
// `<root>/.forge-worktrees/{RUN}/<repo>` — NOT the registry-derived checkout
// `resolveRunAddress` hands back. Deriving from the registered path there
// diffs the wrong tree twice over: its HEAD is usually the default branch (so
// the committed diff is empty) and its `git status` reports the MAIN
// checkout's unrelated dirt. Two concurrent runs both snapshot that same
// checkout and the comparator downstream reports either a confident `clean`
// or an equally confident overlap on shared dirt. `worktree` is the
// shape-derived default wherever a workspace exists (S04), i.e. precisely
// where concurrent runs are plausible, so this is the common path, not a
// corner.
//
// The map is keyed by the RESOLVED registered repo path, never by repo name:
// `worktrees[].repo` carries that path, and basename collision
// (`apps/norns` + `services/norns`) is the DEFAULT case on this operator's
// disk — a name key would silently drop one of the two, the exact bug S05's
// review already conceded once.
function worktreeIndexFor(worktrees) {
  const map = new Map();
  for (const w of (Array.isArray(worktrees) ? worktrees : [])) {
    if (!w || typeof w.repo !== 'string' || typeof w.path !== 'string') continue;
    map.set(path.resolve(w.repo), w.path);
  }
  return map;
}

/**
 * A checkout-INVARIANT identity for the git repository at `p` (review-fix R2).
 *
 * `git rev-parse --git-common-dir` names the ONE object store shared by a main
 * checkout and every worktree cut from it: `.git` (relative) from the main
 * checkout, the main repo's absolute `.git` from a worktree. Resolved against
 * `p` and realpath'd, both spellings converge on the same string — which is
 * what lets the comparator recognise two worktrees of one repo as one repo,
 * while still telling two independent clones apart (different stores,
 * different ids).
 *
 * `null` on any failure. Deliberately non-fatal: a repo whose identity cannot
 * be read still has a real, reportable diff, and the consumer degrades to
 * path comparison rather than losing the entry.
 */
function repoIdentity(p) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: p, encoding: 'utf8' }).trim();
    if (!out) return null;
    const abs = path.isAbsolute(out) ? out : path.resolve(p, out);
    // realpathCanonical (imported from forge-isolation.js), NOT a private
    // fs.realpathSync: on the Windows CI runner `p` arrives via os.tmpdir() in
    // 8.3 short form (C:\Users\RUNNER~1\...) while git prints the long form —
    // plain realpathSync resolves symlinks but does not expand 8.3, so the
    // SAME repo yielded two identities (idWt !== idMain) and the comparator
    // never matched a worktree to its checkout. One shared implementation of
    // "canonical spelling" is the rule this module already states above for
    // repo addressing: a fourth copy of the relation is the defect.
    return realpathCanonical(abs);
  } catch {
    return null;
  }
}

/**
 * Parse one line of `git status --porcelain` into the path it names.
 *
 * Format is `XY PATH` or, for a rename, `XY OLD -> NEW` — we want NEW, the
 * file's current location. Paths containing special characters are quoted
 * and backslash-escaped by git (C-locale quoting); both are unwound so the
 * final path compares equal to the plain paths `git diff --name-only` emits.
 */
function parsePorcelainPath(line) {
  let rest = line.slice(3); // two status chars + one space
  if (rest.includes(' -> ')) {
    rest = rest.split(' -> ')[1];
  }
  if (rest.length >= 2 && rest[0] === '"' && rest[rest.length - 1] === '"') {
    rest = rest.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return rest;
}

/**
 * Derive the committed + uncommitted files touched in one repo.
 *
 * Committed: `git diff --name-only <merge-base>..HEAD`, base found via
 * `git merge-base HEAD <default>` with `<default>` from the imported
 * `gitDefaultBranch` — never re-derived (S07-PLAN.md § Key Links).
 * Uncommitted: `git status --porcelain`.
 * Union, deduped via `Set`, sorted, forward-slash relative to `repoPath` —
 * POSIX-relative regardless of host OS, so two machines produce the same
 * comparable shape (T02 will diff these lists across runs).
 *
 * Never throws: any git failure that is not the merge-base step degrades to
 * `{ status: 'skipped', reason: 'git-command-failed', files: [] }` so one
 * sick repo never kills the whole collection.
 */
function touchedFilesFor(repoPath) {
  let base = null;
  let noMergeBase = false;
  try {
    const def = gitDefaultBranch(repoPath);
    base = execFileSync('git', ['merge-base', 'HEAD', def], { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch {
    noMergeBase = true;
  }

  let committed = [];
  try {
    if (base) {
      const out = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], { cwd: repoPath, encoding: 'utf8' });
      committed = out.split('\n').map((l) => l.trim()).filter(Boolean);
    }
  } catch {
    return { status: 'skipped', reason: 'git-command-failed', files: [] };
  }

  let uncommitted = [];
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
    uncommitted = out.split('\n').filter(Boolean).map(parsePorcelainPath).filter(Boolean);
  } catch {
    return { status: 'skipped', reason: 'git-command-failed', files: [] };
  }

  const set = new Set();
  for (const f of committed) set.add(f.split(path.sep).join('/'));
  for (const f of uncommitted) set.add(f.split(path.sep).join('/'));
  const files = Array.from(set).sort();

  if (noMergeBase) {
    // Uncommitted-only is still an honest answer — never invent a base or
    // silently report zero committed files as "clean".
    return { status: 'ok', reason: 'no-merge-base', files };
  }
  return { status: 'ok', reason: null, files };
}

function touchedFilesForSvn(repoPath) {
  const result = vcsApi.workingStatus(repoPath, { vcs: 'svn' });
  if (!result.ok) return { status: 'skipped', reason: 'svn-command-failed', files: [] };
  const files = Array.from(new Set(result.entries
    .filter((entry) => entry.kind !== 'ignored')
    .map((entry) => entry.path.split(path.sep).join('/')))).sort();
  return { status: 'ok', reason: 'svn-working-copy', files };
}

/**
 * Map ONE address-leg repo `{ name, path }` to its touch entry.
 *
 * `worktreeIndex` (optional) is `worktreeIndexFor(rec.worktrees)`. When it has
 * an entry for this repo, THAT is the tree the run worked in and the one
 * derived from; `source` says which was used, so the census never leaves a
 * reader guessing where a file list came from. The `source` field was shipped
 * hardcoded to `'address'` in T01 — a seam that was never wired; this is the
 * wiring, not a new field.
 *
 * A registered-but-absent worktree is SKIPPED with a named reason rather than
 * falling back to the registered checkout. The fallback looks harmless and is
 * not: it answers a question nobody asked (what the main checkout contains)
 * in the shape of an answer to the question that was asked, which is the
 * silent-`clean` failure class this whole slice exists to close. An honest
 * skip shrinks the comparison in plain sight and lands the verdict on the
 * `inconclusive` floor, which is the correct outcome for "we do not know".
 *
 * Exported separately from `collectTouched` so `repo-path-unresolved` is
 * directly testable: `resolveRunAddress`'s own repo leg never hands back a
 * null `path` today (every declared repo resolves to a joined absolute
 * path), so the branch below could otherwise sit untested until some future
 * address shape actually produces one — exactly the "reason never seen
 * failing" gap TASK-021 warns about. Calling this function directly with a
 * fabricated `{ path: null }` entry proves the branch fires without waiting
 * for `resolveRunAddress` to grow a way to reach it.
 */
function deriveRepoEntry(r, worktreeIndex) {
  if (!r || !r.path) {
    return { name: (r && r.name) || null, path: null, source: 'address', repo_id: null, status: 'skipped', reason: 'repo-path-unresolved', files: [] };
  }

  const wt = worktreeIndex ? worktreeIndex.get(path.resolve(r.path)) : undefined;
  const derivePath = wt || r.path;
  const source = wt ? 'worktree' : 'address';

  if (wt && !fs.existsSync(wt)) {
    return { name: r.name, path: wt, source, repo_id: null, status: 'skipped', reason: 'worktree-path-missing', files: [] };
  }
  const vcs = vcsApi.detectVcs(derivePath);
  if (vcs === 'none') {
    return { name: r.name, path: derivePath, source, repo_id: null, status: 'skipped', reason: 'repo-not-git', files: [] };
  }

  const derived = vcs === 'svn' ? touchedFilesForSvn(derivePath) : touchedFilesFor(derivePath);
  return {
    name: r.name, path: derivePath, source,
    // Identity of the underlying repository, NOT of this checkout — two
    // worktrees of one repo share it, two clones do not. See `repoIdentity`.
    repo_id: vcs === 'git' ? repoIdentity(derivePath) : null,
    status: derived.status, reason: derived.reason || null, files: derived.files,
  };
}

/**
 * Pure(ish) read: resolve the run's address, then derive files per repo.
 * Never writes anything — persistence is `recordTouched`'s job alone.
 *
 * Shape (S07-PLAN.md § Design contract 2):
 *   { at, examined, repos: [{ name, path, source, repo_id, status, reason?, files }] }
 */
function collectTouched(cwd, runId, opts) {
  const addr = resolveRunAddress(cwd, runId, opts || {});
  const at = Date.now();
  // In worktree isolation the registered checkout is NOT where this run
  // worked. See `worktreeIndexFor`.
  const wtIndex = worktreeIndexFor(addr.run && addr.run.worktrees);

  if (addr.repos.length === 0) {
    // The census never goes silent: zero addressable repos is itself a fact
    // worth a named entry, not an empty array a reader could mistake for
    // "examined and clean".
    return {
      at,
      examined: 0,
      repos: [{
        name: null, path: null, source: 'address', repo_id: null,
        status: 'skipped', reason: 'run-has-no-repos', files: [],
      }],
    };
  }

  const repos = addr.repos.map((r) => deriveRepoEntry(r, wtIndex));
  return { at, examined: addr.repos.length, repos };
}

/** Derive AND persist — the only function in this module that writes. */
function recordTouched(cwd, runId, opts) {
  const touched = collectTouched(cwd, runId, opts);
  runs.update(cwd, runId, { touched });
  return touched;
}

/**
 * `null` for a run that was never recorded, the recorded object otherwise —
 * INCLUDING when that object says `repos: []`-shaped emptiness (in practice
 * always at least the `run-has-no-repos` synthetic entry, never a bare `[]`,
 * per `collectTouched` above). The two must never collapse: `null` means
 * "nobody asked this run about its touches yet"; a present object with
 * `examined > 0` means "we asked, and here is the honest — possibly empty —
 * answer". A caller (T02) that compares them as equal would report a run
 * that was simply never captured as if it had been examined and found
 * clean, which is exactly the silent-`clean` failure class S07 exists to
 * close. Do not "simplify" this to `rec.touched || null` — `||` and `? :`
 * with the same truthy check happen to agree today only because `touched`
 * is always either absent or a non-empty object; keep the explicit form so
 * intent survives a future shape change.
 */
function readTouched(rec) {
  return rec && rec.touched ? rec.touched : null;
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

const USAGE = `forge-touch — record repos/files touched by a run (git-derived, advisory)

Flags:
  --record <run-id>   derive and persist touched repos/files for the run
  --show <run-id>     print the run's currently recorded touch data
  --json              emit JSON instead of the human-readable form
  --cwd <path>        where to look for the run registry (default: process.cwd())
  --help              this text

Read-only git only. Never writes to the run other than the --record path.
Exit code is always 0 — this is an advisory collector.
`;

function formatRepoLine(r) {
  if (r.status === 'ok') {
    return `  ${r.name || '(?)'}  ${r.files.length} arquivo(s)`;
  }
  return `  ${r.name || '(?)'}  — (${r.reason})`;
}

function formatTouched(touched) {
  if (!touched) return '(nunca gravado)';
  const lines = [`at=${new Date(touched.at).toISOString()} examined=${touched.examined}`];
  for (const r of touched.repos) lines.push(formatRepoLine(r));
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.record && !args.show)) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();

  try {
    if (typeof args.record === 'string') {
      const touched = recordTouched(cwd, args.record, { cwd });
      process.stdout.write(args.json ? `${JSON.stringify(touched, null, 2)}\n` : `${formatTouched(touched)}\n`);
      return 0;
    }
    if (typeof args.show === 'string') {
      const rec = runs.get(cwd, args.show);
      const touched = readTouched(rec);
      process.stdout.write(args.json ? `${JSON.stringify(touched, null, 2)}\n` : `${formatTouched(touched)}\n`);
      return 0;
    }
  } catch (e) {
    // Advisory collector: report the failure, still exit 0 — a run id typo
    // or an unreadable registry should never break a caller's loop.
    process.stderr.write(`forge-touch: ${e.message}\n`);
    return 0;
  }

  process.stdout.write(USAGE);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  collectTouched,
  recordTouched,
  readTouched,
  touchedFilesFor,
  touchedFilesForSvn,
  deriveRepoEntry,
  worktreeIndexFor,
  repoIdentity,
  parsePorcelainPath,
  TOUCH_REASONS,
  parseArgs,
  main,
  USAGE,
};
