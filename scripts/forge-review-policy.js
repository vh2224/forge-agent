#!/usr/bin/env node
'use strict';

// review-fix-policy-v1 — the single executable policy of the review-fix loop (#341).
//
// What this module owns (and nothing else):
//   - the deterministic dual verdict: "is it real?" (conceded) is separate from
//     "fix it now?" (critical/high AND normally reachable AND in scope);
//   - a bounded read of the owner's event history: admitted cycles, legacy
//     review-fix dispatches, measured review-fix attempts and the execute-task
//     intervals of the same slice (attributed only through the controller record);
//   - the named admission decision (cycle cap, measured budget, fix-now filter)
//     appended once as a `review-fix-admission` event under the owner lock;
//   - the visible `⚖` status line and the read-only `--status` measurement;
//   - the pre-provider guard of review legs inside a milestone.
// Cap and ratio are versioned constants, never preferences. Unknown time stays
// unknown (never zero) and then only the cap governs. Nothing here calls a provider.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_VERSION = 'review-fix-policy-v1';
const CYCLE_LIMIT = 2;
const BUDGET_RATIO = 0.5;
const ADMISSION_EVENT = 'review-fix-admission';
const LEG_REFUSAL_EVENT = 'review-leg-refusal';
const REFUSAL_CODES = Object.freeze(['review-fix-cycle-limit', 'review-fix-budget-exhausted', 'review-fix-not-fix-now', 'review-fix-policy-invalid']);
const REVIEW_LEG_CODES = Object.freeze(['review-per-task-in-milestone', 'review-already-completed']);
const REVIEW_LEG_AGENTS = Object.freeze(['forge-reviewer', 'forge-advocate']);
const REVIEW_LEG_MODES = Object.freeze(['challenge', 'defend', 'rebuttal']);
const TRISTATE = Object.freeze(['yes', 'no', 'unknown']);
const BASES = Object.freeze(['dual-verdict', 'operator-decision']);
const RESOLUTIONS = Object.freeze(['conceded', 'open', 'resolved']);
const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const ITEM_REASONS = Object.freeze(['not-conceded', 'resolution-unknown', 'severity-below-high', 'severity-unknown',
  'not-reachable', 'reachable-unknown', 'out-of-scope', 'scope-unknown']);
const BOUNDARIES = Object.freeze(['slice', 'task', 'milestone-triage']);
// The real owner log is several MiB; the policy uses its own named bound.
const MAX_OWNER_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_ITEMS = 64;
const MAX_RECOVERY_DEPTH = 8;
const TERMINAL_STATUSES = Object.freeze(['done', 'partial', 'blocked', 'failed']);
const MILESTONE_ID_RE = /^(?:M\d+|M-\d{14}-[a-z0-9-]+)$/i;
const SLICE_ID_RE = /^S\d{1,4}$/;
const DISPATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ITEM_ID_RE = /^R\d{1,4}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function nowOf(value) { const n = typeof value === 'function' ? value() : value; return Number.isFinite(n) ? n : Date.now(); }
function policyError(code, detail, extra) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail: detail || null, ...(extra || {}) });
}
function invalid(detail) { return policyError('review-fix-policy-invalid', detail); }
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

// ── Dual verdict ────────────────────────────────────────────────────────────
const RANK = Object.freeze({ no: 0, unknown: 1, yes: 2 });
function tristate(value) { return TRISTATE.includes(value) ? value : 'unknown'; }
function conservative(challenger, contest, field) {
  let resolved = tristate(challenger);
  for (const leg of ['advocate', 'rebuttal']) {
    const value = plainObject(contest) && plainObject(contest[leg]) ? contest[leg][field] : undefined;
    // An absent contest means the leg did not report; only a valid value can lower.
    if (TRISTATE.includes(value) && RANK[value] < RANK[resolved]) resolved = value;
  }
  return resolved;
}

/**
 * Pure, deterministic classification of one finding. Absent, invalid or legacy
 * fields are `unknown` and never become an immediate fix. `reproduced` is only
 * recorded. `operator-decision` waives the filter but keeps the classification.
 */
function classifyFinding(verdict, basis) {
  const v = plainObject(verdict) ? verdict : {};
  const resolution = RESOLUTIONS.includes(v.resolution) ? v.resolution : 'unknown';
  const severity = SEVERITIES.includes(v.severity) ? v.severity : 'unknown';
  const resolved = { resolution, severity, reachable: conservative(v.reachable, v.contest, 'reachable'),
    reproduced: tristate(v.reproduced), in_scope: conservative(v.in_scope, v.contest, 'in_scope') };
  const reasons = [];
  if (resolution === 'unknown') reasons.push('resolution-unknown');
  else if (resolution !== 'conceded') reasons.push('not-conceded');
  if (severity === 'unknown') reasons.push('severity-unknown');
  else if (!['critical', 'high'].includes(severity)) reasons.push('severity-below-high');
  if (resolved.reachable === 'no') reasons.push('not-reachable');
  else if (resolved.reachable === 'unknown') reasons.push('reachable-unknown');
  if (resolved.in_scope === 'no') reasons.push('out-of-scope');
  else if (resolved.in_scope === 'unknown') reasons.push('scope-unknown');
  const fixNow = reasons.length === 0;
  const effectiveBasis = BASES.includes(basis) ? basis : 'dual-verdict';
  return { fix_now: fixNow, admissible: fixNow || effectiveBasis === 'operator-decision', basis: effectiveBasis, resolved, reasons };
}

