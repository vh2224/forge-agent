#!/usr/bin/env node
// forge-maintenance-vcs — VCS concurrency guard for the maintenance fragment
// pipeline (S03 of M-20260706152250-maintenance-fragment).
//
// Purpose: make concurrent `.gsd/` maintenance (rollup/bucket generation)
// safe across git/svn/none by (a) detecting an already-committed remote
// maintenance BEFORE a run starts (R5a), (b) providing a path-scoped pull
// of `.gsd/` (D4), (c) re-checking at commit time (R5b), and (d) resolving
// a detected collision defensively via byte-identity (D3): identical content
// discards local silently; anything else aborts loud and preserves both.
//
// DEC-S03-1 (mechanism): `git pull -- .gsd/` does not exist. Detection is
// split from mutation. Detection (precheckHistory/recheckAtCommit) NEVER
// touches the working tree — it only does `git fetch` (refreshes the
// remote-tracking ref) + `git ls-tree` + `git cat-file blob` to read remote
// content. `pullScoped` is the ONLY tree-mutating function in this module:
// it does `git checkout origin/<br> -- .gsd/` (materializes adds/mods) PLUS
// an explicit deletion-sync pass (checkout with a pathspec never deletes —
// this is the documented gap we close: diff --diff-filter=D + git rm).
// After pullScoped, `.gsd/` mirrors `origin/<br>:.gsd/`; the branch head is
// NOT advanced (git equivalent of `svn update .gsd`; branch-advance policy
// belongs to S05).
//
// DEC-S03-2 (already-committed signal): presence at the remote tip of
// rollup artifacts (isRollupPath predicate) absent locally or present with
// a different blob sha.
//
// DEC-S03-3 (filter-free read): remote content is read via
// `git cat-file blob <sha>` (raw bytes, bypasses checkout/eol filters —
// autocrlf-safe) / `svn cat -r HEAD <path>`. Never read remote content from
// the working tree post-checkout. Compared via
// bucketHash(normalizeText(remoteRaw)) — S01's oracle.
//
// DEC-S03-4 (exec indirection): all VCS calls route through a module-level
// `_execFileSync` (arg-array, no shell) swappable via `__setExecFileSync`,
// mirroring the pattern already shipped in forge-ignore.js (lines 27-34).
// forge-isolation.js helpers are NOT reused here — they use execSync +
// shell:true, which is un-mockable through this indirection layer.
//
// DEC-S03-5 (dirty posture): `pullScoped` refuses on a dirty `.gsd/`
// (git status --porcelain -- .gsd/ non-empty / svn status .gsd non-'?'
// lines) BEFORE any tree mutation. Uncommitted local work is never
// discarded except on the sanctioned identical-collision path.
//
// DEC-S03-6 (graceful degrade): vcs === 'none', missing origin remote, and
// detached HEAD all degrade gracefully (already:false / action:'proceed'
// + warn) instead of throwing. The guard only blocks on positive evidence
// of a remote maintenance.
//
// Library exports:
//   isRollupPath(relPath)                       → bool
//   dirtyGsd(cwd, vcs)                          → { dirty, files }
//   precheckHistory(cwd, vcs?)                  → { vcs, checked, already, remoteRollups, ref, warn? }
//   pullScoped(cwd, vcs?)                       → { vcs, updated, method, applied?, deleted?, dirtyFiles?, warn? }
//   recheckAtCommit(cwd, vcs?)                  → { vcs, checked, collision, collisions, ref, warn? }
//   readRemoteBlob(cwd, entry, vcs, ref)        → string (raw bytes, filter-free)
//   resolveCollision(localHash, remoteContent)  → { action:'discard'|'abort', identical, remoteHash }
//   runCommitGuard(cwd, localBuckets)           → { action:'proceed'|'discard'|'abort', collisions, ref, eventWritten }
//   appendEvent(cwd, evt)                       → bool
//   __setExecFileSync(fn)                       → prev
//
// CLI:
//   node forge-maintenance-vcs.js --precheck [--cwd D]
//   node forge-maintenance-vcs.js --pull-scoped [--cwd D]
//   node forge-maintenance-vcs.js --recheck [--cwd D]
//   node forge-maintenance-vcs.js --dirty [--cwd D]
//   node forge-maintenance-vcs.js --resolve --local-hash <h> --remote-file <f>
//   node forge-maintenance-vcs.js --help
//
// Exit codes: 0 ran clean / guard clear, 3 guard tripped
// (already:true / collision:true / action:'abort' / dirty:true),
// 1 runtime error, 2 bad args.

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { detectVcs } = require('./forge-ignore');
const { normalizeText, bucketHash } = require('./forge-maintenance');

