#!/usr/bin/env node
'use strict';

/**
 * forge-exec-callsites.js — an in-process scanner that turns the absence of
 * `codex exec` call sites into a verifiable fact, following the D10 decision
 * and the canonical mold of `scripts/forge-doc-claims.js`.
 *
 * WHY IN-PROCESS, NEVER SHELL-OUT (lesson from milestone S06): this
 * environment's `grep` is a shell function wrapping `ugrep --ignore-files`,
 * which honors `.gitignore` — a `grep` that returns empty can mean "genuinely
 * absent" or "the file is gitignored and was never read". Proof of absence
 * has to be made by reading files with `fs` directly, so `.gitignore`
 * semantics (a property of the `grep`/`git` tools, not of the filesystem)
 * cannot hide anything from it.
 *
 * SCOPE — WHAT THIS SCANNER LOOKS AT, and therefore what `clean` means.
 * `clean` is an assertion about work actually done, so the set of files read
 * has to be wide enough to carry the sentence a caller reads off the top-line
 * verdict. It reads, under `DEFAULT_ROOTS` (which includes `bin/`) plus the
 * repository's own top-level files:
 *   - every `.js` and `.md`;
 *   - every shell/PowerShell/batch script by extension (`.sh`, `.bash`,
 *     `.ps1`, `.cmd`, `.bat`);
 *   - every EXTENSION-LESS file whose first bytes are a `#!` shebang — this is
 *     how `bin/forge-run`, `bin/forge-accounts` and friends are spelled, and
 *     a shell script is exactly where a retired `codex exec` invocation would
 *     hide from a `.js`-only scan.
 * Measured before the widening (S05 review R4): a `.sh` containing a literal
 * `codex exec` produced `outcome: 'clean'`, exit 0 — the skip WAS named in the
 * census as `extension-not-scanned`, but the verdict a caller acts on still
 * said clean, and a census nobody reads cannot carry a false top line. The
 * choice was between widening the scan and narrowing the advertised guarantee;
 * widening was taken, because the guarantee this scanner exists to give is
 * "the retired transport is not invoked ANYWHERE", and a guarantee narrowed to
 * `.js`/`.md` would be true but useless for a transport whose whole point was
 * shelling out.
 * Non-script data files (`.json`, `.yml`, images, …) remain out of scope and
 * are still named in `skipped[]` as `extension-not-scanned`; a schema pin is
 * not an invocation.
 *
 * PREDICATE — what counts as an "executable call site" of `codex exec`
 * (the thing this scanner exists to prove absent), at minimum:
 *   1. `exec-arg-array` — the literal `'exec'` / `"exec"` on a non-comment
 *      line of a file that HAS CODEX CONTEXT (see below). Deliberately
 *      FILE-SCOPED, not line-windowed.
 *   2. `codex-exec-string` — the string `codex exec` appearing on a non-
 *      comment code line (i.e. as part of an assembled command), not merely
 *      in a comment or markdown prose sentence.
 *   3. `removed-symbol` — a reference to one of the symbols that exist ONLY
 *      to build a `codex exec` invocation: `invokeCodex(`, `invokeCodexDetached(`,
 *      `codexSandboxArgs(`. These are removed in T02 of this slice; any
 *      remaining reference (outside a comment) is itself proof the
 *      transport migration is incomplete.
 *
 * CODEX CONTEXT — the file-scoped condition gating form 1. A file has it when,
 * on its NON-COMMENT lines, either
 *   (i)  a codex command resolution appears (`resolveCodexCommand`,
 *        `FORGE_XLLM_CODEX_BIN`), or
 *   (ii) the word `codex` appears AND a `spawn`/`spawnSync` call appears.
 *
 * WHY FILE-SCOPED AND NOT A ±N LINE WINDOW (S05 review R7). The previous
 * predicate consulted a ±4 raw-line window and both of its failure modes were
 * reproduced: a FALSE POSITIVE (`const mode = 'exec'` two lines from
 * `spawn('ls', [])`, with a COMMENT mentioning codex satisfying the codex-word
 * test) and, worse, a FALSE NEGATIVE (a genuine call site whose `'exec'` sat
 * seven lines from `resolveCodexCommand()` — reported clean). Widening the
 * window only trades the second failure for more of the first, and an AST
 * would break the zero-dependency mold this file lives in. Making the
 * condition file-scoped removes DISTANCE from the predicate entirely, so the
 * false negative cannot be recreated by moving code apart; requiring the codex
 * evidence to be on non-comment lines removes the false positive at the same
 * time, since a comment can no longer vouch for executable context. The
 * residual cost is named, not hidden: inside a file that genuinely does
 * resolve a codex command, EVERY `'exec'` literal is accused, however
 * unrelated. That is fail-closed in the same direction as the string-literal
 * posture below — a human looks at a printed `file:line`, instead of a false
 * `clean`.
 *
 * A separate `prose` class covers markdown files and COMMENT LINES that
 * mention `codex exec` (documentation, this very file's own docstring) —
 * legitimate, counted, but never confused with the executable class above.
 *
 * DELIBERATELY FAIL-CLOSED — a string literal is NOT prose. A line like
 * `const help = "use codex exec for details";` is classified as a call site
 * (`codex-exec-string`), even though it only mentions the retired spelling in
 * a message. This is the measured behaviour and the intended one: the scanner
 * decides on RAW LINES, and telling "a command being assembled" apart from "a
 * sentence that happens to live in quotes" would require tokenizing strings
 * and block comments, or an AST — out of proportion to this zero-dependency
 * mold. The tradeoff is named rather than hidden: a false positive costs a
 * human one look at a `file:line` the tool printed out loud, whereas the
 * alternative posture (treating quoted text as prose) risks a false `clean`,
 * which is the one failure this scanner exists to make impossible. Block
 * comments (`/* … *\/`) are covered only via `isCommentLine`, i.e. per line,
 * by the leading `*`/`//` convention this codebase uses throughout.
 * Pinned by test: "a string literal mentioning …" in the paired suite — the
 * docstring and the classifier must not drift apart again (S05 review R6).
 *
 * CENSUS, NOT VERDICT-ONLY: the scan always reports `scanned` (files
 * actually read) alongside the verdict. `outcome: 'clean'` REQUIRES
 * `scanned > 0` — a scanner reporting "clean" without having read anything is
 * byte-for-byte indistinguishable from a broken detector, which is the
 * defect of origin this entire milestone exists to correct. `scanned === 0`
 * is always `outcome: 'scan-failed'`, never a clean pass.
 *
 * Every file the walk encounters but does not scan (wrong extension,
 * unreadable, or this scanner's own fixture files) is recorded in
 * `skipped[{path, reason}]` with a reason drawn from a CLOSED enum — never
 * silently dropped.
 */

