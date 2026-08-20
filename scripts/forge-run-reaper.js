#!/usr/bin/env node
'use strict';
//
// forge-run-reaper — opportunistic, REVERSIBLE recovery of abandoned runs.
//
// Why this exists (PR #110, D13.2 + medium #3). Two measurements forced it:
//
//   1. `forge-filelock.js` stopped letting age steal a lock from a LIVE holder (liveness is now the
//      authorization; the clock is the named last resort). That removed the only crash-recovery the
//      byte-level layer had — a crashed owner's run stays `active: true` forever and would fence
//      every neighbour permanently.
//   2. `runs.cleanupStale` — the GC that was believed to cap the damage at ~30 min — has ZERO
//      production callers, and the one loop that looked like a reaper
//      (`skills/forge-auto/SKILL.md:157`) was a bash syntax error and never ran.
//
// So the recovery path is named, not implicit. Its shape is deliberately the one already proven in
// `forge-resource-pool.reapStale` + its opportunistic invocation: no daemon, no cron, no new clock.
// The contender who was already going to wait pays the cost.
//
// REAPING IS DEACTIVATION, NEVER DELETION. `active: false` is reversible — a resume flips it back
// and re-claims before dispatching (step 1.7). That reversibility is precisely why this may ship
// here while giving `cleanupStale` (which DELETES the RunRecord) a production caller stays out of
// scope (D15): an over-eager delete destroys a run someone planned to resume.
//
// A run that HOLDS A CLAIM never passes through here. Claims have their own release ladder
// (`forge-claim-release.js`), which since #2(c) refuses to release by TTL while the claimed paths
// are dirty. `last_heartbeat` cannot tell paused from dead (D4) — and that is exactly why it only
// governs the case where there is no dirty claimed tree to protect.

const fs = require('fs');
const path = require('path');
const runs = require('./forge-runs.js');
const { isHeld } = require('./forge-write-claim.js');

// == forge-prefs.schema.json parallelism.orphan_run_ms.default. Not a new constant: it is the same
// 30 min already documented in forge-runs.js:29, re-aimed at a REVERSIBLE action.
const DEFAULT_THRESHOLD_MS = 1800000;

const LIVENESS_STATES = ['live', 'expired', 'holds-claim', 'unmeasured'];
const LIVENESS_REASONS = [
  'heartbeat-fresh',        // live — measured recent
  'heartbeat-expired',      // expired — measured beyond the threshold
  'claim-present',          // holds-claim — the claim ladder owns this run, not the clock
  'run-inactive',           // unmeasured — already deactivated; nothing to reap
  'heartbeat-absent',       // unmeasured — could not ask
  'heartbeat-not-a-number', // unmeasured — could not ask
  // unmeasured — the record was gone by the time we went to write it (or was never a record).
  // Reachable BOTH from `classifyRunLiveness(null)` and from the race in `reapOrphanRuns`.
  'record-absent',
  'excluded',               // unmeasured — caller's own run, never reaped by itself
  // The census said `expired`, but the record read INSIDE the lock no longer says so: the target
  // bumped its heartbeat or wrote a claim between the census and the write. The mutator aborts and
  // this is the named outcome. It is NOT `record-absent` — the record is right there and readable;
  // what changed is the answer, and collapsing the two would hide a live run being spared behind a
  // reason that says "the file vanished".
  'reclassified-under-lock',
];

/**
 * ONE record, ONE fact each. Closed sets both ways, in the mould of
 * `forge-claim-audit.classifyActivity` — the form is copied, not reinvented.
 *
 * `unmeasured` is never collapsed into "dead": a question that could not be asked keeps the run.
 */
function classifyRunLiveness(record, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const thresholdMs = typeof o.thresholdMs === 'number' && o.thresholdMs > 0
    ? o.thresholdMs : DEFAULT_THRESHOLD_MS;

  if (!record || typeof record !== 'object') return { state: 'unmeasured', reason: 'record-absent' };
  if (Array.isArray(o.exclude) && o.exclude.includes(record.id)) {
    return { state: 'unmeasured', reason: 'excluded' };
  }
  // Only an ACTIVE run is reapable. An inactive one is already where reaping would put it.
  if (record.active !== true) return { state: 'unmeasured', reason: 'run-inactive' };

  // The claim gate follows the canonical ownership accessor. A released claim remains persisted
  // as evidence, but no longer represents possession; only an effectively held claim takes this
  // run out of the clock's jurisdiction.
  if (isHeld(record.write_claim)) {
    return { state: 'holds-claim', reason: 'claim-present' };
  }

  const beat = record.last_heartbeat;
  if (beat === undefined || beat === null) return { state: 'unmeasured', reason: 'heartbeat-absent' };
  const n = Number(beat);
  if (!Number.isFinite(n)) return { state: 'unmeasured', reason: 'heartbeat-not-a-number' };

  const age_ms = now - n;
  return age_ms > thresholdMs
    ? { state: 'expired', reason: 'heartbeat-expired', age_ms }
    : { state: 'live', reason: 'heartbeat-fresh', age_ms };
}

