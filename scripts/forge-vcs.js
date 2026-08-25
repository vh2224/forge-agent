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
 * SVN targets also carry peg-revision syntax (`path@rev`). Every SVN command
 * target is escaped at its command boundary; raw paths remain authoritative
 * for classification, filesystem work, preservation checks and reporting.
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

/*
 * Parse the known, machine-produced `svn log --xml -v` format fail-closed
 * (S02/T02, additive — nothing above this point changes behaviour).
 *
 * Molded on parseSvnStatusXml directly above: same tolerant block regex, same
 * "a structurally present entry whose required fields do not parse is a PARSE
 * FAILURE, not an entry to skip" posture. The distinction matters more here
 * than in status: the consumer (forge-unit-delta) attributes WRITES to units,
 * and an entry silently dropped becomes a file nobody wrote — the silent-clean
 * failure class this milestone exists to close. So a `<logentry>` without a
 * readable revision fails the whole parse loudly rather than shrinking the
 * answer quietly.
 *
 * `<paths>` legitimately ABSENT is not a failure: `svn log --xml` without `-v`
 * omits it, and a revision can carry only property changes. That yields
 * `paths: []` — an honest empty, distinguishable from a malformed parse by the
 * `ok` flag, never by an empty array alone.
 *
 * `msg` absent (empty commit message) → `''`, never null: the caller runs a
 * regex over it, and `null` would force every call site to re-handle a case
 * that has one obvious neutral value.
 *
 * Returns { ok: true, revisions: [{ rev, msg, paths: [{ action, path }] }] }
 *      or { ok: false, error: 'svn-log-malformed' }.
 *
 * ── S02 review R1: the four inputs that used to answer `ok: true` ──────────
 *
 * The posture above was DECLARED here and not implemented: four malformed
 * inputs were executed during the S02 review and ALL FOUR returned
 * `{ ok: true }` with a silently shrunken answer — an unclosed `<path>` inside
 * a closed `<paths>` (a written file becomes a file nobody wrote),
 * `revision="12junk"` (`parseInt` prefix-parses, `Number.isFinite` never
 * fires), a truncated stream and outright garbage (both collapse "could not
 * ask" into "asked and there is nothing"). Four guards close them, and each
 * one names the input it exists for:
 *
 *   1. ROOT     — a non-empty payload with no `<log …>` opening tag, or with
 *                 no `</log>` closing tag, is not a log this parser read to the
 *                 end. Truncation and garbage both land here.
 *   2. REVISION — `/^\d+$/` strict. `12junk` is malformed, not revision 12.
 *   3. PATH COUNT — inside a MATCHED `<paths>…</paths>`, the number of `<path`
 *                 opening tags must equal the number of fully parsed entries.
 *                 An unclosed `<path>` no longer evaporates.
 *   4. RESIDUE  — any `<logentry`/`<paths`/`<path` left OUTSIDE every matched
 *                 `<logentry>` block is unconsumed structure; returning a
 *                 shorter `revisions[]` while ignoring it is exactly the
 *                 silent-shrink this function claims not to do.
 */
