#!/usr/bin/env node
'use strict';

/*
 * forge-surgical-reset.js — surgical reset engine + CLI (M013 S01).
 *
 * SAFETY-CRITICAL. This module RESETS a git working tree. A bug here can destroy
 * a user's uncommitted work. Every design decision below is load-bearing; do not
 * "simplify" without re-reading .gsd/milestones/M013/slices/S01/S01-RISK.md.
 *
 * The problem it solves: the sidecar (codex/agy) runs in the user's worktree with
 * auto_commit:false. When the sidecar fails and we fall back to Claude, we must
 * undo ONLY what the sidecar touched — never the work the user already had
 * uncommitted before dispatch. The legacy reset was `git checkout $SHA -- . &&
 * git clean -fd` which nukes ALL uncommitted work (Blocker: destroys pre-existing).
 *
 * The mechanism (locked design — do not deviate):
 *   1. BEFORE dispatch, snapshot the pre-existing dirty set as {path, hash} pairs
 *      (git hash-object of current content; hash:null for a pre-existing deletion).
 *      Persist it in the state file alongside start_sha (survives the poll loop +
 *      auto-compact — shell vars do not).
 *   2. AFTER the run, the reset target = (changes vs START_SHA) MINUS (pre_dirty
 *      paths whose CURRENT hash still equals the snapshot hash).
 *   3. OVERLAP DETECTION (non-negotiable): a pre-dirty tracked file ALWAYS appears
 *      in the post-run diff vs START_SHA even if the sidecar never touched it — a
 *      pure path-set diff cannot tell "intact" from "also-touched". So we re-hash
 *      every pre_dirty path: if any diverged, the sidecar ALSO wrote a pre-dirty
 *      file → abort, reset NOTHING (not even the non-overlapped files), exit 3.
 *
 * VCS I/O is delegated to forge-vcs.js, which uses argv arrays and NUL-delimited
 * parsing so paths with spaces/quotes/newlines remain safe.
 */

const fs = require('fs');
const path = require('path');
const vcs = require('./forge-vcs.js');

const { isGsdPath, parsePorcelainZ, parseNameStatusZ, pruneEmptyParents } = vcs;

/**
 * Named install-artifact rule (S03 B2/W4). S03 is the first networked/npm
 * install path: a failed install can leave thousands of files behind, and
 * comparing them would turn the overlap hard-guard into a volume failure.
 * The 2026-06-10 incident established why this must remain conservative: a
 * dirty worktree was removed with --force. Removing this rule makes the first
 * failed install after npm has run either inoperable or destructive.
 */
function isInstallArtifactPath(p) {
  const normalized = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.split('/').some((segment) => segment === 'node_modules');
}

/**
 * @param {string} p
 * @param {Set<string>} [trackedInstall] paths under node_modules that ARE tracked
 */
function isExcludedPath(p, trackedInstall) {
  if (isGsdPath(p)) return true;
  if (!isInstallArtifactPath(p)) return false;
  // A TRACKED path under node_modules is ordinary version-controlled content; the
  // install rule exists for the thousands of UNTRACKED files a failed install leaves.
  // Excluding a tracked one applied to EVERY site sharing this predicate, including
  // restoreAndRemove and verifyReset: a tracked node_modules file the sidecar modified
  // was never restored, never raised as overlap, and verifyReset then returned
  // verified:true over a tree it had not inspected (S03 review R6).
  return !(trackedInstall && trackedInstall.has(p));
}

const OPTS = { exclude: isExcludedPath, maxBuffer: 32 * 1024 * 1024 };

// Memo for the tracked-install set, keyed per (cwd, vcs). Cleared at the top of
// every resetFromState so staleness can never outlive one reset: within a reset the
// index membership of install paths is stable (this engine never runs add/rm, and
// `checkout <sha> -- <paths>` only rewrites entries for paths already tracked).
const trackedInstallCache = new Map();

