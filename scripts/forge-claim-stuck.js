#!/usr/bin/env node
'use strict';
//
// forge-claim-stuck — READ-ONLY census of active runs the reaper can NEVER reach.
//
// ── Why this exists (issue #120) ────────────────────────────────────────────
//
// `forge-filelock.js` made liveness the authorization: a holder classified `live` never loses the
// lock to age. The crash recovery that removed was MOVED, not deleted, to `forge-run-reaper.js` —
// which converts a crashed owner from live to ended before the clock reaches it.
//
// But the reaper, BY DECISION, never touches a run that holds a claim (`holds-claim` /
// `claim-present`): claims have their own release ladder (`forge-claim-release.js`), and
// `last_heartbeat` cannot tell paused from dead. That decision is defensible and stays. What it
// leaves behind is a state with no automatic exit:
//
//   run A claims paths and crashes -> `active: true` stays on disk -> `classifyHolder` reads it as
//   `live` -> `acquireFileLock` refuses every contender -> the reaper sees the claim and skips ->
//   nothing converts A to `ended`. The only way out is a human running `/forge-pause <run>`.
//
// The issue names the minimum acceptable step, and this module is exactly that step and NOT ONE
// LINE MORE: make the state LEGIBLE without deciding the policy. Enumerating the stuck runs is what
// turns a recurring `Bloqueado:` with no root cause into a named fact an operator can act on — and
// it is also what produces the data that decides, later, between "extend the reaper", "grace
// anchored on deactivation" and "do nothing".
//
// ── What this module REFUSES to do, by decision and not for lack of time ────
//
// It does not deactivate, reap, release, pause, or mutate ANY run. It does not decide policy, does
// not rank runs, does not suggest which one to kill. It has no write path at all: the only
// filesystem verbs in this file are read verbs. A future plan that grows a mutation here is wrong
// however reasonable it looks from the diagnosis — the reversible mutation already has a home
// (`forge-run-reaper.js`) and the release ladder has another (`forge-claim-release.js`). The suite
// asserts the absence rather than describing it.
//
// ── The counterfactual, instead of a second clock ───────────────────────────
//
// `classifyRunLiveness` short-circuits at `holds-claim` BEFORE it ever looks at the heartbeat, so
// it cannot tell a stuck run from a healthy claim holder. The obvious fix — re-parse
// `last_heartbeat` here against the same threshold — would fork the clock: two modules deciding
// "expired" with two copies of the rule, free to drift on the next edit.
//
// So the age question is put BACK to the reaper, on a shallow copy with the claim removed:
//
//     classifyRunLiveness({ ...record, write_claim: null }, opts)
//
// which asks, literally, "what would you say about this run if it were not holding a claim?".
// `expired` means the claim is the ONLY thing keeping the run alive — the exact population issue
// #120 is about. One clock, one threshold, one parsing rule, and the output is directly readable as
// the counterfactual it is.
//
// ── Anti-silence floor ─────────────────────────────────────────────────────
//
// `clean` is an ASSERTION ABOUT WORK PERFORMED — "I classified these records and none is stuck".
// A census that emits it having classified NOTHING (no registry, every record unparseable) reports
// its own inactivity as good news, and that report is byte-for-byte indistinguishable from a broken
// detector. This repository has re-learned that invariant more than once (`forge-overlap.js`,
// `forge-claim-audit.js`'s `pairs_compared === 0`), so here it is structural:
//
//     runs_classified === 0   ->  inconclusive   (BEFORE anything else)
//     stuck.length > 0        ->  stuck
//     otherwise               ->  clean
//
// A claim holder whose heartbeat cannot be READ (absent, NaN) is equally unreachable by the reaper,
// but "beyond the threshold" cannot be ASSERTED about it. It goes to its own enumerated bucket with
// the reaper's own reason — never merged into `stuck` (which would claim a measurement nobody made)
// and never dropped (which would hide a run in exactly the state this module exists to surface).

const path = require('path');
const runs = require('./forge-runs.js');
const { classifyRunLiveness, DEFAULT_THRESHOLD_MS } = require('./forge-run-reaper.js');

// Closed set, both directions. `stuck` and `clean` are verdicts about a census that RAN;
// `inconclusive` is the floor above.
const VERDICTS = ['stuck', 'clean', 'inconclusive'];

// Why a run holding a claim is NOT reported as stuck. Enumerated so a skip can never be silent.
const SKIP_REASONS = [
  'no-claim',            // the reaper can already reach this run; not our population
  'run-inactive',        // already where deactivation would put it
  'record-absent',       // classifier could not see a record
  'heartbeat-fresh',     // claim holder, but alive by the clock — nothing stuck about it
];

// Why a claim holder could not be measured against the threshold. Names come from
// `forge-run-reaper.LIVENESS_REASONS` — same vocabulary, never a parallel one.
const UNMEASURED_REASONS = ['heartbeat-absent', 'heartbeat-not-a-number'];

