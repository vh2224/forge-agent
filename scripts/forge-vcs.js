#!/usr/bin/env node
'use strict';

/*
 * forge-vcs.js — VCS seam: git implementation + normalized boundary (M017 S02).
 *
 * SAFETY-CRITICAL. This module restores and removes files in a user's working
 * tree. The git body below is a literal movement from forge-surgical-reset.js
 * (M017 S02); any "simplification" must re-read M013 S01-RISK first.
 * NUL delimitation (-z) is load-bearing: paths may contain spaces, quotes, and
 * newlines. SVN has no NUL status format: newline-containing paths are routed
 * one-at-a-time in argv rather than through its newline-delimited targets file.
 * SVN targets also carry peg-revision syntax (`path@rev`). svnIsTracked escapes
 * its target through svnPegSafe — see its comment. The revert paths below do
 * NOT, and a path containing a literal `@` therefore fails them: `svn revert`
 * answers E200009 ("a peg revision is not allowed here") for both the argv and
 * the `--targets` form, and the batch form aborts the WHOLE set, reverting none
 * of it. That failure is closed and loud — svnRestoreAndRemove checks the exit
 * status and returns `{ ok: false }`, so nothing is applied by halves — but it
 * is a gap, not a design. Extending the escape is a follow-up: verified against
 * svn 1.14.2 that `svn revert -- 'SERVICES/services@1.2.0.ts@'` reverts the
 * file, so the same helper is the fix; it wants its own regression test before
 * it lands in code this critical.
 * opts.vcs defaults explicitly to 'git' so this seam never probes SVN on its
 * hot path (the M017 S01 4.2–4.9x regression).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { detectVcs } = require('./forge-ignore.js');

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

// ── .gsd exclusion — predicate supplied by each consumer ────────────────────
function isGsdPath(p) {
  return p === '.gsd' || p.startsWith('.gsd/');
}

function optionsFor(opts) {
  const out = { encoding: 'buffer', maxBuffer: opts.maxBuffer == null ? DEFAULT_MAX_BUFFER : opts.maxBuffer, shell: false };
  // Do not turn an absent env into {}; spawnSync must retain process.env exactly.
  if (opts.env !== undefined) out.env = opts.env;
  return out;
}

// ── git primitives (array args, never shell) ─────────────────────────────────
function git(cwd, args, opts) {
  return spawnSync('git', ['-C', cwd, ...args], optionsFor(opts));
}

function stderrOf(result, fallback) {
  if (result && result.stderr) {
    const value = result.stderr.toString('utf8').trim();
    if (value) return value;
  }
  return (result && result.error && result.error.message) || fallback;
}

function unsupported(vcs, extra) {
  return { vcs, ok: false, ...extra, error: `vcs-unsupported:${vcs}` };
}

function excluded(opts, p) {
  return typeof opts.exclude === 'function' && opts.exclude(p);
}

// ── SVN helpers (array args, locale-pinned, never shell) ────────────────────
function svnRun(cwd, args, opts) {
  const configArgs = opts.configDir ? ['--config-dir', opts.configDir] : [];
  return spawnSync('svn', ['--non-interactive', ...configArgs, ...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer: opts.maxBuffer == null ? DEFAULT_MAX_BUFFER : opts.maxBuffer,
    // LC_ALL must be assigned after opts.env: diagnostics are deliberately
    // locale-stable even when the caller supplies an environment.
    env: { ...(opts.env ?? process.env), LC_ALL: 'C' },
  });
}

function svnversionRun(cwd, opts) {
  return spawnSync('svnversion', [], {
    cwd,
    encoding: 'buffer',
    maxBuffer: opts.maxBuffer == null ? DEFAULT_MAX_BUFFER : opts.maxBuffer,
    env: { ...(opts.env ?? process.env), LC_ALL: 'C' },
  });
}

function svnWcRootGuard(cwd) {
  return fs.existsSync(path.join(cwd, '.svn'))
    ? { ok: true }
    : { ok: false, error: 'svn-wcroot-mismatch: run primitives from the working-copy root' };
}

function decodeXmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(value).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, entity) => {
    if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity];
    const numeric = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : all;
  });
}

function xmlAttribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`).exec(tag);
  return match ? decodeXmlEntities(match[2]) : null;
}

/** Parse the known, machine-produced `svn status --xml` format fail-closed. */
function parseSvnStatusXml(xml) {
  const source = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  const entries = [];
  const entryRe = /<entry\b[^>]*>[\s\S]*?<\/entry\s*>/g;
  let entryMatch;
  while ((entryMatch = entryRe.exec(source))) {
    const block = entryMatch[0];
    const open = /^<entry\b[^>]*>/.exec(block);
    const wcStatus = /<wc-status\b[^>]*>/.exec(block);
    if (!open || !wcStatus) return { ok: false, error: 'svn-status-malformed' };
    const relPath = xmlAttribute(open[0], 'path');
    const item = xmlAttribute(wcStatus[0], 'item');
    const props = xmlAttribute(wcStatus[0], 'props');
    if (relPath === null || item === null || props === null) return { ok: false, error: 'svn-status-malformed' };
    entries.push({ path: relPath, item, props });
  }
  return { ok: true, entries };
}