function trackedInstallArtifacts(cwd, vcsName = 'git') {
  const key = `${cwd}:${vcsName}`;
  if (trackedInstallCache.has(key)) return trackedInstallCache.get(key);
  const set = new Set();
  // Non-git backends and an unaskable question both fall back to the pre-R6 posture
  // (treat every install path as excluded) rather than to the opposite, which would
  // feed a failed install's whole output into the overlap comparison — the volume
  // failure this rule was created to prevent.
  const result = vcs.listTracked(cwd, { maxBuffer: OPTS.maxBuffer, vcs: vcsName });
  if (result.ok) {
    for (const p of result.paths) if (isInstallArtifactPath(p)) set.add(p);
  }
  trackedInstallCache.set(key, set);
  return set;
}

function optionsFor(cwd, vcsName, census) {
  const trackedInstall = trackedInstallArtifacts(cwd, vcsName);
  return {
    maxBuffer: OPTS.maxBuffer,
    exclude(p) {
      const excluded = isExcludedPath(p, trackedInstall);
      if (census && excluded && isInstallArtifactPath(p)) census.add(String(p));
      return excluded;
    },
  };
}

function attachCensus(entries, census) {
  if (census && census.size > 0) {
    Object.defineProperty(entries, 'excluded_install_artifacts', {
      value: census.size,
      enumerable: false,
      configurable: true,
    });
  }
  return entries;
}

/**
 * Census the install artifacts git never reports. When node_modules is gitignored
 * (the common case) porcelain lists nothing, so the exclude callback sees nothing
 * and the telemetry would read 0. Adds REAL relative paths to the same Set the
 * callback fills, so the two sources union instead of double-counting — they were
 * summed before, reporting ~2x whenever node_modules was NOT ignored (S03 review R7).
 * Counts files only (directories are not artifacts to compare) and finds nested
 * node_modules too, matching the segment-wise predicate rather than the root alone.
 */
function censusInstallArtifacts(cwd, census, trackedInstall) {
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    let children;
    try { children = fs.readdirSync(path.join(cwd, rel) || cwd, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (child.name === '.git') continue;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory() && !child.isSymbolicLink()) { pending.push(childRel); continue; }
      // Tracked install paths are no longer excluded (R6), so they are not part of
      // the exclusion census either — the number must count what was left out.
      if (isInstallArtifactPath(childRel) && !trackedInstall.has(childRel)) census.add(childRel);
    }
  }
}

/**
 * git hash-object of the CURRENT content of <relPath> in <cwd>. Returns the SHA-1
 * string, or null when the file does not exist (a pre-existing/current deletion).
 * @returns {string|null}
 */
function hashObject(cwd, relPath, vcsName = 'git') {
  const result = vcs.hashPath(cwd, relPath, { ...optionsFor(cwd, vcsName), vcs: vcsName });
  return result.ok ? result.hash : null;
}

/**
 * Snapshot the pre-existing dirty set as {path, hash} pairs. .gsd/** excluded.
 * hash = git hash-object of current content; null for a pre-existing deletion.
 * Renames contribute BOTH the new path (current content) and the old path
 * (now-missing → hash:null), so an overlap on either side is detected.
 * @returns {{path:string, hash:string|null}[]}
 */
function captureSnapshot(cwd, vcsName = 'git') {
  const census = new Set();
  const result = vcs.captureDirty(cwd, { ...optionsFor(cwd, vcsName, census), vcs: vcsName });
  // Never trust `.entries` without checking `.ok` on a SAFETY-CRITICAL path: a silent
  // `[]` here would make the engine believe there was no pre-existing dirty work (R1).
  if (!result.ok) throw new Error(`git status failed: ${result.error}`);
  return attachCensus(result.entries, census);
}

/**
 * All changes in the working tree vs START_SHA, .gsd/** excluded. Union of:
 *   - `git diff --name-status -z <startSha>` (tracked A/M/D/R vs the commit;
 *     a rename R → old becomes D, new becomes A);
 *   - untracked files from `git status --porcelain -uall -z` (?? → A).
 * @returns {{path:string, status:'A'|'M'|'D'}[]}
 */
function computePostChanges(cwd, startSha, vcsName = 'git', options = {}) {
  const census = new Set();
  const result = vcs.postChanges(cwd, startSha, { ...optionsFor(cwd, vcsName, census), vcs: vcsName });
  // The filesystem census is telemetry only. It used to run on EVERY call, and
  // computeLeftover calls this function again, so a full recursive walk happened
  // twice per reset on the critical path for a number nobody reads on that route.
  if (options.census !== false) censusInstallArtifacts(cwd, census, trackedInstallArtifacts(cwd, vcsName));
  return attachCensus(result.entries, census);
}

