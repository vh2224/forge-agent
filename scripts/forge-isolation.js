#!/usr/bin/env node
// forge-isolation — Setup/cleanup for branch + worktree isolation modes
//
// For each git repo in the workspace:
//   branch mode   : git fetch origin <def> && git checkout <def> && git merge --ff-only origin/<def> && git checkout -b forge/{runId} (idempotent)
//   worktree mode : git fetch origin <def> && git worktree add {root}/{runId}/{repo} -b forge/{runId} origin/<def>
//
// Branching in git NEVER talks to the server — `git worktree add ... <def>` /
// `git checkout -b` start from the LOCAL ref, which may be many commits behind
// origin if nobody ran `git pull` on it. So we fetch origin/<def> first (updates
// the remote-tracking cache without touching any working tree) and branch from
// `origin/<def>`, deterministically, regardless of which branch the main checkout
// currently sits on. Falls back to the local ref when there is no origin remote.
//
// Library exports:
//   setupForRun(cwd, runId, opts) → { mode, repos: [{path, branch?, worktree?, status, error?}] }
//   cleanupForRun(cwd, runId, opts) → similar shape
//   readIsolationPrefs(cwd) → { mode, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete }
//
// CLI:
//   node forge-isolation.js --setup --run M065 [--cwd <path>]
//   node forge-isolation.js --cleanup --run M065 [--cwd <path>]

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const repos = require('./forge-repos.js');

function readIsolationPrefs(cwd) {
  const os = require('os');
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];
  let mode = 'shared';
  let branchPattern = 'forge/{M###}';
  let autoPullMain = true;
  let worktreeRoot = '.forge-worktrees';
  let worktreeCleanupOnComplete = false;
  let prOnComplete = false;

  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      // Capture only the indented body of the block (plus blank lines). The previous
      // pattern used `\Z`, which JS treats as a literal "Z" — blocks at end-of-file
      // were silently ignored, so prefs like `mode: worktree` never took effect.
      const block = raw.match(/^forge_isolation:[ \t]*\n((?:[ \t]+[^\n]*(?:\n|$)|[ \t]*\n)*)/m);
      if (!block) continue;
      const modeM = block[1].match(/mode:[ \t]*(\w+)/);                                if (modeM) mode = modeM[1].toLowerCase();
      const patM  = block[1].match(/branch_pattern:[ \t]*["']?([^"'\n]+)["']?/);       if (patM)  branchPattern = patM[1].trim();
      const pullM = block[1].match(/auto_pull_main:[ \t]*(\w+)/);                       if (pullM) autoPullMain = pullM[1].toLowerCase() === 'true';
      const wtrM  = block[1].match(/worktree_root:[ \t]*["']?([^"'\n]+)["']?/);        if (wtrM)  worktreeRoot = wtrM[1].trim();
      const wcM   = block[1].match(/worktree_cleanup_on_complete:[ \t]*(\w+)/);         if (wcM)   worktreeCleanupOnComplete = wcM[1].toLowerCase() === 'true';
      const prM   = block[1].match(/pr_on_complete:[ \t]*(\w+)/);                       if (prM)   prOnComplete = prM[1].toLowerCase() === 'true';
    } catch {}
  }
  return { mode, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, prOnComplete };
}

