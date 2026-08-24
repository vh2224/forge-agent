#!/usr/bin/env node
'use strict';

/**
 * forge-eol-protected.js -- the closed roster of scopes the EOL guard enforces
 * on, plus the counts each one was measured at.
 *
 * WHY A ROSTER AND NOT "NOTHING MAY BE EXPOSED".  A fresh census of scripts/
 * reports ~813 statically exposed call sites, and that number is not a defect
 * count: Form A/funnel repairs normalise at the READ, so every LF-anchored split
 * downstream of the funnel stays statically exposed and behaviourally correct.
 * (That sentence deliberately spells no split literal: this file is itself
 * scanned, and a specimen quoted in a comment would enter the census as a
 * suspect attributed to no scope -- noise the guard would then have to excuse.)
 * scripts/forge-app-items.test.js is the proof -- S03 closed its oracle
 * completely (12 flipping asserts -> 0) and it still carries 30 exposed sites
 * out of 32.  A guard anchored on "zero exposed" would fail 813 sites on day
 * one, including the ones proven correct, and would be muted within a week.
 * That is the forge-doctor Layer-3 precedent this milestone exists to avoid.
 *
 * THE INVARIANT THIS FILE FEEDS, per protected scope, is therefore a pair of
 * counts rather than an absolute:
 *
 *     exposed_count(scope) <= baseline_exposed
 *     tolerant_count(scope) >= baseline_tolerant
 *
 * Both legs are load-bearing.  Reverting an S03 repair turns a tolerant
 * construct (`\r?\n`, `/\r\n?/g`, a captured `eol`) into a blind one, which
 * raises exposed AND lowers tolerant at once; deleting the construct outright
 * moves only the second.  One leg alone would miss one of the two ways back.
 *
 * NO LINE NUMBERS, ANYWHERE.  The anchor is `{file, symbol}` (or `{file}` for
 * a module-scope entry).  S03/T03 inflicted a regression on itself with a
 * specimen hardcoded at line 490 when a comment insertion shifted the lines
 * above it; assertNoLineNumbers() below makes that shape unrepresentable here.
 *
 * ONE DETECTOR.  Every count comes from scanEolAnchors() in
 * forge-eol-anchors.js.  A second heuristic would let the roster and the census
 * disagree, and there would be no principled answer to "which one is right?".
 */

const fs = require('fs');
const path = require('path');
const anchors = require('./forge-eol-anchors');

// Named, enumerated reasons.  Silent absence is forbidden: a scope that is not
// in the roster is in excluded[] under one of these.
const EXCLUSION_REASONS = Object.freeze({
  NO_ORACLE_TRACE: 'no-oracle-trace',
  NOT_TOUCHED_BY_S03: 'not-touched-by-s03',
  SCOPE_UNRESOLVED: 'scope-unresolved',
  UNCONFIRMED_SUSPECT: 'unconfirmed-suspect-out-of-scope',
  LONE_CR_OUT_OF_SCOPE: 'lone-cr-out-of-scope',
});

const FAILURE_REASONS = Object.freeze({
  NO_PROTECTED_SCOPE_RESOLVED: 'no-protected-scope-resolved',
  PROTECTED_SCOPE_UNRESOLVED: 'protected-scope-unresolved',
  FAMILY_FLOOR_TEST_EMPTY: 'family-floor-test-empty',
  FAMILY_FLOOR_SOURCE_EMPTY: 'family-floor-source-empty',
  ROSTER_EMPTY: 'roster-empty',
  LINE_NUMBER_IN_ROSTER: 'line-number-in-roster',
  CENSUS_FAILED: 'census-failed',
  FILE_UNREADABLE: 'file-unreadable',
  SYMBOL_NOT_DECLARED: 'symbol-not-declared',
  SCOPE_UNTERMINATED: 'scope-unterminated',
  INVALID_SYMBOL: 'invalid-symbol',
});

const SCOPE_KINDS = Object.freeze({ SYMBOL: 'symbol', FILE: 'file' });