function emitEvent(cwd, payload) {
  try {
    const file = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    if (!fs.existsSync(path.dirname(file))) return false;
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch (_) { return false; }
}

/**
 * Sweep the registry once. Best-effort by contract: the caller wraps it in try/catch and an
 * unreapable registry must never bring down the evaluation that invoked it.
 *
 * The census is ALWAYS returned in full, including when it is empty — silence is indistinguishable
 * from a broken detector, and this repo has paid for that confusion more than once. `skipped` and
 * `unparseable` are ENUMERATIONS, never terms of an equation: `examined` counts parsed + unparseable
 * so a record that could not be read cannot vanish before the count.
 */
function reapOrphanRuns(cwd, opts) {
  const o = opts || {};
  const detailed = runs.listAllDetailed(cwd);
  const out = {
    ok: true,
    reaped: [],
    examined: detailed.parsed.length + detailed.unparseable.length,
    skipped: [],
    unparseable: detailed.unparseable.map((u) => ({ id: u.id, reason: u.reason })),
  };

  for (const record of detailed.parsed) {
    const c = classifyRunLiveness(record, o);
    if (!LIVENESS_STATES.includes(c.state)) {
      throw new Error(`forge-run-reaper: estado fora de LIVENESS_STATES: ${JSON.stringify(c.state)}`);
    }
    if (!LIVENESS_REASONS.includes(c.reason)) {
      throw new Error(`forge-run-reaper: razão fora de LIVENESS_REASONS: ${JSON.stringify(c.reason)}`);
    }
    if (c.state !== 'expired') {
      out.skipped.push({ id: record.id, state: c.state, reason: c.reason });
      continue;
    }
    // Deactivate. NEVER `runs.remove` — the file stays on disk so a resume can flip it back.
    //
    // The classification above came from a snapshot taken BEFORE the lock. Applying it
    // unconditionally is a read-modify-write ACROSS the lock — the exact window `updateWith` exists
    // to close (`forge-runs.js:285`). A target that bumps its heartbeat or writes a `write_claim` in
    // that window would be deactivated while LIVE or while HOLDING A CLAIM, violating the two
    // guarantees this module exists to sustain. So the mutator RE-ASKS `classifyRunLiveness` over
    // the record read inside the lock and aborts unless it is still `expired`. Abort is a
    // first-class outcome of `updateWith` (`updated: false`), not an error.
    //
    // `updateWith` THROWS when the record is gone (it does not return `updated: false` for that —
    // that outcome is reserved for a mutator that aborts). Without this catch a run removed between
    // the census and the write aborts the whole sweep and LOSES the reaps already done, and the
    // `record-absent` skip below is unreachable — a declared reason nothing can produce.
    let res = null;
    let recheck = null;
    try {
      res = runs.updateWith(cwd, record.id, (fresh) => {
        recheck = classifyRunLiveness(fresh, o);
        if (recheck.state !== 'expired') return null; // ABORT — the world changed under us
        return { active: false };
      });
    } catch (_) { res = null; }
    if (res && res.updated !== true && recheck) {
      // The mutator ran and refused. A DIFFERENT fact from `record-absent`: name it, and carry the
      // fresh verdict so the census says WHY the run was spared.
      out.skipped.push({
        id: record.id,
        state: recheck.state,
        reason: 'reclassified-under-lock',
        recheck: { state: recheck.state, reason: recheck.reason },
      });
      continue;
    }
    if (!res || res.updated !== true) {
      out.skipped.push({ id: record.id, state: 'unmeasured', reason: 'record-absent' });
      continue;
    }
    const entry = { id: record.id, reason: c.reason, age_ms: c.age_ms };
    out.reaped.push(entry);
    emitEvent(cwd, {
      event: 'run-orphan-reaped',
      ts: new Date().toISOString(),
      run: record.id,
      reason: c.reason,
      age_ms: c.age_ms,
    });
  }
  return out;
}

const USAGE = [
  'uso: node scripts/forge-run-reaper.js [--reap] [--threshold-ms <n>] [--cwd <dir>] [--json]',
  '',
  '  --reap            desativa (NUNCA deleta) toda run ativa, sem claim, com heartbeat além do limiar',
  '  --threshold-ms    limiar em ms (default: parallelism.orphan_run_ms = 1800000)',
  '  --json            censo completo em JSON',
  '',
  'Advisory: exit 0 sempre. O censo é sempre emitido, inclusive vazio.',
].join('\n');

function cliMain() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
  }
  if (args.help || !args.reap) { process.stdout.write(`${USAGE}\n`); return 0; }
  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();
  let out;
  try {
    out = reapOrphanRuns(cwd, {
      thresholdMs: args['threshold-ms'] !== undefined ? Number(args['threshold-ms']) : undefined,
    });
  } catch (e) {
    out = { ok: false, error: e.message, reaped: [], examined: 0, skipped: [], unparseable: [] };
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`reaped: ${out.reaped.length} de ${out.examined} examinadas\n`);
    process.stdout.write(`censo: ${out.skipped.length} puladas, ${out.unparseable.length} ilegíveis\n`);
    for (const r of out.reaped) process.stdout.write(`  ⤫ ${r.id} — ${r.reason} (${r.age_ms}ms)\n`);
    for (const u of out.unparseable) process.stdout.write(`  ? ${u.id} — ${u.reason}\n`);
  }
  return 0; // advisory, always
}

if (require.main === module) process.exit(cliMain());

module.exports = {
  DEFAULT_THRESHOLD_MS,
  LIVENESS_STATES,
  LIVENESS_REASONS,
  classifyRunLiveness,
  reapOrphanRuns,
  USAGE,
};