// Strict reading of untrusted raw items: closed enums when present, bounded sizes.
function strictEnum(value, list, field, r) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !list.includes(value)) throw invalid(`${r} ${field} outside the closed enum`);
  return value;
}
function strictContest(contest, r) {
  if (contest === undefined || contest === null) return undefined;
  if (!plainObject(contest) || Object.keys(contest).some(key => !['advocate', 'rebuttal'].includes(key))) throw invalid(`${r} contest invalid`);
  const out = {};
  for (const [leg, value] of Object.entries(contest)) {
    if (value === undefined || value === null) continue;
    if (!plainObject(value) || Object.keys(value).some(key => !['reachable', 'in_scope'].includes(key))) throw invalid(`${r} contest.${leg} invalid`);
    out[leg] = {};
    for (const field of ['reachable', 'in_scope']) {
      const parsed = strictEnum(value[field], TRISTATE, `contest.${leg}.${field}`, r);
      if (parsed !== undefined) out[leg][field] = parsed;
    }
  }
  return out;
}
function reviewFileOf(raw, r) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 1024) throw invalid(`${r} review_file invalid`);
  const value = raw.trim().replace(/\\/g, '/');
  if (!value.startsWith('.gsd/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) {
    throw invalid(`${r} review_file must be a .gsd relative path`);
  }
  return value;
}

/** Verdict and basis of each raw item (never part of the normalized brief). */
function itemVerdicts(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw invalid(`items must be a non-empty list of at most ${MAX_ITEMS}`);
  const seen = new Set();
  return items.map((entry, index) => {
    if (!plainObject(entry)) throw invalid(`item ${index + 1} must be an object`);
    const r = typeof (entry.r ?? entry.id) === 'string' ? (entry.r ?? entry.id).trim() : '';
    if (!ITEM_ID_RE.test(r)) throw invalid(`item ${index + 1} has no R# id`);
    const reviewFile = reviewFileOf(entry.review_file, r);
    const key = JSON.stringify([reviewFile, r]);
    if (seen.has(key)) throw invalid(`duplicate ${r}`);
    seen.add(key);
    const basis = entry.basis === undefined || entry.basis === null ? 'dual-verdict' : entry.basis;
    if (!BASES.includes(basis)) throw invalid(`${r} basis unknown`);
    const raw = entry.verdict === undefined || entry.verdict === null ? {} : entry.verdict;
    if (!plainObject(raw)) throw invalid(`${r} verdict must be an object`);
    const allowed = ['resolution', 'severity', 'reachable', 'reproduced', 'in_scope', 'contest'];
    if (Object.keys(raw).some(field => !allowed.includes(field))) throw invalid(`${r} verdict has an unknown field`);
    const verdict = {};
    const assign = (field, value) => { if (value !== undefined) verdict[field] = value; };
    assign('resolution', strictEnum(raw.resolution, RESOLUTIONS, 'resolution', r));
    assign('severity', strictEnum(raw.severity, SEVERITIES, 'severity', r));
    for (const field of ['reachable', 'reproduced', 'in_scope']) assign(field, strictEnum(raw[field], TRISTATE, field, r));
    assign('contest', strictContest(raw.contest, r));
    return { r, review_file: reviewFile, basis, verdict, classification: classifyFinding(verdict, basis) };
  }).sort((a, b) => Number(a.r.slice(1)) - Number(b.r.slice(1)));
}

// ── Boundaries and identities ───────────────────────────────────────────────
function taskIdValid(task) {
  if (typeof task !== 'string' || task.length > 160 || /[\\/\0]/.test(task)) return false;
  const ids = require('./forge-ids');
  return ids.isValid(task) && ids.entityKind(task) === 'task';
}
function scopeOf(input) {
  const value = plainObject(input) ? input : {};
  const { boundary, milestone, slice, task } = value;
  if (boundary === 'slice') {
    if (!MILESTONE_ID_RE.test(milestone || '') || !SLICE_ID_RE.test(slice || '') || task !== undefined) throw invalid('slice boundary requires milestone and slice');
    return { boundary, milestone, slice, key: `slice:${milestone}:${slice}`, unit_label: `review-fix/${slice}`, label: slice };
  }
  if (boundary === 'task') {
    if (milestone !== undefined || slice !== undefined || !taskIdValid(task)) throw invalid('task boundary requires a standalone task id');
    return { boundary, task, key: `task:${task}`, unit_label: `review-fix/${task}`, label: task };
  }
  if (boundary === 'milestone-triage') {
    if (!MILESTONE_ID_RE.test(milestone || '') || slice !== undefined || task !== undefined) throw invalid('milestone-triage requires a milestone');
    return { boundary, milestone, key: `milestone-triage:${milestone}`, unit_label: `review-fix/${milestone}-triage`, label: `${milestone}-triage` };
  }
  throw invalid('boundary must be slice, task or milestone-triage');
}
/** `slice:<M>:<S##>`, `task:<TASK_ID>` or `milestone-triage:<M>`. */
function boundaryKey(input) { return scopeOf(input).key; }
function decisionIdentity(key, dispatchId, briefIdentity) {
  return sha256(JSON.stringify([POLICY_VERSION, key, dispatchId, briefIdentity]));
}
// Route-free: a recovery successor may change the route, never the correction.
function correctionIdentity(scope, brief) {
  return sha256(JSON.stringify({ boundary: scope.boundary, unit_label: scope.unit_label, items: brief.items, claim_paths: brief.claim_paths }));
}
function isRecoveryOf(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child.includes('-recovery-')) return false;
  if (child.startsWith(parent + '-recovery-')) return true;
  const marker = '-' + sha256(parent).slice(0, 16) + '-recovery-';
  const at = child.indexOf(marker);
  return at > 0 && parent.startsWith(child.slice(0, at));
}
function descendsFrom(id, root, depth = 0) {
  if (id === root) return true;
  if (depth > MAX_RECOVERY_DEPTH || typeof id !== 'string') return false;
  if (isRecoveryOf(id, root)) return true;
  for (let at = id.lastIndexOf('-recovery-'); at > 0; at = id.lastIndexOf('-recovery-', at - 1)) {
    if (descendsFrom(id.slice(0, at), root, depth + 1)) return true;
  }
  return false;
}

