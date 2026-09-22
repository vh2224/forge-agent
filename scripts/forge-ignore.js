#!/usr/bin/env node
// forge-ignore — VCS detection + ignore-rule applier/validator for Forge Agent
//
// Library exports:
//   LOCAL_IGNORE_PATHS        // Object.freeze([...]) — canonical Layer-1 paths
//   PROJECTION_IGNORE_PATHS   // Object.freeze([...]) — projection monoliths derived from fragment stores
//   detectVcs(cwd)            // (cwd) → 'git' | 'svn' | 'none'
//   applyIgnore(cwd)          // (cwd) → { vcs, added: string[], skipped: string[] }
//   validateIgnore(cwd)       // (cwd) → { vcs, missing: string[], ok: boolean }
//
// CLI:
//   node forge-ignore.js --detect-vcs [--cwd <dir>]
//   node forge-ignore.js --list-paths
//   node forge-ignore.js --apply [--cwd <dir>]
//   node forge-ignore.js --validate [--cwd <dir>]
//   node forge-ignore.js --help
//
// Exit codes: 0 on success, 1 on validate-failed or SVN error, 2 on bad args.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

// Indirection layer so tests can stub SVN calls without a real working copy.
// Defaults to the real execFileSync; __setExecFileSync swaps it (and restores).
let _execFileSync = childProcess.execFileSync;
function __setExecFileSync(fn) {
  const prev = _execFileSync;
  _execFileSync = fn || childProcess.execFileSync;
  return prev;
}

// ── LOCAL_IGNORE_PATHS ────────────────────────────────────────────────────────
// Canonical Layer-1 local-state paths that must be ignored by VCS.
// Patterns are relative to repo root (for Git) or absolute path-prefixed
// relative patterns (for SVN, grouped by parent directory at apply time).
const LOCAL_IGNORE_PATHS = Object.freeze([
  '.gsd/STATE.md',
  '.gsd/forge/auto-mode.json',
  '.gsd/forge/auto-mode-started.txt',
  '.gsd/forge/pause',
  '.gsd/forge/runs/',
  '.gsd/forge/events.jsonl',
  '.gsd/forge/evidence-*.jsonl',
  '.gsd/forge/compact-signal.json',
  '.gsd/forge/prompts/',
  '.gsd/forge/projection-state.json',
]);

// ── PROJECTION_IGNORE_PATHS ───────────────────────────────────────────────────
// Derived monoliths regenerated on-read from fragment stores.
// The fragment file is the source of truth (e.g. .gsd/ledger/<id>.md);
// the monolith is a projection rebuilt by S05's read layer.
// All 5 entries are projection targets — S05 regenerates them on-read from the fragment stores under .gsd/{ledger,decisions,memory,checker-memory,items}/.
const PROJECTION_IGNORE_PATHS = Object.freeze([
  '.gsd/LEDGER.md',
  '.gsd/DECISIONS.md',
  '.gsd/AUTO-MEMORY.md',
  '.gsd/CHECKER-MEMORY.md',
  '.gsd/ITEMS.md',
]);

// Internal: union of all ignored paths (LOCAL + PROJECTION).
function allIgnorePaths() {
  return [...LOCAL_IGNORE_PATHS, ...PROJECTION_IGNORE_PATHS];
}