// ── the pure decision function (the heart of the engine) ────────────────────────

/**
 * PURE. Partition the post-run changes into what the reset should touch, given
 * the pre-dirty snapshot and a live re-hash function.
 *
 * @param {{path:string,status:'A'|'M'|'D'}[]} postChanges
 * @param {{path:string,hash:string|null}[]} preDirty
 * @param {(path:string)=>string|null} hashNow  re-hash of current content (injectable)
 * @returns {{restore:string[], remove:string[], preserved:string[], overlap:string[], excluded_install_artifacts?:number}}
 *
 * OVERLAP is computed over EVERY pre_dirty path (re-hashed), independent of the
 * post-run diff: a pre-dirty path whose current hash diverges from the snapshot
 * hash means the sidecar ALSO wrote it. Any overlap → the CALLER must execute
 * NOTHING (checked again in executeReset as a hard guard).
 */
function computeResetTarget(postChanges, preDirty, hashNow) {
  const preByPath = new Map(preDirty.map((d) => [d.path, d.hash]));
  const preserved = [];
  const overlap = [];

  for (const { path: p, hash: snapHash } of preDirty) {
    const current = hashNow(p);
    if (current === snapHash) preserved.push(p);
    else overlap.push(p);
  }

  const restore = [];
  const remove = [];
  for (const { path: p, status } of postChanges) {
    if (preByPath.has(p)) continue; // pre-existing → never a reset target
    if (status === 'A') remove.push(p);
    else restore.push(p); // M or D → restore from START_SHA
  }

  const target = { restore, remove, preserved, overlap };
  if (postChanges.excluded_install_artifacts > 0) {
    target.excluded_install_artifacts = postChanges.excluded_install_artifacts;
  }
  return target;
}

// ── reset execution + verification ──────────────────────────────────────────────

/**
 * Execute the reset. HARD GUARD: refuses to run when target.overlap is non-empty.
 * - restore: `git checkout START_SHA -- <paths...>` in one batched, shell-free call.
 * - remove:  fs.rmSync each file + prune emptied parent dirs.
 * Never touches preserved paths, never touches .gsd/**.
 * @returns {{restored:string[], removed:string[]}}
 */
function executeReset(cwd, startSha, target, vcsName = 'git') {
  const result = vcs.restoreAndRemove(cwd, startSha, target, { ...optionsFor(cwd, vcsName), vcs: vcsName });
  if (!result.ok) throw new Error(`surgical reset checkout failed: ${result.error}`);
  return { restored: result.restored, removed: result.removed };
}

/**
 * Recompute which paths, among the post-run changes vs START_SHA, are NOT
 * accounted for by the pre-dirty snapshot (i.e. still diverge from the
 * untouched pre-existing content). Shared by verifyReset (code:2 path) and by
 * the throw-path diagnostic in resetFromState (R1) — same derivation, same
 * shape, so both failure surfaces give the operator identical visibility.
 * Re-queries live state (postChanges/hashObject) rather than trusting any
 * `restored`/`removed` array, per the S03/R2 contract: those arrays are not
 * an audit trail when `ok:false`.
 * @returns {string[]}
 */
function computeLeftover(cwd, startSha, preDirty, vcsName = 'git') {
  const preByPath = new Map(preDirty.map((d) => [d.path, d.hash]));
  // No census on this route: `leftover` is consumed as a plain array (serialized in
  // the ok:false result, or read for .length by verifyReset), so attaching a
  // non-enumerable count here was dead — unlike the computePostChanges attachment,
  // which computeResetTarget really reads (S03 review R12, half-true).
  const post = computePostChanges(cwd, startSha, vcsName, { census: false });
  const leftover = [];
  for (const { path: p } of post) {
    if (!preByPath.has(p)) { leftover.push(p); continue; }
    if (hashObject(cwd, p, vcsName) !== preByPath.get(p)) leftover.push(p);
  }
  return leftover;
}

