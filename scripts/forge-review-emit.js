#!/usr/bin/env node
/**
 * forge-review-emit.js — the ONLY writer of the `review` telemetry event.
 *
 * Why this exists: the Step 8 event used to be a JSON template in
 * `shared/forge-review.md` that the orchestrator retyped by hand each slice.
 * Measured outcome in one workspace: 265 `review` events, 151 distinct key
 * shapes, ZERO conformant rows. `intra_family_debate` — the field whose whole
 * job is to flag a debate that collapsed into one family — appeared once, and
 * a human had to notice by hand what the field was designed to announce. Two
 * rows recorded the advocate as the prose string
 * `not-invoked-orchestrator-verified-by-direct-reading`: the gate had degraded
 * into self-review and nothing in the pipeline objected.
 *
 * A schema a model retypes is a schema that drifts. This emitter takes the
 * resolved values as flags and constructs the line itself, so:
 *   - every canonical field is present in every row, in a fixed order;
 *   - `intra_family_debate` is DERIVED, never asserted by the caller;
 *   - a malformed invocation fails loudly (exit 2) instead of writing a
 *     plausible-looking row that no reader can aggregate.
 *
 * Derivation beats declaration for intra_family_debate specifically. The bash
 * in Step 0 compared a *family* against an *engine*
 * (`$ADVOCATE_FAMILY != $AUTHOR_ENGINE`), which happens to be right only while
 * every advocate is Claude: once a gpt advocate exists (`--mode defend`),
 * 'gpt' != 'codex' is true for the same family and the flag inverts. This
 * module maps both sides to a family first and compares like with like.
 *
 * The flag means what its name says: the two debaters came from ONE family.
 * It deliberately does NOT also require that family to differ from the
 * author's. That extra clause looks like a refinement and is actually a blind
 * spot: under the SHIPPED defaults (`challenger: claude`, `advocate: claude`,
 * and an explicit path that assumes `AUTHOR_ENGINE=claude`) every debater and
 * the author land in one family, so the clause would hold the flag at `false`
 * on every review of every default-configured project — a debate with zero
 * cross-family adversarialidade filed as "no collapse". That is the same
 * silence this emitter was built to end, re-entering through the derivation.
 * A Claude challenging Claude-authored code defended by Claude IS the collapse,
 * whether or not the author shares the room.
 *
 * `author_engine` is therefore recorded, not just consumed. The flag itself is
 * recomputable without it — challenger and advocate are both in the row — but
 * WHICH collapse it found is not: debaters agreeing on a family that is not the
 * author's (the M134/S02 shape) reads identically to everyone, author included,
 * sitting in one family (the default shape). Both are `true`; this field is what
 * separates them.
 *
 * CLI:
 *   node forge-review-emit.js --cwd <dir> --milestone <id> --slice <id>
 *     [--events <file>] [--style dialectic|flags] [--rounds N]
 *     [--engine agents|workflow] --author-engine claude|codex|gemini
 *     [--challenger claude|codex|gemini] [--advocate <alias>]
 *     [--resolved N] [--conceded N] [--open N] [--conceded-fixed N]
 *     [--intra-family-withdrawn N]
 *     [--unavailable-reason <enum> [--attempts N]]
 *     [--efforts-json '<json>'|@<file>]
 *     [--json] [--dry-run]
 *
 * Exit: 0 wrote (or dry-ran); 2 invalid arguments. I/O errors propagate as a
 * non-zero throw — Step 8 is explicit that event-log writes never silent-fail.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { modelFamily, engineFamily } = require('./forge-model-alias.js');

const STYLES = ['dialectic', 'flags'];
const ENGINES = ['agents', 'workflow'];
const CHALLENGERS = ['claude', 'codex', 'gemini'];
const UNAVAILABLE_REASONS = [
  'review-advocate-unavailable',
  'review-challenger-unavailable',
  'review-rebuttal-unavailable',
];

// Challenger/advocate arrive as short tokens ('codex', 'gemini', 'fable',
// 'opus'); author arrives as a dispatch engine ('claude', 'codex'). modelFamily
// resolves every one of those by substring, and engineFamily is tried first for
// the author so the closed engine enum keeps its exact-match semantics.
function familyOf(token) {
  if (token === null || token === undefined || String(token).trim() === '') return null;
  return engineFamily(token) || modelFamily(token);
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function parseCount(raw, flag, errors) {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!isNonNegativeInt(parsed)) {
    errors.push(`${flag} must be a non-negative integer (got ${JSON.stringify(raw)})`);
    return 0;
  }
  return parsed;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, positional };
}

/**
 * Build the canonical `review` row. Returns { event, errors }. `errors` is
 * non-empty only for caller mistakes the emitter refuses to paper over —
 * a missing scope, an out-of-enum value, a negative count.
 */