function parseSvnLogXml(xml) {
  const source = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);

  // 1. ROOT. `svn log --xml` always emits `<log>…</log>`, even for an empty
  // log (`<log>\n</log>`). Absence of either end means the payload is not a
  // complete log — never an empty one.
  if (!/<log\b[^>]*>/.test(source) || !/<\/log\s*>/.test(source)) {
    return { ok: false, error: 'svn-log-malformed' };
  }

  const revisions = [];
  const entryRe = /<logentry\b[^>]*>[\s\S]*?<\/logentry\s*>/g;
  let entryMatch;
  let consumedUpTo = 0;
  let residue = '';
  while ((entryMatch = entryRe.exec(source))) {
    residue += source.slice(consumedUpTo, entryMatch.index);
    consumedUpTo = entryMatch.index + entryMatch[0].length;
    const block = entryMatch[0];
    const open = /^<logentry\b[^>]*>/.exec(block);
    if (!open) return { ok: false, error: 'svn-log-malformed' };
    const revRaw = xmlAttribute(open[0], 'revision');
    // 2. REVISION: strict. A prefix-parse would admit `12junk` as 12.
    if (revRaw === null || !/^\d+$/.test(revRaw.trim())) return { ok: false, error: 'svn-log-malformed' };
    const rev = Number.parseInt(revRaw.trim(), 10);
    if (!Number.isFinite(rev)) return { ok: false, error: 'svn-log-malformed' };

    const msgMatch = /<msg\b[^>]*>([\s\S]*?)<\/msg\s*>/.exec(block);
    const msg = msgMatch ? decodeXmlEntities(msgMatch[1]) : '';

    const paths = [];
    const pathsBlock = /<paths\b[^>]*>[\s\S]*?<\/paths\s*>/.exec(block);
    if (pathsBlock) {
      const pathRe = /<path\b([^>]*)>([\s\S]*?)<\/path\s*>/g;
      let pathMatch;
      while ((pathMatch = pathRe.exec(pathsBlock[0]))) {
        const action = xmlAttribute(`<path${pathMatch[1]}>`, 'action');
        if (action === null) return { ok: false, error: 'svn-log-malformed' };
        paths.push({ action, path: decodeXmlEntities(pathMatch[2]) });
      }
      // 3. PATH COUNT: every `<path` that opened must have been parsed.
      const opened = (pathsBlock[0].match(/<path\b/g) || []).length;
      if (opened !== paths.length) return { ok: false, error: 'svn-log-malformed' };
    }
    revisions.push({ rev, msg, paths });
  }
  residue += source.slice(consumedUpTo);
  // 4. RESIDUE: structure outside every matched entry was never consumed.
  if (/<logentry\b|<paths\b|<path\b/.test(residue)) return { ok: false, error: 'svn-log-malformed' };
  return { ok: true, revisions };
}

/*
 * Changed paths per revision over a range, from a working copy root.
 *
 * Additive read-only primitive (S02/T02). `-v` is what carries `<paths>`; the
 * range is passed as `-r <from>:<to>` so a caller can bound the walk.
 *
 * Failure is CLOSED and named at both stages a caller can distinguish:
 *   exit != 0        → { ok: false, error: 'svn-log-failed', stderr }
 *   unparsable XML   → { ok: false, error: 'svn-log-malformed' }
 * Never `{ ok: true, revisions: [] }` on failure — "asked and there is nothing"
 * and "could not ask" must stay different answers (forge-touch precedent).
 */
