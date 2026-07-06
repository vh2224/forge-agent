#!/usr/bin/env node
// forge-maintenance — Deterministic bucket merge engine for Forge Agent
//
// Pure primitive: fuses an EXPLICIT list of fragment paths of one type into a
// single byte-deterministic "bucket" file. Does NOT decide which fragments are
// "finalized" (S04), does NOT implement baseline/triggers (S04), does NOT
// implement the VCS guard (S03), does NOT read '.gsd/' directly — callers pass
// explicit paths. No LLM reads or summarizes unit content here.
//
// ── Bucket v1 format (frozen — S02/S03 consume this contract) ─────────────────
//
//   <!-- forge-bucket v1 type:<type> -->        ← line 1; <type> matches [a-z-]+
//                                                  (opts.type, default "generic")
//
//   <!-- unit:<id> -->                          ← idempotent anchor (id = fragment
//                                                  basename without .md)
//   ## <id> — <title>                           ← heading; "## <id>" when the
//                                                  fragment has no title; title =
//                                                  FIRST line of frontmatter
//                                                  `title`, verbatim
//   (blank line)
//   <full fragment content, frontmatter          ← normalized via normalizeText;
//    included, ending in exactly one \n>           zero content bytes lost, zero
//                                                    re-serialization
//
//   (blank line)                                ← separator between units
//   <!-- unit:<id2> -->
//   ...
//   EOF                                         ← file ends at the single \n of
//                                                  the last unit's content
//
// Construction expression (deterministic by definition):
//
//   header + '\n' + units.map(u =>
//     '\n<!-- unit:' + u.id + ' -->\n' + heading(u) + '\n\n' + u.content
//   ).join('')
//
// Normalization D2 (`normalizeText`): strip leading BOM, normalize CRLF/CR to
// LF, collapse trailing newlines to exactly one '\n' (empty input → '\n').
// No other byte is touched (internal whitespace preserved — losslessness).
// Invariant: normalizeText(bucket) === bucket by construction.
//
// Total order (`sortKey(id, writtenAt)` → '<ts14>|<id>'):
//   1. Timestamp id (`[MT]-\d{14}` or dashed `\d{8}-\d{6}` form) → ts14 = the
//      id's own digits.
//   2. Legacy id (`M###`, `TASK-###`, other) → ts14 derived from `writtenAt`
//      (digits only, truncated/right-padded to 14) — sourced from the
//      fragment's own frontmatter `completed_at` (ledger convention) or
//      `written_at`, extracted from the unit's CONTENT via
//      forge-ledger.parseFragment.
//   3. No deterministic source → ts14 = '00000000000000' (groups first).
//   4. Tie-break: the full id as key suffix. Comparison is BYTEWISE
//      (`a < b`) — localeCompare is FORBIDDEN in any sort path here (it is
//      locale-dependent and breaks byte-identity across machines). mtime
//      NEVER enters any ordering or content decision.
//
// Idempotency / anchor dedup: mergeBucket() with an existing bucket parses it
// (parseBucket), dedupes by id (the existing bucket entry wins verbatim; a
// duplicate input fragment goes to `skipped`), re-sorts the union by sortKey
// and re-emits. Since unit content preserves the original frontmatter,
// `writtenAt` is re-derivable from the content itself on every re-merge — the
// same extraction function for both new and existing units produces the same
// key → byte-identical output. Duplicate ids WITHIN the input list throw
// (noisy error, exit 1).
//
// Hash (`bucketHash`): sha256 hex (Node `crypto`) over the UTF-8 bytes of the
// already-normalized content. This is the oracle for the D3 check in S03.
//
// Known limitation: a content line matching `^<!-- unit:.* -->$` at column 0
// would confuse parseBucket. Fragments are forge-generated and never contain
// such a line; documented here as a known limitation, not defended against.
//
// Library exports:
//   mergeBucket(fragmentPaths, opts) → { content, hash, units, skipped }
//   normalizeText(raw)               → string
//   anchorHeader(id, title)          → string
//   sortKey(id, writtenAt)           → string
//   parseBucket(content)             → { type, units: [{ id, title, content }] }
//   bucketHash(content)              → string (sha256 hex)
//
// CLI:
//   node forge-maintenance.js --merge --out <path> [--type <t>] [--dry-run] [--cwd <dir>] <frag...>
//   node forge-maintenance.js --hash <bucketPath>
//   node forge-maintenance.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (bad bucket, duplicate id, missing fragment, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { classify }      = require('./forge-ids');
const { parseFragment } = require('./forge-ledger');
const { writeAtomic }   = require('./forge-yaml-safe');

