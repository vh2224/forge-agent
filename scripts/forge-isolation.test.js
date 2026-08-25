#!/usr/bin/env node
// forge-isolation.test.js — contract suite for git-primary worktree discovery
//
// Why this suite exists (S04 blocker #1, measured 2026-08-02):
//   ~/Development/message holds 7 live worktrees born under the OLD
//   sibling-of-repo convention, 6 registered in git with real commits, while
//   the run registry's `worktrees[]` covers only 2 of them. cleanupForRun used
//   to RE-DERIVE the convention path; the moment the anchor moves, that
//   derivation points at a path that never existed, finds nothing, and reports
//   success — orphaning every one of those trees forever.
//
//   So cleanup asks git. These fixtures reproduce the shape in tmpdir
//   (bare origin -> clone -> `git worktree add`) and prove:
//     - a worktree at the OLD convention path and one at an ARBITRARY
//       unrelated path are BOTH discovered and removed (convention-proof);
//     - the dirty-check guard (2026-06-10 data-loss incident) still skips;
//     - registry<->git divergence is REPORTED, never absorbed (git wins);
//     - the repo's main checkout is never treated as a run worktree, even
//       when it sits on the forge branch;
//     - worktree_cleanup_on_complete=false short-circuits before any removal;
//     - --list-worktrees is strictly read-only.
//
// The real worktrees under ~/Development/message are operator data: this suite
// NEVER touches them. Every destructive assertion runs in tmpdir.
//
// Run: node scripts/forge-isolation.test.js  (exit 0 = all pass)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isolation = require('./forge-isolation.js');
const {
  listWorktreesForBranch, listForgeWorktrees, parseWorktreePorcelain,
  normalizeWorktreePath, cleanupForRun, setupForRun, deriveWorktreePath,
  resolveWorktreeAnchor, validateWorktreeDirName,
  realpathCanonical, gitDefaultBranch,
} = isolation;
const workspace = require('./forge-workspace.js');

// ── Harness ─────────────────────────────────────────────────────────────────
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
  const comparable = (value) => {
    if (typeof value !== 'string' || !(/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value))) return value;
    // The SAME canonicalizer the code under test uses (realpathCanonical),
    // never a private lexical one: path.resolve() leaves Windows 8.3 short
    // names (C:\Users\RUNNER~1\...) unexpanded while git prints the long
    // form, so a lexical normalizer here compares two spellings of one path
    // as different — the exact mismatch class this suite exists to catch,
    // reproduced in the "expected [removed]" CI failures.
    return realpathCanonical(value).toLowerCase();
  };
  const a = JSON.stringify(comparable(actual));
  const e = JSON.stringify(comparable(expected));
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

const CLI = path.join(__dirname, 'forge-isolation.js');

