#!/usr/bin/env node
'use strict';

// Bounded, read-only adapters for the autonomy report. This module deliberately
// accepts explicit files only: it never discovers runs, gates, or personal work.

const fs = require('fs');
const path = require('path');
const { classify, entityKind, isValid } = require('./forge-ids.js');
const { resolveOwner } = require('./forge-workspace.js');
const { validateWorktreeIdentity } = require('./forge-isolation.js');
const {
  MAX_FILE_BYTES,
  resolveSafeFile,
  sha256,
  fingerprint,
} = require('./forge-delivery.js');

const MAX_SOURCE_REFERENCES = 100;
const MAX_RECORDS_PER_SOURCE = 10000;
const SOURCE_KINDS = Object.freeze(['gates', 'events', 'results']);
const LOCAL_TASK_RE = /^T\d+$/;
const SLICE_RE = /^S\d+$/;
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rootLabelForCwd(cwd, rootAliases) {
  if (!path.isAbsolute(cwd)) return null;
  const match = rootAliases.find((entry) => entry.paths.some((allowed) => samePath(allowed, cwd)));
  return match ? match.name : null;
}

function diagnostic(code, fields = {}, severity = 'error') {
  return { severity, code, ...fields };
}

function normalizeTarget(raw) {
  if (!isObject(raw) || !['task', 'slice', 'milestone'].includes(raw.type) || !nonEmpty(raw.id)) {
    return { error: 'target_invalid' };
  }
  const target = { type: raw.type, id: raw.id.trim() };
  if (raw.type === 'task') {
    if (LOCAL_TASK_RE.test(target.id)) {
      if (!nonEmpty(raw.milestone) || !isValid(raw.milestone) || entityKind(raw.milestone) !== 'milestone' || !SLICE_RE.test(raw.slice || '')) {
        return { error: 'target_local_task_context_invalid' };
      }
      target.milestone = raw.milestone.trim();
      target.slice = raw.slice.trim();
      target.scope = 'local';
    } else {
      if (!isValid(target.id) || entityKind(target.id) !== 'task' || raw.milestone !== undefined || raw.slice !== undefined) {
        return { error: 'target_global_task_invalid' };
      }
      target.scope = classify(target.id);
    }
  } else if (raw.type === 'slice') {
    if (!SLICE_RE.test(target.id) || !nonEmpty(raw.milestone) || !isValid(raw.milestone) || entityKind(raw.milestone) !== 'milestone') {
      return { error: 'target_slice_invalid' };
    }
    target.milestone = raw.milestone.trim();
  } else if (!isValid(target.id) || entityKind(target.id) !== 'milestone' || raw.milestone !== undefined || raw.slice !== undefined) {
    return { error: 'target_milestone_invalid' };
  }
  return { target };
}

function resolveRoots(input, options = {}) {
  const baseDir = path.resolve(options.baseDir || process.cwd());
  if (!nonEmpty(input.owner_root)) return { error: 'owner_root_missing' };
  const ownerCandidate = path.resolve(baseDir, input.owner_root);
  let ownerReal;
  try { ownerReal = fs.realpathSync(ownerCandidate); } catch (_) { return { error: 'owner_root_unreadable' }; }
  let resolvedOwner;
  try { resolvedOwner = resolveOwner(ownerReal, { stopAt: ownerReal }); } catch (_) { return { error: 'owner_root_invalid' }; }
  if (!resolvedOwner || !samePath(fs.realpathSync(resolvedOwner), ownerReal)) return { error: 'owner_root_not_project' };

  const codeCandidate = nonEmpty(input.code_root) ? path.resolve(baseDir, input.code_root) : ownerReal;
  let codeReal;
  try { codeReal = fs.realpathSync(codeCandidate); } catch (_) { return { error: 'code_root_unreadable' }; }
  let branch = null;
  if (!samePath(ownerReal, codeReal)) {
    if (!nonEmpty(input.branch)) return { error: 'worktree_branch_missing' };
    branch = input.branch.trim();
    const identity = validateWorktreeIdentity(ownerReal, codeReal, branch);
    if (!identity || !identity.ok) return { error: `worktree_${identity && identity.reason ? identity.reason : 'invalid'}` };
  }
  const sameRoot = samePath(ownerReal, codeReal);
  const ownerAliases = [ownerCandidate, ownerReal];
  if (sameRoot) ownerAliases.push(codeCandidate);
  const rootAliases = [{ name: 'owner', paths: ownerAliases }];
  if (!sameRoot) rootAliases.push({ name: 'code', paths: [codeCandidate, codeReal] });
  return {
    owner: ownerReal,
    code: codeReal,
    branch,
    roots: sameRoot ? [ownerReal] : [ownerReal, codeReal],
    rootAliases,
  };
}

