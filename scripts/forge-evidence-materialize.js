#!/usr/bin/env node
'use strict';

/**
 * forge-evidence-materialize.js — writes the RUNTIME-OBSERVED evidence the
 * codex adapter collected into `.gsd/forge/evidence-{unitId}.jsonl`.
 *
 * Why a separate script instead of letting the adapter append the lines
 * (route (a), not route (b), S04-PLAN § Rota de gravação escolhida): the
 * invariant "only the orchestrator writes `.gsd/**`" is the exact surface
 * `assertNoProtectedSidecarChanges` exists to deny. The adapter therefore
 * carries the evidence as an ADDITIVE result-file field (`runtime_evidence`,
 * T02) and this script — invoked BY the orchestrator at step 7 of the sidecar
 * state machine — is the only thing that touches the jsonl. Same mold as
 * `forge-route-audit.js` (TASK-021: the completer only invokes) and
 * `forge-verifier.js`.
 *
 * Two floors this file holds, both proven in the paired suite:
 *
 *   1. ANTI-SILENCE. Every invocation appends EXACTLY ONE `kind:"census"`
 *      line — including when nothing else is written. Silence in the artifact
 *      a human reads is indistinguishable from a broken collector, which is
 *      the defect this milestone is about. And the three outcomes render
 *      DISTINCT: `collected` with `admitted === 0` is COLLECTED-AND-EMPTY and
 *      never collapses into `not-collected`. Direct precedent: S07's
 *      `pairs_compared === 0` is `inconclusive`, never `clean`.
 *   2. `source: 'codex-runtime'`, NEVER `codex-sidecar`. `codex-sidecar`
 *      already marks the LEGACY synthesized lines (`.gsd/CODING-STANDARDS.md
 *      § Evidência`), which are preserved (D7). Writing both under one value
 *      would make the two indistinguishable — the opposite of the point — so
 *      the source is forced here rather than trusted from the payload.
 *
 * `exit 0` always (arg errors aside): advisory, never blocks the loop.
 */

const fs = require('fs');
const path = require('path');

// Required for a real dependency, not decoration: ADMISSIBLE_TYPES is T01's
// closed list of variants that may become evidence, and MAX_FIELD_CHARS is its
// per-field cap. Re-declaring either here would let the two drift while both
// still looked well-formed.
const { ADMISSIBLE_TYPES, MAX_FIELD_CHARS } = require('./forge-evidence-admit');

// The closed outcome enum shared with T01's census. A fourth value must be
// declared here, never improvised at a call site.
const OUTCOMES = Object.freeze({
  COLLECTED: 'collected',
  NOT_COLLECTED: 'not-collected',
  COLLECTOR_FAILED: 'collector-failed',
});
const OUTCOME_VALUES = Object.freeze(Object.values(OUTCOMES));

// Entry `kind` per admissible variant. Confronted with ADMISSIBLE_TYPES below
// rather than assumed: if T01 makes a third variant admissible without a kind
// landing here, that must fail loudly instead of silently writing entries this
// script cannot name.
const KIND_BY_ADMISSIBLE_TYPE = Object.freeze({
  commandExecution: 'command',
  fileChange: 'file',
});

const MAX_LINE_BYTES = 512;   // same per-line cap as forge-hook.js:676-684
// Caps for the fields the LAST truncation degree retains. Every retained field
// needs one: a field left unbounded there defeats MAX_LINE_BYTES entirely,
// since that degree is the one with nothing left to shrink after it.
const TS_CAP_CHARS = 40;      // an ISO-8601 instant is 24
const KIND_CAP_CHARS = 32;
const UNIT_CAP_CHARS = 120;   // matches evidenceFileName's own unit slice
const CENSUS_KIND = 'census';
const SOURCE = 'codex-runtime';
const LEGACY_SOURCE = 'codex-sidecar'; // named so the guard below reads as a guard

