#!/usr/bin/env node
// forge-write-claim — record/read/clear the write claim a run declares on its
// RunRecord: what it is about to write, plus the CODE_DIR it is writing from.
//
// ── Where the signal lives ──────────────────────────────────────────────────
//
// An ADDITIVE `write_claim` field on the `RunRecord`, written via
// `runs.update`. Nothing migrates: a record written before this field existed
// stays byte-identical on disk until `recordClaim` gives it a real reason to
// change. This mirrors `withAddressDefaults` (forge-runs.js) and
// `forge-touch.js` exactly, down to the one property that matters: `null`
// (never claimed) and `{ paths: [] }` (claimed, honestly empty) are DIFFERENT
// facts and must never collapse. A caller (T02) that treats them alike
// reports "nothing declared" when the honest answer is "declared and empty" —
// or vice versa — the same anti-silence defect S07/T01 already closed once.
//
// ── code_dir is a GIVEN fact, never derived ─────────────────────────────────
//
// Same precedent as `runs.add()`: "records what it is GIVEN and derives
// nothing". Deriving `code_dir` from root/branch/isolation_mode would repeat
// the defect S06 already named — a derived string names a directory that may
// not exist. Absent `--code-dir` -> `code_dir: null`, never a guess.
//
// ── Composition, not reimplementation ───────────────────────────────────────
//
//   persistence        forge-runs.get / forge-runs.update
//   path normalization forge-parallelism.normalizePath
//
// A second implementation of path normalization here would be the defect
// this module's own Standards section forbids.
//
// ── Posture ──────────────────────────────────────────────────────────────
//
// This module PERSISTS the claim's whole lifecycle — record, read, and now
// release — but never JUDGES it. Two fields are additive here (S05/T01):
//
//   vcs_baseline  the VCS state observed at claim time ({vcs, id} or null),
//                 GIVEN by the caller at record time, never re-derived later.
//   released      the envelope written when a release is granted ({at,
//                 mechanism, evidence} or null). This module does not decide
//                 WHETHER a release is warranted — `releaseClaim` writes
//                 whatever it is told. The measurement that PROVES a commit
//                 happened (two probes: baseline advanced AND paths left
//                 flight) and the TTL-as-net decision belong to
//                 `forge-claim-release.js` (T02) — this module is the write
//                 side only, same posture as `code_dir` above: it validates
//                 SHAPE at the boundary, never plausibility of content.
//
// This is the S05 update of what used to say "Coupling the claim's release
// to a commit (git or svn) and any TTL are out of scope here (IN-6/S05)" —
// that scope line described a module with no release concept at all.
// `clearClaim` remains the primitive reset it always was (unconditional
// `write_claim: null`, no envelope, no history) — it is NOT `releaseClaim`
// and must not be confused with it: `clearClaim` erases the claim outright
// (used by tests/CLI to reset fixtures); `releaseClaim` preserves the claim
// and appends the `released` envelope onto it. Reading a cleared run and a
// released run must never look the same to a caller that cares which one it
// is looking at (see `isHeld` below).
//
// CLI:
//   node forge-write-claim.js --claim <run-id> --unit <u> [--source <s>]
//                              [--code-dir <p>] [--paths <csv|json>] [--json] [--cwd <dir>]
//   node forge-write-claim.js --show  <run-id> [--json] [--cwd <dir>]
//   node forge-write-claim.js --clear <run-id> [--json] [--cwd <dir>]
//   node forge-write-claim.js --release <run-id> --mechanism <m> [--evidence <json>] [--json] [--cwd <dir>]

'use strict';

const runs = require('./forge-runs.js');
const { normalizePath } = require('./forge-parallelism.js');

// Closed set. `plan-writes` = came from a T##-PLAN.md `writes:`/`expected_output:`
// block. `review-fix-paths` = came from the `path:line` of conceded review
// items (D7, consumed in S04). `manual` = operator/CLI. A source outside this
// set must never be recorded — see `normalizeClaim` below.
const CLAIM_SOURCES = ['plan-writes', 'review-fix-paths', 'manual'];

