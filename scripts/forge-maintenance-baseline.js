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
//   consolidateAxis(cwd, { units, target, type, invalidate }) → { target, unitIds, bytes, hash }
//   runBaseline(cwd, opts?)          → { dryRun } | { applied, milestones, tasks, ledgerDecisions, verified }
//   MILESTONE_THRESHOLD / TASK_THRESHOLD / DECISIONS_THRESHOLD
//
// runBaseline (T03) is the actual consolidation: fuses every LOOSE finalized
// unit per axis into the LOCKED targets (R1):
//   milestones → .gsd/archive/milestones-rollup.md   (type 'ledger')
//   tasks      → .gsd/archive/tasks-rollup.md         (type 'ledger')
//   decisions  → .gsd/decisions/_rollup-<YYYY-QN>.md  (type 'decisions', per CLOSED quarter)
// Every source loose fragment is `.bak`-ed before deletion; the projection
// (renderLedger/renderDecisions) is verified byte-identical BEFORE physical
// deletion completes — on ANY mismatch the run ABORTS, restores every source
// from its `.bak`, and removes the just-written buckets (no data loss ever).
// Every written target is asserted against `isRollupPath()` (S03 handoff) —
// a target that doesn't satisfy it would leave the VCS guard blind to it.
// On a successful apply that actually wrote at least one target, runBaseline
// stamps `.gsd/SCHEMA-VERSION = fragment-store@2.0.0` via stampBucketSchema
// (S06, upgrade-only — never clobbers an existing valid 2.0.0 stamp). A
// dry-run or a run that consolidated nothing never touches SCHEMA-VERSION.
//
// CLI:
//   node forge-maintenance-baseline.js --dry-run [--cwd <dir>]
//   node forge-maintenance-baseline.js --baseline [--cwd <dir>]
//   node forge-maintenance-baseline.js --help
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
const { mergeBucket } = require('./forge-maintenance.js');
const { writeAtomic } = require('./forge-yaml-safe.js');
const { renderLedger, renderDecisions } = require('./forge-projection.js');
const { isRollupPath } = require('./forge-maintenance-vcs.js');
const { BUCKET_SCHEMA } = require('./forge-doctor.js');

// ── Thresholds — named constants so S05/prefs can reference them ────────────
const MILESTONE_THRESHOLD = 30;
const TASK_THRESHOLD = 30;
const DECISIONS_THRESHOLD = 100;

const NOT_ACTIVE_PHASES = new Set(['idle', 'complete', 'done', 'complete-milestone']);

// ── axes selector (S05, additive) ────────────────────────────────────────────
// AXES names the three consolidation axes. `_axisEnabled` is a pure gate:
// omitting `opts.axes` enables every axis (byte-identical to pre-S05
// behavior); passing an explicit array restricts gathering/consolidation to
// only the named axes. This is a SELECTOR over what to gather — it changes
// no mechanics (normalization, .bak protection, verify/abort-restore).
const AXES = ['milestones', 'tasks', 'ledgerDecisions'];

// REVIEW-FIX (S05, M1/MAJOR): the public/detection/spec name for the third
// axis is `ledgerDecisions` everywhere (detectTriggers, shared/forge-maintenance.md,
// forge-sweep/forge-next skills). `_axisEnabled` accepts BOTH `'ledgerDecisions'`
// and the legacy bare `'decisions'` as aliases for the same axis, so neither a
// caller following the spec nor a caller using the old internal name silently
// no-ops.
function _axisEnabled(opts, axis) {
  if (!opts || !opts.axes) return true;
  if (axis === 'ledgerDecisions' || axis === 'decisions') {
    return opts.axes.includes('ledgerDecisions') || opts.axes.includes('decisions');
  }
  return opts.axes.includes(axis);
}

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