function admissibleKindCoverage() {
  const mapped = Object.keys(KIND_BY_ADMISSIBLE_TYPE);
  const missing = ADMISSIBLE_TYPES.filter((t) => !Object.prototype.hasOwnProperty.call(KIND_BY_ADMISSIBLE_TYPE, t));
  const extra = mapped.filter((t) => !ADMISSIBLE_TYPES.includes(t));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`no kind for admissible variant(s): ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`kind declared for non-admissible variant(s): ${extra.join(', ')}`);
    return { ok: false, detail: parts.join('; ') };
  }
  return { ok: true, kinds: new Set(mapped.map((t) => KIND_BY_ADMISSIBLE_TYPE[t])) };
}

// ── File naming ────────────────────────────────────────────────────────────
//
// Same convention §7 already uses: `evidence-{unitId}.jsonl`. A unit id like
// `execute-task/T02` carries a separator, so it is sanitised to a flat name —
// and sanitised rather than joined, because a value arriving from argv must
// never be able to steer the write outside `.gsd/forge/` (`..`, absolute
// prefixes, nested dirs). The result is a file NAME, not a path.
function evidenceFileName(unit) {
  const flat = String(unit == null ? '' : unit)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Dot RUNS are collapsed on top of the class filter: `..` survives the
    // filter (a dot is legal in a name) and, while it can no longer traverse
    // once separators are gone, a file literally named `evidence-..-x.jsonl`
    // reads like an escape attempt succeeded. Leave nothing that has to be
    // re-reasoned about later.
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return `evidence-${flat || 'unknown'}.jsonl`;
}

function truncateField(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function overCap(serialized) {
  return Buffer.byteLength(serialized, 'utf8') > MAX_LINE_BYTES;
}

// ── Stepped truncation ─────────────────────────────────────────────────────
//
// Copied in shape from forge-hook.js:676-684 (shrink the widest fields first,
// then fall back to a sentinel) instead of inventing another scheme. The line
// stays valid JSON at every degree: a truncated line a consumer cannot parse
// is worse than a short one, because it fails at read time far from here.
function serializeEntryLine(entry) {
  const line = { ...entry };
  let serialized = JSON.stringify(line);
  if (!overCap(serialized)) return serialized;

  if (typeof line.cmd === 'string') line.cmd = truncateField(line.cmd, 80);
  if (typeof line.file === 'string') line.file = truncateField(line.file, 200);
  if (typeof line.cwd === 'string') line.cwd = truncateField(line.cwd, 80);
  serialized = JSON.stringify(line);
  if (!overCap(serialized)) return serialized;

  if (typeof line.cmd === 'string') line.cmd = '[truncated]';
  if (typeof line.file === 'string') line.file = '[truncated]';
  if (typeof line.cwd === 'string') line.cwd = '[truncated]';
  line.truncated = true;
  serialized = JSON.stringify(line);
  if (!overCap(serialized)) return serialized;

  // Last degree: keep only the fields that make the line meaningful at all —
  // and BOUND each of them. Retaining `ts`/`kind`/`unit` verbatim meant the
  // documented 512-byte cap was not actually guaranteed at the final step
  // (measured: 2000-char values produced a 6071-byte line), so the one degree
  // whose job is to stop the growth was the one that did not.
  serialized = JSON.stringify({
    ts: truncateField(line.ts, TS_CAP_CHARS),
    source: SOURCE,
    kind: truncateField(line.kind, KIND_CAP_CHARS),
    unit: truncateField(line.unit, UNIT_CAP_CHARS),
    truncated: true,
  });
  if (!overCap(serialized)) return serialized;

  // Character caps are not byte caps: multi-byte values can still exceed 512
  // even when bounded by length, so the cap is RE-CHECKED and the last resort
  // is a line with no caller-controlled bytes at all. Still a line, never a
  // dropped one — silence is the failure mode this file exists to deny.
  return JSON.stringify({ source: SOURCE, kind: 'unrepresentable', truncated: true });
}

function topEntries(obj, limit) {
  const out = {};
  let count = 0;
  for (const key of Object.keys(obj || {})) {
    if (count >= limit) break;
    out[key] = obj[key];
    count += 1;
  }
  return out;
}

function serializeCensusLine(census) {
  const line = { ...census };
  let serialized = JSON.stringify(line);
  if (!overCap(serialized)) return serialized;

  line.types_seen = topEntries(line.types_seen, 5);
  line.rejected = Array.isArray(line.rejected) ? line.rejected.slice(0, 5) : line.rejected;
  line.truncated = true;
  serialized = JSON.stringify(line);
  if (!overCap(serialized)) return serialized;

  // The counters survive to the end: they are what makes the census a census.
  // Every retained STRING is bounded for the same reason as serializeEntryLine's
  // last degree (R10): `unit` was already capped here, but `ts`/`outcome`/
  // `reason` were not, and one unbounded field is enough to blow the cap.
  serialized = JSON.stringify({
    ts: truncateField(line.ts, TS_CAP_CHARS),
    source: SOURCE,
    kind: CENSUS_KIND,
    unit: truncateField(line.unit, UNIT_CAP_CHARS),
    outcome: truncateField(line.outcome, KIND_CAP_CHARS),
    reason: line.reason == null ? null : truncateField(line.reason, 120),
    items_received: line.items_received,
    admitted: line.admitted,
    written: line.written,
    truncated: true,
  });
  if (!overCap(serialized)) return serialized;

  // Same last resort as the entry path: no caller-controlled bytes, but still a
  // census line — the one line every invocation is required to produce.
  return JSON.stringify({
    source: SOURCE, kind: CENSUS_KIND, outcome: 'unrepresentable', truncated: true,
  });
}

// ── Reading the payload ────────────────────────────────────────────────────
//
// Returns { outcome, reason, payload } — never throws. `field-absent` is
// decided by hasOwnProperty, not by truthiness: `runtime_evidence: null` is a
// present-but-malformed field, and conflating it with a missing one would let
// an absent field be reported as anything other than `not-collected`.
function classifyPayload(resultFile) {
  let raw;
  try {
    raw = fs.readFileSync(resultFile, 'utf8');
  } catch (error) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'result-file-unreadable', detail: error.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'result-file-unparseable', detail: error.message };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'result-file-not-an-object' };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'runtime_evidence')) {
    // The single most important branch in this file: an ABSENT field can only
    // ever be `not-collected`. Rendering it as `collected` with zero entries
    // would claim a collection that never happened.
    return { outcome: OUTCOMES.NOT_COLLECTED, reason: 'field-absent' };
  }

  const field = parsed.runtime_evidence;
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'malformed-field', detail: 'runtime_evidence is not an object' };
  }
  const census = field.census;
  if (!census || typeof census !== 'object' || Array.isArray(census)) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'malformed-field', detail: 'runtime_evidence.census is not an object' };
  }
  if (!OUTCOME_VALUES.includes(census.outcome)) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'malformed-field', detail: `census.outcome '${census.outcome}' is outside the closed enum` };
  }
  if (!Array.isArray(field.entries)) {
    return { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'malformed-field', detail: 'runtime_evidence.entries is not an array' };
  }
  if (census.outcome === OUTCOMES.COLLECTOR_FAILED) {
    return {
      outcome: OUTCOMES.COLLECTOR_FAILED,
      reason: 'collector-reported-failure',
      detail: typeof census.reason === 'string' ? census.reason : null,
      census,
    };
  }
  if (census.outcome === OUTCOMES.NOT_COLLECTED) {
    return { outcome: OUTCOMES.NOT_COLLECTED, reason: 'collector-reported-not-collected', census };
  }
  return { outcome: OUTCOMES.COLLECTED, reason: null, census, entries: field.entries };
}

// ── materialize ────────────────────────────────────────────────────────────
//
// entries[].file / .cmd / .cwd are DATA, never instructions: nothing here
// resolves, stats or opens them — they are serialised as text and that is all.
// Same reasoning as the path-traversal guard in `validatePlanResult:463-464`;
// a path chosen by the sidecar must not be able to make the orchestrator
// touch the filesystem on its behalf.
function materialize(options) {
  const opts = options || {};
  const unit = String(opts.unit == null ? '' : opts.unit);
  const cwd = String(opts.cwd || process.cwd());
  const nowIso = typeof opts.now === 'string' ? opts.now : new Date().toISOString();

  const evidenceDir = path.join(cwd, '.gsd', 'forge');
  const fileName = evidenceFileName(unit);
  const evidenceFile = path.join(evidenceDir, fileName);

  let verdict = classifyPayload(opts.result);

  const coverage = admissibleKindCoverage();
  if (!coverage.ok && verdict.outcome === OUTCOMES.COLLECTED) {
    verdict = { outcome: OUTCOMES.COLLECTOR_FAILED, reason: 'admissible-kind-coverage-diverged', detail: coverage.detail, census: verdict.census };
  }

  const census = verdict.census && typeof verdict.census === 'object' ? verdict.census : {};
  const collected = verdict.outcome === OUTCOMES.COLLECTED;
  const sourceEntries = collected && Array.isArray(verdict.entries) ? verdict.entries : [];

  // The closed set of kinds an ENTRY line may carry — derived from T01's
  // admissible variants, never from the payload. Deliberately excludes
  // CENSUS_KIND: a payload entry claiming `kind:"census"` was written verbatim
  // as a SECOND census line, stamped `source: codex-runtime`, breaking the
  // exactly-one-census floor this file's header promises. `source` is already
  // forced for that same disguise reason; `kind` had been left trusted.
  const entryKinds = new Set(Object.values(KIND_BY_ADMISSIBLE_TYPE));

  const lines = [];
  for (const entry of sourceEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // An unrecognised kind is not silently dropped (that would be the silence
    // above) and not passed through (that is the disguise): it is NAMED, so the
    // line still appears and a reader can see the payload sent something this
    // script cannot classify.
    const kind = typeof entry.kind === 'string' && entryKinds.has(entry.kind)
      ? entry.kind
      : 'unclassified';
    lines.push(serializeEntryLine({
      ...entry,
      // Forced, not trusted: a payload claiming `codex-sidecar` must not be
      // able to disguise runtime lines as the legacy synthesized ones.
      source: SOURCE,
      kind,
      unit: unit || (typeof entry.unit === 'string' ? entry.unit : null),
      cmd: typeof entry.cmd === 'string' ? truncateField(entry.cmd, MAX_FIELD_CHARS) : entry.cmd,
      file: typeof entry.file === 'string' ? truncateField(entry.file, MAX_FIELD_CHARS) : entry.file,
    }));
  }

  const censusLine = {
    ts: nowIso,
    source: SOURCE,
    kind: CENSUS_KIND,
    unit,
    outcome: verdict.outcome,
    reason: verdict.reason || null,
    detail: verdict.detail || null,
    items_received: typeof census.items_received === 'number' ? census.items_received : 0,
    types_seen: census.types_seen && typeof census.types_seen === 'object' ? census.types_seen : {},
    admitted: collected && typeof census.admitted === 'number' ? census.admitted : 0,
    inadmissible: collected && typeof census.inadmissible === 'number' ? census.inadmissible : 0,
    rejected: collected && Array.isArray(census.rejected) ? census.rejected : [],
    turn_status: typeof census.turn_status === 'string' ? census.turn_status : null,
    written: lines.length,
  };

  const payloadLines = [serializeCensusLine(censusLine), ...lines];

  let writeError = null;
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.appendFileSync(evidenceFile, `${payloadLines.join('\n')}\n`, 'utf8');
  } catch (error) {
    // Report-only degradation with a named reason (S04-PLAN contract 8): a
    // failed append must not take the unit down, but it must not be reported
    // as a successful materialisation either.
    writeError = error.message;
  }

  return {
    outcome: verdict.outcome,
    reason: verdict.reason || null,
    detail: verdict.detail || null,
    unit,
    file: evidenceFile,
    written: writeError ? 0 : payloadLines.length,
    entries_written: writeError ? 0 : lines.length,
    census_written: writeError ? 0 : 1,
    items_received: censusLine.items_received,
    types_seen: censusLine.types_seen,
    admitted: censusLine.admitted,
    write_error: writeError,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { result: null, unit: null, cwd: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--result' || arg === '--unit' || arg === '--cwd') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a value` };
      out[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  if (!out.result) return { error: '--result <file> is required' };
  if (!out.unit) return { error: '--unit <unitId> is required' };
  return out;
}

function main() {
  // Arg guards run before any file read — exit 2 is "you called me wrong",
  // kept distinct from the advisory exit 0 of every real outcome.
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`forge-evidence-materialize: ${args.error}\n`);
    process.exit(2);
  }

  const result = materialize({ result: args.result, unit: args.unit, cwd: args.cwd || process.cwd() });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.outcome}${result.reason ? ` (${result.reason})` : ''} — ${result.written} line(s) → ${result.file}\n`);
  }
  process.exit(0); // advisory, always
}

if (require.main === module) main();

module.exports = {
  OUTCOMES,
  OUTCOME_VALUES,
  KIND_BY_ADMISSIBLE_TYPE,
  MAX_LINE_BYTES,
  SOURCE,
  LEGACY_SOURCE,
  CENSUS_KIND,
  evidenceFileName,
  admissibleKindCoverage,
  classifyPayload,
  serializeEntryLine,
  serializeCensusLine,
  materialize,
  parseArgs,
};