function git(args, cwd) {
  const res = spawnSync('git', [
    '-c', 'user.email=isolation-test@forge', '-c', 'user.name=isolation-test',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout;
}

// Builds: base/origin-<name>.git (bare) -> base/ws/<name> (clone with a commit).
function makeRepo(base, name) {
  const bare = path.join(base, `origin-${name}.git`);
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  const ws = path.join(base, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const repo = path.join(ws, name);
  git(['clone', '--quiet', bare, repo], base);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  git(['add', 'README.md'], repo);
  git(['commit', '-qm', 'init'], repo);
  git(['push', '-q', '-u', 'origin', 'main'], repo);
  return repo;
}

// Workspace with .gsd/ so prefs + the run registry resolve. Prefs are written
// once per sandbox: readPrefsCached memoizes per cwd.
function makeWorkspace(prefs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolation-test-'));
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(prefs), 'utf8');
  return { base, ws };
}

function writeRun(ws, id, record) {
  fs.writeFileSync(
    path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`),
    JSON.stringify({ id, kind: 'milestone', session_id: 'isolation-test', active: true, ...record }),
    'utf8',
  );
}

const WORKTREE_PREFS = {
  forge_isolation: { mode: 'worktree', auto_pull_main: false, worktree_cleanup_on_complete: true, worktree_install_deps: false },
  workers: { require_worktree: 'false' },
};

// $HOME is neutralized for the whole body: setupForRun now reads the workspace
// registry from `$HOME/.claude/`, and readPrefsCached reads user-global prefs
// from there too. A test that left the real HOME in place would consult the
// operator's registry — passing or failing according to where their roots
// happen to point, which is not a property of this code at all.
function withSandbox(prefs, fn) {
  const sandbox = makeWorkspace(prefs);
  const neutralHome = path.join(sandbox.base, 'neutral-home');
  fs.mkdirSync(neutralHome, { recursive: true });
  try { withHome(neutralHome, () => fn(sandbox)); }
  finally { fs.rmSync(sandbox.base, { recursive: true, force: true }); }
}

// The OLD sibling-of-repo convention that produced the 7 live worktrees:
//   path.join(repoPath, '..', worktreeRoot, runId, repoName)
function oldConventionPath(repo, runId) {
  return path.join(repo, '..', '.forge-worktrees', runId, path.basename(repo));
}

function statusesOf(result) {
  return (result.repos || []).map(r => r.status);
}

console.log('\n=== forge-isolation.js — git-primary worktree discovery ===\n');

// ── Porcelain parser ────────────────────────────────────────────────────────

test('parseWorktreePorcelain parses blocks and normalizes refs/heads/', () => {
  const out = [
    'worktree /repo', 'HEAD aaa111', 'branch refs/heads/main', '',
    'worktree /wt/one', 'HEAD bbb222', 'branch refs/heads/forge/M-X', '',
    'worktree /wt/detached', 'HEAD ccc333', 'detached', '',
  ].join('\n');
  const parsed = parseWorktreePorcelain(out);
  assertEq(parsed.length, 3, 'block count');
  assertEq(parsed[1].path, '/wt/one', 'second path');
  assertEq(parsed[1].branch, 'forge/M-X', 'branch is stripped of refs/heads/');
  assertEq(parsed[1].head, 'bbb222', 'head sha');
  assertEq(parsed[2].detached, true, 'detached flag');
  assertEq(parsed[2].branch, null, 'detached block has no branch');
});

test('parseWorktreePorcelain flags bare and prunable blocks and tolerates a missing trailing blank line', () => {
  const out = [
    'worktree /bare', 'bare', '',
    'worktree /wt/gone', 'HEAD ddd444', 'branch refs/heads/forge/M-Y', 'prunable gitdir file points to non-existent location',
  ].join('\n');
  const parsed = parseWorktreePorcelain(out);
  assertEq(parsed.length, 2, 'block count without trailing blank line');
  assertEq(parsed[0].bare, true, 'bare flag');
  assertEq(parsed[1].prunable, true, 'prunable flag');
  assertEq(parsed[1].branch, 'forge/M-Y', 'prunable block still carries its branch');
});

// ── Discovery against a real git fixture ────────────────────────────────────

test('listWorktreesForBranch finds an old-convention worktree and excludes the main checkout', () => {
  withSandbox(WORKTREE_PREFS, ({ ws }) => {
    const repo = makeRepo(path.dirname(ws), 'alpha');
    const wt = oldConventionPath(repo, 'M-T01X');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['worktree', 'add', '-q', wt, '-b', 'forge/M-T01X'], repo);

    const found = listWorktreesForBranch(repo, 'forge/M-T01X');
    assertEq(found.length, 1, 'exactly one worktree on the run branch');
    assertEq(normalizeWorktreePath(found[0].path), normalizeWorktreePath(wt), 'discovered path');
    assertEq(found[0].branch, 'forge/M-T01X', 'discovered branch');

    const mainListed = listWorktreesForBranch(repo, 'main');
    assertEq(mainListed.length, 0, 'main checkout is never listed as a run worktree');

    const forgeAll = listForgeWorktrees(repo);
    assertEq(forgeAll.length, 1, 'listForgeWorktrees sees the forge/* tree');
  });
});

test('cleanup removes BOTH an old-convention worktree and one at an arbitrary unrelated path (convention-proof)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const alpha = makeRepo(base, 'alpha');
    const beta  = makeRepo(base, 'beta');

    // alpha: the OLD sibling-of-repo convention.
    const conventionWt = oldConventionPath(alpha, 'M-T01X');
    fs.mkdirSync(path.dirname(conventionWt), { recursive: true });
    git(['worktree', 'add', '-q', conventionWt, '-b', 'forge/M-T01X'], alpha);

    // beta: an arbitrary path no convention would ever derive.
    const arbitraryWt = path.join(base, 'somewhere', 'totally', 'unrelated-beta');
    fs.mkdirSync(path.dirname(arbitraryWt), { recursive: true });
    git(['worktree', 'add', '-q', arbitraryWt, '-b', 'forge/M-T01X'], beta);

    assert(fs.existsSync(conventionWt) && fs.existsSync(arbitraryWt), 'both fixtures exist before cleanup');
    writeRun(ws, 'M-T01X', { isolation_mode: 'worktree', worktrees: [] });

    const result = cleanupForRun(ws, 'M-T01X');
    assertEq(result.mode, 'worktree', 'cleanup mode');
    assertEq(statusesOf(result).filter(s => s === 'removed').length, 2, `both worktrees removed: ${JSON.stringify(result.repos)}`);
    assert(!fs.existsSync(conventionWt), 'old-convention worktree removed');
    assert(!fs.existsSync(arbitraryWt), 'arbitrary-path worktree removed — discovery does not depend on the convention');
    assert((result.repos || []).every(r => r.source === 'git'),
      `rows discovered by git are tagged source=git: ${JSON.stringify(result.repos)}`);
  });
});

test('dirty worktree is skipped and nothing is removed (2026-06-10 incident guard)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const wt = oldConventionPath(repo, 'M-DIRTY');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['worktree', 'add', '-q', wt, '-b', 'forge/M-DIRTY'], repo);
    fs.writeFileSync(path.join(wt, 'uncommitted.txt'), 'work in progress\n');

    writeRun(ws, 'M-DIRTY', { isolation_mode: 'worktree', worktrees: [] });
    const result = cleanupForRun(ws, 'M-DIRTY');
    const row = (result.repos || [])[0];
    assert(row && /^skipped \(dirty\)/.test(row.status), `dirty status: ${JSON.stringify(result.repos)}`);
    assert(fs.existsSync(wt), 'dirty worktree survives cleanup');
    assert(fs.existsSync(path.join(wt, 'uncommitted.txt')), 'uncommitted work is preserved');

    // Positive control: once committed, the same cleanup removes it.
    git(['add', 'uncommitted.txt'], wt);
    git(['commit', '-qm', 'wip'], wt);
    const after = cleanupForRun(ws, 'M-DIRTY');
    assertEq(statusesOf(after), ['removed'], `clean worktree is removed: ${JSON.stringify(after.repos)}`);
    assert(!fs.existsSync(wt), 'clean worktree removed after commit');
  });
});

test('registry/git divergence is reported, never absorbed: git-only is cleaned, registry-only is named', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const realWt = oldConventionPath(repo, 'M-DIVERGE');
    fs.mkdirSync(path.dirname(realWt), { recursive: true });
    git(['worktree', 'add', '-q', realWt, '-b', 'forge/M-DIVERGE'], repo);

    // The registry knows a path git does NOT list — the 5-of-7 blind spot.
    const phantom = path.join(base, 'phantom', 'never-existed');
    writeRun(ws, 'M-DIVERGE', { isolation_mode: 'worktree', worktrees: [{ repo, path: phantom }] });

    // Snapshot before cleanup: symlink resolution only works while it exists.
    const realWtNorm = normalizeWorktreePath(realWt);
    const result = cleanupForRun(ws, 'M-DIVERGE');
    const rows = result.repos || [];

    const removed = rows.find(r => r.status === 'removed');
    assert(removed, `git-listed worktree is cleaned even though the registry never mentioned it: ${JSON.stringify(rows)}`);
    assertEq(normalizeWorktreePath(removed.worktree), realWtNorm, 'removed path is the git-listed one');
    assertEq(removed.source, 'git', 'git-only row is visibly sourced from git');
    assert(!fs.existsSync(realWt), 'git wins: the tree git listed is gone');

    const divergent = rows.find(r => /registry-only/.test(r.status || ''));
    assert(divergent, `registry-only entry is reported: ${JSON.stringify(rows)}`);
    assertEq(divergent.worktree, phantom, 'divergent row names the registry path');
    assertEq(divergent.source, 'registry', 'divergent row names its source');
    assert(/divergência/.test(divergent.reason || ''), `divergence is spelled out: ${divergent.reason}`);
    assert(!fs.existsSync(phantom), 'nothing was created for the phantom path');
  });
});

test('a git-listed worktree that IS registered is tagged git+registry (reinforcement, not source)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const wt = oldConventionPath(repo, 'M-BOTH');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['worktree', 'add', '-q', wt, '-b', 'forge/M-BOTH'], repo);
    writeRun(ws, 'M-BOTH', { isolation_mode: 'worktree', worktrees: [{ repo, path: wt }] });

    const result = cleanupForRun(ws, 'M-BOTH');
    assertEq(statusesOf(result), ['removed'], `single row: ${JSON.stringify(result.repos)}`);
    assertEq(result.repos[0].source, 'git+registry', 'agreement between git and registry is visible');
  });
});

test('the main checkout is never treated as a run worktree, even sitting on the forge branch', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    git(['checkout', '-q', '-b', 'forge/M-MAIN'], repo);
    assertEq(git(['branch', '--show-current'], repo).trim(), 'forge/M-MAIN', 'main checkout sits on the forge branch');

    assertEq(listWorktreesForBranch(repo, 'forge/M-MAIN').length, 0,
      'discovery excludes the entry whose path equals repoPath');

    writeRun(ws, 'M-MAIN', { isolation_mode: 'worktree', worktrees: [] });
    const result = cleanupForRun(ws, 'M-MAIN');
    assert((result.repos || []).every(r => r.status !== 'removed'),
      `nothing removed: ${JSON.stringify(result.repos)}`);
    assert(/^not-found/.test(result.repos[0].status), `absence is stated, not silent: ${JSON.stringify(result.repos)}`);
    assert(fs.existsSync(path.join(repo, 'README.md')), 'the main checkout is intact');
    assert(fs.existsSync(path.join(repo, '.git')), 'the main checkout is still a repo');
  });
});

test('worktree_cleanup_on_complete=false short-circuits before any git query or removal', () => {
  const prefs = {
    forge_isolation: { mode: 'worktree', auto_pull_main: false, worktree_cleanup_on_complete: false, worktree_install_deps: false },
    workers: { require_worktree: 'false' },
  };
  withSandbox(prefs, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const wt = oldConventionPath(repo, 'M-NOCLEAN');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(['worktree', 'add', '-q', wt, '-b', 'forge/M-NOCLEAN'], repo);
    writeRun(ws, 'M-NOCLEAN', { isolation_mode: 'worktree', worktrees: [{ repo, path: wt }] });

    const result = cleanupForRun(ws, 'M-NOCLEAN');
    assertEq(statusesOf(result), ['skipped (worktree_cleanup_on_complete=false)'], JSON.stringify(result.repos));
    assert(fs.existsSync(wt), 'worktree untouched when cleanup is disabled');
  });
});

// ── Borrow / lend guards (unchanged behavior) ───────────────────────────────

test('borrower guard: rec.attached_to short-circuits before any git query', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const lenderWt = oldConventionPath(repo, 'M-LENDER');
    fs.mkdirSync(path.dirname(lenderWt), { recursive: true });
    git(['worktree', 'add', '-q', lenderWt, '-b', 'forge/M-LENDER'], repo);
    writeRun(ws, 'M-LENDER', { isolation_mode: 'worktree', worktrees: [{ repo, path: lenderWt }] });
    writeRun(ws, 'T-BORROW', { kind: 'task', isolation_mode: 'worktree', attached_to: 'M-LENDER', worktrees: [{ repo, path: lenderWt }] });

    const result = cleanupForRun(ws, 'T-BORROW');
    assertEq(result.mode_source, 'borrowed', 'borrowed short-circuit');
    assertEq(result.borrowed_from, 'M-LENDER', 'names the lender');
    assert((result.repos || []).every(r => /borrowed/.test(r.status)), JSON.stringify(result.repos));
    assert(fs.existsSync(lenderWt), 'borrowed tree survives the borrower cleanup');
  });
});

test('lender guard: an active borrower blocks removal; once inactive, cleanup proceeds (positive control)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const lenderWt = oldConventionPath(repo, 'M-LENDER2');
    fs.mkdirSync(path.dirname(lenderWt), { recursive: true });
    git(['worktree', 'add', '-q', lenderWt, '-b', 'forge/M-LENDER2'], repo);
    writeRun(ws, 'M-LENDER2', { isolation_mode: 'worktree', worktrees: [{ repo, path: lenderWt }] });
    writeRun(ws, 'T-BORROW2', { kind: 'task', active: true, isolation_mode: 'worktree', attached_to: 'M-LENDER2', worktrees: [{ repo, path: lenderWt }] });

    let result = cleanupForRun(ws, 'M-LENDER2');
    assert(Array.isArray(result.lent_to) && result.lent_to.includes('T-BORROW2'), JSON.stringify(result));
    assert((result.repos || []).every(r => /lent to T-BORROW2/.test(r.status)), JSON.stringify(result.repos));
    assert(fs.existsSync(lenderWt), 'lent tree survives while the borrow is active');

    writeRun(ws, 'T-BORROW2', { kind: 'task', active: false, isolation_mode: 'worktree', attached_to: 'M-LENDER2', worktrees: [{ repo, path: lenderWt }] });
    result = cleanupForRun(ws, 'M-LENDER2');
    assertEq(statusesOf(result), ['removed'], JSON.stringify(result.repos));
    assert(!fs.existsSync(lenderWt), 'cleanup proceeds once the borrow is inactive');
  });
});

// ── Read-only CLI ───────────────────────────────────────────────────────────

test('--list-worktrees prints discovered worktrees as JSON and mutates nothing', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    const wtA = oldConventionPath(repo, 'M-LIST');
    fs.mkdirSync(path.dirname(wtA), { recursive: true });
    git(['worktree', 'add', '-q', wtA, '-b', 'forge/M-LIST'], repo);
    const wtB = path.join(base, 'elsewhere', 'other');
    fs.mkdirSync(path.dirname(wtB), { recursive: true });
    git(['worktree', 'add', '-q', wtB, '-b', 'forge/M-OTHER'], repo);

    const before = git(['worktree', 'list', '--porcelain'], repo);
    const res = spawnSync(process.execPath, [CLI, '--list-worktrees', '--cwd', ws], { encoding: 'utf8' });
    assertEq(res.status, 0, `exit code (stderr: ${res.stderr})`);
    const out = JSON.parse(res.stdout);
    assertEq(out.total, 2, `both forge/* worktrees listed: ${res.stdout}`);
    assertEq(out.branch, null, 'no --run means every forge/* branch');
    const paths = out.repos[0].worktrees.map(w => normalizeWorktreePath(w.path)).sort();
    assertEq(paths, [wtA, wtB].map(normalizeWorktreePath).sort(), 'listed paths');

    const filtered = spawnSync(process.execPath, [CLI, '--list-worktrees', '--run', 'M-LIST', '--cwd', ws], { encoding: 'utf8' });
    const filteredOut = JSON.parse(filtered.stdout);
    assertEq(filteredOut.branch, 'forge/M-LIST', '--run resolves the branch');
    assertEq(filteredOut.total, 1, '--run filters to that branch');

    // Read-only proof: git metadata and both trees are untouched.
    assertEq(git(['worktree', 'list', '--porcelain'], repo), before, 'git worktree metadata is byte-identical');
    assert(fs.existsSync(wtA) && fs.existsSync(wtB), 'no worktree was removed by the listing');
  });
});

test('--list-worktrees never spawns a destructive git worktree subcommand', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const start = source.indexOf("if (args['list-worktrees'])");
  assert(start > 0, 'list-worktrees CLI branch exists');
  const end = source.indexOf("} else if (args['effective-mode'])", start);
  // Strip comments: the guard must judge executable code, not the prose that
  // describes what the code refrains from doing.
  const branch = source.slice(start, end === -1 ? undefined : end)
    .split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert(!/cleanupWorktreeOne|worktree remove|worktree prune|--force/.test(branch),
    `read-only branch must contain no removal call: ${branch}`);
});

// ── deriveWorktreePath — the single remaining derivation (T02) ─────────────
// T01 removed the copy inside cleanupForRun; setupWorktreeOne's own copy is
// the last inline occurrence. This section proves it was named, not just
// moved, and that setup->cleanup still round-trips once cleanup no longer
// shares any code path with it — including across a convention change.

test('deriveWorktreePath: absolute worktree_root -> <root>/<runId>/<repoName>', () => {
  const repo = path.join('/some', 'deep', 'repo-name');
  const got = deriveWorktreePath(repo, '/abs/wt-root', 'M-ABS1');
  assertEq(got, path.join('/abs/wt-root', 'M-ABS1', 'repo-name'), 'absolute branch literal path');
});

test('deriveWorktreePath: relative worktree_root -> <repoParent>/<worktreeRoot>/<runId>/<repoName>', () => {
  const repo = path.join('/some', 'deep', 'repo-name');
  const got = deriveWorktreePath(repo, '.forge-worktrees', 'M-REL1');
  assertEq(got, path.join('/some', 'deep', '.forge-worktrees', 'M-REL1', 'repo-name'), 'relative branch literal path — ".." cancels the repo dir, leaving its PARENT');
});

// T03 renamed the single home of the convention (deriveWorktreePath became a
// thin delegate over resolveWorktreeAnchor, which also decides the anchor), so
// these two guards follow the function — the PROPERTY they defend is unchanged:
// the convention appears exactly once, and setupWorktreeOne re-derives nothing.
test('the join-with-.. convention appears exactly once in the source, inside resolveWorktreeAnchor', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  // Normalized: matches the `path.join(<expr>, '..', <worktreeRoot-ish>` shape
  // regardless of the local variable name bound to repoPath/worktreeRoot.
  const matches = source.match(/path\.join\([^,]+,\s*'\.\.',\s*\w*worktreeRoot\w*/g) || [];
  assertEq(matches.length, 1, `expected exactly one occurrence, found ${matches.length}: ${JSON.stringify(matches)}`);
  const idx = source.indexOf(matches[0]);
  const fnStart = source.lastIndexOf('function resolveWorktreeAnchor', idx);
  const fnEnd = source.indexOf('\nfunction deriveWorktreePath', fnStart);
  assert(fnStart !== -1 && idx > fnStart && idx < fnEnd,
    'the single occurrence lives inside resolveWorktreeAnchor, not in setupWorktreeOne');
});

test('deriveWorktreePath delegates to resolveWorktreeAnchor — it holds no convention of its own', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const start = source.indexOf('function deriveWorktreePath');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);
  assert(/resolveWorktreeAnchor\(repoPath, worktreeRoot, runId/.test(body),
    `deriveWorktreePath must delegate: ${body}`);
  assert(!/path\.join/.test(body), `deriveWorktreePath must not join paths itself: ${body}`);
});

