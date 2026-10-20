#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256, fingerprint } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { validateSourceManifest, validatePrivateDestination, readLocalSource,
  checkedPath, closed, fail, LIMITS } = require('./forge-empirical-sources');
const { buildReadRequest, readHistoricalSource } = require('./forge-empirical-svn');
const { validateCorpus, caseIdentity, classifyProvenance } = require('./forge-empirical-corpus');
const { createSplit, validateInputGraph } = require('./forge-empirical-input');

// Caller roots and capability are deliberately absent from the serialized manifest.
function initCollection(input, trusted) {
  closed(input, ['schema_version', 'catalog', 'captures', 'freeze_id', 'reserved_count']);
  if (input.schema_version !== undefined && input.schema_version !== 1) fail('collection_schema');
  if (!['offline', 'networked'].includes(trusted.capability)) fail('capability_required');
  if (!validateCorpus(input.catalog).valid) fail('corpus_invalid');
  if (!Array.isArray(input.captures) || input.captures.length > LIMITS.files) fail('captures_invalid');
  const ids = new Set(); const refs = new Set();
  for (const row of input.captures) {
    closed(row, ['id', 'root', 'path', 'type', 'format', 'ref_id', 'request']);
    if (ids.has(row.id)) fail('capture_duplicate');
    ids.add(row.id);
    if (row.ref_id !== undefined) {
      if (refs.has(row.ref_id) || !input.catalog.references.some((r) => r.id === row.ref_id)) fail('capture_reference_invalid');
      refs.add(row.ref_id);
    }
    if (row.type === 'svn') {
      closed(row.request, ['operation', 'revision', 'peg', 'endRevision']);
      if (!['info', 'log', 'list', 'cat'].includes(row.request.operation)) fail('svn_operation_refused');
      if (row.request.operation !== 'info' && !row.ref_id) fail('capture_reference_required');
      for (const key of ['revision', 'peg', 'endRevision']) if (row.request[key] !== undefined &&
        !/^(?:0|[1-9]\d*)$/.test(row.request[key])) fail('svn_revision_invalid');
    } else if (row.request !== undefined || !row.ref_id) fail('capture_request_invalid');
  }
  const sources = input.captures.map(({ id, root, path: sourcePath, type, format }) => ({ id, root, path: sourcePath, type, format }));
  const checked = validateSourceManifest({ schema_version: 1, sources }, trusted);
  if (!checked.valid) fail(checked.diagnostics[0].code);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.freeze_id) || !Number.isSafeInteger(input.reserved_count) || input.reserved_count < 0 || input.reserved_count > 2) fail('split_options_invalid');
  // Validate identity even for an excluded or incomplete seed.
  input.catalog.candidates.forEach(caseIdentity);
  return { schema_version: 1, catalog: structuredClone(input.catalog), captures: structuredClone(input.captures),
    freeze_id: input.freeze_id, reserved_count: input.reserved_count };
}

function writePrivate(trusted, name, value) {
  const destination = validatePrivateDestination(trusted, name);
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return destination;
}

function directory(trusted, name) {
  const destination = validatePrivateDestination(trusted, name);
  fs.mkdirSync(destination, { mode: 0o700 });
  return destination;
}

function readPrivate(file) {
  checkedPath(file);
  const result = readBoundedStableFile(file, 1024 * 1024, { expectedReal: file });
  if (result.error) fail('private_record_unreadable');
  try { return JSON.parse(result.buffer.toString('utf8')); } catch (_) { fail('private_record_invalid'); }
}

