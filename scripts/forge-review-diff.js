#!/usr/bin/env node
'use strict';

/*
 * forge-review-diff.js — the reviewable diff of ONE unit in an SVN working copy.
 *
 * WHY THIS IS A PROGRAM AND NOT THREE LINES OF BASH IN TWO MARKDOWN FILES
 *
 * `DIFF_CMD` is not merely executed by the review gate — arguments are APPENDED
 * to it by three separate consumers:
 *   - `$DIFF_CMD --name-only`        (pattern scan, both boundaries)
 *   - `eval "$DIFF_CMD" --name-only` (empty-diff probe, slice boundary)
 *   - `{DIFF_CMD} -- <files>`        (per-shard scoping, forge-review Step 2.0)
 * So `DIFF_CMD` must be ONE command that accepts those flags. A composed shell
 * string (`svn diff …; diff -u /dev/null new`) satisfies none of them, and plain
 * `svn diff` satisfies neither of the first two — `svn diff --name-only` does not
 * exist, which is why the SVN branch shipped in M017 is silently broken in every
 * consumer that appends. This program is that single command.
 *
 * WHAT IT FIXES BEYOND "no diff to review"
 *
 * 1. SCOPE. `svn diff` with no paths is the WHOLE working copy. SVN has no
 *    per-slice branch and no merge-base, and a working copy is routinely shared
 *    by several developers at once, so the unscoped diff carries other people's
 *    uncommitted work. Measured in the field: 49 files, 8 of them the unit's.
 *    A challenger spends its budget objecting to code the unit does not own.
 *    The diff is therefore intersected with a MANIFEST of the unit's paths.
 * 2. UNTRACKED FILES. `svn diff` cannot show an unversioned (`?`) file at all.
 *    Observed on a real slice whose entire change was two new files: the review
 *    would have read nothing and rendered CLEAN, which is the worst possible
 *    outcome for a gate. New files are reconstructed here as unified diff
 *    against /dev/null, in `svn diff` output shape.
 * 3. PEG REVISIONS — and the trap is the OPPOSITE of the obvious fix. A path
 *    containing `@` (`SERVICES/services@1.2.0` — real in this ecosystem) is read
 *    by most svn subcommands as `path@rev`, and the documented escape is a
 *    trailing `@`. Applying that escape here breaks EVERY path. Measured
 *    (svn 1.14.2, working-copy targets):
 *      svn diff -- src/services@1.2.0.ts    → works, `@` is part of the name
 *      svn diff -- src/services@1.2.0.ts@   → E155010, node '…ts@' not found
 *      svn diff -- src/plain.ts@            → E155010 as well
 *      svn diff -- 'weird@2'                → works, even though `2` is a valid
 *                                             revision — `svn diff` does not peg-
 *                                             parse working-copy targets at all
 *    while `svn info`/`svn add`/`svn delete` DO require the escape on the same
 *    paths. So diff targets are passed LITERALLY here, and the asymmetry is
 *    pinned by a test that exercises the real client rather than our model of
 *    it. (`--targets <file>` would sidestep the question entirely, but `svn
 *    diff` rejects that option — hence argv batching below.)
 *
 * BASELINE (decided, not defaulted). The diff is against BASE — the working
 * copy's own pristine revision — NOT against the `.start-sha` marker.
 *   - `svnversion` (what the marker records) returns things like `44531:44534M`
 *     in a mixed-revision working copy. That is not a revision `svn diff -r`
 *     accepts.
 *   - More decisively: in a SHARED working copy, diffing against a recorded
 *     revision would pull in every OTHER developer's commits landed since — the
 *     exact opposite of the scoping this program exists to provide.
 *   - "Uncommitted work" is what the unit produced when a team holds commits,
 *     and that is precisely `svn diff` against BASE.
 * So the SVN baseline marker is intentionally inert here, matching the existing
 * precedent in forge-vcs.js svnPostChanges ("SVN baseline is intentionally
 * inert: status is always compared to BASE").
 *
 * `.gsd/**` is excluded before any of this: Forge's own plans, summaries and
 * evidence logs are not the code under review, and in an SVN working copy they
 * sit in the tree as unversioned files rather than being ignored by a branch
 * nobody reviews. Uses the repo's canonical `isGsdPath` predicate; the count is
 * reported as `gsd_excluded` rather than padding the `excluded` list.
 *
 * NEVER EMPTY BY SCOPING. If the manifest is absent, or intersects nothing, the
 * scope falls back to every changed path (today's unscoped behavior) and says so
 * in --scope-report. Emitting an empty diff because scoping mis-fired would make
 * the gate write "no diff to review" and pass — silence indistinguishable from a
 * clean review.
 *
 * CLI:
 *   node forge-review-diff.js --cwd <dir> [--paths-file <f>] [--unit-dir <d>]
 *                             [--name-only] [--scope-report] [-- <files...>]
 *
 * Exit codes: 0 produced output (possibly empty), 2 unavailable/unsafe review.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { detectVcs } = require('./forge-ignore.js');
const { parseSvnStatusXml, isGsdPath } = require('./forge-vcs.js');

const MAX_BUFFER = 32 * 1024 * 1024;
// Windows CreateProcess caps the command line near 32K. Batch well below it.
const ARGV_BUDGET = 6000;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

function git(cwd, args) {
  const result = spawnSync('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 30000, windowsHide: true,
  });
  if (result.status !== 0 || result.error) throw new Error('git-review-command-failed');
  return result.stdout || '';
}
function safeGitPath(cwd, rel, { missing = false } = {}) {
  if (!rel || /[\x00-\x1f\x7f:]/.test(rel) || rel.includes('\\') || path.isAbsolute(rel)
      || rel.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('git-review-path-invalid');
  let file = cwd;
  const parts = rel.split('/');
  for (let index = 0; index < parts.length; index++) {
    file = path.join(file, parts[index]);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw new Error('git-review-file-unreadable'); }
    if (stat.isSymbolicLink()) throw new Error('git-review-link');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('git-review-path-invalid');
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) throw new Error('git-review-file-type');
  }
  return file;
}
function gitState(cwd, base = 'HEAD') {
  const revision = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('git-review-baseline-invalid');
  const tracked = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', revision, '--']).split('\0').filter(Boolean);
  const fresh = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  let gsdExcluded = 0;
  const keep = values => [...new Set(values)].filter(rel => {
    if (isGsdPath(rel)) { gsdExcluded++; return false; }
    safeGitPath(cwd, rel, { missing: true }); return true;
  }).sort();
  return { ok: true, versioned: keep(tracked), untracked: keep(fresh), gsdExcluded, revision };
}
function gitDiff(cwd, scope, revision) {
  let out = '';
  for (const rel of scope.versioned) {
    const text = git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', revision, '--', rel]);
    if (/^(?:Binary files |GIT binary patch|(?:new|deleted) file mode (?:120000|160000)|(?:old|new) mode (?:120000|160000))/m.test(text))
      throw new Error('git-review-content-unavailable');
    out += `Index: ${rel}\n${'='.repeat(67)}\n${text}`;
    if (Buffer.byteLength(out) > MAX_BUFFER) throw new Error('git-review-output-limit');
  }
  for (const rel of scope.untracked) {
    const file = safeGitPath(cwd, rel), before = fs.lstatSync(file);
    if (before.size > MAX_UNTRACKED_BYTES) throw new Error('git-review-file-limit');
    const io = Object.create(fs);
    io.openSync = target => fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const read = require('./forge-autonomy-sources').readBoundedStableFile(file, MAX_UNTRACKED_BYTES, { expectedReal: fs.realpathSync.native(file), io });
    if (read.error) throw new Error(read.error === 'source_too_large' ? 'git-review-file-limit' : 'git-review-file-changed');
    const data = read.buffer, after = fs.lstatSync(file);
    safeGitPath(cwd, rel);
    if (after.isSymbolicLink() || after.nlink !== 1 || read.stat.nlink !== 1
      || [read.stat, after].some(stat => before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size
        || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs))
      throw new Error('git-review-file-changed');
    if (data.includes(0)) throw new Error('git-review-content-unavailable');
    const value = data.toString('utf8'), newline = value.endsWith('\n'), lines = value.split(/\r?\n/);
    if (newline) lines.pop();
    out += `Index: ${rel}\n${'='.repeat(67)}\n--- ${rel}\t(nonexistent)\n+++ ${rel}\t(working copy)\n`;
    if (value) {
      out += `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line + '\n').join('');
      if (!newline) out += '\\ No newline at end of file\n';
    }
    if (Buffer.byteLength(out) > MAX_BUFFER) throw new Error('git-review-output-limit');
  }
  return out;
}

function svn(cwd, args) {
  const result = spawnSync('svn', ['--non-interactive', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    // Diagnostics and status codes must not shift with the operator's locale.
    env: { ...process.env, LC_ALL: 'C' },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// ── Manifest — which paths belong to THIS unit ──────────────────────────────
// Two independent sources, unioned. Neither is trusted to be complete on its
// own: `files_changed` is VCS-derived on the sidecar path but self-declared by a
// Claude executor, and a plan's declared outputs can be stale. Over-inclusion
// only costs review budget; under-inclusion costs coverage, so the union wins.

function readPathsFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map(normalize).filter(Boolean);
}

const PLAN_LIST_KEYS = ['expected_output', 'writes', 'artifacts', 'key_files'];

const INDENT_OF = line => /^[ \t]*/.exec(line)[0].length;