function resolveBranchName(pattern, runId) {
  return pattern.replace(/\{M###\}/gi, runId).replace(/\{id\}/gi, runId);
}

function gitDefaultBranch(repoPath) {
  // Try origin/HEAD first; fall back to "main" then "master"
  try {
    const out = execSync('git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null', { cwd: repoPath, encoding: 'utf8', shell: true }).trim();
    return out.replace(/^origin\//, '') || 'main';
  } catch {}
  for (const b of ['main', 'master']) {
    try { execSync(`git rev-parse --verify ${b}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' }); return b; } catch {}
  }
  return 'main';
}

function gitCurrentBranch(repoPath) {
  try { return execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf8', shell: true }).trim(); }
  catch { return null; }
}

function gitHasOriginRemote(repoPath) {
  try {
    execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Fetch <def> from origin so worktrees/branches start from the freshest remote
// state, not a stale local ref. `git fetch` updates the `origin/<def>` cache
// without touching any working tree and does not depend on which branch the
// checkout currently sits on. Returns the ref to branch from:
//   { ref: 'origin/<def>', fetched: true }   when the fetch + verify succeeded
//   { ref: '<def>',        fetched: false }   no origin remote, or fetch failed
function fetchDefaultBranch(repoPath, def) {
  if (!gitHasOriginRemote(repoPath)) return { ref: def, fetched: false };
  try {
    execSync(`git fetch origin ${def} --quiet`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    // Confirm the remote-tracking ref resolves before we rely on it as a base.
    execSync(`git rev-parse --verify origin/${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return { ref: `origin/${def}`, fetched: true };
  } catch (e) {
    return { ref: def, fetched: false, warn: `fetch origin ${def} failed: ${e.message.split('\n')[0]}` };
  }
}

function branchExists(repoPath, branch) {
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── Branch mode ─────────────────────────────────────────────────────────────
function setupBranchOne(repoPath, branchName, autoPullMain) {
  const result = { path: repoPath, branch: branchName, status: 'pending' };
  try {
    const currentBranch = gitCurrentBranch(repoPath);
    if (currentBranch === branchName) {
      result.status = 'already-on-branch';
      return result;
    }

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      const base = fetchDefaultBranch(repoPath, def);
      if (base.warn) result.warn = base.warn;
      try {
        execSync(`git checkout ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        if (base.fetched) {
          // Fast-forward the local default to the freshly-fetched origin tip.
          execSync(`git merge --ff-only origin/${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        } else {
          execSync(`git pull --ff-only`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        }
      } catch (e) {
        result.warn = `update ${def} failed: ${e.message.split('\n')[0]}`;
      }
    }

    if (branchExists(repoPath, branchName)) {
      execSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'checked-out-existing';
    } else {
      execSync(`git checkout -b ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'created';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

function cleanupBranchOne(repoPath, branchName) {
  // Do NOT auto-delete the branch — operator may want to PR. Just checkout main.
  const result = { path: repoPath, branch: branchName, status: 'pending' };
  try {
    const def = gitDefaultBranch(repoPath);
    const current = gitCurrentBranch(repoPath);
    if (current === branchName) {
      execSync(`git checkout ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'checked-out-default';
    } else {
      result.status = 'already-off-branch';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

// ── Worktree mode ───────────────────────────────────────────────────────────
function setupWorktreeOne(repoPath, branchName, worktreeRoot, runId, autoPullMain) {
  const result = { path: repoPath, branch: branchName, worktree: null, status: 'pending' };
  try {
    const repoName = path.basename(repoPath);
    const wtPath = path.isAbsolute(worktreeRoot)
      ? path.join(worktreeRoot, runId, repoName)
      : path.join(repoPath, '..', worktreeRoot, runId, repoName);
    result.worktree = wtPath;

    // Already exists?
    if (fs.existsSync(wtPath)) {
      result.status = 'already-exists';
      return result;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      // Fetch first, then branch the worktree from origin/<def> (fresh remote
      // cache) — NOT the local <def>, which is never updated by branching and is
      // commonly stale. Falls back to local <def> when there is no origin.
      const base = fetchDefaultBranch(repoPath, def);
      if (base.warn) result.warn = base.warn;
      result.base = base.ref;
      execSync(`git worktree add "${wtPath}" -b ${branchName} ${base.ref}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    } else {
      execSync(`git worktree add "${wtPath}" -b ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    }
    result.status = 'created';
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

function cleanupWorktreeOne(repoPath, worktreePath) {
  const result = { path: repoPath, worktree: worktreePath, status: 'pending' };
  try {
    if (!fs.existsSync(worktreePath)) {
      result.status = 'not-found';
      return result;
    }
    // Uncommitted work (modified or untracked) is unrecoverable after removal —
    // commits on the forge/{id} branch survive, the working tree does not.
    // worktree_cleanup_on_complete only authorizes removal of a CLEAN worktree.
    const dirty = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf8', shell: true, stdio: 'pipe' }).trim();
    if (dirty) {
      result.status = 'skipped (dirty)';
      result.reason = 'uncommitted changes in worktree — commit on the forge branch (or discard) before cleanup; nothing was removed';
      return result;
    }
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    result.status = 'removed';
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

// ── Public top-level ────────────────────────────────────────────────────────
function setupForRun(cwd, runId, opts) {
  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const result = { mode: prefs.mode, repos: [] };

  if (prefs.mode === 'shared') return result;  // no-op

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  for (const r of repoList) {
    if (prefs.mode === 'branch') {
      result.repos.push(setupBranchOne(r, branchName, prefs.autoPullMain));
    } else if (prefs.mode === 'worktree') {
      result.repos.push(setupWorktreeOne(r, branchName, prefs.worktreeRoot, runId, prefs.autoPullMain));
    }
  }
  return result;
}

function cleanupForRun(cwd, runId, opts) {
  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const result = { mode: prefs.mode, repos: [] };

  if (prefs.mode === 'shared') return result;

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  for (const r of repoList) {
    if (prefs.mode === 'branch') {
      result.repos.push(cleanupBranchOne(r, branchName));
    } else if (prefs.mode === 'worktree') {
      if (!prefs.worktreeCleanupOnComplete) {
        result.repos.push({ path: r, status: 'skipped (worktree_cleanup_on_complete=false)' });
        continue;
      }
      const repoName = path.basename(r);
      const wtPath = path.isAbsolute(prefs.worktreeRoot)
        ? path.join(prefs.worktreeRoot, runId, repoName)
        : path.join(r, '..', prefs.worktreeRoot, runId, repoName);
      result.repos.push(cleanupWorktreeOne(r, wtPath));
    }
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
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

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help || (!args.setup && !args.cleanup && !args.prefs)) {
    process.stdout.write(`forge-isolation — setup/cleanup branch + worktree modes

Flags:
  --setup --run <id>     setup branch or worktree per repo (idempotent)
  --cleanup --run <id>   cleanup (checkout main / remove worktree)
  --prefs                print resolved prefs
  --cwd <path>           override working directory

Reads prefs from forge_isolation: block (cascade user → repo → local).
`);
    return;
  }

  try {
    if (args.prefs) {
      process.stdout.write(JSON.stringify(readIsolationPrefs(cwd), null, 2) + '\n');
    } else if (args.setup) {
      const r = setupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.cleanup) {
      const r = cleanupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    }
  } catch (e) {
    process.stderr.write(`forge-isolation error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  setupForRun, cleanupForRun, readIsolationPrefs,
  resolveBranchName, gitDefaultBranch, gitCurrentBranch,
  gitHasOriginRemote, fetchDefaultBranch,
};
