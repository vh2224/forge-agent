#!/usr/bin/env node
'use strict';

/**
 * forge-evidence-admit.js — which `ThreadItem` variants of the codex app-server
 * stream may become EVIDENCE, declared by name for all 18, plus the shape of a
 * runtime-observed evidence entry (the contract S04/T02 and S04/T03 consume).
 *
 * Why admissibility is declared per name instead of "take whatever has text":
 * `agentMessage`, `reasoning` and `plan` are prose the MODEL wrote. Feeding
 * those back as evidence would reproduce the TASK-021 class one layer up —
 * model-authored narration standing in for measurement — and it would be worse
 * there, because arriving inside a typed JSON envelope makes it *look*
 * structured. Only fields the RUNTIME emits (`exitCode`, `durationMs`,
 * `status`, `cwd`, `changes[].path/kind`) are admissible (D7, IN-3).
 *
 * Three floors this module exists to hold, each proven in both directions by
 * the paired suite (forge-evidence-admit.test.js), never merely asserted:
 *
 *   1. Anti-silence. `collected` with `admitted === 0` is COLLECTED-AND-EMPTY
 *      and must never collapse into `not-collected` (which this module never
 *      emits at all — it belongs to the materializer, T03) nor into
 *      `collector-failed`. Three distinct outcomes, none substitutable.
 *      Direct precedent: S07's `pairs_compared === 0` is `inconclusive`, never
 *      `clean`; and `readTouched`'s `null` which never equals `[]`.
 *   2. Unknown variant is REJECTED, never passed through. A variant added
 *      upstream must FAIL this guard loudly rather than slip into evidence
 *      unclassified — "pass it through, it's probably fine" is exactly how an
 *      unaudited source becomes authoritative by accident.
 *   3. The count of 18 is CONFRONTED with the pinned schema, never hardcoded
 *      and trusted. A literal 18 that nobody checks against the pin is the
 *      inert guard this project rejects on sight.
 */

const fs = require('fs');
const path = require('path');

// pinPath() is reused rather than re-derived: forge-schema-pin.js already owns
// the pin's location (including the FORGE_SCHEMA_PIN_FILE override), and a
// second copy of that resolution would drift the day the pin moves. Requiring
// it is side-effect free — its CLI sits behind `require.main === module`.
const { pinPath } = require('./forge-schema-pin');

// ── Reason classes ─────────────────────────────────────────────────────────
//
// A closed vocabulary of exactly four. A fifth must be DECLARED here, never
// improvised at a call site, so the doc table and the map cannot diverge in
// vocabulary while both looking well-formed.
const REASONS = Object.freeze({
  RUNTIME_OBSERVED: 'runtime-observed',
  MODEL_AUTHORED: 'model-authored',
  TOOL_RESULT_UNVERIFIED: 'tool-result-unverified',
  SESSION_LIFECYCLE: 'session-lifecycle',
});