function svnLogChangedPaths(cwd, opts) {
  const o = opts || {};
  const fromRev = o.fromRev == null ? 1 : o.fromRev;
  const toRev = o.toRev == null ? 'HEAD' : o.toRev;
  const result = svnRun(cwd, ['log', '--xml', '-v', '-r', `${fromRev}:${toRev}`], o);
  if (result.error || result.status !== 0) {
    return { ok: false, error: 'svn-log-failed', stderr: stderrOf(result, 'svn log failed') };
  }
  return parseSvnLogXml(result.stdout);
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

// -- EOL fidelity advisory (issue #104) --------------------------------------
//
// The restore path below is `git checkout <baseline> -- <paths>`, and a checkout
// HONOURS the user's `core.autocrlf`. On a Windows install where that is `true`
// -- what the Git for Windows installer writes to the SYSTEM config when the
// user picks "Checkout Windows-style" -- a text file stored with LF comes back
// CRLF. So the "restores byte-for-byte" promise is FALSE for that user, and it
// was false SILENTLY: the claim lived only in code and test comments, where
// nobody but an implementer would ever meet it.
//
// The decision on #104 was option (3): keep the behaviour, tell the truth. The
// two rejected alternatives are worth naming so this is not re-litigated by
// accident. Passing `-c core.autocrlf=false` on the restore (option 1) would
// make the restore byte-faithful at the cost of handing that user LF where the
// rest of their tree has CRLF -- the tool would stop honouring the checkout
// configuration they chose, in a RECOVERY path, which is exactly where a
// surprise costs most. Editing prose (option 2) is nearly a no-op: there is no
// user-facing document making the promise to correct.
//
// What is deliberately NOT attempted: deciding per FILE whether conversion
// would really change bytes. That answer needs git's own text/binary
// resolution (the `text` attribute, `text=auto` content sniffing), and a
// per-file claim derived from anything less would be a guess dressed as a
// measurement. So the advisory is scoped to the CONFIGURATION that creates the
// class, and it says "text files" -- never "these files".
//
// `unknown` is not `false`. A probe that could not run (no git, spawn failure,
// an unrecognised value) yields `converts: null` and its own message.
// Collapsing that into "no conversion" would be silence-by-probe-failure --
// the same defect class the issue describes, arriving through a different door.

const AUTOCRLF_VALUES = ['true', 'input', 'false', 'unknown'];
const EOL_SOURCES = ['config', 'git-default', 'unrecognised-value', 'probe-failed'];

const EOL_UNKNOWN_TAIL = 'nao da para afirmar se o restore devolve os bytes de antes.';

/**
 * Resolve the EFFECTIVE `core.autocrlf` for `cwd` and say whether a checkout
 * there converts line endings.
 *
 * `git config --get` already resolves the whole cascade (system -> global ->
 * local), which is why the Git for Windows system default is SEEN here rather
 * than guessed from `process.platform`. Exit 1 means the key is set NOWHERE,
 * and git's compiled-in default for it is `false`.
 *
 * @returns {{ converts: boolean|null, autocrlf: string, source: string, message: string|null }}
 */
function eolRestoreFidelity(cwd, opts) {
  let result;
  try {
    result = git(cwd, ['config', '--get', 'core.autocrlf'], opts);
  } catch (e) {
    return {
      converts: null,
      autocrlf: 'unknown',
      source: 'probe-failed',
      message: 'forge-vcs: nao foi possivel ler core.autocrlf ('
        + ((e && e.message) || 'falha ao invocar git') + ') -- ' + EOL_UNKNOWN_TAIL,
    };
  }

  if (!result || result.error || typeof result.status !== 'number') {
    return {
      converts: null,
      autocrlf: 'unknown',
      source: 'probe-failed',
      message: 'forge-vcs: nao foi possivel ler core.autocrlf -- ' + EOL_UNKNOWN_TAIL,
    };
  }

  // Exit 1 = key absent from every scope. git's built-in default is `false`;
  // this is a MEASURED absence, not a failed probe, so it carries its own source.
  if (result.status === 1) {
    return { converts: false, autocrlf: 'false', source: 'git-default', message: null };
  }
  if (result.status !== 0) {
    return {
      converts: null,
      autocrlf: 'unknown',
      source: 'probe-failed',
      message: 'forge-vcs: git config --get core.autocrlf saiu ' + result.status + ' -- ' + EOL_UNKNOWN_TAIL,
    };
  }

  const raw = (result.stdout ? result.stdout.toString('utf8') : '').trim().toLowerCase();
  // `input` converts on CHECK-IN only; a checkout writes what the blob holds.
  if (raw === 'false' || raw === 'input') {
    return { converts: false, autocrlf: raw, source: 'config', message: null };
  }
  if (raw === 'true') {
    return {
      converts: true,
      autocrlf: 'true',
      source: 'config',
      message: 'forge-vcs: core.autocrlf=true neste repo -- o restore usa `git checkout`, que honra essa '
        + 'configuracao, entao arquivos de TEXTO voltam normalizados para CRLF, e nao com os bytes que '
        + 'tinham antes do reset. O conteudo restaurado e o do baseline; a diferenca e so de fim de linha.',
    };
  }
  return {
    converts: null,
    autocrlf: 'unknown',
    source: 'unrecognised-value',
    message: 'forge-vcs: core.autocrlf tem valor nao reconhecido (' + JSON.stringify(raw) + ') -- ' + EOL_UNKNOWN_TAIL,
  };
}

function gitRestoreAndRemove(cwd, baseline, target, opts) {
  if (target.overlap.length !== 0) {
    throw new Error('executeReset refused: overlap is non-empty (caller must abort)');
  }
  const restored = [];
  const removed = [];
  // Probed only when a restore actually happens: nothing checked out, nothing to
  // convert, and an advisory nobody needs is noise that trains people to skip
  // the ones that matter.
  let eol = null;
  if (target.restore.length) {
    eol = eolRestoreFidelity(cwd, opts);
    const checkout = git(cwd, ['checkout', baseline, '--', ...target.restore], opts);
    if (checkout.status !== 0) return { ok: false, restored, removed, eol, error: stderrOf(checkout, 'git checkout failed') };
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
  return { ok: true, restored, removed, eol };
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
    // Targets files carry literal paths. Some SVN builds do not strip a peg
    // escape in this format, so never append `@` here. The ordinary batch uses
    // only non-sensitive paths; a one-path batch is also the compatibility
    // fallback when an SVN build rejects an argv-escaped `@` directory.
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
    const prefix = `${String(dirPath).replace(/\\/g, '/')}/`;
    for (const preserved of preservedSet) {
      if (String(preserved).replace(/\\/g, '/').startsWith(prefix)) return true;
    }
    return false;
  };
  const infinityPaths = [];
  const emptyPaths = [];
  for (const p of all) {
    if (isDirTarget(p) && hasPreservedDescendant(p)) emptyPaths.push(p);
    else infinityPaths.push(p);
  }
  // `--targets` does not reliably apply peg escaping to a literal `@` path:
  // SVN 1.14.2 can exit 0 while leaving that target modified. Route both `@`
  // and newline paths through argv, where a trailing `@` is unambiguous.
  const individualInfinity = infinityPaths.filter((p) => /[\r\n@]/.test(p));
  const ordinaryInfinity = infinityPaths.filter((p) => !/[\r\n@]/.test(p));
  const individualEmpty = emptyPaths.filter((p) => /[\r\n@]/.test(p));
  const ordinaryEmpty = emptyPaths.filter((p) => !/[\r\n@]/.test(p));
  try {
    if (ordinaryInfinity.length) {
      const result = svnRevertBatch(cwd, ordinaryInfinity, 'infinity', opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    if (ordinaryEmpty.length) {
      const result = svnRevertBatch(cwd, ordinaryEmpty, 'empty', opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    for (const relPath of individualInfinity) {
      let result = svnRun(cwd, ['revert', '--depth', 'infinity', '--', svnPegSafe(relPath)], opts);
      if (result.status !== 0 && !/[\r\n]/.test(relPath)) result = svnRevertBatch(cwd, [relPath], 'infinity', opts);
      if (result.status !== 0) return { ok: false, restored, removed, error: svnErrorCode(result, 'svn revert failed') };
    }
    for (const relPath of individualEmpty) {
      let result = svnRun(cwd, ['revert', '--depth', 'empty', '--', svnPegSafe(relPath)], opts);
      if (result.status !== 0 && !/[\r\n]/.test(relPath)) result = svnRevertBatch(cwd, [relPath], 'empty', opts);
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
 * Call sites: svnIsTracked and revert command boundaries. Callers retain raw
 * paths for filesystem checks, preserved descendants and result reporting.
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
  // `eol` is additive for readers that PICK fields, and for JSON consumers; it
  // is `null` whenever nothing was restored (see gitRestoreAndRemove). It is
  // NOT invisible to a deep-equality assertion, which sees every key -- one in
  // forge-vcs.test.js had to learn the field. Saying "additive, nobody is
  // affected" without that caveat would be the kind of claim this repo keeps
  // having to retract.
  return result.ok
    ? { vcs, ok: true, restored: result.restored, removed: result.removed, eol: result.eol }
    : { vcs, ok: false, restored: result.restored, removed: result.removed, eol: result.eol, error: result.error };
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
  // Additive (S02/T02) — svnRun already existed at :71 and was internal only.
  svnRun,
  parseSvnLogXml,
  svnLogChangedPaths,
  decodeXmlEntities,
  mapSvnItem,
  pruneEmptyParents,
  isGsdPath,
  // Additive (#104): the EOL advisory, exported so the reset CLI can surface it
  // and so the closed sets can be crossed from a test.
  eolRestoreFidelity,
  AUTOCRLF_VALUES,
  EOL_SOURCES,
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