// ── Bounded history ─────────────────────────────────────────────────────────
function ownerReal(owner) {
  if (typeof owner !== 'string' || !owner || owner.includes('\0')) throw invalid('owner must be a directory path');
  try { return require('./forge-code-roots').realDirectory(path.resolve(owner)); }
  catch { throw invalid('owner directory unresolved'); }
}
function ownerEventsFile(owner) { return path.join(owner, '.gsd', 'forge', 'events.jsonl'); }
// null = absent; { error } = unreadable/oversized; { buffer } = a stable bounded read.
function boundedRead(file, limit) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { return error.code === 'ENOENT' ? null : { error: 'source_unreadable' }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { error: 'source_not_file' };
  if (stat.size > limit) return { error: 'source_too_large' };
  let expectedReal;
  try { expectedReal = fs.realpathSync.native(file); } catch { return { error: 'source_unreadable' }; }
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, limit, { expectedReal });
  return read.error ? { error: read.error } : { buffer: read.buffer };
}
function parseLines(buffer) {
  let text;
  try { text = new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(buffer); }
  catch { return { rows: [], malformed: 0, error: 'source_encoding' }; }
  const rows = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { malformed++; continue; }
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!plainObject(row)) { malformed++; continue; }
    rows.push(row);
  }
  return { rows, malformed };
}
function validAdmissionRecord(row) {
  return HEX64_RE.test(row.identity || '') && HEX64_RE.test(row.correction_identity || '')
    && ['admitted', 'refused'].includes(row.decision) && typeof row.counted === 'boolean'
    && typeof row.dispatch_id === 'string' && DISPATCH_ID_RE.test(row.dispatch_id)
    && (row.cycle === null || Number.isSafeInteger(row.cycle)) && plainObject(row.budget) && Array.isArray(row.items);
}
function timeOf(value) { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; }
// started → terminal of the sidecar attempt; anything else is unmeasured.
// Issue 342: the absolute window is shared with the milestone-options history.
function attemptWindow(rows, dispatchId, unitLabel) {
  let start = null, end = null;
  for (const row of rows) {
    if (row.event !== 'sidecar-unit' || row.dispatch_id !== dispatchId || row.unit !== unitLabel) continue;
    const at = timeOf(row.ts);
    if (at === null) return null;
    if (row.status === 'started' && start === null) start = at;
    else if (TERMINAL_STATUSES.includes(row.status) && start !== null && end === null) end = at;
  }
  return start !== null && end !== null && end >= start ? { start, end } : null;
}
function measuredAttempt(rows, dispatchId, unitLabel) {
  const w = attemptWindow(rows, dispatchId, unitLabel);
  return w ? w.end - w.start : null;
}
function dispatchBelongs(row, scope) {
  if (row.event !== 'dispatch' || row.unit !== scope.unit_label) return false;
  return scope.boundary === 'task' ? row.milestone === undefined || row.milestone === null || row.milestone === '' : row.milestone === scope.milestone;
}

// execute_ms of the slice: closed execute-task intervals of the milestone log,
// attributed to the slice only through the committed controller begin record.
function measureExecute(owner, scope, options) {
  if (scope.boundary === 'task') return { execute_ms: null, reasons: ['standalone-task-execute-unknown'] };
  if (scope.boundary !== 'slice') return { execute_ms: null, reasons: ['milestone-triage-not-budgeted'] };
  const phase = require('./forge-phase-cost');
  const read = boundedRead(path.join(owner, '.gsd', 'milestones', scope.milestone, `${scope.milestone}-events.jsonl`), phase.MAX_BYTES);
  if (read === null) return { execute_ms: null, reasons: ['execute-unobserved'] };
  if (read.error) return { execute_ms: null, reasons: ['execute-events-unreadable'] };
  let analysis;
  try { analysis = phase.analyzeEventIntervals(read.buffer); }
  catch { return { execute_ms: null, reasons: ['execute-events-invalid'] }; }
  const ours = row => row.phase === 'execute-task' && row.milestone === scope.milestone;
  const reasons = [];
  if (analysis.open.some(ours)) reasons.push('execute-open');
  for (const row of analysis.ambiguous.filter(ours)) reasons.push(row.reason === 'negative-interval' ? 'execute-negative' : 'execute-ambiguous');
  const lookup = typeof options.lookup === 'function' ? options.lookup : require('./forge-unit-controller').lookupRecord;
  let total = 0, attributed = 0;
  for (const row of analysis.intervals.filter(ours)) {
    let tx = null;
    try { tx = row.begin_key ? lookup(owner, 'transaction', row.begin_key) : null; } catch { tx = null; }
    const committed = plainObject(tx) && tx.phase === 'committed' && tx.action === 'begin' && tx.milestone === scope.milestone
      && plainObject(tx.unit) && tx.unit.key === row.unit && plainObject(tx.after) && plainObject(tx.after.state)
      && typeof tx.after.state.active_slice === 'string';
    if (!committed) { reasons.push('execute-unattributable'); continue; }
    if (tx.after.state.active_slice !== scope.slice) continue;
    total += row.end - row.start; attributed++;
  }
  if (!attributed) reasons.push('execute-unobserved');
  return reasons.length ? { execute_ms: null, reasons: [...new Set(reasons)] } : { execute_ms: total, reasons: [] };
}

/**
 * Bounded read of the owner history for one boundary: admission records,
 * legacy review-fix dispatches, measured attempts and the slice budget.
 */