test('setupWorktreeOne consumes the shared deriver — no inline convention re-derivation remains', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const start = source.indexOf('function setupWorktreeOne');
  const end = source.indexOf('\nfunction cleanupWorktreeOne', start);
  const body = source.slice(start, end);
  assert(/resolveWorktreeAnchor\(repoPath, worktreeRoot, runId, anchorOpts\)/.test(body),
    `setupWorktreeOne must consume resolveWorktreeAnchor: ${body}`);
  assert(!/isAbsolute\(worktreeRoot\)/.test(body),
    `no leftover convention branch in setupWorktreeOne: ${body}`);
  assert(!/path\.join\([^,]+,\s*'\.\.'/.test(body),
    `no leftover sibling join in setupWorktreeOne: ${body}`);
});

test('round-trip A: setupForRun creates a worktree; cleanupForRun (git-based) finds and removes it', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-RTA', { isolation_mode: 'worktree', worktrees: [] });

    const setup = setupForRun(ws, 'M-RTA');
    assertEq(setup.mode, 'worktree', 'setup mode');
    assertEq(setup.repos.length, 1, 'one repo set up');
    const row = setup.repos[0];
    assertEq(row.status, 'created', `worktree created: ${JSON.stringify(row)}`);
    const expected = deriveWorktreePath(repo, '.forge-worktrees', 'M-RTA');
    assertEq(normalizeWorktreePath(row.worktree), normalizeWorktreePath(expected), 'worktree path matches deriveWorktreePath directly');
    assert(fs.existsSync(row.worktree), `worktree exists on disk at ${row.worktree}`);
    assertEq(git(['branch', '--show-current'], row.worktree).trim(), 'forge/M-RTA', 'worktree is on the run branch');

    const cleanup = cleanupForRun(ws, 'M-RTA');
    assertEq(statusesOf(cleanup), ['removed'], `cleanup removes it: ${JSON.stringify(cleanup.repos)}`);
    assert(!fs.existsSync(row.worktree), 'worktree directory is gone');
    assertEq(listWorktreesForBranch(repo, 'forge/M-RTA').length, 0, '`git worktree list` no longer lists it');
  });
});

test('round-trip B: worktree_root is CHANGED between setup and cleanup — cleanup still finds and removes it (convention-flip proof)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-RTB', { isolation_mode: 'worktree', worktrees: [] });

    const setup = setupForRun(ws, 'M-RTB');
    const row = setup.repos[0];
    assertEq(row.status, 'created', `worktree created under the OLD convention: ${JSON.stringify(row)}`);
    assert(fs.existsSync(row.worktree), 'worktree exists before the flip');

    // Flip the convention: a fresh worktree_root name. If cleanup re-derived
    // the path from prefs it would compute a DIFFERENT (nonexistent) path and
    // report false success. It must not — it discovers via git instead.
    const flippedPrefs = {
      forge_isolation: { ...WORKTREE_PREFS.forge_isolation, worktree_root: '.a-totally-different-worktree-root' },
      workers: WORKTREE_PREFS.workers,
    };
    fs.writeFileSync(path.join(ws, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(flippedPrefs), 'utf8');

    // Prove the flip actually changes the derivation (else this test proves nothing).
    const oldDerived = row.worktree;
    const newDerived = deriveWorktreePath(repo, '.a-totally-different-worktree-root', 'M-RTB');
    assert(normalizeWorktreePath(oldDerived) !== normalizeWorktreePath(newDerived),
      'sanity: the flipped convention derives a genuinely different path');
    assert(!fs.existsSync(newDerived), 'sanity: nothing exists at the new-convention path — a re-derive would find nothing');

    const cleanup = cleanupForRun(ws, 'M-RTB');
    assertEq(statusesOf(cleanup), ['removed'], `cleanup still finds the OLD-convention worktree via git: ${JSON.stringify(cleanup.repos)}`);
    assert(!fs.existsSync(oldDerived), 'the actual (old-convention) worktree is gone');
    assertEq(listWorktreesForBranch(repo, 'forge/M-RTB').length, 0, '`git worktree list` confirms removal');
  });
});

test('setupForRun result shape exposes {path, branch, worktree, status} and worktree equals the derived path', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-SHAPE', { isolation_mode: 'worktree', worktrees: [] });
    const setup = setupForRun(ws, 'M-SHAPE');
    const row = setup.repos[0];
    for (const key of ['path', 'branch', 'worktree', 'status']) {
      assert(Object.prototype.hasOwnProperty.call(row, key), `result row is missing "${key}": ${JSON.stringify(row)}`);
    }
    assertEq(row.path, repo, 'path is the repo path');
    assertEq(row.branch, 'forge/M-SHAPE', 'branch is the resolved run branch');
    assert(fs.existsSync(row.worktree), 'worktree field points at the real created worktree');
    cleanupForRun(ws, 'M-SHAPE');
  });
});

// ── Source-level guard: the convention derivation is gone from cleanup ──────

test('cleanupForRun contains no convention re-derivation and asks git instead', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const start = source.indexOf('function cleanupForRun');
  const end = source.indexOf('\n}\n\n// ── CLI', start);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert(!/path\.join\(r, '\.\.', prefs\.worktreeRoot/.test(body),
    'the sibling-of-repo derivation is gone from cleanupForRun');
  assert(!/isAbsolute\(prefs\.worktreeRoot\)/.test(body),
    'no worktreeRoot branch remains in cleanupForRun — git records where the worktree is');
  assert(/listWorktreesForBranch\(r, branchName\)/.test(body), 'cleanup queries git for the run branch');
  assert(/cleanupWorktreeOne\(r, wt\.path\)/.test(body), 'removal still goes through the dirty-checked helper');
  assert(/rec && Array\.isArray\(rec\.worktrees\)/.test(body), 'registry is consumed as reinforcement');
  assert(/registry-only/.test(body), 'divergence status is emitted from cleanup');
});

// ── T03: the anchor moves to the declared root ──────────────────────────────
// Every path assertion below is compared against a LITERAL expectation, never
// against a second call to the function under test — a derivation checked
// against itself passes even when the convention silently reverts.
//
// Registry fixtures always live under a synthetic $HOME. The operator's real
// `~/.claude/forge-gate-workspaces.json` is never read and never written here.

const REPO = path.join('/some', 'deep', 'repo-name');

function reg(roots, opts) {
  return { roots, home: (opts || {}).home || '/home-x', registryFile: (opts || {}).file || '/home-x/.claude/forge-gate-workspaces.json' };
}

test('anchor: repo under a declared root with layout.worktrees -> <root>/<layout>/<runId>/<repo>', () => {
  const got = resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-L1',
    reg([{ path: '/some', primary: true, layout: { worktrees: '.wt' } }]));
  assertEq(got.path, path.join('/some', '.wt', 'M-L1', 'repo-name'), 'literal root-anchored path');
  assertEq(got.anchor, 'root', 'anchor is reported as root');
  assertEq(got.root, '/some', 'the root that won is reported');
  assertEq(got.dir_source, 'layout', 'the directory name came from layout');
});

test('anchor: root without layout falls back to the RELATIVE pref as the directory name', () => {
  const got = resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-L2', reg([{ path: '/some', primary: true }]));
  assertEq(got.path, path.join('/some', '.forge-worktrees', 'M-L2', 'repo-name'),
    'relative pref names the dir, but the ROOT is still the anchor');
  assertEq(got.anchor, 'root');
  assertEq(got.dir_source, 'pref');
});

test('anchor: the DEEPEST containing root wins (same rule as the codec containment scan)', () => {
  const got = resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-L3', reg([
    { path: '/some', primary: true, layout: { worktrees: '.shallow' } },
    { path: '/some/deep', layout: { worktrees: '.deep' } },
  ]));
  assertEq(got.path, path.join('/some', 'deep', '.deep', 'M-L3', 'repo-name'), 'deepest root and ITS layout');
  assertEq(got.root, path.join('/some', 'deep'));
});

