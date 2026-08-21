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
//   readIsolationPrefs(cwd) → { mode, modeSource, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, worktreeInstallDeps }
//
// CLI:
//   node forge-isolation.js --setup --run M065 [--cwd <path>]
//   node forge-isolation.js --cleanup --run M065 [--cwd <path>]
//   node forge-isolation.js --attach M065 --run T123 [--cwd <path>]

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync, spawnSync, execFileSync } = require('child_process');
const { readPrefsCached } = require('./forge-prefs.js');
const { detectVcs } = require('./forge-vcs.js');
const ws = require('./forge-workspace.js');

const repos = require('./forge-repos.js');
const runs = require('./forge-runs.js');

const WORKTREE_INSTALL_TIMEOUT_MS = 600000;

function readIsolationPrefs(cwd) {
  let mode = 'shared';
  let branchPattern = 'forge/{M###}';
  let autoPullMain = true;
  let worktreeRoot = '.forge-worktrees';
  let worktreeCleanupOnComplete = false;
  let worktreeInstallDeps = true;
  let prOnComplete = false;

  // `modeSource` distinguishes an EXPLICIT `shared` from the absence of any
  // mode pref. Both yield the string 'shared', but only the second may be
  // replaced by the shape-derived default (D4): an operator who wrote
  // `mode: shared` under a workspace has opted out, and a derivation that
  // cannot tell the two apart would silently overrule them.
  let modeSource = 'default';

  const isolation = readPrefsCached(cwd).prefs.forge_isolation;
  if (!isolation || typeof isolation !== 'object' || Array.isArray(isolation)) {
    return { mode, modeSource, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, prOnComplete };
  }
  if (typeof isolation.mode === 'string') { mode = isolation.mode.toLowerCase(); modeSource = 'pref'; }
  const stringValue = (value, fallback) => { if (typeof value !== 'string') return fallback; const s = value.replace(/^["']|["']$/g, '').trim(); return s.length > 0 ? s : fallback; };
  branchPattern = stringValue(isolation.branch_pattern, branchPattern);
  worktreeRoot = stringValue(isolation.worktree_root, worktreeRoot);
  const boolValue = (value, fallback) => value === undefined ? fallback : (typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true');
  autoPullMain = boolValue(isolation.auto_pull_main, autoPullMain);
  worktreeCleanupOnComplete = boolValue(isolation.worktree_cleanup_on_complete, worktreeCleanupOnComplete);
  worktreeInstallDeps = boolValue(isolation.worktree_install_deps, worktreeInstallDeps);
  prOnComplete = boolValue(isolation.pr_on_complete, prOnComplete);
  return { mode, modeSource, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, worktreeInstallDeps, prOnComplete };
}

function resolvePackageManager(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, 'package.json'))) return null;
  const managers = [
    ['pnpm-lock.yaml', { manager: 'pnpm', cmd: 'pnpm', args: ['install', '--frozen-lockfile'] }],
    ['yarn.lock', { manager: 'yarn', cmd: 'yarn', args: ['install', '--frozen-lockfile'] }],
    ['package-lock.json', { manager: 'npm', cmd: 'npm', args: ['ci'] }],
  ];
  for (const [lockfile, config] of managers) {
    if (fs.existsSync(path.join(repoRoot, lockfile))) return config;
  }
  return null;
}

// NOTE: first-line truncation above is a size guard, NOT a redaction mechanism —
// a secret on the first line of stderr (the common case for npm/yarn auth
// failures) is NOT protected by truncation. Every credential-shaped pattern
// below must be actively redacted; do not rely on truncation to hide secrets.
function redactInstallError(value) {
  return String(value || '').split(/\r?\n/)[0].slice(0, 500)
    // npm canonical per-registry token: //<host>/:_authToken=<token>
    .replace(/(\/\/[^\s/]+\/:_authToken=)\S+/gi, '$1[REDACTED]')
    // legacy/global npm token forms: _authToken=, _auth=, _password=
    .replace(/(_authToken=)\S+/gi, '$1[REDACTED]')
    .replace(/(_auth=)\S+/gi, '$1[REDACTED]')
    .replace(/(_password=)\S+/gi, '$1[REDACTED]')
    // yarn: npmAuthToken: <token>
    .replace(/(npmAuthToken:\s*)\S+/gi, '$1[REDACTED]')
    // credentials embedded in a URL: https://user:pass@host/...
    .replace(/https:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@');
}

// Dependency provisioning inherits process.env deliberately: private registries often
// require proxy, registry, or NODE_AUTH_TOKEN configuration. It runs project lifecycle
// scripts, so untrusted repositories should set worktree_install_deps: false.
function installWorktreeDeps(repoRoot, wtPath, opts) {
  opts = opts || {};
  if (opts.enabled === false) return { status: 'disabled', manager: null, ms: 0 };
  const packageManager = resolvePackageManager(repoRoot);
  if (!packageManager) return { status: 'no-lockfile', manager: null, ms: 0 };
  const timeoutMs = opts.timeoutMs || WORKTREE_INSTALL_TIMEOUT_MS;
  const runner = opts.runner || ((cmd, args, runOpts) => spawnSync(cmd, args, {
    cwd: runOpts.cwd, timeout: runOpts.timeoutMs, shell: true, stdio: 'pipe', encoding: 'utf8', env: process.env,
  }));
  const started = Date.now();
  try {
    const run = runner(packageManager.cmd, packageManager.args, { cwd: wtPath, timeoutMs });
    const ms = Date.now() - started;
    if (run && !run.error && run.status === 0) return { status: 'installed', manager: packageManager.manager, ms };
    return { status: 'failed', manager: packageManager.manager, ms, error: redactInstallError(run && (run.stderr || run.error)) || 'dependency installer failed' };
  } catch (e) {
    return { status: 'failed', manager: packageManager.manager, ms: Date.now() - started, error: redactInstallError(e.message) || 'dependency installer failed' };
  }
}

// ── Effective-mode elevation (require_worktree per write-engine) ────────────
// S03/M014: `shared` installs that resolve an EXTERNAL WRITE-engine
// (codex/gpt/gemini) for execute-task are elevated to `worktree` STATICALLY at
// activation — never mid-run. Elevation reuses the existing worktree mechanics
// wholesale (setupWorktreeOne/cleanupWorktreeOne); it only swaps the effective
// mode consumed by setupForRun/cleanupForRun. False-positive of elevation is
// acceptable; false-negative is NOT — detection is deliberately generous.

// Reads workers.require_worktree from the prefs cascade. Normalizes JSONC
// boolean true/false → "true"/"false". Valid set {auto,true,false}; anything
// else (or absent) → "auto" (default).
function resolveRequireWorktree(cwd) {
  try {
    const workers = readPrefsCached(cwd).prefs.workers;
    if (!workers || typeof workers !== 'object' || Array.isArray(workers)) return 'auto';
    const raw = workers.require_worktree;
    if (raw === undefined || raw === null) return 'auto';
    const v = String(raw).toLowerCase().trim();
    if (v === 'auto' || v === 'true' || v === 'false') return v;
    return 'auto';
  } catch { return 'auto'; }
}

// Detects whether an external write-engine (codex/gpt/gemini) is configured for
// execute-task. Returns { detected, reason }. Three signals (generous, OR'd):
//   (1) workers.execute-task == codex (the sidecar write path);
//   (2) any routing.<domain>.executor.<tier|fallback> id whose modelFamily is
//       gpt or gemini;
//   (3) any tier_models member whose family is gpt or gemini. Even an explicit
//       Claude worker cannot suppress this signal: task frontmatter has higher
//       precedence and may select an external writer after activation, when the
//       isolation mode is already frozen. This intentionally prefers a safe
//       false-positive over a shared-mode external write.
//       Read-only paths (plan-slice Branch D, review challenger)
//       are intentionally NOT inspected — they never write.
// Never throws (never blocks activation): any error → { detected:true,
// reason:'detect-error (fail-safe: elevating)' } — detection fails SAFE
// (false-positive by design), consistent with the line-62 invariant.
function detectExternalWriteEngine(cwd) {
  try {
    const { modelFamily } = require('./forge-model-alias.js');
    const { readRoutingConfig } = require('./forge-routing.js');

    const prefs = readPrefsCached(cwd).prefs;
    if (prefs.workers && String(prefs.workers['execute-task']).toLowerCase() === 'codex') {
      return { detected: true, reason: 'workers.execute-task:codex' };
    }

    if (prefs.tier_models && typeof prefs.tier_models === 'object') {
      for (const [tier, ids] of Object.entries(prefs.tier_models)) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          const fam = modelFamily(id);
          if (fam === 'gpt' || fam === 'gemini') {
            return { detected: true, reason: 'tier_models.' + tier + ':' + fam };
          }
        }
      }
    }

    const cfg = readRoutingConfig(cwd);
    if (cfg.present && cfg.ok && cfg.routing && typeof cfg.routing === 'object') {
      for (const [domain, dcfg] of Object.entries(cfg.routing)) {
        if (!dcfg || typeof dcfg !== 'object') continue;
        if (!dcfg.executor || typeof dcfg.executor !== 'object') continue;
        for (const [tier, ids] of Object.entries(dcfg.executor)) {
          // Both tier chains (arrays) and the `fallback` string are inspected —
          // a gpt/gemini fallback is still write-engine intent (false-positive OK).
          const list = Array.isArray(ids) ? ids : [ids];
          for (const id of list) {
            const fam = modelFamily(id);
            if (fam === 'gpt' || fam === 'gemini') {
              return { detected: true, reason: 'routing.' + domain + '.executor.' + tier + ':' + fam };
            }
          }
        }
      }
    }
    return { detected: false, reason: null };
  } catch { return { detected: true, reason: 'detect-error (fail-safe: elevating)' }; }
}

