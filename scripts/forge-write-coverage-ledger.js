#!/usr/bin/env node
'use strict';

// Durable, append-only series for forge-write-coverage. The measurement module
// deliberately knows nothing about JSONL; this adapter owns persistence.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const mutex = require('./forge-lock.js');
const { measureCoverage } = require('./forge-write-coverage.js');

const SCHEMA_VERSION = 1;
const LEDGER_RELATIVE = '.gsd/forge/write-coverage.jsonl';
const LOCK_NAME = 'write-coverage-ledger';

function normalizeMilestone(value) {
  const id = String(value || '').trim();
  if (!/^M(?:\d{3}|-\d{8,14}(?:-[a-z0-9-]+)?)$/.test(id)) throw new Error(`milestone inválido: ${id || '(vazio)'}`);
  return id;
}

function sourceRevision(cwd, milestone) {
  let branch = null;
  try {
    const run = require('./forge-runs.js').get(cwd, milestone);
    branch = run && typeof run.branch === 'string' ? run.branch : null;
  } catch { /* registry is an optional provenance source */ }
  const candidates = [branch, `forge/${milestone}`].filter(Boolean);
  for (const ref of candidates) {
    try {
      const sha = execFileSync('git', ['rev-parse', '--verify', ref], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (sha) return { source_ref: ref, source_head: sha };
    } catch { /* try the next attributable ref */ }
  }
  return { source_ref: branch, source_head: null };
}

function compactRecord(report, milestone, opts) {
  const o = opts || {};
  const milestoneId = normalizeMilestone(milestone);
  const revision = o.sourceHead === undefined
    ? sourceRevision(o.cwd || process.cwd(), milestoneId)
    : { source_ref: o.sourceRef || null, source_head: o.sourceHead };
  const stable = {
    schema_version: SCHEMA_VERSION,
    event: 'write-coverage',
    milestone: milestoneId,
    source_ref: revision.source_ref,
    source_head: revision.source_head,
    vcs: report.vcs || null,
    verdict: report.verdict,
    coverage: report.coverage === undefined ? null : report.coverage,
    coverage_mean_per_unit: report.coverage_mean_per_unit === undefined ? null : report.coverage_mean_per_unit,
    totals: report.totals || { written: 0, declared_hits: 0 },
    units_considered: Number(report.units_considered || 0),
    units_measured: Number(report.units_measured || 0),
    units_skipped: Array.isArray(report.skipped) ? report.skipped.length : 0,
    skip_reasons: Array.from(new Set((report.skipped || []).map((row) => row && row.reason).filter(Boolean))).sort(),
    instrument_warning: report.instrument_warning === true,
    reconciliation_balances: {
      units: Boolean(report.reconciliation && report.reconciliation.units && report.reconciliation.units.balances),
      commits: Boolean(report.reconciliation && report.reconciliation.commits && report.reconciliation.commits.balances),
      refs: Boolean(report.reconciliation && Array.isArray(report.reconciliation.refs)
        && report.reconciliation.refs.every((row) => row && row.balances === true)),
    },
    thresholds: report.thresholds || null,
    exit_reason: report.exit_reason || null,
  };
  const measurementId = crypto.createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
  return { measured_at: report.generated_at || new Date().toISOString(), measurement_id: measurementId, ...stable };
}

function readMeasurementIds(file) {
  try {
    const ids = new Set();
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let row;
      try { row = JSON.parse(lines[i]); }
      catch { throw new Error(`ledger ilegível na linha ${i + 1}`); }
      if (row && row.measurement_id) ids.add(row.measurement_id);
    }
    return ids;
  } catch (error) {
    if (error && error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function writeAndSync(file, content, flag) {
  const handle = fs.openSync(file, flag);
  try { fs.writeFileSync(handle, content, 'utf8'); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
}

function recoverIncompleteTail(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  if (!raw || raw.endsWith('\n')) return null;
  const boundary = raw.lastIndexOf('\n') + 1;
  const tail = raw.slice(boundary);
  try {
    JSON.parse(tail);
    writeAndSync(file, '\n', 'a');
    return null;
  }
  catch {
    const recovery = `${file}.incomplete-${Date.now()}-${process.pid}`;
    writeAndSync(recovery, tail, 'wx');
    const handle = fs.openSync(file, 'r+');
    try { fs.ftruncateSync(handle, Buffer.byteLength(raw.slice(0, boundary), 'utf8')); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    return recovery;
  }
}

function appendRecord(cwd, record, opts) {
  const o = opts || {};
  const file = path.join(cwd, LEDGER_RELATIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = (o.acquire || mutex.acquireSync)(cwd, LOCK_NAME, { holderRunId: record.milestone });
  try {
    if (!mutex.assertOwned(lock)) throw new Error('lock do ledger perdido antes da escrita');
    recoverIncompleteTail(file);
    if (readMeasurementIds(file).has(record.measurement_id)) return { ok: true, appended: false, reason: 'duplicate-measurement', file, record };
    if (!mutex.renewHandle(lock).ok || !mutex.assertOwned(lock)) throw new Error('lock do ledger perdido antes da escrita');
    writeAndSync(file, `${JSON.stringify(record)}\n`, 'a');
    return { ok: true, appended: true, reason: 'appended', file, record };
  } finally {
    const released = lock.release();
    if (!released || released.ok !== true) throw new Error('não foi possível liberar o lock do ledger');
  }
}

function recordCoverage(cwd, milestone, opts) {
  const o = opts || {};
  const milestoneId = normalizeMilestone(milestone);
  const report = o.report || measureCoverage(cwd, { ...(o.measureOpts || {}), owner: milestoneId });
  return appendRecord(cwd, compactRecord(report, milestoneId, { cwd, sourceHead: o.sourceHead }), o);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('uso: node scripts/forge-write-coverage-ledger.js --milestone <M###> [--cwd <dir>]\n'); return 0; }
  try {
    const cwd = path.resolve(typeof args.cwd === 'string' ? args.cwd : process.cwd());
    process.stdout.write(`${JSON.stringify(recordCoverage(cwd, args.milestone))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`forge-write-coverage-ledger: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA_VERSION, LEDGER_RELATIVE, LOCK_NAME, normalizeMilestone, sourceRevision, compactRecord, readMeasurementIds, recoverIncompleteTail, appendRecord, recordCoverage, parseArgs, main };