/**
 * Verify the tree after a reset: recompute the post-run changes; every remaining
 * change MUST be a pre_dirty path whose current hash still equals the snapshot
 * hash (i.e. only the preserved pre-existing work is left). Anything else is a
 * leftover → verification fails.
 * @returns {{verified:boolean, leftover:string[]}}
 */
function verifyReset(cwd, startSha, preDirty, vcsName = 'git') {
  const leftover = computeLeftover(cwd, startSha, preDirty, vcsName);
  return { verified: leftover.length === 0, leftover };
}

// ── state file (persisted snapshot; survives the poll loop + auto-compact) ───────

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

/**
 * Parse the raw `svnversion` result into a durable, comparison-safe revision
 * range. This is deliberately pure: `svnversion` itself is invoked only by the
 * VCS seam, so policy can be tested without an SVN executable or working copy.
 *
 * `M`, `S`, and `P` describe working-copy shape, not an obsolete baseline. They
 * are discarded before persistence/comparison. Revision zero is never a valid
 * dispatch baseline (it means the working copy has not been updated yet).
 * @returns {{ok:true,range:string}|{ok:false,error:string}}
 */
function parseSvnBaseline(raw) {
  const match = /^(\d+)(?::(\d+))?[MSP]*$/.exec(String(raw == null ? '' : raw).trim());
  if (!match) return { ok: false, error: 'svn-baseline-unparseable' };
  const lo = Number(match[1]);
  const hi = match[2] === undefined ? null : Number(match[2]);
  if (lo === 0 || hi === 0) return { ok: false, error: 'svn-baseline-zero-revision' };
  return { ok: true, range: hi === null ? String(lo) : `${lo}:${hi}` };
}

/** Capture baseline and dirty hashes as one attempt boundary. A second baseline
 * read closes the commit/update race before an external worker is spawned. */
function captureAttemptSnapshot(cwd, options = {}) {
  const vcsName = options.vcsName || (vcs.detectVcs(cwd) === 'svn' ? 'svn' : 'git');
  const readBaseline = () => {
    const baseline = vcs.baselineId(cwd, { ...OPTS, vcs: vcsName });
    if (!baseline.ok) throw new Error(baseline.error || 'baseline-unavailable');
    if (vcsName !== 'svn') return baseline.id;
    const parsed = parseSvnBaseline(baseline.id);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.range;
  };
  const before = readBaseline();
  const preDirty = captureSnapshot(cwd, vcsName);
  const after = readBaseline();
  if (before !== after) {
    const error = new Error(`baseline moved while capturing attempt (${before} -> ${after})`);
    error.code = 'snapshot-baseline-moved'; throw error;
  }
  return { attempt_id: options.attemptId || null, start_sha: before, pre_dirty: preDirty, code_dir: path.resolve(cwd), vcs: vcsName };
}

/**
 * Capture START_SHA + the pre-dirty snapshot and write BOTH in ONE atomic write.
 * @returns {object} the written state
 */
function initState(stateFile, { cwd, attempt }) {
  const snapshot = captureAttemptSnapshot(cwd, { attemptId: attempt });
  const state = {
    attempt: attempt == null ? 1 : attempt,
    start_sha: snapshot.start_sha,
    pre_dirty: snapshot.pre_dirty,
    reason: '',
    result_file: '',
    code_dir: snapshot.code_dir,
    transient_retry_count: 0,
    vcs: snapshot.vcs,
  };
  writeJsonAtomic(stateFile, state);
  return state;
}

/** Reset only a failed execute attempt owned by one declared repository. */
function resetFailedAttempt(stateFile, context = {}) {
  const state = readState(stateFile);
  if (context.mode !== 'execute') return { ok: false, reason_code: 'reset-refused-read-only' };
  if (context.failed !== true) return { ok: false, reason_code: 'reset-refused-not-failed' };
  if (!Array.isArray(context.repoRoots) || context.repoRoots.length !== 1) return { ok: false, reason_code: 'reset-refused-multirepo' };
  if (!context.codeDir || path.resolve(context.codeDir) !== path.resolve(state.code_dir) || path.resolve(context.codeDir) !== path.resolve(context.repoRoots[0])) {
    return { ok: false, reason_code: 'reset-refused-code-dir' };
  }
  const reset = resetFromState(stateFile);
  if (reset.code === 3) return { ok: false, reason_code: reset.result.overlap && reset.result.overlap.length ? 'reset-overlap' : (reset.result.abort || 'reset-refused'), reset: reset.result };
  if (reset.code !== 0 || !reset.result.verified) return { ok: false, reason_code: 'reset-unverified', reset: reset.result };
  return { ok: true, reason_code: 'reset-verified', reset: reset.result };
}