// Closed set of release mechanisms (S05/T01). This module never corroborates
// any of them — corroboration (the two-probe commit proof, and the TTL net
// over an inactive run) is `forge-claim-release.js` (T02)'s job. A caller
// that requests a mechanism outside this set is refused, naming the closed
// set, and nothing is written.
const RELEASE_MECHANISMS = [
  // An explicit release request that T02 has ALREADY corroborated by probe
  // (baseline advanced AND paths left flight) before calling `releaseClaim`.
  // This module trusts the caller here — it does not re-run the probe.
  'explicit',
  // Same proof as `explicit`, named separately so an event/audit reader can
  // tell "release was requested and confirmed" apart from "release was
  // observed passively during a routine gate evaluation".
  'committed',
  // The TTL net (D2): the claim's owner run went inactive and the TTL+grace
  // window elapsed. Never a criterion of possession on its own — always
  // gated on run inactivity by the caller (forge-claim-release.js), never
  // by this module.
  'ttl-expired',
  // The operator's own hand, and NOTHING else (S05/review R4). The other three
  // names ASSERT A MEASUREMENT: `committed` says two probes agreed, and
  // `ttl-expired` says a window elapsed over a run measured inactive. The CLI
  // could stamp either onto an active, dirty claim without probing anything,
  // and the forged envelope then read as `persisted_mechanism` — corroboration
  // in the eyes of the gate and of the audit trail. Forging was always possible
  // (the registry is hand-editable JSON), so this is not new capability being
  // withheld; it is the official tool refusing to OFFER the lie as a flag.
  // `manual` claims no measurement, so it cannot lie. The CLI accepts this one
  // and refuses the corroborated names by name (see `main`); corroborated
  // releases route exclusively through forge-claim-release.js.
  'manual',
];

// The subset the CLI may write. Library callers (T02) keep the full set — the
// restriction is about what the OPERATOR-facing surface may assert, not about
// removing the primitive.
const CLI_RELEASE_MECHANISMS = ['manual'];

/**
 * Pure — no disk. Validates and shapes a claim input into the persisted form
 * `{ at, unit, source, code_dir, paths: [] }`.
 *
 * `unit` is carried verbatim (the "worker" grammar has THREE forms —
 * "UNIT_TYPE/UNIT_ID", null, "BATCH:<csv>" — and parsing it here would repeat
 * the defect already measured in forge-hook.js:169). `source` must belong to
 * `CLAIM_SOURCES`; anything else throws, naming both the rejected value and
 * the closed set, and nothing is written. `code_dir` is the GIVEN value —
 * absent means `null`, never derived. `paths` are normalized via the
 * imported `normalizePath` (never reimplemented), empty entries dropped,
 * order preserved.
 */
function normalizeClaim(input) {
  const opts = input || {};
  if (!CLAIM_SOURCES.includes(opts.source)) {
    throw new Error(
      `forge-write-claim: unknown source ${JSON.stringify(opts.source)} — ` +
      `must be one of ${JSON.stringify(CLAIM_SOURCES)}`);
  }
  // `code_dir` is GIVEN, never derived — but "given" is not "anything". A
  // non-string value used to be persisted verbatim (only `source` was
  // checked), and downstream `path.isAbsolute` then threw
  // ERR_INVALID_ARG_TYPE inside the comparator, where the CLI's global catch
  // turned it into exit 0 with NO verdict and NO census: one malformed record
  // silenced the comparison of every run. Validated here, at the only place
  // that writes; the read side classifies a legacy malformed value as
  // `code-dir-invalid` rather than trusting this gate retroactively.
  if (!(opts.code_dir === undefined || opts.code_dir === null || opts.code_dir === ''
        || typeof opts.code_dir === 'string')) {
    throw new Error(
      `forge-write-claim: invalid code_dir ${JSON.stringify(opts.code_dir)} ` +
      `(${typeof opts.code_dir}) — must be a non-empty string or null`);
  }
  const paths = Array.isArray(opts.paths)
    ? opts.paths.map(normalizePath).filter((p) => p !== '')
    : [];
  return {
    at: opts.at || Date.now(),
    unit: opts.unit || null,
    source: opts.source,
    // GIVEN, never derived. See module header.
    code_dir: (opts.code_dir === undefined || opts.code_dir === null || opts.code_dir === '')
      ? null : opts.code_dir,
    paths,
    vcs_baseline: normalizeVcsBaseline(opts.vcs_baseline),
    released: normalizeReleased(opts.released),
  };
}