test('anchor: an ABSOLUTE worktree_root pref still wins over a declared root (highest precedence)', () => {
  const got = resolveWorktreeAnchor(REPO, '/abs/wt-root', 'M-ABS2',
    reg([{ path: '/some', primary: true, layout: { worktrees: '.wt' } }]));
  assertEq(got.path, path.join('/abs/wt-root', 'M-ABS2', 'repo-name'), 'absolute pref path, root ignored');
  assertEq(got.anchor, 'pref-absolute');
  assertEq(got.root, null, 'no root is claimed when the pref decided');
});

test('anchor: repo under NO declared root -> legacy sibling convention, reported as such', () => {
  const got = resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-NR', reg([{ path: '/elsewhere', primary: true }]));
  assertEq(got.path, path.join('/some', 'deep', '.forge-worktrees', 'M-NR', 'repo-name'), 'legacy sibling literal');
  assertEq(got.anchor, 'legacy-sibling');
});

test('anchor: no roots at all (absent registry) -> legacy sibling, unchanged from before T03', () => {
  assertEq(resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-NOREG', { roots: [], home: '/home-x' }).anchor,
    'legacy-sibling', 'an absent registry is the ordinary case, not an error');
  assertEq(deriveWorktreePath(REPO, '.forge-worktrees', 'M-NOREG'),
    path.join('/some', 'deep', '.forge-worktrees', 'M-NOREG', 'repo-name'),
    'the 3-argument call keeps its exact pre-T03 behaviour');
});

test('anchor: a root whose path is unusable never disqualifies the others', () => {
  const got = resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-BADROOT', reg([
    { path: 'relative-and-unanchored', primary: true },
    { path: '/some/deep', layout: { worktrees: '.ok' } },
  ]));
  assertEq(got.path, path.join('/some', 'deep', '.ok', 'M-BADROOT', 'repo-name'), 'the usable root still anchors');
});

test('validateWorktreeDirName refuses non-hidden, absolute and escaping values; accepts hidden ones', () => {
  assertEq(validateWorktreeDirName('.forge-worktrees'), null, 'hidden is accepted');
  assertEq(validateWorktreeDirName('.wt/nested'), null, 'nested under a hidden first segment is accepted');
  assert(/not hidden/.test(validateWorktreeDirName('worktrees') || ''), 'a non-hidden name is refused');
  assert(/not hidden/.test(validateWorktreeDirName('build/.wt') || ''), 'only the FIRST segment being hidden counts');
  assert(/absolute/.test(validateWorktreeDirName('/tmp/wt') || ''), 'absolute is refused');
  assert(/escapes/.test(validateWorktreeDirName('.wt/../../etc') || ''), '".." traversal is refused');
  assert(validateWorktreeDirName('') !== null, 'empty is refused');
});

test('anchor: a NON-HIDDEN layout.worktrees is refused loudly — naming the registry file and the value', () => {
  let err = null;
  try {
    resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-GHOST',
      reg([{ path: '/some', primary: true, layout: { worktrees: 'worktrees' } }]));
  } catch (e) { err = e; }
  assert(err !== null, 'a non-hidden layout must throw, never be silently defaulted');
  assert(/"worktrees"/.test(err.message), `the offending value is named: ${err && err.message}`);
  assert(/forge-gate-workspaces\.json/.test(err.message), `the registry file is named: ${err && err.message}`);
  assert(/not hidden/.test(err.message), `the reason is stated: ${err && err.message}`);
});

test('anchor: absolute and root-escaping layout.worktrees are refused too', () => {
  for (const [value, needle] of [['/tmp/elsewhere', /absolute/], ['../outside', /escapes/], ['.wt/../..', /escapes/]]) {
    let err = null;
    try {
      resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-ESC',
        reg([{ path: '/some', primary: true, layout: { worktrees: value } }]));
    } catch (e) { err = e; }
    assert(err !== null && needle.test(err.message), `layout ${JSON.stringify(value)} must be refused: ${err && err.message}`);
  }
});

// ── R2 (M-20260802185210 S04 review): non-string layout.worktrees ─────────

test('R2: counterfactual — the pre-fix typeof-string check WOULD silently degrade a non-string layout value to the pref', () => {
  const declared = 123;
  const preFixFromLayout = typeof declared === 'string';
  assertEq(preFixFromLayout, false,
    'proves the bite: the old `fromLayout = typeof declared === "string"` treats a declared-but-non-string ' +
    'value exactly like "no layout declared at all" — no throw, no warn, just a quiet pref fallback');
});

test('R2: a non-string layout.worktrees (number) is refused loudly, not silently degraded to the pref dirName', () => {
  let err = null;
  try {
    resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-NUM',
      reg([{ path: '/some', primary: true, layout: { worktrees: 123 } }]));
  } catch (e) { err = e; }
  assert(err !== null, 'a non-string layout value must throw, matching the documented contract for layout-sourced badness');
  assert(/123/.test(err.message), `the offending value is named: ${err && err.message}`);
  assert(/is not a string/.test(err.message), `the reason is stated: ${err && err.message}`);
});

test('R2: a non-string layout.worktrees (object) is refused loudly too', () => {
  let err = null;
  try {
    resolveWorktreeAnchor(REPO, '.forge-worktrees', 'M-OBJ',
      reg([{ path: '/some', primary: true, layout: { worktrees: { nested: true } } }]));
  } catch (e) { err = e; }
  assert(err !== null, 'a non-string layout value (object) must also throw');
  assert(/is not a string/.test(err.message), `the reason is stated: ${err && err.message}`);
});

test('anchor: a non-hidden PREF under a root degrades to the legacy sibling WITH a warning — it never throws', () => {
  const got = resolveWorktreeAnchor(REPO, 'worktrees', 'M-PREFBAD', reg([{ path: '/some', primary: true }]));
  assertEq(got.path, path.join('/some', 'deep', 'worktrees', 'M-PREFBAD', 'repo-name'), 'legacy sibling, as before roots existed');
  assertEq(got.anchor, 'legacy-sibling');
  assert(/not hidden/.test(got.warn || ''), `the degradation is reported, not silent: ${got.warn}`);
  assert(/[\\/]some/.test(got.warn || ''), `the root it declined to use is named: ${got.warn}`);
});

test('forge-workspace normalizeRootEntry carries layout through and drops a non-object one', () => {
  assertEq(workspace.normalizeRootEntry({ path: '~/Development', layout: { worktrees: '.wt' } }, 0).layout.worktrees,
    '.wt', 'layout survives normalization — otherwise the anchor could never see it');
  assertEq(workspace.normalizeRootEntry({ path: '~/Development', layout: 'nonsense' }, 0).layout,
    undefined, 'a malformed layout is dropped, not thrown on');
  assertEq(workspace.normalizeRootEntry('~/Development', 0).primary, true, 'the bare-string form still works');
});

// ── T03 end-to-end: real git, real registry file, synthetic $HOME ───────────

function withHome(home, fn) {
  const prev = process.env.HOME;
  const prevUP = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;
  }
}

function writeRegistry(home, roots) {
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, roots, entries: [], quarantine: [] }, null, 2), 'utf8');
  return file;
}

test('setupForRun creates the worktree UNDER the declared root (layout.worktrees), and says so in the row', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const home = path.join(base, 'home');
    writeRegistry(home, [{ path: base, primary: true, layout: { worktrees: '.wt' } }]);
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-ROOT1', { isolation_mode: 'worktree', worktrees: [] });

    const setup = withHome(home, () => setupForRun(ws, 'M-ROOT1'));
    const row = setup.repos[0];
    assertEq(row.status, 'created', `worktree created: ${JSON.stringify(row)}`);
    assertEq(normalizeWorktreePath(row.worktree), normalizeWorktreePath(path.join(base, '.wt', 'M-ROOT1', 'alpha')),
      'the worktree lands at <root>/.wt/<runId>/<repo> — a literal path, not a re-derivation');
    assert(fs.existsSync(path.join(base, '.wt', 'M-ROOT1', 'alpha')), 'it is really on disk at the root-anchored path');
    assertEq(row.anchor, 'root', 'the row reports which anchor decided');
    assertEq(normalizeWorktreePath(row.root), normalizeWorktreePath(base), 'the row reports the root');
    // And pointedly NOT where the pre-T03 convention would have put it.
    assert(!fs.existsSync(path.join(repo, '..', '.forge-worktrees', 'M-ROOT1', 'alpha')),
      'nothing was created at the old sibling location');

    const cleanup = withHome(home, () => cleanupForRun(ws, 'M-ROOT1'));
    assertEq(statusesOf(cleanup), ['removed'], `git-based cleanup removes the root-anchored worktree: ${JSON.stringify(cleanup.repos)}`);
  });
});

test('setupForRun with NO registry keeps the legacy sibling anchor (and reports it)', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const home = path.join(base, 'empty-home');
    fs.mkdirSync(home, { recursive: true });
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-NOREG2', { isolation_mode: 'worktree', worktrees: [] });

    const setup = withHome(home, () => setupForRun(ws, 'M-NOREG2'));
    const row = setup.repos[0];
    assertEq(row.status, 'created', JSON.stringify(row));
    assertEq(row.anchor, 'legacy-sibling', 'absent registry -> legacy anchor');
    assertEq(normalizeWorktreePath(row.worktree), normalizeWorktreePath(oldConventionPath(repo, 'M-NOREG2')),
      'exactly where the pre-T03 convention put it');
    assert(!row.warn, 'an absent registry is not worth warning about — it is the ordinary state');
    withHome(home, () => cleanupForRun(ws, 'M-NOREG2'));
  });
});

test('setupForRun with an UNREADABLE registry falls back to the legacy anchor and reports the file', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const home = path.join(base, 'broken-home');
    const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const repo = makeRepo(base, 'alpha');
    writeRun(ws, 'M-BADREG', { isolation_mode: 'worktree', worktrees: [] });

    const setup = withHome(home, () => setupForRun(ws, 'M-BADREG'));
    const row = setup.repos[0];
    assertEq(row.status, 'created', `a corrupt registry must not block setup: ${JSON.stringify(row)}`);
    assertEq(row.anchor, 'legacy-sibling');
    assertEq(normalizeWorktreePath(row.worktree), normalizeWorktreePath(oldConventionPath(repo, 'M-BADREG')));
    assert(/forge-gate-workspaces\.json/.test(row.warn || ''),
      `the unreadable registry is named on the row — never silent: ${row.warn}`);
    withHome(home, () => cleanupForRun(ws, 'M-BADREG'));
  });
});

