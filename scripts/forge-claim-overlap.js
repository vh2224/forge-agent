#!/usr/bin/env node
// forge-claim-overlap — advisory cross-run comparison of WRITE CLAIMS, with a
// census, named causes and an anti-silence floor.
//
// ── The locked boundary (S03-PLAN.md § 8, inherited from S07) ───────────────
//
// THIS MODULE SIGNALS. It does not sequence runs, it does not gate a dispatch,
// it does not suggest who merges first, it does not persist a queue and it
// does not perform speculative integration. Those together are an integration
// pipeline — a whole product — and they are out of scope BY DECISION, not for
// lack of time. The gate that REFUSES a dispatch is S04's, and it consumes
// this output; it must never be grown into this file, however natural the
// growth looks from here. `forge-claim-overlap.test.js` (and T03) assert that
// absence in executable form, by scanning this source with comments stripped.
//
// ── The polarity this module exists for (D1) ───────────────────────────────
//
// `forge-parallelism.writesConflict` (`forge-parallelism.js:107`) answers
// "empty list = no conflict". That is CORRECT INTRA-SLICE and is explicitly
// out of scope: there, both sides come from `T##-PLAN.md` frontmatter that the
// planner just wrote, so an empty `writes:` is a task that genuinely declares
// no writes, and two such tasks may safely run in parallel.
//
// CROSS-RUN the same shape means the opposite. A run whose claim is absent
// (`null`) or empty (`{ paths: [] }`) has not told us what it is about to
// write — and ABSENCE OF DECLARATION IS NEVER EVIDENCE OF SAFETY (D1). A
// comparator that read it as "no conflict" would hand out a clean bill of
// health to precisely the run nobody can vouch for. So here, an undeclared
// side is a CONFLICT, and it is a DIFFERENT conflict from a collision between
// two runs that did declare: the causes `undeclared-writes` and `overlap` are
// distinct, named, and never substituted for one another (S04 consumes exactly
// that distinction — it is born here, not there).
//
// The two polarities coexist ON PURPOSE. This module therefore reuses only
// `pathsOverlap` — the glob/prefix ALGEBRA — and NEVER the intra-slice
// predicate. T03 is the executable guard for both halves of that sentence.
//
// ── Composition, not reimplementation ──────────────────────────────────────
//
//   run universe       forge-runs.listAll
//   claim snapshot     forge-write-claim.readClaim   (T01)
//   path algebra       forge-parallelism.pathsOverlap
//
// A second glob algebra, or a second claim reader, would be the defect — not
// the feature (S03-PLAN.md § Standards).
//
// ── Posture ────────────────────────────────────────────────────────────────
//
// Read-only and advisory. `exit 0` ALWAYS, including when a conflict is
// found (asserted by SPAWNING the CLI, never claimed in a comment). Writes
// nothing: no `RunRecord` is mutated, which the suite proves by SHA-256 of
// every `.gsd/forge/runs/*.json` before and after a `--check`.
//
// CLI:
//   node forge-claim-overlap.js --check [--json] [--all] [--cwd <dir>]
//   node forge-claim-overlap.js --list  [--json] [--all] [--cwd <dir>]

'use strict';

const fs = require('fs');
const path = require('path');

const { readClaim } = require('./forge-write-claim.js');
const { pathsOverlap } = require('./forge-parallelism.js');
const runs = require('./forge-runs.js');

// ── Verdicts ─────────────────────────────────────────────────────────────
//
// Closed set. `compareClaims` may return nothing outside this list. An
// unlisted verdict string would sail through every `===` a caller writes and
// read as "not a conflict", i.e. as silence.
const VERDICTS = ['conflict', 'clean', 'inconclusive'];

// ── Conflict causes ──────────────────────────────────────────────────────
//
// The distinction D1 rests on. `undeclared-writes` is NOT a weaker
// `overlap` and must never be reported as one (nor the reverse): one says
// "a side never told us what it writes", the other says "both told us, and
// they collide". S04 refuses on the second and may choose differently on the
// first; collapsing them here would remove that choice from the layer that
// owns it.
const CONFLICT_CAUSES = [
  'undeclared-writes', // one or both sides carry no claim (`null`) or an empty `paths` — see the header on D1.
  'overlap',           // both sides declared, and `pathsOverlap` matched at least one pair of paths.
];