// ── normalizeText ─────────────────────────────────────────────────────────────
// Strips BOM, normalizes CRLF/CR to LF, collapses trailing newlines to exactly
// one '\n'. Empty input → '\n'. No other byte is touched.
function normalizeText(raw) {
  return String(raw)
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n*$/, '\n');
}

// ── firstLine ─────────────────────────────────────────────────────────────────
// Internal helper: first line of a string, split on '\n', trailing '\r' stripped.
function firstLine(s) {
  return String(s).split('\n')[0].replace(/\r$/, '');
}

// ── sortKey ───────────────────────────────────────────────────────────────────
// Pure function — never touches Date/mtime. Returns '<ts14>|<id>'.
function sortKey(id, writtenAt) {
  const idStr = String(id);
  let ts14 = null;

  if (classify(idStr) === 'timestamp') {
    let m = idStr.match(/^[MT]-(\d{14})/);
    if (m) {
      ts14 = m[1];
    } else {
      m = idStr.match(/^(?:M|T|TASK)-(\d{8})-(\d{6})/i);
      if (m) ts14 = m[1] + m[2];
    }
  }

  if (ts14 == null) {
    const digits = String(writtenAt == null ? '' : writtenAt).replace(/\D/g, '');
    ts14 = digits ? digits.slice(0, 14).padEnd(14, '0') : '00000000000000';
  }

  return ts14 + '|' + idStr;
}

// ── anchorHeader ──────────────────────────────────────────────────────────────
// Returns the anchor + heading pair (no trailing '\n').
function anchorHeader(id, title) {
  const heading = '## ' + id + (title ? ' — ' + firstLine(title) : '');
  return '<!-- unit:' + id + ' -->\n' + heading;
}

// ── bucketHash ────────────────────────────────────────────────────────────────
function bucketHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ── parseBucket ───────────────────────────────────────────────────────────────
// Parses bucket content into { type, units: [{ id, title, content }] }.
// Throws if line 1 doesn't match the bucket header.
function parseBucket(content) {
  const lines = String(content).split('\n');
  const headerMatch = lines[0].match(/^<!-- forge-bucket v1 type:([a-z-]+) -->$/);
  if (!headerMatch) {
    throw new Error('Invalid bucket: line 1 does not match "<!-- forge-bucket v1 type:<type> -->"');
  }
  const type = headerMatch[1];
  const anchorRe = /^<!-- unit:(.+) -->$/;
  const units = [];

  let i = 1;
  while (i < lines.length) {
    if (lines[i] === '') { i++; continue; }
    const am = lines[i].match(anchorRe);
    if (!am) { i++; continue; } // stray line — skip

    const id = am[1];
    const heading = lines[i + 1] || '';
    let j = i + 2;
    if (lines[j] === '') j++; // skip the 1 blank line after the heading

    const contentLines = [];
    let k = j;
    while (k < lines.length) {
      if (lines[k] === '' && (k + 1 >= lines.length || anchorRe.test(lines[k + 1]))) {
        break; // blank line immediately preceding next anchor, or trailing blank at EOF
      }
      contentLines.push(lines[k]);
      k++;
    }

    const sep = ' — ';
    const sepIdx = heading.indexOf(sep);
    const title = sepIdx !== -1 ? heading.slice(sepIdx + sep.length) : null;

    units.push({ id, title, content: contentLines.join('\n') + '\n' });
    i = k + 1; // skip the blank separator line
  }

  return { type, units };
}

// ── unitMeta ──────────────────────────────────────────────────────────────────
// Internal. Derives { title, writtenAt } from unit content via
// forge-ledger.parseFragment (metadata extraction only — body content NEVER
// comes from the parser). Used identically for new fragments and units
// re-parsed from an existing bucket, which is what makes re-merge idempotent:
// the sort key is always re-derivable from the content alone.
function unitMeta(content) {
  const frag = parseFragment(content);
  return {
    title: frag.title || null,
    writtenAt: frag.completed_at || frag.written_at || null,
  };
}

