#!/usr/bin/env node
// forge-write-coverage — how much of what each GSD unit actually WROTE its plan
// had DECLARED, measured against the VCS and reported with the threshold inside
// the report.
//
// ── What this measures, and what it refuses to measure ─────────────────────
//
// Declared side  = `writes:` (plan frontmatter) ∪ `expected_output:` (the
//                  must_haves schema). Two different fields, two different
//                  parsers, one union — `parseMustHaves` does NOT return
//                  `writes:` (verified by execution during S02 planning), so
//                  reading only one of them would undercount the declaration
//                  and inflate the "undeclared" column.
// Written side   = `forge-unit-delta.writtenByUnit` — the VCS delta, and
//                  nothing else. D6: the evidence log is NEVER a source here.
//                  It records tool calls (a file written then reverted counts;
//                  a file changed by `sed` inside a Bash call does not), which
//                  is not the question. `evidence_file` below is an ADDITIVE
//                  informative field and no code path lets it reach `coverage`
//                  or `verdict` — `forge-write-coverage.test.js` proves that
//                  negatively, by function source and by a fixture where the
//                  evidence contradicts the VCS.
//
// ── The rule that outranks the number ──────────────────────────────────────
//
// Never widen attribution to raise coverage. A unit that does not resolve goes
// to `skipped[]` with a reason from the CLOSED set below — never to a wildcard
// owner, never to 0%, never to 100%. A smaller honest `units_measured` beats a
// larger contaminated one; that is the entire reason S02 exists.
//
// Anti-silence floor, in three places:
//   1. every considered unit is measured OR skipped by name —
//      `units_considered === units_measured + skipped.length`, printed;
//   2. every commit walked is attributed OR named —
//      `commits_walked === attributed + unattributed.length`, printed;
//   3. `units_measured === 0` is NOT a verdict. It is `inconclusive` (outside
//      the closed verdict set on purpose) and the only non-zero exit. A
//      comparator that reports its own inactivity as good news is
//      indistinguishable from a broken detector.
//
// ── Composition, not reimplementation ──────────────────────────────────────
//
//   glob / path match   forge-parallelism.pathsOverlap / globToRegex  (T01)
//   plan frontmatter    forge-parallelism.parseTaskFrontmatter / parseListField
//   must_haves schema   forge-must-haves.hasStructuredMustHaves / parseMustHaves
//   written side        forge-unit-delta.writtenByUnit / listUnitRefs (T02)
//   unit key            forge-unit-delta.unitKeyFor  — the COMPOSITE key; see
//                       the note at `indexWritten` for why keying on
//                       `S##/T##` alone silently drops units
//   id shape            forge-ids.entityKind          (zero ID regex here)
//   evidence (info)     forge-evidence-path.resolveEvidenceFiles
//
// CLI:
//   node forge-write-coverage.js [--cwd <dir>] [--json | --markdown]
// Exit: 0 with a verdict; non-zero ONLY for `inconclusive`, with a named reason.

'use strict';

const fs = require('fs');
const path = require('path');

const { pathsOverlap, normalizePath, parseTaskFrontmatter } = require('./forge-parallelism.js');
const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves.js');
const { writtenByUnit, listUnitRefs, commitsForRef, unitKeyFor } = require('./forge-unit-delta.js');
const { resolveEvidenceFiles } = require('./forge-evidence-path.js');
const { entityKind } = require('./forge-ids.js');