/**
 * `undefined`/`null` -> `null`. Otherwise requires `{ vcs, id }` with
 * `vcs ∈ ['git', 'svn']` and `id` a non-empty string. Same guard posture as
 * `code_dir` above (the S03 incident where an unvalidated non-string value
 * silenced the comparator's verdict for every run): reject the shape at the
 * only place that writes, name the rejected value AND the accepted shape,
 * and write nothing.
 */
function normalizeVcsBaseline(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `forge-write-claim: invalid vcs_baseline ${JSON.stringify(input)} — ` +
      `must be null or an object shaped { vcs: 'git'|'svn', id: <non-empty string> }`);
  }
  if (input.vcs !== 'git' && input.vcs !== 'svn') {
    throw new Error(
      `forge-write-claim: invalid vcs_baseline.vcs ${JSON.stringify(input.vcs)} — ` +
      `must be one of ["git","svn"]`);
  }
  if (typeof input.id !== 'string' || input.id === '') {
    throw new Error(
      `forge-write-claim: invalid vcs_baseline.id ${JSON.stringify(input.id)} — ` +
      `must be a non-empty string`);
  }
  return { vcs: input.vcs, id: input.id };
}

/**
 * `undefined`/`null` -> `null`. Otherwise requires `{ at, mechanism,
 * evidence }` with `at` a finite number, `mechanism ∈ RELEASE_MECHANISMS`,
 * and `evidence` an object (may be `{}`). Same guard posture as
 * `vcs_baseline`/`code_dir`: reject at the write boundary, name the rejected
 * value AND the accepted shape/set, write nothing.
 */
function normalizeReleased(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `forge-write-claim: invalid released ${JSON.stringify(input)} — ` +
      `must be null or an object shaped { at: <number>, mechanism: <string>, evidence: <object> }`);
  }
  if (typeof input.at !== 'number' || !Number.isFinite(input.at)) {
    throw new Error(
      `forge-write-claim: invalid released.at ${JSON.stringify(input.at)} — must be a finite number`);
  }
  if (!RELEASE_MECHANISMS.includes(input.mechanism)) {
    throw new Error(
      `forge-write-claim: unknown released.mechanism ${JSON.stringify(input.mechanism)} — ` +
      `must be one of ${JSON.stringify(RELEASE_MECHANISMS)}`);
  }
  if (typeof input.evidence !== 'object' || input.evidence === null || Array.isArray(input.evidence)) {
    throw new Error(
      `forge-write-claim: invalid released.evidence ${JSON.stringify(input.evidence)} — must be an object (may be {})`);
  }
  return { at: input.at, mechanism: input.mechanism, evidence: input.evidence };
}

/** Derive AND persist — the ONLY function in this module that writes. */
function recordClaim(cwd, runId, input) {
  const write_claim = normalizeClaim(input);
  runs.update(cwd, runId, { write_claim });
  return write_claim;
}

/**
 * `null` for a run that was never claimed, the recorded object otherwise —
 * INCLUDING when that object says `paths: []`-shaped emptiness. The two must
 * never collapse: `null` means "nobody claimed on this run yet"; a present
 * object means "claimed, and here is the honest — possibly empty — answer".
 * Do not "simplify" this to `rec.write_claim || null` — an object with
 * `paths: []` is truthy, so `||` already behaves correctly here today, but
 * the explicit form is kept so intent survives a future shape change (same
 * reasoning as forge-touch.js::readTouched).
 */
function readClaim(rec) {
  return rec && rec.write_claim ? rec.write_claim : null;
}

/**
 * Grava `write_claim: null` — a PRIMITIVE reset, not a release protocol.
 * Unconditional erasure: whatever `vcs_baseline`/`released` history the
 * claim carried is gone. This is NOT `releaseClaim` (below) — `clearClaim`
 * exists only so tests and CLI callers can return a run to its unclaimed
 * state; a real release PRESERVES the claim and appends the `released`
 * envelope onto it.
 */
function clearClaim(cwd, runId) {
  runs.update(cwd, runId, { write_claim: null });
  return null;
}

