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
//   captureBatchBase / setupForBatchMember → issue 343 U2a, the measured dirty base and one
//     exclusive worktree and index per batch member and root (see the section below)
//
// CLI:
//   node forge-isolation.js --setup --run M065 [--cwd <path>]
//   node forge-isolation.js --cleanup --run M065 [--cwd <path>]
//   node forge-isolation.js --attach M065 --run T123 [--cwd <path>]

'use strict';

const crypto = require('crypto');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { git, validateBranch } = require('./forge-git-process');
const { readPrefsCached } = require('./forge-prefs.js');
const { detectVcs, isGsdPath } = require('./forge-vcs.js');
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
// a writing unit. Returns { detected, reason }. Signals (generous, OR'd):
//   (1) workers.execute-task == codex (the sidecar write path), or
//       workers.review-fix == codex (the scoped review-fix sidecar also writes);
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
    if (prefs.workers && String(prefs.workers['review-fix']).toLowerCase() === 'codex') {
      return { detected: true, reason: 'workers.review-fix:codex' };
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
    const out = git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    return validateBranch(repoPath, out.replace(/^origin\//, '') || 'main');
  } catch {}
  for (const b of ['main', 'master']) {
    try { git(repoPath, ['rev-parse', '--verify', '--end-of-options', b]); return b; } catch {}
  }
  return 'main';
}

function gitCurrentBranch(repoPath) {
  try { return git(repoPath, ['branch', '--show-current']).trim(); }
  catch { return null; }
}

function gitHasOriginRemote(repoPath) {
  try {
    git(repoPath, ['remote', 'get-url', 'origin']);
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
  validateBranch(repoPath, def);
  if (!gitHasOriginRemote(repoPath)) return { ref: def, fetched: false };
  try {
    git(repoPath, ['fetch', '--quiet', 'origin', def]);
    // Confirm the remote-tracking ref resolves before we rely on it as a base.
    git(repoPath, ['rev-parse', '--verify', '--end-of-options', `origin/${def}`]);
    return { ref: `origin/${def}`, fetched: true };
  } catch (e) {
    return { ref: def, fetched: false, warn: `fetch origin ${def} failed: ${e.message.split(/\r?\n/)[0]}` };
  }
}

function branchExists(repoPath, branch) {
  try {
    git(repoPath, ['show-ref', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch { return false; }
}

// ── Branch mode ─────────────────────────────────────────────────────────────
function setupBranchOne(repoPath, branchName, autoPullMain) {
  const result = { path: repoPath, branch: branchName, status: 'pending' };
  try {
    validateBranch(repoPath, branchName);
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
        git(repoPath, ['checkout', def]);
        if (base.fetched) {
          // Fast-forward the local default to the freshly-fetched origin tip.
          git(repoPath, ['merge', '--ff-only', `origin/${def}`]);
        } else {
          git(repoPath, ['pull', '--ff-only']);
        }
      } catch (e) {
        result.warn = `update ${def} failed: ${e.message.split(/\r?\n/)[0]}`;
      }
    }

    if (branchExists(repoPath, branchName)) {
      git(repoPath, ['checkout', branchName]);
      result.status = 'checked-out-existing';
    } else {
      git(repoPath, ['checkout', '-b', branchName]);
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
      git(repoPath, ['checkout', def]);
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

function validateWorktreeIdentity(repoPath, wtPath, branchName) {
  try {
    const top = git(wtPath, ['rev-parse', '--show-toplevel']).trim();
    if (normalizeWorktreePath(top) !== normalizeWorktreePath(wtPath)) return { ok: false, reason: 'not-worktree-root' };
    const common = dir => normalizeWorktreePath(path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']).trim()));
    if (common(repoPath) !== common(wtPath)) return { ok: false, reason: 'wrong-repository' };
    if (gitCurrentBranch(wtPath) !== branchName) return { ok: false, reason: 'wrong-branch' };
    const registered = listWorktrees(repoPath).some(entry => normalizeWorktreePath(entry.path) === normalizeWorktreePath(wtPath) && entry.branch === branchName && !entry.prunable);
    return registered ? { ok: true } : { ok: false, reason: 'unregistered-worktree' };
  } catch { return { ok: false, reason: 'not-a-worktree' }; }
}

function setupWorktreeOne(repoPath, branchName, worktreeRoot, runId, autoPullMain, installOpts, anchorOpts) {
  const result = { path: repoPath, branch: branchName, worktree: null, status: 'pending' };
  try {
    validateBranch(repoPath, branchName);
    const anchor = resolveWorktreeAnchor(repoPath, worktreeRoot, runId, anchorOpts);
    const wtPath = anchor.path;
    result.worktree = wtPath;
    result.anchor = anchor.anchor;
    result.root = anchor.root;
    addWarn(result, (anchorOpts || {}).registryWarn);
    addWarn(result, anchor.warn);
    const journal = provisioningJournal(repoPath, wtPath);
    let pending;
    try { pending = JSON.parse(fs.readFileSync(journal, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending && (pending.branch !== branchName || pending.target !== provisioningIdentity(wtPath))) {
      throw new Error('Worktree provisioning journal identity mismatch');
    }
    if (pending && (pending.phase !== 'deps' || !fs.existsSync(wtPath))) {
      result.status = 'error';
      result.reason = 'provisioning-incomplete';
      result.error = `Worktree checkout did not finish; inspect and repair before removing journal: ${journal}`;
      return result;
    }

    // Reuse only a registered worktree of this repository on this branch.
    if (fs.existsSync(wtPath)) {
      const identity = validateWorktreeIdentity(repoPath, wtPath, branchName);
      if (!identity.ok) {
        result.status = 'error';
        result.reason = identity.reason;
        result.error = `Existing worktree refused: ${identity.reason}`;
        return result;
      }
      if (pending) {
        result.deps = installWorktreeDeps(repoPath, wtPath, installOpts);
        if (result.deps.status === 'failed') {
          result.status = 'error';
          result.reason = 'dependency-install-failed';
          result.error = result.deps.error;
          return result;
        }
        fs.unlinkSync(journal);
        result.status = 'already-exists';
        return result;
      }
      result.status = 'already-exists';
      result.deps = { status: 'skipped', manager: null, ms: 0, reason: 'worktree-already-exists' };
      return result;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify({ target: provisioningIdentity(wtPath), branch: branchName, phase: 'creating' }), { flag: 'wx' });

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      // Fetch first, then branch the worktree from origin/<def> (fresh remote
      // cache) — NOT the local <def>, which is never updated by branching and is
      // commonly stale. Falls back to local <def> when there is no origin.
      const base = fetchDefaultBranch(repoPath, def);
      addWarn(result, base.warn);
      result.base = base.ref;
      git(repoPath, ['worktree', 'add', '-b', branchName, '--', wtPath, base.ref]);
    } else {
      git(repoPath, ['worktree', 'add', '-b', branchName, '--', wtPath]);
    }
    result.status = 'created';
    const temporary = `${journal}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ target: provisioningIdentity(wtPath), branch: branchName, phase: 'deps' }), { flag: 'wx' });
    fs.renameSync(temporary, journal);
    result.deps = installWorktreeDeps(repoPath, wtPath, installOpts);
    if (result.deps.status === 'failed') {
      result.status = 'error';
      result.reason = 'dependency-install-failed';
      result.error = result.deps.error;
    } else fs.unlinkSync(journal);
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split(/\r?\n/)[0];
  }
  return result;
}

function provisioningJournal(repoPath, wtPath) {
  const common = path.resolve(repoPath, git(repoPath, ['rev-parse', '--git-common-dir']).trim());
  const key = require('crypto').createHash('sha256').update(provisioningIdentity(wtPath)).digest('hex');
  return path.join(common, 'forge-provisioning', `${key}.json`);
}

function provisioningIdentity(target) {
  let existing = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const canonical = path.join(realpathCanonical(existing), ...suffix);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
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
    const dirty = git(worktreePath, ['status', '--porcelain']).trim();
    if (dirty) {
      result.status = 'skipped (dirty)';
      result.reason = 'uncommitted changes in worktree — commit on the forge branch (or discard) before cleanup; nothing was removed';
      return result;
    }
    git(repoPath, ['worktree', 'remove', '--force', '--', worktreePath]);
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
    out = git(repoPath, ['worktree', 'list', '--porcelain']);
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
  if (lender.batch_locator) return { ok: false, attached: false, reason: 'batch-member-root-exclusive', error: 'Batch roots cannot be borrowed.' };
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
    const reservation = batchAuthority().memberRootReservation(cwd, entry.path);
    if (reservation.reserved) return { ok: false, attached: false, reason: reservation.reason_code, error: 'The worktree has a retained batch owner.' };
    if (typeof entry.repo !== 'string' || typeof lender.branch !== 'string' || !lender.branch) {
      return { ok: false, attached: false, reason: 'worktree-identity-missing', error: 'Lender registry must identify repository and expected branch.' };
    }
    const identity = validateWorktreeIdentity(entry.repo, entry.path, lender.branch);
    if (!identity.ok) return { ok: false, attached: false, reason: identity.reason, error: `Lender worktree refused: ${identity.reason}` };
    try {
      fs.statSync(provisioningJournal(entry.repo, entry.path));
      return { ok: false, attached: false, reason: 'provisioning-incomplete', error: 'Lender worktree provisioning has not completed.' };
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, attached: false, reason: 'provisioning-unreadable', error: 'Cannot inspect lender provisioning state.' };
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

function resolveCleanupMode(cwd, runId, snapshot) {
  // Cleanup passes its bounded snapshot, including explicit null for an absent run.
  // Other callers retain their historical lookup behavior.
  let rec = snapshot === undefined ? null : snapshot;
  if (snapshot === undefined) {
    try { rec = runs.get(cwd, runId); } catch { rec = null; }
  }
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
  return runs.withRegistryFence(cwd, () => cleanupFenced(cwd, runId, opts));
}

function cleanupFenced(cwd, runId, opts) {
  // Inspect the entire registry before reading even this run's payload. Unknown
  // ownership cannot become an empty borrower set or a record-less fallback.
  let census;
  try { census = runs.listAllDetailed(cwd, { maxRuns: 512, maxBytes: 65536 }); } catch { census = null; }
  const records = census && Array.isArray(census.parsed) ? census.parsed : null;
  const known = records && Array.isArray(census.unparseable) && census.unparseable.length === 0 && records.length <= 512
    && records.every(r => r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string' && r.id.length > 0
      && typeof r.active === 'boolean' && (r.attached_to == null || typeof r.attached_to === 'string' && r.attached_to.length > 0)
      && (r.worktrees == null || Array.isArray(r.worktrees) && r.worktrees.every(w => w && typeof w === 'object' && !Array.isArray(w)
        && typeof w.path === 'string' && w.path.length > 0 && (w.repo == null || typeof w.repo === 'string' && w.repo.length > 0))))
    && new Set(records.map(r => r.id)).size === records.length
    && records.reduce((total, r) => total + (r.worktrees || []).length, 0) <= 2048;
  if (!known) return {
    mode: 'shared', mode_source: 'ownership-unknown', user_mode: null, elevated: null, elevation_reason: null,
    vcs: (() => { try { return detectVcs(cwd); } catch { return 'none'; } })(),
    repos: [{ path: cwd, status: 'skipped (ownership unknown)', reason: 'ownership-unknown' }],
  };
  const rec = records.find(r => r.id === runId) || null;
  if (rec?.batch_locator) return {
    mode: 'worktree', mode_source: 'batch-retained', user_mode: null, elevated: null, elevation_reason: null,
    vcs: 'git', repos: [{ path: cwd, status: 'skipped (batch retained)', reason: 'batch-members-pending' }],
  };
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
  const activeBorrowers = records.filter(r => r.active === true && r.id !== runId && r.attached_to === runId);

  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const cm = resolveCleanupMode(cwd, runId, rec);
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

// ── Issue 343 U2a: batch dirty base and member worktrees (B2 part 1) ────────
//
// An admitted execute-task cohort (forge-execution-batch prepareIsolation) gives every
// member its own linked worktree and index per physical root. The member reproduces the
// MEASURED base of the integration root: HEAD, the logical index (path, stage, mode, blob),
// the working-tree bytes (staged and unstaged kept apart, deletions, renames as a removal
// plus a creation, binary content, the representable exec bit) and the legitimate untracked
// files. The integration root is only read, always with GIT_OPTIONAL_LOCKS=0 (not even an
// opportunistic index refresh), and its repository receives exactly one
// `worktree add --no-checkout -b <sibling ref> <HEAD>` per member root: no commit, stash,
// reset, checkout, fetch, rebase or pull, and no fabricated baseline.
//
//   captureBatchBase(reservationHandle, integrationContract, trusted?)
//     measures every integration root before and after reading it and publishes ONE
//     immutable package beside the run's worktree anchor, outside the owner and every code
//     root: <anchor>/.batch/<batch-hash>/base/{package.json, objects/<aa>/<sha256>}
//   setupForBatchMember(memberHandle, baseRef, trusted?)
//     <anchor>/.batch/<batch-hash>/<member-hash>/<root-hash> on a ref sibling of the run
//     branch; its index is built only in its own index file; provisioning journal
//     intent → worktree → verified, resumable in a fresh process
//
// Authority is never minted here: both handles are opaque in-process capabilities of
// forge-execution-batch (resolveIsolationHandle revalidates the manifest, the committed
// begin and the live lease). An unrepresentable base is the named serial fallback
// materialization-unsupported with one BATCH_MATERIALIZATION_DETAILS entry (SVN:
// svn-isolation-unavailable); a foreign, aliased, unstable or changed source refuses with
// one BATCH_ISOLATION_REFUSALS code. Preferences are read only for the existing layout and
// never rewritten. `trusted` is in-process only: named failpoints and limits that can only
// be tightened.

const BATCH_BASE_SCHEMA = 'forge-batch-base-v1';
const BATCH_JOURNAL_SCHEMA = 'forge-batch-provisioning-v1';
const BATCH_ATTEMPT_SCHEMA = 'forge-batch-base-attempt-v1';
const BATCH_AREA = '.batch';
// forge-claude-sidecar TEMP_DIR_PREFIX: one sidecar's private prompt staging, never product.
const SIDECAR_STAGING_PREFIX = '.forge-claude-sidecar-';
const BATCH_BASE_LIMITS = Object.freeze({ entries: 50000, fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024,
  listingBytes: 64 * 1024 * 1024, packageBytes: 64 * 1024 * 1024, chunkBytes: 32 * 1024 * 1024 });
const BATCH_GIT_TIMEOUT_MS = 60000;
const BATCH_MATERIALIZATION_DETAILS = Object.freeze(['head-unborn', 'object-format', 'sparse-checkout', 'worktree-config',
  'index-entry-invalid', 'index-conflict-stage', 'skip-worktree', 'assume-unchanged', 'intent-to-add', 'gitlink',
  'nested-repository', 'symlink', 'special-file', 'type-change', 'case-collision', 'path-encoding', 'path-unsafe',
  'filter-attribute', 'ignored-input', 'limits-exceeded', 'ref-invalid', 'untracked-base-unprovenance']);
const BATCH_ISOLATION_REFUSALS = Object.freeze(['batch-isolation-handle-invalid', 'batch-isolation-handle-stale',
  'batch-isolation-contract-mismatch', 'batch-root-foreign', 'batch-root-alias', 'batch-area-unsafe', 'batch-base-invalid',
  'batch-source-unstable', 'batch-integration-changed', 'batch-member-path-occupied', 'batch-member-ref-occupied',
  'batch-member-unreconciled', 'batch-member-verification-failed', 'batch-journal-invalid']);
const BATCH_ISOLATION_FAILPOINTS = Object.freeze(['base-inventory-read', 'base-captured', 'member-intent-recorded',
  'member-worktree-created', 'member-materialized', 'batch-isolation-recorded', 'batch-claim-committed']);
const JOURNAL_PHASES = Object.freeze(['intent', 'worktree', 'verified']);
const OID_LENGTH = Object.freeze({ sha1: 40, sha256: 64 });
const SHA256_RE = /^[a-f0-9]{64}$/;
const OID_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
// Nothing may point git at another repository, index, object store or injected
// configuration; optional locks and replace refs are off for every batch command.
const BATCH_GIT_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_DIR: undefined,
  GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_COMMON_DIR: undefined, GIT_NAMESPACE: undefined,
  GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: undefined });
const STAGE_ARGS = Object.freeze(['ls-files', '-s', '-z']);
const TAGS_ARGS = Object.freeze(['ls-files', '-v', '-z']);
const STATUS_ARGS = Object.freeze(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
  '--ignored=no', '--no-renames']);
const UNTRACKED_ARGS = Object.freeze(['ls-files', '-z', '-o', '--exclude-standard']);
const IGNORED_ARGS = Object.freeze(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory']);
const STABILITY_KEYS = Object.freeze(['head', 'index_sha256', 'stage_sha256', 'tags_sha256', 'status_sha256',
  'untracked_sha256', 'ignored_sha256']);
// After the capture a reader's stat refresh may rewrite the index FILE without any logical
// change; every other observation must stay exactly the measured one.
const UNCHANGED_KEYS = Object.freeze(STABILITY_KEYS.filter(key => key !== 'index_sha256'));
const LIMITS_EXCEEDED = Symbol('limits-exceeded');
const UTF8_PATH = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

class BatchIsolationError extends Error {
  constructor(code, detail) {
    super(`forge-isolation (${code}): ${detail}`);
    this.name = 'BatchIsolationError';
    this.code = code;
    this.detail = detail;
  }
}
function isolationRefuse(code, detail) { throw new BatchIsolationError(code, detail); }
// Lazy: these modules load forge modules this file must not load at require time, and
// forge-autonomy-sources itself requires this file.
function batchAuthority() { return require('./forge-execution-batch'); }
function codeRootsApi() { return require('./forge-code-roots'); }
function parallelismApi() { return require('./forge-parallelism'); }
function stableReader() { return require('./forge-autonomy-sources'); }

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}
function stableDigest(value) { return sha256Hex(JSON.stringify(stableValue(value))); }
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeDeep(item);
  }
  return value;
}
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function lstatOrNull(file, options) {
  try { return fs.lstatSync(file, options); }
  catch (error) { if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null; throw error; }
}
function failpoint(trusted, name) { if (trusted && typeof trusted.failpoint === 'function') trusted.failpoint(name); }
function limitsOf(requested) {
  const limits = { ...BATCH_BASE_LIMITS };
  if (plainObject(requested)) {
    for (const key of Object.keys(BATCH_BASE_LIMITS)) {
      if (Number.isSafeInteger(requested[key]) && requested[key] >= 0 && requested[key] < limits[key]) limits[key] = requested[key];
    }
  }
  return Object.freeze(limits);
}
function firstLine(error) {
  const stderr = error && Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : '';
  return (stderr.trim() || String((error && error.message) || error)).split(/\r?\n/)[0].slice(0, 300);
}

// Git only through forge-git-process (argv, no shell, windowsHide); output stays a Buffer.
function batchGit(cwd, args, extra = {}) {
  const options = { encoding: 'buffer', maxBuffer: extra.maxBuffer || BATCH_BASE_LIMITS.listingBytes,
    timeout: BATCH_GIT_TIMEOUT_MS, env: BATCH_GIT_ENV };
  if (extra.input) { options.input = extra.input; options.stdio = ['pipe', 'pipe', 'pipe']; }
  return git(cwd, args, options);
}
function batchGitStatus(cwd, args) {
  try { return { status: 0, stdout: batchGit(cwd, args) }; }
  catch (error) {
    if (error && Number.isInteger(error.status)) return { status: error.status, stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.alloc(0) };
    throw error;
  }
}
// A listing Buffer, LIMITS_EXCEEDED, or null when git could not list.
function listing(cwd, args, maxBuffer) {
  try { return batchGit(cwd, args, { maxBuffer }); }
  catch (error) { return error && error.code === 'ENOBUFS' ? LIMITS_EXCEEDED : null; }
}
function splitNul(buffer) {
  const tokens = [];
  let start = 0;
  for (let at = buffer.indexOf(0, start); at >= 0; at = buffer.indexOf(0, start)) {
    tokens.push(buffer.subarray(start, at));
    start = at + 1;
  }
  return start === buffer.length ? tokens : null;
}
function decodePath(bytes) {
  try { return UTF8_PATH.decode(bytes); } catch (_) { return null; }
}
function pathProblem(rel) {
  if (typeof rel !== 'string' || !rel || Buffer.byteLength(rel, 'utf8') > 4096 || rel.startsWith('/') || rel.includes('\\')
      || rel.includes(':')) return 'path-unsafe';
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[\u0000-\u001f\u007f]/.test(part)) return 'path-unsafe';
    if (process.platform === 'win32' && (/[<>"|?*]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))) return 'path-unsafe';
  }
  return null;
}
// Owner metadata and a sidecar's private prompt staging never enter a member base.
function baseExclusion(rel) {
  if (isGsdPath(rel)) return 'gsd';
  const slash = rel.indexOf('/');
  return slash > 0 && rel.slice(0, slash).startsWith(SIDECAR_STAGING_PREFIX) ? 'sidecar_staging' : null;
}
function pathList(buffer) {
  const tokens = splitNul(buffer);
  if (!tokens) return null;
  const paths = [];
  for (const token of tokens) {
    const rel = decodePath(token);
    if (rel === null) return null;
    if (!baseExclusion(rel)) paths.push(rel);
  }
  return paths;
}
function parseStatus(buffer) {
  const tokens = splitNul(buffer);
  if (!tokens) return { detail: 'index-entry-invalid' };
  const entries = [];
  for (const token of tokens) {
    if (token.length < 4 || token[2] !== 0x20) return { detail: 'index-entry-invalid' };
    const xy = token.subarray(0, 2).toString('latin1'), rel = decodePath(token.subarray(3));
    if (rel === null) return { detail: 'path-encoding' };
    // --no-renames: a rename is one removal and one creation; a pair is not this listing.
    if (/[RC]/.test(xy)) return { detail: 'index-entry-invalid' };
    entries.push({ xy, path: rel });
  }
  return { entries };
}
function statusList(entries) { return entries.filter(entry => !baseExclusion(entry.path)).map(entry => [entry.xy, entry.path]); }
function parseStage(buffer, format) {
  const tokens = splitNul(buffer);
  if (!tokens) return { detail: 'index-entry-invalid' };
  const entries = [];
  for (const token of tokens) {
    const tab = token.indexOf(0x09);
    const meta = tab < 0 ? null : /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/.exec(token.subarray(0, tab).toString('latin1'));
    if (!meta || meta[2].length !== OID_LENGTH[format]) return { detail: 'index-entry-invalid' };
    const rel = decodePath(token.subarray(tab + 1));
    if (rel === null) return { detail: 'path-encoding' };
    if (meta[3] !== '0') return { detail: 'index-conflict-stage' };
    if (meta[1] === '160000') return { detail: 'gitlink' };
    if (meta[1] === '120000') return { detail: 'symlink' };
    if (meta[1] !== '100644' && meta[1] !== '100755') return { detail: 'index-entry-invalid' };
    const problem = pathProblem(rel);
    if (problem) return { detail: problem };
    entries.push({ path: rel, mode: meta[1], oid: meta[2] });
  }
  return { entries };
}
// `ls-files -v`: H plain; S/s skip-worktree; lowercase assume-unchanged; M/m unmerged.
function tagsDetail(buffer) {
  const tokens = splitNul(buffer);
  if (!tokens) return 'index-entry-invalid';
  for (const token of tokens) {
    if (token.length < 3 || token[1] !== 0x20) return 'index-entry-invalid';
    const tag = String.fromCharCode(token[0]);
    if (tag === 'H') continue;
    if (tag === 'S' || tag === 's') return 'skip-worktree';
    if (tag === 'M' || tag === 'm') return 'index-conflict-stage';
    return tag === 'h' ? 'assume-unchanged' : 'index-entry-invalid';
  }
  return null;
}
function readHead(at) {
  const probe = batchGitStatus(at, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const oid = probe.stdout.toString('latin1').trim();
  return probe.status === 0 && OID_RE.test(oid) ? oid : null;
}
function objectFormatOf(at) {
  const probe = batchGitStatus(at, ['rev-parse', '--show-object-format']);
  const value = probe.stdout.toString('latin1').trim();
  return probe.status === 0 && Object.prototype.hasOwnProperty.call(OID_LENGTH, value) ? value : null;
}
// false when unset; null when present but not a boolean (unknown is never equality).
function configBool(at, key) {
  const probe = batchGitStatus(at, ['config', '--bool', '--get', key]);
  if (probe.status === 1) return false;
  const value = probe.stdout.toString('latin1').trim();
  return probe.status === 0 && (value === 'true' || value === 'false') ? value === 'true' : null;
}
function gitPathOf(at, args) {
  const out = batchGitStatus(at, args);
  const value = out.status === 0 ? decodePath(out.stdout) : null;
  const trimmed = value === null ? '' : value.replace(/\r?\n$/, '');
  return trimmed ? path.resolve(at, trimmed) : null;
}
// Index content may change during execution; its physical ownership may not.
// Do not pin an inode across Git's legitimate atomic index replacement.
function batchIndexIdentity(at) {
  const file = gitPathOf(at, ['rev-parse', '--git-path', 'index']);
  if (!file) return null;
  const stat = lstatOrNull(file, { bigint: true });
  const actual = realpathCanonical(file);
  if (codeRootsApi().key(actual) !== codeRootsApi().key(file)
      || stat && (stat.isSymbolicLink() || !stat.isFile())) return null;
  return { path: actual, links: stat ? Number(stat.nlink) : 0 };
}
// Bounded stable read (forge-autonomy-sources): a size, identity, time or real-path change
// during the read is no observation. `expectedReal` defaults to the joined path itself, so a
// link or junction anywhere under a physical root makes the read fail.
function stableRead(file, size, expectedReal) {
  const read = stableReader().readBoundedStableFile(file, size, { expectedReal: expectedReal || file });
  return read.error ? null : read.buffer;
}
function indexDigest(file) {
  if (!file) return null;
  const stat = lstatOrNull(file);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BATCH_BASE_LIMITS.listingBytes) return null;
  const bytes = stableRead(file, stat.size, realpathCanonical(file));
  return bytes ? sha256Hex(bytes) : null;
}
function gitBlobId(bytes, format) {
  return crypto.createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`, 'latin1').update(bytes).digest('hex');
}
function statOf(stat) { return { size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ino: String(stat.ino) }; }
// 'missing' (the path is absent), 'symlink' or 'type-change' for the first parent that is not
// a real directory under `rootReal`; null when every parent is one.
function parentProblem(rootReal, rel, cache) {
  const parts = rel.split('/');
  let dir = '';
  for (let index = 0; index < parts.length - 1; index++) {
    dir = dir ? `${dir}/${parts[index]}` : parts[index];
    let verdict = cache.get(dir);
    if (verdict === undefined) {
      const stat = lstatOrNull(path.join(rootReal, ...dir.split('/')));
      verdict = !stat ? 'missing' : stat.isSymbolicLink() ? 'symlink' : !stat.isDirectory() ? 'type-change' : null;
      cache.set(dir, verdict);
    }
    if (verdict) return verdict;
  }
  return null;
}
function nestedRepository(at, paths) {
  const seen = new Set();
  for (const rel of paths) {
    const parts = rel.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (lstatOrNull(path.join(at, ...parts.slice(0, depth), '.git'))) return true;
    }
  }
  return false;
}
// A filter driver (clean/smudge/process) may run external programs and is not reproduced.
function filterAttribute(at, paths) {
  if (!paths.length) return false;
  let out;
  try { out = batchGit(at, ['check-attr', '-z', '--stdin', 'filter'], { input: Buffer.concat(paths.map(rel => Buffer.from(`${rel}\0`, 'utf8'))) }); }
  catch (_) { return true; }
  const tokens = splitNul(out);
  if (!tokens || tokens.length !== paths.length * 3) return true;
  for (let index = 0; index < tokens.length; index += 3) {
    const value = tokens[index + 2].toString('latin1');
    if (value !== 'unspecified' && value !== 'unset') return true;
  }
  return false;
}

// Classifies one integration root, read-only. Returns { detail } for an unrepresentable
// base, { unstable } when git could not list it, else the measured listings.
function classifyRoot(root, reservation, limits) {
  const at = root.path;
  const head = readHead(at);
  if (!head) return { detail: 'head-unborn' };
  const format = objectFormatOf(at);
  if (!format || head.length !== OID_LENGTH[format]) return { detail: 'object-format' };
  if (configBool(at, 'core.sparseCheckout') !== false || configBool(at, 'index.sparse') !== false) return { detail: 'sparse-checkout' };
  if (configBool(at, 'extensions.worktreeConfig') !== false) return { detail: 'worktree-config' };
  if (lstatOrNull(path.join(at, '.gitmodules'))) return { detail: 'gitlink' };
  const commonDir = gitPathOf(at, ['rev-parse', '--git-common-dir']);
  const indexSha = indexDigest(gitPathOf(at, ['rev-parse', '--git-path', 'index']));
  if (!commonDir || indexSha === null) return { unstable: ['index'] };
  const stage = listing(at, STAGE_ARGS, limits.listingBytes);
  if (stage === LIMITS_EXCEEDED) return { detail: 'limits-exceeded' };
  if (stage === null) return { unstable: ['index'] };
  const parsed = parseStage(stage, format);
  if (parsed.detail) return parsed;
  const tags = listing(at, TAGS_ARGS, limits.listingBytes);
  if (tags === LIMITS_EXCEEDED) return { detail: 'limits-exceeded' };
  if (tags === null) return { unstable: ['index'] };
  const flagged = tagsDetail(tags);
  if (flagged) return { detail: flagged };
  // Two names one case-insensitive (or Unicode-normalizing) file system would fold together.
  const keys = new Map();
  const collides = rel => {
    const key = rel.normalize('NFC').toLowerCase(), prior = keys.get(key);
    keys.set(key, rel);
    return prior !== undefined && prior !== rel;
  };
  if (parsed.entries.some(entry => collides(entry.path))) return { detail: 'case-collision' };
  const status = listing(at, STATUS_ARGS, limits.listingBytes);
  if (status === LIMITS_EXCEEDED) return { detail: 'limits-exceeded' };
  if (status === null) return { unstable: ['status'] };
  const reported = parseStatus(status);
  if (reported.detail) return reported;
  for (const entry of reported.entries) {
    const [x, y] = entry.xy;
    if (x === 'U' || y === 'U' || entry.xy === 'AA' || entry.xy === 'DD') return { detail: 'index-conflict-stage' };
    if (x === ' ' && y === 'A') return { detail: 'intent-to-add' };
    if (x === 'T' || y === 'T') return { detail: 'type-change' };
  }
  const others = listing(at, UNTRACKED_ARGS, limits.listingBytes);
  if (others === LIMITS_EXCEEDED) return { detail: 'limits-exceeded' };
  const otherTokens = others === null ? null : splitNul(others);
  if (!otherTokens) return { unstable: ['untracked'] };
  const untracked = [], excluded = { gsd: 0, sidecar_staging: 0 };
  for (const token of otherTokens) {
    const rel = decodePath(token);
    if (rel === null) return { detail: 'path-encoding' };
    const exclusion = baseExclusion(rel);
    if (exclusion) { excluded[exclusion] += 1; continue; }
    if (rel.endsWith('/')) return { detail: 'nested-repository' };
    const problem = pathProblem(rel);
    if (problem) return { detail: problem };
    if (collides(rel)) return { detail: 'case-collision' };
    // Names alone are not permission to read/copy a nonignored local file. Only exact
    // qualified references of the live reservation's admitted plans grant that authority.
    if (!inputOrigins(reservation, root.id, rel).length) return { detail: 'untracked-base-unprovenance' };
    untracked.push(rel);
  }
  if (parsed.entries.length + untracked.length > limits.entries) return { detail: 'limits-exceeded' };
  if (nestedRepository(at, untracked)) return { detail: 'nested-repository' };
  // An ignored path under a member's declared writes is input the member root would lack.
  const ignoredRaw = listing(at, IGNORED_ARGS, limits.listingBytes);
  if (ignoredRaw === LIMITS_EXCEEDED) return { detail: 'limits-exceeded' };
  if (ignoredRaw === null) return { unstable: ['ignored'] };
  const ignored = pathList(ignoredRaw);
  if (!ignored) return { detail: 'path-encoding' };
  const overlaps = parallelismApi().pathsOverlap;
  for (const rel of ignored) {
    const target = `${root.id}::${rel.replace(/\/+$/, '')}`;
    if (reservation.members.some(member => (member.writes || []).some(write => overlaps(target, write)))
        || (reservation.base_inputs?.entries || []).some(ref => ref.root_id === root.id && overlaps(target, `${ref.root_id}::${ref.path}`))) {
      return { detail: 'ignored-input' };
    }
  }
  const tracked = parsed.entries.filter(entry => !isGsdPath(entry.path));
  if (filterAttribute(at, [...tracked.map(entry => entry.path), ...untracked])) return { detail: 'filter-attribute' };
  const kept = statusList(reported.entries);
  return { format, head, commonDir, stage, entryCount: parsed.entries.length, tracked, untracked, excluded, status: kept,
    gsdTracked: parsed.entries.filter(entry => isGsdPath(entry.path)).map(entry => ({ path: entry.path, oid: entry.oid, exec: entry.mode === '100755' })),
    observation: { head, index_sha256: indexSha, stage_sha256: sha256Hex(stage), tags_sha256: sha256Hex(tags),
      status_sha256: stableDigest(kept), untracked_sha256: stableDigest(untracked), ignored_sha256: stableDigest(ignored) } };
}
// The same digests, read again (stability and every later "unchanged" check).
function observationOf(at) {
  const index = indexDigest(gitPathOf(at, ['rev-parse', '--git-path', 'index']));
  const read = args => { const out = listing(at, args); return Buffer.isBuffer(out) ? out : null; };
  const stage = read(STAGE_ARGS), tags = read(TAGS_ARGS), status = read(STATUS_ARGS), others = read(UNTRACKED_ARGS), ignored = read(IGNORED_ARGS);
  const reported = status ? parseStatus(status) : null, untracked = others ? pathList(others) : null, skipped = ignored ? pathList(ignored) : null;
  return { head: readHead(at), index_sha256: index, stage_sha256: stage ? sha256Hex(stage) : null, tags_sha256: tags ? sha256Hex(tags) : null,
    status_sha256: reported && reported.entries ? stableDigest(statusList(reported.entries)) : null,
    untracked_sha256: untracked ? stableDigest(untracked) : null, ignored_sha256: skipped ? stableDigest(skipped) : null };
}
// The working-tree inventory: type, size, SHA-256 of the real bytes, exec bit and stat
// identity of every tracked (non-.gsd) and legitimate untracked path. A tracked file whose
// bytes ARE its index blob comes back from the object database; everything else is packaged.
function inventoryRoot(rootReal, rows, format, limits) {
  const cache = new Map(), inventory = [];
  let total = 0;
  for (const row of rows) {
    const parent = parentProblem(rootReal, row.path, cache);
    if (parent === 'symlink' || parent === 'type-change') return { detail: parent };
    const file = path.join(rootReal, ...row.path.split('/'));
    const stat = parent === 'missing' ? null : lstatOrNull(file, { bigint: true });
    if (!stat) {
      if (!row.tracked) return { unstable: true };
      inventory.push({ path: row.path, tracked: true, type: 'absent', size: 0, sha256: null, exec: null, source: null, oid: row.oid, stat: null });
      continue;
    }
    if (stat.isSymbolicLink()) return { detail: 'symlink' };
    if (stat.isDirectory()) return { detail: 'type-change' };
    if (!stat.isFile()) return { detail: 'special-file' };
    const size = Number(stat.size);
    total += size;
    if (size > limits.fileBytes || total > limits.totalBytes) return { detail: 'limits-exceeded' };
    const bytes = stableRead(file, size);
    if (!bytes) return { unstable: true };
    inventory.push({ path: row.path, tracked: row.tracked, ...(row.tracked ? {} : { provenance: row.provenance }), type: 'file', size, sha256: sha256Hex(bytes),
      exec: process.platform === 'win32' ? null : (Number(stat.mode) & 0o100) !== 0,
      source: row.tracked && gitBlobId(bytes, format) === row.oid ? 'odb' : 'package', oid: row.oid, stat: statOf(stat) });
  }
  return { inventory };
}
// The first inventory path whose presence or stat identity moved, else null.
function movedPath(rootReal, inventory) {
  for (const entry of inventory) {
    const stat = lstatOrNull(path.join(rootReal, ...entry.path.split('/')), { bigint: true });
    if (entry.type === 'absent') { if (stat) return entry.path; continue; }
    if (!stat || !stat.isFile() || JSON.stringify(statOf(stat)) !== JSON.stringify(entry.stat)) return entry.path;
  }
  return null;
}

// ── Batch area: beside the run's worktree anchor, real directories only ──
function physicalPrefix(dir) {
  const rest = [];
  let cursor = path.resolve(dir);
  for (;;) {
    if (lstatOrNull(cursor)) {
      let real = null, directory = false;
      try { real = fs.realpathSync.native(cursor); directory = fs.statSync(real).isDirectory(); } catch (_) { directory = false; }
      if (!directory) isolationRefuse('batch-area-unsafe', 'the worktree anchor is not a directory');
      return { real, rest };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) isolationRefuse('batch-area-unsafe', 'the worktree anchor has no existing ancestor');
    rest.unshift(path.basename(cursor));
    cursor = parent;
  }
}
function mainCheckoutOf(repo) {
  try {
    const listed = decodePath(batchGit(repo, ['worktree', 'list', '--porcelain']));
    const first = listed === null ? null : parseWorktreePorcelain(listed)[0];
    if (first && first.path && !first.bare) return realpathCanonical(first.path);
  } catch (_) { /* the root itself anchors the layout */ }
  return repo;
}
// The run's existing worktree layout (forge_isolation prefs, workspace registry,
// resolveWorktreeAnchor) decides where the batch area lives; never inside the owner or any
// code root, never containing one.
function batchLayout(reservation, contract) {
  const prefs = readIsolationPrefs(reservation.owner);
  const primary = contract.code_roots.find(root => root.id === contract.primary_root_id) || contract.code_roots[0];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const registry = loadRegistryRoots(home);
  let anchor;
  try {
    anchor = resolveWorktreeAnchor(mainCheckoutOf(primary.path), prefs.worktreeRoot, reservation.run_id,
      { roots: registry.roots, home, registryFile: registry.file });
  } catch (error) { return isolationRefuse('batch-area-unsafe', firstLine(error)); }
  const batchHash = stableDigest({ owner: reservation.owner_key, batch_id: reservation.batch_id,
    manifest_sha256: reservation.manifest_sha256 }).slice(0, 16);
  const prefix = physicalPrefix(path.dirname(anchor.path));
  const segments = [...prefix.rest, BATCH_AREA, batchHash];
  const batchDir = path.join(prefix.real, ...segments);
  const roots = codeRootsApi();
  for (const outer of [reservation.owner, ...contract.code_roots.map(root => root.path)]) {
    if (roots.within(outer, batchDir) || roots.within(batchDir, outer)) isolationRefuse('batch-area-unsafe', 'the batch area would overlap the owner or a code root');
  }
  return freezeDeep({ batch_hash: batchHash, batch_dir: batchDir, real_base: prefix.real, segments, anchor: anchor.anchor,
    branch_base: resolveBranchName(prefs.branchPattern, reservation.run_id) });
}
// Hashed names (full values live in the journal binding); the ref is a SIBLING of the run
// branch (forge/<run>-batch-…), never a child of it.
function memberLayout(layout, reservation, member, root) {
  const memberHash = stableDigest({ batch_id: reservation.batch_id, manifest_sha256: reservation.manifest_sha256,
    member_index: member.member_index, task_id: member.task_id, begin_key: member.begin_key,
    lease_generation: member.lease_generation }).slice(0, 16);
  const rootHash = stableDigest({ root_id: root.id, identity_sha256: root.identity_sha256 }).slice(0, 16);
  return { member_hash: memberHash, root_hash: rootHash, target: path.join(layout.batch_dir, memberHash, rootHash),
    branch: `${layout.branch_base}-batch-${layout.batch_hash.slice(0, 12)}-${memberHash.slice(0, 12)}-${rootHash.slice(0, 12)}` };
}
function branchValid(at, branch) { try { validateBranch(at, branch); return true; } catch (_) { return false; } }
function ensureRealDirs(base, segments) {
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat = lstatOrNull(cursor);
    if (!stat) {
      try { fs.mkdirSync(cursor); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) isolationRefuse('batch-area-unsafe', `${segment} is not a real directory`);
  }
  return cursor;
}
// true when the whole area exists; false before it was created; refuses a link in it.
function areaPresent(layout) {
  let cursor = layout.real_base;
  for (const segment of layout.segments) {
    cursor = path.join(cursor, segment);
    const stat = lstatOrNull(cursor);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) isolationRefuse('batch-area-unsafe', `${segment} is not a real directory`);
  }
  return true;
}
function ensureBatchArea(layout) {
  const dir = ensureRealDirs(layout.real_base, layout.segments);
  if (codeRootsApi().key(realpathCanonical(dir)) !== codeRootsApi().key(layout.batch_dir)) isolationRefuse('batch-area-unsafe', 'the batch area resolves elsewhere');
  return dir;
}
// Written and synced in staging, then hard linked to its name: a collision returns false and
// never overwrites; staging debris is never read.
function publishBuffer(layout, file, buffer) {
  const staging = ensureRealDirs(layout.batch_dir, ['.staging']);
  const temporary = path.join(staging, `${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, buffer); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.linkSync(temporary, file); return true; }
    catch (error) { if (error && error.code === 'EEXIST') return false; throw error; }
  } finally {
    if (created) { try { fs.unlinkSync(temporary); } catch (_) { /* staging debris is never authority */ } }
  }
}
function blobFile(layout, sha) { return path.join(layout.batch_dir, 'base', 'objects', sha.slice(0, 2), sha); }
function readBlob(layout, sha) {
  const file = blobFile(layout, sha), stat = lstatOrNull(file);
  const bytes = stat && stat.isFile() && !stat.isSymbolicLink() && stat.size <= BATCH_BASE_LIMITS.listingBytes ? stableRead(file, stat.size) : null;
  if (!bytes || sha256Hex(bytes) !== sha) isolationRefuse('batch-base-invalid', 'a base blob is missing or does not match its digest');
  return bytes;
}
function storeBlob(layout, sha, bytes) {
  const file = path.join(ensureRealDirs(layout.batch_dir, ['base', 'objects', sha.slice(0, 2)]), sha);
  if (!lstatOrNull(file) && publishBuffer(layout, file, bytes)) return;
  readBlob(layout, sha);
}
function packageFile(layout) { return path.join(layout.batch_dir, 'base', 'package.json'); }
function inputOrigins(reservation, rootId, relative) {
  return (reservation.base_inputs?.entries || []).filter(entry => entry.root_id === rootId && entry.path === relative);
}
function bindingOf(reservation) {
  return { owner_key: reservation.owner_key, batch_id: reservation.batch_id, manifest_sha256: reservation.manifest_sha256,
    milestone: reservation.milestone, run_id: reservation.run_id, base_inputs_sha256: stableDigest(reservation.base_inputs) };
}
function validInventoryEntry(entry) {
  if (!plainObject(entry) || pathProblem(entry.path) || isGsdPath(entry.path) || typeof entry.tracked !== 'boolean') return false;
  if (!entry.tracked && (!Array.isArray(entry.provenance) || !entry.provenance.length)) return false;
  if (entry.type === 'absent') return entry.tracked && entry.sha256 === null && entry.source === null && entry.stat === null;
  return entry.type === 'file' && Number.isSafeInteger(entry.size) && entry.size >= 0 && SHA256_RE.test(String(entry.sha256))
    && (entry.exec === null || typeof entry.exec === 'boolean') && plainObject(entry.stat)
    && (entry.source === 'package' || (entry.source === 'odb' && entry.tracked && OID_RE.test(String(entry.oid))));
}
function validPackageRoot(root, expected, bad, reservation, layout) {
  if (!plainObject(root) || root.root_id !== expected.id || root.identity_sha256 !== expected.identity_sha256) bad('the base package names another root');
  if (!Object.prototype.hasOwnProperty.call(OID_LENGTH, root.object_format) || typeof root.head !== 'string'
      || root.head.length !== OID_LENGTH[root.object_format] || !OID_RE.test(root.head)) bad('the base HEAD is invalid');
  if (!plainObject(root.observation) || root.observation.head !== root.head
      || STABILITY_KEYS.some(key => typeof root.observation[key] !== 'string')) bad('the base observation is invalid');
  if (!plainObject(root.index) || !Number.isSafeInteger(root.index.entries) || root.index.entries < 0
      || !SHA256_RE.test(String(root.index.blob)) || root.index.blob !== root.observation.stage_sha256) bad('the base index is invalid');
  if (!Array.isArray(root.status) || root.status.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
      || typeof row[1] !== 'string')) bad('the base status is invalid');
  if (!Array.isArray(root.untracked) || root.untracked.some(rel => pathProblem(rel) || baseExclusion(rel))) bad('the base untracked inventory is invalid');
  if (!Array.isArray(root.gsd_tracked) || root.gsd_tracked.some(row => !plainObject(row) || pathProblem(row.path) || !isGsdPath(row.path)
      || !OID_RE.test(String(row.oid)) || typeof row.exec !== 'boolean')) bad('the base owner-metadata entries are invalid');
  if (!Array.isArray(root.inventory) || !root.inventory.every(validInventoryEntry)) bad('the base working-tree inventory is invalid');
  // A package seal is integrity, not permission to label an arbitrary path "tracked".
  // The captured ls-files -s -z blob is pinned by the measured stage observation; prove a
  // bijection to that actual index before any member journal/content can be materialized.
  const stage = parseStage(readBlob(layout, root.index.blob), root.object_format);
  if (stage.detail || root.index.entries !== stage.entries.length
      || new Set(stage.entries.map(entry => entry.path)).size !== stage.entries.length) bad('the base stage inventory is invalid');
  const tracked = stage.entries.filter(entry => !isGsdPath(entry.path));
  const metadata = stage.entries.filter(entry => isGsdPath(entry.path)).map(entry => ({ path: entry.path, oid: entry.oid, exec: entry.mode === '100755' }));
  if (stableDigest(root.gsd_tracked) !== stableDigest(metadata)) bad('the base owner-metadata index does not match its stage');
  const indexed = new Map(tracked.map(entry => [entry.path, entry]));
  const product = root.inventory.filter(entry => entry.tracked);
  if (new Set(root.inventory.map(entry => entry.path)).size !== root.inventory.length || product.length !== tracked.length
      || product.some(entry => !indexed.has(entry.path) || entry.oid !== indexed.get(entry.path).oid)) {
    bad('the base tracked working-tree inventory does not match its stage');
  }
  const untracked = root.inventory.filter(entry => !entry.tracked);
  if (new Set(root.untracked).size !== root.untracked.length
      || untracked.some(entry => indexed.has(entry.path) || entry.oid !== null)
      || stableDigest(root.untracked) !== stableDigest(untracked.map(entry => entry.path))
      || root.observation.untracked_sha256 !== stableDigest(root.untracked)) bad('the base untracked paths do not match its observation and inventory');
  if (root.observation.status_sha256 !== stableDigest(root.status)
      || new Set(root.status.map(row => row[1])).size !== root.status.length
      || root.status.some(row => pathProblem(row[1]) || baseExclusion(row[1]))
      || stableDigest(root.status.filter(row => row[0] === '??').map(row => row[1])) !== stableDigest(root.untracked)) {
    bad('the base status does not match its observation and untracked inventory');
  }
  for (const entry of untracked) {
    const origins = inputOrigins(reservation, root.root_id, entry.path);
    if (!origins.length || stableDigest(entry.provenance) !== stableDigest(origins)) bad('the base untracked provenance is not the admitted one');
  }
}
// The published package of this batch (sealed, bound to the reservation, rooted in the
// contract order), null when `optional` and nothing is published yet.
function readPackage(layout, reservation, contract, optional) {
  const bad = detail => isolationRefuse('batch-base-invalid', detail);
  const absent = () => (optional ? null : bad('the base package is not published'));
  if (!areaPresent(layout)) return absent();
  const base = lstatOrNull(path.join(layout.batch_dir, 'base'));
  if (!base) return absent();
  if (base.isSymbolicLink() || !base.isDirectory()) bad('the base directory is not a real directory');
  const file = packageFile(layout), stat = lstatOrNull(file);
  if (!stat) return absent();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BATCH_BASE_LIMITS.packageBytes) bad('the base package is not a bounded regular file');
  const bytes = stableRead(file, stat.size);
  let record = null;
  try { record = bytes ? JSON.parse(UTF8_PATH.decode(bytes)) : null; } catch (_) { record = null; }
  if (!plainObject(record)) bad('the base package is unreadable');
  const { package_sha256: sealed, ...content } = record;
  if (record.schema !== BATCH_BASE_SCHEMA || typeof sealed !== 'string' || sealed !== stableDigest(content)) bad('the base package seal does not bind its content');
  if (!plainObject(record.batch) || stableDigest(record.batch) !== stableDigest(bindingOf(reservation))) bad('the base package belongs to another batch');
  if (!Array.isArray(record.roots) || record.roots.length !== contract.code_roots.length) bad('the base package names other roots');
  record.roots.forEach((root, index) => validPackageRoot(root, contract.code_roots[index], bad, reservation, layout));
  return freezeDeep(record);
}
function verifyPackageBlobs(layout, pkg) {
  const seen = new Set();
  for (const root of pkg.roots) {
    for (const sha of [root.index.blob, ...root.inventory.filter(entry => entry.source === 'package').map(entry => entry.sha256)]) {
      if (!seen.has(sha)) { readBlob(layout, sha); seen.add(sha); }
    }
  }
}
function recordAttempt(layout, record) {
  ensureBatchArea(layout);
  const dir = ensureRealDirs(layout.batch_dir, ['attempts']);
  const bytes = Buffer.from(`${JSON.stringify({ ...record, attempt_sha256: stableDigest(record) })}\n`, 'utf8');
  for (let tries = 0; tries < 4; tries++) {
    const sequence = fs.readdirSync(dir).filter(name => /^\d{4}\.json$/.test(name)).length + 1 + tries;
    if (publishBuffer(layout, path.join(dir, `${String(sequence).padStart(4, '0')}.json`), bytes)) return;
  }
  isolationRefuse('batch-source-unstable', 'the unstable capture attempt could not be recorded');
}
// An unstable source is recorded once as an attempt, never retried into an empty snapshot.
function unstableBase(layout, reservation, rootId, changed) {
  recordAttempt(layout, { schema: BATCH_ATTEMPT_SCHEMA, batch: bindingOf(reservation), outcome: 'source-unstable', root_id: rootId,
    changed: [...changed], at: new Date().toISOString() });
  return isolationRefuse('batch-source-unstable', `${rootId}: the source changed or could not be read while it was measured (${changed.join(', ')})`);
}
function unsupportedBase(reason, detail, rootId) { return freezeDeep({ status: 'unsupported', reason_code: reason, detail, root_id: rootId }); }
function capturedBase(layout, pkg, replay) {
  return freezeDeep({ status: 'captured', base: { schema: BATCH_BASE_SCHEMA, batch_id: pkg.batch.batch_id,
    manifest_sha256: pkg.batch.manifest_sha256, package_sha256: pkg.package_sha256, batch_dir: layout.batch_dir, replay,
    roots: pkg.roots.map(root => ({ root_id: root.root_id, head: root.head, index_entries: root.index.entries,
      files: root.inventory.filter(entry => entry.type === 'file').length, deleted: root.inventory.filter(entry => entry.type === 'absent').length,
      untracked: root.untracked.length, package_blobs: new Set(root.inventory.filter(entry => entry.source === 'package').map(entry => entry.sha256)).size })) } });
}
function revalidatedContract(reservation) {
  try { return codeRootsApi().validateContract(reservation.contract, { revalidate: true, owner: reservation.owner }); }
  catch (error) {
    const code = error && error.code;
    return isolationRefuse(code === 'roots-overlap-or-alias' || code === 'root-id-duplicate' ? 'batch-root-alias' : 'batch-root-foreign',
      `the integration roots are no longer their measured checkouts (${code || 'unknown'})`);
  }
}
function assertRootUnchanged(base, root) {
  const now = observationOf(root.path);
  const changed = UNCHANGED_KEYS.filter(key => now[key] !== base.observation[key]);
  if (movedPath(root.path, base.inventory)) changed.push('working-tree');
  // readPackage has already proved every inventory path against the measured stage or
  // explicit input origins. Only those authorized paths may be read here. Stat equality
  // and a self-consistent package seal cannot prove its payload is still the source bytes
  // (notably a dirty tracked file whose Git status remains M after a forged package).
  if (!changed.length) {
    for (const entry of base.inventory) {
      if (entry.type !== 'file') continue;
      const bytes = stableRead(path.join(root.path, ...entry.path.split('/')), entry.size);
      if (!bytes || sha256Hex(bytes) !== entry.sha256) { changed.push('working-tree-bytes'); break; }
    }
    if (movedPath(root.path, base.inventory)) changed.push('working-tree');
  }
  if (changed.length) {
    isolationRefuse('batch-integration-changed', `${base.root_id}: the integration root no longer holds the measured base (${changed.join(', ')})`);
  }
}
function assertRootsUnchanged(pkg, contract) { contract.code_roots.forEach((root, index) => assertRootUnchanged(pkg.roots[index], root)); }
function packageRoot(layout, reservation, row) {
  const { root, classified, inventory } = row;
  storeBlob(layout, classified.observation.stage_sha256, classified.stage);
  const stored = new Set();
  for (const entry of inventory) {
    if (entry.source !== 'package' || stored.has(entry.sha256)) continue;
    const bytes = stableRead(path.join(root.path, ...entry.path.split('/')), entry.size);
    if (!bytes || sha256Hex(bytes) !== entry.sha256) unstableBase(layout, reservation, root.id, ['working-tree']);
    storeBlob(layout, entry.sha256, bytes);
    stored.add(entry.sha256);
  }
  const roots = codeRootsApi();
  return { root_id: root.id, identity_sha256: root.identity_sha256, path_key: roots.key(root.path), common_dir_key: roots.key(classified.commonDir),
    object_format: classified.format, head: classified.head, observation: classified.observation,
    index: { entries: classified.entryCount, blob: classified.observation.stage_sha256 }, status: classified.status,
    untracked: classified.untracked, gsd_tracked: classified.gsdTracked, excluded: classified.excluded, inventory };
}

/**
 * Measures the base of every integration root of a reserved cohort and publishes it once.
 * Returns { status: 'captured', base } (base.replay when the package was already published
 * and every root still holds it) or { status: 'unsupported', reason_code, detail, root_id }.
 */
function captureBatchBase(reservationHandle, integrationContract, trusted = {}) {
  const reservation = batchAuthority().resolveIsolationHandle(reservationHandle, 'reservation');
  if (stableDigest(integrationContract) !== stableDigest(reservation.contract)) {
    isolationRefuse('batch-isolation-contract-mismatch', 'the integration contract is not the one of this reservation');
  }
  const contract = revalidatedContract(reservation);
  for (const root of contract.code_roots) {
    if (root.vcs !== 'git') return unsupportedBase(root.vcs === 'svn' ? 'svn-isolation-unavailable' : 'vcs-isolation-unavailable', null, root.id);
  }
  const limits = limitsOf(trusted.limits);
  const layout = batchLayout(reservation, contract);
  // Replay: the published package IS the base while every root still holds it.
  const published = readPackage(layout, reservation, contract, true);
  if (published) {
    assertRootsUnchanged(published, contract);
    return capturedBase(layout, published, true);
  }
  for (const member of reservation.members) {
    for (const ref of member.roots) {
      const root = contract.code_roots.find(candidate => candidate.id === ref.root_id);
      if (!root) isolationRefuse('batch-isolation-contract-mismatch', `${member.task_id} names a root outside the contract`);
      if (!branchValid(root.path, memberLayout(layout, reservation, member, root).branch)) return unsupportedBase('materialization-unsupported', 'ref-invalid', root.id);
    }
  }
  const measured = [];
  for (const root of contract.code_roots) {
    const classified = classifyRoot(root, reservation, limits);
    if (classified.unstable) unstableBase(layout, reservation, root.id, classified.unstable);
    if (classified.detail) return unsupportedBase('materialization-unsupported', classified.detail, root.id);
    const rows = [...classified.tracked.map(entry => ({ path: entry.path, tracked: true, oid: entry.oid })),
      ...classified.untracked.map(rel => ({ path: rel, tracked: false, oid: null, provenance: inputOrigins(reservation, root.id, rel) }))];
    const counted = inventoryRoot(root.path, rows, classified.format, limits);
    if (counted.unstable) unstableBase(layout, reservation, root.id, ['working-tree']);
    if (counted.detail) return unsupportedBase('materialization-unsupported', counted.detail, root.id);
    measured.push({ root, classified, inventory: counted.inventory });
  }
  failpoint(trusted, 'base-inventory-read');
  // Measured again after every byte was read: a moving source is refused, never captured.
  for (const row of measured) {
    const after = observationOf(row.root.path);
    const changed = STABILITY_KEYS.filter(key => after[key] !== row.classified.observation[key]);
    if (movedPath(row.root.path, row.inventory)) changed.push('working-tree');
    if (changed.length) unstableBase(layout, reservation, row.root.id, changed);
  }
  ensureBatchArea(layout);
  const roots = measured.map(row => packageRoot(layout, reservation, row));
  const content = { schema: BATCH_BASE_SCHEMA, batch: bindingOf(reservation),
    layout: { batch_dir_key: codeRootsApi().key(layout.batch_dir), anchor: layout.anchor, branch_base: layout.branch_base },
    roots, captured_at: new Date().toISOString() };
  const bytes = Buffer.from(`${JSON.stringify({ ...content, package_sha256: stableDigest(content) })}\n`, 'utf8');
  if (bytes.length > limits.packageBytes) return unsupportedBase('materialization-unsupported', 'limits-exceeded', null);
  ensureRealDirs(layout.batch_dir, ['base']);
  const fresh = publishBuffer(layout, packageFile(layout), bytes);
  // Re-read what was published (or what a concurrent capture published first) and check it.
  const reread = readPackage(layout, reservation, contract, false);
  if (!fresh) assertRootsUnchanged(reread, contract);
  verifyPackageBlobs(layout, reread);
  failpoint(trusted, 'base-captured');
  return capturedBase(layout, reread, !fresh);
}

// ── Member worktree: journal, checkout identity, materialization, verification ──
function journalName(sequence) { return `${String(sequence).padStart(4, '0')}.json`; }
function readJournal(dir, binding) {
  const bad = detail => isolationRefuse('batch-journal-invalid', detail);
  const found = lstatOrNull(dir);
  if (!found) return [];
  if (found.isSymbolicLink() || !found.isDirectory()) bad('the provisioning journal is not a real directory');
  const names = fs.readdirSync(dir).sort();
  if (names.length > JOURNAL_PHASES.length || names.some((name, index) => name !== journalName(index + 1))) bad('the provisioning journal holds unexpected entries');
  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name), stat = lstatOrNull(file);
    const bytes = stat && stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536 ? stableRead(file, stat.size) : null;
    let entry = null;
    try { entry = bytes ? JSON.parse(UTF8_PATH.decode(bytes)) : null; } catch (_) { entry = null; }
    if (!plainObject(entry)) bad(`${name} is unreadable`);
    const { entry_sha256: sealed, ...content } = entry;
    if (entry.schema !== BATCH_JOURNAL_SCHEMA || sealed !== stableDigest(content) || entry.sequence !== entries.length + 1
        || entry.phase !== JOURNAL_PHASES[entries.length]) bad(`${name} is not a sealed provisioning step`);
    if (!plainObject(entry.binding) || stableDigest(entry.binding) !== stableDigest(binding)) {
      isolationRefuse('batch-member-path-occupied', 'the provisioning journal belongs to another member attempt');
    }
    if (entry.previous_sha256 !== (entries.length ? entries[entries.length - 1].entry_sha256 : stableDigest(binding))) bad(`${name} is not linked to its predecessor`);
    entries.push(entry);
  }
  return entries;
}
function appendJournal(layout, segments, binding, entries, phase, extra) {
  if (JOURNAL_PHASES[entries.length] !== phase) isolationRefuse('batch-journal-invalid', `${phase} cannot follow the journal`);
  const content = { schema: BATCH_JOURNAL_SCHEMA, sequence: entries.length + 1, phase, binding,
    previous_sha256: entries.length ? entries[entries.length - 1].entry_sha256 : stableDigest(binding), extra: extra || null,
    at: new Date().toISOString() };
  const entry = { ...content, entry_sha256: stableDigest(content) };
  const dir = ensureRealDirs(layout.batch_dir, segments);
  if (!publishBuffer(layout, path.join(dir, journalName(content.sequence)), Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'))) {
    isolationRefuse('batch-journal-invalid', 'another writer advanced this provisioning journal');
  }
  return [...entries, entry];
}
function refExists(at, branch) {
  const probe = batchGitStatus(at, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (probe.status === 0) return true;
  if (probe.status === 1) return false;
  return isolationRefuse('batch-member-ref-occupied', 'the member ref could not be inspected');
}
// The registered linked worktree of the integration repository, on its own ref, at HEAD.
function assertMemberCheckout(integration, target, branch, base) {
  const identity = validateWorktreeIdentity(integration.path, target, branch);
  if (!identity.ok) isolationRefuse('batch-member-unreconciled', `the member root is not this batch worktree (${identity.reason})`);
  if (readHead(target) !== base.head) isolationRefuse('batch-member-unreconciled', 'the member root is not at the measured HEAD');
}
// The checkout `worktree add --no-checkout` leaves: only `.git`, an empty index.
function pristine(target) {
  let names;
  try { names = fs.readdirSync(target); } catch (_) { return false; }
  if (names.length !== 1 || names[0] !== '.git') return false;
  const stage = listing(target, STAGE_ARGS);
  return Buffer.isBuffer(stage) && stage.length === 0;
}
function ensureMemberDirs(target, parts, dirs) {
  let rel = '';
  for (const part of parts) {
    rel = rel ? `${rel}/${part}` : part;
    if (dirs.has(rel)) continue;
    const dir = path.join(target, ...rel.split('/'));
    let stat = lstatOrNull(dir);
    if (!stat) {
      try { fs.mkdirSync(dir); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) isolationRefuse('batch-member-unreconciled', `${rel} is not a real directory in the member root`);
    dirs.add(rel);
  }
}
// Exclusive creation; an existing file (a resumed materialization) must already hold the bytes.
function writeMemberFile(target, entry, bytes, dirs) {
  const parts = entry.path.split('/');
  ensureMemberDirs(target, parts.slice(0, -1), dirs);
  const file = path.join(target, ...parts), mode = entry.exec ? 0o755 : 0o644, existing = lstatOrNull(file);
  if (existing) {
    const current = existing.isFile() && !existing.isSymbolicLink() ? stableRead(file, existing.size) : null;
    if (!current || !current.equals(bytes)) isolationRefuse('batch-member-unreconciled', `${entry.path} already differs from the base in the member root`);
  } else {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode });
  }
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}
function objectChunks(entries) {
  const byOid = new Map(), chunks = [];
  for (const entry of entries) {
    if (!byOid.has(entry.oid)) byOid.set(entry.oid, []);
    byOid.get(entry.oid).push(entry);
  }
  let current = null;
  for (const [oid, group] of byOid) {
    const known = group[0].size === null ? 0 : group[0].size;
    if (!current || current.oids.length >= 512 || (current.oids.length && current.bytes + known > BATCH_BASE_LIMITS.chunkBytes)) {
      current = { oids: [], entries: [], bytes: 0, unknown: 0 };
      chunks.push(current);
    }
    current.oids.push(oid);
    current.entries.push(...group);
    current.bytes += known;
    if (group[0].size === null) current.unknown += 1;
  }
  return chunks;
}
// Raw blobs by id (`cat-file --batch`, no filter, no textconv, no replace refs).
function readObjects(cwd, chunk) {
  const cap = Math.min(BATCH_BASE_LIMITS.totalBytes, chunk.bytes + chunk.unknown * BATCH_BASE_LIMITS.fileBytes) + chunk.oids.length * 160 + 4096;
  let out;
  try { out = batchGit(cwd, ['cat-file', '--batch'], { input: Buffer.from(`${chunk.oids.join('\n')}\n`, 'latin1'), maxBuffer: cap }); }
  catch (error) { return isolationRefuse('batch-base-invalid', `the object database could not provide the base blobs: ${firstLine(error)}`); }
  const objects = new Map();
  let at = 0;
  for (const oid of chunk.oids) {
    const newline = out.indexOf(0x0a, at);
    const header = newline < 0 ? [] : out.subarray(at, newline).toString('latin1').split(' ');
    if (header.length !== 3 || header[0] !== oid || header[1] !== 'blob' || !/^\d+$/.test(header[2])) isolationRefuse('batch-base-invalid', 'the object database returned another object');
    const start = newline + 1, end = start + Number(header[2]);
    if (end >= out.length || out[end] !== 0x0a) isolationRefuse('batch-base-invalid', 'the object database returned a truncated blob');
    objects.set(oid, out.subarray(start, end));
    at = end + 1;
  }
  if (at !== out.length) isolationRefuse('batch-base-invalid', 'the object database returned extra objects');
  return objects;
}
// The member's OWN index from the measured logical entries, then the working-tree bytes:
// packaged blobs for every dirty or untracked file, raw index blobs for the rest.
function materializeMember(layout, target, base) {
  const stage = readBlob(layout, base.index.blob);
  const current = listing(target, STAGE_ARGS);
  if (!Buffer.isBuffer(current)) isolationRefuse('batch-member-unreconciled', 'the member index cannot be listed');
  if (!current.length) {
    try { batchGit(target, ['update-index', '-z', '--index-info'], { input: stage }); }
    catch (error) { isolationRefuse('batch-member-unreconciled', `the member index could not be built: ${firstLine(error)}`); }
  } else if (!current.equals(stage)) isolationRefuse('batch-member-unreconciled', 'the member index holds entries this base does not');
  const dirs = new Set(), files = base.inventory.filter(entry => entry.type === 'file');
  for (const entry of files) if (entry.source === 'package') writeMemberFile(target, entry, readBlob(layout, entry.sha256), dirs);
  const fromObjects = [...files.filter(entry => entry.source === 'odb'),
    ...base.gsd_tracked.map(entry => ({ path: entry.path, oid: entry.oid, exec: entry.exec, sha256: null, size: null }))];
  for (const chunk of objectChunks(fromObjects)) {
    const objects = readObjects(target, chunk);
    for (const entry of chunk.entries) {
      const bytes = objects.get(entry.oid);
      if (!bytes || (entry.sha256 !== null && sha256Hex(bytes) !== entry.sha256)) isolationRefuse('batch-base-invalid', `${entry.path} is not the measured blob`);
      writeMemberFile(target, entry, bytes, dirs);
    }
  }
}
// Independent of checkout filters and line endings: logical index and flags, the real bytes
// and exec bit of every inventory path, the untracked set and what git itself reports.
function verifyMember(target, base) {
  const fail = detail => isolationRefuse('batch-member-verification-failed', detail);
  if (readHead(target) !== base.head) fail('the member HEAD is not the measured HEAD');
  const stage = listing(target, STAGE_ARGS), tags = listing(target, TAGS_ARGS);
  if (!Buffer.isBuffer(stage) || sha256Hex(stage) !== base.observation.stage_sha256) fail('the member index is not the measured logical index');
  if (!Buffer.isBuffer(tags) || sha256Hex(tags) !== base.observation.tags_sha256) fail('the member index flags are not the measured ones');
  const cache = new Map();
  for (const entry of base.inventory) {
    const parent = parentProblem(target, entry.path, cache);
    if (parent === 'symlink' || parent === 'type-change') fail(`${entry.path}: a parent is not a real directory`);
    const file = path.join(target, ...entry.path.split('/'));
    const stat = parent === 'missing' ? null : lstatOrNull(file);
    if (entry.type === 'absent') { if (stat) fail(`${entry.path} must stay deleted`); continue; }
    const bytes = stat && stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.size ? stableRead(file, stat.size) : null;
    if (!bytes || sha256Hex(bytes) !== entry.sha256) fail(`${entry.path} does not hold the measured bytes`);
    if (entry.exec !== null && ((stat.mode & 0o100) !== 0) !== entry.exec) fail(`${entry.path} does not keep its mode`);
  }
  const others = listing(target, UNTRACKED_ARGS), tokens = Buffer.isBuffer(others) ? splitNul(others) : null;
  const untracked = tokens ? tokens.map(decodePath) : null;
  if (!untracked || untracked.includes(null) || JSON.stringify(untracked) !== JSON.stringify(base.untracked)) {
    fail('the member untracked files are not the measured legitimate ones');
  }
  const status = listing(target, STATUS_ARGS), reported = Buffer.isBuffer(status) ? parseStatus(status) : null;
  if (!reported || !reported.entries || JSON.stringify(statusList(reported.entries)) !== JSON.stringify(base.status)) {
    fail('git does not see the measured staged and unstaged state in the member');
  }
}
function memberDependencySpec(owner, target) {
  const enabled = readIsolationPrefs(owner).worktreeInstallDeps !== false;
  const manager = enabled ? resolvePackageManager(target) : null;
  const lock = manager && ({ npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' })[manager.manager];
  const measured = relative => {
    const file = path.join(target, relative), stat = lstatOrNull(file);
    const bytes = stat && stat.isFile() && !stat.isSymbolicLink() && stat.size <= BATCH_BASE_LIMITS.fileBytes
      ? stableRead(file, stat.size) : null;
    if (!bytes) isolationRefuse('batch-member-verification-failed', 'dependency input is not a bounded stable member file');
    return sha256Hex(bytes);
  };
  return { enabled, manager: manager ? manager.manager : null,
    package_sha256: manager ? measured('package.json') : null,
    lock_sha256: lock ? measured(lock) : null };
}
function memberLeaseCheckpoint(trusted, stage, requiredMs = 0) {
  if (typeof trusted.leaseCheckpoint === 'function') trusted.leaseCheckpoint({ stage, required_ms: requiredMs });
}
function provisionMemberRoot(context) {
  const { layout, reservation, member, integration, base, pkg, placed, trusted } = context;
  const { target, branch } = placed;
  const binding = { ...bindingOf(reservation), member_index: member.member_index, task_id: member.task_id, begin_key: member.begin_key,
    lease_generation: member.lease_generation, root_id: integration.id, root_identity_sha256: integration.identity_sha256,
    package_sha256: pkg.package_sha256, head: base.head, target_key: codeRootsApi().key(target), branch };
  const segments = ['journal', placed.member_hash, placed.root_hash];
  let entries = readJournal(path.join(layout.batch_dir, ...segments), binding);
  let phase = entries.length ? entries[entries.length - 1].phase : null;
  const replay = phase === 'verified';
  memberLeaseCheckpoint(trusted, 'before-materialization');
  if (phase === null) {
    // A fresh attempt owns nothing yet: a directory or ref of the same name is not ours.
    if (lstatOrNull(target)) isolationRefuse('batch-member-path-occupied', 'the member root path exists without its provisioning journal');
    if (refExists(integration.path, branch)) isolationRefuse('batch-member-ref-occupied', 'the member ref exists without its provisioning journal');
    ensureRealDirs(layout.batch_dir, [placed.member_hash]);
    entries = appendJournal(layout, segments, binding, entries, 'intent', null);
    failpoint(trusted, 'member-intent-recorded');
    phase = 'intent';
  }
  if (phase === 'intent') {
    if (!lstatOrNull(target)) {
      if (refExists(integration.path, branch)) isolationRefuse('batch-member-unreconciled', 'the member ref exists but its worktree was never created');
      try {
        batchGit(integration.path, ['-c', `core.hooksPath=${path.join(layout.batch_dir, '.no-hooks')}`, 'worktree', 'add',
          '--no-checkout', '-b', branch, '--', target, base.head]);
      } catch (error) { isolationRefuse('batch-member-unreconciled', `git worktree add failed: ${firstLine(error)}`); }
    }
    assertMemberCheckout(integration, target, branch, base);
    if (!pristine(target)) isolationRefuse('batch-member-unreconciled', 'the member worktree is not the empty checkout this journal created');
    entries = appendJournal(layout, segments, binding, entries, 'worktree', null);
    failpoint(trusted, 'member-worktree-created');
    phase = 'worktree';
  }
  assertMemberCheckout(integration, target, branch, base);
  if (phase === 'worktree') {
    materializeMember(layout, target, base);
    failpoint(trusted, 'member-materialized');
  }
  verifyMember(target, base);
  assertRootUnchanged(base, integration);
  const dependencySpec = memberDependencySpec(reservation.owner, target);
  let dependencyProvisioning;
  if (phase === 'worktree') {
    memberLeaseCheckpoint(trusted, 'before-install', dependencySpec.enabled && dependencySpec.manager ? WORKTREE_INSTALL_TIMEOUT_MS : 0);
    const installed = installWorktreeDeps(target, target, { enabled: dependencySpec.enabled,
      ...(typeof trusted.dependencyRunner === 'function' ? { runner: trusted.dependencyRunner } : {}) });
    memberLeaseCheckpoint(trusted, 'after-install');
    if (!['installed', 'disabled', 'no-lockfile'].includes(installed.status)) {
      isolationRefuse('batch-member-verification-failed', `member dependency provisioning failed: ${installed.error || installed.status}`);
    }
    // Lifecycle scripts must not alter the measured sources, index, head or integration root.
    verifyMember(target, base);
    assertMemberCheckout(integration, target, branch, base);
    assertRootUnchanged(base, integration);
    if (stableDigest(memberDependencySpec(reservation.owner, target)) !== stableDigest(dependencySpec)) {
      isolationRefuse('batch-member-verification-failed', 'dependency provisioning changed its configuration or lockfile');
    }
    dependencyProvisioning = { ...dependencySpec, status: installed.status };
  } else {
    dependencyProvisioning = entries[entries.length - 1].extra?.dependency_provisioning;
    const expectedStatus = !dependencySpec.enabled ? 'disabled' : dependencySpec.manager ? 'installed' : 'no-lockfile';
    if (dependencyProvisioning === undefined && dependencySpec.enabled && dependencySpec.manager) {
      isolationRefuse('batch-member-unreconciled', 'the verified member has no dependency provisioning evidence');
    }
    if (dependencyProvisioning !== undefined && stableDigest(dependencyProvisioning) !== stableDigest({ ...dependencySpec, status: expectedStatus })) {
      isolationRefuse('batch-member-unreconciled', 'dependency provisioning no longer matches the verified member');
    }
  }
  let identity;
  try { identity = codeRootsApi().measureRoot({ id: integration.id, path: target, vcs: 'git' }).identity_sha256; }
  catch (error) { return isolationRefuse('batch-member-verification-failed', `the member root is not a measurable checkout (${error && error.code})`); }
  if (phase === 'worktree') entries = appendJournal(layout, segments, binding, entries, 'verified', { identity_sha256: identity,
    dependency_provisioning: dependencyProvisioning });
  else if (!plainObject(entries[entries.length - 1].extra) || entries[entries.length - 1].extra.identity_sha256 !== identity) {
    isolationRefuse('batch-member-unreconciled', 'the verified member root was replaced');
  }
  memberLeaseCheckpoint(trusted, 'after-materialization');
  return { root_id: integration.id, path: target, branch, head: base.head, integration_identity_sha256: integration.identity_sha256,
    identity_sha256: identity, journal_sha256: entries[entries.length - 1].entry_sha256, replay };
}

/**
 * One exclusive worktree and index per root of ONE member, from the published base.
 * Returns { status: 'prepared', member } (each root: path, branch, head, identities, journal
 * digest, replay) or { status: 'unsupported', reason_code, detail, root_id }.
 */
function setupForBatchMember(memberHandle, baseRef, trusted = {}) {
  const member = batchAuthority().resolveIsolationHandle(memberHandle, 'member');
  const reservation = member.reservation;
  const contract = revalidatedContract(reservation);
  const layout = batchLayout(reservation, contract), keyOf = codeRootsApi().key;
  if (!plainObject(baseRef) || typeof baseRef.package_sha256 !== 'string' || !SHA256_RE.test(baseRef.package_sha256)
      || typeof baseRef.batch_dir !== 'string' || keyOf(baseRef.batch_dir) !== keyOf(layout.batch_dir)) {
    isolationRefuse('batch-base-invalid', 'the base reference does not name this batch package');
  }
  const pkg = readPackage(layout, reservation, contract, false);
  if (pkg.package_sha256 !== baseRef.package_sha256) isolationRefuse('batch-base-invalid', 'the base reference names another package');
  const roots = [];
  for (const ref of member.roots) {
    const index = contract.code_roots.findIndex(root => root.id === ref.root_id), integration = contract.code_roots[index];
    if (!integration || integration.identity_sha256 !== ref.identity_sha256) isolationRefuse('batch-root-foreign', `${ref.root_id} is not the reserved integration root`);
    const base = pkg.roots[index];
    // The package must still describe the integration root before a member is built from it.
    assertRootUnchanged(base, integration);
    const placed = memberLayout(layout, reservation, member, integration);
    if (!branchValid(integration.path, placed.branch)) return unsupportedBase('materialization-unsupported', 'ref-invalid', integration.id);
    roots.push(provisionMemberRoot({ layout, reservation, member, integration, base, pkg, placed, trusted }));
  }
  return freezeDeep({ status: 'prepared', member: { batch_id: reservation.batch_id, manifest_sha256: reservation.manifest_sha256,
    member_index: member.member_index, task_id: member.task_id, begin_key: member.begin_key, lease_generation: member.lease_generation,
    package_sha256: pkg.package_sha256, roots } });
}

// ── Issue 343 U5: same-run integration of verified member deltas, and cleanup (B5) ──
//
// After the barrier, the serial consolidation of forge-execution-batch integrates each published
// member's verified delta (the difference after the measured base, never the base itself) into the
// run's integration target, one member at a time in manifest order. The target must still hold exactly
// the measured base plus the deltas already consolidated: HEAD, the logical index and its flags, every
// inventory path's bytes and the untracked set (the member's own delta paths may hold their
// precondition or, on a replay, their verified bytes). Anything else is a named conflict that writes
// nothing. Only working-tree bytes are written (atomic replace, delete, exec bit); the index, HEAD,
// refs, stash and commits are never touched and no owner metadata (.gsd) ever enters. Cleanup plans per
// member root and removes only what is admissible (every sibling terminal, a clean root no reader needs
// and the parent claim no longer names), revalidating its Git registration right before the effect; it
// never resets, commits or forces. Authority is the consolidation's opaque cohort handle of
// forge-execution-batch (resolveConsolidationCohort revalidates it); nothing here mints any.
//   checkBatchIntegration(cohortHandle, { consolidated, member? })  read-only precondition or recheck
//   integrateBatchMember(cohortHandle, { consolidated, member })     the member's writes, idempotent
//   planBatchCleanup(cohortHandle)                                   the retention plan, no effect
//   cleanupBatchMember(cohortHandle, memberIndex)                    only admissible removals
const BATCH_INTEGRATION_REFUSALS = Object.freeze(['batch-integration-delta-invalid', 'batch-integration-conflict',
  'batch-integration-readback-failed', 'batch-cleanup-member-unknown']);
const BATCH_INTEGRATION_CONFLICTS = Object.freeze(['integration-target-moved', 'integration-conflict', 'integration-mode-unsupported']);
const BATCH_CLEANUP_REASONS = Object.freeze(['member-root-identity-unknown', 'batch-members-pending', 'member-root-status-unknown',
  'member-root-dirty', 'delivery-evidence-dependency', 'attempt-evidence-dependency', 'claim-retains-root']);
const TERMINAL_PROGRESS = Object.freeze(['ack', 'falhou', 'bloqueado']);

// One anchored member path: { root_id, path, sha256, exec }; deletion/Windows exec is null.
function deltaRows(rows, contract) {
  if (!Array.isArray(rows)) isolationRefuse('batch-integration-delta-invalid', 'a delta is a list of verified paths');
  const seen = new Set();
  return rows.map(row => {
    if (!plainObject(row) || Object.keys(row).sort().join(',') !== 'exec,path,root_id,sha256' || !contract.code_roots.some(root => root.id === row.root_id)
        || pathProblem(row.path) || isGsdPath(row.path) || baseExclusion(row.path)
        || (row.sha256 !== null && (typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)))
        || (row.sha256 === null || process.platform === 'win32' ? row.exec !== null : typeof row.exec !== 'boolean')) {
      isolationRefuse('batch-integration-delta-invalid', `${plainObject(row) ? String(row.path) : 'a row'} is not a verified member path`);
    }
    const key = `${row.root_id}\u0000${row.path}`;
    if (seen.has(key)) isolationRefuse('batch-integration-delta-invalid', `${row.path} is listed twice`);
    seen.add(key);
    return { root_id: row.root_id, path: row.path, sha256: row.sha256, exec: row.exec };
  });
}
// The integration contract re-measured, the batch's own sealed base package, and per root: the
// consolidated deltas and this member's delta.
function integrationPlan(cohort, input) {
  const reservation = cohort.reservation, contract = revalidatedContract(reservation);
  const layout = batchLayout(reservation, contract);
  if (codeRootsApi().key(layout.batch_dir) !== codeRootsApi().key(cohort.base.batch_dir)) isolationRefuse('batch-base-invalid', 'the consolidation names another batch area');
  const pkg = readPackage(layout, reservation, contract, false);
  if (pkg.package_sha256 !== cohort.base.package_sha256) isolationRefuse('batch-base-invalid', 'the consolidation names another base package');
  const consolidated = deltaRows(plainObject(input) ? input.consolidated : null, contract);
  let member = null;
  if (plainObject(input) && input.member !== undefined) {
    const placed = plainObject(input.member) ? cohort.members.find(row => row.member_index === input.member.member_index) : null;
    if (!placed) isolationRefuse('batch-integration-delta-invalid', 'the delta names no prepared member');
    const delta = deltaRows(input.member.delta, contract);
    if (delta.some(row => !placed.roots.some(root => root.root_id === row.root_id))) isolationRefuse('batch-integration-delta-invalid', 'the delta names a root of another member');
    const taken = new Set(consolidated.map(row => `${row.root_id}\u0000${row.path}`));
    if (delta.some(row => taken.has(`${row.root_id}\u0000${row.path}`))) isolationRefuse('batch-integration-delta-invalid', 'two members changed one path');
    member = { placed, delta };
  }
  const roots = contract.code_roots.map((root, index) => ({ root, base: pkg.roots[index],
    consolidated: new Map(consolidated.filter(row => row.root_id === root.id).map(row => [row.path, { sha256: row.sha256, exec: row.exec }])),
    member: new Map(member ? member.delta.filter(row => row.root_id === root.id).map(row => [row.path, { sha256: row.sha256, exec: row.exec }]) : []) }));
  return { contract, roots, member, layout };
}
// On Windows the filesystem cannot attest an executable bit. Do not turn that null into
// success for a new Git executable-mode intention: retain it by name before publication/apply.
// The immutable index of the base is authoritative; the member's current index is observed only
// to refuse an unrepresentable change, never to derive or authorize a target mode.
function unobservableMemberMode(plan) {
  if (process.platform !== 'win32' || !plan.member) return null;
  for (const entry of plan.roots) {
    if (!entry.member.size) continue;
    const placed = plan.member.placed.roots.find(row => row.root_id === entry.root.id);
    const unsupported = rel => ({ reason_code: 'integration-mode-unsupported', root_id: entry.root.id, path: rel, detail: 'mode-not-observable' });
    const raw = listing(placed.path, STAGE_ARGS);
    const current = Buffer.isBuffer(raw) ? parseStage(raw, entry.base.object_format) : null;
    if (!current || current.detail) return unsupported(null);
    const original = parseStage(readBlob(plan.layout, entry.base.index.blob), entry.base.object_format);
    if (original.detail) return unsupported(null);
    const before = new Map(original.entries.map(row => [row.path, row.mode]));
    const now = new Map(current.entries.map(row => [row.path, row.mode]));
    for (const [rel, verified] of entry.member) {
      if (verified.sha256 === null) continue;
      const oldMode = before.get(rel), newMode = now.get(rel);
      if (oldMode && newMode && oldMode !== newMode || oldMode === '100755' && !newMode
          || !oldMode && newMode === '100755') return unsupported(rel);
    }
  }
  return null;
}
// sha256 of a regular file's real bytes, null when absent, 'unsafe' for a link, a directory or a
// parent that is not a real directory.
function targetSha(rootReal, rel, cache) {
  const parent = parentProblem(rootReal, rel, cache);
  if (parent === 'missing') return null;
  if (parent) return 'unsafe';
  const file = path.join(rootReal, ...rel.split('/')), stat = lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe';
  const bytes = stableRead(file, stat.size);
  return bytes ? sha256Hex(bytes) : 'unsafe';
}
// The full verified file state: bytes plus the platform's executable-mode authority.
function targetMatches(rootReal, rel, expected, cache) {
  if (targetSha(rootReal, rel, cache) !== expected.sha256) return false;
  if (expected.sha256 === null || process.platform === 'win32') return expected.exec === null;
  const stat = lstatOrNull(path.join(rootReal, ...rel.split('/')));
  return !!stat && stat.isFile() && !stat.isSymbolicLink() && typeof expected.exec === 'boolean'
    && ((Number(stat.mode) & 0o100) !== 0) === expected.exec;
}
// null when the target root holds exactly the base plus the consolidated deltas (this member's delta
// paths: at their precondition or their verified bytes in 'replay', only verified bytes in 'exact').
function targetVerdict(entry, mode) {
  const { root, base, consolidated, member } = entry, at = root.path;
  if (readHead(at) !== base.head) return { reason_code: 'integration-target-moved', root_id: root.id, path: null, detail: 'head' };
  const stage = listing(at, STAGE_ARGS), tags = listing(at, TAGS_ARGS);
  if (!Buffer.isBuffer(stage) || sha256Hex(stage) !== base.observation.stage_sha256 || !Buffer.isBuffer(tags) || sha256Hex(tags) !== base.observation.tags_sha256) {
    return { reason_code: 'integration-target-moved', root_id: root.id, path: null, detail: 'index' };
  }
  const expected = new Map(base.inventory.map(row => [row.path, { sha256: row.type === 'file' ? row.sha256 : null, exec: row.type === 'file' ? row.exec : null }]));
  for (const [rel, sha] of consolidated) expected.set(rel, sha);
  const cache = new Map();
  for (const [rel, wanted] of expected) {
    if (member.has(rel)) continue;
    if (!targetMatches(at, rel, wanted, cache)) return { reason_code: 'integration-conflict', root_id: root.id, path: rel, detail: 'bytes-or-mode' };
  }
  for (const [rel, after] of member) {
    const before = expected.has(rel) ? expected.get(rel) : { sha256: null, exec: null };
    const matchesAfter = targetMatches(at, rel, after, cache);
    if (mode === 'exact' ? !matchesAfter : !matchesAfter && !targetMatches(at, rel, before, cache)) {
      return { reason_code: 'integration-conflict', root_id: root.id, path: rel, detail: 'delta' };
    }
  }
  const others = listing(at, UNTRACKED_ARGS), listed = Buffer.isBuffer(others) ? pathList(others) : null;
  if (!listed) return { reason_code: 'integration-conflict', root_id: root.id, path: null, detail: 'untracked' };
  const tracked = new Set(base.inventory.filter(row => row.tracked).map(row => row.path)), wanted = new Set(base.untracked);
  // Declared outputs remain byte/mode verified above even when Git ignores them.
  // Only the expected ls-files membership follows the real checkout's ignore rules.
  const newFiles = [...consolidated].filter(([rel, value]) => !tracked.has(rel) && value.sha256 !== null).map(([rel]) => rel);
  let ignored = new Set();
  if (newFiles.length) {
    let output;
    try { output = batchGit(at, ['check-ignore', '-z', '--stdin'], { input: Buffer.from(`${newFiles.join('\0')}\0`, 'utf8') }); }
    catch (error) {
      if (error && error.status === 1 && Buffer.isBuffer(error.stdout)) output = error.stdout;
      else return { reason_code: 'integration-conflict', root_id: root.id, path: null, detail: 'ignore-query' };
    }
    const paths = Buffer.isBuffer(output) ? pathList(output) : null;
    if (!paths || paths.some(rel => !newFiles.includes(rel))) return { reason_code: 'integration-conflict', root_id: root.id, path: null, detail: 'ignore-query' };
    ignored = new Set(paths);
  }
  for (const [rel, sha] of consolidated) {
    if (tracked.has(rel)) continue;
    if (sha.sha256 === null || ignored.has(rel)) wanted.delete(rel); else wanted.add(rel);
  }
  for (const rel of member.keys()) wanted.delete(rel);
  const actual = listed.filter(rel => !member.has(rel));
  const extra = actual.find(rel => !wanted.has(rel)), missing = [...wanted].find(rel => !actual.includes(rel));
  if (extra !== undefined || missing !== undefined) {
    return { reason_code: 'integration-conflict', root_id: root.id, path: extra !== undefined ? extra : missing, detail: 'untracked' };
  }
  return null;
}
// Atomic replace through a temporary sibling, real parent directories only.
function writeTargetFile(rootReal, rel, bytes, exec) {
  const parts = rel.split('/');
  let dir = rootReal;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let stat = lstatOrNull(dir);
    if (!stat) {
      try { fs.mkdirSync(dir); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) isolationRefuse('batch-integration-conflict', `${rel}: a parent is not a real directory`);
  }
  const name = parts[parts.length - 1], file = path.join(dir, name), existing = lstatOrNull(file);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) isolationRefuse('batch-integration-conflict', `${rel} is not a regular file`);
  const mode = exec === true ? 0o755 : exec === false ? 0o644 : existing ? Number(existing.mode) & 0o777 : 0o644;
  const temporary = path.join(dir, `.${name}.forge-batch-${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', mode);
    created = true;
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
    created = false;
  } finally {
    if (created) { try { fs.unlinkSync(temporary); } catch (_) { /* a temporary is never product */ } }
  }
}
function removeTargetFile(rootReal, rel) {
  const file = path.join(rootReal, ...rel.split('/')), stat = lstatOrNull(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) isolationRefuse('batch-integration-conflict', `${rel} is not a regular file`);
  fs.unlinkSync(file);
}

/** Read-only: { status: 'ready' } or { status: 'conflict', reason_code, root_id, path, detail }. */
function checkBatchIntegration(cohortHandle, input = {}) {
  const cohort = batchAuthority().resolveConsolidationCohort(cohortHandle);
  const plan = integrationPlan(cohort, input);
  const mode = unobservableMemberMode(plan);
  if (mode) return freezeDeep({ status: 'conflict', ...mode });
  for (const entry of plan.roots) {
    const verdict = targetVerdict(entry, 'replay');
    if (verdict) return freezeDeep({ status: 'conflict', ...verdict });
  }
  return freezeDeep({ status: 'ready', roots: plan.roots.map(entry => entry.root.id) });
}

/**
 * Integrates one published member's verified delta into the integration target. A conflict writes
 * nothing; a replay applies only what is still missing. Returns { status: 'integrated', applied,
 * already, delta_sha256 } or { status: 'conflict', reason_code, root_id, path, detail }.
 */
function integrateBatchMember(cohortHandle, input = {}) {
  const cohort = batchAuthority().resolveConsolidationCohort(cohortHandle);
  const plan = integrationPlan(cohort, input);
  if (!plan.member) isolationRefuse('batch-integration-delta-invalid', 'a member delta is required');
  const mode = unobservableMemberMode(plan);
  if (mode) return freezeDeep({ status: 'conflict', ...mode, applied: [], already: [] });
  for (const entry of plan.roots) {
    const verdict = targetVerdict(entry, 'replay');
    if (verdict) return freezeDeep({ status: 'conflict', ...verdict, applied: [], already: [] });
  }
  // The verified bytes come from the member's own roots and are all read before the first write.
  const writes = [];
  for (const entry of plan.roots) {
    for (const [rel, verified] of entry.member) {
      const after = verified.sha256, exec = verified.exec;
      const placed = plan.member.placed.roots.find(row => row.root_id === entry.root.id);
      let bytes = null;
      const source = path.join(placed.path, ...rel.split('/')), stat = lstatOrNull(source);
      if (after !== null) {
        bytes = stat && stat.isFile() && !stat.isSymbolicLink() ? stableRead(source, stat.size) : null;
        if (!bytes || sha256Hex(bytes) !== after) isolationRefuse('batch-integration-delta-invalid', `${rel}: the member root no longer holds its verified bytes`);
        const current = lstatOrNull(source);
        if (!current || !current.isFile() || current.isSymbolicLink()
            || ['dev', 'ino', 'size', 'mtimeMs', 'mode'].some(key => stat[key] !== current[key])
            || (process.platform === 'win32' ? exec !== null : ((Number(current.mode) & 0o100) !== 0) !== exec)) {
          isolationRefuse('batch-integration-delta-invalid', rel + ': the member mode is not its anchored mode');
        }
      } else if (stat) isolationRefuse('batch-integration-delta-invalid', rel + ': the member deletion changed');
      writes.push({ root: entry.root, rel, after, bytes, exec });
    }
  }
  const modeAfter = unobservableMemberMode(plan);
  if (modeAfter) return freezeDeep({ status: 'conflict', ...modeAfter, applied: [], already: [] });
  const applied = [], already = [];
  for (const write of writes) {
    const label = `${write.root.id}::${write.rel}`;
    if (targetMatches(write.root.path, write.rel, { sha256: write.after, exec: write.exec }, new Map())) { already.push(label); continue; }
    if (write.after === null) removeTargetFile(write.root.path, write.rel);
    else writeTargetFile(write.root.path, write.rel, write.bytes, write.exec);
    applied.push(label);
  }
  for (const entry of plan.roots) {
    const verdict = targetVerdict(entry, 'exact');
    if (verdict) isolationRefuse('batch-integration-readback-failed', `${verdict.root_id}: ${verdict.path || verdict.detail} does not hold the integrated delivery`);
  }
  return freezeDeep({ status: 'integrated', member_index: plan.member.placed.member_index, applied, already,
    delta_sha256: stableDigest(plan.member.delta) });
}

// The retention decision of one member root; removal only when every condition admits it.
function cleanupDecision(contract, member, root, live, claimed) {
  const retain = reason => ({ decision: 'retained', reason_code: reason });
  const integration = contract.code_roots.find(row => row.id === root.root_id);
  if (!integration || !lstatOrNull(root.path) || !validateWorktreeIdentity(integration.path, root.path, root.branch).ok) return retain('member-root-identity-unknown');
  if (live) return retain('batch-members-pending');
  const status = batchGitStatus(root.path, STATUS_ARGS), reported = status.status === 0 ? parseStatus(status.stdout) : null;
  if (!reported || !reported.entries) return retain('member-root-status-unknown');
  // A dirty base, a member result kept uncommitted (auto_commit false) or any other change stays.
  if (reported.entries.length) return retain('member-root-dirty');
  // Published delivery envelopes and failed attempt receipts name this physical root; no verified
  // archive successor exists for their readers, so the historical root stays.
  if (['publicado', 'integrado', 'ack'].includes(member.state)) return retain('delivery-evidence-dependency');
  if (member.state !== 'bloqueado') return retain('attempt-evidence-dependency');
  if (claimed.has(codeRootsApi().key(root.path))) return retain('claim-retains-root');
  return { decision: 'removable', reason_code: null };
}
/** The cleanup plan of a cohort: one decision per member root, no effect. */
function planBatchCleanup(cohortHandle) {
  const cohort = batchAuthority().resolveConsolidationCohort(cohortHandle);
  const contract = revalidatedContract(cohort.reservation);
  const live = cohort.members.some(member => !TERMINAL_PROGRESS.includes(member.state));
  const claimed = new Set(((cohort.claim && cohort.claim.execution_contract && cohort.claim.execution_contract.code_roots) || [])
    .map(root => codeRootsApi().key(root.path)));
  return freezeDeep({ batch_id: cohort.batch_id, members: cohort.members.map(member => ({ member_index: member.member_index, task_id: member.task_id,
    state: member.state, roots: member.roots.map(root => ({ root_id: root.root_id, path: root.path, branch: root.branch,
      ...cleanupDecision(contract, member, root, live, claimed) })) })) });
}
/** Removes only the admissible roots of one member (revalidated right before; never forced). */
function cleanupBatchMember(cohortHandle, memberIndex) {
  const plan = planBatchCleanup(cohortHandle);
  const member = plan.members.find(row => row.member_index === memberIndex);
  if (!member) isolationRefuse('batch-cleanup-member-unknown', 'the cleanup names no prepared member');
  const contract = revalidatedContract(batchAuthority().resolveConsolidationCohort(cohortHandle).reservation);
  const roots = member.roots.map(root => {
    if (root.decision !== 'removable') return root;
    const integration = contract.code_roots.find(row => row.id === root.root_id);
    if (!integration || !validateWorktreeIdentity(integration.path, root.path, root.branch).ok) {
      return { ...root, decision: 'retained', reason_code: 'member-root-identity-unknown' };
    }
    const removed = batchGitStatus(integration.path, ['worktree', 'remove', '--', root.path]);
    return removed.status === 0 ? { ...root, decision: 'removed', reason_code: null } : { ...root, decision: 'retained', reason_code: 'member-root-dirty' };
  });
  return freezeDeep({ member_index: member.member_index, task_id: member.task_id, state: member.state, roots });
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
  const owner = canonicalDirectory(input.ownerRoot) || ws.resolveOwner(codeDir) || ws.resolveOwner(mainCheckoutOf(codeDir));
  if (owner) {
    const reservation = batchAuthority().memberRootReservation(owner, codeDir);
    if (reservation.reserved) {
      if (!input.memberHandle) return { ok: false, reason_code: reservation.reason_code };
      try { batchAuthority().assertMemberRootOwner(input.memberHandle, codeDir); }
      catch (error) { return { ok: false, reason_code: error.code || 'batch-member-root-exclusive' }; }
    }
  }
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
  validateCodeDirBoundary, validateWorktreeIdentity,
  // Issue 343 U2a: batch dirty base and member worktrees.
  captureBatchBase, setupForBatchMember, BatchIsolationError, BATCH_BASE_LIMITS, BATCH_MATERIALIZATION_DETAILS,
  BATCH_ISOLATION_REFUSALS, BATCH_ISOLATION_FAILPOINTS,
  batchIndexIdentity,
  // Issue 343 U5: same-run integration of verified member deltas and the retaining cleanup.
  checkBatchIntegration, integrateBatchMember, planBatchCleanup, cleanupBatchMember,
  BATCH_INTEGRATION_REFUSALS, BATCH_INTEGRATION_CONFLICTS, BATCH_CLEANUP_REASONS,
};