function readHistory(owner, input, options = {}) {
  const real = ownerReal(owner), scope = input && input.key ? input : scopeOf(input);
  const read = boundedRead(ownerEventsFile(real), MAX_OWNER_EVENTS_BYTES);
  const empty = { status: 'invalid', scope, malformed_lines: 0, admissions: [], consumed: null, legacy: { count: 0, dispatch_ids: [] },
    budget: { status: 'unknown', execute_ms: null, review_fix_ms: null, ratio: null, limit: BUDGET_RATIO, reasons: [] } };
  if (read && read.error) return { ...empty, reason: read.error === 'source_too_large' ? 'history-oversized' : 'history-unreadable',
    budget: { ...empty.budget, reasons: [read.error === 'source_too_large' ? 'history-oversized' : 'history-unreadable'] } };
  const parsed = read === null ? { rows: [], malformed: 0 } : parseLines(read.buffer);
  if (parsed.error) return { ...empty, reason: 'history-unreadable', budget: { ...empty.budget, reasons: ['history-unreadable'] } };
  const rows = parsed.rows;
  const admissions = rows.filter(row => row.event === ADMISSION_EVENT && row.boundary_key === scope.key);
  if (admissions.some(row => !validAdmissionRecord(row))) {
    return { ...empty, malformed_lines: parsed.malformed, reason: 'admission-record-invalid', budget: { ...empty.budget, reasons: ['admission-record-invalid'] } };
  }
  const admitted = new Map();
  for (const row of admissions) if (row.decision === 'admitted' && !admitted.has(row.identity)) admitted.set(row.identity, row);
  const counted = [...admitted.values()].filter(row => row.counted === true);
  const admittedIds = new Set([...admitted.values()].map(row => row.dispatch_id));
  const legacyIds = new Set(), continuationIds = new Set();
  let legacyWithoutId = 0;
  for (const row of rows.filter(r => dispatchBelongs(r, scope))) {
    const id = typeof row.dispatch_id === 'string' && row.dispatch_id ? row.dispatch_id : null;
    if (!id) { legacyWithoutId++; continue; }
    if (id.includes('-recovery-')) continuationIds.add(id);
    else if (!admittedIds.has(id)) legacyIds.add(id);
  }
  const consumed = counted.length + legacyIds.size + legacyWithoutId;
  // review_fix_ms: every counted cycle and continuation must have a measured pair.
  const measuredIds = [...new Set([...counted.map(row => row.dispatch_id), ...legacyIds, ...continuationIds])];
  let reviewMs = 0;
  const reviewReasons = [];
  if (legacyWithoutId) reviewReasons.push('review-fix-unmeasured');
  for (const id of measuredIds) {
    const duration = measuredAttempt(rows, id, scope.unit_label);
    if (duration === null) reviewReasons.push('review-fix-unmeasured'); else reviewMs += duration;
  }
  const execute = measureExecute(real, scope, options);
  const reviewFixMs = reviewReasons.length ? null : reviewMs;
  const reasons = [...new Set([...execute.reasons, ...reviewReasons])];
  const complete = execute.execute_ms !== null && reviewFixMs !== null && execute.execute_ms > 0;
  if (!complete && execute.execute_ms === 0) reasons.push('execute-zero');
  const budget = { status: complete ? 'complete' : 'unknown', execute_ms: execute.execute_ms, review_fix_ms: reviewFixMs,
    ratio: complete ? reviewFixMs / execute.execute_ms : null, limit: BUDGET_RATIO, reasons: complete ? [] : reasons };
  return { status: 'valid', scope, malformed_lines: parsed.malformed, admissions, admitted: [...admitted.values()], consumed,
    counted: counted.length, legacy: { count: legacyIds.size + legacyWithoutId, dispatch_ids: [...legacyIds].sort(), without_id: legacyWithoutId },
    continuations: [...continuationIds].sort(), budget };
}

// Issue 342: scope of one review-fix dispatch row, proven only by its own fields.
function reviewFixScope(row) {
  const label = row.unit.slice('review-fix/'.length);
  const milestone = typeof row.milestone === 'string' && row.milestone ? row.milestone : null;
  let input;
  if (milestone === null) input = { boundary: 'task', task: label };
  else if (SLICE_ID_RE.test(label)) input = { boundary: 'slice', milestone, slice: label };
  else if (label === `${milestone}-triage`) input = { boundary: 'milestone-triage', milestone };
  else return null;
  let scope;
  try { scope = scopeOf(input); } catch { return null; }
  if (!dispatchBelongs(row, scope)) return null;
  const slice = row.slice === undefined || row.slice === null || row.slice === '' ? null : row.slice;
  return slice !== null && slice !== scope.slice ? null : scope;
}
/**
 * Issue 342: one bounded (16 MiB) stable read of the owner global log. Returns the
 * measured review-fix windows whose scope the dispatch proves, plus named counts of
 * what cannot be measured or attributed. Read-only; it never assigns attempts to samples.
 */
function reviewFixAttempts(owner) {
  const real = ownerReal(owner);
  const read = boundedRead(ownerEventsFile(real), MAX_OWNER_EVENTS_BYTES);
  if (read === null) return { status: 'absent' };
  if (read.error) return { status: 'unavailable', reason: read.error };
  const parsed = parseLines(read.buffer);
  if (parsed.error) return { status: 'unavailable', reason: parsed.error };
  const rows = parsed.rows, counts = { unmeasured: 0, missing_dispatch: 0, invalid_scope: 0, ambiguous: 0 };
  const byId = new Map(), dispatched = new Set();
  for (const row of rows) {
    if (row.event !== 'dispatch' || typeof row.unit !== 'string' || !row.unit.startsWith('review-fix/')) continue;
    if (typeof row.dispatch_id === 'string') dispatched.add(row.dispatch_id);
    const id = typeof row.dispatch_id === 'string' && DISPATCH_ID_RE.test(row.dispatch_id) ? row.dispatch_id : null;
    // A legacy dispatch without an id can never be paired with a measured attempt.
    if (id === null) { counts.unmeasured++; continue; }
    if (!byId.has(id)) byId.set(id, { scopes: new Map(), invalid: 0 });
    const entry = byId.get(id), scope = reviewFixScope(row);
    if (scope) entry.scopes.set(scope.key, scope); else entry.invalid++;
  }
  const attempts = [];
  for (const [id, entry] of byId) {
    if (entry.scopes.size > 1 || entry.scopes.size === 1 && entry.invalid) { counts.ambiguous++; continue; }
    if (!entry.scopes.size) { counts.invalid_scope++; continue; }
    const scope = [...entry.scopes.values()][0], window = attemptWindow(rows, id, scope.unit_label);
    if (window === null) { counts.unmeasured++; continue; }
    attempts.push({ dispatch_id: id, boundary: scope.boundary, key: scope.key, milestone: scope.milestone || null, slice: scope.slice || null,
      task: scope.task || null, start: window.start, end: window.end });
  }
  const orphans = new Set();
  for (const row of rows) {
    if (row.event === 'sidecar-unit' && typeof row.unit === 'string' && row.unit.startsWith('review-fix/')
      && typeof row.dispatch_id === 'string' && row.dispatch_id && !dispatched.has(row.dispatch_id)) orphans.add(row.dispatch_id);
  }
  counts.missing_dispatch = orphans.size;
  attempts.sort((a, b) => a.start - b.start || a.end - b.end || (a.dispatch_id < b.dispatch_id ? -1 : a.dispatch_id > b.dispatch_id ? 1 : 0));
  return { status: 'available', sha256: sha256(read.buffer), bytes: read.buffer.length, max_bytes: MAX_OWNER_EVENTS_BYTES,
    malformed_lines: parsed.malformed, attempts, counts };
}