function mapSvnItem(item, props) {
  if (item === 'modified' || item === 'replaced') return 'M';
  if (item === 'added' || item === 'unversioned') return 'A';
  if (item === 'deleted' || item === 'missing') return 'D';
  if (item === 'normal') return props === 'none' ? { skip: true } : 'M';
  if (item === 'external' || item === 'ignored') return { skip: true };
  return { failClosed: item };
}

function gitIsTracked(cwd, relPath, opts) {
  const result = git(cwd, ['ls-files', '--error-unmatch', '--', relPath], opts);
  // A non-zero exit is the ANSWER ("not tracked", or "not a repository"), not a
  // failure. Only a spawn that never ran (git absent) is `ok: false` — callers
  // must be able to tell "the answer is no" from "I could not ask".
  if (result.error) return { ok: false, tracked: false, error: stderrOf(result, 'git ls-files failed') };
  return { ok: true, tracked: result.status === 0 };
}

/*
 * Every tracked path in the working copy, NUL-delimited so paths with spaces,
 * quotes, or newlines survive. Callers need the WHOLE set (not a per-path
 * question) when a decision must be made about a large family of paths at once
 * without paying one process per path. `ok: false` means the question could not
 * be asked and must never be rendered by a caller as "nothing is tracked".
 */
function gitListTracked(cwd, opts) {
  const result = git(cwd, ['ls-files', '-z'], opts);
  if (result.status !== 0) return { ok: false, paths: [], error: stderrOf(result, 'git ls-files failed') };
  const paths = result.stdout.toString('utf8').split('\0').filter(Boolean);
  return { ok: true, paths };
}

function gitHashObject(cwd, relPath, opts) {
  const abs = path.join(cwd, relPath);
  if (!fs.existsSync(abs)) return { ok: true, hash: null };
  const result = git(cwd, ['hash-object', '--', relPath], opts);
  if (result.status !== 0) return { ok: false, error: stderrOf(result, 'git hash-object failed') };
  return { ok: true, hash: result.stdout.toString('utf8').trim() || null };
}

// ── porcelain / diff parsers (NUL-delimited) ─────────────────────────────────
function parsePorcelainZ(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const tokens = s.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 3) continue;
    const xy = tok.slice(0, 2);
    const p = tok.slice(3);
    const isRenameCopy = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    if (isRenameCopy) {
      const origPath = tokens[i + 1];
      i += 1;
      out.push({ xy, path: p, origPath });
    } else out.push({ xy, path: p });
  }
  return out;
}