// ── exec indirection ─────────────────────────────────────────────────────────
// Mirrors forge-ignore.js's __setExecFileSync pattern (DEC-S03-4): all git/svn
// calls go through vcsExec, an arg-array execFileSync — never execSync, never
// shell:true. This is what makes VCS behavior mockable in tests.
let _execFileSync = childProcess.execFileSync;
function __setExecFileSync(fn) {
  const prev = _execFileSync;
  _execFileSync = fn || childProcess.execFileSync;
  return prev;
}

function vcsExec(cmd, args, opts) {
  return _execFileSync(
    cmd,
    args,
    Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }, opts || {})
  );
}

// ── isRollupPath ──────────────────────────────────────────────────────────────
// Single-source predicate (S02 reserved namespace + ROADMAP consolidated
// targets). Matches:
//   .gsd/<store>/_rollup-<anything>.md   (one store level deep, S02 reserved)
//   .gsd/archive/<anything>rollup<anything>.md
// Rejects: .gsd/ledger/M-....md, .gsd/archive/foo.md, deeper-nested _rollup.
// S04's consolidated outputs MUST satisfy this predicate or the guard is
// blind to them (handoff note in S03-PLAN).
const ROLLUP_RE = /^\.gsd\/(?:archive\/[^/]*rollup[^/]*\.md|[^/]+\/_rollup-[^/]+\.md)$/;
function isRollupPath(relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  return ROLLUP_RE.test(norm);
}

// ── internal git helpers (read-only) ─────────────────────────────────────────

