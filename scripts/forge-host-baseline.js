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
const CURRENT_POINTER = 'docs/host-compatibility-current.json';
const MAX_LINEAGE_LINKS = 8;
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

// SemVer 2.0 precedence for the prerelease part; build metadata is ignored.
// Returns null (unknown) when a prerelease is not valid SemVer.
function prerelease(version) {
  const rest = version.split('+')[0];
  const dash = rest.indexOf('-');
  if (dash === -1) return [];
  const ids = rest.slice(dash + 1).split('.');
  return ids.every((id) => /^(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/.test(id)) ? ids : null;
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];
    const numeric = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (numeric[0] && numeric[1]) {
      // Valid numeric identifiers have no leading zeros; compare decimal text
      // exactly, including values beyond Number.MAX_SAFE_INTEGER.
      if (a.length !== b.length) return a.length > b.length ? 1 : -1;
      if (a !== b) return a > b ? 1 : -1;
    }
    else if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    else if (a !== b) return a > b ? 1 : -1;
  }
  return left.length === right.length ? 0 : left.length > right.length ? 1 : -1;
}

function compareHostVersions(observedVersion, baselineVersion) {
  const [observedPre, baselinePre] = [prerelease(observedVersion), prerelease(baselineVersion)];
  if (observedPre === null || baselinePre === null) return null;
  const core = capabilities.compareVersion(observedVersion, baselineVersion);
  return core !== 0 ? core : comparePrerelease(observedPre, baselinePre);
}