// REVIEW-FIX (S04-Obj4): `runs.get(cwd, id).active === true` used to be
// trusted with NO staleness check. A run record left `active: true` by a
// crashed/abandoned session (Ctrl+C, killed terminal, machine sleep) would
// then indefinitely and silently exclude a genuinely-finalized unit from
// consolidation — the record never expires on its own, only
// `forge-runs --cleanup-stale` removes it, and nothing guarantees that runs
// promptly against every id. `_isActiveUnit` now additionally requires the
// record to be FRESH (not stale) for `active: true` to count — a stale
// "active" record is treated as not-active, so the finalized unit becomes
// eligible again.
//
// TTL choice: reuse forge-runs' own STALE_THRESHOLD_MS (30min) rather than
// inventing a second number. Rationale for going with the existing
// "garbage-collect" threshold instead of something even more generous:
// this predicate only flips a unit from "active" to "not active" — it does
// NOT delete or mutate anything. Worst case if the TTL is too short: a
// genuinely long-running/paused session (heartbeat lagging past 30min)
// gets treated as if it weren't active, and the id becomes visible to
// detectTriggers as a candidate for consolidation — consolidation is
// EXPECTED to be gated by both isFinalized AND actual done-evidence
// (`SUMMARY.md`/ledger fragment), so a still-in-progress unit with no
// done-evidence yet stays excluded by the `doneEvidence` check below
// regardless of this active flag. That asymmetry (activity used only to
// EXCLUDE an otherwise-finalized unit, never to force-include an
// unfinished one) is what makes reusing the shorter GC threshold safe here
// — erring toward "stale wins" cannot cause a false consolidation, only an
// earlier-than-ideal one, and 30min already matches the interval forge-runs
// itself considers "dead enough to garbage collect". Overridable via
// `opts.activeTtlMs` for tests/tuning.
const ACTIVE_STALE_TTL_MS = runs.STALE_THRESHOLD_MS;

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
    const ttl = (opts && opts.activeTtlMs) || ACTIVE_STALE_TTL_MS;
    runActive = !!(rec && rec.active === true && !runs.isStale(rec, ttl, opts && opts.now));
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

// ── rollup target path helpers ───────────────────────────────────────────────
function _milestonesTarget(cwd) {
  return path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');
}
function _tasksTarget(cwd) {
  return path.join(cwd, '.gsd', 'archive', 'tasks-rollup.md');
}
function _decisionsTarget(cwd, quarter) {
  return path.join(cwd, '.gsd', 'decisions', `_rollup-${quarter}.md`);
}

// ── _assertRollupPath (runtime guard, not just a test) ───────────────────────
// S03 handoff: every rollup file this module writes MUST satisfy
// isRollupPath() or the VCS commit guard goes blind to it. This is a real
// runtime assertion — a broken target name fails LOUD, not silently.
function _assertRollupPath(cwd, absTarget) {
  const rel = path.relative(cwd, absTarget).replace(/\\/g, '/');
  if (!isRollupPath(rel)) {
    throw new Error(
      `Internal error: rollup target "${rel}" does not satisfy isRollupPath() — refusing to write (VCS guard would go blind to it)`
    );
  }
}

// ── consolidateAxis ───────────────────────────────────────────────────────────
// Given an EXPLICIT list of loose fragment paths (`units`), a `target` path,
// and a bucket `type`, fuses them into the target bucket via mergeBucket
// (frozen, S01 — sorts internally; baseline performs NO ordering of its own),
// writes it atomically, then invalidates the owning store's bucket cache so
// the post-write projection reflects the new bucket immediately.
// Returns { target, unitIds, bytes, hash }.
function consolidateAxis(cwd, opts) {
  opts = opts || {};
  const units = opts.units || [];
  const target = opts.target;
  const type = opts.type || 'generic';
  const invalidate = opts.invalidate;

  _assertRollupPath(cwd, target);

  fs.mkdirSync(path.dirname(target), { recursive: true });

  let existing = null;
  if (fs.existsSync(target)) {
    existing = fs.readFileSync(target, 'utf8');
  }

  const result = mergeBucket(units, { type, existing });
  writeAtomic(target, result.content, { cwd });

  if (typeof invalidate === 'function') invalidate(cwd);

  return {
    target,
    unitIds: result.units,
    bytes: Buffer.byteLength(result.content, 'utf8'),
    hash: result.hash,
  };
}

