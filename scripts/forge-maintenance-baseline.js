#!/usr/bin/env node
// forge-maintenance-baseline — finalized predicate + quarter helpers + trigger
// detection (T02 of S04, M-20260706152250-maintenance-fragment).
//
// This module is DETECTION ONLY — it decides WHAT is finalized and WHETHER a
// consolidation trigger has fired. It does not consolidate anything (T03) and
// does not own any UX (S05). Nothing here executes automatically.
//
// Library exports:
//   isFinalized(cwd, id, opts?)      → boolean   (D1 predicate)
//   deriveQuarter(idOrWrittenAt, writtenAtFallback?) → 'YYYY-QN' | null  (PURE)
//   currentQuarter(now?)             → 'YYYY-QN'  (the ONLY place Date may appear)
//   isClosedQuarter(q, now?)         → boolean
//   detectTriggers(cwd, opts?)       → { milestones, tasks, ledgerDecisions }
//   MILESTONE_THRESHOLD / TASK_THRESHOLD / DECISIONS_THRESHOLD
//
// Determinism invariants (hard, per S04 CONTEXT + plan):
//   - NO Math.random, NO mtime, NO localeCompare anywhere in this module.
//   - `Date`/`new Date()` appears ONLY inside currentQuarter, and is injectable
//     via the `now` parameter — every other function is pure w.r.t. time.

'use strict';

const fs = require('fs');
const path = require('path');

const ids = require('./forge-ids.js');
const ledger = require('./forge-ledger.js');
const decisions = require('./forge-decisions.js');
const runs = require('./forge-runs.js');
const state = require('./forge-state.js');

// ── Thresholds — named constants so S05/prefs can reference them ────────────
const MILESTONE_THRESHOLD = 30;
const TASK_THRESHOLD = 30;
const DECISIONS_THRESHOLD = 100;

const NOT_ACTIVE_PHASES = new Set(['idle', 'complete', 'done', 'complete-milestone']);

// ── deriveQuarter ─────────────────────────────────────────────────────────────
// PURE. Two supported input shapes:
//   1. `idOrWrittenAt` is a timestamp-format id (M-YYYYMMDDHHMMSS[-slug] or the
//      dashed M-YYYYMMDD-HHMMSS[-slug] form) → quarter derived from the id's
//      own year/month digits.
//   2. `idOrWrittenAt` is NOT a timestamp id (legacy id, or garbage) → the
//      second argument `writtenAtFallback` (if given) is treated as a raw
//      "writtenAt" string; its digits are stripped and read as YYYYMM. If
//      `writtenAtFallback` is absent, `idOrWrittenAt` itself is tried as the
//      writtenAt string (covers callers who pass a bare date string as the
//      sole argument).
// Returns null when nothing resolvable (< 6 digits, or invalid month).
// NEVER calls Date, NEVER reads mtime — the caller supplies everything.
function _extractYYYYMMFromTimestampId(id) {
  const s = String(id);
  let m = s.match(/^[MT]-(\d{14})/);
  if (m) return m[1].slice(0, 6);
  m = s.match(/^(?:M|T|TASK)-(\d{8})-(\d{6})/i);
  if (m) return m[1].slice(0, 6);
  return null;
}