// S06/T01 — closed set of reasons that can populate `unmet_requirement.asked_by`
// in the SVN short-circuit. Cross-referenced both ways by the test suite: every
// asked_by member emitted belongs here, and every member here is reached by at
// least one test case.
const UNMET_ASK_REASONS = Object.freeze(['pref:worktree', 'require_worktree:true', 'require_worktree:auto']);

// Derives the S06/T01 `unmet_requirement` field for the SVN short-circuit, or
// `null` when nothing was actually asked for. `false` never contributes B or C
// here — same invariant as elevation (:279, "false never elevates") — but it
// does NOT suppress A: an explicit `mode: worktree` pref is a standing request,
// not something elevation produced, and the same distinction is asserted for
// elevation itself at the test `require_worktree:false forbids ELEVATION, it
// does not undo the DERIVED default` (:1065). Never throws: `req` and `iso` are
// pre-computed by the caller, and detectExternalWriteEngine is fail-safe by
// construction (:187).
function deriveUnmetRequirement({ iso, req, cwd }) {
  const askedBy = [];
  if (iso.modeSource === 'pref' && iso.mode === 'worktree') askedBy.push('pref:worktree');
  if (req === 'true') askedBy.push('require_worktree:true');
  let writeEngine = null;
  if (req === 'auto') {
    const det = detectExternalWriteEngine(cwd);
    if (det.detected) {
      askedBy.push('require_worktree:auto');
      writeEngine = det.reason;
    }
  }
  if (askedBy.length === 0) return null;
  return { requirement: 'worktree', asked_by: askedBy, blocked_by: 'vcs:svn', write_engine: writeEngine };
}