// ── _gatherEligibility (internal) ────────────────────────────────────────────
// Enumerates loose finalized units per axis, mirroring detectTriggers' walk
// but returning the actual paths/ids needed to consolidate (not just counts).
// Decisions are grouped by deriveQuarter, closed-quarter only.
function _gatherEligibility(cwd, opts) {
  opts = opts || {};
  const now = opts.now;

  const milestoneIds = [];
  const milestonePaths = [];
  const taskIds = [];
  const taskPaths = [];

  const milestonesOn = _axisEnabled(opts, 'milestones');
  const tasksOn = _axisEnabled(opts, 'tasks');
  const decisionsOn = _axisEnabled(opts, 'decisions');

  const ledgerEntries = ledger.listFragments(cwd).filter(e => !e.bucket);
  for (const entry of ledgerEntries) {
    if (!isFinalized(cwd, entry.id, opts)) continue;
    const kind = ids.entityKind(entry.id);
    if (kind === 'milestone') {
      if (!milestonesOn) continue;
      milestoneIds.push(entry.id);
      milestonePaths.push(entry.path);
    } else if (kind === 'task') {
      if (!tasksOn) continue;
      taskIds.push(entry.id);
      taskPaths.push(entry.path);
    }
  }

  const byQuarter = new Map(); // quarter → { ids, paths }
  const decisionEntries = decisionsOn ? decisions.listFragments(cwd).filter(e => !e.bucket) : [];
  for (const entry of decisionEntries) {
    if (!isFinalized(cwd, entry.unitId, opts)) continue;
    const q = deriveQuarter(entry.unitId, opts.writtenAtFor ? opts.writtenAtFor(entry.unitId) : undefined);
    if (!isClosedQuarter(q, now)) continue;
    if (!byQuarter.has(q)) byQuarter.set(q, { ids: [], paths: [] });
    const g = byQuarter.get(q);
    g.ids.push(entry.unitId);
    g.paths.push(entry.path);
  }

  return { milestoneIds, milestonePaths, taskIds, taskPaths, byQuarter };
}

// ── _restoreBackups / _removeTargets (internal, abort path) ──────────────────
function _restoreBackups(backups) {
  for (const src of backups) {
    const bak = src + '.bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, src);
    }
  }
}

// _backupTargetIfExists — REVIEW-FIX (S04 review-fix, MAJOR/data-loss): a
// rollup target may already hold prior consolidated data from an earlier
// runBaseline. Before it gets overwritten this run, snapshot it to
// `target + '.bak'` so an abort can RESTORE prior data instead of deleting
// it. Fresh targets (no pre-existing content) get no backup — there is
// nothing prior to lose for them, so abort just unlinks them (as before).
function _backupTargetIfExists(target, targetBackups) {
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, target + '.bak');
    targetBackups.push(target);
  }
}

// _restoreOrRemoveTargets — abort path for targets written this run.
// A target that HAD a pre-existing backup (prior data) is RESTORED from its
// `.bak`, never deleted — this is the fix for the data-loss objection.
// A target CREATED fresh this run (no prior backup) is unlinked, same as
// before: nothing pre-existing to lose.
function _restoreOrRemoveTargets(paths, targetBackupsSet) {
  for (const t of paths) {
    try {
      if (targetBackupsSet.has(t)) {
        fs.copyFileSync(t + '.bak', t);
        try { fs.unlinkSync(t + '.bak'); } catch { /* noop */ }
      } else {
        fs.unlinkSync(t);
      }
    } catch { /* noop — may never have been written */ }
  }
}