// ── Closed sets ────────────────────────────────────────────────────────────
//
// Cross-checked BOTH WAYS by the suite against what this module actually
// produces: a reason the code emits but the list omits is a silent drop, and a
// reason nobody ever saw fire is decoration (TASK-021).
const SKIP_REASONS = [
  'no-code-writes',        // the declared side names no code: either it is 100% `.gsd/**` (never staged in this repo) or it is empty. `detail` distinguishes the two — see DECLARED_DETAILS.
  'no-branch-ref',         // the unit has a PLAN but its owner has no `forge/*` ref. forge-unit-delta deliberately does not declare this reason: it starts from refs and never sees the plan side. The join is where the absence becomes visible, so the reason lives here.
  'no-attributed-commits', // the ref EXISTS but carries no commit with this unit's scope (e.g. a batch commit aggregating several tasks). Neither 0% nor 100% — an honest "cannot measure this one".
  'legacy-plan-schema',    // the plan carries no readable structured `must_haves:` block, so its declared side cannot be read the way this measurement defines it.
  'plan-swept',            // a milestone/archive directory that exists but holds NO `T##-PLAN.md` FILE AT ALL (the plans were swept). Keyed on plan files SEEN, never on units admitted — see discoverCorpus. One synthetic entry per directory — never a percentage over nothing.
  'plans-all-excluded',    // a milestone/archive directory whose `T##-PLAN.md` files EXIST but none survived admission: every one was `status: DECOMPOSED` (a container, not a writer) or unreadable. Distinct from `plan-swept` because the plans are right there — saying they are absent would be a false statement about the directory (S02 review R3).
  'ambiguous-unit-owner',  // svn side: the revision names a unit scope but more than one milestone candidate and no full id, so ownership is unknowable. Refused, never guessed.
  'ref-divergent',         // the owner carries a local AND an origin ref and neither contains the other, so `forge-unit-delta` refused to pick a range to walk. Distinct from `no-attributed-commits`: there IS a ref and it may well carry the commits — the pair just cannot be resolved (S02 review R5).
];

// Sub-reasons of `no-code-writes`. Both are true instances of the reason ("this
// unit declares no code writes"); they differ in WHY, and that difference is
// the S02-PLAN § Notes measurement about `no-path-signal`, kept visible rather
// than folded away.
const DECLARED_DETAILS = {
  GSD_ONLY: 'gsd-only',           // declared paths exist and are all under `.gsd/**`
  NO_PATH_SIGNAL: 'no-path-signal', // neither `writes:` nor `expected_output:` yielded a path
};

const VERDICTS = ['GO', 'RESCOPE', 'NO-TARGET'];

// The thresholds are the deliverable, not a judgement made at read time. They
// are exported AND echoed in both renders, so a reader never has to open the
// source to learn what the verdict meant. S02-PLAN § Semântica do veredito:
// GO = the claim would intercept ≥ 4 of every 5 writes.
const VERDICT_THRESHOLDS = { go: 0.80, rescope: 0.40 };

// `inconclusive` sits OUTSIDE `VERDICTS` on purpose: it is an instrument
// failure, not a reading.
const INCONCLUSIVE = 'inconclusive';

const LIMITATION = [
  'Limitação (registrada incondicionalmente, D6/W6): este corpus é git + Claude.',
  'O incidente que originou a milestone é SVN + codex. O lado escrito aqui vem do delta',
  'de VCS do corpus medido; nada nesta medição demonstra equivalência com o ambiente do',
  'incidente. É uma limitação do instrumento, não uma equivalência.',
].join(' ');

const INSTRUMENT_WARNING_NOTE = [
  'Σ skipped > units_measured: a maior parte do corpus não pôde ser MEDIDA.',
  'Um veredito baixo aqui pode significar "não achei" e não "não há" — as duas coisas',
  'são diferentes e este campo existe para não deixá-las se confundirem.',
].join(' ');

// ── Corpus enumeration ─────────────────────────────────────────────────────

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// A plan decomposed into sub-tasks is not a unit that writes — it is a
// container. Excluded from the corpus, and COUNTED in `corpus.excluded` so the
// exclusion is visible instead of merely true.
function isDecomposed(content) {
  return /^status:\s*DECOMPOSED\s*$/mi.test(content || '');
}

/**
 * Every plan-bearing unit under `--cwd`, plus the milestone directories that
 * bear none.
 *
 * Roots: `.gsd/milestones/<id>/slices/S##/tasks/T##/T##-PLAN.md`, the same
 * shape under `.gsd/archive/`, and `.gsd/tasks/<T-id>/*-PLAN.md`.
 * `*-PLAN-GATE.md` never matches (the file-name test is exact), and that is
 * asserted rather than assumed.
 */
