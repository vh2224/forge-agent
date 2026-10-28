#!/usr/bin/env node
'use strict';

// Offline host-baseline validation. Exports: validateBaseline,
// compareHostVersion, main. Evidence is observed, never refreshed here.
const fs = require('fs');
const path = require('path');
const { readBoundedStableFile, MAX_FILE_BYTES } = require('./forge-autonomy-sources');
const { sha256, canonical, resolveSafeFile } = require('./forge-delivery');
const capabilities = require('./forge-capabilities');

const DEFAULT_BASELINE = 'docs/host-compatibility-baseline.json';
const IMPORT_RECORD = 'docs/host-compatibility-import.json';
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const POLICY_KEYS = Object.freeze([
  'review_new_release_range', 'carry_forward_open_findings',
  'revalidate_changed_source_or_configuration',
  'unchanged_version_does_not_prove_unchanged_docs_or_ui',
  'baseline_is_not_a_minimum_version_or_runtime_compatibility_guarantee',
]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value)
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.split('/').some((part) => !part || part === '..' || part === '.')
    && path.posix.normalize(value) === value;
}

function compareHostVersion(baselineVersion, observedVersion) {
  const comparison = VERSION.test(baselineVersion || '') && VERSION.test(observedVersion || '')
    ? capabilities.compareVersion(observedVersion, baselineVersion) : null;
  return {
    baseline_version: VERSION.test(baselineVersion || '') ? baselineVersion : null,
    observed_version: VERSION.test(observedVersion || '') ? observedVersion : null,
    relation: comparison === null ? 'unknown' : comparison === 0 ? 'same' : comparison > 0 ? 'newer' : 'older',
    next_range: comparison > 0 ? { after_exclusive: baselineVersion, through_inclusive: observedVersion } : null,
    // Even identical CLI versions say nothing about changed documentation/UI.
    revalidation_required: true,
  };
}

function baselineShape(value) {
  return object(value) && value.schema_version === 1
    && /^\d{4}-\d{2}-\d{2}$/.test(value.analysis_date || '')
    && relativeFile(value.report) && relativeFile(value.evidence)
    && object(value.forge) && VERSION.test(value.forge.version || '')
    && /^[a-f0-9]{40}$/.test(value.forge.commit || '')
    && ['codex_cli', 'claude_code'].every((host) => object(value[host])
      && VERSION.test(value[host].installed || ''))
    && object(value.desktop_ui) && (value.desktop_ui.installed_build === null
      || (typeof value.desktop_ui.installed_build === 'string' && ID.test(value.desktop_ui.installed_build)))
    && Array.isArray(value.open_findings) && value.open_findings.every((finding) => object(finding)
      && ID.test(finding.id || '') && ID.test(finding.status_at_analysis || ''))
    && new Set(value.open_findings.map((finding) => finding.id)).size === value.open_findings.length
    && object(value.reanalysis_policy) && POLICY_KEYS.every((key) => value.reanalysis_policy[key] === true);
}

function hashRows(value) {
  return Array.isArray(value) && value.every((row) => object(row)
    && relativeFile(row.file) && HASH.test(row.sha256 || ''))
    && new Set(value.map((row) => row.file)).size === value.length;
}

function openFindings(baseline) {
  return baseline.open_findings.filter((row) => !['closed', 'resolved'].includes(row.status_at_analysis))
    .map((row) => row.id).sort();
}