// ── stampBucketSchema ────────────────────────────────────────────────────────
// Upgrade-only write of .gsd/SCHEMA-VERSION to BUCKET_SCHEMA ('fragment-store@
// 2.0.0'). Never clobbers an already-valid 2.0.0 stamp (idempotent/anti-
// downgrade — mirrors the pattern in forge-doctor.js --fix). Absent or a
// 1.0.0 stamp is elevated to 2.0.0. Called only from runBaseline's success
// step, after the byte-identical projection check — never in dry-run, never
// when nothing was actually consolidated.
function stampBucketSchema(cwd) {
  const gsdDir = path.join(cwd, '.gsd');
  if (!fs.existsSync(gsdDir)) fs.mkdirSync(gsdDir, { recursive: true });
  const schemaPath = path.join(gsdDir, 'SCHEMA-VERSION');
  if (fs.existsSync(schemaPath)) {
    const current = fs.readFileSync(schemaPath, 'utf8').trim();
    if (current === BUCKET_SCHEMA) return; // already at 2.0.0 — no clobber
  }
  writeAtomic(schemaPath, BUCKET_SCHEMA + '\n');
}

// ── runBaseline ───────────────────────────────────────────────────────────────
// opts may inject { now, dryRun, _forceMismatch, activeIds, writtenAtFor } —
// the last two pass through to isFinalized/_gatherEligibility for tests.
// _forceMismatch is test-only: forces the abort+restore path deterministically.
function runBaseline(cwd, opts) {
  opts = opts || {};
  const now = opts.now;
  const elig = _gatherEligibility(cwd, opts);
  const quarters = Array.from(elig.byQuarter.keys()).sort(); // bytewise (default string sort)

  const milestonesTarget = _milestonesTarget(cwd);
  const tasksTarget = _tasksTarget(cwd);

  if (opts.dryRun) {
    return {
      dryRun: true,
      milestones: { count: elig.milestoneIds.length, target: milestonesTarget, unitIds: elig.milestoneIds },
      tasks: { count: elig.taskIds.length, target: tasksTarget, unitIds: elig.taskIds },
      ledgerDecisions: {
        perQuarter: quarters.map(q => ({
          quarter: q,
          count: elig.byQuarter.get(q).ids.length,
          target: _decisionsTarget(cwd, q),
        })),
        closedQuarterCount: quarters.reduce((sum, q) => sum + elig.byQuarter.get(q).ids.length, 0),
      },
    };
  }

  // (a) snapshot pre-consolidation projection.
  const before = { ledger: renderLedger(cwd), decisions: renderDecisions(cwd) };

  const allSourcePaths = [...elig.milestonePaths, ...elig.taskPaths];
  for (const q of quarters) allSourcePaths.push(...elig.byQuarter.get(q).paths);

  // (b) .bak every source loose fragment BEFORE anything is written/deleted.
  const backups = [];
  for (const src of allSourcePaths) {
    fs.copyFileSync(src, src + '.bak');
    backups.push(src);
  }

  const writtenTargets = [];
  // REVIEW-FIX (S04 review-fix, MAJOR/data-loss): targets that ALREADY held
  // prior consolidated data get backed up before being overwritten, so an
  // abort restores them instead of deleting them (see _restoreOrRemoveTargets).
  const targetBackups = [];
  let milestonesResult = { target: milestonesTarget, unitIds: [] };
  let tasksResult = { target: tasksTarget, unitIds: [] };
  const ledgerDecisionsResult = { perQuarter: [] };

  try {
    // (c) consolidate each axis. Each target is snapshotted (if pre-existing)
    // immediately before its overwrite.
    if (elig.milestonePaths.length > 0) {
      _backupTargetIfExists(milestonesTarget, targetBackups);
      milestonesResult = consolidateAxis(cwd, {
        units: elig.milestonePaths, target: milestonesTarget, type: 'ledger', invalidate: ledger._invalidateBucketCache,
      });
      writtenTargets.push(milestonesTarget);
    }
    if (elig.taskPaths.length > 0) {
      _backupTargetIfExists(tasksTarget, targetBackups);
      tasksResult = consolidateAxis(cwd, {
        units: elig.taskPaths, target: tasksTarget, type: 'ledger', invalidate: ledger._invalidateBucketCache,
      });
      writtenTargets.push(tasksTarget);
    }
    for (const q of quarters) {
      const g = elig.byQuarter.get(q);
      const target = _decisionsTarget(cwd, q);
      _backupTargetIfExists(target, targetBackups);
      const r = consolidateAxis(cwd, {
        units: g.paths, target, type: 'decisions', invalidate: decisions._invalidateBucketCache,
      });
      ledgerDecisionsResult.perQuarter.push({ quarter: q, target, unitIds: r.unitIds });
      writtenTargets.push(target);
    }

    // (d) delete the consumed loose source fragments — only after every
    // bucket write above succeeded.
    for (const src of allSourcePaths) {
      fs.unlinkSync(src);
    }

    // (e) invalidate both stores' bucket caches.
    ledger._invalidateBucketCache(cwd);
    decisions._invalidateBucketCache(cwd);

    // (f) post-consolidation projection — must be byte-identical to `before`.
    const after = { ledger: renderLedger(cwd), decisions: renderDecisions(cwd) };

    if (opts._forceMismatch || after.ledger !== before.ledger || after.decisions !== before.decisions) {
      throw new Error(
        'runBaseline: projection mismatch detected after consolidation — aborting and restoring from .bak. '
        + `ledgerMatch=${after.ledger === before.ledger} decisionsMatch=${after.decisions === before.decisions}`
      );
    }

    // (g) success — remove the target .bak snapshots now that the new
    // content is committed. A stale target .bak left on disk could be
    // wrongly restored-from by a FUTURE run's abort path (it would no
    // longer correspond to that future run's own pre-write state).
    for (const t of targetBackups) {
      try { fs.unlinkSync(t + '.bak'); } catch { /* noop */ }
    }

    // (h) opt-in schema bump — only when this run actually wrote a target.
    if (writtenTargets.length > 0) {
      stampBucketSchema(cwd);
    }

    return {
      applied: true,
      milestones: milestonesResult,
      tasks: tasksResult,
      ledgerDecisions: ledgerDecisionsResult,
      verified: true,
    };
  } catch (e) {
    // Abort path: restore every source from its .bak, restore-or-remove any
    // bucket written this run (restore if it held prior data, remove if it
    // was fresh), and re-invalidate caches — no data loss regardless of
    // which step failed (mismatch, or an earlier consolidateAxis/unlink
    // error). Idempotent: restoring an untouched source is a no-op overwrite.
    _restoreBackups(backups);
    _restoreOrRemoveTargets(writtenTargets, new Set(targetBackups));
    ledger._invalidateBucketCache(cwd);
    decisions._invalidateBucketCache(cwd);
    throw e;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--baseline') out.baseline = true;
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log([
    'forge-maintenance-baseline — finalized predicate, triggers, and consolidation',
    '',
    'Usage:',
    '  node forge-maintenance-baseline.js --dry-run [--cwd <dir>]',
    '  node forge-maintenance-baseline.js --baseline [--cwd <dir>]',
    '  node forge-maintenance-baseline.js --help',
  ].join('\n'));
}

function cliMain(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  const cwd = args.cwd || process.cwd();

  if (args.dryRun) {
    console.log(JSON.stringify(runBaseline(cwd, { dryRun: true })));
    return 0;
  }

  if (args.baseline) {
    try {
      const result = runBaseline(cwd, {});
      console.log(JSON.stringify(result));
      return 0;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      return 1;
    }
  }

  process.stderr.write('Error: no command given. Use --dry-run, --baseline, or --help\n');
  return 2;
}

module.exports = {
  isFinalized,
  deriveQuarter,
  currentQuarter,
  isClosedQuarter,
  detectTriggers,
  consolidateAxis,
  runBaseline,
  stampBucketSchema,
  BUCKET_SCHEMA,
  MILESTONE_THRESHOLD,
  TASK_THRESHOLD,
  DECISIONS_THRESHOLD,
};

if (require.main === module) {
  process.exit(cliMain(process.argv.slice(2)));
}