/**
 * Writes the `released` envelope onto the run's CURRENT claim, preserving
 * every other field (`paths`/`unit`/`source`/`code_dir`/`vcs_baseline`)
 * verbatim. This module does not decide whether release is warranted — the
 * caller (`forge-claim-release.js`, T02) already measured that; this
 * function just persists the verdict, via the locked `runs.update` (never
 * `fs.writeFileSync` on the registry file directly — see module Standards).
 *
 * `runs.update` replaces `write_claim` as a WHOLE SLOT (`Object.assign`
 * over the patch, not a deep merge) — so this function must spread the
 * current claim explicitly before writing, rather than relying on any
 * implicit merge. See forge-runs.js:243-252 (`update`) — the merge is
 * shallow at the top level; nesting one level below `write_claim` is NOT
 * merged automatically.
 *
 * A run with no claim returns a NAMED result and never invents one:
 * `{ ok: false, reason: 'no-claim' }`, nothing written.
 *
 * ── The read happens under the SAME lock as the write (review R1) ───────────
 *
 * This used to `runs.get` OUTSIDE the lock, build `nextClaim` from that stale
 * read, and hand the whole slot to the locked `runs.update`. The lock made the
 * FILE write atomic and left the claim's IDENTITY unprotected: a fresh claim
 * written in that window was replaced by an older object already carrying a
 * `released` envelope — so writes in flight for the new unit ended up covered
 * by a released claim, the counterparts' gates skipped them, and the fence
 * this milestone exists to build opened exactly where it matters (under-block).
 * "Writing through a locked function" is NOT the same as "the read and the
 * write happened under the same lock", and the check that concluded otherwise
 * measured the wrong thing (S05-REVIEW § Nota de método).
 *
 * Now the read is inside `runs.updateWith`'s lock. `opts.expect` carries the
 * claim the CALLER measured (T02 probes before asking); when the persisted
 * claim's identity `{at, unit, vcs_baseline.id}` no longer matches it, the
 * write is REFUSED by name — `{ ok: false, reason: 'stale-claim', expected,
 * found }` — and NOTHING is written. Never silently, never overwriting: the
 * refusal is the whole point. Without `expect` the call is still atomic (the
 * read is under the lock), it simply has no identity to compare against.
 */
function claimIdentity(claim) {
  if (!claim) return null;
  return {
    at: typeof claim.at === 'number' ? claim.at : null,
    unit: claim.unit === undefined ? null : claim.unit,
    baseline_id: claim.vcs_baseline && typeof claim.vcs_baseline.id === 'string'
      ? claim.vcs_baseline.id : null,
  };
}

function sameIdentity(a, b) {
  if (a === null || b === null) return false;
  return a.at === b.at && a.unit === b.unit && a.baseline_id === b.baseline_id;
}

function releaseClaim(cwd, runId, release, opts) {
  const o = opts || {};
  const expected = o.expect === undefined || o.expect === null ? null : claimIdentity(o.expect);
  // Shape is validated BEFORE the lock is taken: a malformed envelope must
  // throw the same way it always did, and holding a lock to do it buys nothing.
  const released = normalizeReleased(release);

  // A run that does not exist at all reads as "no claim", exactly as it did
  // when the pre-lock `runs.get` returned `null` — `updateWith` throws for a
  // missing record, so the mapping is explicit here rather than a behaviour
  // change smuggled in by the fix.
  if (runs.get(cwd, runId) === null) return { ok: false, reason: 'no-claim' };

  let outcome = null;
  const result = runs.updateWith(cwd, runId, (current) => {
    const claim = readClaim(current);
    if (claim === null) { outcome = { ok: false, reason: 'no-claim' }; return null; }
    const found = claimIdentity(claim);
    if (expected !== null && !sameIdentity(expected, found)) {
      outcome = { ok: false, reason: 'stale-claim', expected, found };
      return null;
    }
    const nextClaim = Object.assign({}, claim, { released });
    outcome = { ok: true, claim: nextClaim };
    return { write_claim: nextClaim };
  });
  // `updated` and `outcome.ok` are the same fact seen from two sides; asserting
  // the agreement here keeps a future edit to either side from drifting them.
  if (result.updated !== (outcome !== null && outcome.ok === true)) {
    throw new Error('forge-write-claim: releaseClaim write/outcome disagreement');
  }
  return outcome;
}

