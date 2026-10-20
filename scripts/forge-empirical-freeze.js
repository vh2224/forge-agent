#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, fingerprint } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { checkedPath, relativePath, validatePrivateDestination, fail, LIMITS } = require('./forge-empirical-sources');
const { validateCorpus } = require('./forge-empirical-corpus');
const { validateCollectionInput } = require('./forge-empirical-collect');
const { createSplit, buildAgentView } = require('./forge-empirical-input');
const { buildEmpiricalBaseline, renderBaseline } = require('./forge-empirical-baseline');
const { TEMPLATE_FILES } = require('./forge-prompt');
const PHASES = Object.freeze(['preparation', 'execution', 'verification_review', 'publication', 'recovery']);
const COMPONENTS = Object.freeze(['scripts/forge-empirical-freeze.js', 'scripts/forge-empirical-collect.js',
  'scripts/forge-empirical-baseline.js', 'scripts/forge-empirical-input.js', 'scripts/forge-empirical-sources.js',
  'shared/schemas/empirical-corpus.schema.json', ...Object.values(TEMPLATE_FILES).map((name) => `shared/templates/dispatch/${name}`)]);

function readFile(root, name) {
  relativePath(name);
  const file = checkedPath(path.join(root, ...name.split('/')));
  const read = readBoundedStableFile(file, LIMITS.fileBytes, { expectedReal: file });
  if (read.error || read.stat.nlink !== 1) fail('freeze_source_unreadable');
  return read.buffer;
}

function evidenceRoot(options) {
  checkedPath(options.owner);
  if (!/^[A-Za-z0-9_-]+$/.test(options.milestone || '')) fail('milestone_invalid');
  return checkedPath(path.join(options.owner, '.gsd', 'milestones', options.milestone, 'evidence'));
}

function relativeFile(root, file) {
  const name = path.relative(root, path.resolve(file)).split(path.sep).join('/');
  relativePath(name);
  return name;
}