function parseNameStatusZ(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const tokens = s.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const statusTok = tokens[i];
    if (!statusTok) continue;
    const code = statusTok[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      out.push({ status: code, path: newPath, origPath: oldPath });
    } else {
      const p = tokens[i + 1];
      i += 1;
      out.push({ status: code, path: p });
    }
  }
  return out;
}

// ── moved git snapshot / post-run computation ────────────────────────────────
function gitCaptureDirty(cwd, opts) {
  const status = git(cwd, ['status', '--porcelain', '-uall', '-z'], opts);
  if (status.status !== 0) return { ok: false, error: stderrOf(status, 'git status failed') };
  const entries = parsePorcelainZ(status.stdout);
  const seen = new Set();
  const snapshot = [];
  const add = (p) => {
    if (!p || excluded(opts, p) || seen.has(p)) return;
    seen.add(p);
    // Degrade-per-path: a single path that fails to hash (submodule gitlink,
    // broken clean filter, permission) must not abort the whole snapshot —
    // it degrades to hash:null and the loop continues, matching the
    // pre-seam hashObject() behavior. Aborting here would silently empty
    // preDirty and unprotect the operator's other dirty files (R1).
    const hashed = gitHashObject(cwd, p, opts);
    snapshot.push({ path: p, hash: hashed.ok ? hashed.hash : null });
  };
  for (const entry of entries) {
    add(entry.path);
    if (entry.origPath) add(entry.origPath);
  }
  return { ok: true, entries: snapshot };
}

function gitPostChanges(cwd, baseline, opts) {
  const byPath = new Map();
  const set = (p, status) => { if (p && !excluded(opts, p)) byPath.set(p, status); };
  const diff = git(cwd, ['diff', '--name-status', '-z', baseline], opts);
  if (diff.status !== 0) return { ok: false, error: stderrOf(diff, 'git diff failed') };
  const markCopyOriginAsDeleted = opts.copyOriginDeleted !== false;
  for (const entry of parseNameStatusZ(diff.stdout)) {
    if (entry.status === 'R') {
      set(entry.origPath, 'D');
      set(entry.path, 'A');
    } else if (entry.status === 'C') {
      // Copy leaves the source untouched — only the reset engine (where
      // marking the origin 'D' is inert, restored identically from
      // baseline) wants it collapsed with rename. Report-only consumers
      // (e.g. xllm) must not falsely report the copy source as deleted (R4).
      if (markCopyOriginAsDeleted) set(entry.origPath, 'D');
      set(entry.path, 'A');
    } else if (entry.status === 'A') set(entry.path, 'A');
    else if (entry.status === 'D') set(entry.path, 'D');
    else set(entry.path, 'M');
  }
  const porcelain = git(cwd, ['status', '--porcelain', '-uall', '-z'], opts);
  if (porcelain.status !== 0) return { ok: false, error: stderrOf(porcelain, 'git status failed') };
  for (const entry of parsePorcelainZ(porcelain.stdout)) if (entry.xy === '??') set(entry.path, 'A');
  return { ok: true, entries: Array.from(byPath.entries()).map(([p, status]) => ({ path: p, status })) };
}

// ── reset execution + verification ──────────────────────────────────────────
function pruneEmptyParents(cwd, relPath) {
  let dir = path.dirname(relPath);
  while (dir && dir !== '.' && dir !== path.sep) {
    const abs = path.join(cwd, dir);
    try {
      if (fs.readdirSync(abs).length !== 0) break;
      fs.rmdirSync(abs);
    } catch { break; }
    dir = path.dirname(dir);
  }
}

