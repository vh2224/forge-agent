#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder, isDeepStrictEqual } = require('util');
const projection = require('./forge-projection.js');
const { SHADOW_VERSION, PARAMETERS } = require('./forge-memory-popularity.js');
const { MAX_QUERY_BYTES } = require('./forge-memory-query.js');

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 10000;
const INPUT_ERROR = 'Entrada ou fonte inválida para comparação de memória.';
const FLAGS = Object.freeze({ '--cwd': 'cwd', '--query-file': 'queryFile', '--unit-type': 'unitType',
  '--limit': 'limit', '--max-tokens': 'maxTokens', '--now-ms': 'nowMs', '--commit': 'commit' });
const NUMERIC = new Set(['limit', 'maxTokens', 'nowMs']);
const LIMITATIONS = Object.freeze(['controlled-frozen-copy-required', 'same-runtime-locale-only',
  'budget-stage-not-simulated', 'context-stage-not-simulated', 'comparator-not-reused', 'ranking-not-quality']);

function invalid() { throw new Error(INPUT_ERROR); }
function validateOptions(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) ||
      Object.keys(opts).some(key => !Object.values(FLAGS).includes(key))) invalid();
  for (const key of ['cwd', 'queryFile']) {
    if (typeof opts[key] !== 'string' || !opts[key].trim() || opts[key].includes('\0')) invalid();
  }
  if (typeof opts.unitType !== 'string' || opts.unitType.length > 80 ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(opts.unitType)) invalid();
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50 ||
      !Number.isInteger(opts.maxTokens) || opts.maxTokens < 2 || opts.maxTokens > 16000 ||
      !Number.isSafeInteger(opts.nowMs)) invalid();
  if (opts.commit !== undefined && (typeof opts.commit !== 'string' || !/^[a-fA-F0-9]{7,64}$/.test(opts.commit))) invalid();
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) invalid();
  const opts = { cwd: '.' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    const value = argv[++i];
    if (!key || seen.has(key) || typeof value !== 'string' || value.startsWith('--')) invalid();
    seen.add(key);
    if (NUMERIC.has(key)) {
      if (!/^-?\d+$/.test(value)) invalid();
      opts[key] = Number(value);
    } else opts[key] = value;
  }
  validateOptions(opts);
  return opts;
}

function snapshotFailure(reason) { throw Object.assign(new Error(INPUT_ERROR), { snapshotReason: reason }); }
function optionalStat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; snapshotFailure('state-unreadable'); }
}

// Bounded local read: resolveMemoryQuery selects unit artifacts, whereas this CLI
// accepts an explicit query file. Reuse its byte ceiling, not its selection API.
function boundedRead(file, stat, maxBytes) {
  if (!stat.isFile()) snapshotFailure('state-unreadable');
  if (stat.size > maxBytes) snapshotFailure('state-limit-exceeded');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) snapshotFailure('state-unreadable');
    if (opened.size > maxBytes) snapshotFailure('state-limit-exceeded');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > maxBytes || count !== opened.size) snapshotFailure('state-limit-exceeded');
    return bytes.subarray(0, count);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function snapshot(cwd, sourceOnly) {
  let entries = 0, totalBytes = 0;
  const rows = [];
  function walk(relative) {
    if (++entries > MAX_SNAPSHOT_ENTRIES) snapshotFailure('state-limit-exceeded');
    const file = path.join(cwd, relative);
    const stat = optionalStat(file);
    if (!stat) { rows.push([relative, 'absent']); return 'absent'; }
    if (stat.isSymbolicLink()) snapshotFailure('state-link');
    if (stat.isDirectory()) {
      rows.push([relative, 'directory', stat.mode]);
      const names = fs.readdirSync(file).sort(); // Code units, independent of locale.
      if (entries + names.length > MAX_SNAPSHOT_ENTRIES) snapshotFailure('state-limit-exceeded');
      for (const name of names) walk(`${relative}/${name}`);
      return 'directory';
    }
    const bytes = boundedRead(file, stat, MAX_SNAPSHOT_BYTES - totalBytes);
    totalBytes += bytes.length;
    rows.push([relative, 'file', stat.mode, bytes.length, digest(bytes)]);
    return 'present';
  }
  try {
    let schemaMarker = null;
    if (sourceOnly) {
      // Inspect the shared parent before walking either source; do not traverse a
      // junction masquerading as .gsd. Absence itself is fingerprinted.
      const parent = optionalStat(path.join(cwd, '.gsd'));
      if (parent && (parent.isSymbolicLink() || !parent.isDirectory())) snapshotFailure('state-link');
      walk('.gsd/memory');
      schemaMarker = walk('.gsd/SCHEMA-VERSION');
      if (schemaMarker === 'directory') snapshotFailure('state-unreadable');
    } else walk('.gsd');
    return { fingerprint: digest(JSON.stringify(rows)), schemaMarker };
  } catch (error) {
    if (sourceOnly) invalid();
    return { fingerprint: null, reason: error.snapshotReason || 'state-unreadable' };
  }
}