// ── The 18 variants, each with an explicit verdict and reason ───────────────
//
// Nothing is classified by omission: a variant absent from this map is not
// "assumed inadmissible", it fails assertVariantCoverage by name. Order mirrors
// `definitions.ThreadItem.oneOf` in the 0.144.4 pin for reviewability, but
// nothing depends on the order — the confrontation is set-based.
const VARIANT_ADMISSIBILITY = Object.freeze({
  userMessage: Object.freeze({
    admissible: false, reason: REASONS.MODEL_AUTHORED,
    note: 'Prompt text authored outside the runtime; says nothing about work performed on the code.',
  }),
  hookPrompt: Object.freeze({
    admissible: false, reason: REASONS.MODEL_AUTHORED,
    note: 'Injected prompt fragments — input to the model, not an observation of execution.',
  }),
  agentMessage: Object.freeze({
    admissible: false, reason: REASONS.MODEL_AUTHORED,
    note: 'The model\'s own narration. Admitting it is the TASK-021 defect wearing a JSON envelope.',
  }),
  plan: Object.freeze({
    admissible: false, reason: REASONS.MODEL_AUTHORED,
    note: 'A statement of intent written by the model; intent is not evidence of execution.',
  }),
  reasoning: Object.freeze({
    admissible: false, reason: REASONS.MODEL_AUTHORED,
    note: 'Chain-of-thought text. Maximally persuasive, zero runtime attestation.',
  }),
  commandExecution: Object.freeze({
    admissible: true, reason: REASONS.RUNTIME_OBSERVED,
    note: 'exitCode/durationMs/status/cwd are emitted by the runtime that ran the process.',
  }),
  fileChange: Object.freeze({
    admissible: true, reason: REASONS.RUNTIME_OBSERVED,
    note: 'changes[].path/kind plus the patch-apply status are runtime facts about the filesystem.',
  }),
  mcpToolCall: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'The runtime relays the tool result; it attests no exit code of its own for the work.',
  }),
  dynamicToolCall: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'Carries a self-reported `success` flag — a claim by the tool, not a measured exit code.',
  }),
  collabAgentToolCall: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'Another agent\'s prompt/state; admitting it makes a second model\'s narration evidence.',
  }),
  subAgentActivity: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'Sub-agent lifecycle marker; the work itself surfaces (if at all) as that agent\'s own items.',
  }),
  webSearch: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'A query and its action; nothing about the repository was executed or changed.',
  }),
  imageView: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'Reading an image is not work performed on the code, and carries no status the runtime signs.',
  }),
  sleep: Object.freeze({
    admissible: false, reason: REASONS.SESSION_LIFECYCLE,
    note: 'Elapsed time only — describes the session, never the code.',
  }),
  imageGeneration: Object.freeze({
    admissible: false, reason: REASONS.TOOL_RESULT_UNVERIFIED,
    note: 'Produces an artifact outside the code under test; savedPath is not a repository change.',
  }),
  enteredReviewMode: Object.freeze({
    admissible: false, reason: REASONS.SESSION_LIFECYCLE,
    note: 'Mode transition of the session; no command ran and no file moved.',
  }),
  exitedReviewMode: Object.freeze({
    admissible: false, reason: REASONS.SESSION_LIFECYCLE,
    note: 'Mode transition of the session; the review verdict is model-authored anyway.',
  }),
  contextCompaction: Object.freeze({
    admissible: false, reason: REASONS.SESSION_LIFECYCLE,
    note: 'Bookkeeping about the model\'s own context window; unrelated to work on the code.',
  }),
});

const ADMISSIBLE_TYPES = Object.freeze(
  Object.keys(VARIANT_ADMISSIBILITY).filter((name) => VARIANT_ADMISSIBILITY[name].admissible)
);

// Sentinel for an item that carries no usable `type`. A named sentinel, not a
// dropped item: an item we cannot even name still has to appear in the census,
// because a silently discarded item is indistinguishable from one never sent.
const MISSING_TYPE = '<missing>';

const MAX_FIELD_CHARS = 200; // cmd/file cap here; the 512B per-line cap is T03's.