// All physical sources are explicit and stable-read through the existing bounded reader.
// The collection's persisted document digests are rechecked before using any classification.
function prepareFreeze(options) {
  const root = evidenceRoot(options); const code = checkedPath(options.codeDir);
  if (code !== checkedPath(path.resolve(__dirname, '..'))) fail('freeze_code_root_mismatch');
  for (const row of RUNTIME_COMPONENTS) if (sha256(readFile(code, row.path)) !== row.sha256) fail('freeze_drift');
  if (!['diagnostic', 'comparative'].includes(options.mode) || !/^[A-Za-z0-9_-]{1,64}$/.test(options.revision || '')) fail('freeze_options_invalid');
  const inventory = [];
  const capture = (region, name) => {
    const bytes = readFile(region === 'evidence' ? root : code, name);
    inventory.push({ region, path: name, bytes: bytes.length, sha256: sha256(bytes) });
    return bytes;
  };
  const collectionPath = relativeFile(root, options.collection);
  const collection = JSON.parse(capture('evidence', collectionPath));
  if (collection.schema_version !== 1 || !Array.isArray(collection.captures) || !collection.documents) fail('collection_invalid');
  const directory = path.posix.dirname(collectionPath); const docs = {};
  for (const name of ['catalog', 'selection', 'provenance']) {
    docs[name] = JSON.parse(capture('evidence', `${directory}/${name}.json`));
    if (fingerprint(docs[name]) !== collection.documents[name]) fail('collection_document_changed');
  }
  const catalog = docs.catalog; const validation = validateCorpus(catalog);
  if (!validation.valid) fail('corpus_invalid');
  const gaps = [];
  const split = docs.selection.split;
  if (!split) fail('split_missing');
  createSplit(catalog, { freezeId: split.freeze_id, reservedCount: split.reserved.length, previous: split });
  for (const ref of catalog.references.filter((r) => r.state === 'observed')) {
    const bytes = capture('evidence', ref.path);
    if (sha256(bytes) !== ref.sha256 || bytes.length !== ref.bytes) fail('snapshot_changed');
    const source = collection.captures.find((c) => c.ref_id === ref.id && c.status === 'observed');
    if (!source || source.metadata?.sha256 !== ref.sha256 || source.metadata?.snapshot !== ref.path) fail('capture_reference_changed');
  }
  if (!validation.ready) gaps.push('catalog_coverage_insufficient');
  const seeds = new Set(catalog.candidates.filter((c) => split.exposure_registry.some((e) => e.family_id === c.family_id)).map((c) => c.delivery_id));
  if (seeds.size < 6) gaps.push('six_seeds_not_accounted');
  for (const stratum of ['success', 'return', 'simple-control']) if (!catalog.candidates.some((c) =>
    c.selection === 'included' && c.stratum.value === stratum && c.stratum.refs.length &&
    c.stratum.refs.every((id) => catalog.references.some((r) => r.id === id && r.state === 'observed')))) gaps.push(`missing_stratum_${stratum}`);
  if (split.reserved.length < 2 || split.reserved.some((family) => !catalog.candidates.some((c) =>
    c.family_id === family && c.selection === 'included' && ['prework', 'grader/criteria', 'grader/expected', 'grader/final-code'].every((role) =>
      c.refs.some((id) => catalog.references.some((r) => r.id === id && r.role === role && r.state === 'observed')))))) gaps.push('reserved_eligibility_insufficient');
  const observationRefs = options.observationRefs || [];
  if (!Array.isArray(observationRefs) || observationRefs.some((id) => !catalog.references.some((r) => r.id === id))) fail('observation_refs_invalid');
  const adjustments = catalog.candidates.filter((c) => split.adjustment.includes(c.family_id));
  const baselineInput = { schema_version: 1, cases: adjustments.map((c) => ({ id: `version:${fingerprint({ case_id: c.case_id, version: c.version })}`, case_id: c.case_id, version: c.version, delivery_id: c.delivery_id,
    sources: c.refs.map((id) => catalog.references.find((r) => r.id === id)).filter((r) => r.state === 'observed').map((r) =>
      ({ id: r.id, path: r.path, sha256: r.sha256, origin: 'captured-corpus', format: observationRefs.includes(r.id) ? 'observations' : 'document' })) })) };
  const baseline = buildEmpiricalBaseline(baselineInput, { roots: [root], synthetic: options.synthetic === true });
  if (baseline.cases.some((c) => c.diagnostics.length || Object.values(c.dimensions).some((m) => ['invalid', 'conflict'].includes(m.state)))) gaps.push('baseline_invalid_or_conflicting');
  for (const key of ['functional', 'tests', 'uat']) if (!baseline.coverage[key].denominator ||
    baseline.coverage[key].numerator !== baseline.coverage[key].denominator) gaps.push(`dimension_${key}_unknown`);
  const views = [];
  for (const row of options.inputs || []) {
    const trusted = { ...row.provenance, split, sourceRoot: root };
    const graph = validateCollectionInput(catalog, row.graph, trusted);
    const view = buildAgentView(catalog, row.graph, trusted);
    views.push({ case_id: row.graph.case_id, version: row.graph.version, graph_digest: graph.digest, sha256: view.sha256, digest: view.digest });
  }
  if (adjustments.filter((c) => c.selection === 'included').some((c) => !views.some((v) => v.case_id === c.case_id && v.version === c.version))) gaps.push('agent_input_unverified');
  const protocol = capture('evidence', relativeFile(root, options.protocol));
  if (!protocol.toString('utf8').trim()) fail('protocol_empty');
  const components = [...new Set([...COMPONENTS, ...RUNTIME_COMPONENTS.map((row) => row.path), ...(options.components || [])])].sort();
  for (const name of components) capture('code', name);
  const coverage = { schema_version: 1, dimensions: baseline.coverage, cases: catalog.candidates.map((c) => ({
    case_id: c.case_id, version: c.version, family_id: c.family_id, selection: c.selection, stratum: c.stratum,
    phases: PHASES.map((phase) => {
      const metric = baseline.cases.find((row) => row.id === `version:${fingerprint({ case_id: c.case_id, version: c.version })}`)?.dimensions[
        { verification_review: 'tests', recovery: 'exception' }[phase]];
      const sources = metric?.references || [];
      return { phase, state: sources.length ? metric.state : 'unknown', sources,
        limitation: sources.length ? 'dimension_evidence_not_whole_phase' : 'no_explicit_phase_observation' };
    }),
    sources: c.refs, limitations: c.coverage.limitations })) };
  // A document may inform later design; it is not reconstructed prework or an outcome.
  const conditions = { runtime_root: code, runtime: RUNTIME_COMPONENTS, node: process.version, platform: process.platform, arch: process.arch,
    baseline_method: 'explicit-documents-or-observations', input_provenance: 'caller-reviewed-digest-bound',
    configuration: 'documentary-baseline-no-external-preferences', templates: 'hashed-inventory-not-token-or-provider-measurement',
    protocol_sha256: sha256(protocol), synthetic: options.synthetic === true };
  return { catalog, baseline, split, coverage, views, conditions, inventory, gaps: [...new Set(gaps)].sort(),
    recipe: { collection: collectionPath, protocol: relativeFile(root, options.protocol), mode: options.mode,
      revision: options.revision, observationRefs, inputs: options.inputs || [], components, synthetic: options.synthetic === true } };
}