// ── Skip reasons ─────────────────────────────────────────────────────────
//
// Why a run, or a PAIR of runs, did not participate in the comparison. Every
// value documents WHEN it is reachable; the suite asserts the crossing in
// BOTH directions (every reason this code emits is listed; every listed entry
// is emitted by >= 1 test). One-directional checking lets a dead entry rot or
// an undocumented one leak.
const CLAIM_SKIP_REASONS = [
  'run-inactive',              // `rec.active !== true` and `--all` was not given. Excluded by the default activity filter — never dropped silently.
  'different-code-dir',        // D2: the two runs write from DIFFERENT `code_dir`s, so identical paths denote different files. Pair skipped; `pairs_compared` NOT incremented.
  'not-comparable-single-run', // exactly one comparable run survived, so zero pairs exist. This is the named reason behind the `inconclusive` floor.
];

// ── Note reasons ─────────────────────────────────────────────────────────
//
// A note is NOT a skip: the run or pair STAYS in the comparison and the note
// records what is uncertain about it. Same closed-set discipline, same
// two-directional crossing.
const CLAIM_NOTE_REASONS = [
  'claim-absent',     // the run never recorded a claim. It STAYS comparable on purpose: D1 requires "did not declare" to be a VISIBLE conflict, not a run quietly dropped from the universe.
  'claim-empty',      // the run recorded a claim whose `paths` is empty — declared, and honestly empty. Still `undeclared-writes` cross-run (D1), and still distinct from `claim-absent` as a FACT about the record.
  'code-dir-unknown',    // one or both sides did not record a `code_dir`. The pair IS compared — excluding on unknown would be the exact polarity D1 forbids, one level up.
  'code-dir-relative',   // one or both sides recorded a NON-ABSOLUTE `code_dir`. A relative string names a directory only together with a base nobody recorded, so neither identity NOR difference was measured (R1). Treated as `unknown`: compared, never skipped, never called `same`.
  'code-dir-invalid',    // one or both sides persisted a `code_dir` that is not a string at all (a malformed record predating the write-side validation). Same posture: `unknown`, compared, named (R3).
  'code-dir-unresolved', // both sides are absolute but at least one could not be resolved to a real path (removed worktree, permissions). The comparison DEGRADED to lexical identity, and the degradation is named here rather than passing silently (R2).
  'run-record-unparseable', // the `runs/*.json` could not be parsed at all. It STAYS in the universe as an undeclared counterpart, exactly like `claim-absent` — the same polarity, one layer lower. `block` was REFUSED (D12): one truncated file would paralyse every neighbour until a human deleted it by hand.
];

/**
 * What kind of `code_dir` value is this? Closed set, because every kind below
 * routes to a DIFFERENT named outcome and a silent boolean here is precisely
 * how R1/R3 produced a fabricated `same` and a fabricated `different`.
 *
 *   'absent'   -> never recorded (`null`/`undefined`/`''`)
 *   'invalid'  -> persisted, but not a string (malformed record)
 *   'relative' -> a string, but not absolute: names a directory only relative
 *                 to a base NOBODY recorded. Identity was not measured.
 *   'absolute' -> the only kind from which identity or difference may be
 *                 CONCLUDED.
 */
function classifyCodeDir(value) {
  if (value === undefined || value === null || value === '') return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'invalid' };
  if (!path.isAbsolute(value)) return { kind: 'relative' };
  return { kind: 'absolute', value };
}

/**
 * Resolve an absolute path to its REAL path. Symlinks, Windows junctions,
 * `subst` drives and `/tmp` -> `/private/tmp` all make two lexically different
 * strings name one and the same directory; a purely lexical comparison calls
 * those `different`, skips the pair (D2) and SUPPRESSES a real collision —
 * the polarity D1 forbids. Same precedent as M-20260803205433 PR1, which
 * replaced a lexical comparison with real-vs-real for exactly this reason (and
 * this code runs from a worktree, where the difference is not hypothetical).
 *
 * `{ ok: false }` when the directory cannot be resolved (removed worktree,
 * permissions): the caller degrades to lexical and NAMES the degradation.
 */
function realPathOf(p) {
  try {
    return { ok: true, value: fs.realpathSync.native(p) };
  } catch (_) {
    return { ok: false, value: path.resolve(p) };
  }
}

