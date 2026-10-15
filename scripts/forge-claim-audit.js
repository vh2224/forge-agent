#!/usr/bin/env node
// forge-claim-audit — cross-run File Audit CORE: what a unit actually WROTE
// (VCS delta, S02) confronted against what ANOTHER run CLAIMED (S03), with a
// reconciling census, a closed verdict set and an anti-silence floor.
//
// ── Why this module exists (IN-8, D4) ──────────────────────────────────────
//
// `work-lost` is today NARRATION: a line a model wrote about itself. The whole
// point of this file is that the finding becomes produced by an artifact the
// model does NOT author. That is the TASK-021 lesson already paid for in this
// repository — the harness printed the correct hint and the session's prose
// overwrote it, and a whole slice routed 4/4 to the wrong engine while the log
// said so. So the detector derives from the VCS and from recorded claims, and
// the section (T02) is emitted by code, unconditionally.
//
// ── The locked boundary (inherited verbatim from forge-claim-overlap.js) ───
//
// THIS MODULE SIGNALS. It does not sequence runs, it does not gate a dispatch,
// it does not block a merge, it does not suggest who merges first, it does not
// persist a queue and it performs no speculative integration. Those together
// are an integration pipeline — a whole product — out of scope BY DECISION,
// not for lack of time. A plan that grows this file in that direction is wrong
// however elegant it looks from here. The suite asserts `exit 0` by SPAWNING
// the CLI, never by claiming it in a comment.
//
// ── Why the floor precedes every other branch ──────────────────────────────
//
//     pairs_compared === 0   ->  inconclusive     (BEFORE anything else)
//     findings.length > 0    ->  overlap
//     otherwise              ->  clean
//
// `clean` is an ASSERTION ABOUT WORK PERFORMED — "I confronted these pairs and
// found no collision". A comparator that emits it having confronted nothing
// reports its own inactivity as good news, and that report is byte-for-byte
// indistinguishable from a broken detector. This repository has re-learned the
// invariant three times (`forge-overlap.js`, S02's `units_measured === 0`,
// S03's `pairs_compared === 0`); here it is STRUCTURAL — the zero case cannot
// reach `clean`, and the suite forces a zero-comparison case over a NON-EMPTY
// universe rather than merely describing the rule.
//
// ── Composition, never reimplementation ────────────────────────────────────
//
//   written side      forge-unit-delta.writtenByUnit / unitKeyFor   (D6: VCS)
//   declared side     forge-write-coverage.declaredFor / discoverCorpus
//   claimed side      forge-claim-overlap.collectRunClaims / claimsConflict
//                     / codeDirScope   +  the `claim-gate` lines of events.jsonl
//   JSONL reading     forge-review-pairing.readEvents
//
// D6 is not a preference: the source of the WRITTEN side is the VCS, never the
// per-tool activity log — that equivalence was REFUTED BY MEASUREMENT in S02.
// No line of this module reads that log as the source of what was written, and
// the suite proves the absence by scanning this source with comments stripped,
// WITH a positive control (the scanner finds the word when it is planted).
//
// The intra-slice predicate of `forge-parallelism` (the one whose polarity says
// "empty list = no conflict") is likewise NOT imported and NOT referenced: that
// polarity is correct intra-slice and FORBIDDEN cross-run by D1, because
// absence of declaration is never evidence of safety. Only the glob ALGEBRA is
// reused, reached through `forge-claim-overlap.claimsConflict`.
//
// ── Posture ────────────────────────────────────────────────────────────────
//
// Advisory, and its writes are exactly two, both its own (T02): the
// `## File Audit (cross-run)` section of the target SUMMARY, and one appended
// `work-lost` line per finding. `auditClaims` itself stays read-only, which the
// suite proves by
// SHA-256 of every `.gsd/forge/runs/<run-id>.json`, of `events.jsonl` and of the
// (the glob is spelled out on purpose: a `slash-star` inside a line comment
// opens a phantom block comment for the source scanner of the suite, which
// would swallow the requires below and blind the D6/D1 guards — measured, and
// the reason the suite carries an anti-blindness floor over the same scan)
// target SUMMARY, before and after a full run.
//
// CLI:
//   node forge-claim-audit.js --slice S07 --milestone M-… [--cwd <dir>]
//                             [--code-dir <dir>] [--run <id>] [--json]
//                             [--write <SUMMARY>]

'use strict';

const fs = require('fs');
const path = require('path');

const { writtenByUnit, unitKeyFor } = require('./forge-unit-delta.js');
const { discoverCorpus, declaredFor } = require('./forge-write-coverage.js');
const {
  collectRunClaims, claimsConflict, codeDirScope, CONFLICT_CAUSES,
} = require('./forge-claim-overlap.js');
const { readEvents } = require('./forge-review-pairing.js');
const runs = require('./forge-runs.js');

// ── Verdicts ───────────────────────────────────────────────────────────────
//
// Closed set. `compareClaimAudit` may return nothing outside this list: an
// unlisted verdict string sails through every `===` a caller writes and reads
// as "nothing found", i.e. as silence.
const VERDICTS = ['overlap', 'clean', 'inconclusive'];

// ── Claim sources ──────────────────────────────────────────────────────────
//
// The two NAMED sources of the claimed side. They are distinct on purpose:
// a claim is EPHEMERAL UNTIL THE COMMIT (D2/S05), so at `complete-slice` time
// the registry may legitimately carry nothing while the history still does.
// A source that contributed ZERO appears NAMED with `contributed: 0` — never
// absent, because an absent row is indistinguishable from a source nobody
// consulted.
const CLAIM_SOURCES = [
  'run-registry', // live `write_claim` of every registered run (`collectRunClaims`), scoped to the same CODE_DIR by `codeDirScope` (D2).
  'gate-events',  // `claim-gate` lines of `.gsd/forge/events.jsonl`; their `counterparts[].paths` SURVIVE the release of the claim (D2/S05).
];

// ── Finding groups (triage of the milestone, 2026-08-16) ───────────────────
//
// Running this detector over the real corpus of this repository produced 45
// findings, ALL `undeclared-writes`, ALL against runs that wrote before the
// claim existed. They are TRUE — those runs did write those paths without ever
// recording a claim. What they are not is ACTIONABLE: the counterpart run is
// over, and there is nobody left to coordinate with.
//
// The temptation is a filter. The operator refused it, and the reasoning is the
// thesis of this whole module: a section that prints 45 identical rows every
// time is a section people stop reading, and a detector nobody reads is
// indistinguishable from a broken one — the exact defect of origin. But so is
// dropping rows. So NOTHING is filtered, NOTHING is thresholded and NOTHING is
// hidden: the findings are PARTITIONED into two named groups, both rendered,
// both counted, and the census reconciles by arithmetic equality
// (`findings === findings_actionable + findings_historical`).
const FINDING_GROUPS = [
  'actionable',  // the counterpart may still be writing, OR its state could not be measured. Rendered first, and the ONLY group that emits `work-lost`.
  'historical',  // MEASURED as ended: the counterpart run is recorded `active: false`. Rendered, counted, never dropped — and never an incident.
];