// ── mergeBucket ───────────────────────────────────────────────────────────────
// fragmentPaths: array of absolute/relative paths to fragment .md files.
// opts = { type = 'generic', existing = null (string content of current bucket) }
function mergeBucket(fragmentPaths, opts) {
  opts = opts || {};
  const type = opts.type || 'generic';
  const map = new Map(); // id → { id, content }
  const skipped = [];

  if (opts.existing) {
    const parsed = parseBucket(opts.existing);
    for (const u of parsed.units) {
      map.set(u.id, { id: u.id, content: u.content });
    }
  }

  const seenInput = new Set();
  for (const p of fragmentPaths || []) {
    const id = path.basename(p, '.md');
    if (seenInput.has(id)) {
      throw new Error(`Duplicate id in input fragment list: ${id}`);
    }
    seenInput.add(id);

    const raw = fs.readFileSync(p, 'utf8'); // throws if missing — intentional
    const content = normalizeText(raw);

    if (map.has(id)) {
      skipped.push(id);
      continue; // existing bucket entry wins verbatim
    }
    map.set(id, { id, content });
  }

  const unitsArr = Array.from(map.values()).map(u => {
    const meta = unitMeta(u.content);
    return { id: u.id, content: u.content, title: meta.title, writtenAt: meta.writtenAt };
  });

  unitsArr.sort((a, b) => {
    const ka = sortKey(a.id, a.writtenAt);
    const kb = sortKey(b.id, b.writtenAt);
    return ka < kb ? -1 : ka > kb ? 1 : 0; // bytewise — localeCompare forbidden
  });

  const header = '<!-- forge-bucket v1 type:' + type + ' -->';
  const body = unitsArr
    .map(u => '\n' + anchorHeader(u.id, u.title) + '\n\n' + u.content)
    .join('');
  const content = header + '\n' + body;

  if (normalizeText(content) !== content) {
    throw new Error('Determinism invariant violated: normalizeText(content) !== content');
  }

  const hash = bucketHash(content);
  return { content, hash, units: unitsArr.map(u => u.id), skipped };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge') out.merge = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--hash') { out.hashCmd = true; out.hashPath = argv[++i]; }
    else if (a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log([
    'forge-maintenance — deterministic bucket merge engine',
    '',
    'Usage:',
    '  node forge-maintenance.js --merge --out <path> [--type <t>] [--dry-run] [--cwd <dir>] <fragment...>',
    '  node forge-maintenance.js --hash <bucketPath>',
    '  node forge-maintenance.js --help',
  ].join('\n'));
}

function cliMain(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.hashCmd) {
    if (!args.hashPath) {
      process.stderr.write('Error: --hash requires a bucket path\n');
      return 2;
    }
    try {
      const content = fs.readFileSync(args.hashPath, 'utf8');
      console.log(JSON.stringify({ path: args.hashPath, hash: bucketHash(content) }));
      return 0;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      return 1;
    }
  }

  if (args.merge) {
    if (!args.out) {
      process.stderr.write('Error: --merge requires --out\n');
      return 2;
    }
    if (args._.length === 0) {
      process.stderr.write('Error: --merge requires at least one fragment path\n');
      return 2;
    }

    const cwd = args.cwd || process.cwd();
    const type = args.type || 'generic';
    let existing = null;
    if (fs.existsSync(args.out)) {
      existing = fs.readFileSync(args.out, 'utf8');
    }

    try {
      const result = mergeBucket(args._, { type, existing });

      if (args.dryRun) {
        console.log(JSON.stringify({
          dryRun: true,
          out: args.out,
          type,
          unitCount: result.units.length,
          units: result.units,
          skipped: result.skipped,
          hash: result.hash,
          bytes: Buffer.byteLength(result.content, 'utf8'),
        }));
        return 0;
      }

      if (existing != null && existing === result.content) {
        console.log(JSON.stringify({
          created: false,
          out: args.out,
          hash: result.hash,
          unitCount: result.units.length,
          skipped: result.skipped,
        }));
        return 0;
      }

      writeAtomic(args.out, result.content, { cwd });
      console.log(JSON.stringify({
        created: true,
        out: args.out,
        hash: result.hash,
        unitCount: result.units.length,
        skipped: result.skipped,
      }));
      return 0;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      return 1;
    }
  }

  process.stderr.write('Error: no command given. Use --merge, --hash, or --help\n');
  return 2;
}

module.exports = { mergeBucket, normalizeText, anchorHeader, sortKey, parseBucket, bucketHash };

if (require.main === module) {
  process.exit(cliMain(process.argv.slice(2)));
}