function buildReviewEvent(opts) {
  const errors = [];
  const options = opts || {};

  const milestone = typeof options.milestone === 'string' ? options.milestone.trim() : '';
  const slice = typeof options.slice === 'string' ? options.slice.trim() : '';
  if (milestone === '') errors.push('--milestone is required (RUN_ID or {M###})');
  if (slice === '') errors.push('--slice is required ({S##} or {TASK_ID})');

  const style = options.style === undefined ? 'dialectic' : String(options.style).toLowerCase();
  if (!STYLES.includes(style)) errors.push(`--style must be one of ${STYLES.join('|')}`);

  const engine = options.engine === undefined ? 'agents' : String(options.engine).toLowerCase();
  if (!ENGINES.includes(engine)) errors.push(`--engine must be one of ${ENGINES.join('|')}`);

  const challenger =
    options.challenger === undefined ? 'claude' : String(options.challenger).toLowerCase();
  if (!CHALLENGERS.includes(challenger)) {
    errors.push(`--challenger must be one of ${CHALLENGERS.join('|')}`);
  }

  let rounds = options.rounds === undefined ? 1 : Number(options.rounds);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 3) {
    errors.push('--rounds must be an integer in 0..3');
    rounds = 1;
  }

  // An advocate that never ran is `null` — the same glue the rest of the event
  // uses for "resolved to nothing". It is NEVER a sentence describing what the
  // orchestrator did instead; that is the drift this emitter exists to stop.
  const rawAdvocate =
    typeof options.advocate === 'string' ? options.advocate.trim() : '';
  const advocate = rawAdvocate === '' || rawAdvocate.toLowerCase() === 'null' ? null : rawAdvocate;
  if (advocate !== null && /\s/.test(advocate)) {
    errors.push(
      `--advocate must be a model alias or id, not prose (got ${JSON.stringify(rawAdvocate)})`
    );
  }

  const counts = {
    resolved: parseCount(options.resolved, '--resolved', errors),
    conceded: parseCount(options.conceded, '--conceded', errors),
    open: parseCount(options.open, '--open', errors),
  };
  const concededFixed = parseCount(options.concededFixed, '--conceded-fixed', errors);
  if (concededFixed > counts.conceded) {
    errors.push(
      `--conceded-fixed (${concededFixed}) cannot exceed --conceded (${counts.conceded})`
    );
  }

  // Required — but NOT because the flag depends on it. It does not: the
  // derivation below compares challenger to advocate, and both are in the row.
  // What this value decides is which collapse the row describes, and a row that
  // cannot answer that is the incomplete row this emitter exists to stop
  // shipping (265 events, 151 key shapes, none aggregatable). That is a weaker
  // reason than "otherwise we derive a wrong boolean" — which is what it was
  // before the author clause left the formula — and it is the honest one. The
  // cost of exit 2 is a re-run with the flag added, which Step 8 already
  // prescribes over appending a hand-built line.
  const rawAuthorEngine =
    typeof options.authorEngine === 'string' ? options.authorEngine.trim() : '';
  const authorEngine = rawAuthorEngine.toLowerCase();
  const authorFamily = familyOf(authorEngine);
  if (rawAuthorEngine === '') {
    errors.push(
      '--author-engine is required (claude|codex|gemini) — ' +
        'the row must record who wrote the code under review'
    );
  } else if (authorFamily === null) {
    errors.push(
      `--author-engine did not resolve to a known family (got ${JSON.stringify(rawAuthorEngine)})`
    );
  }

  // Derived, never taken on the caller's word. Both debaters in one family IS
  // the collapse; the author's family is recorded alongside rather than folded
  // into this test — see the header for the blind spot that folding creates.
  const challengerFamily = familyOf(challenger);
  const advocateFamily = advocate === null ? null : familyOf(advocate);
  const intraFamily = Boolean(
    challengerFamily && advocateFamily && challengerFamily === advocateFamily
  );

  let intraFamilyWithdrawn = parseCount(
    options.intraFamilyWithdrawn,
    '--intra-family-withdrawn',
    errors
  );
  // Step 8 is explicit: this count is always 0 when the debate was not
  // intra-family. Clamping here keeps that invariant out of the caller's hands.
  if (!intraFamily) intraFamilyWithdrawn = 0;

  const event = {
    ts: options.ts || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    event: 'review',
    milestone,
    slice,
    style,
    rounds,
    counts,
    conceded_fixed: concededFixed,
    engine,
    author_engine: authorEngine,
    challenger,
    advocate,
    intra_family_debate: intraFamily,
    intra_family_withdrawn: intraFamilyWithdrawn,
  };

  return { event, errors, derived: { authorFamily, challengerFamily, advocateFamily } };
}