function truncate(value, max) {
  const text = String(value == null ? '' : value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ── classifyThreadItem ─────────────────────────────────────────────────────
//
// Returns one of exactly three shapes:
//   admissible   → { admissible: true,  known: true }
//   inadmissible → { admissible: false, known: true,  reason: <class> }
//   unknown      → { admissible: false, known: false, reason: 'unknown-variant' }
//
// The admissible shape deliberately carries NO `reason` key: the contract
// locked in T01-PLAN is asserted by strict equality downstream, so an extra
// key here is a breaking change, not a nicety. The map still records
// `runtime-observed` for those two — that value feeds the doc table, which
// must state a reason for all 18 rows.
//
// `known: false` is a REJECTION, never a pass-through. See floor 2 in the
// header: an upstream variant we have never classified must not become
// evidence by default. Removing this branch silently re-opens that door.
function classifyThreadItem(item) {
  const type = item && typeof item === 'object' && typeof item.type === 'string' ? item.type : null;
  if (type === null || !Object.prototype.hasOwnProperty.call(VARIANT_ADMISSIBILITY, type)) {
    return { admissible: false, known: false, reason: 'unknown-variant' };
  }
  const entry = VARIANT_ADMISSIBILITY[type];
  if (entry.admissible) return { admissible: true, known: true };
  return { admissible: false, known: true, reason: entry.reason };
}

// ── validateAdmissibleItem ─────────────────────────────────────────────────
//
// S04 review R1. Admission used to be decided by the DISCRIMINATOR ALONE: an
// item was admitted because `type === 'commandExecution'`, and the fields the
// entry is actually built from were never looked at. Measured consequences: a
// `commandExecution` with no `command` became an admitted entry with `cmd: ''`
// and null runtime facts — an observation of nothing, indistinguishable in the
// stream from a real one; and a `fileChange` whose `changes[]` elements lack a
// `path` produced entries with `file: ''`, which the file audit then compares
// against real paths.
//
// The two obvious repairs were both rejected. Admitting them anyway is the
// silence this module exists to prevent. Throwing degrades the WHOLE census to
// `collector-failed` over one thin item, destroying the record for every other
// item in the turn — the defence raised at review, and it is correct.
//
// So malformed-known items become their OWN census class: counted, named, and
// kept out of `entries`. `known: true` (we recognise the variant) but not
// admitted (the instance is unusable). A triager reading the census sees the
// difference between "the sidecar ran nothing" and "the sidecar reported five
// commands and two of them arrived unusable".
//
// Returns null when the item is usable, or a named reason string.
function validateAdmissibleItem(item) {
  if (item.type === 'commandExecution') {
    // exitCode/durationMs/status are legitimately absent or null (see the entry
    // builder). `command` is the one field with no meaningful empty value: an
    // entry whose cmd is '' asserts that a command ran and declines to say which.
    if (typeof item.command !== 'string' || item.command.trim().length === 0) {
      return 'empty-command';
    }
    return null;
  }
  if (item.type === 'fileChange') {
    if (!Array.isArray(item.changes)) return 'changes-not-an-array';
    if (item.changes.length === 0) return 'no-changes';
    // Per-ELEMENT malformation does not condemn the item: a 3-file patch with
    // one bad element still carries two real observations, and dropping all
    // three would be the same destruction-over-one-thin-part the item-level
    // rule already refuses. The bad elements are counted separately
    // (`malformed_changes`) so they are never merely discarded.
    if (!item.changes.some(isUsableChange)) return 'no-usable-change';
    return null;
  }
  return null;
}

function isUsableChange(change) {
  return !!change && typeof change === 'object'
    && typeof change.path === 'string' && change.path.trim().length > 0;
}

function itemTypeName(item) {
  if (!item || typeof item !== 'object') return MISSING_TYPE;
  return typeof item.type === 'string' && item.type.length > 0 ? item.type : MISSING_TYPE;
}

// ── buildRuntimeEvidence ───────────────────────────────────────────────────
//
// items = already-unwrapped ThreadItems (params.item OR the item itself).
// Returns { census, entries } — the contract T02 (adapter) and T03
// (materializer) consume.
//
// census.admitted counts admissible ITEMS, not entries: one `fileChange` with
// three `changes[]` is 1 admitted and 3 entries. The identity
// `admitted + inadmissible + Σrejected.count === items_received` therefore
// holds over items, and is checked below — if it ever breaks, an item was
// dropped without being counted, which is the silence this module exists to
// prevent, so it degrades to `collector-failed` rather than reporting a census
// that quietly does not add up.
//
// This collector NEVER takes the unit down (S04-PLAN contract 8): any failure
// becomes `outcome: 'collector-failed'` with a named reason and empty entries.
function buildRuntimeEvidence(items, options) {
  const opts = options || {};
  const unit = typeof opts.unit === 'string' ? opts.unit : null;
  const nowIso = typeof opts.now === 'string' ? opts.now : new Date().toISOString();
  // Raw value as observed, or null. `null` here means "no turn/completed was
  // observed", which is NOT the same as a turn that completed with an unknown
  // status — see S02 R15 in S04-PLAN: a census taken under someone else's turn
  // must stay distinguishable during triage.
  const turnStatus = typeof opts.turnStatus === 'string' ? opts.turnStatus : null;

  // types_seen is keyed by an UNTRUSTED discriminator, so it may never be a
  // plain object: `{type:'constructor'}` read `Object.prototype.constructor`
  // before incrementing (yielding `"function Object() { [native code] }1"`) and
  // `{type:'__proto__'}` vanished from the census entirely, because assigning
  // it hits the prototype setter instead of creating an own key. A census that
  // silently drops an item is the exact silence this module exists to prevent,
  // so counting happens in a Map (no prototype at all) and the plain object is
  // built once, explicitly, from its own entries.
  const typeCounts = new Map(); // insertion-ordered → stable output order

  const census = {
    outcome: 'collected',
    items_received: 0,
    types_seen: {},
    admitted: 0,
    inadmissible: 0,
    // S04 review R1. A FOURTH item disposition, additive to the three that
    // already exist. It joins the accounting identity below — a malformed item
    // is neither admitted nor inadmissible nor rejected, and letting it fall
    // through any of those three would be exactly the mis-accounting the
    // identity check is there to catch.
    malformed: 0,
    malformed_detail: [],
    // Element-level, NOT part of the item identity: these are `changes[]`
    // members dropped from an item that was otherwise usable.
    malformed_changes: 0,
    rejected: [],
    turn_status: turnStatus,
  };

  // defineProperty, not `out[name] = count`: a `__proto__` key must land as an
  // OWN property, and plain assignment hits the prototype setter instead (which
  // is how it disappeared). The container stays a PLAIN object rather than
  // Object.create(null) on purpose — the census crosses a JSON boundary into
  // the result-file, and `JSON.parse` yields a plain object, so a null
  // prototype here would make the in-memory census and its own serialisation
  // structurally unequal (forge-xllm-evidence.test.js asserts that identity).
  // Safety comes from never READING this object by untrusted key: it is built
  // from own entries and consumed via Object.keys/JSON.stringify.
  const materializeTypesSeen = () => {
    const out = {};
    for (const [name, count] of typeCounts) Object.defineProperty(out, name, {
      value: count, enumerable: true, writable: true, configurable: true,
    });
    return out;
  };

  try {
    const list = Array.isArray(items) ? items : [];
    if (!Array.isArray(items) && items != null) {
      throw new Error(`items must be an array, received ${typeof items}`);
    }
    census.items_received = list.length;

    const entries = [];
    const rejectedCounts = new Map(); // insertion-ordered → stable output order
    const malformedCounts = new Map(); // `${type} ${reason}` → count

    for (const item of list) {
      const name = itemTypeName(item);
      // Insertion order is the stable order promised by the contract; Map key
      // order over string keys preserves it.
      typeCounts.set(name, (typeCounts.get(name) || 0) + 1);

      const verdict = classifyThreadItem(item);
      if (!verdict.known) {
        rejectedCounts.set(name, (rejectedCounts.get(name) || 0) + 1);
        continue; // NEVER pushed into entries — floor 2.
      }
      if (!verdict.admissible) {
        census.inadmissible += 1;
        continue;
      }

      // Validated BEFORE `admitted` is incremented: a malformed item is a
      // distinct disposition, not an admitted one that happened to be thin.
      const malformedReason = validateAdmissibleItem(item);
      if (malformedReason) {
        census.malformed += 1;
        const key = `${name} ${malformedReason}`;
        malformedCounts.set(key, (malformedCounts.get(key) || 0) + 1);
        continue; // NEVER pushed into entries.
      }

      census.admitted += 1;
      if (item.type === 'commandExecution') {
        entries.push({
          ts: nowIso,
          source: 'codex-runtime',
          kind: 'command',
          unit,
          cmd: truncate(item.command, MAX_FIELD_CHARS),
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
          // The pin declares exitCode as ["integer","null"]. A null exit code is
          // an OBSERVED VALUE ("the runtime reported no exit code"), not an
          // absence to be defaulted. Coercing it to 0 would manufacture a
          // success that nothing measured — the single most damaging edit
          // anyone could make to this file.
          exit_code: typeof item.exitCode === 'number' ? item.exitCode : null,
          duration_ms: typeof item.durationMs === 'number' ? item.durationMs : null,
          status: typeof item.status === 'string' ? item.status : null,
        });
      } else if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        // One entry PER change: the path lives inside changes[], so a single
        // entry per item would silently collapse an N-file patch into one.
        for (const change of changes) {
          if (!isUsableChange(change)) {
            // Counted, never emitted: an entry with `file: ''` is an assertion
            // that a file changed while declining to say which (S04 review R1).
            census.malformed_changes += 1;
            const key = `${name} invalid-change-element`;
            malformedCounts.set(key, (malformedCounts.get(key) || 0) + 1);
            continue;
          }
          entries.push({
            ts: nowIso,
            source: 'codex-runtime',
            kind: 'file',
            unit,
            file: truncate(change && change.path, MAX_FIELD_CHARS),
            change_kind: change && typeof change.kind === 'string' ? change.kind : null,
            status: typeof item.status === 'string' ? item.status : null,
          });
        }
      } else {
        // Unreachable while ADMISSIBLE_TYPES has exactly these two members. If a
        // third becomes admissible in the map without a builder here, that is a
        // programming error and must be loud, not an item silently admitted and
        // then dropped from entries.
        throw new Error(`admissible variant '${item.type}' has no entry builder`);
      }
    }

    census.rejected = Array.from(rejectedCounts, ([type, count]) => ({ type, count }));
    census.malformed_detail = Array.from(malformedCounts, ([key, count]) => {
      const split = key.lastIndexOf(' ');
      return { type: key.slice(0, split), reason: key.slice(split + 1), count };
    });

    const rejectedTotal = census.rejected.reduce((sum, r) => sum + r.count, 0);
    // `malformed` joins the identity; `malformed_changes` deliberately does NOT
    // (it counts changes[] elements, not items — mixing the two units is how an
    // identity check stops meaning anything).
    if (census.admitted + census.inadmissible + census.malformed + rejectedTotal !== census.items_received) {
      throw new Error('census does not account for every received item');
    }

    census.types_seen = materializeTypesSeen();

    // NOTE the outcome here: 'collected' regardless of admitted === 0.
    // Collected-and-empty is a real, reportable result — see floor 1.
    return { census, entries };
  } catch (error) {
    return {
      census: {
        outcome: 'collector-failed',
        items_received: census.items_received,
        // Counted up to the point of failure — the partial census is still the
        // most a human has to go on, and dropping it would be silence again.
        types_seen: materializeTypesSeen(),
        admitted: 0,
        inadmissible: 0,
        malformed: 0,
        malformed_detail: [],
        malformed_changes: 0,
        rejected: [],
        turn_status: turnStatus,
        reason: error && error.message ? error.message : String(error),
      },
      entries: [],
    };
  }
}

// ── assertVariantCoverage ──────────────────────────────────────────────────
//
// Confronts this module's 18 names with the pinned schema. Throws naming the
// DIVERGENT VARIANTS, never just a count: "expected 18, got 19" sends a
// reviewer on an archaeology trip, "missing from map: quantumThing" does not.
function pinVariantNames(pin) {
  const oneOf = pin && pin.definitions && pin.definitions.ThreadItem
    ? pin.definitions.ThreadItem.oneOf
    : null;
  if (!Array.isArray(oneOf)) {
    const error = new Error('pin has no definitions.ThreadItem.oneOf array');
    error.code = 'PIN_SHAPE_CHANGED';
    throw error;
  }
  // The variant NAME is the discriminator `type.enum[0]`, read from the pin —
  // not derived from the title by string surgery, which would invent names the
  // protocol never used the moment a title stops matching its discriminator.
  const names = oneOf.map((variant, index) => {
    const typeProp = variant && variant.properties && variant.properties.type;
    const name = typeProp && Array.isArray(typeProp.enum) ? typeProp.enum[0] : null;
    if (typeof name !== 'string' || name.length === 0) {
      const error = new Error(`pin variant #${index} has no type.enum[0] discriminator`);
      error.code = 'PIN_SHAPE_CHANGED';
      throw error;
    }
    return name;
  });

  // A DUPLICATE discriminator is the pin contradicting itself, same class as
  // meta.variant_count disagreeing with oneOf.length below — hence the same
  // error code. It has to be caught here rather than downstream, because every
  // later comparison is set-based: a pin carrying all 18 names plus a repeat
  // passes coverage AND passes the count check (forge-schema-pin derives
  // meta.variant_count from this same array), while `variants` and the
  // admissible/inadmissible totals reported to the caller overstate reality.
  const seen = new Set();
  const duplicates = [];
  for (const name of names) {
    if (seen.has(name)) { if (!duplicates.includes(name)) duplicates.push(name); }
    else seen.add(name);
  }
  if (duplicates.length > 0) {
    const error = new Error(
      `pin is internally inconsistent: duplicate ThreadItem discriminator(s): ${duplicates.join(', ')}`
    );
    error.code = 'PIN_SHAPE_CHANGED';
    error.duplicates = duplicates;
    throw error;
  }

  return names;
}

function assertVariantCoverage(pin) {
  const names = pinVariantNames(pin);

  // Anti-silence floor: a pin that yields zero variants means reading stopped
  // working, not that the protocol has no variants. Passing here would make
  // every later comparison vacuously agreeable.
  if (names.length === 0) {
    const error = new Error('anti-silence floor: pin yielded 0 ThreadItem variants');
    error.code = 'PIN_SHAPE_CHANGED';
    throw error;
  }

  const metaCount = pin && pin.meta ? pin.meta.variant_count : undefined;
  // meta.variant_count vs oneOf.length is a check of the PIN AGAINST ITSELF.
  // If those two disagree the pin is corrupt, and neither number may be quoted
  // as authoritative afterwards.
  if (typeof metaCount === 'number' && metaCount !== names.length) {
    const error = new Error(
      `pin is internally inconsistent: meta.variant_count=${metaCount} but oneOf has ${names.length} variants`
    );
    error.code = 'PIN_SHAPE_CHANGED';
    throw error;
  }

  const pinSet = new Set(names);
  const mapNames = Object.keys(VARIANT_ADMISSIBILITY);
  const mapSet = new Set(mapNames);

  const missingInMap = names.filter((name) => !mapSet.has(name));
  const missingInPin = mapNames.filter((name) => !pinSet.has(name));

  if (missingInMap.length > 0 || missingInPin.length > 0) {
    const parts = [];
    if (missingInMap.length > 0) parts.push(`unclassified in map: ${missingInMap.join(', ')}`);
    if (missingInPin.length > 0) parts.push(`absent from pin: ${missingInPin.join(', ')}`);
    const error = new Error(`ThreadItem variant coverage diverges — ${parts.join('; ')}`);
    error.code = 'VARIANT_COVERAGE_DIVERGED';
    error.missingInMap = missingInMap;
    error.missingInPin = missingInPin;
    throw error;
  }

  return {
    ok: true,
    variants: names.length,
    admissible: ADMISSIBLE_TYPES.length,
    inadmissible: names.length - ADMISSIBLE_TYPES.length,
    meta_variant_count: typeof metaCount === 'number' ? metaCount : null,
  };
}

// ── checkDocTable ──────────────────────────────────────────────────────────
//
// Parses the markdown table in `## Admissibilidade das 18 variantes de
// ThreadItem` and confronts it with the map: name set, verdict per name, and a
// non-empty reason naming the same reason class. In-process, `fs` only, never
// a shell-out — the mold is forge-doc-claims.js, whose origin defect was a
// `grep` that honored `.gitignore` and therefore never saw the file it policed.
const DOC_SECTION_HEADING = '## Admissibilidade das 18 variantes de ThreadItem';

function normalizeCell(cell) {
  return String(cell == null ? '' : cell)
    .replace(/[`*]/g, '')
    .trim();
}

function normalizeVerdict(cell) {
  const text = normalizeCell(cell)
    .toLowerCase()
    .normalize('NFD')
    // Combining marks written as explicit escapes, never as literal accent
    // bytes in the source: a literal class here is invisible in review and can
    // be silently mangled by an editor re-encoding the file, which would turn
    // "admissível" unreadable and fail every row at once.
    .replace(/[\u0300-\u036f]/g, ''); // strip accents: admissível → admissivel
  if (text === 'inadmissivel' || text === 'inadmissible') return false;
  if (text === 'admissivel' || text === 'admissible') return true;
  return null; // unrecognised verdict — a mismatch by name, never a skipped row
}

function parseDocRows(markdown) {
  const lines = String(markdown == null ? '' : markdown).split('\n');
  const rows = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // Section-scoped on purpose: rows are collected from THIS section only,
      // but every row inside it is collected — including one whose name was
      // mutated. Filtering rows by "is it a known variant" would turn a
      // renamed row into silence, which is the failure mode under audit.
      inSection = line.trim() === DOC_SECTION_HEADING;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue;            // separator row
    const first = normalizeCell(cells[0]).toLowerCase();
    if (first === 'variante' || first === 'variant' || first === 'nome') continue; // header

    rows.push({ name: normalizeCell(cells[0]), verdict: cells[1], reason: normalizeCell(cells[2]) });
  }
  return rows;
}

function checkDocTable(markdown) {
  const rows = parseDocRows(markdown);
  const problems = [];

  // Anti-silence floor, same shape as forge-doc-claims' `scanned === 0`:
  // parsing nothing is a FAILURE. A doc checker that reports "clean" after
  // reading zero rows is exactly the broken detector this milestone is about.
  if (rows.length === 0) {
    return {
      ok: false,
      parsed: 0,
      problems: [{ kind: 'anti-silence', detail: `no table rows parsed under "${DOC_SECTION_HEADING}"` }],
      reason: `anti-silence floor: 0 rows parsed under "${DOC_SECTION_HEADING}"`,
    };
  }

  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.name)) {
      problems.push({ kind: 'duplicate', variant: row.name, detail: `variant '${row.name}' listed more than once` });
      continue;
    }
    seen.set(row.name, row);

    const entry = Object.prototype.hasOwnProperty.call(VARIANT_ADMISSIBILITY, row.name)
      ? VARIANT_ADMISSIBILITY[row.name]
      : null;
    if (!entry) {
      problems.push({ kind: 'unknown-variant', variant: row.name, detail: `'${row.name}' is not one of the classified variants` });
      continue;
    }

    const verdict = normalizeVerdict(row.verdict);
    if (verdict === null) {
      problems.push({
        kind: 'unreadable-verdict', variant: row.name,
        detail: `'${row.name}' has an unreadable verdict '${normalizeCell(row.verdict)}'`,
      });
    } else if (verdict !== entry.admissible) {
      problems.push({
        kind: 'verdict-mismatch', variant: row.name,
        detail: `'${row.name}' is documented ${verdict ? 'admissível' : 'inadmissível'} but the map says ${entry.admissible ? 'admissível' : 'inadmissível'}`,
      });
    }

    // "Nenhuma por omissão" is enforced here: an empty reason cell, or one that
    // does not name the map's reason class, is a defect — a row that states a
    // verdict without a reason is the omission D7 forbids.
    if (row.reason.length === 0) {
      problems.push({ kind: 'missing-reason', variant: row.name, detail: `'${row.name}' has an empty reason cell` });
    } else if (!row.reason.includes(entry.reason)) {
      problems.push({
        kind: 'reason-mismatch', variant: row.name,
        detail: `'${row.name}' does not name its reason class '${entry.reason}'`,
      });
    }
  }

  for (const name of Object.keys(VARIANT_ADMISSIBILITY)) {
    if (!seen.has(name)) {
      problems.push({ kind: 'missing-row', variant: name, detail: `'${name}' is classified in the map but absent from the table` });
    }
  }

  return {
    ok: problems.length === 0,
    parsed: rows.length,
    problems,
    reason: problems.length === 0 ? 'clean' : `${problems.length} table divergence(s)`,
  };
}

function readJsonFile(file) {
  // readFileSync + JSON.parse, never require(): a path coming from argv or env
  // must not be executable (same reasoning as forge-schema-pin's readJson).
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { mode: null, json: false, pin: null, doc: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Contradictory modes are REJECTED, never resolved by "last wins": a caller
    // that passes both asked for two different checks and got one silently, and
    // the exit code it reads back names neither. Same posture as the per-mode
    // option guard below — exit 2 is "you called me wrong" (see main()).
    if (arg === '--check-schema') {
      if (out.mode && out.mode !== 'schema') return { error: '--check-schema and --check-doc are mutually exclusive' };
      out.mode = 'schema';
    } else if (arg === '--check-doc') {
      if (out.mode && out.mode !== 'doc') return { error: '--check-schema and --check-doc are mutually exclusive' };
      out.mode = 'doc';
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { error: '--check-doc requires a markdown file path' };
      out.doc = value;
      i += 1;
    } else if (arg === '--pin') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { error: '--pin requires a file path' };
      out.pin = value;
      i += 1;
    } else if (arg === '--json') out.json = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!out.mode) return { error: 'one of --check-schema or --check-doc <file> is required' };
  // Checked after the loop, not at `--pin`, because argv order is the caller's
  // choice: `--pin p --check-doc d` must fail exactly like `--check-doc d
  // --pin p`. Silently ignoring an option outside its mode makes the CLI answer
  // a question the caller did not ask, while still exiting 0.
  if (out.pin !== null && out.mode !== 'schema') {
    return { error: '--pin is only valid with --check-schema' };
  }
  return out;
}

function main() {
  // Arg guards run before any file read: malformed input must fail fast at the
  // boundary, with exit 2 reserved for "you called me wrong" so a caller can
  // tell it apart from exit 1, "what I checked is wrong".
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`forge-evidence-admit: ${args.error}\n`);
    process.exit(2);
  }

  if (args.mode === 'schema') {
    const file = args.pin || pinPath();
    let result;
    try {
      result = assertVariantCoverage(readJsonFile(file));
    } catch (error) {
      const payload = {
        ok: false,
        error: error.message,
        code: error.code || 'PIN_UNREADABLE',
        missing_in_map: error.missingInMap || [],
        missing_in_pin: error.missingInPin || [],
        pin: file,
      };
      if (args.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
      process.stderr.write(`forge-evidence-admit: ${error.message}\n`);
      process.exit(1);
    }
    const payload = { ...result, pin: file };
    if (args.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stdout.write(`ok: ${result.variants} variants, ${result.admissible} admissible (pin: ${file})\n`);
    process.exit(0);
  }

  // args.mode === 'doc'
  let markdown;
  try {
    markdown = fs.readFileSync(path.resolve(args.doc), 'utf8');
  } catch (error) {
    process.stderr.write(`forge-evidence-admit: cannot read ${args.doc}: ${error.message}\n`);
    process.exit(1);
  }
  const result = checkDocTable(markdown);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...result, doc: args.doc })}\n`);
  } else {
    process.stdout.write(`parsed: ${result.parsed} rows\n`);
    for (const problem of result.problems) process.stdout.write(`  [${problem.kind}] ${problem.detail}\n`);
    process.stdout.write(`${result.ok ? 'clean' : `FAIL: ${result.reason}`}\n`);
  }
  if (!result.ok) process.stderr.write(`forge-evidence-admit: ${result.reason}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  REASONS,
  VARIANT_ADMISSIBILITY,
  ADMISSIBLE_TYPES,
  DOC_SECTION_HEADING,
  MAX_FIELD_CHARS,
  classifyThreadItem,
  buildRuntimeEvidence,
  assertVariantCoverage,
  pinVariantNames,
  checkDocTable,
  parseDocRows,
};