test('setupForRun refuses a non-hidden layout.worktrees: status error, nothing created', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const home = path.join(base, 'home');
    writeRegistry(home, [{ path: base, primary: true, layout: { worktrees: 'worktrees' } }]);
    makeRepo(base, 'alpha');
    writeRun(ws, 'M-REFUSE', { isolation_mode: 'worktree', worktrees: [] });

    const setup = withHome(home, () => setupForRun(ws, 'M-REFUSE'));
    const row = setup.repos[0];
    assertEq(row.status, 'error', `a ghost-project layout must be refused, not accepted: ${JSON.stringify(row)}`);
    assert(/forge-gate-workspaces\.json/.test(row.error || ''), `the registry file is named: ${row.error}`);
    assert(/"worktrees"/.test(row.error || ''), `the offending value is named: ${row.error}`);
    assert(!fs.existsSync(path.join(base, 'worktrees')), 'and nothing was created at the refused location');
  });
});

test('round-trip C: root-anchored setup, layout CHANGED before cleanup — git-based cleanup still finds it', () => {
  withSandbox(WORKTREE_PREFS, ({ base, ws }) => {
    const home = path.join(base, 'home');
    writeRegistry(home, [{ path: base, primary: true, layout: { worktrees: '.wt' } }]);
    makeRepo(base, 'alpha');
    writeRun(ws, 'M-RTC', { isolation_mode: 'worktree', worktrees: [] });

    const setup = withHome(home, () => setupForRun(ws, 'M-RTC'));
    const created = setup.repos[0].worktree;
    assertEq(setup.repos[0].anchor, 'root', JSON.stringify(setup.repos[0]));
    assert(fs.existsSync(created), 'root-anchored worktree exists before the flip');

    // Move the anchor under cleanup's feet. Before T01 this made cleanup look
    // at a path that never existed, find nothing, and report success.
    writeRegistry(home, [{ path: base, primary: true, layout: { worktrees: '.moved-elsewhere' } }]);
    const wouldBeDerived = path.join(base, '.moved-elsewhere', 'M-RTC', 'alpha');
    assert(normalizeWorktreePath(wouldBeDerived) !== normalizeWorktreePath(created),
      'sanity: the flipped layout derives a genuinely different path');
    assert(!fs.existsSync(wouldBeDerived), 'sanity: nothing exists there — a re-derive would find nothing');

    const cleanup = withHome(home, () => cleanupForRun(ws, 'M-RTC'));
    assertEq(statusesOf(cleanup), ['removed'], `cleanup finds it via git despite the moved anchor: ${JSON.stringify(cleanup.repos)}`);
    assert(!fs.existsSync(created), 'the real worktree is gone');
  });
});

// ── T04: D4 — the default derived from shape, FROZEN at the run's birth ─────
//
// Two properties are proven here and they pull in opposite directions, which is
// why both need pinning:
//
//   DERIVE — with no explicit `forge_isolation.mode`, a WORKSPACE (a registered
//   project containing other registered projects) defaults to `worktree`, and
//   everything else stays `shared`. Several repos and several plausible
//   concurrent runs is exactly the shape where one working tree collides.
//
//   FREEZE — a run's effective mode is decided ONCE, when the run is born, and
//   recorded in its registry record. Nothing recomputes it from the project's
//   current shape afterwards (S04-RISK blocker #3). A run that started `shared`
//   finishes `shared`, or the two modes coexist in one repo and neither cleanup
//   sees the other's artifacts.
//
// Every fixture below runs under a synthetic $HOME with its own registry; the
// operator's real ~/.claude/forge-gate-workspaces.json is never written, and is
// read only by the two explicitly read-only dogfood pins at the end.

const { resolveEffectiveMode, deriveShapeMode, resolveCleanupMode, readIsolationPrefs } = isolation;
const runsRegistry = require('./forge-runs.js');

// A directory that `classify` calls a project: a .gsd/ carrying a WORK_ENTRY.
// (`.gsd/forge/` alone is runtime, not work — it would classify as `touched`
// and never reach the `workspace` role at all.)
function makeProjectDir(dir) {
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'PROJECT.md'), '# fixture project\n', 'utf8');
  return dir;
}

function writeRegistryEntries(home, entries) {
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, roots: [], entries, quarantine: [] }, null, 2), 'utf8');
  return file;
}

/**
 * Sandbox whose SHAPE is the variable under test.
 *   opts.members  — subdirectories of the workspace that are ALSO registered
 *                   projects. One or more of them is what turns the cwd's role
 *                   from `project` into `workspace`.
 *   opts.registry — 'entries' (default) | 'absent' | 'unreadable' | 'unrelated'
 */
function withShape(prefs, opts, fn) {
  const o = opts || {};
  const sandbox = makeWorkspace(prefs);
  const home = path.join(sandbox.base, 'shape-home');
  fs.mkdirSync(home, { recursive: true });
  makeProjectDir(sandbox.ws);
  const members = (o.members || []).map(name => makeProjectDir(path.join(sandbox.ws, name)));

  const kind = o.registry || 'entries';
  if (kind === 'unreadable') {
    const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json', 'utf8');
  } else if (kind === 'unrelated') {
    const other = makeProjectDir(path.join(sandbox.base, 'elsewhere'));
    writeRegistryEntries(home, [{ path: other }, { path: makeProjectDir(path.join(other, 'child')) }]);
  } else if (kind !== 'absent') {
    writeRegistryEntries(home, [{ path: sandbox.ws }, ...members.map(m => ({ path: m }))]);
  }

  try { return withHome(home, () => fn(sandbox, home)); }
  finally { fs.rmSync(sandbox.base, { recursive: true, force: true }); }
}

// No `mode` key anywhere: this is what makes the derivation eligible at all.
const NO_MODE_PREFS = { forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'false' } };

// ── readIsolationPrefs: pref-set vs defaulted are now distinguishable ───────

test('readIsolationPrefs reports modeSource=default when no forge_isolation block exists', () => {
  withShape({ workers: { require_worktree: 'false' } }, { registry: 'absent' }, (s) => {
    const p = readIsolationPrefs(s.ws);
    assertEq(p.mode, 'shared', 'the value is unchanged from before D4');
    assertEq(p.modeSource, 'default', 'but it is now marked as NOT chosen by the operator');
  });
});

test('readIsolationPrefs reports modeSource=default for a block that omits mode', () => {
  withShape(NO_MODE_PREFS, { registry: 'absent' }, (s) => {
    assertEq(readIsolationPrefs(s.ws).modeSource, 'default', 'other knobs set, mode absent');
  });
});

test('readIsolationPrefs reports modeSource=pref for an EXPLICIT shared — the operator opt-out', () => {
  withShape({ forge_isolation: { mode: 'shared' }, workers: { require_worktree: 'false' } }, { registry: 'absent' }, (s) => {
    const p = readIsolationPrefs(s.ws);
    assertEq(p.mode, 'shared');
    assertEq(p.modeSource, 'pref', 'an explicit shared must be distinguishable from an absent one');
  });
});

test('readIsolationPrefs reports modeSource=pref for an explicit worktree, case-insensitively', () => {
  withShape({ forge_isolation: { mode: 'WORKTREE' }, workers: { require_worktree: 'false' } }, { registry: 'absent' }, (s) => {
    const p = readIsolationPrefs(s.ws);
    assertEq(p.mode, 'worktree', 'normalization is unchanged');
    assertEq(p.modeSource, 'pref');
  });
});

// ── The derivation itself ───────────────────────────────────────────────────

test('shape: a WORKSPACE (registered project containing registered projects) derives worktree', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha', 'beta'] }, (s) => {
    assertEq(deriveShapeMode(s.ws).role, 'workspace', 'the fixture really is workspace-shaped');
    const eff = resolveEffectiveMode(s.ws);
    assertEq(eff.mode, 'worktree', 'several repos + several plausible concurrent runs → isolate');
    assertEq(eff.mode_origin, 'derived-shape', 'and it says WHERE the mode came from');
    assertEq(eff.user_mode, 'shared', 'user_mode still reports the pref-level value, unchanged');
  });
});

test('shape: a STANDALONE registered project derives shared — one run at a time', () => {
  withShape(NO_MODE_PREFS, { members: [] }, (s) => {
    assertEq(deriveShapeMode(s.ws).role, 'project', 'registered, but with no registered descendant');
    const eff = resolveEffectiveMode(s.ws);
    assertEq(eff.mode, 'shared', 'a worktree here would be cost without benefit');
    assertEq(eff.mode_origin, 'default');
  });
});

test('shape: NO registry at all → shared (the ordinary state of a machine that never registered)', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'], registry: 'absent' }, (s) => {
    const shape = deriveShapeMode(s.ws);
    assertEq(shape.mode, 'shared');
    assertEq(shape.reason, 'no-registry', 'the reason is named, not guessed at');
    assertEq(resolveEffectiveMode(s.ws).mode_origin, 'default');
  });
});

test('shape: an UNREADABLE registry degrades to shared and NEVER throws (this runs at every activation)', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'], registry: 'unreadable' }, (s) => {
    const shape = deriveShapeMode(s.ws);
    assertEq(shape.mode, 'shared', 'shared is what such a machine always got');
    assertEq(shape.reason, 'registry-unreadable', 'and it is distinguishable from a plain absence');
    assertEq(resolveEffectiveMode(s.ws).mode, 'shared', 'no throw escapes into activation');
  });
});

test('shape: a cwd unrelated to every registered path derives shared', () => {
  withShape(NO_MODE_PREFS, { registry: 'unrelated' }, (s) => {
    // `workspace` is a containment claim, not a registration one: resolveRole
    // calls an unregistered project `project` because it has no registered
    // DESCENDANT. Either way there is nothing here for a run to collide with.
    assertEq(deriveShapeMode(s.ws).role, 'project', 'no registered path lies under it');
    assertEq(resolveEffectiveMode(s.ws).mode, 'shared');
  });
});