function gitRestoreAndRemove(cwd, baseline, target, opts) {
  if (target.overlap.length !== 0) {
    throw new Error('executeReset refused: overlap is non-empty (caller must abort)');
  }
  const restored = [];
  const removed = [];
  if (target.restore.length) {
    const checkout = git(cwd, ['checkout', baseline, '--', ...target.restore], opts);
    if (checkout.status !== 0) return { ok: false, restored, removed, error: stderrOf(checkout, 'git checkout failed') };
    restored.push(...target.restore);
  }
  for (const rel of target.remove) {
    if (excluded(opts, rel)) continue;
    const abs = path.join(cwd, rel);
    try {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      pruneEmptyParents(cwd, rel);
    } catch { /* best-effort — leftover surfaces in caller verification */ }
  }
  return { ok: true, restored, removed };
}

// ── SVN snapshot / post-run computation ─────────────────────────────────────
function svnHashPath(cwd, relPath) {
  const abs = path.resolve(cwd, relPath);
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { ok: true, hash: 'dir' };
    return { ok: true, hash: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, hash: null };
    return { ok: false, error: 'svn-hash-path-failed' };
  }
}

function svnStatusEntries(cwd, opts) {
  const guard = svnWcRootGuard(cwd);
  if (!guard.ok) return guard;
  // `--no-ignore` is opt-in: captureDirty/postChanges drop `ignored` in
  // mapSvnItem anyway, so asking for it there would only cost a larger scan.
  // workingStatus does need it — its refusal reason distinguishes `ignored`.
  const args = ['status', '--xml', '--ignore-externals'];
  if (opts && opts.noIgnore === true) args.push('--no-ignore');
  const result = svnRun(cwd, args, opts);
  if (result.status !== 0) return { ok: false, error: 'svn-status-failed' };
  return parseSvnStatusXml(result.stdout);
}

/**
 * SVN status is always against BASE. Directories are deliberately included in
 * this snapshot and use the non-hash sentinel `dir`; callers compare it like
 * any other hash so file↔directory replacement is a divergence.
 */
function svnCaptureDirty(cwd, opts) {
  const status = svnStatusEntries(cwd, opts);
  if (!status.ok) return status;
  const entries = [];
  for (const entry of status.entries) {
    const mapped = mapSvnItem(entry.item, entry.props);
    if (mapped.failClosed) return { ok: false, error: `svn-status-unhandled:${mapped.failClosed}` };
    if (mapped.skip || excluded(opts, entry.path)) continue;
    const hashed = svnHashPath(cwd, entry.path);
    // Degrade one unreadable path only; never discard a partially protective
    // snapshot because that would make unrelated operator files unsafe.
    entries.push({ path: entry.path, hash: hashed.ok ? hashed.hash : null });
  }
  return { ok: true, entries };
}

/** SVN `baseline` is intentionally inert: status is always compared to BASE. */
function svnPostChanges(cwd, baseline, opts) { // eslint-disable-line no-unused-vars
  const status = svnStatusEntries(cwd, opts);
  if (!status.ok) return status;
  const entries = [];
  for (const entry of status.entries) {
    const mapped = mapSvnItem(entry.item, entry.props);
    if (mapped.failClosed) return { ok: false, error: `svn-status-unhandled:${mapped.failClosed}` };
    if (!mapped.skip && !excluded(opts, entry.path)) entries.push({ path: entry.path, status: mapped });
  }
  return { ok: true, entries };
}

function svnErrorCode(result, fallback) {
  const message = stderrOf(result, fallback);
  const code = /\bE1550\d{2}\b/.exec(message);
  return code ? `svn-revert-failed:${code[0]}` : 'svn-revert-failed';
}

function isWithinCwd(cwd, relPath) {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, relPath);
  return abs === root || abs.startsWith(`${root}${path.sep}`);
}