function buildUnavailableEvent(opts) {
  const errors = [];
  const options = opts || {};
  const reason = String(options.unavailableReason || '');
  if (!UNAVAILABLE_REASONS.includes(reason)) {
    errors.push(`--unavailable-reason must be one of ${UNAVAILABLE_REASONS.join('|')}`);
  }
  const attempts = parseCount(options.attempts, '--attempts', errors);
  return {
    event: {
      ts: options.ts || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      event: 'review-agent-unavailable',
      milestone: typeof options.milestone === 'string' ? options.milestone.trim() : '',
      slice: typeof options.slice === 'string' ? options.slice.trim() : '',
      reason,
      attempts,
    },
    errors,
  };
}

// Optional per-leg effort telemetry (`--efforts-json`). Closed shape so a
// retyped payload cannot drift: legs ⊆ challenge|defense|rebuttal|fix, each with
// exactly requested/resolved/sent/applied/reason/diagnostics. `applied` is
// always null — no transport reads back what a provider applied.
const EFFORT_LEGS = ['challenge', 'defense', 'rebuttal', 'fix'];
const EFFORT_FIELDS = ['requested', 'resolved', 'sent', 'applied', 'reason', 'diagnostics'];
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseEfforts(raw, errors) {
  let value;
  try {
    const text = String(raw);
    value = JSON.parse(text.startsWith('@') ? fs.readFileSync(text.slice(1), 'utf8') : text);
  } catch (error) {
    errors.push(`--efforts-json must be JSON or @file (${(error && error.message) || error})`);
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('--efforts-json must be an object keyed by leg');
    return null;
  }
  const out = {};
  for (const [leg, entry] of Object.entries(value)) {
    if (!EFFORT_LEGS.includes(leg)) { errors.push(`--efforts-json leg must be one of ${EFFORT_LEGS.join('|')} (got ${JSON.stringify(leg)})`); continue; }
    const keys = entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : null;
    if (!keys || keys.length !== EFFORT_FIELDS.length || EFFORT_FIELDS.some((field) => !keys.includes(field))) {
      errors.push(`--efforts-json.${leg} must have exactly ${EFFORT_FIELDS.join(', ')}`);
      continue;
    }
    const nullableEffort = (field) => entry[field] === null || EFFORT_VALUES.includes(entry[field]);
    if (!nullableEffort('requested') || !nullableEffort('resolved')) errors.push(`--efforts-json.${leg} requested/resolved must be an effort or null`);
    if (entry.sent !== null && (typeof entry.sent !== 'string' || !/^(?:low|medium|high|xhigh|max|agent-frontmatter:(?:low|medium|high|xhigh|max))$/.test(entry.sent))) {
      errors.push(`--efforts-json.${leg}.sent must be an effort, agent-frontmatter:<effort> or null`);
    }
    if (entry.applied !== null) errors.push(`--efforts-json.${leg}.applied must be null (no provider readback exists)`);
    if (entry.reason !== null && (typeof entry.reason !== 'string' || entry.reason.length > 200 || /[\r\n]/.test(entry.reason))) {
      errors.push(`--efforts-json.${leg}.reason must be a short single-line string or null`);
    }
    if (!Array.isArray(entry.diagnostics) || entry.diagnostics.some((item) => !item || typeof item !== 'object'
        || typeof item.code !== 'string' || !/^[a-z0-9-]{1,80}$/.test(item.code))) {
      errors.push(`--efforts-json.${leg}.diagnostics must be a list of {code} objects`);
    }
    out[leg] = {
      requested: entry.requested, resolved: entry.resolved, sent: entry.sent, applied: null,
      reason: entry.reason, diagnostics: Array.isArray(entry.diagnostics) ? entry.diagnostics.map((item) => ({ code: item && item.code })) : [],
    };
  }
  return out;
}