// ── Counterpart activity — a MEASUREMENT, never a heuristic ────────────────
//
// The classification reads ONE recorded fact: the `active` field of the
// counterpart's `RunRecord`, written by the run lifecycle itself. It does not
// infer liveness from a timestamp, from an id's date, from whether the work
// "looks merged", nor from any other shape-of-the-data guess dressed as a
// measurement. Where the fact CANNOT be read — the counterpart is not in the
// registry, or its record never carried the field — the answer is `unmeasured`,
// and `unmeasured` groups with `actionable`. Ambiguity fails toward BEING SEEN,
// never toward the inert bucket: the same polarity as D1 one level down.
const COUNTERPART_ACTIVITY = ['live', 'ended', 'unmeasured'];

const ACTIVITY_REASONS = [
  'registry-active',       // the counterpart's `RunRecord` records `active: true`. Measured.
  'registry-inactive',     // the counterpart's `RunRecord` records `active: false`. Measured — the ONLY route into `historical`.
  'run-not-registered',    // no `RunRecord` for this counterpart id (pruned registry, or a counterpart known only through a historical `claim-gate` line). Unmeasured → stays visible.
  'activity-not-recorded', // a record exists but carries no boolean `active` (a record predating the field, or malformed). Unmeasured → stays visible.
];

/** Seam: an activity outside the closed set is LOUD, never a silent bucket. */
function groupOf(activity) {
  if (!COUNTERPART_ACTIVITY.includes(activity)) {
    throw new Error(`forge-claim-audit: atividade fora de COUNTERPART_ACTIVITY: ${activity}`);
  }
  // Only a MEASURED end is inert. `live` and `unmeasured` both stay visible.
  return activity === 'ended' ? 'historical' : 'actionable';
}

/**
 * Classify ONE counterpart from its `RunRecord` (or its absence). Pure — the
 * caller owns the registry read, so this stays testable without disk.
 */
function classifyActivity(record) {
  if (!record || typeof record !== 'object') {
    return { activity: 'unmeasured', activity_reason: 'run-not-registered' };
  }
  if (record.active === true) return { activity: 'live', activity_reason: 'registry-active' };
  if (record.active === false) return { activity: 'ended', activity_reason: 'registry-inactive' };
  return { activity: 'unmeasured', activity_reason: 'activity-not-recorded' };
}

/**
 * Read the activity a collector STAMPED on a claim row. A row that carries no
 * stamp at all (a hand-built input, a collector that could not reach the
 * registry) is `unmeasured` — never assumed inert. A stamp from OUTSIDE either
 * closed set THROWS: a bogus value that quietly became `historical` would
 * suppress a real incident, which is the one failure this partition must not
 * be able to produce.
 */
function activityOf(claim) {
  const a = claim && claim.activity;
  if (a === undefined || a === null) {
    return { activity: 'unmeasured', activity_reason: 'activity-not-recorded' };
  }
  if (!COUNTERPART_ACTIVITY.includes(a)) {
    throw new Error(`forge-claim-audit: atividade fora de COUNTERPART_ACTIVITY: ${a}`);
  }
  const r = claim.activity_reason;
  if (!ACTIVITY_REASONS.includes(r)) {
    throw new Error(`forge-claim-audit: razão fora de ACTIVITY_REASONS: ${r}`);
  }
  return { activity: a, activity_reason: r };
}

// ── Skip kinds ─────────────────────────────────────────────────────────────
//
// Which census equation a skip belongs to. The census reconciles by ARITHMETIC
// EQUALITY per kind, so a skip filed under the wrong kind breaks a test rather
// than quietly unbalancing a total.
const AUDIT_SKIP_KINDS = ['unit', 'claim-source', 'pair', 'collector'];

// ── Skip reasons ───────────────────────────────────────────────────────────
//
// Closed set, crossed BOTH WAYS by the suite (every reason this code emits is
// listed; every listed entry is emitted by >= 1 test). A value from outside
// the set is LOUD at the seam — it throws — instead of becoming an unlabelled
// string in the census that a downstream `includes` reads as absence. Same
// mould as `CONFLICT_CAUSES`/`CLAIM_NOTE_REASONS` in `forge-claim-gate.js`.
const AUDIT_SKIP_REASONS = [
  'delta-unavailable',  // kind `unit`: the VCS delta could not measure this unit. The ORIGINAL `DELTA_REASONS` value rides in `detail` — translated, never discarded.
  'no-written-files',   // kind `unit`: the unit was measured and wrote no file, so there is nothing to confront. Named, never dropped.
  'source-unavailable', // kind `claim-source`: the source could not be consulted at all (unreadable registry, unreadable log). NOT the same as a source that was read and contributed zero — that one is a named row with `contributed: 0`.
  'different-code-dir', // kind `pair`: D2 — the two sides write from DIFFERENT `code_dir`s, so identical relative paths denote different files. Pair skipped; `pairs_compared` NOT incremented.
  'same-run',           // kind `pair`: the counterpart IS the run under audit. Confronting a run with itself would manufacture a finding out of its own bookkeeping.
  'collector-failed',   // kind `collector`: a collector THREW (absent VCS, corrupt registry). The report still exists — an exception never becomes silence and never becomes a crash (S02/R2 precedent, where a reader's throw escaped the whole measurement).
  'scope-unresolved',   // kind `claim-source`: R1 — the run→milestone bridge is EMPTY, so no historical `claim-gate` line can be shown to belong to this milestone. The `claim-gate` payload carries no `milestone` field, so the registry is the ONLY bridge; empty means the fact is genuinely UNMEASURABLE. The source contributes ZERO. Admitting every historical line instead would turn an unmeasured scope into MAXIMUM permission — the exact inversion of this module's floor.
  'no-attributable-paths', // kind `pair`: R2 — the counterpart entry named no path this audit may attribute (either it carried none, or every label was COMPOSITE and ownership of the operands is not recorded). The row leaves the comparison NAMED; the previous `continue` dropped it in silence, which is the defect of origin.
];

// ── Note reasons ───────────────────────────────────────────────────────────
//
// A note is NOT a skip: the pair or unit STAYS in the comparison and the note
// records what is uncertain about it. `code-dir-unknown` in particular is
// CARRIED, never converted into a skip and never dropped — S07 transports the
// uncertainty into the census and decides no policy over it (the policy is the
// gate's, S04).
const AUDIT_NOTE_REASONS = [
  'code-dir-unknown',    // one or both sides recorded no `code_dir`. Inherited verbatim from S03 `codeDirScope`.
  'code-dir-relative',   // a side recorded a NON-ABSOLUTE `code_dir`: identity was not measured.
  'code-dir-invalid',    // a side persisted a `code_dir` that is not a string at all.
  'code-dir-unresolved', // both absolute, at least one unresolvable: the comparison degraded to lexical identity, and the degradation is named.
  'plan-legacy-schema',  // the unit's own plan carries no structured `must_haves:`, so the DECLARED side is unreadable. The unit stays compared — under D1, an unreadable declaration is not evidence of safety.
  'self-run-unknown',    // the run under audit could not be identified in the registry, so `same-run` exclusion could not be applied. Named rather than assumed harmless.
  'composite-label-ownership', // R2 — a HISTORICAL line recorded a COMPOSITE label (`a` and `b` joined by the rendering separator). Nothing in the written line preserves WHICH operand belongs to the counterpart: the label is a rendering born in `forge-claim-overlap` (`claimA.paths` × `claimB.paths`), and the positional order is an invariant of ONE implementation at ONE version, never a contract of the record — a historical line does not certify which version wrote it. So the operands are NOT attributed as counterpart claim paths (attributing them would FABRICATE overlap against this run's own files); the uncertainty is CARRIED here instead. Making the gate persist explicit operand ownership is an event-schema change, raised to the operator's final triage.
];