// ── detectVcs ─────────────────────────────────────────────────────────────────
// Checks cwd first, then asks SVN for the working-copy root when cwd is below it.
// Layer-1 normally operates at the repo root where .gsd/ lives.
// Root-anchored probe: since SVN 1.7 only the WC ROOT carries .svn, so a
// CODE_DIR pointing at a subdirectory reads as 'none' without this.
function svnWcRoot(dir) {
  try {
    const out = _execFileSync('svn',
      ['info', '--show-item', 'wc-root', '--non-interactive', dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const root = String(out || '').trim();
    return root || null;
  } catch (_) {
    return null;
  }
}

// Pure filesystem walk-up: does any ancestor directory contain a .svn dir?
// Since SVN 1.7, .svn only exists at the WC root, so "inside a WC" is
// exactly "some ancestor has .svn". Zero-cost compared to spawning svn,
// and lets us skip the spawn entirely in the common (no-VCS) hot path.
function hasAncestorSvn(dir) {
  let p = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(p, '.svn'))) return true;
    const parent = path.dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

function detectVcs(cwd) {
  const dir = cwd || process.cwd();
  if (fs.existsSync(path.join(dir, '.git'))) return 'git';
  if (fs.existsSync(path.join(dir, '.svn'))) return 'svn';
  // Keep both fast-paths: root behavior stays byte-identical and git avoids svn spawn.
  // Only probe svn (spawn) when a pure filesystem walk-up finds a candidate
  // ancestor .svn — avoids spawning svn for the common no-VCS case.
  if (hasAncestorSvn(dir) && svnWcRoot(dir)) return 'svn';
  return 'none';
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Read .gitignore lines, returning an array of trimmed non-empty lines.
//
// Form A/funnel (S03-FIXSET.json): normalize once at the read. applyIgnore
// only ever APPENDS to this file, never rewrites it, so existing bytes are
// untouched by this normalization — but a CRLF .gitignore left the split
// with a trailing CR on every entry, which made the presence check below
// miss an already-present line and re-append it. `/\r\n?/g`, never
// `/\r\n/g` — a lone CR degrades identically.
function readGitignoreLines(gitignorePath) {
  if (!fs.existsSync(gitignorePath)) return [];
  return fs.readFileSync(gitignorePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
}

// Group LOCAL_IGNORE_PATHS by their parent directory for SVN propset.
// Returns Map<dirName, basename[]> — e.g. '.gsd' → ['STATE.md'], '.gsd/forge' → ['auto-mode.json', ...]
function groupByParentDir(paths) {
  const groups = new Map();
  for (const p of paths) {
    const parentDir = path.posix.dirname(p);
    const basename = path.posix.basename(p);
    if (!groups.has(parentDir)) groups.set(parentDir, []);
    groups.get(parentDir).push(basename);
  }
  return groups;
}

// Returns true if `dir` is under SVN version control. A non-versioned node
// (e.g. a directory the parent ignores wholesale) makes `svn info` exit non-zero
// — we treat any failure as "not versioned". Used to skip per-child ignore
// rules inside directories already covered by an ancestor's wholesale ignore.
function svnIsVersioned(dir) {
  try {
    _execFileSync('svn', ['info', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch (_) {
    return false;
  }
}

// Run svn propget svn:ignore on a directory; returns array of existing patterns (trimmed).
// Returns [] on any error (property not set, SVN not found, etc.)
function svnPropget(dir) {
  try {
    const out = _execFileSync('svn', ['propget', 'svn:ignore', dir], { encoding: 'utf8' });
    // Tolerant split: `svn propget` output is CRLF on Windows. The read side of the
    // propget→propset round-trip must not turn one pattern into two, nor smuggle a
    // lone CR into a pattern.
    return out.split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
  } catch (e) {
    // Property not set on dir → empty; treat as []
    if (e.stderr && /E200009|svn: E/.test(e.stderr)) return [];
    // Any other error: rethrow with context
    const msg = (e.stderr || e.message || String(e)).trim();
    throw new Error(`svn propget failed on "${dir}": ${msg}`);
  }
}

// Write patterns via tempfile and svn propset.
// EOL note (Form B audit, S03/T02): this tempfile is GENERATED — it never re-emits
// bytes read from a file on disk, so there is no original EOL to capture here. The
// round-trip's byte-preserving side is svnPropget above (tolerant read). LF is the
// separator svn itself stores svn:ignore with; emitting CRLF would be the churn.
function svnPropset(dir, patterns) {
  const tmp = path.join(os.tmpdir(), `forge-ignore-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, patterns.join('\n') + '\n', 'utf8');
    _execFileSync('svn', ['propset', 'svn:ignore', '-F', tmp, dir], { encoding: 'utf8' });
  } catch (e) {
    const msg = (e.stderr || e.message || String(e)).trim();
    throw new Error(`svn propset failed on "${dir}": ${msg}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ── applyIgnore ───────────────────────────────────────────────────────────────
function applyIgnore(cwd) {
  const dir = cwd || process.cwd();
  const vcs = detectVcs(dir);

  if (vcs === 'git') {
    const gitignorePath = path.join(dir, '.gitignore');
    const existingLines = readGitignoreLines(gitignorePath);
    const existingSet = new Set(existingLines.map(l => l.trim()));

    const added = [];
    const skipped = [];
    const toAppend = [];

    for (const p of allIgnorePaths()) {
      if (existingSet.has(p)) {
        skipped.push(p);
      } else {
        added.push(p);
        toAppend.push(p);
      }
    }

    if (toAppend.length > 0) {
      // Append with a leading newline if file already has content
      const existingContent = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf8')
        : '';
      // Form B (EOL preservation): this appends to bytes the user owns. Capture the
      // EOL the existing .gitignore already uses and re-emit it — joining with LF
      // would leave a Windows-authored file with mixed endings. Tolerant of a lone
      // CR too (`/\r\n?/`), which degrades the same way (measured).
      const eol = (existingContent.match(/\r\n|\n|\r/) || ['\n'])[0];
      const separator = existingContent.length > 0 && !/(?:\r\n|\n|\r)$/.test(existingContent) ? eol : '';
      const block = toAppend.join(eol) + eol;
      fs.appendFileSync(gitignorePath, separator + block, 'utf8');
    }

    return { vcs: 'git', added, skipped };
  }

  if (vcs === 'svn') {
    const groups = groupByParentDir(allIgnorePaths());
    const added = [];
    const skipped = [];
    const notes = [];

    for (const [parentDir, basenames] of groups) {
      const absDir = path.join(dir, parentDir);

      // Ensure directory exists (it should if .gsd/ is already created)
      if (!fs.existsSync(absDir)) {
        // Cannot set svn:ignore on non-existent dir; mark all as skipped with a warning
        for (const b of basenames) skipped.push(path.posix.join(parentDir, b));
        continue;
      }

      // Wholesale-ignore guard: if the directory exists on disk but is NOT under
      // version control, an ancestor already ignores it wholesale (e.g. the
      // `.gsd` svn:ignore lists `forge`). svn propset would throw E155010 on a
      // non-versioned node and abort the entire --apply, leaving partial state.
      // The per-child rules are redundant here — skip the whole group.
      if (!svnIsVersioned(absDir)) {
        for (const b of basenames) skipped.push(path.posix.join(parentDir, b));
        notes.push(`${parentDir}: not versioned (covered by an ancestor's wholesale svn:ignore) — skipped`);
        continue;
      }

      const existing = svnPropget(absDir);
      const existingSet = new Set(existing);
      const newPatterns = [];

      for (const b of basenames) {
        const fullPath = path.posix.join(parentDir, b);
        if (existingSet.has(b)) {
          skipped.push(fullPath);
        } else {
          added.push(fullPath);
          newPatterns.push(b);
        }
      }

      if (newPatterns.length > 0) {
        const merged = [...existing, ...newPatterns];
        svnPropset(absDir, merged);
      }
    }

    return { vcs: 'svn', added, skipped, notes };
  }

  // vcs === 'none'
  return { vcs: 'none', added: [], skipped: allIgnorePaths() };
}

// ── validateIgnore ────────────────────────────────────────────────────────────
function validateIgnore(cwd) {
  const dir = cwd || process.cwd();
  const vcs = detectVcs(dir);

  if (vcs === 'git') {
    const gitignorePath = path.join(dir, '.gitignore');
    const lines = readGitignoreLines(gitignorePath);
    const existingSet = new Set(lines.map(l => l.trim()));
    const missing = allIgnorePaths().filter(p => !existingSet.has(p));
    return { vcs: 'git', missing, ok: missing.length === 0 };
  }

  if (vcs === 'svn') {
    const groups = groupByParentDir(allIgnorePaths());
    const missing = [];
    const covered = [];

    for (const [parentDir, basenames] of groups) {
      const absDir = path.join(dir, parentDir);

      // A directory present on disk but not under version control is covered by
      // an ancestor's wholesale svn:ignore — its children are effectively
      // ignored and must NOT be reported as missing (that was a false positive).
      if (fs.existsSync(absDir) && !svnIsVersioned(absDir)) {
        for (const b of basenames) covered.push(path.posix.join(parentDir, b));
        continue;
      }

      let existing = [];
      if (fs.existsSync(absDir)) {
        existing = svnPropget(absDir);
      }
      const existingSet = new Set(existing);
      for (const b of basenames) {
        if (!existingSet.has(b)) missing.push(path.posix.join(parentDir, b));
      }
    }

    return { vcs: 'svn', missing, covered, ok: missing.length === 0 };
  }

  // vcs === 'none' — no VCS, treat as ok (informational; forge-doctor handles no-VCS projects)
  return { vcs: 'none', missing: [], ok: true };
}

// ── module.exports ─────────────────────────────────────────────────────────────
module.exports = {
  LOCAL_IGNORE_PATHS,
  PROJECTION_IGNORE_PATHS,
  detectVcs,
  applyIgnore,
  validateIgnore,
  svnIsVersioned,
  __setExecFileSync,
};

// ── CLI ────────────────────────────────────────────────────────────────────────
// Guarded by require.main === module — importing this file does NOT trigger output.
// Both LOCAL_IGNORE_PATHS and PROJECTION_IGNORE_PATHS are used by --apply/--validate/--list-paths.
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

  if (args.help) {
    process.stdout.write(`forge-ignore — VCS detection and ignore-rule applier for Forge Agent

Flags:
  --detect-vcs [--cwd <dir>]   print 'git', 'svn', or 'none' for the repo at <dir>
  --list-paths                 print LOCAL_IGNORE_PATHS and PROJECTION_IGNORE_PATHS (sectioned)
  --apply [--cwd <dir>]        add missing ignore rules to .gitignore or svn:ignore
  --validate [--cwd <dir>]     check all canonical paths are ignored; exit 1 if not
  --cwd <dir>                  working directory (default: process.cwd())
  --help                       show this help

Exit codes:
  0  success (or validate: all paths present; or 'none' VCS in --validate)
  1  validate failed (missing paths printed to stdout) or SVN error
  2  bad arguments
`);
    return;
  }

  const cwdArg = typeof args.cwd === 'string' ? args.cwd : process.cwd();

  try {
    if ('detect-vcs' in args) {
      process.stdout.write(detectVcs(cwdArg) + '\n');

    } else if ('list-paths' in args) {
      process.stdout.write('LOCAL_IGNORE_PATHS:\n');
      process.stdout.write(LOCAL_IGNORE_PATHS.map(p => `  ${p}`).join('\n') + '\n');
      process.stdout.write('PROJECTION_IGNORE_PATHS:\n');
      process.stdout.write(PROJECTION_IGNORE_PATHS.map(p => `  ${p}`).join('\n') + '\n');

    } else if ('apply' in args) {
      const result = applyIgnore(cwdArg);
      if (result.added.length > 0) {
        process.stdout.write(`vcs: ${result.vcs}\nadded:\n${result.added.map(p => `  ${p}`).join('\n')}\n`);
        if (result.skipped.length > 0) {
          process.stdout.write(`skipped (already present or covered):\n${result.skipped.map(p => `  ${p}`).join('\n')}\n`);
        }
      } else {
        process.stdout.write(`vcs: ${result.vcs}\nall paths already present (no changes made)\n`);
      }
      if (result.notes && result.notes.length > 0) {
        process.stdout.write(`notes:\n${result.notes.map(n => `  ${n}`).join('\n')}\n`);
      }

    } else if ('validate' in args) {
      const result = validateIgnore(cwdArg);
      if (result.covered && result.covered.length > 0) {
        process.stdout.write(`covered by wholesale ignore:\n${result.covered.map(p => `  ${p}`).join('\n')}\n`);
      }
      if (result.ok) {
        process.stdout.write(`vcs: ${result.vcs}\nok: all canonical paths are ignored\n`);
        process.exit(0);
      } else {
        process.stdout.write(`vcs: ${result.vcs}\nmissing:\n${result.missing.map(p => `  ${p}`).join('\n')}\n`);
        process.exit(1);
      }

    } else {
      process.stderr.write('forge-ignore: no command specified. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-ignore error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();