function stripQuotes(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Resolves one block-list item to the path it declares. Items come in two
 * shapes: a bare scalar (`- src/a.ts`) and a mapping whose `path:` names the
 * file (`must_haves.artifacts[]`). A mapping led by any other key is metadata
 * (min_lines, provides, …); returning its value would inject a garbage entry
 * into the manifest, so it contributes nothing.
 */
function itemDeclaredPath(raw) {
  if (/^[A-Za-z][A-Za-z0-9_-]*::/.test(raw)) return stripQuotes(raw);
  const mapping = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw);
  if (!mapping) return stripQuotes(raw);
  return /^(path|file)$/i.test(mapping[1]) ? stripQuotes(mapping[2]) : '';
}

/**
 * Pulls declared output paths out of a unit's plan/summary frontmatter. A
 * hand-rolled reader for the shapes these files use (`key:` followed by
 * `  - "value"` lines, by `  - path: "value"` entries carrying their own
 * nested keys, or an inline `[a, b]`) — the repo has no YAML dependency
 * and this must never throw on a malformed plan: a manifest that cannot be read
 * degrades to "no manifest", which degrades to unscoped, which is visible.
 */
function readDeclaredPaths(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!header || !PLAN_LIST_KEYS.includes(header[1])) continue;
    const inline = header[2].trim();
    if (inline.startsWith('[')) {
      for (const piece of inline.replace(/^\[|\]$/g, '').split(',')) {
        const value = piece.trim().replace(/^["']|["']$/g, '');
        if (value) out.push(normalize(value));
      }
      continue;
    }
    if (inline && inline !== '|' && inline !== '>') {
      out.push(normalize(inline.replace(/^["']|["']$/g, '')));
      continue;
    }
    // Block list. An entry may be a mapping (`- path: "x"` + `  min_lines: 40`),
    // so a non-item line indented DEEPER than the items is a nested key of the
    // current entry, not the end of the list — treating it as the end drops
    // every remaining entry silently, which is under-inclusion, the one
    // direction this reader cannot afford.
    let itemIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^([ \t]*)-\s+(.+?)\s*$/.exec(lines[j]);
      if (!item) {
        if (/^\s*$/.test(lines[j])) continue;
        if (itemIndent !== null && INDENT_OF(lines[j]) > itemIndent) continue;
        break;
      }
      if (itemIndent === null) itemIndent = item[1].length;
      else if (item[1].length < itemIndent) break; // dedent — this list ended
      else if (item[1].length > itemIndent) continue; // a list nested under an entry's own key
      const value = itemDeclaredPath(item[2]);
      if (value) out.push(normalize(value));
    }
  }
  return out;
}

function collectUnitDeclaredPaths(unitDir, cwd) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /-(PLAN|SUMMARY)\.md$/i.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        const declared = readDeclaredPaths(content);
        if (declared.some(p => p.includes('::'))) {
          if (!cwd) throw new Error('review-root-context-required');
          const fields = require('./forge-must-haves').parseExecutionFields(content);
          const roots = require('./forge-code-roots');
          const contract = roots.validateContract({ schema_version: 2, owner: cwd,
            primary_root_id: fields.primary_root_id, code_roots: fields.code_roots });
          const physical = fs.realpathSync.native(cwd);
          const current = contract.code_roots.find(r => roots.key(r.path) === roots.key(physical));
          if (!current) throw new Error('review-root-context-mismatch');
          for (const p of declared) {
            const resolved = roots.resolvePath(contract, p);
            if (resolved.root_id === current.id) out.push(resolved.path);
          }
        } else out.push(...declared);
      }
    }
  };
  walk(unitDir, 0);
  return out;
}