function svnRevertBatch(cwd, paths, depth, opts) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-svn-targets-'));
  const targets = path.join(tmpDir, 'targets');
  try {
    fs.writeFileSync(targets, `${paths.join('\n')}\n`, 'utf8');
    return svnRun(cwd, ['revert', '--depth', depth, '--targets', targets], opts);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

/**
 * Reverts and removes `target.restore`/`target.remove` against a real SVN
 * working copy.
 *
 * Contract on failure: `ok:false` means the working copy is left in an
 * UNKNOWN state — some targets in the failed batch may already have been
 * reverted (a `svn revert --targets` batch is non-atomic: it can revert
 * earlier targets and then abort on a later one, per E6). `restored`/
 * `removed` on a failure return are NOT an audit trail of what actually
 * changed on disk; they are deliberately left empty rather than partially
 * populated, so no caller can mistake them for one. Any caller that needs to
 * know the true post-failure state MUST re-snapshot the working copy from
 * scratch (fresh `postChanges`/`captureDirty`), never trust these arrays.
 *
 * Depth safety: `--depth infinity` on a directory target applies to its
 * WHOLE subtree, not just that directory's own properties. Directory-level
 * prop-only changes (svn:ignore, svn:externals) surface here as ordinary
 * entries with hash 'dir' (see svnHashPath), so a blanket `infinity` revert
 * can destroy preserved sibling files nested under that directory. A
 * directory target only uses `infinity` when it provably has zero
 * descendants in `target.preserved`; otherwise it reverts at `--depth empty`
 * (sufficient for a prop-only change, and safe regardless of children).
 */
function svnRestoreAndRemove(cwd, baseline, target, opts) { // baseline is intentionally inert for SVN
  if (target.overlap.length !== 0) throw new Error('executeReset refused: overlap is non-empty (caller must abort)');
  const guard = svnWcRootGuard(cwd);
  const restored = [];
  const removed = [];
  if (!guard.ok) return { ok: false, restored, removed, error: guard.error };
  const all = Array.from(new Set([...target.restore, ...target.remove])).filter((p) => !excluded(opts, p));
  const preservedSet = new Set(target.preserved || []);
  const isDirTarget = (p) => {
    try { return fs.statSync(path.resolve(cwd, p)).isDirectory(); } catch { return false; }
  };
  const hasPreservedDescendant = (dirPath) => {
    const prefix = `${dirPath}/`;
    for (const preserved of preservedSet) if (preserved.startsWith(prefix)) return true;
    return false;
  };
  const infinityPaths = [];
  const emptyPaths = [];
  for (const p of all) {
    if (isDirTarget(p) && hasPreservedDescendant(p)) emptyPaths.push(p);
    else infinityPaths.push(p);
  }
  const newlineInfinity = infinityPaths.filter((p) => /[\r\n]/.test(p));
  const ordinaryInfinity = infinityPaths.filter((p) => !/[\r\n]/.test(p));
  const newlineEmpty = emptyPaths.filter((p) => /[\r\n]/.test(p));
  const ordinaryEmpty = emptyPaths.filter((p) => !/[\r\n]/.test(p));
  try {
    if (ordinaryInfinity.length) {
      const result = svnRevertBatch(cwd, ordinaryInfinity, 'infinity', opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    if (ordinaryEmpty.length) {
      const result = svnRevertBatch(cwd, ordinaryEmpty, 'empty', opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    for (const relPath of newlineInfinity) {
      const result = svnRun(cwd, ['revert', '--depth', 'infinity', '--', relPath], opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    for (const relPath of newlineEmpty) {
      const result = svnRun(cwd, ['revert', '--depth', 'empty', '--', relPath], opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
  } catch (_) { return { ok: false, restored, removed, error: 'svn-revert-failed' }; }
  for (const relPath of [...target.remove].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (excluded(opts, relPath) || !isWithinCwd(cwd, relPath)) continue;
    try {
      fs.rmSync(path.resolve(cwd, relPath), { recursive: true, force: true });
      removed.push(relPath);
      pruneEmptyParents(cwd, relPath);
    } catch { /* verification by caller exposes remnants */ }
  }
  return { ok: true, restored: [...target.restore], removed };
}

/**
 * SVN reads a trailing `@<rev>` in a target as a peg revision, so a path that
 * legitimately contains `@` (`SERVICES/services@1.2.0`) is parsed as a revision
 * and the command fails (E205000) instead of addressing the file — silently
 * dropping that path from whatever set was being computed. The documented
 * escape is a trailing `@`, which SVN strips. Applied unconditionally:
 * `plain.md@` and `plain.md` address the same node (verified, svn 1.14.2).
 * `--` does NOT cover this: peg parsing is part of the target syntax, not
 * option parsing.
 *
 * Call sites: svnIsTracked only. The reverts pass raw targets — see the file
 * header for the measured consequence and why closing it is a follow-up.
 */
function svnPegSafe(target) {
  return `${target}@`;
}

/**
 * "Is this path under version control?" — deliberately NOT answered with
 * `svn status`, which is the wrong oracle in both directions:
 *   - it only omits an IGNORED path while SCANNING a directory; name the path
 *     explicitly and it prints `I <path>`, so a "non-empty and not `?`" test
 *     reads *ignored* as *tracked* (false positive on every correctly
 *     configured working copy);
 *   - it is silent for a versioned file with no local modification, so the same
 *     test reads *committed and clean* as *untracked* (false negative).
 * `svn info` answers the actual question by exit code, one call, no parsing.
 *
 * No working-copy-root guard here, unlike the `svn status` primitives: `svn
 * info <path>` is valid from any directory, and since SVN 1.7 only the WC root
 * carries `.svn`, so requiring the root would break every caller whose `.gsd/`
 * sits below it.
 */
function svnIsTracked(cwd, relPath, opts) {
  const result = svnRun(cwd, ['info', '--', svnPegSafe(relPath)], opts);
  if (result.error) return { ok: false, tracked: false, error: 'svn-info-failed' };
  return { ok: true, tracked: result.status === 0 };
}

function svnBaselineId(cwd, opts) {
  const guard = svnWcRootGuard(cwd);
  if (!guard.ok) return { ok: false, id: null, error: guard.error };
  const result = svnversionRun(cwd, opts);
  if (result.status !== 0) return { ok: false, id: null, error: 'svn-baseline-failed' };
  return { ok: true, id: result.stdout.toString('utf8').trim() };
}

// ── normalized public VCS seam ───────────────────────────────────────────────
function baselineId(cwd, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const result = svnBaselineId(cwd, opts);
    return result.ok ? { vcs, ok: true, id: result.id } : { vcs, ok: false, id: null, error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { id: null });
  const result = git(cwd, ['rev-parse', 'HEAD'], opts);
  if (result.status !== 0) return { vcs, ok: false, id: null, error: stderrOf(result, 'git rev-parse failed') };
  return { vcs, ok: true, id: result.stdout.toString('utf8').trim() };
}

function hashPath(cwd, relPath, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const guard = svnWcRootGuard(cwd);
    if (!guard.ok) return { vcs, ok: false, hash: null, error: guard.error };
    const result = svnHashPath(cwd, relPath);
    return result.ok ? { vcs, ok: true, hash: result.hash } : { vcs, ok: false, hash: null, error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { hash: null });
  const result = gitHashObject(cwd, relPath, opts);
  return result.ok ? { vcs, ok: true, hash: result.hash } : { vcs, ok: false, hash: null, error: result.error };
}

/**
 * Version-control membership of one path. `{ ok: true, tracked }` is an answer;
 * `{ ok: false, error }` means the question could not be asked (VCS binary
 * absent) and must never be rendered as "not tracked" by a caller that accuses
 * on `tracked: true` — an unaskable question is not evidence either way.
 */
function isTracked(cwd, relPath, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const result = svnIsTracked(cwd, relPath, opts);
    return result.ok
      ? { vcs, ok: true, tracked: result.tracked }
      : { vcs, ok: false, tracked: false, error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { tracked: false });
  const result = gitIsTracked(cwd, relPath, opts);
  return result.ok
    ? { vcs, ok: true, tracked: result.tracked }
    : { vcs, ok: false, tracked: false, error: result.error };
}

/**
 * Version-control membership of EVERY tracked path, as a set-sized answer.
 * Same contract as isTracked: `{ ok: false }` is "could not ask", never "no".
 * Non-git backends return unsupported rather than an empty list, so a caller
 * cannot mistake an unanswered question for an empty repository.
 */
function listTracked(cwd, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs !== 'git') return unsupported(vcs, { paths: [] });
  const result = gitListTracked(cwd, opts);
  return result.ok
    ? { vcs, ok: true, paths: result.paths }
    : { vcs, ok: false, paths: [], error: result.error };
}

function captureDirty(cwd, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const result = svnCaptureDirty(cwd, opts);
    return result.ok ? { vcs, ok: true, entries: result.entries } : { vcs, ok: false, entries: [], error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { entries: [] });
  const result = gitCaptureDirty(cwd, opts);
  return result.ok ? { vcs, ok: true, entries: result.entries } : { vcs, ok: false, entries: [], error: result.error };
}

function postChanges(cwd, baseline, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const result = svnPostChanges(cwd, baseline, opts);
    return result.ok ? { vcs, ok: true, entries: result.entries } : { vcs, ok: false, entries: [], error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { entries: [] });
  const result = gitPostChanges(cwd, baseline, opts);
  return result.ok ? { vcs, ok: true, entries: result.entries } : { vcs, ok: false, entries: [], error: result.error };
}

function restoreAndRemove(cwd, baseline, target, opts = {}) {
  const vcs = opts.vcs === undefined ? 'git' : opts.vcs;
  if (vcs === 'svn') {
    const result = svnRestoreAndRemove(cwd, baseline, target, opts);
    return result.ok
      ? { vcs, ok: true, restored: result.restored, removed: result.removed }
      : { vcs, ok: false, restored: result.restored, removed: result.removed, error: result.error };
  }
  if (vcs !== 'git') return unsupported(vcs, { restored: [], removed: [] });
  const result = gitRestoreAndRemove(cwd, baseline, target, opts);
  return result.ok
    ? { vcs, ok: true, restored: result.restored, removed: result.removed }
    : { vcs, ok: false, restored: result.restored, removed: result.removed, error: result.error };
}

/*
 * Read the working-copy status for consumers that need a per-path safety
 * decision. This is deliberately separate from captureDirty(): the latter
 * carries hashes for reset recovery, whereas this envelope retains the raw
 * status category needed for an operator-facing refusal reason.
 */
function workingStatus(cwd, opts = {}) {
  const vcs = opts.vcs === undefined ? detectVcs(cwd) : opts.vcs;
  if (vcs === 'git') {
    // -z is load-bearing: parsePorcelainZ is the only parser used here and
    // preserves paths containing spaces, quotes, or newlines. -uall prevents
    // directory-collapse from making a dirty descendant look absent.
    const result = git(cwd, ['status', '--porcelain', '-uall', '-z', '--ignored'], opts);
    if (result.status !== 0) return { vcs, ok: false, entries: [], error: stderrOf(result, 'git status failed') };
    try {
      const entries = [];
      for (const entry of parsePorcelainZ(result.stdout)) {
        const xy = entry.xy;
        let kind = null;
        if (xy === '??') kind = 'untracked';
        else if (xy === '!!') kind = 'ignored';
        // Index A is checked before the generic worktree-modified branch:
        // both `A ` and `AM` are additions not yet committed, not ordinary
        // local modifications.
        else if (xy[0] === 'A') kind = 'added';
        else if (xy.includes('D')) kind = 'deleted';
        else if (/[MRCU]/.test(xy)) kind = 'modified';
        else return { vcs, ok: false, entries: [], error: `git-status-unhandled:${xy}` };
        entries.push({ path: entry.path, code: xy, kind });
        // A rename/copy affects both spellings; checking either target member
        // must therefore fail closed instead of treating its old spelling clean.
        if (entry.origPath) entries.push({ path: entry.origPath, code: xy, kind });
      }
      return { vcs, ok: true, entries };
    } catch (error) {
      return { vcs, ok: false, entries: [], error: `git-status-parse-failed:${error.message}` };
    }
  }
  if (vcs === 'svn') {
    // noIgnore mirrors the git branch's --ignored: without it `ignored` below
    // is unreachable and an ignored path would read as absent, hence eligible.
    const status = svnStatusEntries(cwd, { ...opts, noIgnore: true });
    if (!status.ok) return { vcs, ok: false, entries: [], error: status.error };
    const entries = [];
    for (const entry of status.entries) {
      let kind = null;
      // Do not use mapSvnItem here: it deliberately collapses added and
      // unversioned into A, but this reporting boundary must distinguish them.
      if (entry.item === 'unversioned') kind = 'untracked';
      else if (entry.item === 'ignored') kind = 'ignored';
      else if (entry.item === 'added') kind = 'added';
      else if (entry.item === 'deleted' || entry.item === 'missing') kind = 'deleted';
      else if (entry.item === 'modified' || entry.item === 'replaced') kind = 'modified';
      else if (entry.item === 'normal' && entry.props !== 'none') kind = 'modified';
      else if (entry.item !== 'normal' && entry.item !== 'external') {
        return { vcs, ok: false, entries: [], error: `svn-status-unhandled:${entry.item}` };
      }
      if (kind) entries.push({ path: entry.path, code: entry.item, kind });
    }
    return { vcs, ok: true, entries };
  }
  return unsupported(vcs, { entries: [] });
}

module.exports = {
  detectVcs,
  baselineId,
  hashPath,
  isTracked,
  listTracked,
  svnPegSafe,
  captureDirty,
  postChanges,
  restoreAndRemove,
  workingStatus,
  parsePorcelainZ,
  parseNameStatusZ,
  parseSvnStatusXml,
  decodeXmlEntities,
  mapSvnItem,
  pruneEmptyParents,
  isGsdPath,
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = ['detect', 'baseline', 'changes'].filter((name) => args[name] === true);
  if (commands.length !== 1 || !args.cwd || args._.length !== 0) {
    process.stderr.write('forge-vcs: exactly one of --detect, --baseline, or --changes with --cwd is required\n');
    return 1;
  }
  if (args.detect === true) {
    const vcs = detectVcs(args.cwd);
    const payload = { vcs, ok: true };
    if (typeof args.field === 'string' && args.field) {
      if (!Object.prototype.hasOwnProperty.call(payload, args.field)) {
        process.stderr.write(`forge-vcs: unknown --detect field "${args.field}"\n`);
        return 1;
      }
      process.stdout.write(`${payload[args.field]}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  }
  if (args.baseline === true) {
    const result = baselineId(args.cwd, { vcs: detectVcs(args.cwd) });
    if (!result.ok) {
      process.stderr.write(`forge-vcs: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(`${result.id}\n`);
    return 0;
  }
  // A revision is passed as one argv element to the VCS seam, never composed
  // into a shell command. Reject option-shaped values before they can be read
  // as a VCS flag by a downstream primitive.
  if (typeof args.since !== 'string' || !args.since || args.since.startsWith('-') || args.since.includes('\0')) {
    process.stderr.write('forge-vcs: --changes requires a non-option --since revision\n');
    return 1;
  }
  const result = postChanges(args.cwd, args.since, { vcs: detectVcs(args.cwd), copyOriginDeleted: false });
  if (!result.ok) {
    process.stderr.write(`forge-vcs: ${result.error}\n`);
    return 1;
  }
  for (const entry of result.entries) process.stdout.write(`${entry.status}\t${entry.path}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