/** Initialize the durable read-only plan-sidecar state without shell-built JSON.
 * Unlike initState this deliberately performs no git snapshot because plan mode cannot
 * write the workspace. Atomic JSON serialization keeps Windows paths and quotes valid. */
function initReadOnlyState(stateFile, { cwd, attempt, resultFile, contextFile }) {
  const state = {
    attempt: attempt == null ? 1 : attempt,
    reason: '',
    result_file: resultFile,
    code_dir: cwd,
    ctx_file: contextFile,
    transient_retry_count: 0,
  };
  writeJsonAtomic(stateFile, state);
  return state;
}

/** Read-modify-write, atomic, preserving all fields (esp. pre_dirty + start_sha). */
function updateState(stateFile, patch) {
  const state = readState(stateFile);
  const next = { ...state, ...patch };
  writeJsonAtomic(stateFile, next);
  return next;
}

// ── high-level reset (used by the CLI) ──────────────────────────────────────────

/**
 * Full reset flow from a state file. Returns a result object + an exit code.
 * exit 0 ok / 3 overlap-abort (reset NOTHING) / 2 verify-failed.
 */
function resetFromState(stateFile) {
  // Bound the tracked-install memo to ONE reset. The set cannot change during a
  // reset, but a long-lived process (or a test) that resets twice must re-ask
  // rather than decide a destructive question from a stale answer.
  trackedInstallCache.clear();
  const state = readState(stateFile);
  const cwd = state.code_dir;
  const startSha = state.start_sha;
  const preDirty = Array.isArray(state.pre_dirty) ? state.pre_dirty : [];
  const stateVcs = state.vcs;

  // A legacy state predates VCS discrimination. It is intentionally git-only
  // and must not probe: probing would change the existing git path and could
  // reinterpret a durable legacy state under a different VCS.
  let vcsName = 'git';
  if (stateVcs !== undefined) {
    const detectedRaw = vcs.detectVcs(cwd);
    const detected = detectedRaw === 'svn' ? 'svn' : 'git';
    if (stateVcs !== detected) {
      return {
        code: 3,
        result: {
          ok: false,
          abort: 'vcs-state-mismatch',
          expected: stateVcs,
          detected,
          overlap: [],
          preserved: [],
        },
      };
    }
    vcsName = stateVcs;
  }

  if (vcsName === 'svn') {
    const baseline = vcs.baselineId(cwd, { ...OPTS, vcs: 'svn' });
    if (!baseline.ok) throw new Error(baseline.error);
    const parsed = parseSvnBaseline(baseline.id);
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.range !== startSha) {
      return {
        code: 3,
        result: {
          ok: false,
          abort: 'svn-revision-moved',
          baseline: startSha,
          current: parsed.range,
          overlap: [],
          preserved: [],
        },
      };
    }
  }

  const post = computePostChanges(cwd, startSha, vcsName);
  const target = computeResetTarget(post, preDirty, (p) => hashObject(cwd, p, vcsName));

  if (target.overlap.length !== 0) {
    return { code: 3, result: {
      ok: false,
      overlap: target.overlap,
      preserved: target.preserved,
      ...(target.excluded_install_artifacts > 0
        ? { excluded_install_artifacts: target.excluded_install_artifacts }
        : {}),
    } };
  }

  let done;
  try {
    done = executeReset(cwd, startSha, target, vcsName);
  } catch (e) {
    // Best-effort diagnostic (R1): the tree is in an UNKNOWN state per the
    // S03/R2 contract, so this MUST re-query live state, never trust `result`
    // fields off the throw. If the re-query itself fails, the ORIGINAL error
    // must survive untouched — a diagnostic that swallows the real cause
    // would be worse than no diagnostic at all.
    try {
      e.leftover = computeLeftover(cwd, startSha, preDirty, vcsName);
    } catch (_diagErr) {
      // swallow: original error below is what matters
    }
    throw e;
  }
  const check = verifyReset(cwd, startSha, preDirty, vcsName);
  if (!check.verified) {
    return {
      code: 2,
      result: { ok: false, restored: done.restored, removed: done.removed, verified: false, leftover: check.leftover },
    };
  }
  return {
    code: 0,
    result: {
      ok: true,
      restored: done.restored,
      removed: done.removed,
      preserved: target.preserved,
      verified: true,
      ...(target.excluded_install_artifacts > 0
        ? { excluded_install_artifacts: target.excluded_install_artifacts }
        : {}),
    },
  };
}