// The only numeric fields a roster entry may carry.  Anything else numeric is
// rejected by assertNoLineNumbers(), which is what keeps a line number from
// creeping back in as `line`, `offset` or `at`.
const NUMERIC_FIELDS_ALLOWED = Object.freeze(['baseline_exposed', 'baseline_tolerant']);

const DEFAULT_ROOT = 'scripts';

// ---------------------------------------------------------------------------
// The roster.
//
// Derivation rule, applied mechanically over the 78 funnels of S03-FIXSET.json
// (see S04-protected-roster.json for the entry-by-entry reconciliation):
//
//   in  <=>  the funnel's scope contains a line S03 actually changed
//            (git diff e8c4040..f7aaf25, the S03 commit range)
//       AND  the funnel's file lies in the attribution set of at least one
//            suite in S01's confirmed[] -- the oracle closes the set, the
//            census only locates it (D-S03-1)
//       AND  the scope resolves textually against HEAD.
//
// A funnel S03 touched without an oracle trace is excluded, not protected: the
// enforcing level answers only to behaviour the differential confirmed.
// ---------------------------------------------------------------------------
const PROTECTED = Object.freeze([
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.FILE,
    form: "B",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form B funnel at module scope: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 30,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "itemCardBody",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-funnel funnel at itemCardBody: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "itemDetailSheetBody",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-funnel funnel at itemDetailSheetBody: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "itemsViewBody",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-funnel funnel at itemsViewBody: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "readLines",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-funnel funnel at readLines: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-app-items.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "stripAllComments",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-inplace funnel at stripAllComments: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-items.test.js)",
    oracle_trace: ["forge-app-items.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-app-projects-digest.test.js",
    kind: SCOPE_KINDS.FILE,
    form: "B",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form B funnel at module scope: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-projects-digest.test.js)",
    oracle_trace: ["forge-app-projects-digest.test.js"],
    baseline_exposed: 2,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-app-projects-digest.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "stripComments",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-inplace funnel at stripComments: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-projects-digest.test.js)",
    oracle_trace: ["forge-app-projects-digest.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-app-workspace-marker.test.js",
    kind: SCOPE_KINDS.FILE,
    form: "B",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form B funnel at module scope: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 7,
    baseline_tolerant: 6,
  },
  {
    file: "scripts/forge-app-workspace-marker.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "jsDefaultCandidates",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-funnel funnel at jsDefaultCandidates: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-app-workspace-marker.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "projectRoleBody",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-inplace funnel at projectRoleBody: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-app-workspace-marker.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "stripLineComments",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-inplace funnel at stripLineComments: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-app-workspace-marker.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "swiftWorkEntries",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T03, S03/T04",
    why: "form A-inplace funnel at swiftWorkEntries: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-dashboard.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "readEventsTail",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T02, S03/T03; moved to scripts/forge-jsonl.js::readJsonl by T-20260824022343-criar-scripts-forge",
    why: "readEventsTail is now a thin delegation to the shared forge-jsonl.js reader (T-20260824022343-criar-scripts-forge) — the normalize+split constructs that used to live here moved with the code, not away from it. This scope itself owns zero constructs now; the protection lives on the new entry below. The file is still exercised by an S01 confirmed[] suite (forge-projection.test.js)",
    oracle_trace: ["forge-projection.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-dashboard.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "readLedgerTail",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form A-funnel funnel at readLedgerTail: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-projection.test.js)",
    oracle_trace: ["forge-projection.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-dashboard.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "render",
    form: "B",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form B funnel at render: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-projection.test.js)",
    oracle_trace: ["forge-projection.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-ignore.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "applyIgnore",
    form: "B",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form B funnel at applyIgnore: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (fragment-store-guards.test.js)",
    oracle_trace: ["fragment-store-guards.test.js"],
    baseline_exposed: 2,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-ignore.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "readGitignoreLines",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form A-funnel funnel at readGitignoreLines: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (fragment-store-guards.test.js)",
    oracle_trace: ["fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-ignore.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "svnPropget",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form A-inplace funnel at svnPropget: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (fragment-store-guards.test.js)",
    oracle_trace: ["fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "cleanupBranchOne",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at cleanupBranchOne: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "cleanupWorktreeOne",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at cleanupWorktreeOne: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "fetchDefaultBranch",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at fetchDefaultBranch: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "loadRegistryRoots",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at loadRegistryRoots: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "setupBranchOne",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at setupBranchOne: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-isolation.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "setupWorktreeOne",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at setupWorktreeOne: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-app-workspace-marker.test.js)",
    oracle_trace: ["forge-app-workspace-marker.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-jsonl.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "readJsonl",
    form: "A-funnel",
    s03_tasks_touching_file: "T-20260824022343-criar-scripts-forge — new module; carries the tolerance moved out of scripts/forge-dashboard.js::readEventsTail (form A-funnel) when the two readers (forge-tokens.js::readJsonlLines, forge-dashboard.js::readEventsTail) were promoted into this shared module",
    why: "readJsonl normalizes CRLF/lone-CR to LF at the read (form A-inplace regex) and splits on a CR-tolerant boundary as a second, independent A-form construct — moving the protection with the code it was extracted from, per the rule that a scope's tolerance must not net-lose when duplicated logic is deduplicated into one call site. Exercised by scripts/forge-jsonl.test.js (six discuss-measured entries: CRLF, lone CR, BOM, truncated tail, blank lines, indented line — plus the maxLines tail window and the discard census)",
    oracle_trace: ["forge-jsonl.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-ledger-snapshot.test.js",
    kind: SCOPE_KINDS.FILE,
    form: "B",
    s03_tasks_touching_file: "S03/T02, S03/T04, S03/T05",
    why: "form B funnel at module scope: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js"],
    baseline_exposed: 8,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-ledger-snapshot.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "markerLineOf",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T02, S03/T04, S03/T05",
    why: "form A-inplace funnel at markerLineOf: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-ledger.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "parseFragment",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at parseFragment: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-ledger.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "serializeFrontmatter",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at serializeFrontmatter: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-memory-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "parseAutoMemory",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at parseAutoMemory: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (fragment-store-guards.test.js)",
    oracle_trace: ["fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-memory-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "parseCheckerMemory",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at parseCheckerMemory: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (fragment-store-guards.test.js)",
    oracle_trace: ["fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-memory.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "parseFragment",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at parseFragment: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-memory.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-memory.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-memory.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "serializeFrontmatter",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at serializeFrontmatter: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-memory.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-memory.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-prefs-legacy.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "legacyReadFile",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T03",
    why: "form A-funnel funnel at legacyReadFile: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 2,
  },
  {
    file: "scripts/forge-prefs-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "activateValues",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at activateValues: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "ensureGitignore",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at ensureGitignore: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "renderActiveEntry",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at renderActiveEntry: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "rootEntryEnd",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at rootEntryEnd: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-migrate.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "setCatalogValue",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at setCatalogValue: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-scaffold.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "commentedRootKeys",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at commentedRootKeys: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-scaffold.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "generatedSection",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at generatedSection: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-prefs-scaffold.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "rescaffoldCatalog",
    form: "B",
    s03_tasks_touching_file: "S03/T02",
    why: "form B funnel at rescaffoldCatalog: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-prefs-migrate.test.js)",
    oracle_trace: ["forge-prefs-migrate.test.js"],
    baseline_exposed: 2,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-projection.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "parseOrphanMemory",
    form: "B",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form B funnel at parseOrphanMemory: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js, forge-memory.test.js, forge-projection.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js","forge-memory.test.js","forge-projection.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 1,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-projection.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "renderDecisions",
    form: "B",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form B funnel at renderDecisions: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js, forge-memory.test.js, forge-projection.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js","forge-memory.test.js","forge-projection.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 2,
    baseline_tolerant: 0,
  },
  {
    file: "scripts/forge-projection.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "snapshotUnitsFromMonolith",
    form: "A-funnel",
    s03_tasks_touching_file: "S03/T02, S03/T03",
    why: "form A-funnel funnel at snapshotUnitsFromMonolith: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js, forge-memory.test.js, forge-projection.test.js, fragment-store-guards.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js","forge-memory.test.js","forge-projection.test.js","fragment-store-guards.test.js"],
    baseline_exposed: 2,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-projection.test.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "headerOrder",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T02, S03/T04, S03/T05",
    why: "form A-inplace funnel at headerOrder: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-projection.test.js)",
    oracle_trace: ["forge-projection.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
  {
    file: "scripts/forge-tokens.js",
    kind: SCOPE_KINDS.SYMBOL,
    symbol: "truncateAtSectionBoundary",
    form: "A-inplace",
    s03_tasks_touching_file: "S03/T04",
    why: "form A-inplace funnel at truncateAtSectionBoundary: an S03 hunk lands inside this resolved scope, and the file is exercised by an S01 confirmed[] suite (forge-ledger-snapshot.test.js)",
    oracle_trace: ["forge-ledger-snapshot.test.js"],
    baseline_exposed: 0,
    baseline_tolerant: 1,
  },
].map(Object.freeze));

// ---------------------------------------------------------------------------
// Scope resolution -- textual, by declaration, never by line.
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Declaration forms recognised, mirroring SCOPE_DECL_RE in forge-eol-anchors.js
 * so that a symbol the census can attribute is a symbol this module can locate.
 * The brace match itself is delegated to the census tokenizer -- comment,
 * string, template and regex spans are decided in exactly one place.
 */
function declarationPatterns(symbol) {
  const s = symbol.replace(/\$/g, '\\$');
  return [
    new RegExp(`\\b(?:async[ \\t]+)?function[ \\t]+${s}[ \\t]*\\([^()\\r\\n]*\\)[ \\t]*\\{`),
    new RegExp(`\\b(?:const|let|var)[ \\t]+${s}[ \\t]*=[ \\t]*(?:async[ \\t]*)?\\([^()\\r\\n]*\\)[ \\t]*=>[ \\t]*\\{`),
    new RegExp(`^[ \\t]*(?:async[ \\t]+)?${s}[ \\t]*\\([^()\\r\\n]*\\)[ \\t]*\\{`, 'm'),
  ];
}

/**
 * Locate the body of one roster entry inside `content`.
 * Returns `{ ok:true, start, end }` or `{ ok:false, reason }` -- a named reason,
 * never a bare null.
 */
function resolveScope(content, entry) {
  if (typeof content !== 'string' || !entry) return { ok: false, reason: FAILURE_REASONS.FILE_UNREADABLE };
  if (entry.kind === SCOPE_KINDS.FILE) {
    return content.length > 0
      ? { ok: true, start: 0, end: content.length - 1 }
      : { ok: false, reason: FAILURE_REASONS.FILE_UNREADABLE };
  }
  const symbol = entry.symbol;
  if (typeof symbol !== 'string' || !IDENTIFIER_RE.test(symbol)) {
    return { ok: false, reason: FAILURE_REASONS.INVALID_SYMBOL };
  }
  for (const pattern of declarationPatterns(symbol)) {
    const match = pattern.exec(content);
    if (!match) continue;
    const openingBrace = match.index + match[0].lastIndexOf('{');
    const end = anchors._private.braceEnd(content, openingBrace);
    if (end < openingBrace) return { ok: false, reason: FAILURE_REASONS.SCOPE_UNTERMINATED };
    return { ok: true, start: match.index, end };
  }
  return { ok: false, reason: FAILURE_REASONS.SYMBOL_NOT_DECLARED };
}

// ---------------------------------------------------------------------------
// Measurement -- one census run, consumed twice.
// ---------------------------------------------------------------------------

function toPosixRelative(cwd, filePath) {
  return path.relative(cwd, filePath).split(path.sep).join('/');
}

function scopeKeyOf(entry) {
  return entry.kind === SCOPE_KINDS.FILE ? `${entry.file}::(file)` : `${entry.file}::${entry.symbol}`;
}

/**
 * Count exposed/tolerant call sites per protected scope, from ONE scan.
 *
 * Attribution reuses the census's own `symbol` field rather than re-deriving
 * containment from offsets: the census already assigns each site to its
 * nearest enclosing declaration, and asking a second mechanism the same
 * question is how a roster and a census come to disagree.  A `kind:'file'`
 * entry counts every site in the file, its own symbol-scoped siblings
 * included -- the two invariants are independent, and the wider one is
 * deliberately the stricter of the two.
 */
function measureBaselines(opts) {
  opts = opts || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  const roster = opts.roster || PROTECTED;
  const root = path.resolve(cwd, opts.root || DEFAULT_ROOT);
  const scan = opts.scan || anchors.scanEolAnchors([root]);
  if (!scan || scan.outcome === 'scan-failed') {
    return { ok: false, reason: FAILURE_REASONS.CENSUS_FAILED, message: (scan && scan.reason) || FAILURE_REASONS.CENSUS_FAILED, scopes: [], census_totals: null };
  }

  const byFile = new Map();
  for (const site of scan.call_sites) {
    const key = toPosixRelative(cwd, site.file);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(site);
  }

  const scopes = [];
  const unresolved = [];
  for (const entry of roster) {
    const sites = byFile.get(entry.file) || [];
    let content = null;
    try { content = fs.readFileSync(path.resolve(cwd, entry.file), 'utf8'); } catch { content = null; }
    const resolution = content === null
      ? { ok: false, reason: FAILURE_REASONS.FILE_UNREADABLE }
      : resolveScope(content, entry);
    if (!resolution.ok) {
      unresolved.push({ file: entry.file, symbol: entry.symbol || null, kind: entry.kind, reason: resolution.reason });
      continue;
    }
    const owned = entry.kind === SCOPE_KINDS.FILE ? sites : sites.filter((site) => site.symbol === entry.symbol);
    scopes.push({
      key: scopeKeyOf(entry),
      file: entry.file,
      symbol: entry.symbol || null,
      kind: entry.kind,
      exposed: owned.filter((site) => site.exposed === true).length,
      tolerant: owned.filter((site) => site.exposed !== true).length,
      call_sites: owned.length,
    });
  }

  return {
    ok: unresolved.length === 0 && scopes.length > 0,
    reason: scopes.length === 0
      ? FAILURE_REASONS.NO_PROTECTED_SCOPE_RESOLVED
      : (unresolved.length > 0 ? FAILURE_REASONS.PROTECTED_SCOPE_UNRESOLVED : null),
    scopes,
    unresolved,
    census_totals: {
      scanned: scan.scanned,
      call_sites: scan.counts.call_sites,
      exposed: scan.counts.exposed,
    },
  };
}

// ---------------------------------------------------------------------------
// Floors.
// ---------------------------------------------------------------------------

function isTestFile(file) {
  return /\.test\.js$/.test(String(file));
}

/**
 * D2: coverage must not collapse onto one family.  Four of the five known
 * instances of this class, and 44 of the 80 static suspects, live in
 * `*.test.js`; a roster that quietly loses its test half would switch off half
 * the guard while still reporting green.  Both families are floors, and an
 * empty roster is a named failure rather than a vacuous pass.
 */
function familyFloor(roster) {
  const list = Array.isArray(roster) ? roster : PROTECTED;
  const testEntries = list.filter((entry) => isTestFile(entry.file));
  const sourceEntries = list.filter((entry) => !isTestFile(entry.file));
  if (list.length === 0) {
    return { ok: false, reason: FAILURE_REASONS.ROSTER_EMPTY, test_entries: 0, source_entries: 0, message: 'roster is empty: zero protected scopes is a failure, never a clean pass' };
  }
  if (testEntries.length === 0) {
    return { ok: false, reason: FAILURE_REASONS.FAMILY_FLOOR_TEST_EMPTY, test_entries: 0, source_entries: sourceEntries.length, message: 'no *.test.js entry: D2 requires both families to stay covered' };
  }
  if (sourceEntries.length === 0) {
    return { ok: false, reason: FAILURE_REASONS.FAMILY_FLOOR_SOURCE_EMPTY, test_entries: testEntries.length, source_entries: 0, message: 'no non-test .js entry: D2 requires both families to stay covered' };
  }
  return { ok: true, reason: null, test_entries: testEntries.length, source_entries: sourceEntries.length, message: 'both families present' };
}

/**
 * Reject any numeric roster field outside the two baselines.  This is the
 * mechanical form of "no line numbers": a `line`, `offset` or `at` field cannot
 * be added without tripping it.
 */
function assertNoLineNumbers(roster) {
  const list = Array.isArray(roster) ? roster : PROTECTED;
  const offenders = [];
  for (const entry of list) {
    for (const [field, value] of Object.entries(entry)) {
      if (NUMERIC_FIELDS_ALLOWED.includes(field)) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (typeof item === 'number') offenders.push({ file: entry.file, symbol: entry.symbol || null, field });
      }
    }
  }
  return offenders.length === 0
    ? { ok: true, reason: null, offenders, message: 'no numeric field outside the baselines' }
    : { ok: false, reason: FAILURE_REASONS.LINE_NUMBER_IN_ROSTER, offenders, message: `numeric field outside the baselines: ${offenders.map((o) => `${o.file}:${o.field}`).join(', ')}` };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false, cwd: process.cwd(), root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--cwd' || arg === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a directory` };
      if (arg === '--cwd') args.cwd = value; else args.root = value;
    } else return { error: `unknown argument: ${arg}` };
  }
  return args;
}

function buildReport(opts) {
  const measurement = measureBaselines(opts);
  const roster = (opts && opts.roster) || PROTECTED;
  const floor = familyFloor(roster);
  const lineCheck = assertNoLineNumbers(roster);
  const byKey = new Map((measurement.scopes || []).map((scope) => [scope.key, scope]));
  const entries = roster.map((entry) => {
    const measured = byKey.get(scopeKeyOf(entry)) || null;
    return {
      file: entry.file,
      symbol: entry.symbol || null,
      kind: entry.kind,
      form: entry.form,
      repaired_in: entry.repaired_in,
      why: entry.why,
      oracle_trace: entry.oracle_trace,
      baseline_exposed: entry.baseline_exposed,
      baseline_tolerant: entry.baseline_tolerant,
      measured_exposed: measured ? measured.exposed : null,
      measured_tolerant: measured ? measured.tolerant : null,
      resolved: Boolean(measured),
    };
  });
  const ok = Boolean(measurement.ok) && floor.ok && lineCheck.ok;
  const reason = measurement.reason || floor.reason || lineCheck.reason || null;
  return {
    outcome: ok ? 'roster-resolved' : 'roster-failed',
    ...(reason ? { reason } : {}),
    roster: entries,
    unresolved: measurement.unresolved || [],
    family_floor: floor,
    line_number_check: { ok: lineCheck.ok, reason: lineCheck.reason, offenders: lineCheck.offenders, message: lineCheck.message },
    census_totals: measurement.census_totals,
    counts: { entries: entries.length, resolved: entries.filter((e) => e.resolved).length, unresolved: (measurement.unresolved || []).length },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { process.stderr.write(`Error: ${args.error}\n`); process.exitCode = 2; return; }
  const report = buildReport({ cwd: args.cwd, root: args.root });
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const entry of report.roster) {
      process.stdout.write(`${entry.file}::${entry.symbol || '(file)'} exposed ${entry.measured_exposed}/${entry.baseline_exposed} tolerant ${entry.measured_tolerant}/${entry.baseline_tolerant}\n`);
    }
    for (const miss of report.unresolved) process.stdout.write(`unresolved ${miss.file}::${miss.symbol || '(file)'} [${miss.reason}]\n`);
    process.stdout.write(`${report.outcome}${report.reason ? `: ${report.reason}` : ''}\n`);
  }
  process.exitCode = report.outcome === 'roster-resolved' ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  PROTECTED,
  EXCLUSION_REASONS,
  FAILURE_REASONS,
  SCOPE_KINDS,
  resolveScope,
  measureBaselines,
  familyFloor,
  assertNoLineNumbers,
  buildReport,
  _private: { declarationPatterns, toPosixRelative, scopeKeyOf, isTestFile, parseArgs, NUMERIC_FIELDS_ALLOWED, DEFAULT_ROOT },
};