// ── Decision ────────────────────────────────────────────────────────────────
function itemRows(verdicts) {
  return verdicts.map(item => ({ r: item.r, ...(item.review_file ? { review_file: item.review_file } : {}), basis: item.basis,
    fix_now: item.classification.fix_now, reasons: item.classification.reasons }));
}
function refusedDecision(ctx, history, code, extra) {
  return { allowed: false, decision: 'refused', mode: 'new', reason_code: code, counted: false,
    cycle: history && Number.isSafeInteger(history.consumed) ? history.consumed : null, ...extra };
}
/**
 * Pure decision in the contract order: invalid → replay → recovery → triage →
 * cycle cap → measured budget → fix-now filter → admitted.
 */
function decideAdmission(ctx, history) {
  if (!ctx || ctx.invalid || !history || history.status !== 'valid') {
    return refusedDecision(ctx, history, 'review-fix-policy-invalid', { detail: (ctx && ctx.invalid) || (history && history.reason) || 'history-unreadable' });
  }
  const replay = history.admitted.find(row => row.identity === ctx.identity);
  if (replay) return { allowed: true, decision: 'admitted', mode: 'replay', counted: false, cycle: replay.cycle, recorded: replay };
  if (ctx.recovery_of) {
    const parent = history.admitted.find(row => row.dispatch_id === ctx.recovery_of)
      || history.admitted.find(row => descendsFrom(ctx.recovery_of, row.dispatch_id));
    const legacy = !parent && history.legacy.dispatch_ids.find(id => descendsFrom(ctx.recovery_of, id));
    const bound = ctx.dispatch_id.includes('-recovery-') && isRecoveryOf(ctx.dispatch_id, ctx.recovery_of);
    if (!bound || (!parent && !legacy)) return refusedDecision(ctx, history, 'review-fix-policy-invalid', { detail: 'recovery-parent-unknown' });
    if (parent && parent.correction_identity !== ctx.correction_identity) {
      return refusedDecision(ctx, history, 'review-fix-policy-invalid', { detail: 'recovery-correction-mismatch' });
    }
    return { allowed: true, decision: 'admitted', mode: 'recovery', counted: false, recovery_of: ctx.recovery_of,
      cycle: parent ? parent.cycle : null, recorded: parent || { dispatch_id: legacy, legacy: true } };
  }
  if (ctx.scope.boundary === 'milestone-triage') return { allowed: true, decision: 'admitted', mode: 'new', counted: false, cycle: null };
  if (history.consumed >= CYCLE_LIMIT) return refusedDecision(ctx, history, 'review-fix-cycle-limit');
  if (history.budget.status === 'complete' && history.budget.ratio >= BUDGET_RATIO) return refusedDecision(ctx, history, 'review-fix-budget-exhausted');
  const refused = ctx.verdicts.filter(item => !item.classification.admissible);
  if (refused.length) {
    return refusedDecision(ctx, history, 'review-fix-not-fix-now', { refused_items: refused.map(item => ({ r: item.r,
      ...(item.review_file ? { review_file: item.review_file } : {}), reasons: item.classification.reasons })) });
  }
  return { allowed: true, decision: 'admitted', mode: 'new', counted: true, cycle: history.consumed + 1 };
}