/**
 * Operator recovery transition. The measured claim and run activity are
 * compared under the run lock; a changed record is never released.
 */
function recoverClaim(cwd, runId, expectedRecord, release, opts) {
  const o = opts || {};
  const released = normalizeReleased(release);
  if (!expectedRecord || expectedRecord.active !== true) {
    return { ok: false, reason: 'stale-run' };
  }
  const expectedRecordJson = JSON.stringify(expectedRecord);
  let outcome = { ok: false, reason: 'stale-run' };
  let result;
  try {
    result = runs.updateWith(cwd, runId, (current) => {
      if (current.active !== true || JSON.stringify(current) !== expectedRecordJson) return null;
      if (!isHeld(current.write_claim)) return null;
      // Executes while the run lock is held, immediately before publication.
      // Recovery uses this for the final dirty-scope measurement.
      if (typeof o.precondition === 'function') o.precondition(current);
      const nextClaim = Object.assign({}, current.write_claim, { released });
      outcome = { ok: true, claim: nextClaim };
      return { write_claim: nextClaim, active: false, ended_at: released.at };
    });
  } catch (error) {
    if (/not found/.test(error.message)) return { ok: false, reason: 'stale-run' };
    throw error;
  }
  if (!result.updated) return { ok: false, reason: 'stale-run' };
  return outcome;
}

/**
 * Pure. THREE distinct facts must never collapse when read through here:
 *   - claim absent (`readClaim` -> null)              -> isHeld: false
 *   - claim recorded, honestly empty (`paths: []`)     -> isHeld: true
 *   - claim RELEASED (`released` present, paths intact) -> isHeld: false
 * `isHeld` returns `false` for the first AND the third case, for DIFFERENT
 * reasons — callers that need to tell "never claimed" apart from "claimed
 * then released" must inspect `claim` (or `claim.released`) directly, not
 * `isHeld` alone. This is the accessor T03 uses so a released claim never
 * falls into `claim-absent` (which cross-run is `undeclared-writes`, D1) —
 * see S05-PLAN.md contract #6.
 */
function isHeld(claim) {
  // Only the canonical absence values mean "no claim". Falsy persisted values
  // are malformed claims, not proof that ownership ended.
  if (claim === null || claim === undefined) return false;
  if (typeof claim !== 'object' || Array.isArray(claim)) return true;
  try {
    return normalizeReleased(claim.released) === null;
  } catch {
    // A malformed release envelope cannot prove that ownership ended. Legacy,
    // hand-edited and partially-corrupt records stay protected (fail closed).
    return true;
  }
}

/** Strict read-side validator for a persisted live claim. */
function validateHeldClaim(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('claim-invalid');
  if (typeof claim.at !== 'number' || !Number.isFinite(claim.at)) throw new Error('claim-at-invalid');
  if (!CLAIM_SOURCES.includes(claim.source)) throw new Error('claim-source-invalid');
  if (!(claim.code_dir === null || (typeof claim.code_dir === 'string' && claim.code_dir !== ''))) throw new Error('claim-code-dir-invalid');
  if (!Array.isArray(claim.paths)) throw new Error('claim-paths-invalid');
  normalizeVcsBaseline(claim.vcs_baseline);
  if (normalizeReleased(claim.released) !== null) throw new Error('claim-not-live');
  return claim;
}

// ── CLI ──────────────────────────────────────────────────────────────────
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

function parsePathsArg(raw) {
  if (raw === undefined || raw === true) return [];
  const s = String(raw).trim();
  if (s === '') return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through to CSV */ }
  }
  return s.split(',').map((p) => p.trim()).filter((p) => p !== '');
}

const USAGE = `forge-write-claim — record/read/clear/release the write claim on a run's RunRecord

Flags:
  --claim <run-id> --unit <u> [--source <s>] [--code-dir <p>] [--paths <csv|json>]
                       record a write claim for the run (source default: manual)
  --show <run-id>      print the run's currently recorded claim
  --clear <run-id>     reset the run's claim to null (PRIMITIVE erase — not a release)
  --release <run-id> [--mechanism manual] [--evidence <json>]
                       write the released envelope, preserving the rest of the claim.
                       The CLI only writes the mechanism 'manual' (default), which
                       asserts NO measurement. 'committed'/'ttl-expired'/'explicit'
                       claim corroboration and are refused here — they are written
                       only by forge-claim-release.js, which measures them.
  --json               emit JSON instead of the human-readable form
  --cwd <path>         where to look for the run registry (default: process.cwd())
  --help               this text

recordClaim and releaseClaim are the only functions that write. Exit code 0 on success.
`;