// ── Working-copy state ──────────────────────────────────────────────────────
// `svn status --xml` reports every LOCAL change against BASE. It does not list
// unmodified files (nothing to review) nor ignored ones (correctly invisible).

const CHANGED_ITEMS = new Set(['modified', 'added', 'deleted', 'replaced', 'missing', 'conflicted']);

function changedEntries(cwd) {
  const status = svn(cwd, ['status', '--xml', '--ignore-externals']);
  if (!status.ok) return { ok: false, error: (status.stderr.trim().split('\n')[0] || 'svn-status-failed') };
  const parsed = parseSvnStatusXml(status.stdout);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const versioned = [];
  const untracked = [];
  let gsdExcluded = 0;
  for (const entry of parsed.entries) {
    const p = normalize(entry.path);
    if (!p) continue;
    // Forge's own artifacts are not the code under review. In git they are
    // usually ignored or committed on a branch nobody reviews; in an SVN working
    // copy they sit right there as unversioned files, so an unscoped diff hands
    // the challenger plans, summaries and evidence logs. `isGsdPath` is the
    // repo's canonical predicate for exactly this exclusion.
    if (isGsdPath(p)) { gsdExcluded += 1; continue; }
    if (entry.item === 'unversioned') untracked.push(p);
    else if (CHANGED_ITEMS.has(entry.item)) versioned.push(p);
    else if (entry.item === 'normal' && entry.props !== 'none') versioned.push(p);
  }
  return { ok: true, versioned, untracked, gsdExcluded };
}

