#!/usr/bin/env node
// forge-ids — Central ID module for Forge Agent
//
// Generation format is controlled by the `ids.format` pref (timestamp | sequential,
// default timestamp). Reading always accepts BOTH formats regardless of the pref.
//
// Library exports (pure — no I/O):
//   nowTimestamp()        → string  // 'YYYYMMDDHHMMSS', 14 digits, UTC
//   slugify(desc)         → string  // kebab-case ASCII-folded, stopwords removed; '' if empty
//   makeMilestoneId(desc) → string  // 'M-<ts>-<slug>' or 'M-<ts>' if slug empty
//   makeTaskId(desc)      → string  // 'T-<ts>-<slug>' or 'T-<ts>' if slug empty
//   nextSequentialMilestoneId(existingIds) → string  // 'M00N' (max legacy M### + 1)
//   nextSequentialTaskId(existingIds)      → string  // 'TASK-00N' (max legacy TASK-### + 1)
//   classify(id)          → 'legacy' | 'timestamp'
//   isValid(id)           → boolean
//   prefixGlob(id)        → string  // 'M-20260522143012*' or exact id for legacy
//   entityKind(id)        → 'milestone' | 'task' | 'unknown'
//
// Library exports (I/O — prefs cascade + .gsd scan; used by CLI and forge-cli-helpers):
//   readIdFormat(cwd)               → 'timestamp' | 'sequential'
//   resolveMilestoneId(cwd, desc, formatOverride?) → string
//   resolveTaskId(cwd, desc, formatOverride?)      → string
//
// CLI:
//   node forge-ids.js --new-milestone "<desc>" [--format timestamp|sequential] [--cwd <path>]
//   node forge-ids.js --new-task "<desc>"      [--format timestamp|sequential] [--cwd <path>]
//   node forge-ids.js --classify <id>
//   node forge-ids.js --slugify "<desc>"
//   node forge-ids.js --help

'use strict';

// ── Stopwords — bilingual (pt-BR + en), checked-in constant, never derived at runtime ──
const STOPWORDS = Object.freeze(new Set([
  // Portuguese
  'de', 'da', 'do', 'das', 'dos', 'o', 'a', 'os', 'as',
  'com', 'para', 'por', 'e', 'em', 'no', 'na', 'um', 'uma',
  // English
  'the', 'an', 'of', 'to', 'for', 'and', 'in', 'on', 'at',
]));