function validateBaseline({ cwd = process.cwd(), baseline = DEFAULT_BASELINE, observed = {}, previous, io = fs } = {}) {
  const report = { ok: false, issues: [], baseline: null, artifacts: [], sources: [], hosts: {},
    import_record: 'absent', ui: { installed_build: null, state: 'unknown', range_closed: false },
    open_findings: [], carry_forward: [], dropped_findings: [] };
  const issue = (code, detail) => report.issues.push(`${code}:${detail}`);
  let root;
  try { root = fs.realpathSync.native(path.resolve(cwd)); }
  catch (_) { issue('root-unreadable', 'cwd'); return canonical(report); }
  const cache = new Map();
  function read(file, label, optional = false) {
    if (!relativeFile(file)) { issue('invalid-path', label); return null; }
    if (cache.has(file)) return cache.get(file);
    const resolved = resolveSafeFile(file, [root], { base: root, maxBytes: MAX_FILE_BYTES });
    if (resolved.error) {
      if (!(optional && resolved.error === 'source_missing')) issue(resolved.error.replace(/_/g, '-'), label);
      return null;
    }
    const result = readBoundedStableFile(resolved.path, MAX_FILE_BYTES, { io, expectedReal: resolved.path });
    if (result.error) { issue(result.error.replace(/_/g, '-'), label); return null; }
    const entry = { buffer: result.buffer, sha256: sha256(result.buffer) };
    cache.set(file, entry);
    return entry;
  }
  function json(file, label, optional = false) {
    const entry = read(file, label, optional);
    if (!entry) return null;
    try { return { ...entry, value: JSON.parse(entry.buffer.toString('utf8').replace(/^\uFEFF/, '')) }; }
    catch (_) { issue('invalid-json', label); return null; }
  }
  const current = json(baseline, 'baseline');
  if (!current) return canonical(report);
  if (!baselineShape(current.value)) { issue('invalid-shape', 'baseline'); return canonical(report); }
  const data = current.value;
  report.baseline = { file: baseline, sha256: current.sha256, analysis_date: data.analysis_date,
    forge_version: data.forge.version, forge_commit: data.forge.commit };
  report.open_findings = openFindings(data);
  report.carry_forward = report.open_findings.slice();
  for (const [host, key] of [['codex', 'codex_cli'], ['claude', 'claude_code']]) {
    const observation = observed[host];
    const version = object(observation) ? observation.version : observation;
    report.hosts[host] = { ...compareHostVersion(data[key].installed, version),
      observed_source: version && VERSION.test(version) ? (object(observation) && observation.source === 'observe' ? 'observe' : 'flag') : 'none' };
  }
  // Desktop build is independent of all CLI observations.
  if (data.desktop_ui.installed_build !== null) {
    report.ui = { installed_build: data.desktop_ui.installed_build, state: 'observed', range_closed: false };
  }
  let evidence = json(data.evidence, 'evidence');
  if (evidence && !(object(evidence.value) && evidence.value.schema_version === 1
    && hashRows(evidence.value.artifacts) && hashRows(evidence.value.inspected_source_fingerprints)
    && [baseline, data.report].every((file) => evidence.value.artifacts.some((row) => row.file === file)))) {
    issue('invalid-shape', 'evidence'); evidence = null;
  }
  const imported = json(IMPORT_RECORD, 'import-record', true);
  let records = [];
  if (imported) {
    report.import_record = 'present';
    const value = imported.value;
    if (!(object(value) && value.schema_version === 1 && Array.isArray(value.files)
      && value.files.every((row) => object(row) && relativeFile(row.file)
        && HASH.test(row.source_sha256 || '') && HASH.test(row.imported_sha256 || '')
        && (row.pre_import_sha256 === null || HASH.test(row.pre_import_sha256 || ''))
        && typeof row.edited_after_import === 'boolean' && ['LF', 'CRLF', 'mixed', 'CRLF-or-mixed'].includes(row.eol))
      && new Set(value.files.map((row) => row.file)).size === value.files.length)) issue('invalid-shape', 'import-record');
    else {
      records = value.files;
      for (const [index, row] of records.entries()) {
        if (row.source_sha256 !== row.imported_sha256) issue('import-record-inconsistent', `row-${index}`);
      }
      for (const file of [baseline, data.report, data.evidence]) {
        const row = records.find((entry) => entry.file === file);
        if (!row || row.edited_after_import) issue('import-record-inconsistent', file);
      }
    }
  }
  const expectedArtifacts = evidence ? evidence.value.artifacts : [];
  const files = [...new Set([data.report, baseline, data.evidence, ...expectedArtifacts.map((row) => row.file), ...records.map((row) => row.file)])];
  for (const file of files) {
    const entry = read(file, file);
    const fromEvidence = expectedArtifacts.find((row) => row.file === file);
    const fromImport = records.find((row) => row.file === file);
    if (fromEvidence && fromImport && fromEvidence.sha256 !== fromImport.imported_sha256) issue('import-record-inconsistent', file);
    const expected = { evidence: fromEvidence ? fromEvidence.sha256 : null, import: fromImport ? fromImport.imported_sha256 : null };
    const hashes = Object.values(expected).filter(Boolean);
    let status = !entry ? 'missing' : hashes.length === 0 ? 'unknown'
      : hashes.every((hash) => hash === entry.sha256) ? 'match' : 'mismatch';
    if (status === 'mismatch' && fromImport && fromImport.edited_after_import === true && !fromEvidence) status = 'changed-after-import';
    if (status === 'mismatch') issue('artifact-hash-mismatch', file);
    report.artifacts.push({ file, expected_sha256: expected, current_sha256: entry ? entry.sha256 : null, status });
  }
  if (evidence) {
    for (const row of evidence.value.inspected_source_fingerprints) {
      const entry = read(row.file, row.file, true);
      const status = !entry ? 'missing' : entry.sha256 === row.sha256 ? 'unchanged' : 'changed';
      report.sources.push({ file: row.file, recorded_sha256: row.sha256, current_sha256: entry ? entry.sha256 : null,
        status, revalidation_required: status !== 'unchanged' });
    }
  }
  if (previous !== undefined) {
    const prior = json(previous, 'previous');
    if (prior) {
      if (!baselineShape(prior.value)) issue('invalid-shape', 'previous');
      else {
        const currentIds = new Set(data.open_findings.map((row) => row.id));
        report.dropped_findings = openFindings(prior.value).filter((id) => !currentIds.has(id));
        for (const id of report.dropped_findings) issue('open-finding-dropped', id);
      }
    }
  }
  report.issues = [...new Set(report.issues)].sort();
  report.ok = report.issues.length === 0;
  report.artifacts.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  report.sources.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  return canonical(report);
}