function formatClaim(claim) {
  if (!claim) return '(sem claim)';
  const lines = [
    `at=${new Date(claim.at).toISOString()} unit=${claim.unit || '(?)'} source=${claim.source}`,
    `code_dir=${claim.code_dir === null ? '(desconhecido)' : claim.code_dir}`,
    `paths=${claim.paths.length === 0 ? '(vazio)' : claim.paths.join(', ')}`,
    `vcs_baseline=${claim.vcs_baseline ? `${claim.vcs_baseline.vcs}:${claim.vcs_baseline.id}` : '(nenhum)'}`,
    `released=${claim.released ? `${claim.released.mechanism} @ ${new Date(claim.released.at).toISOString()}` : '(não liberado)'}`,
  ];
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.claim && !args.show && !args.clear && !args.release)) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();

  try {
    if (typeof args.release === 'string') {
      // R4: the CLI may only write a mechanism that asserts NO measurement.
      // Refused by name, nothing written — never a silent downgrade to
      // `manual`, which would let the operator believe a corroborated release
      // was recorded.
      const mechanism = typeof args.mechanism === 'string' ? args.mechanism : 'manual';
      if (!CLI_RELEASE_MECHANISMS.includes(mechanism)) {
        throw new Error(
          `forge-write-claim: --mechanism ${JSON.stringify(mechanism)} não pode ser gravado pela CLI — ` +
          `ela só aceita ${JSON.stringify(CLI_RELEASE_MECHANISMS)}, que não alega medição nenhuma. ` +
          `${JSON.stringify(RELEASE_MECHANISMS.filter((m) => !CLI_RELEASE_MECHANISMS.includes(m)))} ` +
          `afirmam corroboração e só podem ser gravados por forge-claim-release.js, que a mede.`);
      }
      let evidence = {};
      if (typeof args.evidence === 'string') {
        try { evidence = JSON.parse(args.evidence); }
        catch (e) { throw new Error(`forge-write-claim: --evidence must be valid JSON, got ${JSON.stringify(args.evidence)}`); }
      }
      const result = releaseClaim(cwd, args.release, { at: Date.now(), mechanism, evidence });
      if (!result.ok) {
        process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `(sem claim para liberar: ${result.reason})\n`);
        return 0;
      }
      process.stdout.write(args.json ? `${JSON.stringify(result.claim, null, 2)}\n` : `${formatClaim(result.claim)}\n`);
      return 0;
    }
    if (typeof args.claim === 'string') {
      const claim = recordClaim(cwd, args.claim, {
        unit: typeof args.unit === 'string' ? args.unit : null,
        source: typeof args.source === 'string' ? args.source : 'manual',
        code_dir: typeof args['code-dir'] === 'string' ? args['code-dir'] : undefined,
        paths: parsePathsArg(args.paths),
      });
      process.stdout.write(args.json ? `${JSON.stringify(claim, null, 2)}\n` : `${formatClaim(claim)}\n`);
      return 0;
    }
    if (typeof args.show === 'string') {
      const rec = runs.get(cwd, args.show);
      const claim = readClaim(rec);
      process.stdout.write(args.json ? `${JSON.stringify(claim, null, 2)}\n` : `${formatClaim(claim)}\n`);
      return 0;
    }
    if (typeof args.clear === 'string') {
      clearClaim(cwd, args.clear);
      process.stdout.write(args.json ? `${JSON.stringify(null)}\n` : '(claim limpo)\n');
      return 0;
    }
  } catch (e) {
    process.stderr.write(`forge-write-claim: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(USAGE);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  normalizeClaim,
  recordClaim,
  readClaim,
  clearClaim,
  releaseClaim,
  recoverClaim,
  isHeld,
  validateHeldClaim,
  CLAIM_SOURCES,
  RELEASE_MECHANISMS,
  CLI_RELEASE_MECHANISMS,
  parseArgs,
  main,
  USAGE,
};