function buildComparisonReport(opts) {
  validateOptions(opts); // No filesystem or projection calls precede this check.
  try {
    const cwd = path.resolve(opts.cwd);
    const queryFile = path.resolve(opts.queryFile);
    const queryStat = optionalStat(queryFile);
    if (!queryStat || queryStat.isSymbolicLink()) invalid();
    const queryBytes = boundedRead(queryFile, queryStat, MAX_QUERY_BYTES);
    const query = new TextDecoder('utf-8', { fatal: true }).decode(queryBytes);
    if (!query.trim() || query.includes('\0')) invalid();
    const sourceBefore = snapshot(cwd, true);
    const stateBefore = snapshot(cwd, false);
    const queryOptions = { query, unitType: opts.unitType, limit: opts.limit, maxTokens: opts.maxTokens, nowMs: opts.nowMs };
    let off, on, again, warnings = 0;
    const originalWrite = process.stderr.write;
    try {
      process.stderr.write = function (_chunk, encoding, callback) {
        warnings++;
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') done();
        return true;
      };
      off = projection.queryMemoryEntries(cwd, { ...queryOptions, popularityShadow: false });
      on = projection.queryMemoryEntries(cwd, { ...queryOptions, popularityShadow: true });
      again = projection.queryMemoryEntries(cwd, { ...queryOptions, popularityShadow: false });
    } finally { process.stderr.write = originalWrite; }
    const sourceAfter = snapshot(cwd, true);
    const stateAfter = snapshot(cwd, false);
    const { popularity_shadow: shadow, ...active } = on;
    const activeEqual = isDeepStrictEqual(off, active) && isDeepStrictEqual(off, again);
    const sourceEqual = sourceBefore.fingerprint === sourceAfter.fingerprint;
    const persistedEqual = stateBefore.fingerprint === null || stateAfter.fingerprint === null
      ? null : stateBefore.fingerprint === stateAfter.fingerprint;
    const equalities = [activeEqual, sourceEqual, persistedEqual];
    const invariance = equalities.includes(false) ? 'violated' : equalities.includes(null) ? 'unknown' : 'held';
    return {
      report_version: 1, shadow_version: SHADOW_VERSION, parameters: { ...PARAMETERS },
      inputs: { source_scope: ['.gsd/memory/**', '.gsd/SCHEMA-VERSION'], schema_marker: sourceBefore.schemaMarker,
        source_fingerprint_before: sourceBefore.fingerprint, source_fingerprint_after: sourceAfter.fingerprint,
        query_sha256: digest(queryBytes), unit_type: opts.unitType, limit: opts.limit, max_tokens: opts.maxTokens,
        now_ms: opts.nowMs, commit: opts.commit || 'unknown' },
      source_equal: sourceEqual, active_equal: activeEqual, persisted_scope: '.gsd', persisted_equal: persistedEqual,
      persisted_reason: persistedEqual === null ? stateBefore.reason || stateAfter.reason : null,
      invariance, projection_warnings: warnings, popularity_shadow: shadow,
      apply_policy: false, efficacy: 'not-evaluated', corpus: 'unspecified', family_count: 1,
      conditions: { node: process.version, locale: Intl.Collator().resolvedOptions().locale }, limitations: [...LIMITATIONS],
    };
  } catch (_) { invalid(); }
}

module.exports = { buildComparisonReport, parseArgs };
if (require.main === module) {
  try {
    const report = buildComparisonReport(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = { held: 0, violated: 1, unknown: 3 }[report.invariance];
  } catch (_) {
    process.stderr.write(`${INPUT_ERROR}\n`);
    process.exitCode = 2;
  }
}