test('shape: a FOLDER (not itself a project, merely containing registered ones) derives shared', () => {
  // The real ~/Development is exactly this: a container, not a workspace. Only
  // a project that contains projects gets worktree isolation — a plain folder
  // is never the cwd a run is launched from.
  // `s.base` contains the registered ws (and its member) but has no .gsd of its
  // own, so it classifies as a container rather than a project.
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    assertEq(deriveShapeMode(s.base).role, 'folder', 'a synthesised display node, not a workspace');
    assertEq(resolveEffectiveMode(s.base).mode, 'shared');
    assertEq(resolveEffectiveMode(s.base).mode_origin, 'default');
  });
});

// ── Explicit pref always wins ───────────────────────────────────────────────

test('an EXPLICIT shared under a workspace shape wins — the operator opted out and is obeyed', () => {
  withShape({ forge_isolation: { mode: 'shared' }, workers: { require_worktree: 'false' } },
    { members: ['alpha'] }, (s) => {
      assertEq(deriveShapeMode(s.ws).mode, 'worktree', 'the shape alone WOULD have derived worktree');
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'shared', 'but an explicit pref is never overruled by a derivation');
      assertEq(eff.mode_origin, 'pref');
      assertEq(eff.shape_role, undefined, 'the derivation is not even consulted');
    });
});

test('an EXPLICIT branch under a workspace shape wins too', () => {
  withShape({ forge_isolation: { mode: 'branch' }, workers: { require_worktree: 'false' } },
    { members: ['alpha'] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'branch');
      assertEq(eff.mode_origin, 'pref');
    });
});

// ── Composition: SVN short-circuit and require_worktree elevation ───────────

test('SVN precedes the derivation: a workspace-shaped SVN checkout still resolves shared', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    fs.mkdirSync(path.join(s.ws, '.svn'), { recursive: true });   // no .git in this fixture
    const eff = resolveEffectiveMode(s.ws);
    assertEq(eff.vcs, 'svn', 'the fixture is detected as SVN');
    assertEq(eff.mode, 'shared', 'SVN has no worktree path — M017 Fase 1 runs shared');
    assert(/vcs:svn/.test(eff.elevation_reason || ''), `the degradation is named: ${eff.elevation_reason}`);
    assertEq(eff.shape_role, undefined, 'the short-circuit returned BEFORE the derivation ran');
  });
});

test('require_worktree:true elevates a DERIVED shared base exactly as it elevates a pref one', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'true' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'worktree');
      assertEq(eff.elevated, true, 'elevation composes on top of the derived base');
      assert(/shared→worktree/.test(eff.elevation_reason || ''),
        `the reason names the base it elevated FROM: ${eff.elevation_reason}`);
    });
});

test('require_worktree:true is a NO-OP on a derived worktree base — not a double elevation', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'true' } },
    { members: ['alpha'] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'worktree');
      assertEq(eff.elevated, false, 'already isolated — nothing to elevate');
      assertEq(eff.elevation_reason, null);
      assertEq(eff.mode_origin, 'derived-shape', 'the mode is still attributed to the shape');
    });
});

test('require_worktree:false forbids ELEVATION, it does not undo the DERIVED default', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    const eff = resolveEffectiveMode(s.ws);
    assertEq(eff.require_worktree, 'false');
    assertEq(eff.mode, 'worktree', 'the shape default is a base mode, not an elevation');
    assertEq(eff.elevated, false, 'and it is correctly not reported as one');
  });
});

test('require_worktree:auto still elevates a derived shared base when a write engine is configured', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto', 'execute-task': 'codex' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'worktree');
      assertEq(eff.elevated, true);
      assert(/codex/.test(eff.write_engine || ''), `the engine is named: ${eff.write_engine}`);
    });
});

test('require_worktree:auto elevates when execute-task can derive GPT from tier_models', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto' }, tier_models: { standard: 'gpt-5.6-sol' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'worktree');
      assertEq(eff.elevated, true);
      assertEq(eff.write_engine, 'tier_models.standard:gpt');
    });
});

test('explicit Claude worker cannot suppress conservative tier_models isolation', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto', 'execute-task': 'claude' }, tier_models: { standard: 'gpt-5.6-sol' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'worktree');
      assertEq(eff.elevated, true);
      assertEq(eff.write_engine, 'tier_models.standard:gpt');
    });
});

test('require_worktree:auto with no write engine leaves a derived shared base alone', () => {
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'shared');
      assertEq(eff.elevated, false);
    });
});

// ── FREEZE (S04-RISK blocker #3) ────────────────────────────────────────────

test('FREEZE: a legacy record with NO isolation_mode never sees shape derivation — started shared, finishes shared', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    // Counterfactual first: without the freeze this very fixture resolves worktree.
    assertEq(resolveEffectiveMode(s.ws).mode, 'worktree',
      'sanity: the shape genuinely derives worktree, so the assert below is not vacuous');

    writeRun(s.ws, 'M-LEGACY-REC', {});                 // pre-D4 record: no isolation_mode
    const cm = resolveCleanupMode(s.ws, 'M-LEGACY-REC');
    assertEq(cm.source, 'fallback-resolve', 'this IS the legacy path');
    assertEq(cm.mode, 'shared',
      'the run was born in the pref-only world and must be cleaned up in it');
  });
});

test('FREEZE: the registry-recorded mode beats a flipped pref (round trip through runs.add)', () => {
  withShape({ forge_isolation: { mode: 'worktree', auto_pull_main: false }, workers: { require_worktree: 'false' } },
    { members: ['alpha'] }, (s) => {
      runsRegistry.add(s.ws, {
        id: 'M-FROZEN', kind: 'milestone', session_id: 'freeze-test', isolation_mode: 'shared',
      });
      assertEq(resolveEffectiveMode(s.ws).mode, 'worktree', 'sanity: current prefs+shape say worktree');
      const cm = resolveCleanupMode(s.ws, 'M-FROZEN');
      assertEq(cm.mode, 'shared', 'the mode recorded at birth wins');
      assertEq(cm.source, 'registry');
      const full = cleanupForRun(s.ws, 'M-FROZEN');
      assertEq(full.mode, 'shared', 'and cleanupForRun runs the shared path end to end');
      assertEq(full.mode_source, 'registry');
    });
});

test('FREEZE: a run born under the DERIVED worktree default is recorded as worktree and cleans up as one', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    // This mirrors the skills exactly: ISOLATION_MODE is read from the setup
    // result's `mode` (forge-auto/SKILL.md:167) and handed to
    // `forge-runs --add --isolation-mode` (:196). No skill change is needed for
    // a derived mode to be frozen — it flows through the same field.
    const bornMode = resolveEffectiveMode(s.ws).mode;
    assertEq(bornMode, 'worktree', 'the run is born worktree by derivation');
    runsRegistry.add(s.ws, { id: 'M-BORN', kind: 'milestone', session_id: 'freeze-test', isolation_mode: bornMode });

    // Now flip the world under it: an explicit shared pref would, for a NEW run,
    // win over the shape. The already-born run must not notice.
    fs.writeFileSync(path.join(s.ws, '.gsd', 'forge-prefs.jsonc'),
      JSON.stringify({ forge_isolation: { mode: 'shared' }, workers: { require_worktree: 'false' } }), 'utf8');
    const cm = resolveCleanupMode(s.ws, 'M-BORN');
    assertEq(cm.mode, 'worktree', 'the frozen mode survives a pref flip in both directions');
    assertEq(cm.source, 'registry');
  });
});

test('FREEZE: resolveCleanupMode is the ONLY caller that touches the derivation opt-out, and it says why', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-isolation.js'), 'utf8');
  const body = src.slice(src.indexOf('function resolveCleanupMode'), src.indexOf('function cleanupForRun'));
  assert(/resolveEffectiveMode\(cwd,\s*\{\s*shapeDefault:\s*rec === null\s*\}\)/.test(body),
    'the legacy fallback opts out of shape derivation only for a genuine legacy record, not a null one (R1)');
  assert(/FREEZE/.test(body), 'and the reason is written where the next reader will be tempted to remove it');
  const others = [...src.matchAll(/shapeDefault:\s*[^,\s]/g)];
  assertEq(others.length, 1, 'exactly one call site passes an explicit shapeDefault option in the whole module');
  assert(/const eff = resolveEffectiveMode\(cwd\);/.test(src.slice(src.indexOf('function setupForRun'))),
    'setup — where a run is BORN — still resolves with the derivation enabled');
});

// ── R1 (M-20260802185210 S04 review): rec===null must not leak a worktree ──

test('R1: counterfactual — the pre-fix shapeDefault:false WOULD resolve a null record as shared (proves the bite)', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    assertEq(resolveEffectiveMode(s.ws).mode, 'worktree',
      'sanity: the shape genuinely derives worktree, so the assert below is not vacuous');
    // No run record written at all — mirrors --setup --run <id> with no --add,
    // or a crash window between setup and registration.
    const preFix = resolveEffectiveMode(s.ws, { shapeDefault: false });
    assertEq(preFix.mode, 'shared',
      'counterfactual: the old unconditional shapeDefault:false silently resolved a record-less run to shared, ' +
      'which is exactly how a workspace-shaped worktree leaked with no not-found row');
  });
});

test('R1: a run-record-less cleanup (rec===null) resolves worktree, mirroring what setup provisioned at birth', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    assertEq(resolveEffectiveMode(s.ws).mode, 'worktree', 'sanity: shape derives worktree');
    // No writeRun call — runs.get(cwd, id) returns null.
    const cm = resolveCleanupMode(s.ws, 'M-NEVER-REGISTERED');
    assertEq(cm.source, 'fallback-resolve');
    assertEq(cm.mode, 'worktree',
      'cleanup must see the same mode setup provisioned, or the worktree it created is never discovered/removed');
  });
});

test('R1: a genuine legacy record (isolation_mode absent, rec present) still resolves shared, unaffected by the null-record fix', () => {
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    assertEq(resolveEffectiveMode(s.ws).mode, 'worktree', 'sanity: shape derives worktree');
    writeRun(s.ws, 'M-LEGACY-REC-2', {});   // pre-D4 record: no isolation_mode
    const cm = resolveCleanupMode(s.ws, 'M-LEGACY-REC-2');
    assertEq(cm.source, 'fallback-resolve');
    assertEq(cm.mode, 'shared',
      'a genuine legacy record must still freeze to the pref-only world, not the current shape');
  });
});

// ── Dogfood pin: this repo is standalone, and its explicit pref is untouched ─