function gitCurrentBranch(cwd) {
  try {
    const out = vcsExec('git', ['branch', '--show-current'], { cwd }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

function gitHasOrigin(cwd) {
  try {
    vcsExec('git', ['remote', 'get-url', 'origin'], { cwd });
    return true;
  } catch {
    return false;
  }
}

// Fetch-first (2026-06-17 lesson, MEM/forge-isolation lineage): never trust
// the stale local ref — always refresh the remote-tracking cache before
// comparing. Read-only: fetch only updates remote-tracking refs, not the
// working tree or the local branch.
function fetchCurrentBranch(cwd) {
  const br = gitCurrentBranch(cwd);
  if (br === null) return { ref: null, fetched: false, warn: 'detached HEAD' };
  if (!gitHasOrigin(cwd)) return { ref: null, fetched: false, warn: 'no origin remote' };
  try {
    vcsExec('git', ['fetch', 'origin', br, '--quiet'], { cwd });
    vcsExec('git', ['rev-parse', '--verify', 'origin/' + br], { cwd });
    return { ref: 'origin/' + br, fetched: true };
  } catch (err) {
    return { ref: null, fetched: false, warn: 'fetch failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

// Enumerate rollup blobs at `ref` under .gsd/. Read-only (git ls-tree).
// Returns [{path, sha}].
function listRollups(cwd, ref) {
  let out;
  try {
    out = vcsExec('git', ['ls-tree', '-r', ref, '--', '.gsd/'], { cwd });
  } catch {
    return [];
  }
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const left = line.slice(0, tabIdx).trim().split(/\s+/);
    const relPath = line.slice(tabIdx + 1).trim();
    const sha = left[2];
    if (isRollupPath(relPath)) entries.push({ path: relPath, sha });
  }
  return entries;
}

// ── dirtyGsd ──────────────────────────────────────────────────────────────────
function dirtyGsd(cwd, vcs) {
  const v = vcs || detectVcs(cwd);
  if (v === 'git') {
    let out;
    try {
      out = vcsExec('git', ['status', '--porcelain', '--', '.gsd/'], { cwd });
    } catch {
      return { dirty: false, files: [] };
    }
    const files = out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.slice(3));
    return { dirty: files.length > 0, files };
  }
  if (v === 'svn') {
    let out;
    try {
      out = vcsExec('svn', ['status', '.gsd'], { cwd });
    } catch {
      return { dirty: false, files: [] };
    }
    const files = out
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('?'))
      .map((l) => l.slice(8).trim());
    return { dirty: files.length > 0, files };
  }
  return { dirty: false, files: [] };
}

// ── precheckHistory (R5a — READ-ONLY) ────────────────────────────────────────
function precheckHistory(cwd, vcs) {
  const v = vcs || detectVcs(cwd);
  if (v === 'none') {
    return { vcs: v, checked: false, already: false, remoteRollups: [], ref: null, warn: 'no VCS' };
  }
  if (v === 'git') {
    const f = fetchCurrentBranch(cwd);
    if (f.ref === null) {
      return { vcs: 'git', checked: false, already: false, remoteRollups: [], ref: null, warn: f.warn };
    }
    const remote = listRollups(cwd, f.ref);
    const local = new Map(listRollups(cwd, 'HEAD').map((e) => [e.path, e.sha]));
    const remoteNew = remote.filter((r) => local.get(r.path) !== r.sha);
    return { vcs: 'git', checked: true, already: remoteNew.length > 0, remoteRollups: remoteNew, ref: f.ref };
  }
  if (v === 'svn') {
    let out;
    try {
      out = vcsExec('svn', ['status', '--show-updates', '--quiet', '.gsd'], { cwd });
    } catch (err) {
      return {
        vcs: 'svn',
        checked: false,
        already: false,
        remoteRollups: [],
        ref: null,
        warn: 'svn status failed: ' + (err && err.message ? err.message : String(err)),
      };
    }
    const hits = [];
    for (const line of out.split('\n')) {
      if (!line.includes('*')) continue;
      const parts = line.trim().split(/\s+/);
      const p = parts[parts.length - 1];
      const norm = String(p).replace(/\\/g, '/');
      if (isRollupPath(norm)) hits.push({ path: norm, sha: null });
    }
    return { vcs: 'svn', checked: true, already: hits.length > 0, remoteRollups: hits, ref: 'HEAD' };
  }
  return { vcs: v, checked: false, already: false, remoteRollups: [], ref: null, warn: 'unknown vcs' };
}

// ── pullScoped (D4 — the ONLY tree-mutating function) ────────────────────────
function pullScoped(cwd, vcs) {
  const v = vcs || detectVcs(cwd);
  if (v === 'none') {
    return { vcs: v, updated: false, method: 'no-vcs' };
  }

  // Dirty check FIRST (DEC-S03-5) — no mutation before this passes.
  const dirty = dirtyGsd(cwd, v);
  if (dirty.dirty) {
    return { vcs: v, updated: false, method: 'dirty-abort', dirtyFiles: dirty.files };
  }

  if (v === 'git') {
    const f = fetchCurrentBranch(cwd);
    if (f.ref === null) {
      return { vcs: 'git', updated: false, method: 'no-remote', warn: f.warn };
    }
    try {
      vcsExec('git', ['diff', '--quiet', 'HEAD', f.ref, '--', '.gsd/'], { cwd });
      // exit 0 → no diff.
      return { vcs: 'git', updated: false, method: 'up-to-date' };
    } catch {
      // non-zero exit → there IS a diff; proceed to materialize it.
    }
    const applied = vcsExec('git', ['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD', f.ref, '--', '.gsd/'], {
      cwd,
    })
      .split('\n')
      .filter((l) => l.trim() !== '');
    const deleted = vcsExec('git', ['diff', '--name-only', '--diff-filter=D', 'HEAD', f.ref, '--', '.gsd/'], { cwd })
      .split('\n')
      .filter((l) => l.trim() !== '');

    // Materialize adds/mods. Checkout with a pathspec never deletes — that
    // is the documented gap explicit deletion-sync below closes.
    vcsExec('git', ['checkout', f.ref, '--', '.gsd/'], { cwd });
    for (const p of deleted) {
      try {
        vcsExec('git', ['rm', '-q', '--ignore-unmatch', '--', p], { cwd });
      } catch {
        // best-effort; a failed deletion-sync entry does not abort the pull
      }
    }
    // Contract: .gsd/ worktree+index now mirror <ref>:.gsd/. Branch head is
    // NOT advanced (git equivalent of `svn update .gsd`; branch-advance
    // policy belongs to S05).
    return { vcs: 'git', updated: true, method: 'checkout-pathspec', applied, deleted, ref: f.ref };
  }

  if (v === 'svn') {
    let output;
    try {
      output = vcsExec('svn', ['update', '.gsd'], { cwd });
    } catch (err) {
      return { vcs: 'svn', updated: false, method: 'svn-update-failed', warn: err && err.message ? err.message : String(err) };
    }
    return { vcs: 'svn', updated: true, method: 'svn-update', output };
  }

  return { vcs: v, updated: false, method: 'unknown-vcs' };
}

// ── recheckAtCommit (R5b — READ-ONLY) ────────────────────────────────────────
function recheckAtCommit(cwd, vcs) {
  const v = vcs || detectVcs(cwd);
  const pre = precheckHistory(cwd, v);
  return {
    vcs: pre.vcs,
    checked: pre.checked,
    collision: pre.already,
    collisions: pre.remoteRollups,
    ref: pre.ref,
    warn: pre.warn,
  };
}

// ── readRemoteBlob (DEC-S03-3 — filter-free) ─────────────────────────────────
function readRemoteBlob(cwd, entry, vcs, ref) {
  const v = vcs || detectVcs(cwd);
  if (v === 'git') {
    // Raw blob bytes — bypasses checkout/eol filters; the autocrlf-safe path.
    return vcsExec('git', ['cat-file', 'blob', entry.sha], { cwd });
  }
  if (v === 'svn') {
    return vcsExec('svn', ['cat', '-r', 'HEAD', entry.path], { cwd });
  }
  throw new Error('readRemoteBlob: unsupported vcs ' + v);
}

// ── resolveCollision — PURE, no I/O ──────────────────────────────────────────
function resolveCollision(localHash, remoteContent) {
  const remoteHash = bucketHash(normalizeText(String(remoteContent)));
  const identical = remoteHash === String(localHash);
  return { action: identical ? 'discard' : 'abort', identical, remoteHash };
}

// ── appendEvent ───────────────────────────────────────────────────────────────
function appendEvent(cwd, evt) {
  try {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const line = JSON.stringify(Object.assign({ ts }, evt));
    const dir = path.join(cwd, '.gsd', 'forge');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n', 'utf8');
    return true;
  } catch {
    // Silent-fail posture: an event-log failure must never mask the abort.
    return false;
  }
}

// ── runCommitGuard — S05 convenience glue ────────────────────────────────────
// localBuckets = [{ path, hash }] (paths repo-relative, forward slashes;
// hash = S01 mergeBucket().hash). No file writes/deletes anywhere in here.
function runCommitGuard(cwd, localBuckets) {
  const vcs = detectVcs(cwd);
  if (vcs === 'none') {
    return { action: 'proceed', collisions: [], ref: null, eventWritten: false };
  }

  const re = recheckAtCommit(cwd, vcs);
  if (!re.collision) {
    return { action: 'proceed', collisions: [], ref: re.ref, eventWritten: false, warn: re.warn };
  }

  const localByPath = new Map((localBuckets || []).map((b) => [String(b.path).replace(/\\/g, '/'), b.hash]));
  const collisions = [];
  for (const entry of re.collisions) {
    const localHash = localByPath.get(entry.path);
    if (localHash === undefined) {
      // Remote did a maintenance we know nothing about locally — unsafe by
      // construction, routed down the abort branch (never guess "identical").
      collisions.push({ path: entry.path, identical: false, localHash: null, remoteHash: null });
      continue;
    }
    const raw = readRemoteBlob(cwd, entry, vcs, re.ref);
    const res = resolveCollision(localHash, raw);
    collisions.push({ path: entry.path, identical: res.identical, localHash, remoteHash: res.remoteHash });
  }

  const anyDivergent = collisions.some((c) => !c.identical);
  if (anyDivergent) {
    const eventWritten = appendEvent(cwd, {
      event: 'maintenance-aborted-collision',
      vcs,
      ref: re.ref,
      collisions,
    });
    // No file writes/deletes anywhere in this function — preserve-both is
    // satisfied by *not acting*.
    return { action: 'abort', collisions, ref: re.ref, eventWritten };
  }

  return { action: 'discard', identical: true, collisions, ref: re.ref, eventWritten: false };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--precheck') args.precheck = true;
    else if (a === '--pull-scoped') args.pullScoped = true;
    else if (a === '--recheck') args.recheck = true;
    else if (a === '--dirty') args.dirty = true;
    else if (a === '--resolve') args.resolve = true;
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--local-hash') args.localHash = argv[++i];
    else if (a === '--remote-file') args.remoteFile = argv[++i];
    else if (a === '--help') args.help = true;
    else return null;
  }
  return args;
}

function printHelp() {
  console.log([
    'forge-maintenance-vcs — VCS concurrency guard',
    '',
    'Usage:',
    '  node forge-maintenance-vcs.js --precheck [--cwd D]',
    '  node forge-maintenance-vcs.js --pull-scoped [--cwd D]',
    '  node forge-maintenance-vcs.js --recheck [--cwd D]',
    '  node forge-maintenance-vcs.js --dirty [--cwd D]',
    '  node forge-maintenance-vcs.js --resolve --local-hash <h> --remote-file <f>',
    '  node forge-maintenance-vcs.js --help',
    '',
    'Exit codes: 0 clean/guard-clear, 3 guard-tripped, 1 runtime error, 2 bad args.',
  ].join('\n'));
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args || args.help) {
    printHelp();
    return args && args.help ? 0 : 2;
  }

  try {
    if (args.precheck) {
      const r = precheckHistory(args.cwd);
      console.log(JSON.stringify(r));
      return r.already ? 3 : 0;
    }
    if (args.pullScoped) {
      const r = pullScoped(args.cwd);
      console.log(JSON.stringify(r));
      return r.method === 'dirty-abort' ? 3 : 0;
    }
    if (args.recheck) {
      const r = recheckAtCommit(args.cwd);
      console.log(JSON.stringify(r));
      return r.collision ? 3 : 0;
    }
    if (args.dirty) {
      const r = dirtyGsd(args.cwd, detectVcs(args.cwd));
      console.log(JSON.stringify(r));
      return r.dirty ? 3 : 0;
    }
    if (args.resolve) {
      if (!args.localHash || !args.remoteFile) {
        console.error('--resolve requires --local-hash and --remote-file');
        return 2;
      }
      const remoteContent = fs.readFileSync(args.remoteFile, 'utf8');
      const r = resolveCollision(args.localHash, remoteContent);
      console.log(JSON.stringify(r));
      return r.action === 'abort' ? 3 : 0;
    }
    printHelp();
    return 2;
  } catch (err) {
    console.error('forge-maintenance-vcs error: ' + (err && err.message ? err.message : String(err)));
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  isRollupPath,
  dirtyGsd,
  precheckHistory,
  pullScoped,
  recheckAtCommit,
  readRemoteBlob,
  resolveCollision,
  runCommitGuard,
  appendEvent,
  __setExecFileSync,
};