/** Seam: a reason from outside the closed set throws instead of leaking. */
function recordSkip(skipped, kind, id, reason, detail) {
  if (!AUDIT_SKIP_KINDS.includes(kind)) {
    throw new Error(`forge-claim-audit: kind fora de AUDIT_SKIP_KINDS: ${kind}`);
  }
  if (!AUDIT_SKIP_REASONS.includes(reason)) {
    throw new Error(`forge-claim-audit: razão fora de AUDIT_SKIP_REASONS: ${reason}`);
  }
  skipped.push({ kind, id, reason, detail: detail === undefined ? null : detail });
  return skipped;
}

/** Seam: same discipline for notes. */
function recordNote(notes, id, reason) {
  if (!AUDIT_NOTE_REASONS.includes(reason)) {
    throw new Error(`forge-claim-audit: razão fora de AUDIT_NOTE_REASONS: ${reason}`);
  }
  notes.push({ id, reason });
  return notes;
}

/** Repo-relative POSIX form, so git output and claim paths compare alike. */
function posix(p) {
  return typeof p === 'string' ? p.split('\\').join('/').replace(/^\.\//, '') : p;
}

// ── Collectors (the only code here that touches disk) ──────────────────────

/**
 * The WRITTEN side (D6): the VCS delta of S02, narrowed to this milestone/slice
 * by the COMPOSITE key `unitKeyFor` already carries. Narrowing by `S##/T##`
 * alone would collapse eleven milestones' `S04/T01` into one bucket.
 *
 * Units the delta could not measure are TRANSPORTED into `skipped[]` as
 * `delta-unavailable` carrying the original `DELTA_REASONS` value in `detail` —
 * a remainder that is renamed but never dropped.
 */
function collectWritten(cwd, opts) {
  const o = opts || {};
  const contract = o.execution_contract || o.executionContract;
  if (contract) {
    const roots = require('./forge-code-roots');
    const validated = roots.validateContract(contract, { revalidate: true });
    const rows = validated.code_roots.map(root => {
      const collected = collectWritten(cwd, { ...o, execution_contract: undefined, executionContract: undefined,
        codeDir: root.path, delta: o.deltasByRoot?.[root.id] });
      return { ...collected, units: collected.units.map(unit => ({ ...unit,
        files: unit.files.map(file => roots.qualified(roots.resolvePath(validated, { root_id: root.id, path: file }))) })) };
    });
    return { vcs: 'multi', repo: validated.owner, units: rows.flatMap(row => row.units),
      skipped: rows.flatMap(row => row.skipped), refs_examined: rows.reduce((sum, row) => sum + row.refs_examined, 0) };
  }
  const repoRoot = o.codeDir || cwd;
  const delta = (o.delta) || writtenByUnit(repoRoot, o.deltaOptions || {});
  const units = [];
  const skipped = [];

  for (const u of (delta.units || [])) {
    if (u.owner !== o.milestone) continue;
    if (o.slice && u.slice !== o.slice) continue;
    const files = (u.files || []).map(posix).filter(Boolean);
    units.push({ unit: u.unit, owner: u.owner, slice: u.slice, task: u.task, files });
  }
  for (const s of (delta.skipped || [])) {
    if (s.unit !== o.milestone) continue;
    recordSkip(skipped, 'unit', s.unit, 'delta-unavailable', s.reason);
  }

  return { vcs: delta.vcs, repo: repoRoot, units, skipped, refs_examined: delta.refs_examined || 0 };
}

/**
 * The DECLARED side: `writes:` ∪ `expected_output:` of each `T##-PLAN.md`,
 * keyed by the SAME composite key as the written side. Purely an ANNOTATION on
 * a finding (D4's partial-declaration residue is exactly what this detector
 * covers); it never removes a unit from the comparison, because under D1 an
 * unreadable declaration is not evidence of safety.
 */
function collectDeclared(cwd, opts) {
  const o = opts || {};
  const corpus = o.corpus || discoverCorpus(cwd);
  const byUnit = new Map();
  const notes = [];

  for (const unit of (corpus.units || [])) {
    if (unit.owner !== o.milestone) continue;
    if (o.slice && unit.slice !== o.slice) continue;
    const d = declaredFor(cwd, unit);
    if (d.legacy) recordNote(notes, unit.unit, 'plan-legacy-schema');
    byUnit.set(unit.unit, (d.declared || []).map(posix));
  }
  return { byUnit, notes, plans_seen: byUnit.size };
}

/**
 * `id -> RunRecord` for the WHOLE registry — the single disk read behind the
 * activity measurement. An unreadable registry yields an EMPTY map, and an
 * empty map makes every counterpart `run-not-registered`, i.e. `unmeasured`,
 * i.e. VISIBLE. A failure to measure can therefore never mute a finding.
 */
function runRecordsById(cwd) {
  const byId = new Map();
  let records = [];
  try { records = runs.listAll(cwd); } catch { records = []; }
  for (const rec of records) {
    if (rec && typeof rec.id === 'string') byId.set(rec.id, rec);
  }
  return byId;
}

/** Every run id that belongs to this milestone (own id, or `milestone_dir`). */
function runIdsForMilestone(cwd, milestone) {
  const ids = new Set();
  let records = [];
  try { records = runs.listAll(cwd); } catch { records = []; }
  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string') continue;
    const dirId = typeof rec.milestone_dir === 'string'
      ? (rec.milestone_dir.split('/').filter(Boolean).pop() || null)
      : null;
    if (rec.id === milestone || dirId === milestone) ids.add(rec.id);
  }
  return ids;
}

/**
 * The CLAIMED side, from BOTH named sources — and both are reported even when
 * one contributes nothing.
 *
 * `gate-events` exists because of D2/S05: the live claim is released at commit
 * time, so at `complete-slice` the registry can be legitimately empty while the
 * `counterparts[].paths` recorded in the history still name the collision. A
 * finding reachable ONLY through the history must still be found — the suite
 * proves exactly that case.
 *
 * A NON-composite label recorded by S03 is read as a claimed path — both sides
 * named that same file, so the attribution is safe. A COMPOSITE label is NOT
 * split into counterpart paths: re-deriving the BYTES is reading S03's record,
 * but re-deriving the OWNERSHIP is inventing it (R2). The uncertainty is
 * carried as `composite-label-ownership` and the row leaves the comparison
 * NAMED, never in silence.
 */