test('dogfood: forge-agent itself is shape-standalone → derives shared (read-only against the real registry)', () => {
  const repoRoot = path.join(__dirname, '..');
  const shape = deriveShapeMode(repoRoot);
  assertEq(shape.mode, 'shared',
    `forge-agent is one project, not a workspace — D4 must not move this repo to worktree (role: ${shape.role})`);
  assert(shape.role !== 'workspace', `role must not be workspace, got ${shape.role}`);
});

// The SUBJECT here is synthetic on purpose, and that is the whole fix.
//
// resolveRole() asks classify(), which decides `project` by reading .gsd/ off the
// disk. This repo's .gsd/ is gitignored (see the dogfood block in .gitignore), so
// it exists for anyone who runs forge here and never exists in a fresh checkout.
// Aiming this assertion at repoRoot therefore derived `project` on an operator's
// machine and `null` on CI — a test named "independent of the operator machine"
// that depended on it, red on every commit while green for every author.
//
// What is actually under test is the registry rule — one entry, no registered
// descendant → project → shared — so the subject only has to be a real project,
// not this one.
test('a synthetic registry listing ONLY one project derives project/shared, independent of the operator machine', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolation-solo-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const project = makeProjectDir(path.join(base, 'solo'));
  writeRegistryEntries(home, [{ path: project }]);
  try {
    withHome(home, () => {
      const shape = deriveShapeMode(project);
      assertEq(shape.role, 'project', 'registered, with no registered descendant');
      assertEq(shape.mode, 'shared');
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('dogfood: a synthetic registry listing ONLY this repo never promotes it to workspace', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolation-dogfood-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repoRoot = path.resolve(path.join(__dirname, '..'));
  if (!fs.existsSync(path.join(repoRoot, '.gsd', 'PROJECT.md'))) {
    console.log('  (skip: isolated worktree has no project marker; marker classification is covered by synthetic fixtures)');
    fs.rmSync(base, { recursive: true, force: true });
    return;
  }
  writeRegistryEntries(home, [{ path: repoRoot }]);
  try {
    withHome(home, () => {
      const shape = deriveShapeMode(repoRoot);
      // True on both shapes of checkout: with .gsd/ present the role is `project`,
      // without it classify() says `none` and the role is null. Neither may become
      // `workspace` — that is the one role that flips the mode to worktree, which
      // is what this pin exists to prevent.
      assert(shape.role !== 'workspace', `role must not be workspace, got ${shape.role}`);
      assertEq(shape.mode, 'shared');
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ── S06/T01: unmet_requirement — the SVN short-circuit names what it refused ─

const { UNMET_ASK_REASONS } = isolation;

// Tracks which UNMET_ASK_REASONS members were actually emitted across this
// block, so the closed-set cross-reference at the end is not vacuous.
const reachedUnmetReasons = new Set();

function withSvn(prefs, opts, fn) {
  return withShape(prefs, opts, (s) => {
    fs.mkdirSync(path.join(s.ws, '.svn'), { recursive: true });
    return fn(s);
  });
}

test('unmet_requirement: require_worktree:true in SVN names requirement/asked_by/blocked_by', () => {
  withSvn({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'true' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.vcs, 'svn');
      assert(eff.unmet_requirement, 'unmet_requirement must be present');
      assertEq(eff.unmet_requirement.requirement, 'worktree');
      assert(eff.unmet_requirement.asked_by.includes('require_worktree:true'),
        `asked_by must include require_worktree:true, got ${JSON.stringify(eff.unmet_requirement.asked_by)}`);
      assertEq(eff.unmet_requirement.blocked_by, 'vcs:svn');
      reachedUnmetReasons.add('require_worktree:true');
    });
});

test('unmet_requirement: an explicit worktree pref + require_worktree:false is STILL emitted (pref:worktree)', () => {
  withSvn({ forge_isolation: { mode: 'worktree', auto_pull_main: false }, workers: { require_worktree: 'false' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assert(eff.unmet_requirement, 'false forbids elevation, it does not undo an explicit pref request');
      assert(eff.unmet_requirement.asked_by.includes('pref:worktree'),
        `asked_by must include pref:worktree, got ${JSON.stringify(eff.unmet_requirement.asked_by)}`);
      reachedUnmetReasons.add('pref:worktree');
    });
});

test('unmet_requirement: require_worktree:auto + an external write engine names asked_by AND write_engine (the protected-wc case)', () => {
  withSvn({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto', 'execute-task': 'codex' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assert(eff.unmet_requirement, 'unmet_requirement must be present');
      assert(eff.unmet_requirement.asked_by.includes('require_worktree:auto'),
        `asked_by must include require_worktree:auto, got ${JSON.stringify(eff.unmet_requirement.asked_by)}`);
      assert(/codex/.test(eff.unmet_requirement.write_engine || ''),
        `write_engine must name the detected engine: ${eff.unmet_requirement.write_engine}`);
      reachedUnmetReasons.add('require_worktree:auto');
    });
});

test('unmet_requirement: require_worktree:false with no worktree pref is ABSENT — nothing was asked (with positive control)', () => {
  withSvn({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'false' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assert(!('unmet_requirement' in eff), `unmet_requirement must be ABSENT, got ${JSON.stringify(eff.unmet_requirement)}`);
    });
  // Positive control: the SAME fixture shape, with require_worktree:true, DOES
  // produce the field — proving the assert above is not vacuously passing.
  withSvn({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'true' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assert(eff.unmet_requirement, 'positive control: the same fixture WITH require_worktree:true must emit the field');
    });
});

test('unmet_requirement: forge_isolation.mode: branch in SVN is ABSENT — branch is not physical filesystem isolation (D8)', () => {
  withSvn({ forge_isolation: { mode: 'branch', auto_pull_main: false }, workers: { require_worktree: 'false' } },
    { members: [] }, (s) => {
      const eff = resolveEffectiveMode(s.ws);
      assertEq(eff.mode, 'shared', 'SVN still short-circuits to shared regardless of a branch pref');
      assert(!('unmet_requirement' in eff),
        `branch is not physical isolation (D8) — unmet_requirement must be ABSENT, got ${JSON.stringify(eff.unmet_requirement)}`);
    });
});

// ── Additive purity: in git, the key SET is byte-identical to before T01 ────

const FROZEN_GIT_KEYS = [
  'mode', 'user_mode', 'mode_origin', 'require_worktree', 'elevated', 'elevation_reason',
  'write_engine', 'vcs',
].sort();

function assertKeySetEq(obj, expectedKeys, msg) {
  const actual = Object.keys(obj).filter(k => k !== 'shape_role' && k !== 'shape_reason').sort();
  const expected = [...expectedKeys].sort();
  assertEq(JSON.stringify(actual), JSON.stringify(expected), msg || 'key set must match exactly, both directions');
}

test('unmet_requirement: in git (derived worktree, shared, elevated true, elevated auto), the key SET is frozen — no new key leaks outside SVN', () => {
  // derived worktree
  withShape(NO_MODE_PREFS, { members: ['alpha'] }, (s) => {
    assertKeySetEq(resolveEffectiveMode(s.ws), FROZEN_GIT_KEYS, 'derived-worktree case');
  });
  // shared (no shape, no elevation)
  withShape(NO_MODE_PREFS, { members: [] }, (s) => {
    assertKeySetEq(resolveEffectiveMode(s.ws), FROZEN_GIT_KEYS, 'shared case');
  });
  // elevated by require_worktree:true
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'true' } },
    { members: [] }, (s) => {
      assertKeySetEq(resolveEffectiveMode(s.ws), FROZEN_GIT_KEYS, 'require_worktree:true elevation case');
    });
  // elevated by auto + engine
  withShape({ forge_isolation: { auto_pull_main: false }, workers: { require_worktree: 'auto', 'execute-task': 'codex' } },
    { members: [] }, (s) => {
      assertKeySetEq(resolveEffectiveMode(s.ws), FROZEN_GIT_KEYS, 'require_worktree:auto+engine elevation case');
    });
});

// ── UNMET_ASK_REASONS: closed set, cross-referenced both ways ───────────────

test('UNMET_ASK_REASONS: every asked_by emitted above belongs to the closed set', () => {
  for (const reason of reachedUnmetReasons) {
    assert(UNMET_ASK_REASONS.includes(reason), `${reason} must be a member of UNMET_ASK_REASONS`);
  }
});

test('UNMET_ASK_REASONS: every member of the closed set was reached by at least one test case above', () => {
  for (const member of UNMET_ASK_REASONS) {
    assert(reachedUnmetReasons.has(member), `${member} must be reached by at least one test case`);
  }
});

test('UNMET_ASK_REASONS: is frozen (Object.freeze)', () => {
  assert(Object.isFrozen(UNMET_ASK_REASONS), 'UNMET_ASK_REASONS must be frozen');
});

// ── F2 — realpathCanonical: one canonicalizer, 8.3-aware, symlink-aware ─────
//
// Windows CI measured: os.tmpdir() spells C:\Users\RUNNER~1\... (8.3 short
// form) while git prints C:\Users\runneradmin\... . fs.realpathSync resolves
// symlinks but does NOT expand 8.3; fs.realpathSync.native does. A helper that
// regresses to plain realpathSync re-splits one repo into two identities.
// Third occurrence of "lexical comparison where only real-vs-real is truth"
// in this repo (memory-index containment, sweep vault PR #100, now this).

test('F2: source guard — plain fs.realpathSync( survives ONLY inside realpathCanonical, and both consumers route through it', () => {
  const isoSrc   = fs.readFileSync(path.join(__dirname, 'forge-isolation.js'), 'utf8');
  const touchSrc = fs.readFileSync(path.join(__dirname, 'forge-touch.js'), 'utf8');

  // `fs.realpathSync(` (with the open paren) never matches the `.native(`
  // spelling. Positive control first, so a blind miner cannot go green.
  const PLAIN = /fs\.realpathSync\(/g;
  assert('try { return fs.realpathSync(x); }'.match(PLAIN).length === 1,
    'positive control: the plain-call pattern must match a synthetic plain call');
  assert('fs.realpathSync.native(x)'.match(PLAIN) === null,
    'positive control: the plain-call pattern must NOT match the .native spelling');

  // Exactly one plain call in forge-isolation.js: the middle rung of the
  // ladder inside realpathCanonical (native → plain → path.resolve).
  const isoPlain = isoSrc.match(PLAIN) || [];
  assertEq(isoPlain.length, 1,
    'forge-isolation.js: exactly ONE plain fs.realpathSync( call (the fallback rung inside realpathCanonical) — ' +
    'a second one means a caller regressed to the 8.3-blind form');
  const helperBody = isoSrc.slice(isoSrc.indexOf('function realpathCanonical'));
  const helperHead = helperBody.slice(0, helperBody.indexOf('\n}'));
  assert(/fs\.realpathSync\.native\(/.test(helperHead),
    'realpathCanonical must keep fs.realpathSync.native as its first rung — removing it reintroduces the 8.3 split');
  assert(/fs\.realpathSync\(/.test(helperHead),
    'realpathCanonical must keep the plain fs.realpathSync fallback rung (.native can fail on network drives)');

  // forge-touch.js: zero private realpath calls; repoIdentity delegates.
  assertEq((touchSrc.match(PLAIN) || []).length, 0,
    'forge-touch.js must have NO private fs.realpathSync( call — repoIdentity regressed to its own copy');
  assert(/realpathCanonical\(/.test(touchSrc),
    'forge-touch.js must call the shared realpathCanonical (repoIdentity)');
  const normBody = isoSrc.slice(isoSrc.indexOf('function normalizeWorktreePath'));
  assert(/realpathCanonical\(/.test(normBody.slice(0, normBody.indexOf('\n}'))),
    'normalizeWorktreePath must delegate to realpathCanonical, not carry its own resolution');
});

test('F2: symlink rung — realpathCanonical converges link and target (bites a regression to lexical path.resolve)', () => {
  if (process.platform === 'win32') {
    console.log('  (skip: symlink creation needs elevation/dev-mode on Windows — the symlink rung is proven on POSIX; the Windows-only 8.3 rung has its own test below)');
    return;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-canon-link-'));
  try {
    const real = path.join(base, 'real-dir');
    fs.mkdirSync(real);
    const link = path.join(base, 'link-dir');
    fs.symlinkSync(real, link);
    assertEq(realpathCanonical(link), realpathCanonical(real),
      'link and target must canonicalize to one spelling');
    // Non-vacuous: a resolver regressed to lexical path.resolve would keep
    // the two spellings apart, so the equality above genuinely bites.
    assert(path.resolve(link) !== realpathCanonical(link),
      'sanity: the link spelling must differ from the canonical one, or the equality above is vacuous');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('F2: Windows 8.3 rung — short (RUNNER~1-style) and long spellings converge; plain realpathSync would not', () => {
  if (process.platform !== 'win32') {
    console.log('  (skip: 8.3 short names exist only on Windows/NTFS — this exact effect cannot be reproduced on POSIX; the shared-helper source guard above bites on every platform)');
    return;
  }
  // The 8.3 alias comes from the OS, not from parsing a shell.
  //
  // Three CI rounds were spent trying to read `%~sI` out of cmd.exe and each one
  // came back in a different shape — `"c:\...\"`, then `\"c:\...\"` (escaped
  // quote), then nothing the extractor could find, which fed the helper an empty
  // string and compared the CWD against the fixture. The measured environment
  // makes all of that unnecessary: the runner's own `os.tmpdir()` IS
  // `C:\Users\RUNNER~1\AppData\Local\Temp` — the short spelling is already in
  // hand, and `.native` supplies the long one. That is also the exact real-world
  // shape of the bug (tmpdir short, git's answer long), so the fixture now
  // reproduces the incident instead of simulating it.
  // No fixture directory is created, so there is nothing to clean up — and the
  // absence of a `finally` here is deliberate: the previous version removed the
  // temp tree it had made, and keeping that block while the paths became
  // `os.tmpdir()` would have pointed a recursive delete at the system temp dir.
  const shortDir = os.tmpdir();
  const longDir = fs.realpathSync.native(shortDir);
  {
    if (shortDir.toLowerCase() === longDir.toLowerCase()) {
      console.log('  (skip: this runner\'s tmpdir carries no 8.3 component (fsutil 8dot3name may be disabled) — no short alias exists to compare)');
      return;
    }
    assertEq(realpathCanonical(shortDir).toLowerCase(), realpathCanonical(longDir).toLowerCase(),
      'the 8.3 alias and the long name are ONE directory and must get ONE canonical spelling');
    assertEq(normalizeWorktreePath(shortDir).toLowerCase(), normalizeWorktreePath(longDir).toLowerCase(),
      'normalizeWorktreePath must inherit the 8.3 expansion — this is the exact comparison worktree matching does');
    // The bite, stated as a measured fact: plain realpathSync leaves the 8.3
    // component alone, so a helper regressed to it returns a DIFFERENT string
    // for shortDir and the equality above goes red. If Node ever changes
    // plain realpathSync to expand 8.3, this sanity assert fails loudly and
    // the guard should be re-evaluated — never silently weakened.
    assert(fs.realpathSync(shortDir).toLowerCase() !== fs.realpathSync.native(shortDir).toLowerCase(),
      'sanity (non-vacuous): plain fs.realpathSync must still differ from .native on the 8.3 alias — otherwise this test no longer distinguishes the regression');
  }
});

// ── F7 — gitDefaultBranch: no shell, no /dev/null, same fallback semantics ──
//
// The old `2>/dev/null` inside a shell:true string made cmd.exe fail the
// symbolic-ref call itself (literal invalid path), so on Windows origin/HEAD
// was ALWAYS ignored and the silent main/master fallback answered — the same
// family as the "worktree born 13 commits behind" default-branch bug.

test('F7: origin/HEAD set to a non-main branch is honored (on Windows the old redirect form always fell back)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-defbranch-'));
  try {
    const bare = path.join(base, 'origin-trunk.git');
    spawnSync('git', ['init', '--bare', '-b', 'trunk', bare], { encoding: 'utf8' });
    const repo = path.join(base, 'clone');
    git(['clone', '--quiet', bare, repo], base);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-qm', 'init'], repo);
    git(['push', '-q', '-u', 'origin', 'trunk'], repo);
    git(['remote', 'set-head', 'origin', 'trunk'], repo);
    // No 'main'/'master' branch exists here on purpose: under the pre-fix
    // Windows behavior (symbolic-ref call fails at the shell) the ladder
    // returns 'main' — which is a branch this repo does not even have.
    assertEq(gitDefaultBranch(repo), 'trunk',
      'origin/HEAD is set and readable — the fallback must not answer');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('F7: failure semantics preserved — no origin/HEAD falls back to local main/master, garbage cwd falls back to main, never throws', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-defbranch-fb-'));
  try {
    // Local-only repo on master, no origin remote: symbolic-ref fails → the
    // rev-parse ladder must answer 'master', exactly as before the fix.
    const repo = path.join(base, 'local-master');
    spawnSync('git', ['init', '-q', '-b', 'master', repo], { encoding: 'utf8' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-qm', 'init'], repo);
    assertEq(gitDefaultBranch(repo), 'master', 'no origin → local branch ladder answers');
    // A cwd that is not a repo at all: every rung fails → 'main', no throw.
    assertEq(gitDefaultBranch(path.join(base, 'does-not-exist')), 'main',
      'total failure degrades to the historical default, never an exception');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('F7: source guard — no exec call carries a POSIX /dev/null redirect, and symbolic-ref goes through execFileSync', () => {
  const isoSrc = fs.readFileSync(path.join(__dirname, 'forge-isolation.js'), 'utf8');
  const REDIRECT_CALL = /exec(?:File)?Sync\([^\n]*2>\/dev\/null/;
  assert(REDIRECT_CALL.test("execSync('git foo 2>/dev/null', { shell: true })"),
    'positive control: the miner must match a synthetic redirect-in-exec line');
  assert(!REDIRECT_CALL.test(isoSrc),
    'forge-isolation.js must not pass `2>/dev/null` to any exec call — cmd.exe reads it as a literal path and the call itself fails');
  assert(/execFileSync\('git',\s*\['symbolic-ref'/.test(isoSrc),
    'gitDefaultBranch must query origin/HEAD via execFileSync argv (no shell), or Windows regresses to permanent fallback');
});

// ── F4 — --migrate backup fsync: 'r+' fd, byte-compare stays ────────────────
//
// Windows CI measured: fsync maps to FlushFileBuffers, which needs WRITE
// access on the handle — fsync over an fd opened 'r' fails with EPERM and
// killed the migrate after the backup copy. POSIX accepts both modes, so the
// behavioral case below cannot go red here pre-fix; the source guard is the
// cross-platform bite, and this comment is the declaration of that limit.

test('F4: --migrate on a legacy registry exits 0, writes a byte-identical .bak, and lands a versioned file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-fsync-'));
  try {
    const home = path.join(base, 'home');
    const proj = path.join(home, 'Projects', 'proj-a');
    fs.mkdirSync(proj, { recursive: true });
    const regFile = path.join(base, 'registry.json');
    const legacy = JSON.stringify([proj]) + '\n';
    fs.writeFileSync(regFile, legacy, 'utf8');

    const res = spawnSync(process.execPath,
      [path.join(__dirname, 'forge-workspace.js'), '--migrate', '--home', home, '--file', regFile],
      { encoding: 'utf8' });
    // Pre-fix on Windows this is where EPERM surfaced (fsync on a read-only
    // fd), after the .bak was already copied — a half-done migrate.
    assertEq(res.status, 0, `--migrate must exit 0 (stderr: ${(res.stderr || '').trim()})`);
    const bak = regFile + '.bak';
    assert(fs.existsSync(bak), '.bak must exist');
    assert(fs.readFileSync(bak).equals(Buffer.from(legacy, 'utf8')),
      '.bak must be byte-identical to the legacy original');
    const migrated = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    assert(Number.isInteger(migrated.version) && migrated.version >= 1,
      'the registry file must now carry a released schema version');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("F4: source guard — the backup fd opens 'r+' (fsync needs write access on Windows) and the byte-compare proof stays", () => {
  const wsSrc = fs.readFileSync(path.join(__dirname, 'forge-workspace.js'), 'utf8');
  assert(wsSrc.includes("fs.openSync(bak, 'r+')"),
    "the .bak fsync fd must open 'r+' — FlushFileBuffers rejects a read-only handle with EPERM on Windows");
  assert(!wsSrc.includes("fs.openSync(bak, 'r')"),
    "a plain 'r' open of the .bak fd is the measured Windows EPERM regression");
  assert(/readFileSync\(bak\)\.equals\(original\)/.test(wsSrc),
    'the byte-compare of .bak against the original is the real proof the backup landed — the fsync is not a substitute and the compare must never be removed');
});

// ── Summary ─────────────────────────────────────────────────────────────────
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
