'use strict';

/*
 * Distill selection schema:
 * { milestone, verdicts: [{ candidate_id, keep, gate:
 * { project_specific, non_obvious, durable }, category, text, rank, reason }] }
 * The plan is recomputed at apply time. Selection validation checks judgment
 * shape, not the merit of the judgment.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isValid } = require('./forge-ids');
const memory = require('./forge-memory');
const { readFragment: readLedgerFragment } = require('./forge-ledger');
const { activeUnits, isUnitBlocked } = require('./forge-sweep-active-phase');

const MAX_LINES_PER_BOUNDED_FILE = 10;
// Ranking semantics of the consumer, not a taste call: forge-projection.js reads
// `confidence_base` and falls back to 0.5 when the field is absent, then sorts and
// cuts at MEMORY_CAP=50. A distilled fact written without the field lands at the
// 0.5 floor and never survives the cap in any store with more than ~50 facts — the
// defect `distill-facts-invisible-in-projection`, measured on this repo's store
// (10 DST facts at positions 72-81 of 86, cutoff 0.681).
// 0.80 is chosen against the band that unit-authored MEM facts actually occupy in
// that same store (0.75 / 0.80 / 0.85 / 0.90 / 0.95, modal 0.85): comfortably above
// the cap cutoff so the distillate is VISIBLE, and below the 0.85 modal band so it
// does NOT displace memories a worker observed first-hand. Distilled facts are
// second-hand by construction — re-read from a closed milestone's wrapper — so they
// earn the low end of "confirmed", never the top.
const DISTILL_CONFIDENCE_BASE = 0.8;
const VERDICT_LINE = /conced|refut|abert|verdict|veredito|NO-TARGET|green/i;
function readSourceText(file) { return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'); }
// Resolve the wrapper root where the wrapper actually lives. The previous version
// built `.gsd/milestones/<id>` unconditionally, so every wrapper under `.gsd/tasks/`
// was refused as `wrapper-not-found` and never reached the distiller at all
// (measured on the WDMA sweep: 189 of 266 wrappers). The fallback returns the
// milestones path so the original `wrapper-not-found` message and detail survive.
function wrapperRoot(cwd, unitId) {
  const ms = path.join(cwd, '.gsd', 'milestones', unitId);
  if (fs.existsSync(ms)) return ms;
  const tk = path.join(cwd, '.gsd', 'tasks', unitId);
  if (fs.existsSync(tk)) return tk;
  return ms;
}
// Locate a root artifact by SUFFIX instead of demanding the exact `<id>-<TYPE>.md`
// name. Measured on the same WDMA sweep: several wrappers store the SUMMARY without
// the slug in the file name (`M-20260529-151715-extracao-controllers/` holds
// `M-20260529-151715-SUMMARY.md`), so the exact name never matched and the richest
// source file entered the plan as `absent`.
//
// Ambiguity is decided by the two-layer D5 rule, never by `sort()[0]`: picking the
// alphabetically first SUMMARY would write the WRONG knowledge into permanent memory
// moments before the wrapper is deleted. Asymmetry: a refusal costs one manual look;
// a silent wrong pick is unrecoverable.
//   0 matches   -> no file (caller falls back to the exact name -> `absent`)
//   1 match     -> that file, ONLY if its stem relates to the unit (see below)
//   >1 matches  -> strong form `<unitId>-<suffix>` (any name prefixed by unitId):
//                    exactly 1 strong -> canonical, the others are NAMED as ignored
//                    0 or >=2 strong  -> refusal NAMING every candidate, none read
//
// The single-match branch used to treat CARDINALITY as provenance: being the only
// file ending in the suffix was accepted as proof of belonging to the unit. It is
// not. `review-fix-triage-SUMMARY.md` exists today at the root of
// `.gsd/milestones/M-20260811134201-controle-contexto-gsd/` and only fails to bite
// because the canonical SUMMARY coexists (2 matches). Alone in a wrapper, it would
// have been read as THE unit summary and written into permanent memory moments
// before the wrapper is deleted. So the stem (basename minus suffix) must be a
// PREFIX of the unitId — which accepts the canonical name and the shortened WDMA
// form (`M-20260811134201` is a prefix of `M-20260811134201-controle-contexto-gsd`)
// and refuses `review-fix-triage` with a NAMED refusal (data in an exit-0 plan,
// never a throw). Same asymmetry as above: a refusal costs one manual look.
function relatedStem(name, suffix, unitId) {
  if (typeof unitId !== 'string' || unitId.length === 0) return false;
  const stem = name.slice(0, name.length - suffix.length);
  return stem.length > 0 && unitId.startsWith(stem);
}
function findBySuffix(root, suffix, unitId) {
  let names;
  try { names = fs.readdirSync(root).filter(name => name.endsWith(suffix)).sort(); } catch (_) { return { file: null }; }
  if (names.length === 0) return { file: null };
  if (names.length === 1) {
    if (relatedStem(names[0], suffix, unitId)) return { file: path.join(root, names[0]) };
    return { file: null, refusal: `unrelated-suffix-match: ${names[0]} (name is not a prefix form of ${unitId})` };
  }
  const strong = names.filter(name => typeof unitId === 'string' && unitId.length > 0 && name.startsWith(unitId));
  if (strong.length === 1) {
    const ignored = names.filter(name => name !== strong[0]);
    return { file: path.join(root, strong[0]), note: `ambiguous-suffix-resolved: ${strong[0]} (ignored: ${ignored.join(', ')})` };
  }
  return { file: null, refusal: `ambiguous-suffix: ${names.join(', ')}` };
}
function checkEligibility(cwd, milestoneId) {
  const wrapper = wrapperRoot(cwd, milestoneId);
  if (!fs.existsSync(wrapper)) return { ok: false, reason: 'wrapper-not-found', detail: wrapper };
  let ledger;
  try { ledger = readLedgerFragment(cwd, milestoneId); } catch (error) { return { ok: false, reason: `no-ledger-entry: ${error.message}` }; }
  if (!ledger) return { ok: false, reason: 'no-ledger-entry' };
  let census;
  try { census = activeUnits(cwd); } catch (error) { census = { ok: false, reason: `active-phase-unknown: ${error.message}` }; }
  const blocked = isUnitBlocked(census, { milestoneId, unitId: milestoneId });
  if (census.ok !== true || blocked.blocked) return { ok: false, reason: 'active-phase', detail: blocked.reason || census.reason };
  return { ok: true, reason: null, detail: 'all eligibility fences passed' };
}
function rel(cwd, file) { return path.relative(cwd, file).split(path.sep).join('/'); }
function sourceFiles(cwd, milestoneId) {
  const root = wrapperRoot(cwd, milestoneId);
  // Root artifacts are located by suffix (milestones OR tasks wrapper); the slice
  // files below stay on exact names — that is the boundary of this change.
  const files = [];
  for (const [suffix, kind] of [['-SUMMARY.md', 'milestone-summary'], ['-CONTEXT.md', 'milestone-context']]) {
    const found = findBySuffix(root, suffix, milestoneId);
    if (found.refusal) { files.push({ file: path.join(root, `${milestoneId}${suffix}`), kind, refusal: found.refusal }); continue; }
    files.push({ file: found.file || path.join(root, `${milestoneId}${suffix}`), kind, note: found.note });
  }
  let entries; try { entries = fs.readdirSync(path.join(root, 'slices'), { withFileTypes: true }); } catch (_) { return files; }
  for (const entry of entries.filter(item => item.isDirectory() && /^S\d+$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    files.push({ file: path.join(root, 'slices', entry.name, `${entry.name}-SUMMARY.md`), kind: 'slice-summary' });
    files.push({ file: path.join(root, 'slices', entry.name, `${entry.name}-REVIEW.md`), kind: 'slice-review', bounded: true });
    files.push({ file: path.join(root, 'slices', entry.name, `${entry.name}-MEASUREMENT.md`), kind: 'slice-measurement', bounded: true });
  }
  return files;
}
// R1 (review S02): the inline flow used to be treated as ONE value with the first
// and last quote stripped by regex, so `key: ["first", "second"]` produced the
// corrupted candidate `first", "second` — YAML syntax residue presented as fact
// text, in silence. That form is alive in this repo's own generator output
// (`provides: ["a", "b"]` in a T##-SUMMARY.md), and the WDMA population was never
// measured for item multiplicity, so the reach is real, not hypothetical.
//
// Three closed cases, and nothing else is guessed:
//   - no quote character at all -> ONE item, commas intact (the measured WDMA
//     form `[payload whitelisted {reason, status?}]`; splitting it would cut a
//     fact in half, and that behaviour stays pinned by test).
//   - every item fully quoted -> N items, quote-aware (a comma inside quotes
//     never separates, and the quotes are consumed by the parser, never by a
//     strip-first-and-last regex).
//   - anything else (mixed quoted/bare, unterminated quote, text outside the
//     quotes) -> REFUSED BY NAME. The refusal is data in the exit-0 plan, never a
//     throw; no text carrying a quote artifact is ever emitted.
function parseInlineFlow(inner) {
  const raw = inner.trim();
  if (!raw) return { values: [] };
  if (!/["']/.test(raw)) return { values: [raw] };
  const values = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) return { refusal: `inline-flow-unparsed: trailing separator after item ${values.length}` };
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") return { refusal: `inline-flow-unparsed: item ${values.length + 1} is not fully quoted` };
    let j = i + 1;
    let buffer = '';
    while (j < raw.length && raw[j] !== quote) {
      if (quote === '"' && raw[j] === '\\' && j + 1 < raw.length) { buffer += raw[j + 1]; j += 2; continue; }
      buffer += raw[j]; j++;
    }
    if (j >= raw.length) return { refusal: `inline-flow-unparsed: unterminated quote at item ${values.length + 1}` };
    values.push(buffer);
    i = j + 1;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i < raw.length) {
      if (raw[i] !== ',') return { refusal: `inline-flow-unparsed: text outside quotes after item ${values.length}` };
      i++;
    }
  }
  return { values };
}
// `refusals` is an optional sink: named reasons travel out alongside the values so
// the caller can put them in the plan instead of dropping them on the floor.
function arrayValues(text, key, refusals) {
  const lines = text.split('\n'); const values = []; let active = false;
  for (const line of lines) {
    if (line.startsWith(`${key}:`)) {
      // INLINE YAML form: `key: [content]` on the same line. The original only
      // understood the block list (`key:` followed by `  - item`), so wrappers
      // written with `key_decisions: [...]` extracted ZERO — no error, no warning
      // (measured on the WDMA sweep: 9 task wrappers).
      // Parsing is delegated to parseInlineFlow — see the three closed cases
      // documented above it. A bare item keeps its commas; a fully quoted flow
      // yields N items; anything else is refused by name.
      const inline = line.slice(key.length + 1).trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const parsed = parseInlineFlow(inline.slice(1, -1));
        if (parsed.refusal) { if (Array.isArray(refusals)) refusals.push(`${key}: ${parsed.refusal}`); continue; }
        for (const value of parsed.values) values.push(value);
        continue;
      }
      active = true; continue;
    }
    if (active && line.match(/^\s+-\s+/)) { const value = line.replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''); values.push(value); continue; }
    if (active && line.trim() && !line.match(/^\s/)) active = false;
  }
  return values;
}
// Bullets under a bold label (`**Entregas:**`, `**Key Deliverables:**`). Measured
// on the WDMA sweep: the SUMMARY files without frontmatter — the ones the original
// extractor classified as "no recognised source" — are precisely the richest; one
// of them holds 18 delivery bullets, each naming the file touched and what changed.
// The capture stops at the first heading or at the next bold label, so it never
// drags the prose that follows the section.
//
// Scope fence: only the NAMED labels below are read here. Generalising to ANY bold
// label is a separate, measured decision (S02 RISK) and does not live in this file.
function labelledBullets(text, label) {
  const out = [];
  const re = new RegExp(`^\\*\\*${label}:\\*\\*\\s*$`, 'gim');
  let match;
  while ((match = re.exec(text)) !== null) {
    const tail = text.slice(match.index + match[0].length);
    const stop = tail.search(/^(#{2,3}\s|\*\*[^*\n]+:\*\*)/m);
    const body = stop < 0 ? tail : tail.slice(0, stop);
    for (const bullet of body.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)) out.push(bullet[1].trim());
  }
  return out;
}
// Generalisation of labelledBullets: bullets under ANY structured bold label.
function anyLabelledBullets(text, alreadyCovered) {
  const out = [];
  const re = /^\*\*([^*\n]{2,60}?):\*\*\s*$/gim;
  let match;
  while ((match = re.exec(text)) !== null) {
    const label = match[1].trim();
    if (alreadyCovered.some(l => label.toLowerCase() === l.toLowerCase())) continue;
    const tail = text.slice(match.index + match[0].length);
    const stop = tail.search(/^(#{1,3}\s|\*\*[^*\n]+:\*\*)/m);
    const body = stop < 0 ? tail : tail.slice(0, stop);
    for (const bullet of body.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)) out.push({ label, text: bullet[1].trim() });
  }
  return out;
}
// Section titles the extractor recognises. The original set covered only the two
// English labels emitted by the CURRENT generator; this repo has five generations
// of SUMMARY and the decisions section also appears in pt-BR.
//
// Entries are interpolated literally into `new RegExp`: none carries a regex
// metacharacter today and it must stay that way. If a future heading needs one,
// the escape idiom is `forge-symbol-check.js:195`.
const HEADINGS = [
  'Implementation Decisions',
  'Decisões-chave do milestone',
  'Decisões-chave',
  'Key Decisions',
  // Titles seen in this repo whose content is ALREADY well-formed bullets — there
  // the fix belongs to the extractor, not to the document. When the content is a
  // table or prose, the direction is the opposite: fix the document.
  'Decisões travadas',
  'Decisões registradas',
  'Locked Decisions',
  'Aggregate Decisions',
];
// Bold labels read as sections, kept NAMED (see labelledBullets).
const LABELS = ['Entregas', 'Key Deliverables'];
function extractSource(spec, refusals) {
  const text = readSourceText(spec.file); const values = [];
  if (spec.bounded) {
    for (const line of text.split('\n').slice(0, MAX_LINES_PER_BOUNDED_FILE)) if (VERDICT_LINE.test(line)) values.push({ text: line.trim(), kind: 'bounded:review' });
  } else {
    if (text.startsWith('---\n') && !text.includes('\n---', 4)) throw new Error('frontmatter sem fechamento');
    for (const key of ['provides', 'key_decisions', 'patterns_established']) for (const value of arrayValues(text, key, refusals)) values.push({ text: value, kind: `frontmatter:${key}` });
    // PREFIX match, not equality. The repo uses suffixes that the original `\s*$`
    // could never match: `## Forward Intelligence for S03`, `## Key Decisions
    // (acumulado)`, `## Decisões-chave do milestone (acumuladas)`.
    for (const heading of [spec.kind === 'milestone-context' ? 'Decisions from Session' : 'Forward Intelligence', ...HEADINGS]) { const start = text.search(new RegExp(`^##\\s+${heading}\\b[^\\n]*$`, 'im')); if (start >= 0) { const tail = text.slice(start).replace(/^##[^\n]*\n?/i, ''); const body = tail.slice(0, tail.search(/^##\s+/m) < 0 ? undefined : tail.search(/^##\s+/m)); for (const match of body.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)) values.push({ text: match[1].trim(), kind: `section:${heading.toLowerCase().replace(/ /g, '-')}` }); } }
    for (const label of LABELS) for (const value of labelledBullets(text, label)) values.push({ text: value, kind: `label:${label.toLowerCase().replace(/ /g, '-')}` });
    // The ANY path carries its own kind PREFIX (`label-any:`), never `label:`. The
    // two NAMED labels keep a stable kind, and the containment below can tell the
    // generalised path apart from every other source without guessing at slugs.
    // The slug keeps unicode letters (`\p{L}`): the prototype's `[^\w]+` turned
    // `Decisões registradas` into `decis-es-registradas`, while every other kind in
    // this file preserves the accent (`section:decisões-chave`).
    for (const item of anyLabelledBullets(text, LABELS)) values.push({ text: item.text, kind: `label-any:${item.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}` });
  }
  return values.filter(Boolean);
}
// Containment for the generalised bold-label path, and ONLY for it.
//
// Measured on this repo (S02-MEASUREMENT.md, population of 17 local units): the ANY
// path takes the total from 468 to 533 candidates — 1.14x, far from the 3x that named
// the ANY class explosive elsewhere — but it does lift TWO units from under 100
// verdicts to over it (87 -> 113 and 93 -> 120). 100 is not a taste call: it is the
// order of magnitude of the WDMA wrapper that raised the alarm (137 verdicts), and a
// unit whose distillation demands that many judgments is not arbitrable in one pass.
//
// So the ANY candidates are admitted in order until the unit reaches the cap, and the
// overflow is DISCARDED BY NAME with a reason instead of being silently truncated:
// `discarded: [{ id, source_file, label, kind, text, reason }]`. Candidates from every
// other source (frontmatter, sections, the two NAMED labels) are never discarded —
// the cap contains the path that widened, it does not ration what already worked. A
// unit already above the cap without the ANY path keeps all of its old candidates and
// admits none of the new ones.
const ANY_LABEL_UNIT_CAP = 100;
function isAnyLabel(candidate) { return typeof candidate.source_kind === 'string' && candidate.source_kind.startsWith('label-any:'); }
function containAnyLabels(gathered, cap) {
  const limit = typeof cap === 'number' ? cap : ANY_LABEL_UNIT_CAP;
  // Two passes, not one: everything that is not ANY is admitted FIRST, so the cap is
  // decided against the unit's real load instead of against whatever happened to be
  // read before it. A single interleaved pass would admit ANY bullets from the first
  // file while the running total was still low and then leave the unit above the cap
  // anyway — order-dependent containment, which is no containment at all.
  const accepted = gathered.filter(candidate => !isAnyLabel(candidate));
  const discarded = [];
  for (const candidate of gathered) {
    if (!isAnyLabel(candidate)) continue;
    if (accepted.length < limit) { accepted.push(candidate); continue; }
    discarded.push({
      id: candidate.id,
      source_file: candidate.source_file,
      label: candidate.source_kind.slice('label-any:'.length),
      kind: candidate.source_kind,
      text: candidate.text,
      reason: `any-label-cap: unit already holds ${accepted.length} candidates (cap ${limit})`,
    });
  }
  return { accepted, discarded };
}
// Display-id assignment, lifted out of planDistill so the collision branch can be
// exercised directly: a natural 8-hex sha1 prefix collision cannot be produced on
// demand inside a fixture, and a test that cannot reach the branch does not bite.
// `collisions` is the same array the plan surfaces as `id_collisions`.
function createIdAssigner() {
  const byDisplayId = new Map();
  const collisions = [];
  function displayId(digest, source, text) {
    for (const width of [8, 16, 24, 40]) {
      const candidateId = 'c-' + digest.slice(0, width);
      const prior = byDisplayId.get(candidateId);
      if (prior === digest) return candidateId;
      if (prior === undefined) {
        if (width > 8) collisions.push({ id: candidateId, collided_with: 'c-' + digest.slice(0, 8), source_file: source, text, reason: `candidate-id-collision: the 8-hex prefix is already taken by a different (source, text) pair; this candidate is kept under a ${width}-hex id` });
        byDisplayId.set(candidateId, digest);
        return candidateId;
      }
    }
    throw new Error('candidate-id-collision: full sha1 digest collision');
  }
  return { displayId, collisions };
}
function planDistill(cwd, milestoneId) {
  const result = { milestone: milestoneId, verdict: 'INELIGIBLE', eligibility: null, files_examined: 0, candidates_total: 0, candidates: [], skipped: [], notes: [], measured_at: new Date().toISOString() };
  if (!isValid(milestoneId)) { result.eligibility = { ok: false, reason: 'plan-error:invalid milestone id' }; return result; }
  result.eligibility = checkEligibility(cwd, milestoneId); if (!result.eligibility.ok) return result;
  const gathered = [];
  // A candidate id is sha1(source \x00 text) and deliberately EXCLUDES the kind, so
  // two headings that match the same section (`## Decisões-chave do milestone` is
  // matched by the `Decisões-chave` prefix too) produce the very same id twice.
  // Duplicates would inflate `candidates_total`, inflate the number of verdicts a
  // selection must carry, and contaminate any before/after measurement of the
  // extractor's reach. First occurrence wins; the extra one is dropped silently
  // because it carries no information the first does not already carry.
  //
  // R2 (review S02): that last sentence is true only when the two candidates are
  // genuinely the same, so the dedupe key is the FULL sha1 digest, never the
  // truncated 8-hex display id. Keyed on 32 bits, a prefix collision between two
  // DIFFERENT (source, text) pairs discarded a distinct candidate in silence.
  // Precedent in this same file: `checkCollisions` names `mem-id-collision`
  // instead of absorbing it. A display-id collision is likewise never absorbed —
  // BOTH candidates are kept (dropping one was the defect), the later one gets a
  // longer deterministic id so the selection protocol keeps unique candidate_ids,
  // and the event is reported by name in `result.id_collisions` plus a stderr
  // warning. Surfaced rather than thrown because planDistill is a preview whose
  // refusals are data in an exit-0 plan; a throw would destroy the whole plan.
  const seen = new Set();
  const assigner = createIdAssigner();
  const displayId = assigner.displayId;
  const idCollisions = assigner.collisions;
  for (const spec of sourceFiles(cwd, milestoneId)) {
    result.files_examined++;
    // A refused suffix ambiguity is data in the exit-0 plan, never a throw: consumers
    // read a non-zero exit as "unavailable" and would move on in silence.
    if (spec.refusal) { result.skipped.push({ file: rel(cwd, spec.file), reason: spec.refusal }); continue; }
    if (spec.note) result.notes.push({ file: rel(cwd, spec.file), note: spec.note });
    if (!fs.existsSync(spec.file)) { result.skipped.push({ file: rel(cwd, spec.file), reason: 'absent' }); continue; } const refusals = []; try { for (const item of extractSource(spec, refusals)) { const source = rel(cwd, spec.file); const digest = crypto.createHash('sha1').update(`${source}\x00${item.text}`).digest('hex'); if (seen.has(digest)) continue; seen.add(digest); gathered.push({ id: displayId(digest, source, item.text), source_file: source, source_kind: item.kind, text: item.text }); } } catch (_) { result.skipped.push({ file: rel(cwd, spec.file), reason: 'unparseable' }); } for (const refusal of refusals) result.skipped.push({ file: rel(cwd, spec.file), reason: refusal }); }
  const contained = containAnyLabels(gathered, ANY_LABEL_UNIT_CAP);
  result.candidates = contained.accepted; result.candidates_total = contained.accepted.length;
  // Additive fields: consumers that never heard of containment read `candidates` and
  // ignore these, exactly as they ignore any other unknown key.
  result.discarded = contained.discarded; result.candidates_before_containment = gathered.length;
  result.id_collisions = idCollisions;
  for (const collision of idCollisions) process.stderr.write(`forge-distill: ${collision.reason} (${collision.source_file})\n`);
  result.verdict = result.candidates_total ? 'ELIGIBLE-PREVIEW' : 'NO-CANDIDATES'; return result;
}

// ROADMAP: “≤ 10 linhas/milestone além da entrada do LEDGER”; one single-line fact is one rendered line.
const DISTILL_BUDGET_FACTS = 10;
const CATEGORIES = new Set(['gotcha', 'convention', 'architecture', 'pattern', 'environment', 'preference']);
const WRAPPER_CITATION_RES = [
  /\.gsd[\\/](milestones|tasks|archive)[\\/]/i,
  /slices[\\/]S\d{2}[\\/]/i,
  /tasks[\\/]T\d{2}(?:[\\/]|\b)/i,
  /\bS\d{2}-[A-Z][A-Z-]*\.md\b/,
  /\bT\d{2}(?:\.\d+)?-(PLAN|SUMMARY)\.md\b/,
];
const USAGE = 'Uso: node scripts/forge-distill.js --milestone <id> --selection <file> [--cwd <dir>] [--apply] [--json]';

// Apply pipeline invariants, kept beside the implementation so future changes
// do not accidentally move a fence across the write boundary.
//
// 1. Selection JSON is parsed before any project state is changed.
// 2. The plan is collected from the current wrapper and current source files.
// 3. Candidate ids are compared against that fresh plan.
// 4. Every fresh candidate receives an explicit keep or discard verdict.
// 5. A keep must carry all three durable-evidence booleans.
// 6. The category set is closed to the six memory categories.
// 7. A kept text is single-line, because one fact is one rendered ledger line.
//    Fences 5-7 live in validateSelectionShape and run on BOTH entry points —
//    loadSelection (CLI) and validateAgainstPlan (apply) — so no programmatic
//    caller can reach the store around them.
// 8. Wrapper citations are rejected before the memory store is inspected.
// 9. Existing facts are read through forge-memory's public API.
// 10. A same-id, same-payload fact is an idempotent no-op.
// 11. A same-id, different-payload fact is an explicit collision.
// 12. The budget counts only DST-prefixed facts after simulated merge.
// 13. Existing MEM-prefixed facts are deliberately outside that budget.
// 14. Budget overflow reports ranks rather than silently truncating input.
// 15. Eligibility is checked once while planning and once immediately before write.
// 16. The preview is emitted before the apply call reaches writeFragment.
// 17. The fragment key is the milestone id, with no command-line namespace.
// 18. The source marker names the distiller and the same milestone.
// 19. The date is generated at fact creation and is stable on re-execution.
// 20. writeFragment performs the store merge and byte-level idempotence check.
// 21. No direct memory-directory path is constructed by this module.
// 22. No raw fragment bytes are written by the apply path.
// 23. Citation diagnostics expose only candidate id and matched wrapper token.
// 24. The complete rejected fact text is never included in a refusal message.
// 25. SHA-1 below is an identity fingerprint only, not an integrity claim.
// 26. The twelve-character suffix is sufficient for the documented namespace.
// 27. `rank` remains selection metadata and is not persisted as a fact field.
// 28. This keeps the stored schema exact and lets mergeFacts remain authoritative.
// 29. Read failures are converted to named selection or eligibility failures.
// 30. CLI argument errors use exit 2; apply validation errors use exit 1.
// 31. Preview-only invocations retain T01's exit-zero reporting behavior.
// 32. `--apply` without `--selection` cannot reach plan or memory writes.
// 33. Unknown CLI options cannot be mistaken for selection content.
// 34. The module exports helpers for behavior-focused tests and callers.
// 35. The CLI does not auto-accept an omitted selection.
// 36. The apply API accepts an object, while the CLI owns JSON file loading.
// 37. This separation makes unreadable-selection errors deterministic.
// 38. Candidate ordering remains the order produced by planDistill.
// 39. Rank ordering is used only to describe budget overflow.
// 40. Every refusal occurs before the sole mutating operation.
// 41. A no-op second apply does not rewrite created_at or source fields.
// 42. The memory API's existing-fact precedence is preserved.
// 43. No merge shadowing is allowed when a deterministic id collides.
// 44. The wrapper regexes accept both slash conventions for Windows and POSIX.
// 45. Named regexes cover wrapper directories and wrapper artifact filenames.
// 46. The plan parser remains a closed source discovery list.
// 47. Missing source files are skipped by planning, not created by applying.
// 48. The current milestone is always the unit_id of the output fragment.
// 49. All output fields are JSON serializable for automation.
// 50. These invariants are also exercised by forge-distill.test.js.

function failure(reason, detail) {
  const error = new Error(reason + (detail ? `: ${detail}` : ''));
  error.reason = reason;
  error.detail = detail;
  error.exitCode = 1;
  return error;
}

function dstMemId(unitId, category, text) {
  return 'DST-' + crypto.createHash('sha1').update(`${unitId}\x00${category}\x00${text}`).digest('hex').slice(0, 12);
}

// R1 (review S03): invariants #5-#7 (three-boolean gate, closed category set,
// single-line text) used to live only inside loadSelection, i.e. only on the CLI
// path. applyDistill is exported and directly callable, so a programmatic caller
// could persist a malformed kept verdict — bypassing the very quality gate this
// module exists to enforce. The shape check now lives here and is invoked from
// BOTH entry points: loadSelection (file path) and validateAgainstPlan (apply
// path). Every refusal keeps its original reason string, so the boundary moved
// without renaming any observable failure.
function validateSelectionShape(selection) {
  if (!selection || typeof selection !== 'object' || !Array.isArray(selection.verdicts) || typeof selection.milestone !== 'string') {
    throw failure('selection-unreadable', 'expected milestone and verdicts[]');
  }
  const ranks = new Set();
  const ids = new Set();
  for (const verdict of selection.verdicts) {
    if (!verdict || typeof verdict !== 'object' || typeof verdict.candidate_id !== 'string' || ids.has(verdict.candidate_id)) {
      throw failure('selection-unreadable', 'candidate_id must be unique and non-empty');
    }
    ids.add(verdict.candidate_id);
    if (typeof verdict.keep !== 'boolean') throw failure('selection-unreadable', `${verdict.candidate_id}: keep must be boolean`);
    if (verdict.keep) {
      const gate = verdict.gate;
      if (!gate || typeof gate.project_specific !== 'boolean' || typeof gate.non_obvious !== 'boolean' || typeof gate.durable !== 'boolean') {
        throw failure('gate-shape', verdict.candidate_id);
      }
      if (!(gate.project_specific && gate.non_obvious && gate.durable)) throw failure('gate-shape', verdict.candidate_id);
      if (!CATEGORIES.has(verdict.category)) throw failure('invalid-category', verdict.candidate_id);
      if (typeof verdict.text !== 'string' || !verdict.text.trim()) throw failure('multiline-text', `${verdict.candidate_id}: text is empty`);
      if (verdict.text.includes('\n') || verdict.text.includes('\r')) throw failure('multiline-text', verdict.candidate_id);
      if (!Number.isInteger(verdict.rank) || verdict.rank < 0 || ranks.has(verdict.rank)) throw failure('selection-unreadable', `${verdict.candidate_id}: rank must be unique integer`);
      ranks.add(verdict.rank);
    } else if (typeof verdict.reason !== 'string' || !verdict.reason.trim()) {
      throw failure('selection-unreadable', `${verdict.candidate_id}: rejected verdict needs reason`);
    }
  }
  return selection;
}

function loadSelection(file) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(file), 'utf8'); } catch (error) { throw failure('selection-unreadable', error.message); }
  let selection;
  try { selection = JSON.parse(raw); } catch (error) { throw failure('selection-unreadable', error.message); }
  return validateSelectionShape(selection);
}

function candidateMap(plan) { return new Map(plan.candidates.map(candidate => [candidate.id, candidate])); }

function matchedCitation(text) {
  for (const re of WRAPPER_CITATION_RES) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

function validateAgainstPlan(selection, plan) {
  // R1: the verdict-shape fence runs on the apply path too, not only on the CLI
  // path. A caller that never touched loadSelection still cannot write a fact
  // with a failed gate, an unknown category, or multiline text.
  validateSelectionShape(selection);
  const known = candidateMap(plan);
  const unknown = selection.verdicts.filter(item => !known.has(item.candidate_id)).map(item => item.candidate_id);
  if (unknown.length) throw failure('unknown-candidate', unknown.join(','));
  const judged = new Set(selection.verdicts.map(item => item.candidate_id));
  const missing = plan.candidates.filter(item => !judged.has(item.id)).map(item => item.id);
  if (missing.length) throw failure('unjudged-candidates', missing.join(','));
  const keeps = selection.verdicts.filter(item => item.keep).map(item => ({ ...item, candidate: known.get(item.candidate_id) }));
  for (const item of keeps) {
    // The text is a judged value, while the candidate id anchors it to the fresh plan.
    const citation = matchedCitation(item.text);
    if (citation) throw failure('wrapper-citation', JSON.stringify({ candidate_id: item.candidate_id, matched: citation }));
  }
  return keeps;
}

function existingFacts(cwd, milestoneId) {
  const fragment = memory.readFragment(cwd, milestoneId);
  return { fragment, facts: fragment && Array.isArray(fragment.facts) ? fragment.facts : [] };
}

// R2 (review S03): a second same-category+text verdict inside the SAME batch used
// to be reported as `already_present`, which is a claim about the persisted store.
// After a first-ever apply that reading is false, and a curator could conclude a
// fact pre-existed when it did not. Store-origin is now decided against the
// snapshot taken BEFORE any in-batch insertion (`storeIds`), so the two origins
// are separate outputs: `already` (persisted from a prior run) and
// `dedupedInBatch` (duplicate payload within this very selection).
function checkCollisions(existing, keeps, milestoneId) {
  const byId = new Map(existing.map(fact => [fact.mem_id, fact]));
  const storeIds = new Set(byId.keys());
  const fresh = [];
  const already = [];
  const dedupedInBatch = [];
  for (const item of keeps) {
    const mem_id = dstMemId(milestoneId, item.category, item.text);
    const prior = byId.get(mem_id);
    if (prior) {
      if (prior.category !== item.category || prior.text !== item.text) throw failure('mem-id-collision', mem_id);
      if (storeIds.has(mem_id)) already.push(item.candidate_id);
      else dedupedInBatch.push({ candidate_id: item.candidate_id, mem_id });
    } else {
      const fact = { mem_id, category: item.category, text: item.text, rank: item.rank, source_unit: `distill/${milestoneId}` };
      byId.set(mem_id, fact);
      fresh.push({ ...item, mem_id });
    }
  }
  // R4: the former `merged: Array.from(byId.values())` was computed on every apply
  // and read by nobody (applyDistill uses only `fresh`/`already`, and no other
  // caller consumes it). No consumer was found, so it is deleted rather than
  // surfaced — the store merge is forge-memory's job, not this module's.
  return { fresh, already, dedupedInBatch };
}

function checkBudget(existing, fresh) {
  const existingDst = existing.filter(fact => typeof fact.mem_id === 'string' && /^DST-/.test(fact.mem_id)).length;
  const total = existingDst + fresh.length;
  if (total <= DISTILL_BUDGET_FACTS) return total;
  const overflow = fresh.slice().sort((a, b) => a.rank - b.rank).slice(Math.max(0, DISTILL_BUDGET_FACTS - existingDst)).map(item => ({ candidate_id: item.candidate_id, rank: item.rank }));
  throw failure('budget-exceeded', JSON.stringify({ dst_facts_total: total, over_budget: overflow }));
}

function previewText(plan, selection) {
  return JSON.stringify({ preview: true, milestone: plan.milestone, candidates: plan.candidates_total, verdicts: selection.verdicts.length, keeps: selection.verdicts.filter(v => v.keep).length }) + '\n';
}

function applyDistill(cwd, milestoneId, selection, opts = {}) {
  if (!selection || !Array.isArray(selection.verdicts)) throw failure('selection-unreadable', 'selection object required');
  if (selection.milestone !== milestoneId) throw failure('selection-unreadable', 'milestone mismatch');
  if (!isValid(milestoneId)) throw failure('selection-unreadable', 'invalid milestone');
  const plan = planDistill(cwd, milestoneId);
  if (!plan.eligibility || !plan.eligibility.ok) throw failure('ineligible', plan.eligibility && plan.eligibility.reason);
  const keeps = validateAgainstPlan(selection, plan);
  const current = existingFacts(cwd, milestoneId);
  const checked = checkCollisions(current.facts, keeps, milestoneId);
  checkBudget(current.facts, checked.fresh);
  // Re-check all three T01 fences immediately before the only mutating call.
  const finalEligibility = checkEligibility(cwd, milestoneId);
  if (!finalEligibility.ok) throw failure('ineligible', finalEligibility.reason);
  // R3 (review S03) — ACCEPTED RACE, NARROWED, NOT ELIMINATED.
  // The budget is decided from a store snapshot; forge-memory's transaction lock
  // guards the merge, not this read-then-decide window, and writeFragment does not
  // know about DISTILL_BUDGET_FACTS. Two concurrent `--apply` for the same
  // milestone could therefore each pass against the same snapshot and jointly
  // exceed the budget. Recomputing INSIDE the lock is not available to this module
  // without reaching past forge-memory's public API (invariants #9/#21/#22), and
  // buying it would cost exactly the boundary this module was built to respect.
  // forge-distill is a human-driven, single-operator curation command; concurrent
  // apply of the same milestone is explicitly outside its contract. What is bought
  // here is best-effort narrowing, not mutual exclusion: the store is re-read
  // immediately before the write and the budget re-checked, so a competing apply
  // that already landed is refused by name instead of silently overflowing.
  const latest = existingFacts(cwd, milestoneId);
  let total;
  try {
    total = checkBudget(latest.facts, checked.fresh);
  } catch (error) {
    if (error.reason !== 'budget-exceeded') throw error;
    throw failure('budget-exceeded-on-recheck', error.detail);
  }
  const facts = checked.fresh.map(item => ({ mem_id: item.mem_id, category: item.category, text: item.text, confidence_base: DISTILL_CONFIDENCE_BASE, created_at: new Date().toISOString().slice(0, 10), source_unit: `distill/${milestoneId}` }));
  let written = false;
  let fragmentPath = current.fragment ? memory.listFragments(cwd).find(entry => entry.unitId === milestoneId)?.path : undefined;
  if (facts.length) {
    const result = memory.writeFragment(cwd, { unit_id: milestoneId, facts }, {});
    // A1 (review PR #125) — a refused write is NOT an applied one. writeFragment
    // returns { quarantined: true, path: <quarantine sidecar>, container, reason,
    // remedy } when the unit's key already lives inside a grouped container: the
    // facts never reach the store. Reporting that as APPLIED with `path` in
    // `fragment_path` names the quarantine sidecar as if it were the fragment, and
    // `written: false` cannot disambiguate it — that is the very same value the
    // idempotent no-op returns. Own verdict, `fragment_path: null`, and the
    // quarantine path in a field of its own.
    if (result.quarantined) {
      return {
        verdict: 'QUARANTINED',
        written: false,
        quarantine_path: result.path,
        container: result.container,
        reason: result.reason,
        remedy: result.remedy,
        already_present: checked.already,
        deduped_in_batch: checked.dedupedInBatch,
        fragment_path: null,
        dst_facts_total: total,
        preview: opts.preview || false
      };
    }
    written = result.created;
    fragmentPath = result.path;
  }
  return { verdict: 'APPLIED', written, already_present: checked.already, deduped_in_batch: checked.dedupedInBatch, fragment_path: fragmentPath, dst_facts_total: total, preview: opts.preview || false };
}

function parseArgs(argv) {
  const out = { cwd: process.cwd(), apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (['--milestone', '--cwd', '--selection'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} exige um valor`);
      out[arg.slice(2)] = argv[++i];
    } else throw new Error(`argumento desconhecido: ${arg}`);
  }
  if (!out.milestone) throw new Error('--milestone é obrigatório');
  if (out.apply && !out.selection) throw new Error('--apply exige --selection');
  return out;
}

function cliMain(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); process.exitCode = 2; return; }
  const cwd = path.resolve(options.cwd);
  if (!options.apply) {
    const result = planDistill(cwd, options.milestone);
    process.stdout.write(options.json ? JSON.stringify(result) + '\n' : `forge-distill: ${result.verdict}\nfiles=${result.files_examined} candidates=${result.candidates_total}\n`);
    return;
  }
  try {
    const selection = loadSelection(options.selection);
    const plan = planDistill(cwd, options.milestone);
    process.stdout.write(previewText(plan, selection));
    const result = applyDistill(cwd, options.milestone, selection, options);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`${error.reason || 'apply-error'}${error.detail ? `: ${error.detail}` : ''}\n`);
    process.exitCode = error.exitCode || 1;
  }
}

module.exports = { applyDistill, loadSelection, dstMemId, planDistill, checkEligibility, _private: { CATEGORIES, WRAPPER_CITATION_RES, DISTILL_BUDGET_FACTS, DISTILL_CONFIDENCE_BASE, matchedCitation, validateAgainstPlan, validateSelectionShape, checkBudget, checkCollisions, parseArgs, previewText, arrayValues, parseInlineFlow, createIdAssigner, extractSource, sourceFiles, wrapperRoot, findBySuffix, labelledBullets, anyLabelledBullets, containAnyLabels, ANY_LABEL_UNIT_CAP, HEADINGS, LABELS } };
if (require.main === module) cliMain(process.argv.slice(2));