function validateManifest(input, options = {}) {
  if (!isObject(input) || input.schema_version !== 1 || !isObject(input.sources)) {
    return { diagnostics: [diagnostic('manifest_invalid')] };
  }
  const targetResult = normalizeTarget(input.target);
  if (targetResult.error) return { diagnostics: [diagnostic(targetResult.error)] };
  const rootsResult = resolveRoots(input, options);
  if (rootsResult.error) return { target: targetResult.target, diagnostics: [diagnostic(rootsResult.error)] };
  const sources = {};
  let total = 0;
  for (const kind of SOURCE_KINDS) {
    const value = input.sources[kind];
    if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry))) {
      return { target: targetResult.target, diagnostics: [diagnostic('sources_invalid', { source_kind: kind })] };
    }
    total += value.length;
    sources[kind] = value.slice();
  }
  const extra = Object.keys(input.sources).filter((key) => !SOURCE_KINDS.includes(key));
  if (extra.length > 0) return { target: targetResult.target, diagnostics: [diagnostic('source_kind_unsupported')] };
  if (total > MAX_SOURCE_REFERENCES) {
    return { target: targetResult.target, diagnostics: [diagnostic('source_reference_limit_exceeded', { limit: MAX_SOURCE_REFERENCES })] };
  }
  return { target: targetResult.target, sources, ...rootsResult, io: options.io || fs, diagnostics: [] };
}

function rootsStillValid(context) {
  try {
    if (!samePath(fs.realpathSync(context.owner), context.owner) || !samePath(fs.realpathSync(context.code), context.code)) return false;
    const owner = resolveOwner(context.owner, { stopAt: context.owner });
    if (!owner || !samePath(fs.realpathSync(owner), context.owner)) return false;
  } catch (_) {
    return false;
  }
  if (!samePath(context.owner, context.code)) {
    const identity = validateWorktreeIdentity(context.owner, context.code, context.branch);
    if (!identity || !identity.ok) return false;
  }
  return true;
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Read through one descriptor into a fixed buffer. A concurrent writer can make
// the observation invalid or too large, but can never make this helper allocate
// or read beyond maxBytes + 1.
function readBoundedStableFile(file, maxBytes = MAX_FILE_BYTES, options = {}) {
  const io = options.io || fs;
  let descriptor;
  let before;
  let after;
  let pathAfter;
  let realAfter;
  let buffer;
  let total = 0;
  try {
    descriptor = io.openSync(file, 'r');
    before = io.fstatSync(descriptor);
    if (!before.isFile()) return { error: 'source_not_file' };
    if (before.size > maxBytes) return { error: 'source_too_large' };
    buffer = Buffer.allocUnsafe(maxBytes + 1);
    while (total < buffer.length) {
      const count = io.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    after = io.fstatSync(descriptor);
    pathAfter = io.statSync(file);
    realAfter = io.realpathSync(file);
  } catch (_) {
    return { error: 'source_unreadable' };
  } finally {
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); } catch (_) { /* observation already failed closed */ }
    }
  }
  if (total > maxBytes || after.size > maxBytes || pathAfter.size > maxBytes) return { error: 'source_too_large' };
  const expectedReal = options.expectedReal || file;
  const unchanged = before.isFile() && after.isFile() && pathAfter.isFile()
    && before.size === total && after.size === total && pathAfter.size === total
    && sameStatIdentity(before, after) && sameStatIdentity(after, pathAfter)
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && samePath(expectedReal, realAfter);
  if (!unchanged) return { error: 'source_changed_during_read' };
  return { buffer: buffer.subarray(0, total), stat: after, real: realAfter };
}

function stableFileRead(reference, kind, index, context) {
  if (!rootsStillValid(context)) return { error: 'source_root_identity_changed' };
  const resolved = resolveSafeFile(reference, context.roots, { base: context.owner, maxBytes: MAX_FILE_BYTES });
  if (resolved.error) return { error: resolved.error };
  const read = readBoundedStableFile(resolved.path, MAX_FILE_BYTES, { io: context.io, expectedReal: resolved.path });
  if (read.error) return read;
  if (!rootsStillValid(context)) return { error: 'source_root_identity_changed' };

  const rootName = samePath(context.owner, context.code) || inside(context.owner, resolved.path) ? 'owner' : 'code';
  const root = rootName === 'owner' ? context.owner : context.code;
  const relative = path.relative(root, resolved.path).split(path.sep).join('/');
  return {
    buffer: read.buffer,
    reference: {
      source: `${rootName}:${relative}`,
      sha256: sha256(read.buffer),
      source_kind: kind,
      source_index: index,
    },
  };
}