/** POSIX-normalise and strip a trailing separator, for path identity. */
function posix(p) {
  return typeof p === 'string' ? p.split(path.sep).join('/').replace(/\/+$/, '') : p;
}

/**
 * Do two claims write from the SAME `CODE_DIR` (D2)?
 *
 * Three outcomes, ALL named — nothing is decided by a silent boolean:
 *
 *   'same'      -> the pair is compared;
 *   'different' -> the pair is SKIPPED (`different-code-dir`), because
 *                  identical relative paths under different working trees
 *                  denote different files and flagging them would be a
 *                  fabricated collision;
 *   'unknown'   -> the identity of the two directories was NOT MEASURED: a side
 *                  recorded nothing, recorded a non-string, or recorded a
 *                  RELATIVE path (which names a directory only together with a
 *                  base nobody recorded). The pair is STILL COMPARED and the
 *                  uncertainty is noted. Excluding on unknown would be
 *                  "absence of information = safe", exactly the polarity D1
 *                  forbids one level down.
 *
 * `same` and `different` are CONCLUSIONS, and are therefore reachable only
 * from two ABSOLUTE paths resolved real-vs-real. Two equal relative strings
 * used to answer `same` (an identity nobody measured) and a relative/absolute
 * pair naming ONE directory used to answer `different` (a real collision
 * suppressed by a skip) — R1, both directions of the same defect.
 *
 * `codeDirScope` carries the note alongside the outcome; `sameCodeDir` is the
 * outcome-only view kept for callers that only branch on scope.
 */
function codeDirScope(a, b) {
  if (a?.schema_version !== undefined && a.schema_version !== 1 || b?.schema_version !== undefined && b.schema_version !== 1) {
    try {
      const roots = require('./forge-code-roots');
      const aa = roots.claimGroups(a), bb = roots.claimGroups(b);
      return { scope: aa.some(x => bb.some(y => x.identity_sha256 === y.identity_sha256)) ? 'same' : 'different', note: null };
    } catch { return { scope: 'unknown', note: 'code-dir-unresolved' }; }
  }
  const ka = classifyCodeDir(a && a.code_dir !== undefined ? a.code_dir : null);
  const kb = classifyCodeDir(b && b.code_dir !== undefined ? b.code_dir : null);

  // Order names the MOST specific defect first; all three route to `unknown`.
  if (ka.kind === 'invalid' || kb.kind === 'invalid') {
    return { scope: 'unknown', note: 'code-dir-invalid' };
  }
  if (ka.kind === 'absent' || kb.kind === 'absent') {
    return { scope: 'unknown', note: 'code-dir-unknown' };
  }
  if (ka.kind === 'relative' || kb.kind === 'relative') {
    return { scope: 'unknown', note: 'code-dir-relative' };
  }

  const ra = realPathOf(ka.value);
  const rb = realPathOf(kb.value);
  const note = (ra.ok && rb.ok) ? null : 'code-dir-unresolved';
  if (!ra.ok || !rb.ok) return { scope: 'unknown', note };

  let na = posix(ra.value);
  let nb = posix(rb.value);
  // Windows paths are case-insensitive; comparing case-sensitively there would
  // manufacture a `different-code-dir` skip for one and the same directory.
  if (process.platform === 'win32') {
    na = na.toLowerCase();
    nb = nb.toLowerCase();
  }
  return { scope: na === nb ? 'same' : 'different', note };
}

function sameCodeDir(a, b) {
  return codeDirScope(a, b).scope;
}

/** A claim that declares nothing: never recorded, or recorded with no paths. */
function isUndeclared(claim) {
  return !claim || !Array.isArray(claim.paths) || claim.paths.length === 0;
}