function collectClaims(cwd, opts) {
  const o = opts || {};
  const claims = [];
  const skipped = [];
  const notes = [];
  const sources = [];
  const selfRun = o.run || null;
  // ONE registry read for both sources, so a counterpart reached through the
  // history is measured by exactly the same fact as one reached live.
  const recordsById = o.runRecords || runRecordsById(cwd);
  const activityFor = (id) => classifyActivity(recordsById.get(id));

  // (1) run-registry — live claims.
  let registryContributed = 0;
  let runsExamined = 0;
  try {
    const collected = o.collected || collectRunClaims(cwd, { all: true });
    runsExamined = collected.runs_examined || 0;
    for (const c of collected.comparable) {
      if (selfRun && c.id === selfRun) {
        recordSkip(skipped, 'pair', c.id, 'same-run', 'run sob auditoria');
        continue;
      }
      claims.push({
        run: c.id,
        source: 'run-registry',
        paths: ((c.claim && c.claim.paths) || []).map(posix),
        claim: c.claim,
        scope_source: 'code-dir',
        scope: null,
        note: null,
        ...activityFor(c.id),
      });
      registryContributed += 1;
    }
    sources.push({ source: 'run-registry', consulted: true, contributed: registryContributed, runs_examined: runsExamined });
  } catch (e) {
    recordSkip(skipped, 'claim-source', 'run-registry', 'source-unavailable', (e && e.message) || String(e));
    sources.push({ source: 'run-registry', consulted: false, contributed: 0, runs_examined: 0 });
  }

  // (2) gate-events — historical claims that survive the release.
  let eventContributed = 0;
  let eventsSeen = 0;
  let eventsInScope = 0;
  try {
    const file = o.eventsFile || path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    const events = o.events || readEvents(file);
    const scopeIds = o.scopeRunIds || runIdsForMilestone(cwd, o.milestone);
    // R1 — a scope that could not be MEASURED is not maximum permission.
    // `claim-gate` lines carry no `milestone` field, so the run registry is the
    // ONLY run→milestone bridge. An empty bridge (unreadable registry, runs
    // never registered or already pruned) means pertinence is UNMEASURABLE, and
    // the rest of this module treats absence of measurement as non-evidence —
    // that is literally the thesis of the `inconclusive` floor. Admitting every
    // historical line here would invert it, manufacturing findings AND writing
    // false `work-lost` lines to disk, which are permanent.
    if (scopeIds.size === 0) {
      recordSkip(skipped, 'claim-source', 'gate-events', 'scope-unresolved',
        'nenhuma run desta milestone no registry: a pertinência das linhas históricas é imedível');
      sources.push({ source: 'gate-events', consulted: false, contributed: 0, events_seen: 0, events_in_scope: 0 });
      if (!selfRun) recordNote(notes, '(self)', 'self-run-unknown');
      return { claims, sources, skipped, notes };
    }
    for (const ev of events) {
      if (!ev || ev.event !== 'claim-gate') continue;
      eventsSeen += 1;
      // The query boundary: only lines emitted by a run of THIS milestone. This
      // is the scope of the question, not a discarded remainder — the census
      // reports both counts so the narrowing stays visible.
      if (!scopeIds.has(ev.run)) continue;
      eventsInScope += 1;
      for (const cp of (ev.counterparts || [])) {
        if (!cp || typeof cp.id !== 'string') continue;
        if (selfRun && cp.id === selfRun) {
          recordSkip(skipped, 'pair', cp.id, 'same-run', 'contraparte é a run sob auditoria');
          continue;
        }
        // R2 — a NON-composite label stays attributable (the path was claimed
        // by both sides, so it names a real file of the counterpart). A
        // COMPOSITE one does not: see `composite-label-ownership`.
        const paths = [];
        let composite = 0;
        for (const raw of (cp.paths || [])) {
          const parts = String(raw).split(' × ').map((s) => posix(s.trim())).filter(Boolean);
          const distinct = parts.filter((p, ix) => parts.indexOf(p) === ix);
          if (distinct.length > 1) { composite += 1; continue; }
          const p = distinct[0];
          if (p && !paths.includes(p)) paths.push(p);
        }
        if (composite > 0) recordNote(notes, cp.id, 'composite-label-ownership');
        if (paths.length === 0) {
          // NOT a silent `continue`. The row leaves the comparison NAMED, so a
          // counterpart dropped for lack of attributable paths is countable in
          // the census instead of vanishing through the back door.
          recordSkip(skipped, 'pair', cp.id, 'no-attributable-paths',
            composite > 0
              ? `${composite} rótulo(s) composto(s): propriedade do operando não registrada`
              : 'a contraparte não nomeou caminho algum');
          continue;
        }
        claims.push({
          run: cp.id,
          source: 'gate-events',
          paths,
          claim: { paths, code_dir: null },
          // The event already recorded the measured scope, so the audit reads
          // it rather than re-deriving an identity from a `code_dir` the line
          // never carried.
          scope_source: 'event',
          scope: cp.scope === 'same' ? 'same' : 'unknown',
          note: AUDIT_NOTE_REASONS.includes(cp.note) ? cp.note : (cp.scope === 'same' ? null : 'code-dir-unknown'),
          // A counterpart named only by the history is very often absent from
          // the registry — `run-not-registered`, hence VISIBLE.
          ...activityFor(cp.id),
        });
        eventContributed += 1;
      }
    }
    sources.push({ source: 'gate-events', consulted: true, contributed: eventContributed, events_seen: eventsSeen, events_in_scope: eventsInScope });
  } catch (e) {
    recordSkip(skipped, 'claim-source', 'gate-events', 'source-unavailable', (e && e.message) || String(e));
    sources.push({ source: 'gate-events', consulted: false, contributed: 0, events_seen: 0, events_in_scope: 0 });
  }

  if (!selfRun) recordNote(notes, '(self)', 'self-run-unknown');

  return { claims, sources, skipped, notes };
}

// ── The pure core ──────────────────────────────────────────────────────────

/**
 * Confront every (written unit × claim of another run) pair. PURE: no disk, no
 * registry, no git — everything it needs is in `input`, which is what makes the
 * floor directly testable without a fixture.
 *
 * `pairs_compared` is incremented INSIDE the loop, once per pair actually
 * walked — never computed as `n*m` on the side. A counter derived from a
 * formula stays correct while the loop it describes fails to run: the same lie
 * in a smaller font.
 */