function parseJsonSource(read, kind, index) {
  try {
    const text = read.buffer.toString('utf8').replace(/^\uFEFF/, '');
    return { value: JSON.parse(text) };
  } catch (_) {
    return { error: diagnostic('source_malformed_json', { source_kind: kind, source_index: index }) };
  }
}

function parseJsonlSource(read, index) {
  const text = read.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r\n|\n|\r/);
  const populated = lines.map((raw, offset) => ({ raw, line: offset + 1 })).filter((row) => row.raw.trim() !== '');
  if (populated.length > MAX_RECORDS_PER_SOURCE) {
    return { error: diagnostic('source_record_limit_exceeded', { source_kind: 'events', source_index: index, limit: MAX_RECORDS_PER_SOURCE }) };
  }
  const records = [];
  for (const row of populated) {
    let value;
    try { value = JSON.parse(row.raw); } catch (_) {
      return { error: diagnostic('source_malformed_jsonl', { source_kind: 'events', source_index: index, line: row.line }) };
    }
    if (!isObject(value)) {
      return { error: diagnostic('event_record_invalid_type', { source_kind: 'events', source_index: index, line: row.line }) };
    }
    records.push({ value, line: row.line });
  }
  return { records };
}

function referenceAt(base, location) {
  return { ...base, ...location };
}