/**
 * The heart of D1. Returns `null` (no conflict) or
 * `{ cause, paths }` with `cause` from `CONFLICT_CAUSES`.
 *
 * ── Why the polarity here is the INVERSE of `writesConflict` ───────────────
 *
 * `forge-parallelism.writesConflict` returns `false` when either side is
 * empty ("empty = no writes = no conflict"). That is right INTRA-SLICE and
 * stays untouched: both sides there are `writes:` blocks from task plans the
 * planner just emitted, so empty means "this task declares no writes", a
 * positive fact about a plan that exists.
 *
 * CROSS-RUN there is no such plan behind the emptiness. A missing or empty
 * claim means the run NEVER TOLD US what it is about to write — and absence
 * of declaration is not evidence of safety (D1 of the milestone CONTEXT). So
 * an undeclared side conflicts, with its OWN cause `undeclared-writes`, kept
 * distinct from `overlap` so the S04 gate can treat them differently.
 *
 * `writesConflict` is deliberately NOT imported here, and is not referenced
 * anywhere in this file; only `pathsOverlap` — the algebra — is reused.
 */
function claimsConflict(claimA, claimB) {
  if (claimA?.schema_version !== undefined && claimA.schema_version !== 1 || claimB?.schema_version !== undefined && claimB.schema_version !== 1) {
    try {
      const roots = require('./forge-code-roots'), matched = [];
      for (const a of roots.claimGroups(claimA)) for (const b of roots.claimGroups(claimB)) {
        if (a.identity_sha256 !== b.identity_sha256) continue;
        for (const x of a.paths) for (const y of b.paths) if (pathsOverlap(x, y)) matched.push(`${a.id}::${x} × ${b.id}::${y}`);
      }
      return matched.length ? { cause: 'overlap', paths: matched } : null;
    } catch (e) { return { cause: 'undeclared-writes', paths: [], detail: e.message }; }
  }
  if (isUndeclared(claimA) || isUndeclared(claimB)) {
    return { cause: 'undeclared-writes', paths: [] };
  }

  const matched = [];
  for (const a of claimA.paths) {
    for (const b of claimB.paths) {
      if (pathsOverlap(a, b)) {
        const label = a === b ? a : `${a} × ${b}`;
        if (!matched.includes(label)) matched.push(label);
      }
    }
  }
  if (matched.length === 0) return null;
  return { cause: 'overlap', paths: matched };
}

/**
 * Read the run registry and split every run into `comparable` or `skipped`.
 *
 * Reads only — no writes, no git. `opts.all` includes inactive runs.
 *
 * A run whose claim is `null` STAYS COMPARABLE and lands in `notes[]` with
 * `claim-absent`. Dropping it would be the quiet version of the very failure
 * D1 names: an undeclared run must be a visible conflict, not an absent row.
 */
function collectRunClaims(cwd, opts) {
  const o = opts || {};
  const detailed = runs.listAllDetailed ? runs.listAllDetailed(cwd) : { parsed: runs.listAll(cwd), unparseable: [] };
  const all = detailed.parsed;

  const comparable = [];
  const skipped = [];
  const notes = [];

  for (const rec of all) {
    const id = rec && rec.id ? rec.id : '(?)';

    if (!o.all && rec.active !== true) {
      skipped.push({ id, reason: 'run-inactive' });
      continue;
    }

    const claim = readClaim(rec);
    if (claim === null) {
      notes.push({ id, reason: 'claim-absent' });
    } else if (!Array.isArray(claim.paths) || claim.paths.length === 0) {
      // Recorded and honestly empty — a DIFFERENT fact from never-recorded,
      // and kept different here (forge-write-claim.readClaim's contract).
      notes.push({ id, reason: 'claim-empty' });
    }

    comparable.push({ id, claim, code_dir: (claim && claim.code_dir) || null });
  }
  // Finding 3 (PR #110). A record we could not read is NOT a record that is not there. It is kept in
  // the universe as an undeclared counterpart, and `runs_examined` counts it — a census whose count
  // is computed AFTER the discard is a census that reports its own blindness as a clean universe.
  // The skip is an ENUMERATION, never a term of the equation (the R3 lesson of
  // forge-claim-audit.js:642-646).
  for (const bad of detailed.unparseable) {
    notes.push({ id: bad.id, reason: 'run-record-unparseable', detail: bad.reason });
    comparable.push({ id: bad.id, claim: null, code_dir: null });
  }
  return { runs_examined: all.length + detailed.unparseable.length, comparable, skipped, notes };
}

/** Stable output: by the two run ids. */
function byRunIds(x, y) {
  const a = String(x.runs[0]).localeCompare(String(y.runs[0]));
  if (a !== 0) return a;
  return String(x.runs[1]).localeCompare(String(y.runs[1]));
}