module.exports = {
  isGsdPath,
  isInstallArtifactPath,
  parsePorcelainZ,
  parseNameStatusZ,
  parseSvnBaseline,
  captureAttemptSnapshot,
  hashObject,
  captureSnapshot,
  computePostChanges,
  computeResetTarget,
  computeLeftover,
  executeReset,
  verifyReset,
  pruneEmptyParents,
  writeJsonAtomic,
  readState,
  initState,
  initReadOnlyState,
  updateState,
  resetFromState,
  resetFailedAttempt,
};

// ── CLI (manual argv parse, no deps — mold: forge-xllm.js) ───────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usageError(msg) {
  process.stderr.write(`forge-surgical-reset: ${msg}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    if (args['state-init']) {
      if (!args.state || !args.cwd) usageError('--state-init requires --state <file> --cwd <dir>');
      const attempt = args.attempt != null && args.attempt !== true ? parseInt(args.attempt, 10) : 1;
      const state = initState(args.state, { cwd: args.cwd, attempt });
      process.stdout.write(state.start_sha + '\n'); // skills capture with $( )
      process.exit(0);
    }

    if (args['state-init-read-only']) {
      if (!args.state || !args.cwd || !args['result-file'] || !args['ctx-file']) {
        usageError('--state-init-read-only requires --state <file> --cwd <dir> --result-file <file> --ctx-file <file>');
      }
      const attempt = args.attempt != null && args.attempt !== true ? parseInt(args.attempt, 10) : 1;
      initReadOnlyState(args.state, {
        cwd: args.cwd,
        attempt,
        resultFile: args['result-file'],
        contextFile: args['ctx-file'],
      });
      process.exit(0);
    }

    if (args['state-update']) {
      if (!args.state) usageError('--state-update requires --state <file>');
      const patch = {};
      if (args.reason != null && args.reason !== true) patch.reason = args.reason;
      if (args['result-file'] != null && args['result-file'] !== true) patch.result_file = args['result-file'];
      if (args['dispatch-id'] != null && args['dispatch-id'] !== true) {
        const dispatchId = String(args['dispatch-id']);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dispatchId)) {
          usageError('--dispatch-id must be 1-128 safe identifier characters');
        }
        patch.dispatch_id = dispatchId;
      }
      if (args['transient-retry-count'] != null && args['transient-retry-count'] !== true) {
        patch.transient_retry_count = parseInt(args['transient-retry-count'], 10);
      }
      updateState(args.state, patch);
      process.exit(0);
    }

    if (args.reset) {
      if (!args.state) usageError('--reset requires --state <file>');
      try {
        const { code, result } = resetFromState(args.state);
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(code);
      } catch (e) {
        // R1: same leftover shape as the code:2 (verify-failed) path, so the
        // operator has identical visibility on both failure surfaces. Exit
        // code stays 1 (unchanged) — this only adds a diagnostic, it never
        // reclassifies the failure as a different exit path.
        const leftover = Array.isArray(e.leftover) ? e.leftover : null;
        if (leftover) {
          process.stdout.write(JSON.stringify({ ok: false, error: e.message, leftover }) + '\n');
        }
        process.stderr.write(`forge-surgical-reset: ${e.message}\n`);
        process.exit(1);
      }
    }

    usageError('one of --state-init | --state-init-read-only | --state-update | --reset is required');
  } catch (e) {
    process.stderr.write(`forge-surgical-reset: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