/**
 * Is this claim still holding, or was it already released?
 *
 * A release PRESERVES the claim object and appends a `released` envelope onto it
 * (`forge-write-claim.js` — "reading a cleared run and a released run must never look the same").
 * `classifyRunLiveness` does not make that distinction: any non-null `write_claim` is
 * `holds-claim`. So a run whose claim was legitimately released and which then went silent is
 * ALSO unreachable by the reaper — with nothing left to protect.
 *
 * That difference is the single most decision-relevant fact this census can carry, because the
 * remedy the issue floats first ("extend the reaper when the claimed tree is clean") is precisely
 * about runs with nothing to protect. Reporting it is diagnosis; acting on it is not this module.
 *
 * A claim of unexpected SHAPE (not an object, or an unreadable `released`) reads as `live`. That
 * direction is deliberate: `released` is the state that says "nothing left to protect", so guessing
 * it from a shape we could not parse would understate the risk of the very run we are reporting.
 */
function claimState(claim) {
  if (!claim || typeof claim !== 'object') return { state: 'live', released_at: null, mechanism: null };
  const released = claim.released;
  if (!released || typeof released !== 'object') {
    return { state: 'live', released_at: null, mechanism: null };
  }
  return {
    state: 'released',
    released_at: typeof released.at === 'number' ? released.at : null,
    mechanism: typeof released.mechanism === 'string' ? released.mechanism : null,
  };
}

/**
 * One record, one fact. Returns either a `stuck` entry, an `unmeasured` entry, or a `skip` — never
 * more than one, never none.
 */
function classifyStuck(record, opts) {
  const o = opts || {};
  const verdict = classifyRunLiveness(record, o);

  // Not a claim holder: whatever the reaper said about it, this census has nothing to add. The
  // reaper's own reason is carried through so the skip is readable without a second lookup.
  if (verdict.state !== 'holds-claim') {
    const reason = verdict.reason === 'run-inactive' ? 'run-inactive'
      : verdict.reason === 'record-absent' ? 'record-absent'
        : 'no-claim';
    return { kind: 'skip', reason };
  }

  // THE COUNTERFACTUAL. Same module, same threshold, same parsing — the claim is the only thing
  // taken away. See the header: this is deliberately not a second clock.
  const withoutClaim = classifyRunLiveness({ ...record, write_claim: null }, o);

  if (withoutClaim.state === 'live') return { kind: 'skip', reason: 'heartbeat-fresh' };

  if (withoutClaim.state !== 'expired') {
    // `unmeasured` — the question could not be asked. Named, never collapsed into either direction.
    return {
      kind: 'unmeasured',
      reason: UNMEASURED_REASONS.includes(withoutClaim.reason) ? withoutClaim.reason : 'heartbeat-absent',
      claim: claimState(record.write_claim),
    };
  }

  const claim = record.write_claim;
  const c = claimState(claim);
  return {
    kind: 'stuck',
    age_ms: withoutClaim.age_ms,
    claim_state: c.state,
    released_at: c.released_at,
    release_mechanism: c.mechanism,
    claim_at: claim && typeof claim.at === 'number' ? claim.at : null,
    claim_unit: claim && claim.unit !== undefined ? claim.unit : null,
    code_dir: claim && claim.code_dir !== undefined ? claim.code_dir : null,
    claimed_paths: claim && Array.isArray(claim.paths) ? claim.paths.length : null,
  };
}

/**
 * Sweep the registry once, read-only.
 *
 * The census is ALWAYS returned in full, including empty. `unparseable` records are COUNTED in
 * `runs_examined` and ENUMERATED — a record that could not be read must never vanish before the
 * count (the `listAllDetailed` contract, PR #110 finding 3).
 */