/**
 * D4 — the default isolation mode derived from the project's SHAPE, not from a
 * second flag the operator has to keep in sync with the first.
 *
 * A WORKSPACE (a registered project that strictly contains other registered
 * projects) is where several runs plausibly go at once, and where they would
 * collide in one working tree — so it defaults to `worktree`. A standalone
 * project runs one at a time; a worktree there is cost without benefit, so it
 * stays `shared`, which is also the historical behaviour.
 *
 * Failure is safe-silent by design: this runs at EVERY activation, and an
 * unreadable or absent registry must not stop a run or change its isolation.
 * `shared` is what such a machine always got, so that is what it keeps getting.
 */
function deriveShapeMode(cwd) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  try {
    const reg = ws.loadRegistry(ws.registryPath(home), { home, recomputeKinds: false });
    if (!reg) return { mode: 'shared', role: null, reason: 'no-registry' };
    const actives = (reg.entries || []).map(e => e.abs).filter(Boolean);
    const role = ws.resolveRole(path.resolve(cwd), actives);
    return {
      mode: role === 'workspace' ? 'worktree' : 'shared',
      role: role || null,
      reason: 'role:' + String(role),
    };
  } catch (e) {
    return { mode: 'shared', role: null, reason: 'registry-unreadable' };
  }
}

// Resolves the EFFECTIVE isolation mode for a run, applying the shape-derived
// default (D4) and then require_worktree elevation, once at activation. Returns
//   { mode, user_mode, mode_origin, require_worktree, elevated, elevation_reason, write_engine, vcs }
// Invariants: `false` never elevates (byte-identical); a `worktree` base mode is
// a no-op; `true` always yields `worktree` from shared/branch; `auto` elevates
// only from `shared` when a write-engine is detected.
//
// Ordering is load-bearing: SVN short-circuit FIRST (it has no worktree path at
// all), then the shape default, then elevation on top of whatever base resulted
// — a derived base is elevated by exactly the same rules as a pref-set one.
//
// `opts.shapeDefault === false` disables the derivation, leaving the pref-only
// world. Its one caller is resolveCleanupMode's legacy fallback: see the FREEZE
// note there.
function resolveEffectiveMode(cwd, opts) {
  const o = opts || {};
  const iso = readIsolationPrefs(cwd);
  const userMode = iso.mode;
  const explicit = iso.modeSource === 'pref';
  const req = resolveRequireWorktree(cwd);
  // VCS detection is advisory here: an error or an unrecognised location keeps
  // the historical git-oriented path rather than weakening isolation broadly.
  let vcs = 'none';
  try { vcs = detectVcs(cwd); } catch { vcs = 'none'; }
  const base = {
    mode: userMode, user_mode: userMode,
    mode_origin: explicit ? 'pref' : 'default',
    require_worktree: req, elevated: false, elevation_reason: null, write_engine: null, vcs,
  };

  // SVN has no worktree or branch equivalent in Phase 1. This must precede
  // every elevation branch, including an explicit worktree user preference:
  // a named shared degradation is safer than attempting git setup and STOPing.
  if (vcs === 'svn') {
    const unmet = deriveUnmetRequirement({ iso, req, cwd });
    return {
      ...base,
      mode: 'shared',
      elevated: false,
      elevation_reason: 'vcs:svn — worktree/branch isolation unsupported in SVN (M017 Fase 1 runs shared)',
      ...(unmet ? { unmet_requirement: unmet } : {}),
    };
  }

  // D4: only an ABSENT mode pref is derived from shape. An explicit one wins
  // always — including an explicit `shared` inside a workspace, which is the
  // operator's opt-out and the whole reason readIsolationPrefs reports
  // modeSource.
  let baseMode = userMode;
  if (!explicit && o.shapeDefault !== false) {
    const shape = deriveShapeMode(cwd);
    base.shape_role = shape.role;
    base.shape_reason = shape.reason;
    if (shape.mode === 'worktree') {
      baseMode = 'worktree';
      base.mode = 'worktree';
      base.mode_origin = 'derived-shape';
    }
  }

  if (req === 'false') return base;            // never elevate — invariant
  if (baseMode === 'worktree') return base;    // already isolated — no-op

  if (req === 'true') {
    return { ...base, mode: 'worktree', elevated: true, elevation_reason: 'require_worktree:true (' + baseMode + '→worktree)' };
  }
  if (req === 'auto' && baseMode === 'shared') {
    const det = detectExternalWriteEngine(cwd);
    if (det.detected) {
      return { ...base, mode: 'worktree', elevated: true, elevation_reason: 'require_worktree:auto ' + det.reason, write_engine: det.reason };
    }
  }
  return base;
}