const fs = require('fs');
const path = require('path');

// ── Closed enum of skip reasons — never invent a new string inline ─────────

const SKIP_REASONS = Object.freeze({
  EXTENSION_NOT_SCANNED: 'extension-not-scanned',
  UNREADABLE: 'unreadable',
  SELF_FIXTURE: 'self-fixture',
  ROOT_NOT_FOUND: 'root-not-found',
  // An extension-less file with no `#!` shebang — data, not a script.
  NOT_A_SCRIPT: 'not-a-script',
  // A subdirectory the SHALLOW top-level pass deliberately did not descend
  // into (the recursive roots cover the scanned subtrees). Recorded rather
  // than dropped: a walk that narrows its own scope in silence is the defect.
  OUT_OF_SCOPE_DIR: 'out-of-scope-directory',
});

// ── Closed enum of call-site forms ──────────────────────────────────────────

const CALL_SITE_FORMS = Object.freeze({
  EXEC_ARG: 'exec-arg-array',
  EXEC_STRING: 'codex-exec-string',
  REMOVED_SYMBOL: 'removed-symbol',
});

const DEFAULT_ROOTS = Object.freeze(['scripts', 'shared', 'skills', 'agents', 'commands', 'docs', 'bin']);
const SCANNED_EXTENSIONS = Object.freeze(['.js', '.md', '.sh', '.bash', '.ps1', '.cmd', '.bat']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'build', '.gsd']);