// ── nowTimestamp ─────────────────────────────────────────────────────────────
// Returns 14-digit UTC timestamp: YYYYMMDDHHMMSS
// Always derived from toISOString() — never local time getters.
function nowTimestamp() {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

// ── slugify ──────────────────────────────────────────────────────────────────
// Pure function: same input always returns same output. No Date, no random, no I/O.
// Steps: lowercase → NFD accent-fold → strip non-alphanumeric → tokenize →
//        remove stopwords → join with '-' up to ~24 chars (word boundary) →
//        hard-slice fallback if single token exceeds 24 → '' if nothing left.
const SLUG_CAP = 24;

function slugify(desc) {
  // Lowercase and ASCII-fold diacritics via NFD decomposition
  const normalized = String(desc)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  // Replace non-alphanumeric with spaces, collapse, trim
  const cleaned = normalized.replace(/[^a-z0-9]+/g, ' ').trim();

  if (!cleaned) return '';

  // Tokenize and remove stopwords
  const tokens = cleaned.split(' ').filter(t => t && !STOPWORDS.has(t));

  if (tokens.length === 0) return '';

  // Join tokens up to SLUG_CAP characters at word boundary
  let result = '';
  for (const token of tokens) {
    const candidate = result ? `${result}-${token}` : token;
    if (candidate.length > SLUG_CAP) {
      // Would exceed cap — stop if we already have something
      if (result) break;
      // Single first token longer than cap: hard-slice fallback
      result = token.slice(0, SLUG_CAP).replace(/-+$/, '');
      break;
    }
    result = candidate;
  }

  // Final safety: hard-slice if somehow still over cap (edge case)
  if (result.length > SLUG_CAP) {
    result = result.slice(0, SLUG_CAP).replace(/-+$/, '');
  }

  return result;
}

// ── makeMilestoneId ──────────────────────────────────────────────────────────
function makeMilestoneId(desc) {
  const slug = slugify(desc);
  const ts = nowTimestamp();
  return slug ? `M-${ts}-${slug}` : `M-${ts}`;
}

// ── makeTaskId ───────────────────────────────────────────────────────────────
function makeTaskId(desc) {
  const slug = slugify(desc);
  const ts = nowTimestamp();
  return slug ? `T-${ts}-${slug}` : `T-${ts}`;
}

// ── nextSequentialMilestoneId ────────────────────────────────────────────────
// Pure: takes the list of existing IDs (directory names), returns the next
// legacy-style sequential ID — 'M001' if none exist, else max(M###) + 1.
// Timestamp-format IDs in the list are ignored (different namespace, no collision).
function nextSequentialMilestoneId(existingIds) {
  let max = 0;
  for (const id of existingIds || []) {
    const m = String(id).match(/^M(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'M' + String(max + 1).padStart(3, '0');
}

// ── nextSequentialTaskId ─────────────────────────────────────────────────────
// Pure: same contract as nextSequentialMilestoneId, for legacy 'TASK-###' IDs.
function nextSequentialTaskId(existingIds) {
  let max = 0;
  for (const id of existingIds || []) {
    const m = String(id).match(/^TASK-(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'TASK-' + String(max + 1).padStart(3, '0');
}

// ── classify ─────────────────────────────────────────────────────────────────
// Returns 'timestamp' for new-style IDs, 'legacy' otherwise.
// Conservative default: unknown patterns classified as 'legacy' so S02 can
// handle errors via isValid() rather than crashing on unexpected input.
function classify(id) {
  if (!id) return 'legacy';
  const s = String(id);
  if (/^[MT]-\d{14}(-|$)/.test(s)) return 'timestamp';
  // Dashed timestamp form: M-YYYYMMDD-HHMMSS / T-… / TASK-… (date and time
  // separated by a hyphen). Observed in the wild alongside the compact 14-digit
  // form — both encode a creation timestamp, so both classify as 'timestamp'.
  if (/^(?:M|T|TASK)-\d{8}-\d{6}(-|$)/i.test(s)) return 'timestamp';
  // Legacy patterns: M005, M123, TASK-001, task-fix-foo, etc.
  if (/^M\d+$/i.test(s)) return 'legacy';
  if (/^TASK-\d+$/i.test(s)) return 'legacy';
  if (/^task-/i.test(s)) return 'legacy';
  // Default conservative: treat anything else as legacy
  return 'legacy';
}

// ── isValid ──────────────────────────────────────────────────────────────────
function isValid(id) {
  if (!id) return false;
  const s = String(id);
  // New timestamp format — compact 14-digit (canonical generated form)
  if (/^[MT]-\d{14}(-[a-z0-9-]*)?$/.test(s)) return true;
  // Timestamp format — dashed date-time (M-YYYYMMDD-HHMMSS, T-…, TASK-…),
  // optionally followed by a slug. Read-compatible alternate of the compact form.
  if (/^(?:M|T|TASK)-\d{8}-\d{6}(-[a-z0-9-]*)?$/i.test(s)) return true;
  // Legacy formats
  if (/^M\d+$/i.test(s)) return true;
  if (/^TASK-\d+$/i.test(s)) return true;
  if (/^task-[a-z0-9-]+$/.test(s)) return true;
  return false;
}

// ── prefixGlob ───────────────────────────────────────────────────────────────
// For timestamp IDs: returns 'M-20260522143012*' (prefix + wildcard).
// For legacy IDs: returns the ID itself (exact match, no wildcard).
function prefixGlob(id) {
  if (!id) return String(id);
  const s = String(id);
  const m = s.match(/^([MT]-\d{14})/);
  if (m) return `${m[1]}*`;
  // Dashed timestamp form: glob on the M-YYYYMMDD-HHMMSS prefix.
  const dm = s.match(/^((?:M|T|TASK)-\d{8}-\d{6})/i);
  if (dm) return `${dm[1]}*`;
  return s; // legacy: exact match
}

// ── entityKind ───────────────────────────────────────────────────────────────
// Prefix-based detection: M prefix → milestone, T/TASK/task prefix → task.
function entityKind(id) {
  if (!id) return 'unknown';
  const s = String(id);
  if (/^M-/.test(s) || /^M\d+$/i.test(s)) return 'milestone';
  if (/^T-/.test(s) || /^TASK-/i.test(s) || /^task-/i.test(s)) return 'task';
  return 'unknown';
}

// ── I/O helpers — prefs cascade + .gsd scan ─────────────────────────────────
// These are the ONLY functions in this module that touch the filesystem.
// Kept separate from the pure core above so library consumers can stay pure.

// readIdFormat — resolves the `ids.format` pref through the standard cascade
// (user-global → repo shared → local personal; last file wins).
// Invalid/absent values silently fall back to 'timestamp'.
// NOTE: block regex matches indented lines only — do NOT use \Z (JS treats it
// as a literal 'Z'; see the readIsolationPrefs regression).
function readIdFormat(cwd) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];
  let value = 'timestamp';
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const block = raw.match(/^ids:[ \t]*\n((?:[ \t]+\S.*(?:\n|$))*)/m);
      if (block) {
        const kv = block[1].match(/^[ \t]+format:[ \t]*([a-z]+)/m);
        if (kv) value = kv[1];
      }
    } catch { /* file missing — keep current value */ }
  }
  return value === 'sequential' ? 'sequential' : 'timestamp';
}

// listExistingIds — collects candidate ID directory names for sequential numbering.
// Milestones: .gsd/milestones/ + .gsd/archive/ (archived ones still occupy their number).
// Tasks: .gsd/tasks/.
function listExistingIds(cwd, kind) {
  const fs = require('fs');
  const path = require('path');
  const dirs = kind === 'milestone'
    ? [path.join(cwd, '.gsd', 'milestones'), path.join(cwd, '.gsd', 'archive')]
    : [path.join(cwd, '.gsd', 'tasks')];
  const out = [];
  for (const d of dirs) {
    try { out.push(...fs.readdirSync(d)); } catch { /* dir absent — skip */ }
  }
  return out;
}

// resolveMilestoneId / resolveTaskId — single entry point honoring the pref.
// formatOverride (from --format flag) wins over the pref when provided.
function resolveMilestoneId(cwd, desc, formatOverride) {
  const format = formatOverride || readIdFormat(cwd);
  if (format === 'sequential') {
    return nextSequentialMilestoneId(listExistingIds(cwd, 'milestone'));
  }
  return makeMilestoneId(desc);
}

function resolveTaskId(cwd, desc, formatOverride) {
  const format = formatOverride || readIdFormat(cwd);
  if (format === 'sequential') {
    return nextSequentialTaskId(listExistingIds(cwd, 'task'));
  }
  return makeTaskId(desc);
}

// ── module.exports ───────────────────────────────────────────────────────────
module.exports = {
  nowTimestamp,
  slugify,
  makeMilestoneId,
  makeTaskId,
  nextSequentialMilestoneId,
  nextSequentialTaskId,
  classify,
  isValid,
  prefixGlob,
  entityKind,
  readIdFormat,
  resolveMilestoneId,
  resolveTaskId,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded by require.main === module — importing this file does NOT trigger output.
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
    process.stdout.write(`forge-ids — ID generator for Forge Agent

Flags:
  --new-milestone "<desc>"   generate a new milestone ID (M-<ts>-<slug> or M00N)
  --new-task "<desc>"        generate a new task ID (T-<ts>-<slug> or TASK-00N)
  --format <fmt>             timestamp | sequential — overrides the ids.format pref
  --cwd <path>               project root for pref/scan resolution (default: cwd)
  --classify <id>            print 'legacy' or 'timestamp'
  --slugify "<desc>"         print the slug for a description
  --help                     show this help

Generation format resolves: --format flag > ids.format pref (user → repo → local,
last wins) > 'timestamp' default. Reading accepts both formats always.
`);
    return;
  }

  const cwd = (typeof args.cwd === 'string' && args.cwd) ? args.cwd : process.cwd();
  let formatOverride;
  if ('format' in args) {
    if (args.format !== 'timestamp' && args.format !== 'sequential') {
      process.stderr.write(`forge-ids: invalid --format '${args.format}' (use timestamp | sequential)\n`);
      process.exit(1);
    }
    formatOverride = args.format;
  }

  try {
    if ('new-milestone' in args) {
      const desc = args['new-milestone'];
      if (!desc || desc === true) {
        process.stderr.write('forge-ids: --new-milestone requires a description argument\n');
        process.exit(1);
      }
      process.stdout.write(resolveMilestoneId(cwd, desc, formatOverride) + '\n');
    } else if ('new-task' in args) {
      const desc = args['new-task'];
      if (!desc || desc === true) {
        process.stderr.write('forge-ids: --new-task requires a description argument\n');
        process.exit(1);
      }
      process.stdout.write(resolveTaskId(cwd, desc, formatOverride) + '\n');
    } else if ('classify' in args) {
      const id = args['classify'];
      if (!id || id === true) {
        process.stderr.write('forge-ids: --classify requires an ID argument\n');
        process.exit(1);
      }
      process.stdout.write(classify(id) + '\n');
    } else if ('slugify' in args) {
      const desc = args['slugify'];
      if (desc === true) {
        process.stderr.write('forge-ids: --slugify requires a description argument\n');
        process.exit(1);
      }
      process.stdout.write(slugify(desc || '') + '\n');
    } else {
      process.stderr.write('forge-ids: no command specified. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-ids error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();