function compareClaimAudit(input) {
  const i = input || {};
  const codeDir = i.code_dir || null;
  const written = (i.written && i.written.units) || [];
  const claims = (i.claims && i.claims.claims) || [];
  const declaredBy = (i.declared && i.declared.byUnit) || new Map();

  const skipped = []
    .concat((i.written && i.written.skipped) || [])
    .concat((i.declared && i.declared.skipped) || [])
    .concat((i.claims && i.claims.skipped) || [])
    .concat(i.skipped || []);
  const notes = []
    .concat((i.declared && i.declared.notes) || [])
    .concat((i.claims && i.claims.notes) || [])
    .concat(i.notes || []);

  const findings = [];
  let pairs_compared = 0;
  let units_compared = 0;
  // Distinct written paths that entered the comparison. T02's `clean` sentence
  // is an ASSERTION ABOUT WORK PERFORMED, and "N pairs" alone does not say over
  // how much surface: two runs and one file is a different claim from two runs
  // and four hundred. Counted from the units actually walked, never derived.
  const pathsSeen = new Set();

  for (const unit of written) {
    if (!unit.files || unit.files.length === 0) {
      recordSkip(skipped, 'unit', unit.unit, 'no-written-files', 'delta mediu a unidade e ela não escreveu arquivo');
      continue;
    }
    units_compared += 1;
    for (const f of unit.files) pathsSeen.add(f);
    const declared = declaredBy instanceof Map ? (declaredBy.get(unit.unit) || null) : (declaredBy[unit.unit] || null);

    for (const c of claims) {
      const pairId = `${unit.unit} × ${c.run}`;

      // Scope (D2). Two provenances, one decision: an event carries the scope
      // S03 already measured; a registry claim is measured here by S03's own
      // `codeDirScope`. Neither invents an identity.
      let scope;
      let note;
      if (c.scope_source === 'event') {
        scope = c.scope;
        note = c.note;
      } else {
        const s = codeDirScope(i.execution_contract ? { schema_version: 2, execution_contract: i.execution_contract, paths: unit.files } : { code_dir: codeDir }, c.claim || {});
        scope = s.scope;
        note = s.note;
      }
      // The note is recorded BEFORE the skip branch and independently of it —
      // a degraded comparison that ends in `different` still degraded. It is
      // CARRIED to the pair and never converted into a skip (S07 transports
      // the uncertainty; the policy over it belongs to the gate, S04).
      if (note) recordNote(notes, pairId, note);
      if (scope === 'different') {
        recordSkip(skipped, 'pair', pairId, 'different-code-dir', 'D2: árvores distintas, caminhos iguais nomeiam arquivos distintos');
        continue;
      }

      pairs_compared += 1;

      const hit = claimsConflict({ paths: unit.files, code_dir: codeDir,
        ...(i.execution_contract ? { schema_version: 2, execution_contract: i.execution_contract } : {}) }, c.claim);
      if (!hit) continue;
      // S03 owns this set; a cause it grows without teaching this audit must be
      // loud, never silently read as "no conflict" by an `===` below.
      if (!CONFLICT_CAUSES.includes(hit.cause)) {
        throw new Error(`forge-claim-audit: causa fora de CONFLICT_CAUSES: ${hit.cause}`);
      }
      const act = activityOf(c);
      findings.push({
        unit: unit.unit,
        counterpart_run: c.run,
        claim_source: c.source,
        cause: hit.cause,
        paths: hit.paths,
        note: note || null,
        declared_by_own_plan: declared === null ? null : hit.paths.some((p) => declared.includes(p.split(' × ')[0])),
        counterpart_activity: act.activity,
        activity_reason: act.activity_reason,
        group: groupOf(act.activity),
      });
    }
  }

  // Actionable rows FIRST, then historical — a stable, total order (the group
  // rank breaks ties before the existing key, never instead of it). This is
  // PRESENTATION ORDER, not selection: both groups are rendered in full.
  const rank = (f) => (f.group === 'actionable' ? 0 : 1);
  findings.sort((a, b) => (rank(a) - rank(b))
    || (`${a.unit}|${a.counterpart_run}`).localeCompare(`${b.unit}|${b.counterpart_run}`));

  const actionable = findings.filter((f) => f.group === 'actionable');
  const historical = findings.filter((f) => f.group === 'historical');

  const unitSkips = skipped.filter((s) => s.kind === 'unit').length;
  const sources = (i.claims && i.claims.sources) || [];
  const contributing = sources.filter((s) => s.contributed > 0).length;

  // ── The floor. FIRST, always. See the module header. ──────────────────────
  let verdict;
  let reason;
  if (pairs_compared === 0) {
    verdict = 'inconclusive';
    reason = `${units_compared} unidade(s) com escrita e ${claims.length} claim(s), 0 par(es) confrontado(s)`;
  } else if (findings.length > 0) {
    // The verdict does NOT soften when every finding is historical. The
    // findings are TRUE; the partition governs how they are read, never
    // whether they exist. Reporting `clean` over 45 true findings would be the
    // silent filter the operator refused — the failure this design forbids.
    verdict = 'overlap';
    reason = `${findings.length} achado(s) em ${pairs_compared} par(es) confrontado(s)`
      + ` — ${actionable.length} acionável(is), ${historical.length} histórico(s)`;
  } else {
    verdict = 'clean';
    reason = `${pairs_compared} par(es) confrontado(s), nenhuma colisão`;
  }

  return {
    verdict,
    reason,
    milestone: i.milestone || null,
    slice: i.slice || null,
    code_dir: codeDir,
    census: {
      units_examined: units_compared + unitSkips,
      units_compared,
      // R3 — the number of sources EXAMINED is the number of source rows, full
      // stop. A source that failed is ALREADY one of those rows, named, with
      // `consulted: false`; adding its skip on top counted it twice and broke
      // the very equality this census claims to reconcile (2 sources, 1 failing
      // → `examined 3` while `contributing 1 + skips 1 = 2`). The skip stays as
      // ENUMERATION — it names WHY the row contributed nothing — never as a
      // term of the equation. Claiming more examination than happened is the
      // same lie in a smaller font as computing `pairs_compared` as `n*m`.
      claim_sources_examined: sources.length,
      claim_sources_contributing: contributing,
      claims_considered: claims.length,
      pairs_compared,
      paths_compared: pathsSeen.size,
      findings: findings.length,
      // The partition reconciles by ARITHMETIC EQUALITY:
      //   findings === findings_actionable + findings_historical
      // Both terms are counted from the walked findings, never derived from a
      // formula — a counter computed on the side stays correct while the loop
      // it describes fails to run (the same lie in a smaller font).
      findings_actionable: actionable.length,
      findings_historical: historical.length,
      skipped: skipped.length,
    },
    claim_sources: sources,
    findings,
    skipped,
    notes,
  };
}

/**
 * Orchestrate the collectors and the pure core. Every collector is wrapped:
 * a throw becomes a NAMED `collector-failed` skip and the report still exists.
 * An exception here never becomes silence and never becomes a crash.
 */