function compareHostVersion(baselineVersion, observedVersion) {
  const comparison = VERSION.test(baselineVersion || '') && VERSION.test(observedVersion || '')
    ? compareHostVersions(observedVersion, baselineVersion) : null;
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

function validateBaseline({ cwd = process.cwd(), baseline, observed = {}, previous, io = fs } = {}) {
  const report = { ok: false, issues: [], baseline: null, artifacts: [], sources: [], hosts: {},
    import_record: 'absent', ui: { installed_build: null, state: 'unknown', range_closed: false },
    open_findings: [], carry_forward: [], dropped_findings: [], lineage: [], selection: null };
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
      if (optional && resolved.error === 'source_missing') {
        // A dangling pointer/link is present, not an absent optional file.
        try { fs.lstatSync(path.resolve(root, file)); issue('source-unreadable', label); }
        catch (error) { if (error.code !== 'ENOENT') issue('source-unreadable', label); }
      } else issue(resolved.error.replace(/_/g, '-'), label);
      return null;
    }
    const result = readBoundedStableFile(resolved.path, MAX_FILE_BYTES, { io, expectedReal: resolved.path });
    if (result.error) { issue(result.error.replace(/_/g, '-'), label); return null; }
    const entry = { buffer: result.buffer, sha256: sha256(result.buffer), real: resolved.path };
    cache.set(file, entry);
    return entry;
  }
  function json(file, label, optional = false) {
    const entry = read(file, label, optional);
    if (!entry) return null;
    try { return { ...entry, value: JSON.parse(entry.buffer.toString('utf8').replace(/^\uFEFF/, '')) }; }
    catch (_) { issue('invalid-json', label); return null; }
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
    }
  }
  const docsFile = (file) => relativeFile(file) && file.startsWith('docs/');
  function physicalDocsFile(file) {
    if (!docsFile(file)) return false;
    const resolved = resolveSafeFile(file, [root], { base: root, maxBytes: MAX_FILE_BYTES });
    // Missing files retain their specific pointer/lineage diagnostic later.
    if (resolved.error === 'source_missing') return true;
    return !resolved.error && path.relative(root, resolved.path).split(path.sep)[0] === 'docs';
  }
  if (baseline === undefined) {
    const pointer = json(CURRENT_POINTER, 'pointer', true);
    if (pointer) {
      const value = pointer.value;
      report.selection = { source: 'pointer', file: object(value) && typeof value.baseline === 'string' ? value.baseline : null };
      if (!(object(value) && value.schema_version === 1 && physicalDocsFile(value.baseline) && HASH.test(value.baseline_sha256 || '')
        && Object.keys(value).every((key) => ['schema_version', 'baseline', 'baseline_sha256'].includes(key)))) {
        issue('pointer-invalid', CURRENT_POINTER); return canonical(report);
      }
      const target = json(value.baseline, 'pointer-target');
      if (!target || !baselineShape(target.value)) { issue('pointer-invalid', 'target'); return canonical(report); }
      if (target.sha256 !== value.baseline_sha256) { issue('pointer-hash-mismatch', value.baseline); return canonical(report); }
      baseline = value.baseline;
    } else if (report.issues.length) {
      issue('pointer-invalid', CURRENT_POINTER); return canonical(report);
    } else {
      baseline = DEFAULT_BASELINE;
      report.selection = { source: 'default', file: baseline };
    }
  } else report.selection = { source: 'explicit', file: baseline };

  function carryForward(data, prior) {
    const currentIds = new Map(data.open_findings.map((row) => [row.id, row]));
    const dropped = openFindings(prior).filter((id) => !currentIds.has(id));
    report.dropped_findings.push(...dropped);
    for (const id of dropped) issue('open-finding-dropped', id);
    for (const old of prior.open_findings) {
      const row = currentIds.get(old.id);
      if (row && row.status_at_analysis !== old.status_at_analysis
        && !(ID.test(row.disposition || '') && relativeFile(row.evidence) && read(row.evidence, `finding-${row.id}`, true))) {
        issue('finding-disposition-missing', row.id);
      }
    }
  }
  function ranges(data, prior, evidence) {
    for (const [host, key] of [['codex', 'codex_cli'], ['claude', 'claude_code']]) {
      const row = data[key];
      const anchor = prior[key].next_release_notes_after_exclusive;
      const comparison = compareHostVersion(anchor, row.installed);
      if (row.revalidation_required !== true || ['unknown', 'older'].includes(comparison.relation)
        || compareHostVersion(prior[key].installed, row.installed).relation === 'older') {
        issue('release-range-invalid', host); continue;
      }
      if (comparison.relation === 'same') {
        if (row.release_notes_range !== null || row.release_notes_review !== 'not-applicable-same-version') issue('release-range-invalid', host);
        if (row.next_release_notes_after_exclusive !== anchor) issue('release-range-gap', host);
        continue;
      }
      const range = row.release_notes_range;
      if (!object(range) || range.through_inclusive !== row.installed) issue('release-range-invalid', host);
      if (!object(range) || range.after_exclusive !== anchor) issue('release-range-gap', host);
      if (row.release_notes_review === 'pending') {
        if (!openFindings(data).includes(`release-review-${host}`)) issue('release-range-invalid', `${host}-pending-finding`);
        if (row.next_release_notes_after_exclusive !== anchor) issue('release-range-gap', `${host}-unreviewed-anchor`);
      } else if (row.release_notes_review === 'reviewed') {
        const sources = evidence && evidence.value.official_releases;
        if (!Array.isArray(sources) || !sources.some((source) => object(source) && source.host === host
          && source.release_notes_review === 'reviewed' && source.after_exclusive === anchor
          && source.through_inclusive === row.installed && /^https:\/\//.test(source.url || '')
          && HASH.test(source.body_sha256 || '') && Number.isInteger(source.body_bytes) && source.body_bytes > 0
          && typeof source.observed_at === 'string' && Number.isFinite(Date.parse(source.observed_at)))) issue('release-range-invalid', `${host}-review-sources`);
        if (row.next_release_notes_after_exclusive !== row.installed) issue('release-range-gap', `${host}-reviewed-anchor`);
      } else issue('release-range-invalid', `${host}-review`);
    }
  }
  function visit(file, depth, seen) {
    if (depth > MAX_LINEAGE_LINKS) { issue('lineage-depth-exceeded', file); return null; }
    const current = json(file, depth ? 'lineage' : 'baseline');
    if (!current) return null;
    if (!baselineShape(current.value)) { issue('invalid-shape', depth ? 'lineage' : 'baseline'); return null; }
    const data = current.value;
    let evidence = json(data.evidence, 'evidence');
    if (evidence && !(object(evidence.value) && evidence.value.schema_version === 1
      && hashRows(evidence.value.artifacts) && hashRows(evidence.value.inspected_source_fingerprints)
      && [file, data.report].every((target) => evidence.value.artifacts.some((row) => row.file === target)))) {
      issue('invalid-shape', 'evidence'); evidence = null;
    }
    const importedBaseline = records.find((row) => row.file === file);
    const terminal = importedBaseline || file === DEFAULT_BASELINE;
    if (terminal) {
      if (imported) {
        for (const target of [file, data.report, data.evidence]) {
          const row = records.find((entry) => entry.file === target);
          if (!row || row.edited_after_import) issue('import-record-inconsistent', target);
        }
      }
      if (depth && !importedBaseline) issue('lineage-foreign', file);
    } else if (!object(data.lineage)) issue(depth ? 'lineage-foreign' : 'lineage-required', file);
    else {
      const link = data.lineage;
      if (!physicalDocsFile(file) || !physicalDocsFile(link.previous) || !HASH.test(link.previous_sha256 || '')) issue('lineage-foreign', file);
      else if (seen.has(link.previous)) issue('lineage-cycle', link.previous);
      else {
        const prior = json(link.previous, 'lineage', true);
        if (!prior) issue('lineage-missing', link.previous);
        else if ([...seen].some((name) => cache.get(name) && cache.get(name).real === prior.real)) issue('lineage-cycle', link.previous);
        else if (prior.sha256 !== link.previous_sha256) issue('lineage-hash-mismatch', link.previous);
        else {
          report.lineage.push({ file, previous: link.previous, previous_sha256: prior.sha256 });
          const validated = visit(link.previous, depth + 1, new Set([...seen, link.previous]));
          if (validated) {
            if (validated.analysis_date > data.analysis_date) issue('lineage-order-invalid', file);
            carryForward(data, validated);
            ranges(data, validated, evidence);
          }
        }
      }
    }
    for (const row of data.open_findings) {
      if (['closed', 'resolved'].includes(row.status_at_analysis)
        && !(object(row.closure) && row.closure.source === 'operator' && relativeFile(row.closure.reference)
          && read(row.closure.reference, `closure-${row.id}`, true))) issue('finding-closure-unverified', row.id);
    }
    const expectedArtifacts = evidence ? evidence.value.artifacts : [];
    const files = [...new Set([data.report, file, data.evidence, ...expectedArtifacts.map((row) => row.file), ...records.map((row) => row.file)])];
    for (const target of files) {
      const entry = read(target, target);
      const fromEvidence = expectedArtifacts.find((row) => row.file === target);
      const fromImport = records.find((row) => row.file === target);
      if (fromEvidence && fromImport && fromEvidence.sha256 !== fromImport.imported_sha256) issue('import-record-inconsistent', target);
      const expected = { evidence: fromEvidence ? fromEvidence.sha256 : null, import: fromImport ? fromImport.imported_sha256 : null };
      const hashes = Object.values(expected).filter(Boolean);
      let status = !entry ? 'missing' : hashes.length === 0 ? 'unknown'
        : hashes.every((hash) => hash === entry.sha256) ? 'match' : 'mismatch';
      if (status === 'mismatch' && fromImport && fromImport.edited_after_import && !fromEvidence) status = 'changed-after-import';
      if (status === 'mismatch') {
        issue('artifact-hash-mismatch', target);
        if (fromImport && !fromImport.edited_after_import) issue('import-record-inconsistent', target);
      }
      // One physical row per artifact; the selected analysis wins over an
      // ancestor's evidence row while import provenance remains explicit.
      const artifact = { file: target, expected_sha256: expected, current_sha256: entry ? entry.sha256 : null, status,
        origin: fromImport ? 'import-record' : depth ? 'lineage' : 'current-evidence' };
      const index = report.artifacts.findIndex((row) => row.file === target);
      if (index < 0) report.artifacts.push(artifact);
      else report.artifacts[index] = artifact;
    }
    if (evidence && depth === 0) {
      for (const row of evidence.value.inspected_source_fingerprints) {
        const entry = read(row.file, row.file, true);
        const status = !entry ? 'missing' : entry.sha256 === row.sha256 ? 'unchanged' : 'changed';
        report.sources.push({ file: row.file, recorded_sha256: row.sha256, current_sha256: entry ? entry.sha256 : null,
          status, revalidation_required: status !== 'unchanged' });
      }
    }
    return data;
  }
  const data = visit(baseline, 0, new Set([baseline]));
  if (!data) return canonical(report);
  report.baseline = { file: baseline, sha256: cache.get(baseline).sha256, analysis_date: data.analysis_date,
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
  if (data.desktop_ui.installed_build !== null) report.ui = { installed_build: data.desktop_ui.installed_build, state: 'observed', range_closed: false };
  if (previous !== undefined) {
    const prior = json(previous, 'previous');
    if (prior) {
      if (!baselineShape(prior.value)) issue('invalid-shape', 'previous');
      else carryForward(data, prior.value);
    }
  }
  report.dropped_findings = [...new Set(report.dropped_findings)].sort();
  if (report.selection.source === 'pointer' && report.issues.length) issue('pointer-invalid', 'target');
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