/** An unversioned DIRECTORY is reported as one entry; the review needs its files. */
function expandUntracked(cwd, entries) {
  const files = [];
  const visit = (rel, depth) => {
    if (depth > 64 || files.length > 100000) throw new Error('svn-review-inventory-limit');
    const abs = path.resolve(cwd, rel);
    let stat;
    try { stat = fs.lstatSync(abs); } catch { throw new Error('svn-review-inventory-unreadable'); }
    if (stat.isSymbolicLink()) throw new Error('svn-review-inventory-link'); // never follow links
    if (stat.isFile()) { files.push(rel); return; }
    if (!stat.isDirectory()) return;
    let children = [];
    try { children = fs.readdirSync(abs); } catch { throw new Error('svn-review-inventory-unreadable'); }
    for (const child of children) visit(`${rel}/${child}`, depth + 1);
  };
  for (const entry of entries) visit(entry, 0);
  return files;
}

// ── Scoping ─────────────────────────────────────────────────────────────────

function withinManifest(candidate, manifest) {
  if (manifest.has(candidate)) return true;
  // A manifest entry may name a directory; everything under it belongs to the unit.
  //
  // Trade-off, deliberate: a coarse entry (`src`) pulls in whatever else lives
  // under it — including another owner's work — while `reason` still reports
  // `manifest`, so the disclosure reads as correctly scoped when it is merely
  // wide. Accepted because over-inclusion only costs review budget, and because
  // declared outputs are files in every plan on disk; if directory entries ever
  // become common, the reason label is what has to earn a `manifest:coarse`.
  for (const declared of manifest) {
    if (declared && candidate.startsWith(`${declared}/`)) return true;
  }
  return false;
}

