#!/usr/bin/env node
// forge-isolation — Setup/cleanup for branch + worktree isolation modes
//
// For each git repo in the workspace:
//   branch mode   : git checkout main && git pull && git checkout -b forge/{runId} (idempotent)
//   worktree mode : git worktree add {root}/{runId}/{repo} -b forge/{runId}
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
      const block = raw.match(/^forge_isolation:[ \t]*\n([\s\S]*?)(?=^\w|\Z)/m);
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
      try {
        execSync(`git checkout ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        execSync(`git pull --ff-only`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      } catch (e) {
        result.warn = `pull main failed: ${e.message.split('\n')[0]}`;
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
      try { execSync(`git pull --ff-only`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' }); } catch {}
      // Worktree from default branch
      execSync(`git worktree add "${wtPath}" -b ${branchName} ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
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
};