function resolveBranchName(pattern, runId) {
  return pattern.replace(/\{M###\}/gi, runId).replace(/\{id\}/gi, runId);
}

function gitDefaultBranch(repoPath) {
  // Try origin/HEAD first; fall back to "main" then "master".
  //
  // execFileSync WITHOUT a shell (measured on the Windows CI runner): the old
  // form appended `2>/dev/null` inside a shell:true string, and cmd.exe parses
  // `/dev/null` as a literal (invalid) path — the whole command failed, so on
  // Windows this ALWAYS fell through to the main/master fallback even when
  // origin/HEAD was set. Same failure family as the "worktree born 13 commits
  // behind" incident: a silently wrong branch base. stderr is discarded via
  // stdio (portable), not a redirect; the error semantics are unchanged —
  // any failure still lands in the catch and takes the fallback ladder.
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
    return { ref: def, fetched: false, warn: `fetch origin ${def} failed: ${e.message.split(/\r?\n/)[0]}` };
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
        result.warn = `update ${def} failed: ${e.message.split(/\r?\n/)[0]}`;
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
    result.error = e.message.split(/\r?\n/)[0];
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
    result.error = e.message.split(/\r?\n/)[0];
  }
  return result;
}

// ── Worktree mode ───────────────────────────────────────────────────────────
// Sole holder of the worktree path naming convention. Cleanup (cleanupForRun)
// deliberately never calls this — it discovers worktrees via `git worktree
// list` instead, so a convention change here cannot orphan anything already
// on disk. This exists purely for SETUP to know where to create the new
// worktree. Kept pure: the registry is passed IN, never loaded here.

// A worktree directory that is not hidden gets walked by ProjectDiscovery, and
// every `.gsd/` copy inside it enrols as a phantom project — the exact defect
// the workspace-root milestone's earlier slices closed. The dot-prefix rule is
// also what keeps `forge-repos.js DEFAULT_EXCLUDE` honest: it excludes hidden
// directories generically, so a root that renames the worktree dir stays
// excluded only while the name starts with a dot. Hence this is enforced at
// setup, loudly, rather than written down as a comment nobody reads.
// (DEFAULT_EXCLUDE is deliberately NOT widened dynamically here.)
function validateWorktreeDirName(dirName) {
  if (typeof dirName !== 'string' || dirName.trim() === '') return 'is empty';
  const v = dirName.trim();
  if (path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) return 'is absolute';
  const segments = v.split(/[\\/]/).filter(s => s !== '' && s !== '.');
  if (segments.length === 0) return 'names no directory';
  if (segments.some(s => s === '..')) return 'escapes the root via ".."';
  if (!segments[0].startsWith('.')) {
    return 'is not hidden (its first segment must start with "." or every worktree becomes a phantom project for discovery)';
  }
  return null;
}

// The deepest declared root that strictly contains `repoPath`, or null. Same
// rule as the codec's `encodeEntryPath` containment scan, reusing the same
// helpers rather than reimplementing containment.
function findContainingRoot(repoPath, roots, home) {
  if (!Array.isArray(roots) || roots.length === 0 || typeof home !== 'string' || !home) return null;
  const abs = path.resolve(repoPath);
  let best = null;
  let bestLen = -1;
  for (const r of roots) {
    let entry;
    let rootAbs;
    try {
      entry = ws.normalizeRootEntry(r, 0);
      rootAbs = ws.resolveRootPath(entry.path, home);
    } catch { continue; }   // one unusable root never disqualifies the others
    if (ws.isStrictlyUnder(abs, rootAbs) && rootAbs.length > bestLen) {
      best = { entry, abs: rootAbs };
      bestLen = rootAbs.length;
    }
  }
  return best;
}

/**
 * Where a worktree for `runId` is created. Three cases, in order, and no fourth:
 *
 *   absolute `worktree_root` pref  → <pref>/<runId>/<repo>        anchor 'pref-absolute'
 *   repo under a declared root     → <root>/<dirName>/<runId>/<repo>   anchor 'root'
 *   anything else                  → <repoParent>/<pref>/<runId>/<repo> anchor 'legacy-sibling'
 *
 * `dirName` is `root.layout.worktrees` when the root declares one, else the
 * relative pref (default `.forge-worktrees`).
 *
 * The two ways `dirName` can be unusable are NOT the same fact and do not get
 * the same outcome:
 *   - it came from `layout` → THROW. The operator wrote it into the registry on
 *     purpose; quietly using something else would put worktrees somewhere they
 *     did not ask for and hide the mistake.
 *   - it came from the pref → fall back to the legacy sibling with a reported
 *     warning. That value predates roots entirely, and erroring would break
 *     setups that worked yesterday for a reason the operator never opted into.
 */
function resolveWorktreeAnchor(repoPath, worktreeRoot, runId, opts) {
  opts = opts || {};
  const repoName = path.basename(repoPath);
  // The legacy sibling convention, written ONCE — two callers below reach it
  // (no containing root, and an unusable pref under a root), and a second copy
  // of this expression is precisely what T02 removed.
  const legacySibling = () => path.join(repoPath, '..', worktreeRoot, runId, repoName);

  if (path.isAbsolute(worktreeRoot)) {
    return { path: path.join(worktreeRoot, runId, repoName), anchor: 'pref-absolute', root: null, dir_name: worktreeRoot, dir_source: 'pref' };
  }

  const found = findContainingRoot(repoPath, opts.roots, opts.home);
  if (found) {
    const declared = found.entry.layout && typeof found.entry.layout === 'object'
      ? found.entry.layout.worktrees : undefined;
    // A declared-but-non-string value (e.g. `{"worktrees": 123}`) is a
    // layout-sourced mistake, not an absent declaration — it must take the
    // THROW path below (R2, M-20260802185210 S04 review), not silently
    // degrade to the pref dirName. Silently ignoring it would be quieter
    // than even the pref-sourced fallback (which at least warns), and would
    // contradict this function's own documented rule above.
    const declaredPresent = declared !== undefined;
    const fromLayout = declaredPresent && typeof declared === 'string';
    const dirName = (fromLayout ? declared
      : declaredPresent ? String(declared)
        : worktreeRoot).trim();
    const bad = declaredPresent && !fromLayout
      ? `is not a string (got ${JSON.stringify(declared)})`
      : validateWorktreeDirName(dirName);
    if (!bad) {
      return {
        path: path.join(found.abs, dirName, runId, repoName),
        anchor: 'root', root: found.abs,
        dir_name: dirName, dir_source: fromLayout ? 'layout' : 'pref',
      };
    }
    if (declaredPresent) {
      throw new Error(
        `forge-isolation: root "${found.entry.path}" declares layout.worktrees ${JSON.stringify(fromLayout ? dirName : declared)}, which ${bad}` +
        ` — refusing to create a worktree; fix it in ${opts.registryFile || 'the workspace registry'}`);
    }
    return {
      path: legacySibling(),
      anchor: 'legacy-sibling', root: null,
      dir_name: worktreeRoot, dir_source: 'pref',
      warn: `worktree_root ${JSON.stringify(worktreeRoot)} ${bad} — not anchoring under the declared root ${found.abs}; falling back to the legacy sibling convention`,
    };
  }

  return {
    path: legacySibling(),
    anchor: 'legacy-sibling', root: null, dir_name: worktreeRoot, dir_source: 'pref',
  };
}

// Back-compat surface: the path alone. Delegates — the convention still lives
// in exactly one function.
function deriveWorktreePath(repoPath, worktreeRoot, runId, opts) {
  return resolveWorktreeAnchor(repoPath, worktreeRoot, runId, opts).path;
}

/**
 * Roots declared in the workspace registry, for the given home. An absent
 * registry and an unreadable one both mean "no root anchor available", but only
 * the second is reported: absence is the ordinary state of a machine that never
 * registered a workspace, while an unreadable file is a fact the operator wants
 * to hear about before wondering why worktrees moved.
 */
function loadRegistryRoots(home) {
  const file = ws.registryPath(home);
  try {
    const reg = ws.loadRegistry(file, { home, recomputeKinds: false });
    if (!reg) return { roots: [], file, present: false };
    return { roots: reg.roots || [], file, present: true };
  } catch (e) {
    return {
      roots: [], file, present: false,
      warn: `workspace registry ${file} could not be read (${e.message.split(/\r?\n/)[0]}) — worktree anchoring falls back to the legacy sibling convention`,
    };
  }
}

function addWarn(result, msg) {
  if (!msg) return;
  result.warn = result.warn ? `${result.warn}; ${msg}` : msg;
}

function setupWorktreeOne(repoPath, branchName, worktreeRoot, runId, autoPullMain, installOpts, anchorOpts) {
  const result = { path: repoPath, branch: branchName, worktree: null, status: 'pending' };
  try {
    const anchor = resolveWorktreeAnchor(repoPath, worktreeRoot, runId, anchorOpts);
    const wtPath = anchor.path;
    result.worktree = wtPath;
    result.anchor = anchor.anchor;
    result.root = anchor.root;
    addWarn(result, (anchorOpts || {}).registryWarn);
    addWarn(result, anchor.warn);

    // Already exists?
    if (fs.existsSync(wtPath)) {
      result.status = 'already-exists';
      result.deps = { status: 'skipped', manager: null, ms: 0, reason: 'worktree-already-exists' };
      return result;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      // Fetch first, then branch the worktree from origin/<def> (fresh remote
      // cache) — NOT the local <def>, which is never updated by branching and is
      // commonly stale. Falls back to local <def> when there is no origin.
      const base = fetchDefaultBranch(repoPath, def);
      addWarn(result, base.warn);
      result.base = base.ref;
      execSync(`git worktree add "${wtPath}" -b ${branchName} ${base.ref}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    } else {
      execSync(`git worktree add "${wtPath}" -b ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    }
    result.status = 'created';
    result.deps = installWorktreeDeps(repoPath, wtPath, installOpts);
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split(/\r?\n/)[0];
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
    result.error = e.message.split(/\r?\n/)[0];
  }
  return result;
}

// ── Worktree discovery (git-primary) ────────────────────────────────────────
// Cleanup must NEVER re-derive a worktree path from the naming convention.
// The convention can change; `git worktree list` records where each worktree
// ACTUALLY is, so it is the only source that survives such a change. Measured
// 2026-08-02 in ~/Development/message: 7 live worktrees born under the old
// sibling-of-repo convention, 6 registered in git with real commits, while the
// run registry's `worktrees[]` covers only 2 of them. A registry-primary
// cleanup would report "nothing to clean" as success and orphan the rest.
// Hence: git is the source, the registry is reinforcement whose divergence is
// REPORTED, never absorbed.

// ── Canonical on-disk path spelling — ONE implementation ────────────────────
// git prints fully resolved paths: on macOS os.tmpdir() is a symlink
// (/var/... → /private/var/...), and on Windows os.tmpdir() can come back in
// 8.3 short form (C:\Users\RUNNER~1\...) while git (`--git-common-dir`,
// `git worktree list`) prints the long form (C:\Users\runneradmin\...).
// Measured on the GitHub Windows runner: plain fs.realpathSync resolves
// symlinks but does NOT expand 8.3 short names, so the same repo produced two
// distinct identities and worktree matching matched nothing ("expected
// [removed]" failures). fs.realpathSync.native calls GetFinalPathNameByHandle,
// which expands 8.3 — but it can fail where the libuv fallback still works
// (e.g. some network drives), hence a ladder, not a swap:
//   .native → realpathSync → path.resolve (path may not exist yet: lexical).
// This is the THIRD time this repo pays "lexical comparison where only
// real-vs-real is truth" (memory-index path containment, the sweep vault in
// PR #100, now worktree identity). Every consumer — normalizeWorktreePath
// here, repoIdentity in forge-touch.js, and the test normalizer in
// forge-isolation.test.js — MUST route through this helper; a fourth private
// copy of the relation is the defect, not a convenience.
function realpathCanonical(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch {}
  try { return fs.realpathSync(abs); } catch {}
  return abs;
}

function normalizeWorktreePath(p) {
  if (!p || typeof p !== 'string') return '';
  return realpathCanonical(p);
}

// Parses `git worktree list --porcelain`: blank-line separated blocks, each
// starting with `worktree <path>`, plus optional HEAD/branch/detached/bare/
// locked/prunable attribute lines.
function parseWorktreePorcelain(out) {
  const entries = [];
  let cur = null;
  const flush = () => { if (cur) entries.push(cur); cur = null; };
  for (const rawLine of String(out || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') { flush(); continue; }
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  flush();
  return entries;
}

// Every worktree git knows about for `repoPath`, EXCLUDING the main checkout.
// git always lists the main worktree first; it is excluded both by that
// position and by path identity with repoPath, so a main checkout sitting on
// the forge branch is never mistaken for a run worktree (removing it would be
// data loss, not cleanup). Bare and detached blocks are skipped.
function listWorktrees(repoPath) {
  let out = '';
  try {
    out = execSync('git worktree list --porcelain', { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
  } catch { return []; }
  const parsed = parseWorktreePorcelain(out).filter(e => e.path && !e.bare);
  const mainPath = normalizeWorktreePath(repoPath);
  const primary = parsed.length > 0 ? normalizeWorktreePath(parsed[0].path) : null;
  return parsed.filter((e, i) => {
    if (i === 0) return false;                                    // main checkout
    const p = normalizeWorktreePath(e.path);
    return p !== mainPath && p !== primary;
  });
}

// Worktrees of `repoPath` checked out on exactly `branchName`. This replaces
// convention re-derivation in cleanupForRun.
function listWorktreesForBranch(repoPath, branchName) {
  if (!branchName || typeof branchName !== 'string') return [];
  return listWorktrees(repoPath).filter(e => e.branch === branchName);
}

// Worktrees of `repoPath` on any forge/* branch — the read-only inventory view.
function listForgeWorktrees(repoPath) {
  return listWorktrees(repoPath).filter(e => typeof e.branch === 'string' && /^forge\//.test(e.branch));
}

// Validates a lender's registered worktree(s) without provisioning anything.
// A fallback setup here would silently put the borrower on an unrelated branch.
function attachForRun(cwd, runId, lenderRunId) {
  if (!lenderRunId || typeof lenderRunId !== 'string') {
    return { ok: false, attached: false, reason: 'missing-run-id', error: 'Informe o id do run que emprestará o worktree.' };
  }

  const lender = runs.get(cwd, lenderRunId);
  if (!lender) {
    return { ok: false, attached: false, reason: 'unknown-run', error: `Run emprestador não encontrado: ${lenderRunId}.` };
  }
  if (!Array.isArray(lender.worktrees) || lender.worktrees.length === 0) {
    return {
      ok: false,
      attached: false,
      reason: 'no-worktree-registered',
      error: `O run ${lenderRunId} não tem worktree registrado; ele precisa ter rodado em modo worktree com esta versão.`,
    };
  }

  for (const entry of lender.worktrees) {
    if (!entry || typeof entry.path !== 'string' || !fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
      const missingPath = entry && entry.path ? entry.path : '(caminho ausente no registro)';
      return { ok: false, attached: false, reason: 'worktree-path-missing', error: `Worktree registrado não existe ou não é diretório: ${missingPath}.` };
    }
  }

  const first = lender.worktrees[0];
  const codeDir = lender.worktrees.length === 1 ? first.path : path.dirname(first.path);
  return {
    ok: true,
    mode: 'worktree',
    attached: true,
    attached_to: lenderRunId,
    code_dir: codeDir,
    branch: gitCurrentBranch(first.path),
    repos: lender.worktrees.map(entry => ({ path: entry.repo, worktree: entry.path, status: 'attached' })),
  };
}

// ── Public top-level ────────────────────────────────────────────────────────
function setupForRun(cwd, runId, opts) {
  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const eff = resolveEffectiveMode(cwd);   // may elevate shared→worktree at activation
  const mode = eff.mode;
  const result = { mode, user_mode: eff.user_mode, elevated: eff.elevated, elevation_reason: eff.elevation_reason, vcs: eff.vcs, repos: [] };

  if (mode === 'shared') return result;  // no-op

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  // Loaded ONCE per setup, here rather than inside the derivation, so the
  // derivation stays pure and testable against literal fixtures. `HOME` is read
  // from the environment first so a synthetic-$HOME harness (smoke, tests) sees
  // its own registry and never the operator's.
  const registry = mode === 'worktree'
    ? loadRegistryRoots(process.env.HOME || process.env.USERPROFILE || os.homedir())
    : { roots: [], file: null };
  const anchorOpts = {
    roots: registry.roots,
    home: process.env.HOME || process.env.USERPROFILE || os.homedir(),
    registryFile: registry.file,
    registryWarn: registry.warn,
  };

  for (const r of repoList) {
    if (mode === 'branch') {
      result.repos.push(setupBranchOne(r, branchName, prefs.autoPullMain));
    } else if (mode === 'worktree') {
      result.repos.push(setupWorktreeOne(r, branchName, prefs.worktreeRoot, runId, prefs.autoPullMain, {
        enabled: prefs.worktreeInstallDeps, runner: opts.runner, timeoutMs: opts.timeoutMs,
      }, anchorOpts));
    }
  }
  return result;
}

// Cleanup must honor the effective mode recorded at activation. This closes
// the M014 S03-R2 debt: a mid-run pref flip worktree→shared must not hit the
// shared guard and orphan the worktree. Only isolation_mode is registry-backed;
// a mid-run worktree_root flip remains out of scope.
const VALID_ISOLATION_MODES = new Set(['shared', 'branch', 'worktree']);

function resolveCleanupMode(cwd, runId) {
  let rec = null;
  try { rec = runs.get(cwd, runId); } catch { rec = null; }
  if (rec && typeof rec.isolation_mode === 'string' && rec.isolation_mode.trim()) {
    const normalized = rec.isolation_mode.trim().toLowerCase();
    if (VALID_ISOLATION_MODES.has(normalized)) {
      return { mode: normalized, source: 'registry' };
    }
    // Corrupted/unknown registry value: no-op rather than silently falling
    // back to re-resolving current prefs (that reintroduces the mid-run
    // pref-flip hazard this slice closed).
    return { mode: 'shared', source: 'invalid-registry' };
  }
  // FREEZE (S04-RISK blocker #3), corrected by R1 (M-20260802185210 S04
  // review): this fallback is reached by TWO distinct cases, not one.
  //
  //   - `rec === null` — no run-registry record at all. Reachable in
  //     practice: the standalone CLI (`--setup --run <id>`) calls
  //     setupForRun and never writes a record, and forge-auto has a crash
  //     window between isolation setup and the subsequent
  //     `forge-runs.js --add`. Setup, at birth, resolved with the shape
  //     default ON — so a record-less run must resolve cleanup the same
  //     way, or a workspace-shaped project provisions a worktree at setup
  //     and leaks it at cleanup with no `not-found` row at all (silent
  //     abandonment). This direction is safe: worktree-mode cleanup is
  //     discovery-based, so a genuinely shared-born record-less run just
  //     produces a loud `not-found` row and removes nothing.
  //   - a legacy record that HAS `rec` but no (or invalid) `isolation_mode`
  //     — written before isolation_mode was recorded at --add. Those runs
  //     were born in the pref-only world, so resolving them under the shape
  //     default is exactly the "started shared, finishes worktree" hazard:
  //     two isolation modes would coexist in one repo with neither cleanup
  //     seeing the other's artifacts. Keep the shape default OFF here.
  //
  // A run's effective mode is frozen when the run is born; nothing here
  // recomputes it from the project's current shape — the shapeDefault split
  // above exists only to mirror what birth actually did in each case.
  const eff = resolveEffectiveMode(cwd, { shapeDefault: rec === null });
  return {
    mode: eff.mode,
    source: 'fallback-resolve',
    user_mode: eff.user_mode,
    elevated: eff.elevated,
    elevation_reason: eff.elevation_reason,
    vcs: eff.vcs,
  };
}

function cleanupForRun(cwd, runId, opts) {
  let rec = null;
  try { rec = runs.get(cwd, runId); } catch { rec = null; }
  if (rec && rec.attached_to) {
    // Borrowed worktrees belong to another (possibly still active) run. A clean
    // status does not make them disposable: cleanupWorktreeOne only protects
    // uncommitted changes and would otherwise destroy valid in-flight work.
    return {
      mode: 'worktree',
      mode_source: 'borrowed',
      borrowed_from: rec.attached_to,
      user_mode: null,
      elevated: null,
      elevation_reason: null,
      vcs: (() => { try { return detectVcs(cwd); } catch { return 'none'; } })(),
      repos: (rec.worktrees || []).map(e => ({
        path: e.repo,
        worktree: e.path,
        status: 'skipped (borrowed)',
        reason: 'worktree emprestado de ' + rec.attached_to + ' — nunca removido',
      })),
    };
  }
  // Lender-side guard (TASK-019 R1): the borrower-side `rec.attached_to`
  // check above protects a path that path-derivation-by-convention never
  // actually hits (a borrower's own runId never maps to the lender's
  // worktree dir), so it guards nothing in practice today — it is kept
  // because it is cheap, keeps borrowed status auditable in the JSON, and
  // becomes load-bearing the moment path derivation ever switches from
  // convention to the registry's `worktrees` field. The check that is
  // actually load-bearing right now is this one: cleaning up the LENDER
  // removes its tree by convention regardless of who has an active
  // attach to it, so we must scan the registry for active borrowers of
  // THIS runId before touching anything. Mirrors the 2026-06-10 worktree
  // cleanup data-loss incident, newly reachable because borrowing exists.
  let activeBorrowers = [];
  try {
    activeBorrowers = runs.listActive(cwd).filter(r => r.id !== runId && r.attached_to === runId);
  } catch { activeBorrowers = []; }

  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const cm = resolveCleanupMode(cwd, runId);
  const mode = cm.mode;
  const result = {
    mode,
    mode_source: cm.source,
    user_mode: cm.user_mode === undefined ? null : cm.user_mode,
    elevated: cm.elevated === undefined ? null : cm.elevated,
    elevation_reason: cm.elevation_reason === undefined ? null : cm.elevation_reason,
    vcs: cm.vcs === undefined ? (() => { try { return detectVcs(cwd); } catch { return 'none'; } })() : cm.vcs,
    repos: [],
  };

  if (activeBorrowers.length > 0) {
    const borrowerIds = activeBorrowers.map(r => r.id);
    result.lent_to = borrowerIds;
    const repoList = repos.discoverRepos(cwd);
    for (const r of repoList) {
      result.repos.push({
        path: r,
        status: `skipped (lent to ${borrowerIds.join(', ')})`,
        reason: 'worktree emprestado a ' + borrowerIds.join(', ') + ' — nunca removido enquanto emprestimo ativo',
      });
    }
    return result;
  }

  if (mode === 'shared') return result;

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  for (const r of repoList) {
    if (mode === 'branch') {
      result.repos.push(cleanupBranchOne(r, branchName));
    } else if (mode === 'worktree') {
      if (!prefs.worktreeCleanupOnComplete) {
        result.repos.push({ path: r, status: 'skipped (worktree_cleanup_on_complete=false)' });
        continue;
      }
      // Git is the source (survives a convention change); the registry is
      // reinforcement. The convention re-derivation that used to live here is
      // gone deliberately — see the discovery block above.
      // Normalization is snapshotted BEFORE any removal: normalizeWorktreePath
      // resolves symlinks (macOS /var → /private/var) only while the path still
      // exists, and falls back to path.resolve once it is gone. Re-normalizing
      // after the removal loop would make a correctly-matched registry entry
      // stop matching and be re-reported as a phantom divergence.
      const repoNorm = normalizeWorktreePath(r);
      const listed = listWorktreesForBranch(r, branchName)
        .map(wt => ({ wt, norm: normalizeWorktreePath(wt.path) }));
      const registered = (rec && Array.isArray(rec.worktrees) ? rec.worktrees : [])
        .filter(e => e && typeof e.path === 'string' &&
          (e.repo === undefined || e.repo === null || normalizeWorktreePath(e.repo) === repoNorm))
        .map(e => ({ entry: e, norm: normalizeWorktreePath(e.path) }));
      const registeredPaths = new Set(registered.map(x => x.norm));
      const listedPaths = new Set(listed.map(x => x.norm));

      for (const { wt, norm } of listed) {
        const row = cleanupWorktreeOne(r, wt.path);   // dirty-check lives there
        row.branch = wt.branch;
        row.source = registeredPaths.has(norm) ? 'git+registry' : 'git';
        result.repos.push(row);
      }

      // Divergence is reported, never absorbed: a registry entry git does not
      // list is named explicitly and left untouched (git wins on what exists).
      for (const { entry, norm } of registered) {
        if (listedPaths.has(norm)) continue;
        result.repos.push({
          path: r,
          worktree: entry.path,
          status: 'registry-only (não listado pelo git — não removido)',
          source: 'registry',
          reason: 'registro do run aponta ' + entry.path + ', mas `git worktree list` do repo ' + r +
            ' não lista esse caminho para ' + branchName + ' — divergência reportada, nada foi removido',
        });
      }

      // Silence must not be indistinguishable from a broken query.
      if (listed.length === 0 && registered.length === 0) {
        result.repos.push({
          path: r,
          worktree: null,
          status: 'not-found (git não lista worktree para ' + branchName + ')',
          source: 'git',
        });
      }
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

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return fs.realpathSync.native(path.resolve(value)); } catch { return null; }
}

/** Pure/read-only dispatch boundary for a declared single-repo CODE_DIR. */
function validateCodeDirBoundary(input = {}) {
  const workspace = canonicalDirectory(input.workspaceRoot);
  const codeDir = canonicalDirectory(input.codeDir);
  const declared = canonicalDirectory(input.declaredCodeDir);
  const reposList = Array.isArray(input.repoRoots) ? input.repoRoots.map(canonicalDirectory).filter(Boolean) : [];
  if (!workspace || !codeDir || !declared) return { ok: false, reason_code: 'code-dir-undeclared' };
  if (reposList.length !== 1) return { ok: false, reason_code: 'multirepo-refused' };
  const relative = path.relative(workspace, codeDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { ok: false, reason_code: 'code-dir-outside-workspace' };
  if (codeDir !== declared || codeDir !== reposList[0]) return { ok: false, reason_code: 'code-dir-undeclared' };
  return { ok: true, reason_code: 'code-dir-verified', code_dir: codeDir, workspace_root: workspace };
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help || (!args.setup && !args.cleanup && !args.attach && !args.prefs && !args['effective-mode'] && !args['list-worktrees'])) {
    process.stdout.write(`forge-isolation — setup/cleanup branch + worktree modes

Flags:
  --setup --run <id>     setup branch or worktree per repo (idempotent)
  --cleanup --run <id>   cleanup (checkout main / remove worktree)
  --attach <lender> --run <id>  validate and borrow a registered worktree (never creates one)
  --list-worktrees       READ-ONLY inventory: worktrees git knows about, per repo
                         (all forge/* branches, or only --run <id>'s branch)
  --prefs                print resolved forge_isolation prefs
  --effective-mode       print resolveEffectiveMode JSON (shows mode_origin: pref | derived-shape | default,
                         the shape-derived default, require_worktree elevation and the SVN shared short-circuit)
  --cwd <path>           override working directory

Reads prefs from forge_isolation: + workers.require_worktree (cascade user → repo → local).
--setup/--cleanup JSON carry elevated/elevation_reason/user_mode/vcs.
`);
    return;
  }

  try {
    if (args['list-worktrees']) {
      // Strictly read-only: it queries git and prints. It never calls
      // cleanupWorktreeOne and never spawns `git worktree remove/prune`.
      const prefs = readIsolationPrefs(cwd);
      const runId = typeof args.run === 'string' ? args.run : null;
      const branchName = runId ? resolveBranchName(prefs.branchPattern, runId) : null;
      const out = { cwd, run: runId, branch: branchName, repos: [] };
      for (const r of repos.discoverRepos(cwd)) {
        const list = branchName ? listWorktreesForBranch(r, branchName) : listForgeWorktrees(r);
        out.repos.push({ path: r, count: list.length, worktrees: list });
      }
      out.total = out.repos.reduce((n, x) => n + x.count, 0);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else if (args['effective-mode']) {
      process.stdout.write(JSON.stringify(resolveEffectiveMode(cwd), null, 2) + '\n');
    } else if (args.prefs) {
      process.stdout.write(JSON.stringify(readIsolationPrefs(cwd), null, 2) + '\n');
    } else if (args.setup) {
      const r = setupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.cleanup) {
      const r = cleanupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.attach) {
      const lenderRunId = typeof args.attach === 'string' ? args.attach : '';
      const r = attachForRun(cwd, args.run, lenderRunId);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r.ok) {
        process.stderr.write(`forge-isolation attach: ${r.error}\n`);
        process.exit(2);
      }
    }
  } catch (e) {
    process.stderr.write(`forge-isolation error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  setupForRun, cleanupForRun, attachForRun, readIsolationPrefs,
  resolveEffectiveMode, detectExternalWriteEngine, resolveRequireWorktree, resolveCleanupMode,
  deriveShapeMode, UNMET_ASK_REASONS,
  listWorktreesForBranch, listForgeWorktrees, listWorktrees, parseWorktreePorcelain, normalizeWorktreePath,
  realpathCanonical,
  cleanupWorktreeOne, setupWorktreeOne, deriveWorktreePath,
  resolveWorktreeAnchor, validateWorktreeDirName, findContainingRoot, loadRegistryRoots,
  resolveBranchName, gitDefaultBranch, gitCurrentBranch,
  gitHasOriginRemote, fetchDefaultBranch,
  resolvePackageManager, installWorktreeDeps, WORKTREE_INSTALL_TIMEOUT_MS,
  validateCodeDirBoundary,
};