function computeScope({ versioned, untracked, manifest, only }) {
  if ([...manifest].some(p => p.includes('::'))) throw new Error('review-root-context-required');
  const all = { versioned, untracked };
  let reason = 'manifest';
  let scoped = all;

  if (manifest.size === 0) {
    reason = 'unscoped:no-manifest';
  } else {
    const keep = list => list.filter(p => withinManifest(p, manifest));
    const candidate = { versioned: keep(versioned), untracked: keep(untracked) };
    if (candidate.versioned.length === 0 && candidate.untracked.length === 0) {
      // Never let scoping produce an empty diff: the gate would write "no diff
      // to review" and pass, which reads exactly like a clean review.
      reason = 'unscoped:manifest-matched-nothing';
    } else {
      scoped = candidate;
    }
  }

  if (only && only.length) {
    const wanted = new Set(only.map(normalize));
    scoped = {
      versioned: scoped.versioned.filter(p => wanted.has(p)),
      untracked: scoped.untracked.filter(p => wanted.has(p)),
    };
    reason += '|shard';
  }

  const inScope = new Set([...scoped.versioned, ...scoped.untracked]);
  const excluded = [...versioned, ...untracked].filter(p => !inScope.has(p));
  return { ...scoped, reason, excluded };
}

// ── Diff production ─────────────────────────────────────────────────────────