/**
 * Confront every unordered pair of comparable runs.
 *
 * PURE. No disk, no writes, no git — everything it needs is in `collected`,
 * which makes the floor below directly testable without a fixture.
 *
 * ── Why `pairs_compared === 0` precedes every other branch ─────────────────
 *
 * The verdict order is FIXED and the floor is FIRST:
 *
 *     pairs_compared === 0   ->  inconclusive     (before anything else)
 *     conflicts.length > 0   ->  conflict
 *     otherwise              ->  clean
 *
 * `clean` is a CLAIM ABOUT WORK DONE — "I confronted these pairs and found no
 * collision". A comparator that emits it having confronted nothing reports
 * its own inactivity as good news, and that report is byte-for-byte
 * indistinguishable from a broken detector. Reordering these branches, or
 * short-circuiting `conflicts.length === 0` to `clean` ahead of the floor,
 * reintroduces the whole bug class. The suite proves the floor BITES by
 * mutating it and observing red.
 *
 * `pairs_compared` is incremented INSIDE the loop, once per pair actually
 * walked — never computed as `n*(n-1)/2` on the side. A counter derived from
 * a formula stays correct while the loop it describes fails to run: the same
 * lie in a smaller font.
 */
function compareClaims(collected) {
  const comparable = (collected && collected.comparable) || [];
  const skipped = ((collected && collected.skipped) || []).slice();
  const notes = ((collected && collected.notes) || []).slice();

  const conflicts = [];
  let pairs_compared = 0;
  let paths_compared = 0;

  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const A = comparable[i];
      const B = comparable[j];

      const { scope, note } = codeDirScope(A.claim, B.claim);
      // The note is recorded BEFORE the skip branch and independently of it: a
      // degraded comparison that ends in `different` still degraded, and a
      // skip whose basis was lexical-only must say so. Silence about HOW the
      // scope was decided is the failure mode R1/R2 were both instances of.
      if (note) notes.push({ id: `${A.id} × ${B.id}`, reason: note });
      if (scope === 'different') {
        // D2: skipped BEFORE the counter — a pair that was not confronted
        // must never inflate the census that makes `clean` reachable.
        skipped.push({ id: `${A.id} × ${B.id}`, reason: 'different-code-dir' });
        continue;
      }

      pairs_compared += 1;
      paths_compared += ((A.claim && A.claim.paths) || []).length
        + ((B.claim && B.claim.paths) || []).length;

      const hit = claimsConflict(A.claim, B.claim);
      if (hit) {
        conflicts.push({
          runs: [A.id, B.id],
          cause: hit.cause,
          code_dir: (A.code_dir || B.code_dir) || null,
          paths: hit.paths,
        });
      }
    }
  }

  conflicts.sort(byRunIds);

  if (comparable.length === 1) {
    skipped.push({ id: comparable[0].id, reason: 'not-comparable-single-run' });
  }

  let verdict;
  let reason;
  if (pairs_compared === 0) {
    verdict = 'inconclusive';
    reason = comparable.length === 1
      ? '1 run comparável, nenhum par a confrontar'
      : `${comparable.length} run(s) comparável(is), 0 par(es) confrontado(s)`;
  } else if (conflicts.length > 0) {
    verdict = 'conflict';
    reason = `${conflicts.length} conflito(s) em ${pairs_compared} par(es) confrontado(s)`;
  } else {
    verdict = 'clean';
    reason = `${pairs_compared} par(es) confrontado(s), ${paths_compared} caminho(s), nenhuma colisão`;
  }

  return {
    verdict,
    reason,
    runs_examined: (collected && collected.runs_examined) || 0,
    runs_with_claim: comparable.filter((c) => c.claim !== null).length,
    pairs_compared,
    paths_compared,
    conflicts,
    skipped,
    notes,
  };
}

/**
 * Human-readable rendering.
 *
 * The reason rides on the FIRST line for EVERY verdict, `inconclusive`
 * included: a mute `inconclusive` repeats one level up the very defect this
 * module exists to prevent — the reader cannot tell "nothing to compare" from
 * "the tool is broken". The census is the second line, always.
 */