function _quarterFromYYYYMM(yyyymm) {
  if (!yyyymm || yyyymm.length < 6) return null;
  const year = yyyymm.slice(0, 4);
  const month = parseInt(yyyymm.slice(4, 6), 10);
  if (!/^\d{4}$/.test(year) || !(month >= 1 && month <= 12)) return null;
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${q}`;
}

function deriveQuarter(idOrWrittenAt, writtenAtFallback) {
  if (idOrWrittenAt != null && ids.classify(idOrWrittenAt) === 'timestamp') {
    const yyyymm = _extractYYYYMMFromTimestampId(idOrWrittenAt);
    const q = _quarterFromYYYYMM(yyyymm);
    if (q) return q;
    // Fall through to writtenAt if id matched the classify pattern but the
    // digit extraction still somehow failed (defensive — should not happen).
  }

  const src = writtenAtFallback != null ? writtenAtFallback : idOrWrittenAt;
  if (src == null) return null;
  const digits = String(src).replace(/\D/g, '');
  if (digits.length < 6) return null;
  return _quarterFromYYYYMM(digits);
}

// ── currentQuarter ────────────────────────────────────────────────────────────
// The ONLY function in this module allowed to touch `Date`. Injectable `now`
// for deterministic tests.
function currentQuarter(now) {
  const d = now || new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  return _quarterFromYYYYMM(`${year}${String(month).padStart(2, '0')}`);
}

// ── isClosedQuarter ───────────────────────────────────────────────────────────
// Bytewise string comparison — safe because 'YYYY-QN' is zero-padded and the
// lexical order matches chronological order.
function isClosedQuarter(q, now) {
  if (q == null) return false;
  return q < currentQuarter(now);
}

// ── isActiveUnit (internal) ───────────────────────────────────────────────────
// Resolves whether `id` is the workspace's active in-progress unit.
// Precedence: opts.activeIds (test injection) short-circuits everything else;
// otherwise checks forge-runs.get() per-id, OR'd with the legacy STATE.md
// dashboard pointer (a run record and a stale STATE.md can both exist —
// either signal marks the unit active).
function _isActiveUnit(cwd, id, opts) {
  if (opts && opts.activeIds) return opts.activeIds.has(id);

  let runActive = false;
  try {
    const rec = runs.get(cwd, id);
    runActive = !!(rec && rec.active === true);
  } catch { /* runs registry unavailable — treat as not-active from this source */ }
  if (runActive) return true;

  try {
    const legacy = state.readLegacyStateFile(cwd);
    if (legacy) {
      const phase = String(legacy.phase || 'idle').toLowerCase();
      if (!NOT_ACTIVE_PHASES.has(phase)) {
        if (legacy.active_milestone === id || legacy.active_task === id) return true;
      }
    }
  } catch { /* legacy STATE unreadable — no signal from this source */ }

  return false;
}

// ── isFinalized (D1) ──────────────────────────────────────────────────────────
// true only when: done-evidence present AND the unit is NOT the active
// in-progress unit. `opts.activeIds` (a Set) lets tests pin the active set
// deterministically instead of touching real runs/STATE.
function isFinalized(cwd, id, opts) {
  opts = opts || {};

  // ask-* / conversation units: closed logs, never "in progress" — the
  // decisions axis already gates them via closed-quarter, so treat as done.
  if (/^ask-/.test(String(id))) return true;

  if (_isActiveUnit(cwd, id, opts)) return false;

  const kind = ids.entityKind(id);
  let doneEvidence = false;

  if (kind === 'milestone') {
    doneEvidence = fs.existsSync(
      path.join(cwd, '.gsd', 'milestones', id, `${id}-SUMMARY.md`)
    );
  } else if (kind === 'task') {
    doneEvidence = fs.existsSync(
      path.join(cwd, '.gsd', 'tasks', id, `${id}-SUMMARY.md`)
    );
  }

  if (!doneEvidence) {
    try {
      doneEvidence = ledger.readFragment(cwd, id) !== null;
    } catch { /* invalid id shape for the ledger store — no evidence from here */ }
  }

  return doneEvidence;
}

// ── detectTriggers ────────────────────────────────────────────────────────────
// Enumerates LOOSE (non-bucketed) finalized units per axis and reports whether
// each axis has crossed its threshold. Already-consolidated (bucketed) units
// are excluded — they were counted the cycle they were baselined.
function detectTriggers(cwd, opts) {
  opts = opts || {};
  const now = opts.now;

  let milestonesCount = 0;
  let tasksCount = 0;

  const ledgerEntries = ledger.listFragments(cwd).filter(e => !e.bucket);
  for (const entry of ledgerEntries) {
    if (!isFinalized(cwd, entry.id, opts)) continue;
    const kind = ids.entityKind(entry.id);
    if (kind === 'milestone') milestonesCount++;
    else if (kind === 'task') tasksCount++;
  }

  let closedQuarterCount = 0;
  const decisionEntries = decisions.listFragments(cwd).filter(e => !e.bucket);
  for (const entry of decisionEntries) {
    if (!isFinalized(cwd, entry.unitId, opts)) continue;
    const q = deriveQuarter(entry.unitId, opts.writtenAtFor ? opts.writtenAtFor(entry.unitId) : undefined);
    if (isClosedQuarter(q, now)) closedQuarterCount++;
  }

  return {
    milestones: { count: milestonesCount, fired: milestonesCount >= MILESTONE_THRESHOLD },
    tasks: { count: tasksCount, fired: tasksCount >= TASK_THRESHOLD },
    ledgerDecisions: { closedQuarterCount, fired: closedQuarterCount >= DECISIONS_THRESHOLD },
  };
}

module.exports = {
  isFinalized,
  deriveQuarter,
  currentQuarter,
  isClosedQuarter,
  detectTriggers,
  MILESTONE_THRESHOLD,
  TASK_THRESHOLD,
  DECISIONS_THRESHOLD,
};