function main(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) {
  const options = { cwd: process.cwd(), observed: {} };
  const seen = new Set();
  let check = false; let asJson = false; let observe = false; let help = false;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (seen.has(arg)) throw new Error('usage');
      seen.add(arg);
      if (arg === '--check') check = true;
      else if (arg === '--json') asJson = true;
      else if (arg === '--observe') observe = true;
      else if (arg === '--help') help = true;
      else if (['--cwd', '--baseline', '--previous', '--codex-version', '--claude-version'].includes(arg)) {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error('usage');
        if (arg.endsWith('-version')) {
          if (!VERSION.test(value)) throw new Error('usage');
          options.observed[arg === '--codex-version' ? 'codex' : 'claude'] = { version: value, source: 'flag' };
        } else options[arg.slice(2)] = value;
      } else throw new Error('usage');
    }
    if (help) {
      write('Uso: forge-host-baseline.js --check [--cwd DIR] [--baseline FILE] [--previous FILE] [--codex-version V] [--claude-version V] [--observe] [--json]\n');
      return 0;
    }
    if (!check) throw new Error('usage');
  } catch (_) { write('Uso inválido; consulte --help.\n'); return 2; }
  if (observe) {
    try {
      const detection = capabilities.detect({ cwd: options.cwd, runtime: 'both' });
      for (const host of ['codex', 'claude']) {
        if (!options.observed[host]) options.observed[host] = { version: detection.probes[host].version, source: 'observe' };
      }
    } catch (_) { write('Falha na observação dos hosts.\n'); return 1; }
  }
  const report = validateBaseline(options);
  write(asJson ? `${JSON.stringify(report)}\n` : `Baseline ${report.ok ? 'válida' : 'com problemas'}; ${report.issues.length} problemas; ${report.carry_forward.length} achados preservados.\n`);
  return report.ok ? 0 : 1;
}

module.exports = { validateBaseline, compareHostVersion, main };
if (require.main === module) process.exitCode = main();