function discoverCorpus(cwd, owner) {
  const units = [];
  const swept = [];
  const allExcluded = [];
  const excluded = { decomposed: 0 };
  const rootsScanned = [];
  let milestoneDirs = 0;
  let plansSeenTotal = 0;

  for (const bucket of ['milestones', 'archive']) {
    const root = path.join(cwd, '.gsd', bucket);
    if (!isDir(root)) continue;
    rootsScanned.push(`.gsd/${bucket}`);
    for (const e of listDir(root)) {
      if (!e.isDirectory()) continue;
      const ownerId = e.name;
      if (entityKind(ownerId) !== 'milestone') continue;
      if (owner && ownerId !== owner) continue;
      milestoneDirs++;
      const before = units.length;
      // Plan FILES seen, counted apart from units ADMITTED. Before the S02
      // review R3 the two were the same number, so a milestone whose plans all
      // exist but are all `DECOMPOSED` was emitted as `plan-swept` with the
      // detail "sem nenhum T##-PLAN.md" — a false statement about a directory
      // whose plans are sitting right there, and one that inflates `skipped`
      // (hence the `instrument_warning`) on top of already being counted in
      // `excluded.decomposed`.
      let plansSeen = 0;
      let decomposedHere = 0;
      let unreadableHere = 0;
      const slicesRoot = path.join(root, ownerId, 'slices');
      for (const s of listDir(slicesRoot)) {
        if (!s.isDirectory() || !/^S\d{2}$/.test(s.name)) continue;
        const tasksRoot = path.join(slicesRoot, s.name, 'tasks');
        for (const t of listDir(tasksRoot)) {
          if (!t.isDirectory() || !/^T\d{2}(\.\d+)?$/.test(t.name)) continue;
          const planPath = path.join(tasksRoot, t.name, `${t.name}-PLAN.md`);
          if (!fs.existsSync(planPath)) continue;
          plansSeen++;
          plansSeenTotal++;
          const content = readText(planPath);
          if (content === null) { unreadableHere++; continue; }
          if (isDecomposed(content)) { excluded.decomposed++; decomposedHere++; continue; }
          units.push({
            unit: unitKeyFor(ownerId, s.name, t.name),
            owner: ownerId, owner_kind: 'milestone',
            slice: s.name, task: t.name,
            plan_path: path.relative(cwd, planPath).replace(/\\/g, '/'),
            content,
          });
        }
      }
      // Keyed on plan FILES, not on contribution: zero plans is `plan-swept`;
      // plans present but none admitted is its own named outcome.
      if (plansSeen === 0) swept.push({ owner: ownerId, bucket, plans_seen: 0 });
      else if (units.length === before) {
        allExcluded.push({
          owner: ownerId, bucket, plans_seen: plansSeen,
          decomposed: decomposedHere, unreadable: unreadableHere,
        });
      }
    }
  }

  const tasksRoot = path.join(cwd, '.gsd', 'tasks');
  if (isDir(tasksRoot) && (!owner || entityKind(owner) === 'task')) {
    rootsScanned.push('.gsd/tasks');
    for (const e of listDir(tasksRoot)) {
      if (!e.isDirectory()) continue;
      const taskId = e.name;
      if (entityKind(taskId) !== 'task') continue;
      if (owner && taskId !== owner) continue;
      for (const f of listDir(path.join(tasksRoot, taskId))) {
        if (!f.isFile || !f.isFile()) continue;
        // Exact suffix: `*-PLAN.md`. `*-PLAN-GATE.md` ends in `-GATE.md` and
        // therefore cannot match — proved by test, not by reading.
        if (!/-PLAN\.md$/.test(f.name)) continue;
        plansSeenTotal++;
        const planPath = path.join(tasksRoot, taskId, f.name);
        const content = readText(planPath);
        if (content === null) continue;
        if (isDecomposed(content)) { excluded.decomposed++; continue; }
        units.push({
          unit: unitKeyFor(taskId, null, null),
          owner: taskId, owner_kind: 'task',
          slice: null, task: null,
          plan_path: path.relative(cwd, planPath).replace(/\\/g, '/'),
          content,
        });
      }
    }
  }

  units.sort((a, b) => a.unit.localeCompare(b.unit));
  swept.sort((a, b) => a.owner.localeCompare(b.owner));
  allExcluded.sort((a, b) => a.owner.localeCompare(b.owner));
  return {
    units, swept, all_excluded: allExcluded, excluded,
    roots_scanned: rootsScanned, milestone_dirs: milestoneDirs,
    plan_files_seen: plansSeenTotal,
  };
}

// ── Declared side ──────────────────────────────────────────────────────────

/**
 * `writes:` ∪ `expected_output:` for one plan, de-duplicated and normalized.
 *
 * A malformed structured block is reported as `legacy-plan-schema` WITH the
 * parser's message in `detail`: the declared side cannot be read either way,
 * and inventing a seventh reason for a case the corpus may never contain would
 * be the decorative entry this module refuses.
 */