function batched(paths) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const p of paths) {
    const cost = p.length + 4;
    if (current.length && size + cost > ARGV_BUDGET) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function versionedDiff(cwd, paths) {
  let out = '';
  for (const batch of batched(paths)) {
    // Targets are literal — see the peg-revision note in the file header. `--`
    // still guards a path that begins with `-`.
    const result = svn(cwd, ['diff', '--', ...batch]);
    out += result.stdout;
    // A failed batch is reported inline rather than dropped: a path missing from
    // a review must never be missing silently (that is the peg-revision failure
    // mode this program exists to prevent).
    if (!result.ok && result.stderr.trim()) {
      out += `\n### forge-review-diff: svn diff failed for ${batch.length} path(s): ${result.stderr.trim().split('\n')[0]}\n`;
    }
  }
  return out;
}

const BINARY_NOTICE = 'Cannot display: file marked as a binary type.';

/**
 * `svn diff` cannot show an unversioned file, so the added-file hunk is
 * reconstructed here in the same shape SVN emits for an add.
 */
function untrackedDiff(cwd, paths) {
  let out = '';
  for (const rel of paths) {
    const abs = path.resolve(cwd, rel);
    let data;
    try { data = fs.readFileSync(abs); } catch { continue; }
    const header = `Index: ${rel}\n${'='.repeat(67)}\n`;
    if (data.includes(0)) {
      out += `${header}${BINARY_NOTICE}\n\n`;
      continue;
    }
    if (data.length > MAX_UNTRACKED_BYTES) {
      out += `${header}### forge-review-diff: new file omitted, ${data.length} bytes exceeds the ${MAX_UNTRACKED_BYTES}-byte cap\n\n`;
      continue;
    }
    const text = data.toString('utf8');
    if (text === '') {
      out += `${header}--- ${rel}\t(nonexistent)\n+++ ${rel}\t(working copy)\n`;
      continue;
    }
    const hadTrailingNewline = text.endsWith('\n');
    const lines = text.split(/\r?\n/);
    if (hadTrailingNewline) lines.pop();
    out += `${header}--- ${rel}\t(nonexistent)\n+++ ${rel}\t(working copy)\n`;
    out += `@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) out += `+${line}\n`;
    if (!hadTrailingNewline) out += '\\ No newline at end of file\n';
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { only: [] };
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  if (sep !== -1) args.only = argv.slice(sep + 1).filter(Boolean);
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = flags[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

// Cost and sharding use the same reconstructed SVN diff as the reviewer.
function collectDiffEntries(cwd, scopeFile) {
  const state = changedEntries(cwd);
  if (!state.ok) return { ok: false, entries: [], warning: state.error };
  let scope;
  try { scope = computeScope({ versioned: state.versioned, untracked: expandUntracked(cwd, state.untracked),
    manifest: new Set(scopeFile ? readPathsFile(scopeFile) : []), only: [] }); }
  catch (error) { return { ok: false, entries: [], warning: error.message }; }
  const text = versionedDiff(cwd, scope.versioned) + untrackedDiff(cwd, scope.untracked);
  const entries = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Index: ')) {
      const file = normalize(line.slice(7));
      current = entries.get(file) || { file, added: 0, deleted: 0, binary: false, review_lines: 0 };
      entries.set(file, current);
    }
    if (!current) continue;
    current.review_lines++;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    if (line.startsWith('-') && !line.startsWith('---')) current.deleted++;
    if (line === BINARY_NOTICE || line.includes('new file omitted,')) current.binary = true;
  }
  const warning = text.includes('### forge-review-diff:') ? 'svn-review-diff-incomplete' : null;
  return { ok: warning === null, entries: [...entries.values()], warning };
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(`forge-review-diff — reviewable diff of one unit in Git or SVN

  --cwd <dir>          working copy (default: process.cwd())
  --base <commit>      Git baseline (default HEAD); includes current dirty and untracked files
  --paths-file <f>     manifest: one path per line (e.g. files_changed)
  --unit-dir <d>       unit artifact dir; declared outputs are read from its
                       *-PLAN.md / *-SUMMARY.md and unioned into the manifest
  --name-only          print the scoped paths instead of the diff
  --scope-report       print a JSON scope report instead of the diff
  -- <files...>        restrict to these paths (per-shard review)

Diffs against BASE; the SVN baseline marker is intentionally inert (see header).
`);
    return 0;
  }

  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();

  const vcs = detectVcs(cwd);
  if (!['svn', 'git'].includes(vcs)) {
    process.stderr.write('forge-review-diff: vcs-unavailable:none-or-detection-failed\n');
    return 2;
  }

  const state = vcs === 'git' ? gitState(cwd, typeof args.base === 'string' ? args.base : 'HEAD') : changedEntries(cwd);
  if (!state.ok) {
    process.stderr.write(`forge-review-diff: ${state.error}\n`);
    return 2;
  }

  const manifest = new Set();
  if (typeof args['paths-file'] === 'string') for (const p of readPathsFile(args['paths-file'])) manifest.add(p);
  if (typeof args['unit-dir'] === 'string') for (const p of collectUnitDeclaredPaths(path.resolve(args['unit-dir']), cwd)) manifest.add(p);

  const untrackedFiles = vcs === 'git' ? state.untracked : expandUntracked(cwd, state.untracked);
  const scope = computeScope({
    versioned: state.versioned,
    untracked: untrackedFiles,
    manifest,
    only: args.only,
  });

  if (args['scope-report']) {
    process.stdout.write(JSON.stringify({
      vcs,
      baseline: vcs === 'git' ? state.revision : 'BASE',
      reason: scope.reason,
      manifest_size: manifest.size,
      gsd_excluded: state.gsdExcluded,
      scoped: [...scope.versioned, ...scope.untracked].sort(),
      untracked_included: scope.untracked.slice().sort(),
      excluded: scope.excluded.slice().sort(),
    }) + '\n');
    return 0;
  }

  if (args['name-only']) {
    const names = [...scope.versioned, ...scope.untracked].sort();
    process.stdout.write(names.length ? names.join('\n') + '\n' : '');
    return 0;
  }

  process.stdout.write(vcs === 'git' ? gitDiff(cwd, scope, state.revision) : versionedDiff(cwd, scope.versioned) + untrackedDiff(cwd, scope.untracked));
  return 0;
}

module.exports = {
  normalize,
  readDeclaredPaths,
  collectUnitDeclaredPaths,
  computeScope,
  untrackedDiff,
  batched,
  changedEntries,
  expandUntracked,
  collectDiffEntries,
};

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    const code = /^git-review-[a-z-]+$/.test(error.message) ? error.message : 'review-diff-unavailable';
    process.stderr.write(`forge-review-diff: ${code}\n`); process.exitCode = 2;
  }
}
