#!/usr/bin/env node
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const MAX_BYTES = 2 * 1024 * 1024, MAX_RECORDS = 50000, MAX_LINE = 32768;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return NaN;
  const localText = match[1] + '.' + (match[2] || '').padEnd(3, '0') + 'Z';
  const local = new Date(localText);
  if (!Number.isFinite(local.getTime()) || local.toISOString() !== localText) return NaN;
  if (match[3] === 'Z') return local.getTime();
  const hours = Number(match[3].slice(1, 3)), minutes = Number(match[3].slice(4, 6));
  if (hours > 23 || minutes > 59) return NaN;
  return local.getTime() - (match[3][0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000;
}
function canonical(value, depth = 0) {
  if (depth > 64) fail('phase-cost-record-depth');
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}
function identity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail('phase-cost-source-invalid');
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join('/');
}
function analyzeEvents(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail('phase-cost-input-limit');
  let text;
  try { text = new (require('util').TextDecoder)('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('phase-cost-encoding'); }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > MAX_RECORDS) fail('phase-cost-input-limit');
  const active = new Map(), seen = new Map(), byPhase = Object.create(null), intervals = [];
  const diagnostics = { ignored_records: 0, duplicate_records: 0, conflicting_ids: 0,
    ambiguous_begins: 0, unmatched_transitions: 0, unmatched_begins: 0, invalid_records: 0, negative_intervals: 0, nonterminal_transitions: 0,
    excluded_ambiguous_intervals: 0 };
  let begins = 0, transitions = 0;
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE) fail('phase-cost-line-limit');
    let row; try { row = JSON.parse(line); } catch { fail('phase-cost-json-invalid'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('phase-cost-record-invalid');
    if (!['unit-began', 'unit-transition'].includes(row.event)) { diagnostics.ignored_records++; continue; }
    if (row.event === 'unit-began') begins++; else transitions++;
    if (typeof row.idempotency_key === 'string') {
      const old = seen.get(row.idempotency_key), contents = canonical(row);
      if (old) {
        if (old === contents) { diagnostics.duplicate_records++; continue; }
        fail('phase-cost-conflicting-id');
      }
      seen.set(row.idempotency_key, contents);
    }
    if (Object.hasOwn(row, 'idempotency_key') && (typeof row.idempotency_key !== 'string'
      || !row.idempotency_key.trim() || row.idempotency_key.length > 512 || /[\x00-\x1f\x7f]/.test(row.idempotency_key))) fail('phase-cost-lifecycle-invalid');
    const at = timestamp(row.ts);
    if (!Number.isFinite(at) || typeof row.unit !== 'string' || row.unit.length > 512 || !row.unit.includes('/')
      || typeof row.milestone !== 'string' || !row.milestone.trim() || row.milestone.trim() !== row.milestone
      || row.milestone.length > 512 || /[\x00-\x1f\x7f]/.test(row.milestone)) fail('phase-cost-lifecycle-invalid');
    const parts = row.unit.split('/');
    if (parts.length !== 2 || !parts[1] || /[\s\x00-\x1f\x7f]/.test(parts[1])) fail('phase-cost-lifecycle-invalid');
    for (const field of ['host_runtime', 'host']) if (Object.hasOwn(row, field) && !['claude', 'codex'].includes(row[field])) fail('phase-cost-lifecycle-invalid');
    if (row.host && row.host_runtime && row.host !== row.host_runtime) fail('phase-cost-lifecycle-invalid');
    const phase = row.unit.split('/')[0];
    if (!/^[a-z][a-z0-9-]{1,50}$/.test(phase)) fail('phase-cost-lifecycle-invalid');
    const key = JSON.stringify([row.milestone, row.unit, row.host_runtime || row.host || null]);
    if (row.event === 'unit-began') {
      if (row.action !== 'begin') fail('phase-cost-lifecycle-invalid');
      if (active.has(key)) {
        diagnostics.ambiguous_begins++;
        const group = active.get(key); group.ambiguous = true; group.outstanding++;
      } else active.set(key, { at, phase, outstanding: 1, ambiguous: false });
      continue;
    }
    if (row.action === 'running') { diagnostics.nonterminal_transitions++; continue; }
    if (!['complete', 'pause', 'fail', 'expired-safe'].includes(row.action)) fail('phase-cost-lifecycle-invalid');
    const begin = active.get(key);
    if (!begin) { diagnostics.unmatched_transitions++; continue; }
    if (begin.ambiguous) {
      diagnostics.excluded_ambiguous_intervals++;
      if (--begin.outstanding === 0) active.delete(key);
      continue;
    }
    active.delete(key);
    if (at < begin.at) { diagnostics.negative_intervals++; continue; }
    const duration = at - begin.at;
    const stats = byPhase[phase] ||= { count: 0, duration_ms: 0, min_ms: duration, max_ms: duration };
    stats.count++; stats.duration_ms += duration; stats.min_ms = Math.min(stats.min_ms, duration); stats.max_ms = Math.max(stats.max_ms, duration);
    intervals.push([begin.at, at]);
  }
  diagnostics.unmatched_begins = [...active.values()].reduce((sum, group) => sum + group.outstanding, 0);
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = 0, cursor = null;
  for (const [start, end] of intervals) {
    if (!cursor) cursor = [start, end];
    else if (start <= cursor[1]) cursor[1] = Math.max(cursor[1], end);
    else { covered += cursor[1] - cursor[0]; cursor = [start, end]; }
  }
  if (cursor) covered += cursor[1] - cursor[0];
  const aggregate = Object.values(byPhase).reduce((sum, row) => sum + row.duration_ms, 0);
  return { schema_version: 1, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source_bytes: bytes.length,
    records: lines.length, begins, transitions, completed_pairs: intervals.length, by_phase: byPhase,
    aggregate_unit_ms: aggregate, observed_active_wall_ms: covered,
    observed_span_ms: intervals.length ? Math.max(...intervals.map(row => row[1])) - intervals[0][0] : null,
    diagnostics, fixed_overhead: { status: 'unknown', reason: 'events-do-not-separate-useful-work-from-fixed-cost' },
    actual_token_attribution: 'unknown', interpretation: 'aggregate-unit-time-is-not-wall-time-or-billing' };
}
function measurePhaseCost(file) {
  const before = identity(file), expectedReal = fs.realpathSync.native(file);
  const read = readBoundedStableFile(file, MAX_BYTES, { expectedReal });
  if (read.error || identity(file) !== before) fail('phase-cost-source-unstable');
  return analyzeEvents(read.buffer);
}
module.exports = { MAX_BYTES, analyzeEvents, measurePhaseCost };