function declaredFor(cwd, unit) {
  if (!hasStructuredMustHaves(unit.content)) {
    return { declared: [], legacy: true, detail: 'no structured must_haves: block' };
  }
  let expected = [];
  try {
    expected = parseMustHaves(unit.content).expected_output || [];
  } catch (e) {
    return { declared: [], legacy: true, detail: e.message };
  }
  const fm = parseTaskFrontmatter(path.join(cwd, unit.plan_path));
  const writes = (fm && Array.isArray(fm.writes)) ? fm.writes : [];

  const seen = new Set();
  const declared = [];
  for (const raw of [...writes, ...expected]) {
    const p = normalizePath(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    declared.push(p);
  }
  return { declared, legacy: false, detail: null };
}

function isGsdOnly(declared) {
  return declared.length > 0 && declared.every((p) => p === '.gsd' || p.startsWith('.gsd/'));
}

// ── Written side ───────────────────────────────────────────────────────────

/**
 * Index the delta by the COMPOSITE key `forge-unit-delta.unitKeyFor` already
 * carries — never by `S##/T##`.
 *
 * This is measured, not cautious: T02's bait test showed that dropping the
 * owner axis does not merge buckets, it produces TWO entries sharing ONE key,
 * and any downstream index (a `Map`, a `find` — this join) keeps one and drops
 * the other with no signal at all. This join is exactly such an index.
 */
function indexWritten(delta) {
  const byKey = new Map();
  for (const u of (delta.units || [])) byKey.set(u.unit, u);
  return byKey;
}

function deltaForOwner(delta, owner) {
  if (!owner) return delta;
  const belongs = (row) => row && (
    row.owner === owner
    || row.unit === owner
    || (typeof row.unit === 'string' && (row.unit.startsWith(`${owner}::`) || row.unit.startsWith(`${owner}/`)))
  );
  const refBelongs = (row) => row && typeof row.ref === 'string'
    && (row.ref === `forge/${owner}` || row.ref.endsWith(`/${owner}`));
  const units = (delta.units || []).filter(belongs);
  const unattributed = (delta.unattributed || []).filter(refBelongs);
  const skipped = (delta.skipped || []).filter((row) => belongs(row) || refBelongs(row));
  const attributed = units.reduce((sum, row) => sum + (row.commits || []).length, 0);
  const svnUnattributedCannotBeScoped = delta.vcs === 'svn' && (delta.unattributed || []).length > 0;
  return {
    ...delta,
    units,
    unattributed,
    skipped,
    attributed,
    commits_walked: svnUnattributedCannotBeScoped ? null : attributed + unattributed.length,
    owner_scope_reconciliation: svnUnattributedCannotBeScoped ? 'unavailable:svn-unattributed-ownerless' : 'scoped',
    refs_examined: new Set([
      ...units.map((row) => row.ref),
      ...unattributed.map((row) => row.ref),
      ...skipped.map((row) => row.ref),
    ].filter(Boolean)).size,
  };
}

/**
 * Per-ref reconciliation `commits_walked === attributed + unattributed`.
 *
 * When the delta was produced here, `commits_walked` is re-derived from the
 * VCS (`commitsForRef`) so the identity is a real check. When the delta was
 * injected (tests), it can only be reconstructed from the parts, and the entry
 * says so in `source` — a tautology labelled as one is honest; a tautology
 * presented as a check is not.
 */
function reconcileRefs(cwd, delta, opts) {
  const o = opts || {};
  const rows = new Map();
  const touch = (ref) => {
    if (!rows.has(ref)) rows.set(ref, { ref, commits_walked: null, attributed: 0, unattributed: 0, source: 'reconstructed' });
    return rows.get(ref);
  };
  for (const u of (delta.units || [])) touch(u.ref || '(sem ref)').attributed += (u.commits || []).length;
  for (const c of (delta.unattributed || [])) touch(c.ref || '(sem ref)').unattributed += 1;
  for (const s of (delta.skipped || [])) if (s.ref) touch(s.ref);

  for (const row of rows.values()) {
    if (o.walkRefs && row.ref !== '(sem ref)') {
      const got = commitsForRef(cwd, row.ref, { defaultBranch: delta.default_branch });
      if (got.ok) { row.commits_walked = got.commits.length; row.source = 'vcs'; }
      else { row.commits_walked = null; row.source = `unavailable:${got.reason}`; }
    }
    if (row.commits_walked === null && row.source === 'reconstructed') {
      row.commits_walked = row.attributed + row.unattributed;
    }
    row.balances = row.commits_walked === row.attributed + row.unattributed;
  }
  return Array.from(rows.values()).sort((a, b) => a.ref.localeCompare(b.ref));
}

// Informative only, and structurally unable to be anything else: this returns
// a field that `computeCoverage` never receives. Existence of the composite
// evidence file for a unit — a secondary signal from S01, never a source (D6).
function evidenceInfoFor(cwd, unit) {
  try {
    const res = resolveEvidenceFiles(cwd, {
      milestone: unit.owner_kind === 'milestone' ? unit.owner : null,
      slice: unit.slice,
      unit: `execute-task/${unit.task || unit.owner}`,
    });
    const files = (res.files || []).map((f) => f.name);
    return { present: files.length > 0, files };
  } catch {
    return { present: false, files: [], error: 'unresolved' };
  }
}

// ── The join ───────────────────────────────────────────────────────────────

/**
 * Coverage over the MEASURED units, weighted per file.
 *
 * Takes only rows of `{ declared, written }`. It cannot see the evidence
 * field, cannot see skip reasons, cannot see the corpus — the D6 test asserts
 * that negatively over this function's own source.
 */
function computeCoverage(rows) {
  let written = 0;
  let hits = 0;
  const perUnit = [];
  for (const r of rows) {
    const w = r.written.length;
    const h = r.declared_hits;
    written += w;
    hits += h;
    perUnit.push(w === 0 ? 0 : h / w);
  }
  const mean = perUnit.length === 0 ? null : perUnit.reduce((a, b) => a + b, 0) / perUnit.length;
  return {
    total_written: written,
    total_declared_hits: hits,
    // A measured unit always has ≥ 1 written file (a unit with none is skipped
    // as `no-attributed-commits`), so this never divides by zero — and when
    // there are no measured units at all the caller emits `inconclusive`
    // rather than a 0% or a 100% invented out of nothing.
    coverage: written === 0 ? null : hits / written,
    coverage_mean_per_unit: mean,
  };
}

function verdictFor(coverage, unitsMeasured) {
  if (unitsMeasured === 0 || coverage === null) return INCONCLUSIVE;
  if (coverage >= VERDICT_THRESHOLDS.go) return 'GO';
  if (coverage >= VERDICT_THRESHOLDS.rescope) return 'RESCOPE';
  return 'NO-TARGET';
}

/**
 * The measurement. `opts.delta` / `opts.refs` are injection points for the
 * suite; `opts.evidence === false` drops the informative field entirely, which
 * is how the test proves the field cannot move the number.
 */
function measureCoverage(cwd, opts) {
  const o = opts || {};
  const corpus = discoverCorpus(cwd, o.owner);
  const delta = deltaForOwner(o.delta || writtenByUnit(cwd, o.deltaOpts || {}), o.owner);
  const written = indexWritten(delta);

  const refOwners = new Set();
  if (delta.vcs === 'git') {
    const refs = (o.refs || listUnitRefs(cwd)).filter((row) => !o.owner || row.id === o.owner);
    for (const r of refs) refOwners.add(r.id);
  }
  // svn has no ref axis at all, so `no-branch-ref` is not askable there; an
  // unresolved unit falls to `no-attributed-commits` (or to
  // `ambiguous-unit-owner` when the delta already refused ownership).
  const refAxisAvailable = delta.vcs === 'git';

  const ambiguous = new Set();
  const divergentOwners = new Map();
  for (const s of (delta.skipped || [])) {
    if (s.reason === 'ambiguous-unit-owner' && s.unit) ambiguous.add(s.unit);
    // The delta refused to pick between a local and an origin ref that diverged
    // (S02 review R5). Propagated as its own reason: calling it
    // `no-attributed-commits` would assert "ref presente, nenhum commit com o
    // escopo desta unidade" about refs nobody walked.
    if (s.reason === 'ref-divergent' && s.unit) divergentOwners.set(s.unit, s.refs || []);
  }

  const measured = [];
  const skipped = [];
  const contradictions = [];

  for (const sw of corpus.swept) {
    skipped.push({ unit: sw.owner, reason: 'plan-swept', detail: `${sw.bucket} sem nenhum T##-PLAN.md` });
  }
  for (const ax of (corpus.all_excluded || [])) {
    const parts = [];
    if (ax.decomposed) parts.push(`${ax.decomposed} DECOMPOSED`);
    if (ax.unreadable) parts.push(`${ax.unreadable} ilegível(is)`);
    skipped.push({
      unit: ax.owner,
      reason: 'plans-all-excluded',
      detail: `${ax.bucket} com ${ax.plans_seen} T##-PLAN.md, nenhum admitido (${parts.join(', ')})`,
    });
  }

  for (const u of corpus.units) {
    const dec = declaredFor(cwd, u);
    if (dec.legacy) {
      skipped.push({ unit: u.unit, reason: 'legacy-plan-schema', detail: dec.detail });
      continue;
    }
    if (dec.declared.length === 0 || isGsdOnly(dec.declared)) {
      const detail = dec.declared.length === 0 ? DECLARED_DETAILS.NO_PATH_SIGNAL : DECLARED_DETAILS.GSD_ONLY;
      skipped.push({ unit: u.unit, reason: 'no-code-writes', detail });
      if (detail === DECLARED_DETAILS.NO_PATH_SIGNAL) {
        // S02-PLAN § Notes measured `no-path-signal` as UNREACHABLE in this
        // corpus (46/46 plans carry `writes:`). If it fires, the measurement
        // that justified keeping the closed set at six has been contradicted —
        // said out loud here rather than quietly absorbed.
        contradictions.push({
          unit: u.unit,
          note: 'lado declarado vazio (nem writes: nem expected_output:) — a medição do S02-PLAN § Notes dava no-path-signal como inalcançável neste corpus; a condição de reversão registrada lá disparou',
        });
      }
      continue;
    }
    if (!written.has(u.unit)) {
      if (divergentOwners.has(u.owner)) {
        const refs = divergentOwners.get(u.owner);
        skipped.push({
          unit: u.unit, reason: 'ref-divergent',
          detail: `refs divergentes, nenhum contém o outro: ${refs.filter(Boolean).join(' × ') || '(refs não nomeados pelo delta)'}`,
        });
      } else if (u.slice && u.task && ambiguous.has(`${u.slice}/${u.task}`)) {
        skipped.push({ unit: u.unit, reason: 'ambiguous-unit-owner', detail: 'delta svn recusou o dono desta unidade' });
      } else if (refAxisAvailable && !refOwners.has(u.owner)) {
        skipped.push({ unit: u.unit, reason: 'no-branch-ref', detail: `nenhum ref forge/${u.owner}` });
      } else {
        skipped.push({ unit: u.unit, reason: 'no-attributed-commits', detail: 'ref presente, nenhum commit com o escopo desta unidade' });
      }
      continue;
    }
    const w = written.get(u.unit);
    const files = (w.files || []).slice();
    if (files.length === 0) {
      // A measured unit with an empty written side does not exist: it would be
      // a 0% (or a 100%) invented from nothing.
      skipped.push({ unit: u.unit, reason: 'no-attributed-commits', detail: 'unidade atribuída sem nenhum arquivo' });
      continue;
    }
    const undeclared = [];
    let hits = 0;
    for (const f of files) {
      const nf = normalizePath(f);
      if (dec.declared.some((d) => pathsOverlap(d, nf))) hits++;
      else undeclared.push(nf);
    }
    const row = {
      unit: u.unit, owner: u.owner, owner_kind: u.owner_kind, slice: u.slice, task: u.task,
      plan_path: u.plan_path,
      declared: dec.declared,
      written: files.map(normalizePath),
      declared_hits: hits,
      undeclared,
      unit_coverage: hits / files.length,
      commits: (w.commits || []).length,
    };
    if (o.evidence !== false) row.evidence_file = evidenceInfoFor(cwd, u);
    measured.push(row);
  }

  const totals = computeCoverage(measured.map((r) => ({ declared: r.declared, written: r.written, declared_hits: r.declared_hits })));
  const unitsConsidered = corpus.units.length + corpus.swept.length + (corpus.all_excluded || []).length;
  const verdict = verdictFor(totals.coverage, measured.length);

  const refRows = reconcileRefs(cwd, delta, { walkRefs: !o.delta && delta.vcs === 'git' });

  return {
    generated_at: new Date().toISOString(),
    scope: { owner: o.owner || null },
    cwd: normalizePath(cwd),
    vcs: delta.vcs,
    corpus: {
      roots_scanned: corpus.roots_scanned,
      milestone_dirs: corpus.milestone_dirs,
      // `plans_found` = plans ADMITTED as units. `plan_files_seen` = plan FILES
      // on disk. They differ by exclusions, and keeping both visible is what
      // stops `plan-swept` from meaning two different things (S02 review R3).
      plans_found: corpus.units.length,
      plan_files_seen: corpus.plan_files_seen,
      excluded: corpus.excluded,
      dirs_all_excluded: (corpus.all_excluded || []).length,
    },
    units_considered: unitsConsidered,
    units_measured: measured.length,
    skipped,
    skip_reasons_declared: SKIP_REASONS,
    reconciliation: {
      units: {
        units_considered: unitsConsidered,
        units_measured: measured.length,
        skipped: skipped.length,
        balances: unitsConsidered === measured.length + skipped.length,
      },
      commits: {
        commits_walked: delta.commits_walked,
        attributed: delta.attributed,
        unattributed: (delta.unattributed || []).length,
        balances: delta.commits_walked === delta.attributed + (delta.unattributed || []).length,
        source: delta.owner_scope_reconciliation || 'complete-delta',
      },
      refs: refRows,
    },
    units: measured,
    totals: { written: totals.total_written, declared_hits: totals.total_declared_hits },
    coverage: totals.coverage,
    coverage_mean_per_unit: totals.coverage_mean_per_unit,
    verdict,
    verdicts_closed_set: VERDICTS,
    thresholds: VERDICT_THRESHOLDS,
    thresholds_scale: [
      `GO: coverage >= ${VERDICT_THRESHOLDS.go}`,
      `RESCOPE: ${VERDICT_THRESHOLDS.rescope} <= coverage < ${VERDICT_THRESHOLDS.go}`,
      `NO-TARGET: coverage < ${VERDICT_THRESHOLDS.rescope}`,
      `${INCONCLUSIVE}: units_measured === 0 (fora do conjunto fechado — falha do instrumento, exit nao-zero)`,
    ],
    instrument_warning: skipped.length > measured.length,
    instrument_warning_note: INSTRUMENT_WARNING_NOTE,
    contradictions,
    limitation: LIMITATION,
    exit_reason: verdict === INCONCLUSIVE
      ? (unitsConsidered === 0 ? 'inconclusive: nenhuma unidade no corpus (--cwd sem .gsd/ ou corpus varrido)' : 'inconclusive: units_measured === 0 — nenhuma unidade do corpus pôde ser medida')
      : null,
  };
}

// ── Renders ────────────────────────────────────────────────────────────────

function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(rep) {
  const L = [];
  L.push('# Cobertura da declaração pelo delta de VCS');
  L.push('');
  L.push(`- **Corpus:** \`${rep.cwd}\` (vcs \`${rep.vcs}\`; raízes: ${rep.corpus.roots_scanned.join(', ') || '(nenhuma)'})`);
  L.push(`- **Gerado em:** ${rep.generated_at}`);
  L.push('');
  L.push('## Veredito');
  L.push('');
  L.push(`**${rep.verdict}** — coverage \`${pct(rep.coverage)}\` (${rep.totals.declared_hits}/${rep.totals.written} arquivos escritos que o plano declara).`);
  L.push('');
  L.push('Thresholds (constantes exportadas, ecoadas aqui e no `--json` — nunca só no código):');
  L.push('');
  for (const s of rep.thresholds_scale) L.push(`- \`${s}\``);
  L.push('');
  L.push(`Média por unidade (informativa, não decide o veredito): \`${pct(rep.coverage_mean_per_unit)}\`.`);
  if (rep.exit_reason) {
    L.push('');
    L.push(`> **${rep.exit_reason}**`);
  }
  L.push('');
  L.push('## Reconciliação (por extenso)');
  L.push('');
  const ru = rep.reconciliation.units;
  const rc = rep.reconciliation.commits;
  L.push(`- Unidades: \`${ru.units_considered} considerada(s) === ${ru.units_measured} medida(s) + ${ru.skipped} skipped\` → **${ru.balances ? 'fecha' : 'NÃO FECHA'}**`);
  L.push(`- Commits: \`${rc.commits_walked} caminhado(s) === ${rc.attributed} atribuído(s) + ${rc.unattributed} não-atribuído(s)\` → **${rc.balances ? 'fecha' : 'NÃO FECHA'}**`);
  L.push(`- Corpus: ${rep.corpus.plans_found} plano(s) admitido(s) de ${rep.corpus.plan_files_seen} arquivo(s) \`T##-PLAN.md\` vistos, em ${rep.corpus.milestone_dirs} diretório(s) de milestone; excluídos: ${rep.corpus.excluded.decomposed} DECOMPOSED; diretórios com planos mas nenhum admitido: ${rep.corpus.dirs_all_excluded}`);
  L.push('');
  L.push('| ref | commits caminhados | atribuídos | não-atribuídos | fecha | fonte |');
  L.push('|---|---:|---:|---:|---|---|');
  for (const r of rep.reconciliation.refs) {
    L.push(`| \`${r.ref}\` | ${r.commits_walked === null ? 'n/a' : r.commits_walked} | ${r.attributed} | ${r.unattributed} | ${r.balances ? 'sim' : 'NÃO'} | ${r.source} |`);
  }
  L.push('');
  if (rep.instrument_warning) {
    L.push('## ⚠ Aviso de instrumento');
    L.push('');
    L.push(`\`instrument_warning: true\` — ${rep.instrument_warning_note}`);
    L.push('');
  }
  L.push('## Unidades medidas');
  L.push('');
  if (rep.units.length === 0) {
    L.push('_Nenhuma._ Nenhuma porcentagem é emitida sobre nenhuma unidade — ver `skipped` abaixo.');
  } else {
    L.push('| unidade | declarados | escritos | acertos | cobertura | não-declarados |');
    L.push('|---|---:|---:|---:|---:|---|');
    for (const u of rep.units) {
      const und = u.undeclared.length === 0 ? '—' : u.undeclared.map((f) => `\`${f}\``).join(', ');
      L.push(`| \`${u.unit}\` | ${u.declared.length} | ${u.written.length} | ${u.declared_hits} | ${pct(u.unit_coverage)} | ${und} |`);
    }
  }
  L.push('');
  L.push('## Unidades não medidas (todas nomeadas)');
  L.push('');
  L.push(`Conjunto FECHADO de razões: ${SKIP_REASONS.map((r) => `\`${r}\``).join(', ')}.`);
  L.push('');
  if (rep.skipped.length === 0) {
    L.push('_Nenhuma._');
  } else {
    L.push('| unidade | razão | detalhe |');
    L.push('|---|---|---|');
    for (const s of rep.skipped) L.push(`| \`${s.unit}\` | \`${s.reason}\` | ${s.detail || '—'} |`);
  }
  if (rep.contradictions.length > 0) {
    L.push('');
    L.push('## Contradições medidas');
    L.push('');
    for (const c of rep.contradictions) L.push(`- \`${c.unit}\` — ${c.note}`);
  }
  L.push('');
  L.push('## Limitação');
  L.push('');
  L.push(LIMITATION);
  L.push('');
  return L.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `forge-write-coverage — quanto do que cada unidade ESCREVEU o plano DECLARAVA

Uso:
  node forge-write-coverage.js [--cwd <dir>] [--json | --markdown]

Flags:
  --cwd <path>   raiz do corpus (default: process.cwd())
  --json         relatório em JSON (default)
  --markdown     relatório em markdown
  --help         este texto

Exit: 0 com veredito {GO, RESCOPE, NO-TARGET}; nao-zero SÓ no 'inconclusive'.
`;