// This scanner and its paired suite deliberately CONTAIN the patterns they
// hunt for (as literal regex source and as fixture strings) — self-matching
// them would be permanent, unfixable noise, never a real violation. Excluded
// on basename, resolved against the file being walked (works regardless of
// which --root/--cwd combination reaches them).
const SELF_FIXTURE_BASENAMES = new Set(['forge-exec-callsites.js', 'forge-exec-callsites.test.js']);

const REMOVED_SYMBOLS_RE = /\b(invokeCodex|invokeCodexDetached|codexSandboxArgs)\(/;
const EXEC_STRING_RE = /codex\s+exec\b/i;
const EXEC_LITERAL_RE = /['"]exec['"]/;
// Form 1 is gated by FILE-SCOPED codex context — see the CODEX CONTEXT block
// in the docstring for why distance was removed from the predicate entirely.
const CODEX_RESOLUTION_RE = /resolveCodexCommand|FORGE_XLLM_CODEX_BIN/;
const SPAWN_CALL_RE = /\bspawn(Sync)?\s*\(/;
const CODEX_WORD_RE = /codex/i;

// Shell (`#`), batch (`::`, `REM`) and JS (`//`, `/*`, ` *`) comment openers.
// The shell/batch forms matter now that scripts without a `.js` extension are
// in scope: a `#`-prefixed line is prose there exactly as `//` is here.
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('#')
    || trimmed.startsWith('::')
    || /^rem\s/i.test(trimmed);
}

// A file HAS CODEX CONTEXT when its non-comment lines resolve a codex command,
// or mention codex alongside a spawn call. Pure over the already-split lines.
function hasCodexContext(lines) {
  let sawCodexWord = false;
  let sawSpawn = false;
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    if (CODEX_RESOLUTION_RE.test(line)) return true;
    if (CODEX_WORD_RE.test(line)) sawCodexWord = true;
    if (SPAWN_CALL_RE.test(line)) sawSpawn = true;
  }
  return sawCodexWord && sawSpawn;
}

// An extension-less file is scanned only when it opens with a `#!` shebang —
// that is how every executable in `bin/` is spelled. Read failures are NOT
// treated as "not a script": they surface as `unreadable`, so an unopenable
// file can never be quietly excused out of scope.
function shebangCheck(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    const read = fs.readSync(fd, buf, 0, 2, 0);
    return { scan: read === 2 && buf.toString('latin1') === '#!', reason: SKIP_REASONS.NOT_A_SCRIPT };
  } catch {
    return { scan: false, reason: SKIP_REASONS.UNREADABLE };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// ── collectFiles — impure, in-process walk under a single root, no shell ───

// `opts.shallow` — read only the files directly inside `rootDir`, recording
// every subdirectory in `skipped[]` as `out-of-scope-directory`. Used for the
// repository's own top level, whose interesting subtrees are already covered
// by their own recursive roots and whose remainder (app/, tests/, …) is
// deliberately not this scanner's scope. The skips are recorded, never
// dropped, so the narrowing is legible in the census.
function collectFiles(rootDir, opts) {
  const shallow = !!(opts && opts.shallow);
  const files = [];
  const skipped = [];
  // An in-scope directory the walk could not read is an UNSCANNED SUBTREE, and
  // an unscanned subtree can hold the very call site this scanner exists to
  // prove absent. Returning silently made `{outcome:'clean', skipped:[]}` and
  // exit 0 byte-for-byte indistinguishable from a genuinely clean scan — the
  // exact defect the census invariant at the top of this file forbids (S05
  // review R5). So: record the skip AND count it, so the caller can refuse to
  // say "clean".
  let unreadableDirs = 0;

  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    skipped.push({ path: rootDir, reason: SKIP_REASONS.ROOT_NOT_FOUND });
    return { files, skipped, unreadableDirs };
  }
  if (!rootStat.isDirectory()) {
    skipped.push({ path: rootDir, reason: SKIP_REASONS.ROOT_NOT_FOUND });
    return { files, skipped, unreadableDirs };
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs++;
      skipped.push({ path: dir, reason: SKIP_REASONS.UNREADABLE });
      return; // don't abort the whole walk — but the caller must not read clean
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (shallow) {
          skipped.push({ path: full, reason: SKIP_REASONS.OUT_OF_SCOPE_DIR });
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks/sockets/etc — silently out of scope

      if (SELF_FIXTURE_BASENAMES.has(entry.name)) {
        skipped.push({ path: full, reason: SKIP_REASONS.SELF_FIXTURE });
        continue;
      }

      const ext = path.extname(entry.name);
      if (!SCANNED_EXTENSIONS.includes(ext)) {
        if (ext !== '') {
          skipped.push({ path: full, reason: SKIP_REASONS.EXTENSION_NOT_SCANNED });
          continue;
        }
        const shebang = shebangCheck(full);
        if (!shebang.scan) {
          skipped.push({ path: full, reason: shebang.reason });
          continue;
        }
      }

      files.push(full);
    }
  }

  walk(rootDir);
  return { files, skipped, unreadableDirs };
}

// ── classifyFile — pure, testable with in-memory fixtures ──────────────────
//
// `record` is `{ path, content }` (in-memory, for fixtures) or a plain path
// string (read from disk). `isMarkdown` short-circuits every match on a
// `.md` file to the prose class — a documentation file cannot contain an
// "executable" call site by definition.
//
// Returns `{ scanned: 0|1, callSites: [...], proseMentions: [...] }` — a
// single-file unit the caller (`scanExecCallSites`) aggregates. `scanned`
// stays 0 (not counted) when the file could not be read.

function classifyFile(record) {
  const filePath = typeof record === 'string' ? record : record.path;
  let content;
  if (typeof record === 'object' && typeof record.content === 'string') {
    content = record.content;
  } else {
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { scanned: 0, unreadable: true, callSites: [], proseMentions: [] };
    }
  }

  const isMarkdown = path.extname(filePath) === '.md';
  const lines = content.split('\n');
  const callSites = [];
  const proseMentions = [];
  const codexContext = !isMarkdown && hasCodexContext(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comment = isCommentLine(line);

    // Form 3: removed-symbol references.
    if (REMOVED_SYMBOLS_RE.test(line)) {
      const target = isMarkdown || comment ? proseMentions : callSites;
      const entry = { file: filePath, line: i + 1, text: line.trim() };
      if (target === callSites) entry.form = CALL_SITE_FORMS.REMOVED_SYMBOL;
      target.push(entry);
    }

    // Form 2: the literal string "codex exec" outside comments/markdown.
    if (EXEC_STRING_RE.test(line)) {
      const target = isMarkdown || comment ? proseMentions : callSites;
      const entry = { file: filePath, line: i + 1, text: line.trim() };
      if (target === callSites) entry.form = CALL_SITE_FORMS.EXEC_STRING;
      target.push(entry);
    }

    // Form 1: a bare 'exec'/"exec" literal in a file that HAS CODEX CONTEXT
    // (file-scoped, distance-free — see the docstring's CODEX CONTEXT block).
    // In a file with no codex context an `'exec'` literal is noise, not a
    // claim about this transport, and is a hit of neither class.
    if (!isMarkdown && !comment && codexContext && EXEC_LITERAL_RE.test(line)) {
      callSites.push({ file: filePath, line: i + 1, form: CALL_SITE_FORMS.EXEC_ARG, text: line.trim() });
    }
  }

  return { scanned: 1, unreadable: false, callSites, proseMentions };
}