function eventsPathFor(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'events.jsonl');
}

// I/O errors deliberately propagate: Step 8 says event-log writes never
// silent-fail, and a review whose telemetry vanished is indistinguishable from
// a review that never ran.
function appendEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function runCli(argv) {
  const { flags } = parseArgs(argv);
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const file = typeof flags.events === 'string' ? flags.events : eventsPathFor(cwd);

  const opts = {
    milestone: flags.milestone,
    slice: flags.slice,
    style: flags.style,
    rounds: flags.rounds,
    engine: flags.engine,
    challenger: flags.challenger,
    advocate: flags.advocate,
    authorEngine: flags['author-engine'],
    resolved: flags.resolved,
    conceded: flags.conceded,
    open: flags.open,
    concededFixed: flags['conceded-fixed'],
    intraFamilyWithdrawn: flags['intra-family-withdrawn'],
    ts: typeof flags.ts === 'string' ? flags.ts : undefined,
  };

  const built = buildReviewEvent(opts);
  const errors = built.errors.slice();
  // Absent flag → the review row is byte-identical to the historical one.
  if (flags['efforts-json'] !== undefined) {
    const efforts = flags['efforts-json'] === true ? (errors.push('--efforts-json requires a value'), null)
      : parseEfforts(flags['efforts-json'], errors);
    if (efforts) built.event.efforts = efforts;
  }
  const lines = [built.event];

  if (flags['unavailable-reason'] !== undefined) {
    const companion = buildUnavailableEvent({
      milestone: opts.milestone,
      slice: opts.slice,
      unavailableReason: flags['unavailable-reason'],
      attempts: flags.attempts,
      ts: opts.ts,
    });
    errors.push(...companion.errors);
    lines.push(companion.event);
  }

  if (errors.length > 0) {
    process.stderr.write(
      'forge-review-emit: refusing to write a malformed review event:\n' +
        errors.map((e) => `  - ${e}`).join('\n') +
        '\n'
    );
    return 2;
  }

  if (flags['dry-run'] !== true) appendEvents(file, lines);

  if (flags.json === true) {
    process.stdout.write(JSON.stringify(lines.length === 1 ? lines[0] : lines) + '\n');
  } else {
    const shape = built.event.intra_family_debate ? ' intra-family=TRUE' : '';
    process.stdout.write(
      `review event: ${built.event.milestone}/${built.event.slice} ` +
        `author=${built.event.author_engine} challenger=${built.event.challenger} ` +
        `advocate=${built.event.advocate}${shape}\n`
    );
  }
  return 0;
}

module.exports = { buildReviewEvent, buildUnavailableEvent, appendEvents, familyOf, parseEfforts, runCli };

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