function collectCorpus(input, trusted) {
  const manifest = initCollection(input, trusted);
  const sources = manifest.captures.map(({ id, root, path: sourcePath, type, format }) => ({ id, root, path: sourcePath, type, format }));
  const validation = validateSourceManifest({ schema_version: 1, sources }, trusted);
  if (!validation.valid) fail(validation.diagnostics[0].code);
  const session = validation.session;
  const base = path.join(trusted.owner, '.gsd', 'milestones', trusted.milestone, 'evidence');
  if (!fs.existsSync(path.join(base, 'corpus'))) directory(trusted, 'corpus');
  checkedPath(path.join(base, 'corpus'));
  const attempt = `corpus/capture-${crypto.randomBytes(8).toString('hex')}`;
  directory(trusted, attempt);
  for (const region of ['prework', 'grader', 'reserved', 'unknown']) directory(trusted, `${attempt}/${region}`);
  const catalog = structuredClone(manifest.catalog); const captures = [];
  let plannedSplit = null;
  try { plannedSplit = createSplit(catalog, { freezeId: manifest.freeze_id, reservedCount: manifest.reserved_count }); }
  catch (_) { /* Missing families remain an explicit gap after capture. */ }
  const reservedRefs = new Set(catalog.candidates.filter((c) => plannedSplit?.reserved.includes(c.family_id)).flatMap((c) => c.refs));
  for (const row of manifest.captures) {
    const ref = catalog.references.find((r) => r.id === row.ref_id);
    const region = reservedRefs.has(row.ref_id) ? 'reserved' : ref?.region || 'unknown';
    const name = `${attempt}/${region}/${row.id}.snapshot`;
    let captured;
    try {
      // Building the request is a typed validation step; it never executes it.
      if (row.type === 'svn') buildReadRequest(session, row.id, row.request);
      captured = row.type === 'local' ? readLocalSource(session, row.id, name) : readHistoricalSource(session, row.id, row.request, name);
    } catch (error) { captured = { status: 'insufficient', complete: false, reason: error.code || 'capture_failed' }; }
    captures.push({ id: row.id, ref_id: row.ref_id || null, status: captured.status,
      reason: captured.reason || null, ...(captured.metadata ? { metadata: captured.metadata } : {}),
      ...(captured.result ? { result: captured.result } : {}) });
    if (!ref) continue;
    // A stale digest from an imported catalog never survives a failed capture.
    for (const key of ['path', 'bytes', 'sha256', 'revision', 'peg', 'captured_at', 'temporal_source']) delete ref[key];
    ref.state = captured.status === 'observed' ? 'observed' : 'missing';
    if (ref.state === 'observed') {
      const m = captured.metadata;
      Object.assign(ref, { path: path.relative(base, m.snapshot).split(path.sep).join('/'), bytes: m.bytes,
        sha256: m.sha256, captured_at: m.captured_at, temporal_source: m.temporal_source });
      if (m.revision) ref.revision = m.revision;
      if (m.peg) ref.peg = m.peg;
    }
  }
  catalog.captured_at = new Date().toISOString();
  const capturedRefs = new Set(manifest.captures.map((r) => r.ref_id));
  for (const ref of catalog.references) if (!capturedRefs.has(ref.id)) {
    ref.state = 'missing';
    for (const key of ['path', 'bytes', 'sha256', 'revision', 'peg', 'captured_at', 'temporal_source']) delete ref[key];
  }
  for (const candidate of catalog.candidates) {
    const observed = candidate.refs.map((id) => catalog.references.find((r) => r.id === id));
    const complete = observed.length > 0 && observed.every((r) => r?.state === 'observed' && r.role !== 'unknown') &&
      ['prework', 'grader/criteria', 'grader/expected', 'grader/final-code'].every((role) => observed.some((r) => r.role === role));
    if (candidate.selection !== 'excluded' && !complete) {
      candidate.selection = 'insufficient'; candidate.reasons = ['source_coverage_insufficient'];
      candidate.coverage = { state: 'partial', limitations: ['source_coverage_insufficient'] };
    }
    const available = (ids) => ids.length > 0 && ids.every((id) => catalog.references.some((r) => r.id === id && r.state === 'observed'));
    for (const claim of candidate.claims) if (claim.state === 'observed' && !available(claim.refs)) {
      claim.state = 'unknown'; claim.value = null; claim.limitations.push('source_coverage_insufficient');
    }
    for (const metric of Object.values(candidate.metrics)) if (metric.state === 'observed' && !available(metric.refs)) {
      metric.state = 'unknown'; metric.value = null; metric.limitations.push('source_coverage_insufficient');
    }
  }
  const checked = validateCorpus(catalog);
  if (!checked.valid) fail('collected_corpus_invalid');
  let split = null; const gaps = [];
  try { split = createSplit(catalog, { freezeId: manifest.freeze_id, reservedCount: manifest.reserved_count }); }
  catch (error) { gaps.push(error.code || 'split_invalid'); }
  const provenance = catalog.candidates.map((c) => ({ case_id: c.case_id, version: c.version,
    claims: classifyProvenance(c.claims, catalog.references) }));
  // Stable identity excludes capture timestamps/paths, retaining actual source bytes and request.
  const identity = fingerprint({ manifest, roots: trusted.roots, capability: trusted.capability,
    captures: captures.map((c) => ({ id: c.id, status: c.status, reason: c.reason, sha256: c.metadata?.sha256 || null })) });
  const runName = `corpus/run-${identity}`; const runPath = path.join(base, runName);
  if (fs.existsSync(runPath)) {
    checkedPath(runPath);
    const previous = readPrivate(path.join(runPath, 'collection.json'));
    if (previous.identity !== identity) fail('replay_identity_mismatch');
    for (const row of previous.captures.filter((c) => c.status === 'observed')) {
      const expected = path.resolve(base, row.metadata.snapshot);
      if (path.relative(base, expected).startsWith('..')) fail('replay_path_invalid');
      checkedPath(expected);
      const bytes = readBoundedStableFile(expected, LIMITS.fileBytes, { expectedReal: expected });
      if (bytes.error || sha256(bytes.buffer) !== row.metadata.sha256) fail('replay_snapshot_changed');
    }
    for (const name of ['selection', 'catalog', 'provenance']) if (fingerprint(readPrivate(path.join(runPath, `${name}.json`))) !== previous.documents[name]) fail('replay_document_changed');
    return { ...previous, replay: true, private_root: runPath };
  }
  directory(trusted, runName);
  const selection = { candidates: catalog.candidates.map((c) => ({ case_id: c.case_id, family_id: c.family_id,
    selection: c.selection, reasons: c.reasons })), split, gaps };
  const collection = { schema_version: 1, identity, replay: false, captured_at: catalog.captured_at,
    ready: checked.ready && gaps.length === 0, counts: checked.counts, gaps,
    captures: captures.map((c) => c.metadata ? { ...c, metadata: { ...c.metadata,
      snapshot: path.relative(base, c.metadata.snapshot).split(path.sep).join('/') } } : c),
    documents: { selection: fingerprint(selection), catalog: fingerprint(catalog), provenance: fingerprint(provenance) },
    limitations: ['owner_historical_coverage_requires_separate_verification', 'no_installation_inference', 'reserved_selection_does_not_prove_eligibility'] };
  for (const [name, value] of Object.entries({ selection, catalog, provenance, collection })) writePrivate(trusted, `${runName}/${name}.json`, value);
  return { ...collection, private_root: runPath };
}