function fullIso(value) {
  return nonEmpty(value) && ISO_WITH_ZONE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function unitNames(target) {
  if (target.type === 'task') return new Set([`execute-task/${target.id}`, `review-fix/${target.id}`]);
  if (target.type === 'slice') return new Set([target.id, `plan-slice/${target.id}`, `complete-slice/${target.id}`]);
  return new Set([target.id, `plan-milestone/${target.id}`, `complete-milestone/${target.id}`]);
}

function unitMatchesTarget(event, target) {
  if (!nonEmpty(event.unit)) return false;
  if (target.type === 'task' && target.scope !== 'local') {
    return unitNames(target).has(event.unit) && (!nonEmpty(event.milestone) || event.milestone === target.id);
  }
  if (target.type === 'task') {
    return event.milestone === target.milestone && event.slice === target.slice && unitNames(target).has(event.unit);
  }
  if (target.type === 'slice') {
    if (event.milestone !== target.milestone || event.slice !== target.id) return false;
    return unitNames(target).has(event.unit) || /^(?:execute-task|review-fix)\/T\d+$/.test(event.unit);
  }
  if (event.milestone !== target.id) return false;
  if (unitNames(target).has(event.unit)) return true;
  return SLICE_RE.test(event.slice || '') && (
    /^(?:execute-task|review-fix)\/T\d+$/.test(event.unit)
    || event.unit === `plan-slice/${event.slice}`
    || event.unit === `complete-slice/${event.slice}`
  );
}

function gateMatchesTarget(gate, target) {
  if (target.type === 'task' && target.scope === 'local') return false;
  if (target.type === 'task') return gate.run_id === target.id && unitNames(target).has(gate.unit_id);
  if (target.type === 'slice') return gate.run_id === target.milestone && unitNames(target).has(gate.unit_id);
  if (gate.run_id !== target.id || !nonEmpty(gate.unit_id)) return false;
  return unitNames(target).has(gate.unit_id) || SLICE_RE.test(gate.unit_id)
    || /^(?:plan-slice|complete-slice)\/S\d+$/.test(gate.unit_id)
    || /^(?:execute-task|review-fix)\/T\d+$/.test(gate.unit_id);
}

function reviewMatchesTarget(review, target) {
  if (target.type === 'task') return false;
  if (target.type === 'slice') return review.milestone === target.milestone && review.slice === target.id;
  return review.milestone === target.id && SLICE_RE.test(review.slice);
}

function gateAnswerMatchesStatus(status, answer) {
  if (status === 'pending') return answer === undefined || answer === null;
  if (status === 'answered') return isObject(answer) && answer.source === 'human';
  if (status === 'cancelled') return isObject(answer) && answer.source === 'cancelled';
  if (status === 'expired') return answer === undefined || answer === null
    || (isObject(answer) && answer.source === 'timeout-default');
  return false;
}

function normalizeGate(value, rootAliases, target) {
  if (!isObject(value) || value.schema !== 1 || !nonEmpty(value.id) || !nonEmpty(value.cwd)
      || !nonEmpty(value.run_id) || !nonEmpty(value.unit_id) || !nonEmpty(value.status)
      || typeof value.created_at !== 'number' || !Number.isFinite(value.created_at) || value.created_at < 0) {
    return { error: 'gate_record_invalid' };
  }
  if (!['pending', 'answered', 'expired', 'cancelled'].includes(value.status)) return { error: 'gate_status_invalid' };
  const cwdLabel = rootLabelForCwd(value.cwd, rootAliases);
  if (!cwdLabel) return { foreign: 'gate_cwd_foreign' };
  const answer = value.answer;
  if (answer !== undefined && answer !== null && !isObject(answer)) return { error: 'gate_answer_invalid' };
  if (!gateAnswerMatchesStatus(value.status, answer)) return { error: 'gate_status_answer_invalid' };
  if (isObject(answer) && (!['human', 'timeout-default', 'cancelled'].includes(answer.source)
      || typeof answer.at !== 'number' || !Number.isFinite(answer.at) || answer.at < 0)) {
    return { error: 'gate_answer_invalid' };
  }
  const normalized = {
    id: value.id,
    cwd: cwdLabel,
    run_id: value.run_id,
    unit_id: value.unit_id,
    status: value.status,
    created_at: value.created_at,
    answer: answer ? { source: nonEmpty(answer.source) ? answer.source : null, at: answer.at } : null,
  };
  const attributable = gateMatchesTarget(normalized, target);
  return {
    value: normalized,
    attributable,
    ...(attributable ? {} : { foreign: 'gate_not_attributable' }),
    semantic: {
      schema: value.schema,
      id: value.id,
      cwd: normalized.cwd,
      run_id: value.run_id,
      unit_id: value.unit_id,
      origin: nonEmpty(value.origin) ? value.origin : null,
      status: value.status,
      created_at: value.created_at,
      expires_at: typeof value.expires_at === 'number' && Number.isFinite(value.expires_at) ? value.expires_at : null,
      answer: answer ? { source: answer.source, at: answer.at } : null,
    },
  };
}

function normalizeDispatch(value, target) {
  if (!isObject(value) || value.event !== 'dispatch' || !nonEmpty(value.unit)
      || typeof value.dispatch_allowed !== 'boolean' || !fullIso(value.ts)) {
    return { error: 'dispatch_record_invalid' };
  }
  const normalized = {
    event: 'dispatch', ts: value.ts, unit: value.unit,
    milestone: nonEmpty(value.milestone) ? value.milestone : null,
    slice: nonEmpty(value.slice) ? value.slice : null,
    dispatch_id: nonEmpty(value.dispatch_id) ? value.dispatch_id : null,
    dispatch_allowed: value.dispatch_allowed,
  };
  const attributable = unitMatchesTarget(normalized, target);
  return {
    value: normalized,
    attributable,
    ...(attributable ? {} : { foreign: 'dispatch_not_attributable' }),
    semantic: {
      ts: value.ts,
      event: value.event,
      unit: value.unit,
      milestone: normalized.milestone,
      slice: normalized.slice,
      dispatch_id: normalized.dispatch_id,
      dispatch_allowed: value.dispatch_allowed,
      attempt: Number.isInteger(value.attempt) ? value.attempt : null,
      engine: nonEmpty(value.engine) ? value.engine : null,
      model: nonEmpty(value.model) ? value.model : null,
      host_runtime: nonEmpty(value.host_runtime) ? value.host_runtime : null,
      worker_mode: nonEmpty(value.worker_mode) ? value.worker_mode : null,
      resolved_worker_engine: nonEmpty(value.resolved_worker_engine) ? value.resolved_worker_engine : null,
      dispatch_reason_code: nonEmpty(value.dispatch_reason_code) ? value.dispatch_reason_code : null,
      dispatch_posture: nonEmpty(value.dispatch_posture) ? value.dispatch_posture : null,
      dispatch_decision: nonEmpty(value.dispatch_decision) ? value.dispatch_decision : null,
      tier: nonEmpty(value.tier) ? value.tier : null,
      effort: nonEmpty(value.effort) ? value.effort : null,
      domain: nonEmpty(value.domain) ? value.domain : null,
      route_source: nonEmpty(value.route_source) ? value.route_source : null,
      chain_len: Number.isFinite(value.chain_len) ? value.chain_len : null,
      model_applied: nonEmpty(value.model_applied) ? value.model_applied : null,
      vcs: nonEmpty(value.vcs) ? value.vcs : null,
      transport: nonEmpty(value.transport) ? value.transport : null,
      transport_version: nonEmpty(value.transport_version) ? value.transport_version : null,
    },
  };
}

function normalizeReview(value, target) {
  if (!isObject(value) || value.event !== 'review' || !fullIso(value.ts)
      || !nonEmpty(value.milestone) || !nonEmpty(value.slice)
      || !Number.isInteger(value.conceded_fixed) || value.conceded_fixed < 0
      || !isObject(value.counts)) {
    return { error: 'review_record_invalid' };
  }
  const normalized = {
    event: 'review', ts: value.ts, milestone: value.milestone, slice: value.slice,
    conceded_fixed: value.conceded_fixed,
    counts: {
      resolved: value.counts.resolved,
      conceded: value.counts.conceded,
      open: value.counts.open,
    },
  };
  if (![normalized.counts.resolved, normalized.counts.conceded, normalized.counts.open]
    .every((entry) => Number.isInteger(entry) && entry >= 0)) return { error: 'review_record_invalid' };
  if (!['dialectic', 'flags'].includes(value.style) || !Number.isInteger(value.rounds) || value.rounds < 0 || value.rounds > 3
      || !['agents', 'workflow'].includes(value.engine) || !nonEmpty(value.author_engine)
      || !nonEmpty(value.challenger) || !(value.advocate === null || nonEmpty(value.advocate))
      || typeof value.intra_family_debate !== 'boolean'
      || !Number.isInteger(value.intra_family_withdrawn) || value.intra_family_withdrawn < 0) {
    return { error: 'review_record_invalid' };
  }
  if (!reviewMatchesTarget(normalized, target)) return { foreign: 'review_not_attributable' };
  return {
    value: normalized,
    semantic: {
      ts: value.ts,
      event: value.event,
      milestone: value.milestone,
      slice: value.slice,
      style: value.style,
      rounds: value.rounds,
      counts: normalized.counts,
      conceded_fixed: value.conceded_fixed,
      engine: value.engine,
      author_engine: value.author_engine,
      challenger: value.challenger,
      advocate: value.advocate,
      intra_family_debate: value.intra_family_debate,
      intra_family_withdrawn: value.intra_family_withdrawn,
    },
  };
}

function normalizeResult(value) {
  if (!isObject(value) || !nonEmpty(value.dispatch_id) || !nonEmpty(value.status)) {
    return { error: 'result_record_invalid' };
  }
  const normalized = {
      dispatch_id: value.dispatch_id,
      status: value.status,
      started_at: value.started_at,
      finished_at: value.finished_at,
      duration_secs: value.duration_secs,
  };
  return {
    value: normalized,
    semantic: {
      ...normalized,
      protocol_version: Number.isInteger(value.protocol_version) ? value.protocol_version : null,
      start_sha: nonEmpty(value.start_sha) ? value.start_sha : null,
      head_sha: nonEmpty(value.head_sha) ? value.head_sha : null,
      vcs: nonEmpty(value.vcs) ? value.vcs : null,
      input_tokens: Number.isFinite(value.input_tokens) ? value.input_tokens : null,
      output_tokens: Number.isFinite(value.output_tokens) ? value.output_tokens : null,
      token_method: nonEmpty(value.token_method) ? value.token_method : null,
      capability: nonEmpty(value.capability) ? value.capability : null,
      capability_declared: nonEmpty(value.capability_declared) ? value.capability_declared : null,
    },
  };
}

function loadAutonomySources(input, options = {}) {
  const checked = validateManifest(input, options);
  const empty = {
    target: checked.target || null,
    gates: [], dispatches: [], reviews: [], results: [],
    provided: { gates: false, events: false, results: false },
    diagnostics: checked.diagnostics || [],
  };
  if (empty.diagnostics.length > 0) return empty;
  const context = checked;
  const output = { ...empty, target: checked.target };

  for (const kind of SOURCE_KINDS) {
    output.provided[kind] = checked.sources[kind].length > 0;
    checked.sources[kind].forEach((sourceReference, index) => {
      const read = stableFileRead(sourceReference, kind, index, context);
      if (read.error) {
        output.diagnostics.push(diagnostic(read.error, { source_kind: kind, source_index: index }));
        return;
      }
      if (kind === 'events') {
        const parsed = parseJsonlSource(read, index);
        if (parsed.error) { output.diagnostics.push(parsed.error); return; }
        for (const record of parsed.records) {
          let normalized;
          if (record.value.event === 'dispatch') normalized = normalizeDispatch(record.value, checked.target);
          else if (record.value.event === 'review') normalized = normalizeReview(record.value, checked.target);
          else {
            output.diagnostics.push(diagnostic('event_record_unsupported', { source_kind: kind, source_index: index, line: record.line }, 'warning'));
            continue;
          }
          if (normalized.error) output.diagnostics.push(diagnostic(normalized.error, { source_kind: kind, source_index: index, line: record.line }));
          else if (record.value.event === 'review' && normalized.foreign) {
            output.diagnostics.push(diagnostic(normalized.foreign, { source_kind: kind, source_index: index, line: record.line }, 'warning'));
          } else {
            if (normalized.foreign) output.diagnostics.push(diagnostic(normalized.foreign, { source_kind: kind, source_index: index, line: record.line }, 'warning'));
            const item = {
              data: normalized.value,
              semantic: normalized.semantic,
              attributable: normalized.attributable !== false,
              references: [referenceAt(read.reference, { line: record.line })],
            };
            if (record.value.event === 'dispatch') output.dispatches.push(item);
            else output.reviews.push(item);
          }
        }
        return;
      }

      const parsed = parseJsonSource(read, kind, index);
      if (parsed.error) { output.diagnostics.push(parsed.error); return; }
      if (!isObject(parsed.value)) {
        output.diagnostics.push(diagnostic(`${kind.slice(0, -1)}_record_invalid_type`, { source_kind: kind, source_index: index }));
        return;
      }
      if (kind === 'gates') {
        const normalized = normalizeGate(parsed.value, checked.rootAliases, checked.target);
        if (normalized.error) output.diagnostics.push(diagnostic(normalized.error, { source_kind: kind, source_index: index }));
        else if (normalized.foreign && !normalized.value) output.diagnostics.push(diagnostic(normalized.foreign, { source_kind: kind, source_index: index }, 'warning'));
        else {
          if (normalized.foreign) output.diagnostics.push(diagnostic(normalized.foreign, { source_kind: kind, source_index: index }, 'warning'));
          output.gates.push({ data: normalized.value, semantic: normalized.semantic, attributable: normalized.attributable !== false, references: [referenceAt(read.reference, { pointer: '/' })] });
        }
      } else {
        const normalized = normalizeResult(parsed.value);
        if (normalized.error) output.diagnostics.push(diagnostic(normalized.error, { source_kind: kind, source_index: index }));
        else output.results.push({ data: normalized.value, semantic: normalized.semantic, references: [referenceAt(read.reference, { pointer: '/' })] });
      }
    });
  }
  return output;
}

function readAutonomyManifest(file, options = {}) {
  if (!nonEmpty(file)) return { error: diagnostic('manifest_path_missing') };
  const absolute = path.resolve(file);
  let real;
  try {
    real = (options.io || fs).realpathSync(absolute);
  } catch (_) {
    return { error: diagnostic('manifest_unreadable') };
  }
  const read = readBoundedStableFile(absolute, MAX_FILE_BYTES, { io: options.io, expectedReal: real });
  if (read.error) {
    const codes = {
      source_not_file: 'manifest_not_file',
      source_too_large: 'manifest_too_large',
      source_changed_during_read: 'manifest_changed_during_read',
      source_unreadable: 'manifest_unreadable',
    };
    return { error: diagnostic(codes[read.error] || 'manifest_unreadable') };
  }
  try {
    return { input: JSON.parse(read.buffer.toString('utf8').replace(/^\uFEFF/, '')), baseDir: path.dirname(absolute), sha256: sha256(read.buffer) };
  } catch (_) {
    return { error: diagnostic('manifest_malformed_json') };
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_SOURCE_REFERENCES,
  MAX_RECORDS_PER_SOURCE,
  SOURCE_KINDS,
  ISO_WITH_ZONE_RE,
  normalizeTarget,
  validateManifest,
  readBoundedStableFile,
  loadAutonomySources,
  readAutonomyManifest,
  fingerprint,
};