function freezeCorpus(options) {
  const prepared = prepareFreeze(options);
  if (options.mode === 'comparative' && prepared.gaps.length) fail('comparative_readiness_failed');
  const name = `freeze-${options.revision}`;
  const destination = validatePrivateDestination(options, name);
  // Validate before creating anything. Never overwrite any prior revision, even on retry.
  const body = { schema_version: 1, schema_versions: { corpus: 1, baseline: 1, split: 1 }, mode: options.mode, revision: options.revision,
    comparative_ready: options.mode === 'comparative' && !prepared.gaps.length,
    gaps: prepared.gaps, corpus_digest: fingerprint(prepared.catalog), baseline_digest: prepared.baseline.digest,
    split_digest: prepared.split.digest, input_views: prepared.views, conditions: prepared.conditions,
    inventory: prepared.inventory, recipe: prepared.recipe,
    limitations: ['hashes_are_not_authenticity', 'no_provider_or_uat_inference', 'diagnostic_is_not_comparison',
      'prospective_registration_requires_owner_review', 'phase_observations_not_inferred_from_filenames'] };
  // Recheck exact bytes immediately before publication; failure produces no ready marker.
  for (const row of body.inventory) if (sha256(readFile(row.region === 'code' ? options.codeDir : evidenceRoot(options), row.path)) !== row.sha256) fail('source_changed');
  fs.mkdirSync(destination, { mode: 0o700 }); fs.mkdirSync(path.join(destination, 'baseline'), { mode: 0o700 });
  const outputs = { 'baseline/BASELINE.json': `${JSON.stringify(prepared.baseline, null, 2)}\n`,
    'baseline/BASELINE.md': renderBaseline(prepared.baseline), 'split.lock.json': `${JSON.stringify(prepared.split, null, 2)}\n`,
    'coverage-map.json': `${JSON.stringify(prepared.coverage, null, 2)}\n` };
  body.outputs = Object.entries(outputs).map(([file, text]) => ({ path: file, sha256: sha256(Buffer.from(text)) }));
  const result = { ...body, digest: fingerprint(body), generated_at: new Date().toISOString() };
  for (const [file, text] of Object.entries(outputs)) fs.writeFileSync(path.join(destination, file), text, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'freeze.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { passed: true, mode: result.mode, comparative_ready: result.comparative_ready, digest: result.digest,
    baseline_digest: result.baseline_digest, gaps: result.gaps, revision: result.revision,
    coverage: prepared.baseline.coverage };
}

function verifyFreeze(options) {
  const root = evidenceRoot(options); const file = relativeFile(root, options.freezeFile);
  const freeze = JSON.parse(readFile(root, file)); const { digest, generated_at, ...body } = freeze;
  if (freeze.schema_version !== 1 || digest !== fingerprint(body) || !Number.isFinite(Date.parse(generated_at))) fail('freeze_changed');
  const directory = path.posix.dirname(file);
  for (const row of freeze.outputs) if (sha256(readFile(root, `${directory}/${row.path}`)) !== row.sha256) fail('freeze_output_changed');
  const regenerated = prepareFreeze({ ...freeze.recipe, owner: options.owner, milestone: options.milestone,
    codeDir: options.codeDir, collection: path.join(root, freeze.recipe.collection), protocol: path.join(root, freeze.recipe.protocol) });
  if (fingerprint(regenerated.inventory) !== fingerprint(freeze.inventory) || regenerated.baseline.digest !== freeze.baseline_digest ||
      fingerprint(regenerated.catalog) !== freeze.corpus_digest || regenerated.split.digest !== freeze.split_digest ||
      fingerprint(regenerated.views) !== fingerprint(freeze.input_views) || fingerprint(regenerated.conditions) !== fingerprint(freeze.conditions) ||
      fingerprint(regenerated.gaps) !== fingerprint(freeze.gaps) || freeze.comparative_ready !== (freeze.mode === 'comparative' && !regenerated.gaps.length)) fail('freeze_drift');
  return { passed: true, mode: freeze.mode, comparative_ready: freeze.comparative_ready, digest,
    baseline_digest: regenerated.baseline.digest, gaps: freeze.gaps, readonly: true };
}

function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--freeze', '--verify', '--json'].includes(key)) { if (args[key]) fail('cli_invalid'); args[key] = true; }
    else if (['--owner', '--milestone', '--code-dir', '--collection', '--protocol', '--revision', '--mode', '--freeze-file'].includes(key) && argv[i + 1] && !args[key]) args[key] = argv[++i];
    else fail('cli_invalid');
  }
  if (!!args['--freeze'] === !!args['--verify']) fail('cli_invalid');
  const options = { owner: args['--owner'], milestone: args['--milestone'], codeDir: args['--code-dir'], collection: args['--collection'],
    protocol: args['--protocol'], revision: args['--revision'], mode: args['--mode'], freezeFile: args['--freeze-file'] };
  return args['--verify'] ? verifyFreeze(options) : freezeCorpus(options);
}

// Bind the transitive modules actually loaded by this runtime, not another checkout.
const runtimeModules = new Set();
function collectRuntimeModules(loaded) {
  if (runtimeModules.has(loaded.filename)) return;
  const relative = path.relative(path.resolve(__dirname, '..'), loaded.filename);
  if (path.isAbsolute(relative) || relative.startsWith('..')) fail('freeze_runtime_foreign');
  runtimeModules.add(loaded.filename);
  loaded.children.forEach(collectRuntimeModules);
}
collectRuntimeModules(module);
const RUNTIME_COMPONENTS = [...runtimeModules].sort().map((file) => ({
  path: path.relative(path.resolve(__dirname, '..'), file).split(path.sep).join('/'),
  sha256: sha256(fs.readFileSync(file)) }));

module.exports = { freezeCorpus, verifyFreeze, prepareFreeze, cli };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ reason_code: /^[a-z0-9_]+$/.test(error.code || '') ? error.code : 'freeze_failed' })}\n`); process.exitCode = 1; }
}