function admissionContext(input) {
  if (!plainObject(input)) throw invalid('admission input must be an object');
  const scope = scopeOf(input);
  if (typeof input.dispatch_id !== 'string' || !DISPATCH_ID_RE.test(input.dispatch_id)) throw invalid('dispatch_id invalid');
  if (input.recovery_of !== undefined && input.recovery_of !== null
      && (typeof input.recovery_of !== 'string' || !DISPATCH_ID_RE.test(input.recovery_of))) throw invalid('recovery_of invalid');
  const brief = input.brief;
  if (!plainObject(brief) || !HEX64_RE.test(brief.identity || '') || brief.boundary !== scope.boundary || brief.unit_label !== scope.unit_label
      || !Array.isArray(brief.items) || !Array.isArray(brief.claim_paths)) throw invalid('brief does not match the boundary');
  const verdicts = itemVerdicts(input.items);
  let normalized;
  try { normalized = require('./forge-review-fix').normalizeItems(input.items); } catch { throw invalid('items do not normalize'); }
  if (JSON.stringify(normalized) !== JSON.stringify(brief.items)) throw invalid('items differ from the brief');
  return { scope, dispatch_id: input.dispatch_id, recovery_of: input.recovery_of || null, brief_identity: brief.identity,
    identity: decisionIdentity(scope.key, input.dispatch_id, brief.identity), correction_identity: correctionIdentity(scope, brief), verdicts };
}
function admissionEvent(ctx, decision, budget, at) {
  const s = ctx.scope;
  return { ts: new Date(at).toISOString(), event: ADMISSION_EVENT, policy_version: POLICY_VERSION, identity: ctx.identity,
    correction_identity: ctx.correction_identity, boundary: s.boundary, boundary_key: s.key,
    ...(s.milestone ? { milestone: s.milestone } : {}), ...(s.slice ? { slice: s.slice } : {}), ...(s.task ? { task: s.task } : {}),
    dispatch_id: ctx.dispatch_id, brief_identity: ctx.brief_identity, decision: decision.decision,
    ...(decision.reason_code ? { reason_code: decision.reason_code } : {}), counted: decision.counted, cycle: decision.cycle,
    cycle_limit: CYCLE_LIMIT, budget: { status: budget.status, execute_ms: budget.execute_ms, review_fix_ms: budget.review_fix_ms,
      ratio: budget.ratio, limit: BUDGET_RATIO, reasons: budget.reasons },
    items: itemRows(ctx.verdicts), ...(decision.refused_items ? { refused_items: decision.refused_items } : {}) };
}
// Append one line and confirm the appended bytes are in the file as a whole line.
function appendVerified(owner, line) {
  const file = ownerEventsFile(owner), dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  for (const target of [path.join(owner, '.gsd'), dir, file]) {
    try { if (fs.lstatSync(target).isSymbolicLink()) throw invalid('owner events path is a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const before = fs.fstatSync(fd).size;
    let prefix = '';
    if (before > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, before - 1); if (last[0] !== 0x0a) prefix = '\n'; }
    const bytes = Buffer.from(prefix + line + '\n');
    fs.writeSync(fd, bytes);
    const after = fs.fstatSync(fd).size, span = Math.min(after - before, MAX_INPUT_BYTES);
    const check = Buffer.alloc(Math.max(span, 0));
    if (span > 0) fs.readSync(fd, check, 0, span, before);
    if (after < before + bytes.length || !check.includes(Buffer.from(line + '\n'))) throw invalid('appended bytes not confirmed');
  } finally { fs.closeSync(fd); }
}
function publicResult(ctx, decision, history, eventWritten) {
  const budget = history ? history.budget : { status: 'unknown', execute_ms: null, review_fix_ms: null, ratio: null, limit: BUDGET_RATIO, reasons: ['history-unreadable'] };
  const scope = ctx && ctx.scope;
  const { recorded, ...rest } = decision;
  return { policy_version: POLICY_VERSION, ...rest, provider_called: false, cycle_limit: CYCLE_LIMIT,
    ...(scope ? { boundary: scope.boundary, boundary_key: scope.key } : {}), ...(ctx && ctx.identity ? { identity: ctx.identity, correction_identity: ctx.correction_identity, dispatch_id: ctx.dispatch_id } : {}),
    budget, items: ctx && ctx.verdicts ? itemRows(ctx.verdicts) : [], malformed_lines: history ? history.malformed_lines : null,
    event_written: eventWritten,
    status_line: scope ? (scope.boundary === 'milestone-triage' ? `⚖ Review ${scope.label}: triagem final, fora do teto de ciclos`
      : renderStatusLine({ label: scope.label, cycles: decision.cycle, budget })) : null };
}

/**
 * Public admission: validation, bounded history, decision and the single
 * `review-fix-admission` append happen under the canonical owner lock. Replay
 * and recovery return the recorded decision without a new event.
 */
function admitCorrection(input, options = {}) {
  let owner, ctx;
  try { owner = ownerReal(input && input.owner); } catch (error) {
    return publicResult(null, refusedDecision(null, null, 'review-fix-policy-invalid', { detail: error.detail }), null, false);
  }
  try { ctx = admissionContext(input); }
  catch (error) {
    if (error.code !== 'review-fix-policy-invalid') throw error;
    let scope = null;
    try { scope = scopeOf(input); } catch { /* no boundary: nothing attributable to record */ }
    ctx = scope && typeof input.dispatch_id === 'string' && DISPATCH_ID_RE.test(input.dispatch_id)
      ? { scope, invalid: error.detail || 'input-invalid', dispatch_id: input.dispatch_id, identity: decisionIdentity(scope.key, input.dispatch_id, 'invalid'),
        correction_identity: sha256(JSON.stringify(['invalid', scope.key])), brief_identity: 'invalid', verdicts: [] } : null;
    if (!ctx) return publicResult(null, refusedDecision(null, null, 'review-fix-policy-invalid', { detail: error.detail }), null, false);
  }
  const at = nowOf(input.now !== undefined ? input.now : options.now);
  try {
    return require('./forge-artifact-reconciliation').withOwnerLock(owner, () => {
      const history = ctx.invalid ? null : readHistory(owner, ctx.scope, options);
      const decision = decideAdmission(ctx, history);
      if (decision.mode === 'replay' || decision.mode === 'recovery') return publicResult(ctx, decision, history, false);
      const budget = history ? history.budget : { status: 'unknown', execute_ms: null, review_fix_ms: null, ratio: null, reasons: ['input-invalid'] };
      appendVerified(owner, JSON.stringify(admissionEvent(ctx, decision, budget, at)));
      return publicResult(ctx, decision, history, true);
    });
  } catch (error) {
    // Fail closed: an unconfirmed append or an unavailable lock never admits.
    return publicResult(ctx, refusedDecision(ctx, null, 'review-fix-policy-invalid', { detail: error.code === 'review-fix-policy-invalid' ? error.detail : 'owner-lock-or-append-failed' }), null, false);
  }
}

/** The admitted decision recorded for an identity (or dispatch_id + brief identity), else null. */
function findAdmission(input, options = {}) {
  const value = plainObject(input) ? input : {};
  const scope = scopeOf(value);
  const identity = HEX64_RE.test(value.identity || '') ? value.identity
    : typeof value.dispatch_id === 'string' && HEX64_RE.test(value.brief_identity || '') ? decisionIdentity(scope.key, value.dispatch_id, value.brief_identity) : null;
  if (!identity) throw invalid('identity or dispatch_id + brief_identity required');
  const history = readHistory(value.owner, scope, options);
  if (history.status !== 'valid') throw invalid(history.reason);
  return history.admitted.find(row => row.identity === identity) || null;
}

// ── Status ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'desconhecido';
  const minutes = Math.round(ms / 60000);
  if (minutes === 0) return ms > 0 ? '<1 min' : '0 min';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
/** `⚖ Review <S##|TASK_ID>: ciclo n/2 · review-fix X / execute Y (Z% | desconhecido)`. */
function renderStatusLine(row) {
  const budget = row && row.budget ? row.budget : {};
  const cycles = Number.isSafeInteger(row && row.cycles) ? String(row.cycles) : 'desconhecido';
  const ratio = budget.status === 'complete' && Number.isFinite(budget.ratio) ? `${Math.round(budget.ratio * 100)}%` : 'desconhecido';
  return `⚖ Review ${row.label}: ciclo ${cycles}/${CYCLE_LIMIT} · review-fix ${formatDuration(budget.review_fix_ms)} / execute ${formatDuration(budget.execute_ms)} (${ratio})`;
}
function statusRow(owner, scope, options) {
  const history = readHistory(owner, scope, options);
  const row = { boundary: scope.boundary, boundary_key: scope.key, label: scope.label,
    ...(scope.milestone ? { milestone: scope.milestone } : {}), ...(scope.slice ? { slice: scope.slice } : {}), ...(scope.task ? { task: scope.task } : {}),
    history: history.status === 'valid' ? 'valid' : 'unknown', ...(history.reason ? { history_reason: history.reason } : {}),
    cycles: history.status === 'valid' ? history.consumed : null, cycle_limit: CYCLE_LIMIT,
    admitted_cycles: history.status === 'valid' ? history.counted : null, legacy_cycles: history.status === 'valid' ? history.legacy.count : null,
    refusals: history.admissions.filter(r => r.decision === 'refused').length, malformed_lines: history.malformed_lines, budget: history.budget };
  return { ...row, line: renderStatusLine(row) };
}
function slicesOf(owner, milestone) {
  const found = new Set();
  const dir = path.join(owner, '.gsd', 'milestones', milestone, 'slices');
  try { for (const name of fs.readdirSync(dir)) if (SLICE_ID_RE.test(name)) found.add(name); } catch { /* no slice directory */ }
  const read = boundedRead(ownerEventsFile(owner), MAX_OWNER_EVENTS_BYTES);
  if (read && read.buffer) {
    for (const row of parseLines(read.buffer).rows) {
      if (row.milestone !== milestone) continue;
      if (row.event === ADMISSION_EVENT && row.boundary === 'slice' && SLICE_ID_RE.test(row.slice || '')) found.add(row.slice);
      const match = row.event === 'dispatch' && typeof row.unit === 'string' && /^review-fix\/(S\d{1,4})$/.exec(row.unit);
      if (match) found.add(match[1]);
    }
  }
  return [...found].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
/** Read-only measurement per boundary: cycles, times and ratio or unknown with reasons. */
function readStatus(input, options = {}) {
  const value = plainObject(input) ? input : {};
  const owner = ownerReal(value.owner || value.cwd);
  let scopes;
  if (value.task !== undefined) scopes = [scopeOf({ boundary: 'task', task: value.task })];
  else if (value.slice !== undefined) scopes = [scopeOf({ boundary: 'slice', milestone: value.milestone, slice: value.slice })];
  else {
    if (!MILESTONE_ID_RE.test(value.milestone || '')) throw invalid('milestone or task required');
    scopes = slicesOf(owner, value.milestone).map(slice => scopeOf({ boundary: 'slice', milestone: value.milestone, slice }));
  }
  return { policy_version: POLICY_VERSION, cycle_limit: CYCLE_LIMIT, budget_ratio: BUDGET_RATIO, rows: scopes.map(scope => statusRow(owner, scope, options)) };
}

// ── Review-leg guard ────────────────────────────────────────────────────────
function legError(code, details) {
  return Object.assign(new Error(code === 'review-per-task-in-milestone'
    ? 'Revisão por task dentro de milestone recusada: só complete-slice revisa (review.milestone_task_review não está true)'
    : code === 'review-already-completed' ? 'Revisão da slice já concluída: nova perna de revisão recusada'
      : 'Contexto de revisão inválido para a política'), { code, provider_called: false, stage: 'review-policy', layer: 'review-policy', details });
}
function legRefusalEvent(owner, details, at) {
  try {
    require('./forge-artifact-reconciliation').withOwnerLock(owner, () => appendVerified(owner, JSON.stringify({ ts: new Date(at).toISOString(),
      event: LEG_REFUSAL_EVENT, reason_code: details.reason_code, milestone: details.milestone, unit: details.unit, leg: details.leg })));
    return true;
  } catch { return false; } // best-effort: the refusal itself is already decided
}
function milestoneTaskReviewEnabled(owner, options) {
  try {
    const reader = typeof options.prefsReader === 'function' ? options.prefsReader : require('./forge-prefs').readPrefs;
    const resolved = reader(owner);
    return !!resolved && resolved.ok === true && plainObject(resolved.prefs) && plainObject(resolved.prefs.review)
      && resolved.prefs.review.milestone_task_review === true;
  } catch { return false; }
}
function reviewCompleted(owner, milestone, slice) {
  const file = path.join(owner, '.gsd', 'milestones', milestone, 'slices', slice, `${slice}-REVIEW.md`);
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code !== 'ENOENT') return true; }
  const read = boundedRead(ownerEventsFile(owner), MAX_OWNER_EVENTS_BYTES);
  if (read && read.error) throw invalid('history-unreadable');
  if (!read) return false;
  const parsed = parseLines(read.buffer);
  if (parsed.error) throw invalid('history-unreadable');
  return parsed.rows.some(row => row.event === 'review' && row.milestone === milestone && row.slice === slice);
}
/**
 * Pre-provider guard of the review legs. Acts only with `{cwd, milestone, unit}`;
 * a task context or no context changes nothing. Runs after the time admission.
 */