// Graph validation remains an explicit owner operation with digest-bound provenance.
function validateCollectionInput(catalog, graph, trusted) { return validateInputGraph(catalog, graph, trusted); }

function publicResult(result) {
  return { id: result.identity, replay: result.replay, ready: result.ready, counts: result.counts,
    reason_codes: [...new Set([...result.gaps, ...result.captures.map((c) => c.reason).filter(Boolean)])],
    snapshots: result.captures.filter((c) => c.metadata).map((c) => ({ id: c.id, sha256: c.metadata.sha256 })) };
}

function cli(argv) {
  const args = {}; const roots = []; const svn = [];
  const values = ['owner', 'milestone', 'input', 'manifest', 'capability', 'root', 'svn'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['init', 'collect'].includes(key) && argv[i] === `--${key}`) { if (args[key]) fail('cli_invalid'); args[key] = true; }
    else if (values.includes(key) && argv[i] === `--${key}` && argv[i + 1]) {
      const value = argv[++i];
      if (key === 'root') roots.push(value); else if (key === 'svn') svn.push(value);
      else { if (args[key] !== undefined) fail('cli_invalid'); args[key] = value; }
    } else fail('cli_invalid');
  }
  if (!!args.init === !!args.collect || !args.manifest) fail('cli_invalid');
  const trusted = { owner: args.owner, milestone: args.milestone, capability: args.capability,
    roots: roots.map((value) => { const i = value.indexOf('='); if (i < 1) fail('cli_root_invalid'); return { id: value.slice(0, i), path: value.slice(i + 1) }; }) };
  for (const value of svn) {
    const i = value.indexOf('='); const pieces = value.slice(i + 1).split(',');
    const root = trusted.roots.find((r) => r.id === value.slice(0, i));
    if (!root || pieces.length !== 2) fail('cli_root_invalid');
    [root.repository, root.subtree] = pieces;
  }
  const evidence = path.join(trusted.owner, '.gsd', 'milestones', trusted.milestone, 'evidence');
  const manifestPath = path.resolve(args.manifest);
  if (path.dirname(manifestPath) !== evidence) fail('manifest_destination_invalid');
  if (args.init) {
    const manifest = initCollection(readPrivate(path.resolve(args.input)), trusted);
    writePrivate(trusted, path.basename(manifestPath), manifest);
    return { id: fingerprint(manifest), initialized: true };
  }
  return publicResult(collectCorpus(readPrivate(manifestPath), trusted));
}

module.exports = { initCollection, collectCorpus, validateCollectionInput, publicResult, cli };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ reason_code: /^[a-z0-9_]+$/.test(error.code || '') ? error.code : 'collection_failed' })}\n`); process.exitCode = 1; }
}