function auditClaims(options) {
  const o = options || {};
  const cwd = path.resolve(o.cwd || process.cwd());
  const codeDir = o.codeDir ? path.resolve(o.codeDir) : cwd;
  const c = o.collectors || {};
  const skipped = [];

  const run = (fn, name, fallback) => {
    try {
      return fn();
    } catch (e) {
      recordSkip(skipped, 'collector', name, 'collector-failed', (e && e.message) || String(e));
      return fallback;
    }
  };

  const written = run(
    () => (c.written || collectWritten)(cwd, { ...o, codeDir }),
    'written', { units: [], skipped: [] },
  );
  const declared = run(
    () => (c.declared || collectDeclared)(cwd, o),
    'declared', { byUnit: new Map(), notes: [] },
  );
  const claims = run(
    () => (c.claims || collectClaims)(cwd, { ...o, codeDir }),
    'claims', { claims: [], sources: [], skipped: [], notes: [] },
  );

  return compareClaimAudit({
    execution_contract: o.execution_contract || o.executionContract,
    milestone: o.milestone || null,
    slice: o.slice || null,
    code_dir: codeDir,
    written,
    declared,
    claims,
    skipped,
  });
}

/** Human-readable rendering. The reason rides on the first line for EVERY
 * verdict, `inconclusive` included: a mute `inconclusive` repeats one level up
 * the very defect this module exists to close. */
function formatClaimAudit(result) {
  const cs = result.census;
  const lines = [];
  lines.push(`forge-claim-audit: ${result.verdict} — ${result.reason}`);
  lines.push(
    `  censo: units ${cs.units_compared}/${cs.units_examined}`
    + ` · fontes ${cs.claim_sources_contributing}/${cs.claim_sources_examined}`
    + ` · claims ${cs.claims_considered} · pares ${cs.pairs_compared}`
    + ` · achados ${cs.findings} (acionáveis ${cs.findings_actionable}, históricos ${cs.findings_historical})`
    + ` · skipped ${cs.skipped}`,
  );
  for (const s of result.claim_sources) {
    lines.push(`  · fonte ${s.source}: contribuiu ${s.contributed}`);
  }
  for (const f of result.findings) {
    // Two markers, one list: the historical rows are never dropped and never
    // collapsed into a count — they are simply not shouted at.
    const mark = f.group === 'actionable' ? '⚠' : '·';
    lines.push(`  ${mark} [${f.group}/${f.counterpart_activity}] ${f.unit} × ${f.counterpart_run} — ${f.cause} (${f.claim_source}): ${f.paths.join(', ') || '(nada declarado)'}`);
  }
  for (const s of result.skipped) {
    lines.push(`  · fora da comparação [${s.kind}]: ${s.id} (${s.reason})`);
  }
  for (const n of result.notes) {
    lines.push(`  · nota: ${n.id} (${n.reason})`);
  }
  return lines.join('\n');
}

// ── The section, written BY CODE and UNCONDITIONALLY ───────────────────────
//
// The heading is `## File Audit (cross-run)`, anchored on its own literal and
// therefore DISJOINT from the intra-slice `## File Audit` that sub-step 1.6
// owns: `^## File Audit\r?$` cannot match this one and this one cannot match
// that one. Two neighbouring sections, two owners, neither overwriting the
// other — asserted in both directions by the suite.
//
// Emitted for ALL THREE verdicts, `clean` included. The instruction this
// replaces ("if both are empty, omit the section entirely") is the origin
// defect: an omitted section is byte-for-byte indistinguishable from a detector
// that never ran. A clean section therefore does not merely exist — it STATES
// THE WORK PERFORMED ("confrontei N pares sobre M caminhos"), which is a claim
// a broken detector cannot make.
const AUDIT_SECTION_HEADING = '## File Audit (cross-run)';
const AUDIT_SECTION_ANCHOR = /^## File Audit \(cross-run\)\r?$/m;