function formatClaimOverlap(result) {
  const lines = [];
  lines.push(`forge-claim-overlap: ${result.verdict} — ${result.reason}`);
  lines.push(
    `  censo: examined ${result.runs_examined} · with-claim ${result.runs_with_claim}`
    + ` · pairs ${result.pairs_compared} · paths ${result.paths_compared}`
    + ` · skipped ${result.skipped.length}`,
  );

  for (const c of result.conflicts) {
    const where = c.code_dir ? ` @ ${c.code_dir}` : '';
    const what = c.paths.length > 0 ? c.paths.join(', ') : '(nada declarado)';
    lines.push(`  ⚠ ${c.runs[0]} × ${c.runs[1]} — ${c.cause}${where}: ${what}`);
  }

  for (const s of result.skipped) {
    lines.push(`  · fora da comparação: ${s.id} (${s.reason})`);
  }
  for (const n of result.notes) {
    lines.push(`  · ${n.id} (${n.reason})`);
  }

  return lines.join('\n');
}

/** The "show the claims" half of the demo: one line per comparable run. */
function formatClaimList(collected) {
  const lines = [];
  lines.push(`forge-claim-overlap --list: ${collected.comparable.length} run(s) comparável(is)`
    + ` de ${collected.runs_examined} examinada(s)`);
  for (const c of collected.comparable) {
    const claim = c.claim;
    if (!claim) {
      lines.push(`  ${c.id}: (sem claim) — não declarou`);
      continue;
    }
    const p = claim.paths.length === 0 ? '(vazio) — não declarou' : claim.paths.join(', ');
    lines.push(`  ${c.id}: unit=${claim.unit || '(?)'} code_dir=${claim.code_dir || '(desconhecido)'} paths=${p}`);
  }
  for (const s of collected.skipped) {
    lines.push(`  · fora da comparação: ${s.id} (${s.reason})`);
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-claim-overlap.js --check|--list [--json] [--all] [--cwd <dir>]',
  '',
  'Sinal advisory: confronta os write claims das runs que dividem o mesmo',
  'CODE_DIR e aponta quando duas runs colidem — ou quando uma delas não',
  'declarou nada. SEMPRE sai com exit 0.',
  '',
  'Veredictos: conflict | clean | inconclusive.',
  '`clean` exige ter confrontado ao menos um par; sem par, o veredicto é',
  '`inconclusive` — nunca `clean`.',
  '',
  'Causas: undeclared-writes (um dos lados não declarou) | overlap (declararam',
  'e colidiram). Nunca uma reportada no lugar da outra.',
  '',
  'Flags:',
  '  --check        confronta os claims e aponta as colisões',
  '  --list         mostra os claims das runs comparáveis',
  '  --json         emite JSON em vez da forma legível',
  '  --all          inclui runs inativas (default: só as ativas)',
  '  --cwd <path>   onde procurar o registry de runs (default: process.cwd())',
  '  --help         este texto',
].join('\n');

function parseArgs(argv) {
  const out = { check: false, list: false, json: false, all: false, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--list') out.list = true;
    else if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--cwd') { out.cwd = argv[++i]; }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.check && !args.list)) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  try {
    const collected = collectRunClaims(cwd, { all: args.all });
    if (args.check) {
      const result = compareClaims(collected);
      process.stdout.write(args.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatClaimOverlap(result)}\n`);
    } else {
      process.stdout.write(args.json
        ? `${JSON.stringify(collected, null, 2)}\n`
        : `${formatClaimList(collected)}\n`);
    }
  } catch (e) {
    // Advisory: an unreadable registry is REPORTED — loud on stderr — never
    // fatal to a caller's loop. Same posture as forge-overlap.js.
    process.stderr.write(`forge-claim-overlap: ${e.message}\n`);
    return 0;
  }

  // Return 0 UNCONDITIONALLY — including when `verdict === 'conflict'`. This
  // signal informs; the gate that REFUSES a dispatch is S04's. Do NOT make
  // this reflect the verdict: that single edit converts an advisory detector
  // into the mechanism S03 declared out of scope.
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  collectRunClaims,
  claimsConflict,
  compareClaims,
  formatClaimOverlap,
  formatClaimList,
  sameCodeDir,
  codeDirScope,
  classifyCodeDir,
  isUndeclared,
  VERDICTS,
  CONFLICT_CAUSES,
  CLAIM_SKIP_REASONS,
  CLAIM_NOTE_REASONS,
  parseArgs,
  main,
  USAGE,
};