function assertReviewLeg(input = {}) {
  const value = plainObject(input) ? input : {};
  const context = value.context;
  const leg = REVIEW_LEG_MODES.includes(value.mode) ? value.mode : REVIEW_LEG_AGENTS.includes(value.agentType) ? value.agentType : null;
  if (!leg || !plainObject(context) || !Object.hasOwn(context, 'milestone') || Object.hasOwn(context, 'task')) {
    return { status: 'not-applicable' };
  }
  const details = { milestone: context.milestone, unit: context.unit, leg };
  let owner;
  try {
    if (!MILESTONE_ID_RE.test(context.milestone || '') || typeof context.unit !== 'string' || !/^[a-z][a-z0-9-]{1,50}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(context.unit)) throw invalid('context');
    owner = ownerReal(context.cwd);
  } catch { throw legError('review-fix-policy-invalid', { ...details, reason_code: 'review-fix-policy-invalid' }); }
  const at = nowOf(value.now), slice = /^complete-slice\/(S\d{1,4})$/.exec(context.unit);
  let code = null;
  if (!slice) {
    if (milestoneTaskReviewEnabled(owner, value)) return { status: 'allowed', reason: 'milestone-task-review-pref', ...details };
    code = 'review-per-task-in-milestone';
  } else {
    let completed;
    try { completed = reviewCompleted(owner, context.milestone, slice[1]); }
    catch { throw legError('review-fix-policy-invalid', { ...details, reason_code: 'review-fix-policy-invalid' }); }
    if (completed) code = 'review-already-completed';
  }
  if (!code) return { status: 'allowed', ...details };
  const refusal = { ...details, reason_code: code };
  refusal.event_written = value.record === false ? false : legRefusalEvent(owner, refusal, at);
  throw legError(code, refusal);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function readJsonInput(file) {
  const resolved = path.resolve(file);
  const read = boundedRead(resolved, MAX_INPUT_BYTES);
  if (!read || read.error) throw invalid('input unreadable');
  let parsed;
  try { parsed = JSON.parse(new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(read.buffer)); }
  catch { throw invalid('input is not UTF-8 JSON'); }
  if (!plainObject(parsed)) throw invalid('input must be an object');
  return parsed;
}
// The native review-fix request → admission input through the canonical brief helpers.
function admissionFromRequest(request) {
  const r = plainObject(request) ? request : {};
  const fix = plainObject(r.reviewFix) ? r.reviewFix : {};
  const boundary = fix.boundary;
  const scopeInput = boundary === 'slice' ? { boundary, milestone: r.milestoneId, slice: r.sliceId }
    : boundary === 'task' ? { boundary, task: r.taskId } : { boundary, milestone: r.milestoneId };
  const base = { owner: r.contextRoot || r.cwd, ...scopeInput, dispatch_id: r.dispatchId, items: fix.items,
    ...(r.reviewFixRecoveryOf !== undefined ? { recovery_of: r.reviewFixRecoveryOf } : {}) };
  try {
    const scope = scopeOf(scopeInput), helpers = require('./forge-review-fix');
    const items = helpers.normalizeItems(fix.items), claim = helpers.deriveClaim(items);
    base.brief = helpers.buildBrief({ boundary: scope.boundary, unitLabel: scope.unit_label, items, claimPaths: claim.paths || [], route: r.route });
  } catch { base.brief = null; }
  return base;
}
function main(argv = process.argv.slice(2), io = process) {
  const usage = message => { io.stderr.write(`Uso inválido: ${message}\n`); return 2; };
  const args = {}, seen = new Set();
  let operation = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) return usage(`opção repetida ${arg}`);
    seen.add(arg);
    if (['--status', '--classify', '--admit'].includes(arg)) { if (operation) return usage('uma operação por chamada'); operation = arg; }
    else if (arg === '--json') args.json = true;
    else if (['--cwd', '--milestone', '--slice', '--task', '--input', '--request'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return usage(`${arg} exige valor`);
      args[arg.slice(2)] = value;
    } else return usage(`opção desconhecida ${arg}`);
  }
  if (!operation) return usage('informe --status, --classify ou --admit');
  if (operation === '--status') {
    if (args.input || args.request || (args.task ? args.milestone || args.slice : !args.milestone)) return usage('--status exige --milestone [--slice] ou --task');
    let status;
    try { status = readStatus({ owner: path.resolve(args.cwd || '.'), milestone: args.milestone, slice: args.slice, task: args.task }); }
    catch { return usage('owner, milestone, slice ou task inválidos'); }
    io.stdout.write(args.json ? JSON.stringify(status) + '\n' : (status.rows.length ? status.rows.map(row => row.line).join('\n') : `⚖ Review: nenhuma fronteira de review-fix registrada`) + '\n');
    return 0;
  }
  if (operation === '--classify') {
    if (!args.input || args.request || args.milestone || args.slice || args.task) return usage('--classify exige --input <arquivo>');
    let items;
    try { items = itemVerdicts(readJsonInput(args.input).items); }
    catch (error) { return usage(error.code === 'review-fix-policy-invalid' ? 'itens inválidos para a política' : 'entrada ilegível'); }
    io.stdout.write(JSON.stringify({ policy_version: POLICY_VERSION, items: items.map(item => ({ r: item.r,
      ...(item.review_file ? { review_file: item.review_file } : {}), basis: item.basis, ...item.classification })) }) + '\n');
    return 0;
  }
  if (!args.request || args.input || args.milestone || args.slice || args.task) return usage('--admit exige --request <arquivo>');
  let request;
  try { request = readJsonInput(args.request); } catch { return usage('request ilegível'); }
  const result = admitCorrection(admissionFromRequest(request));
  io.stdout.write(JSON.stringify(result) + '\n');
  if (result.allowed) return 0;
  io.stderr.write(`Review-fix recusado: ${result.reason_code}\n`);
  return 3;
}

module.exports = { POLICY_VERSION, CYCLE_LIMIT, BUDGET_RATIO, ADMISSION_EVENT, LEG_REFUSAL_EVENT, REFUSAL_CODES, REVIEW_LEG_CODES,
  REVIEW_LEG_AGENTS, TRISTATE, BASES, ITEM_REASONS, BOUNDARIES, MAX_OWNER_EVENTS_BYTES,
  classifyFinding, itemVerdicts, boundaryKey, readHistory, reviewFixAttempts, decideAdmission, admitCorrection, findAdmission, readStatus,
  renderStatusLine, formatDuration, assertReviewLeg, admissionFromRequest, main };
if (require.main === module) process.exitCode = main();