// ── scanExecCallSites — the public entry point ──────────────────────────────
//
// `roots` — array of directory paths (already resolved against --cwd by the
// caller) or an array of `{ path, content }` file records for in-memory
// fixtures in tests (bypassing disk walk entirely — pass `{ inMemory: true }`
// in opts to signal `roots` is really a file-record array, not directories).
//
// Returns:
//   { outcome: 'clean' | 'found' | 'scan-failed',
//     scanned, files_with_hits,
//     call_sites: [{file, line, form, text}],
//     prose_mentions: [{file, line, text}],
//     skipped: [{path, reason}] }

function scanExecCallSites(roots, opts) {
  opts = opts || {};
  const skipped = [];
  let fileRecords = [];
  let unreadableDirs = 0;

  if (opts.inMemory) {
    fileRecords = Array.isArray(roots) ? roots : [];
  } else {
    const rootList = Array.isArray(roots) && roots.length > 0 ? roots : DEFAULT_ROOTS;
    for (const rootEntry of rootList) {
      // A root is a plain path, or `{ path, shallow }` for the top-level pass.
      const root = typeof rootEntry === 'string' ? rootEntry : rootEntry.path;
      const rootOpts = typeof rootEntry === 'string' ? undefined : { shallow: !!rootEntry.shallow };
      const { files, skipped: rootSkipped, unreadableDirs: rootUnreadable } = collectFiles(root, rootOpts);
      fileRecords = fileRecords.concat(files);
      skipped.push(...rootSkipped);
      unreadableDirs += rootUnreadable || 0;
    }
  }

  let scanned = 0;
  const callSites = [];
  const proseMentions = [];
  const filesWithHits = new Set();

  for (const record of fileRecords) {
    const result = classifyFile(record);
    if (result.unreadable) {
      const p = typeof record === 'string' ? record : record.path;
      skipped.push({ path: p, reason: SKIP_REASONS.UNREADABLE });
      continue;
    }
    scanned += result.scanned;
    if (result.callSites.length > 0) {
      filesWithHits.add(typeof record === 'string' ? record : record.path);
      callSites.push(...result.callSites);
    }
    proseMentions.push(...result.proseMentions.map((m) => ({ file: m.file, line: m.line, text: m.text })));
  }

  let outcome;
  if (scanned === 0) {
    outcome = 'scan-failed';
  } else if (callSites.length > 0) {
    outcome = 'found';
  } else if (unreadableDirs > 0) {
    // Read files, found nothing — but part of the scope was never opened, so
    // absence is NOT established. `scan-failed` (exit 2), never `clean`.
    outcome = 'scan-failed';
  } else {
    outcome = 'clean';
  }

  return {
    outcome,
    scanned,
    unreadable_dirs: unreadableDirs,
    files_with_hits: filesWithHits.size,
    call_sites: callSites,
    prose_mentions: proseMentions,
    skipped,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { check: false, json: false, roots: [], cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--root') out.roots.push(argv[++i]);
    else if (a === '--cwd') out.cwd = argv[++i];
    else {
      process.stderr.write(`forge-exec-callsites: unknown argument '${a}'\n`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.check) {
    process.stderr.write('forge-exec-callsites: usage: forge-exec-callsites.js --check [--json] [--root <dir> ...] [--cwd <dir>]\n');
    process.exit(2);
  }

  // With no explicit --root, the default scope is the recursive roots PLUS a
  // shallow pass over the repository's own top level, where install.sh /
  // install.ps1 / README.md live — files that a roots-only scan never opened.
  const roots = args.roots.length > 0
    ? args.roots.map((r) => path.resolve(args.cwd, r))
    : DEFAULT_ROOTS.map((r) => path.resolve(args.cwd, r))
      .concat([{ path: path.resolve(args.cwd), shallow: true }]);

  const result = scanExecCallSites(roots);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned: ${result.scanned}, outcome: ${result.outcome}`);
    if (result.call_sites.length > 0) {
      for (const c of result.call_sites) {
        console.log(`  CALL SITE [${c.form}] ${c.file}:${c.line} ${c.text}`);
      }
    }
    if (result.prose_mentions.length > 0) {
      console.log(`  ${result.prose_mentions.length} prose mention(s) (not executable call sites)`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ${result.skipped.length} file(s)/root(s) skipped (see --json for reasons)`);
    }
  }

  process.exitCode = result.outcome === 'clean' ? 0 : 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  SKIP_REASONS,
  CALL_SITE_FORMS,
  DEFAULT_ROOTS,
  SCANNED_EXTENSIONS,
  collectFiles,
  hasCodexContext,
  classifyFile,
  scanExecCallSites,
};