function findStuckClaims(cwd, opts) {
  const o = opts || {};
  const thresholdMs = typeof o.thresholdMs === 'number' && o.thresholdMs > 0
    ? o.thresholdMs : DEFAULT_THRESHOLD_MS;
  const classifyOpts = { thresholdMs, now: typeof o.now === 'number' ? o.now : Date.now() };

  const detailed = runs.listAllDetailed(cwd);
  const out = {
    ok: true,
    verdict: 'inconclusive',
    threshold_ms: thresholdMs,
    stuck: [],
    unmeasured: [],
    census: {
      runs_examined: detailed.parsed.length + detailed.unparseable.length,
      runs_classified: 0,
      claim_holders: 0,
      skipped: [],
      unparseable: detailed.unparseable.map((u) => ({ id: u.id, reason: u.reason })),
    },
  };

  for (const record of detailed.parsed) {
    out.census.runs_classified += 1;
    const c = classifyStuck(record, classifyOpts);
    // `claim_holders` counts the population this census is ABOUT — every record the reaper
    // classified as `holds-claim`, whatever we then concluded about its clock. A fresh holder is
    // part of that population and is counted; a run with no claim never is.
    if (c.kind !== 'skip' || c.reason === 'heartbeat-fresh') out.census.claim_holders += 1;

    if (c.kind === 'skip') {
      if (!SKIP_REASONS.includes(c.reason)) {
        throw new Error(`forge-claim-stuck: razão fora de SKIP_REASONS: ${JSON.stringify(c.reason)}`);
      }
      out.census.skipped.push({ id: record.id, reason: c.reason });
      continue;
    }
    if (c.kind === 'unmeasured') {
      out.unmeasured.push({ id: record.id, reason: c.reason, claim_state: c.claim.state });
      continue;
    }
    const { kind, ...entry } = c;
    out.stuck.push({ id: record.id, ...entry });
  }

  // THE FLOOR, before anything else. See the header.
  if (out.census.runs_classified === 0) out.verdict = 'inconclusive';
  else if (out.stuck.length > 0) out.verdict = 'stuck';
  else out.verdict = 'clean';

  if (!VERDICTS.includes(out.verdict)) {
    throw new Error(`forge-claim-stuck: veredito fora de VERDICTS: ${JSON.stringify(out.verdict)}`);
  }
  return out;
}

/**
 * Human-readable rendering. Emitted for ALL THREE verdicts, `clean` included — a section that only
 * appears when there is bad news is indistinguishable from a detector that stopped running.
 */
function formatStuck(result) {
  const r = result || {};
  const census = r.census || {};
  const lines = [];

  if (r.verdict === 'inconclusive') {
    lines.push('forge-claim-stuck: inconclusivo — nenhuma run classificada '
      + `(${census.runs_examined || 0} examinada(s), ${(census.unparseable || []).length} ilegível(is)).`);
  } else if (r.verdict === 'clean') {
    lines.push(`forge-claim-stuck: 0 runs travadas — ${census.runs_classified} classificada(s), `
      + `${census.claim_holders} com claim.`);
  } else {
    lines.push(`forge-claim-stuck: ${r.stuck.length} run(s) fora do alcance do reaper `
      + `— ${census.runs_classified} classificada(s), ${census.claim_holders} com claim.`);
    for (const s of r.stuck) {
      const mins = Math.floor((s.age_ms || 0) / 60000);
      const claimNote = s.claim_state === 'released'
        ? `claim JÁ LIBERADO (${s.release_mechanism || 'mecanismo n/a'}) — nada a proteger`
        : 'claim ativo';
      lines.push(`    - ${s.id} — heartbeat parado há ~${mins} min, ${claimNote}`
        + `${s.claimed_paths === null ? '' : `, ${s.claimed_paths} path(s) reivindicado(s)`}`);
    }
    lines.push('    Saída hoje é humana: /forge-pause <run> desativa a run e libera o filelock.');
  }

  for (const u of r.unmeasured || []) {
    lines.push(`    ? ${u.id} — com claim, mas o heartbeat não pôde ser lido (${u.reason})`);
  }
  for (const u of census.unparseable || []) {
    lines.push(`    ? ${u.id} — registro ilegível (${u.reason})`);
  }
  return lines.join('\n');
}

const USAGE = [
  'uso: node scripts/forge-claim-stuck.js [--cwd <dir>] [--threshold-ms <n>] [--json]',
  '',
  '  Enumera runs ATIVAS que seguram um claim e cujo heartbeat já passou do limiar —',
  '  a população que o forge-run-reaper nunca alcança (holds-claim/claim-present).',
  '',
  '  --threshold-ms    limiar em ms (default: o mesmo do reaper, 1800000)',
  '  --json            censo completo em JSON',
  '',
  'READ-ONLY e advisory: nunca desativa, libera ou altera run alguma; exit 0 sempre.',
  'O censo é sempre emitido, inclusive vazio.',
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
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();
  let out;
  try {
    out = findStuckClaims(cwd, {
      thresholdMs: args['threshold-ms'] !== undefined ? Number(args['threshold-ms']) : undefined,
    });
  } catch (e) {
    out = {
      ok: false,
      error: e.message,
      verdict: 'inconclusive',
      stuck: [],
      unmeasured: [],
      census: { runs_examined: 0, runs_classified: 0, claim_holders: 0, skipped: [], unparseable: [] },
    };
  }
  if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else process.stdout.write(`${formatStuck(out)}\n`);
  return 0; // advisory, always
}

if (require.main === module) process.exit(cliMain());

module.exports = {
  VERDICTS,
  SKIP_REASONS,
  UNMEASURED_REASONS,
  claimState,
  classifyStuck,
  findStuckClaims,
  formatStuck,
  USAGE,
};