function parseArgs(argv) {
  const args = {};
  const booleanFlags = new Set(['json', 'markdown', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (booleanFlags.has(key)) { args[key] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(USAGE); return 0; }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();

  let rep;
  try {
    rep = measureCoverage(cwd, {});
  } catch (e) {
    // Measuring must never look like a failure to WRITE. A crash is reported
    // as a crash, on stderr, with the same non-zero code the inconclusive uses.
    process.stderr.write(`forge-write-coverage: ${e.message}\n`);
    return 2;
  }

  process.stdout.write(args.markdown ? `${renderMarkdown(rep)}\n` : `${JSON.stringify(rep, null, 2)}\n`);
  if (rep.verdict === INCONCLUSIVE) {
    process.stderr.write(`forge-write-coverage: ${rep.exit_reason}\n`);
    return 2;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  SKIP_REASONS,
  DECLARED_DETAILS,
  VERDICTS,
  VERDICT_THRESHOLDS,
  INCONCLUSIVE,
  LIMITATION,
  discoverCorpus,
  declaredFor,
  measureCoverage,
  computeCoverage,
  verdictFor,
  renderMarkdown,
  parseArgs,
  main,
  USAGE,
  _private: { indexWritten, reconcileRefs, evidenceInfoFor, isGsdOnly, isDecomposed },
};