function formatClaimAuditMd(result) {
  const cs = result.census;
  const lines = [
    AUDIT_SECTION_HEADING,
    '',
    '_Advisory — o que esta slice ESCREVEU (delta de VCS) confrontado com o que OUTRA run CLAIMOU. Sinaliza; não ordena runs, não bloqueia merge, não sugere quem mergeia primeiro._',
    '',
  ];
  // Verdict + reason first, census second — the same two-line contract as the
  // human rendering, so `inconclusive` can never be read as a quiet pass.
  lines.push(`- Veredicto: **${result.verdict}** — ${result.reason}.`);
  lines.push(
    `- Censo: units ${cs.units_compared}/${cs.units_examined}`
    + ` · fontes ${cs.claim_sources_contributing}/${cs.claim_sources_examined}`
    + ` · claims ${cs.claims_considered} · pares ${cs.pairs_compared}`
    + ` · caminhos ${cs.paths_compared} · achados ${cs.findings}`
    + ` (acionáveis ${cs.findings_actionable}, históricos ${cs.findings_historical})`
    + ` · skipped ${cs.skipped}.`,
  );

  if (result.verdict === 'overlap') {
    const row = (f) => {
      const paths = f.paths.length ? f.paths.map((p) => `\`${p}\``).join(', ') : '(nenhum caminho nomeado)';
      const declared = f.declared_by_own_plan === null
        ? 'declaração do próprio plano ilegível'
        : (f.declared_by_own_plan ? 'declarado no próprio plano' : 'NÃO declarado no próprio plano');
      const mark = f.group === 'actionable' ? '⚠' : '·';
      lines.push(`- ${mark} \`${f.unit}\` × run \`${f.counterpart_run}\` — ${f.cause} (fonte: ${f.claim_source}): ${paths} — ${declared} — contraparte ${f.counterpart_activity} (${f.activity_reason}).`);
      if (f.note) lines.push(`  - nota: ${f.note} (incerteza transportada, não resolvida aqui).`);
    };
    const actionable = result.findings.filter((f) => f.group === 'actionable');
    const historical = result.findings.filter((f) => f.group === 'historical');

    // Both groups get a heading line NAMING their count, and both are listed in
    // full. Nothing is filtered, nothing is thresholded, nothing is collapsed
    // into "and N more" — a row a reader cannot see is a row that was dropped.
    lines.push(`- **Acionáveis (${actionable.length})** — contraparte viva, ou cujo estado não pôde ser medido (a ambiguidade fica VISÍVEL):`);
    if (actionable.length === 0) lines.push('  - nenhum.');
    for (const f of actionable) row(f);

    lines.push(`- **Históricos/inertes (${historical.length})** — contraparte MEDIDA como encerrada (\`active: false\` no registry): o achado é verdadeiro e não é acionável. Listado, contado, nunca filtrado; não emite incidente \`work-lost\`:`);
    if (historical.length === 0) lines.push('  - nenhum.');
    for (const f of historical) row(f);
  } else if (result.verdict === 'clean') {
    lines.push(`- Confrontei ${cs.pairs_compared} par(es) sobre ${cs.paths_compared} caminho(s) escrito(s) e não achei colisão.`);
  } else {
    lines.push(`- Inconclusivo: ${result.reason}. Não é uma afirmação de limpeza — nenhum par foi confrontado, então nada foi verificado.`);
  }

  for (const s of result.claim_sources) {
    lines.push(`- Fonte \`${s.source}\`: consultada=${s.consulted}, contribuiu ${s.contributed}.`);
  }
  // Every discarded row surfaces with its reason. A census that reconciles but
  // does not enumerate is a gate that counts without naming.
  for (const s of result.skipped) {
    lines.push(`- Fora da comparação [${s.kind}]: \`${s.id}\` — ${s.reason}${s.detail ? ` (${s.detail})` : ''}.`);
  }
  for (const n of result.notes) {
    lines.push(`- Nota: \`${n.id}\` — ${n.reason}.`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Upsert the section into a SUMMARY. Mould: `forge-route-audit.upsertRouteSection`
 * — no second section-writing mechanism enters this repo.
 *
 * Three NAMED refusals, and on each of them the target keeps its bytes: a write
 * that cannot be proven safe does not happen partially and does not happen
 * quietly somewhere else.
 */
function upsertClaimAuditSection(summaryPath, md, cwd) {
  try {
    if (!fs.existsSync(summaryPath)) return { written: false, reason: 'target-missing' };
    const stat = fs.lstatSync(summaryPath);
    if (stat.isSymbolicLink()) return { written: false, reason: 'target-symlink' };
    const root = fs.realpathSync(path.resolve(cwd || process.cwd(), '.gsd'));
    const realParent = fs.realpathSync(path.dirname(summaryPath));
    const target = path.resolve(realParent, path.basename(summaryPath));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { written: false, reason: 'outside-gsd' };

    // Operate on the ORIGINAL bytes. Normalizing the whole file would rewrite
    // line endings in sections this tool does not own; only the injected
    // section is normalized, and it adopts the file's own convention.
    const current = fs.readFileSync(summaryPath, 'utf8');
    const crlf = /\r\n/.test(current);
    const eol = crlf ? '\r\n' : '\n';
    const section = md.replace(/\r\n/g, '\n').replace(/\n*$/, '\n').replace(/\n/g, eol);

    let next;
    const hit = AUDIT_SECTION_ANCHOR.exec(current);
    if (hit) {
      const tail = current.slice(hit.index + hit[0].length);
      const nextHeader = /^## /m.exec(tail);
      const end = nextHeader ? hit.index + hit[0].length + nextHeader.index : current.length;
      next = current.slice(0, hit.index) + section + (nextHeader ? `${eol}${current.slice(end)}` : '');
    } else {
      const anchors = [/^## Checker Memory/m, /^## ⚠ Review Flags/m, /^## Security Flags/m, /^## Forward Intelligence/m, /^## Drill/m];
      const anchor = anchors.map((re) => re.exec(current)).find(Boolean);
      next = anchor
        ? current.slice(0, anchor.index).replace(/[\r\n]*$/, eol + eol) + section + eol + current.slice(anchor.index)
        : current.replace(/[\r\n]*$/, eol + eol) + section;
    }
    if (next !== current) fs.writeFileSync(summaryPath, next, 'utf8');
    return { written: true, reason: null };
  } catch (error) { return { written: false, reason: error.code || error.message }; }
}

// ── The event, written BY CODE ─────────────────────────────────────────────
//
// Why the event name did NOT change (SCOPE open question (e)): `work-lost`
// already names this fact in the histories that exist, and renaming it would
// orphan every historical line — the reader would have to know both names to
// see one phenomenon. The legibility of the narrated lines is kept; what is
// added is the ability to TELL THEM APART, through an ADDITIVE marker. An old
// reader ignoring the two keys stays correct; a new one can say whether the
// line was measured by a detector or written by a model about itself.
const WORK_LOST_EMITTER = 'forge-claim-audit';
const WORK_LOST_ORIGINS = ['code', 'narrated'];

/**
 * Classify one `work-lost` line. Accepts the raw JSON string or the parsed
 * object. Closed set `{ code, narrated }`; a line that is not `work-lost` at
 * all is LOUD here rather than silently bucketed as narrated.
 */
function originOf(line) {
  let ev = line;
  if (typeof line === 'string') {
    try { ev = JSON.parse(line); } catch (e) {
      throw new Error(`forge-claim-audit: linha work-lost ilegível: ${(e && e.message) || String(e)}`);
    }
  }
  if (!ev || typeof ev !== 'object' || ev.event !== 'work-lost') {
    throw new Error(`forge-claim-audit: originOf só classifica linhas work-lost, veio: ${ev && ev.event}`);
  }
  if (ev.origin === 'code' && ev.emitter === WORK_LOST_EMITTER) return 'code';
  // No marker: the hand-written historical form. Named, never discarded.
  return 'narrated';
}

/**
 * Append ONE `work-lost` line PER FINDING to `.gsd/forge/events.jsonl` of the
 * WORKSPACE `cwd` (never the CODE_DIR — the log lives with the artifacts).
 *
 * Field shape follows the historical narrated line verbatim (`milestone`,
 * `slice`, `unit`, `cause`, `other_run`, `files`) so both forms read alike,
 * plus the additive origin marker. Mould: `forge-claim-gate.emitGateEvent` —
 * a failure to log NEVER swallows the finding and never hides that it failed.
 */
function workLostIdentity(ev) {
  return JSON.stringify([
    ev.milestone || null, ev.slice || null, ev.unit || null, ev.other_run || null,
    ev.cause || null, (ev.files || []).slice().sort(), ev.claim_source || null, ev.origin || null,
  ]);
}

// ── Which findings become an INCIDENT ──────────────────────────────────────
//
// Only the ACTIONABLE ones — and the argument is about what the event MEANS,
// not about volume. `work-lost` is an incident feed: a line saying "someone may
// have lost work here, go look". A finding whose counterpart run is MEASURED
// as ended names no one to go look at, and no coordination is possible with a
// run that is over.
//
// The asymmetry with the section is deliberate and rests on a property of the
// two artifacts. The section is rewritten idempotently and byte-surgically, so
// carrying 45 historical rows there costs a reader some scrolling and NOTHING
// else. `events.jsonl` is append-only and PERMANENT: 45 non-incidents written
// into it are non-incidents forever, in the very feed whose job is to say
// something happened. R4's identity suppression bounds the DUPLICATION, not the
// pollution.
//
// And nothing is filtered away, because the section — the artifact whose job IS
// enumeration — carries every historical row in full, and this function REPORTS
// the suppression by name (`event_historical_suppressed`, plus the named
// `historical-only` skip), which the CLI prints on stderr. `unmeasured`
// counterparts are ACTIONABLE and therefore DO emit: an incident is never
// suppressed by a fact nobody could measure.
function emitWorkLostEvent(cwd, result) {
  const historical = result.findings.filter((f) => f.group === 'historical');
  if (result.verdict !== 'overlap' || result.findings.length === 0) {
    return {
      event_written: false, event_error: null, event_lines: 0,
      event_skipped: 'no-finding', event_historical_suppressed: 0,
    };
  }
  const actionable = result.findings.filter((f) => f.group === 'actionable');
  if (actionable.length === 0) {
    return {
      event_written: false, event_error: null, event_lines: 0,
      event_skipped: 'historical-only', event_historical_suppressed: historical.length,
    };
  }
  const file = path.join(path.resolve(cwd || process.cwd()), '.gsd', 'forge', 'events.jsonl');

  // R4 — re-running the closing (retry after `partial`, resume, manual CLI) must
  // not multiply a TRUE finding into N incidents for whoever counts them. The
  // section T02 owns is byte-surgical and idempotent for exactly this reason;
  // the event was not, and the asymmetry lives inside one task.
  //
  // This does NOT violate the append-only idiom, which forbids REWRITING and
  // DELETING — never declining to append the redundant. A line already on disk
  // with the SAME identity tuple is the same fact, and re-measuring a fact is
  // not a new occurrence. The mould (`emitGateEvent`) appends blindly because
  // there each invocation IS a distinct event: a decision taken at a dispatch.
  const seen = new Set();
  try {
    for (const ev of readEvents(file)) {
      if (ev && ev.event === 'work-lost' && originOf(ev) === 'code') seen.add(workLostIdentity(ev));
    }
  } catch { /* an unreadable log suppresses nothing: at worst we append again */ }

  // The identity tuple is UNCHANGED (R4): adding a field to it would make every
  // line already on disk stop matching, and a re-run would multiply the very
  // incidents that suppression exists to keep singular.
  const fresh = actionable.filter((f) => !seen.has(workLostIdentity({
    milestone: result.milestone, slice: result.slice, unit: f.unit, cause: f.cause,
    other_run: f.counterpart_run, files: f.paths, claim_source: f.claim_source, origin: 'code',
  })));
  if (fresh.length === 0) {
    return {
      event_written: false, event_error: null, event_lines: 0,
      event_skipped: 'already-recorded', event_historical_suppressed: historical.length,
    };
  }

  const payload = fresh.map((f) => JSON.stringify({
    ts: new Date().toISOString(),
    event: 'work-lost',
    milestone: result.milestone,
    slice: result.slice,
    unit: f.unit,
    cause: f.cause,
    other_run: f.counterpart_run,
    files: f.paths,
    claim_source: f.claim_source,
    declared_by_own_plan: f.declared_by_own_plan,
    // ADDITIVE, and OUTSIDE the identity tuple: says WHY this finding earned an
    // incident, without changing what makes two lines the same fact.
    counterpart_activity: f.counterpart_activity,
    // ADDITIVE marker — see WORK_LOST_ORIGINS above.
    origin: 'code',
    emitter: WORK_LOST_EMITTER,
  })).join('\n');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${payload}\n`, 'utf8');
    // `event_lines` reports what was ACTUALLY appended, never the finding count.
    return {
      event_written: true, event_error: null, event_lines: fresh.length,
      event_skipped: null, event_historical_suppressed: historical.length,
    };
  } catch (e) {
    return {
      event_written: false, event_error: (e && e.message) || String(e), event_lines: 0,
      event_skipped: null, event_historical_suppressed: historical.length,
    };
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-claim-audit.js --slice <S##> --milestone <id>',
  '                                       [--cwd <dir>] [--code-dir <dir>]',
  '                                       [--run <id>] [--json]',
  '                                       [--write <SUMMARY.md>]',
  '',
  'Sinal advisory cross-run: confronta o que a unidade ESCREVEU (delta de VCS)',
  'contra o que OUTRA run CLAIMOU (registry vivo + histórico claim-gate).',
  'SEMPRE sai com exit 0.',
  '',
  'Veredictos: overlap | clean | inconclusive.',
  '`clean` exige ter confrontado ao menos um par; sem par, o veredicto é',
  '`inconclusive` — nunca `clean`.',
  '',
  'Com --write, o script é o dono da seção `## File Audit (cross-run)` do SUMMARY',
'e a escreve nos TRÊS veredictos — seção omitida é indistinguível de detector',
'quebrado. Os achados saem PARTICIONADOS em acionáveis (contraparte viva ou',
'imedível) e históricos (contraparte medida como encerrada): nada é filtrado,',
'os dois grupos são listados e o censo fecha por igualdade. O evento',
'`work-lost` (origin: code) é appendado só para os ACIONÁVEIS, e a supressão',
'dos históricos é anunciada no stderr.',
].join('\n');

function parseArgs(argv) {
  const out = { slice: null, milestone: null, cwd: null, codeDir: null, run: null, write: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--slice') out.slice = argv[++i];
    else if (a === '--milestone') out.milestone = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--code-dir') out.codeDir = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--write') out.write = argv[++i];
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.milestone) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = auditClaims({
      cwd: args.cwd, codeDir: args.codeDir, milestone: args.milestone, slice: args.slice, run: args.run,
    });
    if (args.write) {
      const cwd = path.resolve(args.cwd || process.cwd());
      // The section FIRST, and unconditionally: it is written even when the
      // event fails, and even when the verdict is clean. Order matters — a
      // logging failure must never be able to suppress the finding's rendering.
      const up = upsertClaimAuditSection(path.resolve(args.write), formatClaimAuditMd(result), cwd);
      result.write = up;
      const ev = emitWorkLostEvent(cwd, result);
      Object.assign(result, ev);
      process.stderr.write(up.written
        ? `forge-claim-audit: cross-run file audit: ${args.write}\n`
        : `forge-claim-audit: refused: ${up.reason}\n`);
      if (ev.event_error) process.stderr.write(`forge-claim-audit: evento work-lost NÃO registrado: ${ev.event_error}\n`);
      // The suppression is ANNOUNCED. A partition whose inert half disappears
      // without a word is the silent filter this design exists to refuse.
      if (ev.event_historical_suppressed > 0) {
        process.stderr.write(`forge-claim-audit: ${ev.event_historical_suppressed} achado(s) histórico(s) — contraparte encerrada: listado(s) na seção, NÃO emitido(s) como incidente work-lost\n`);
      }
    }
    process.stdout.write(args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatClaimAudit(result)}\n`);
  } catch (e) {
    // Advisory: an unreadable corpus is REPORTED — loud on stderr — never fatal
    // to a caller's loop. Same posture as forge-route-audit.js / forge-overlap.js.
    process.stderr.write(`forge-claim-audit: ${(e && e.message) || String(e)}\n`);
    return 0;
  }
  // Return 0 UNCONDITIONALLY, including when `verdict === 'overlap'`. This
  // signal informs; nothing here refuses, blocks or sequences anything. Making
  // this reflect the verdict is the single edit that converts an advisory
  // detector into the integration pipeline S07 declared out of scope.
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  VERDICTS,
  CLAIM_SOURCES,
  FINDING_GROUPS,
  COUNTERPART_ACTIVITY,
  ACTIVITY_REASONS,
  groupOf,
  classifyActivity,
  activityOf,
  runRecordsById,
  AUDIT_SKIP_KINDS,
  AUDIT_SKIP_REASONS,
  AUDIT_NOTE_REASONS,
  recordSkip,
  recordNote,
  collectWritten,
  collectDeclared,
  collectClaims,
  compareClaimAudit,
  auditClaims,
  formatClaimAudit,
  formatClaimAuditMd,
  upsertClaimAuditSection,
  emitWorkLostEvent,
  originOf,
  AUDIT_SECTION_HEADING,
  AUDIT_SECTION_ANCHOR,
  WORK_LOST_EMITTER,
  WORK_LOST_ORIGINS,
  runIdsForMilestone,
  parseArgs,
  main,
  USAGE,
};
