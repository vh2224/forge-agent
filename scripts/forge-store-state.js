#!/usr/bin/env node
// forge-store-state — migration-state detector for Forge Agent fragment stores
//
// Determines, per store, whether the fragment store has been populated relative
// to its legacy monolith. This is the single source of truth used by both the
// projection write guard (forge-projection.js) and the doctor --fix gate
// (forge-doctor.js) to avoid the "stamped-but-empty" failure mode where an
// unmigrated working copy gets its monoliths overwritten with empty skeletons.
//
// A store is:
//   'migrated'    — the fragment store has ≥ 1 fragment (source of truth lives there)
//   'unmigrated'  — the fragment store is empty BUT the monolith still has entries
//                   (regenerating the projection here would destroy real content)
//   'empty'       — no fragments and no monolith entries (fresh project — safe to write)
//
// Library exports:
//   storeState(cwd)    → { ledger, decisions, memory }  // each: { state, fragments, monolithEntries, monolithPath }
//   isUnmigrated(cwd)  → boolean  // true if ANY store is 'unmigrated'
//
// CLI:
//   node forge-store-state.js [--cwd <dir>]   // prints JSON, exit 0 always
//
// Exit codes:
//   0 — success
//   1 — runtime error

'use strict';

const fs   = require('fs');
const path = require('path');

const ledgerMod    = require('./forge-ledger');
const decisionsMod = require('./forge-decisions');
const memoryMod    = require('./forge-memory');

const ledgerMigrate    = require('./forge-ledger-migrate');
const decisionsMigrate = require('./forge-decisions-migrate');
const memoryMigrate    = require('./forge-memory-migrate');

// ── Store descriptors ───────────────────────────────────────────────────────
// Each descriptor knows how to count fragments and how to count entries in the
// legacy monolith (reusing the migrators' own parsers — no ad-hoc regex).
const STORES = [
  {
    name: 'ledger',
    monolithRel: '.gsd/LEDGER.md',
    countFragments: (cwd) => ledgerMod.listFragments(cwd).length,
    countMonolithEntries: (text) => ledgerMigrate.parseLedger(text).length,
  },
  {
    name: 'decisions',
    monolithRel: '.gsd/DECISIONS.md',
    countFragments: (cwd) => decisionsMod.listFragments(cwd).length,
    countMonolithEntries: (text) => decisionsMigrate.parseDecisions(text).rows.length,
  },
  {
    name: 'memory',
    monolithRel: '.gsd/AUTO-MEMORY.md',
    countFragments: (cwd) => memoryMod.listFragments(cwd).length,
    countMonolithEntries: (text) => memoryMigrate.parseAutoMemory(text).entries.length,
  },
];

// ── monolithHasContent ──────────────────────────────────────────────────────
// Format-agnostic "does this monolith hold real entries?" heuristic. Used as a
// safety net when a store's structured parser returns 0 — a parser bug (e.g. a
// new monolith dialect the regex doesn't recognize) must NOT be read as "empty",
// because that lets the projection write guard clobber real content.
//
// Counts as content: any non-empty line that is not part of the empty skeleton —
// i.e. not a heading (#), blockquote (>), italic placeholder (_…_), table header
// row, or table separator. Table DATA rows (those after a `|---|` separator) DO
// count. HTML comment blocks (extraction/pruning annotations) are stripped first.
function monolithHasContent(text) {
  if (!text) return false;
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  let pastSeparator = false;
  for (const raw of stripped.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Table separator row (|---|---|) marks the start of data rows.
    if (/^\|[\s\-:|]+\|$/.test(line)) { pastSeparator = true; continue; }
    if (line.startsWith('|')) {
      // A pipe row after a separator is real data; a header row before it is skeleton.
      if (pastSeparator) return true;
      continue;
    }
    if (/^#/.test(line)) continue;     // headings (## M### entries handled via body lines)
    if (/^>/.test(line)) continue;     // blockquote preamble
    if (/^_.*_$/.test(line)) continue; // italic placeholder (_No … yet._)
    return true;                       // bullets, prose, key/value lines → real content
  }
  return false;
}

// ── monolithEntryCount ────────────────────────────────────────────────────────
// Reads the monolith (if present) and returns the number of real entries.
// Returns 0 when the file is absent, empty, or only contains the skeleton.
function monolithEntryCount(cwd, store) {
  const fpath = path.join(cwd, store.monolithRel);
  let text;
  try {
    text = fs.readFileSync(fpath, 'utf8');
  } catch (_) {
    return 0; // monolith absent
  }
  let count;
  try {
    count = store.countMonolithEntries(text) || 0;
  } catch (_) {
    // A parse failure means we cannot prove the monolith is empty — treat as
    // having content so the write guard errs on the side of NOT overwriting.
    return text.trim() ? 1 : 0;
  }
  // Safety net: the structured parser found nothing but the file clearly holds
  // content. Report ≥1 so the store is classified 'unmigrated' (not 'empty') and
  // the write guard refuses to overwrite it. Without this, a parser that silently
  // under-counts (returns 0 instead of throwing) would let writeAll wipe the file.
  if (count === 0 && monolithHasContent(text)) return 1;
  return count;
}

// ── storeState ────────────────────────────────────────────────────────────────
function storeState(cwd) {
  const dir = cwd || process.cwd();
  const out = {};

  for (const store of STORES) {
    const fragments = store.countFragments(dir);
    const monolithEntries = fragments > 0 ? 0 : monolithEntryCount(dir, store);

    let state;
    if (fragments > 0) {
      state = 'migrated';
    } else if (monolithEntries > 0) {
      state = 'unmigrated';
    } else {
      state = 'empty';
    }

    out[store.name] = {
      state,
      fragments,
      monolithEntries,
      monolithPath: store.monolithRel,
    };
  }

  return out;
}

// ── isUnmigrated ────────────────────────────────────────────────────────────────
// True if ANY store is in the 'unmigrated' state.
function isUnmigrated(cwd) {
  const st = storeState(cwd);
  return Object.values(st).some(s => s.state === 'unmigrated');
}

// ── Module exports ──────────────────────────────────────────────────────────────
module.exports = { storeState, isUnmigrated, STORES };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    let cwd = process.cwd();
    const argv = process.argv.slice(2);
    const cwdIdx = argv.indexOf('--cwd');
    if (cwdIdx !== -1) {
      cwd = argv[cwdIdx + 1];
      if (!cwd) {
        process.stderr.write('--cwd requires a directory argument\n');
        process.exit(1);
      }
    }
    console.log(JSON.stringify(storeState(cwd), null, 2));
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
