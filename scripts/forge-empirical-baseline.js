#!/usr/bin/env node
'use strict';

// Descriptive evidence projection. Caller-owned roots/provenance are authority;
// files, summaries and imported approvals are data. No model or price lookup.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildAutonomyReport } = require('./forge-autonomy');
const { loadAutonomySources, readBoundedStableFile, MAX_FILE_BYTES } = require('./forge-autonomy-sources');
const { sha256, fingerprint, resolveSafeFile } = require('./forge-delivery');
const { sanitizeFinal, measure } = require('./forge-attempt-telemetry');
const { countTokens } = require('./forge-tokens');
const { TEMPLATE_FILES } = require('./forge-prompt');
const { MANIFEST_PATH, canonicalProcedureBytes, loadManifest, loadAllProcedureContexts } = require('./forge-procedure-context');
const { buildAgentView } = require('./forge-empirical-input');
const { checkedPath, fail } = require('./forge-empirical-sources');

const STATES = Object.freeze(['observed', 'derived', 'estimated', 'unknown', 'invalid', 'conflict']);
const DIMENSIONS = Object.freeze(['functional', 'tests', 'uat', 'canonical_autonomy', 'exception',
  'interruptions', 'interventions', 'human_effort', 'duration', 'package_bytes', 'package_tokens',
  'provider_input_tokens', 'provider_output_tokens', 'cost']);
const TOKEN = /^[a-zA-Z0-9_.:-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const safe = (s) => typeof s === 'string' && TOKEN.test(s) ? s : null;
const number = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const timestamp = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
  Number.isFinite(Date.parse(s)) ? s : null;

function metric(unit, value = null, state = 'unknown', method = 'unavailable', references = [], extra = {}) {
  return { value, unit, state, method, references, confidence: state === 'observed' ? 'direct' :
    ['derived', 'estimated'].includes(state) ? 'method-limited' : 'unavailable',
  numerator: null, denominator: null, conditions: [], limitations: [], ...extra };
}

// Stable bounded reads, exact byte identity and caller root containment. The
// reference has no authority to introduce another filesystem root.
function readSource(ref, roots) {
  if (!safe(ref.id) || !HASH.test(ref.sha256) || !safe(ref.origin)) fail('source_identity_invalid');
  const resolved = resolveSafeFile(ref.path, roots, { base: roots[0], maxBytes: MAX_FILE_BYTES });
  if (resolved.error) fail(resolved.error);
  const read = readBoundedStableFile(resolved.path, MAX_FILE_BYTES, { expectedReal: resolved.path });
  if (read.error) fail(read.error);
  if (sha256(read.buffer) !== ref.sha256) fail('source_hash_changed');
  return read.buffer;
}

// Observation identity is case + kind + id. Repeated observations merge refs;
// divergent variants remain conflicts rather than winning by source order.
function observationsFor(c, roots, diagnostics) {
  const groups = new Map(); const documents = []; const provenance = [];
  if (!Array.isArray(c.sources) || c.sources.length > 100) fail('sources_invalid');
  for (const ref of c.sources) {
    try {
      const bytes = readSource(ref, roots);
      const reference = { id: ref.id, sha256: ref.sha256, origin: ref.origin };
      provenance.push({ ...reference, bytes: bytes.length, component: safe(ref.component),
        revision: safe(ref.revision), captured_at: timestamp(ref.captured_at) });
      if (ref.format === 'document') { documents.push({ ...reference, pointer: '/', canonical: false }); continue; }
      if (ref.format !== 'observations') fail('source_format_invalid');
      const source = JSON.parse(bytes.toString('utf8'));
      if (source.schema_version !== 1 || source.case_id !== (c.case_id || c.id) || !Array.isArray(source.observations) ||
          source.observations.length > 1000) fail('observation_source_invalid');
      if (source.observations.some((o) => !o || !safe(o.id) || !safe(o.kind))) fail('observation_identity_invalid');
      source.observations.forEach((observation, index) => {
        const identity = observation.kind === 'provider_usage' ? observation.usage_id :
          observation.kind === 'package' ? observation.final?.dispatch_id : observation.id;
        const key = `${observation.kind}:${safe(identity) || observation.id}`;
        const variants = groups.get(key) || new Map(); const hash = fingerprint(observation);
        const item = variants.get(hash) || { data: observation, references: [] };
        item.references.push({ ...reference, pointer: `/observations/${index}` });
        variants.set(hash, item); groups.set(key, variants);
      });
    } catch (error) { diagnostics.push({ code: safe(error.code) || safe(error.message) || 'source_invalid', source_id: safe(ref.id) }); }
  }
  const records = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, variants]) => {
    const rows = [...variants.values()];
    return { kind: key.split(':')[0], conflict: rows.length > 1, data: rows[0].data,
      references: rows.flatMap((row) => row.references).sort((a, b) => fingerprint(a).localeCompare(fingerprint(b))) };
  });
  return { records, documents, provenance: provenance.sort((a, b) => a.id.localeCompare(b.id)) };
}

function evidenceMetric(records, kind, unit, decode, combine = (values) => values[0]) {
  const rows = records.filter((row) => row.kind === kind);
  const refs = rows.flatMap((row) => row.references);
  if (!rows.length) return metric(unit);
  if (rows.some((row) => row.conflict)) return metric(unit, null, 'conflict', 'explicit-evidence', refs);
  const values = rows.map((row) => decode(row.data));
  if (values.some((v) => v === undefined)) return metric(unit, null, 'invalid', 'explicit-evidence', refs);
  if (combine === SINGLE && new Set(values.map(fingerprint)).size > 1)
    return metric(unit, null, 'conflict', 'explicit-evidence', refs);
  const value = combine(values);
  if ((typeof value === 'number' && (!number(value) || (['count', 'bytes', 'tokens'].includes(unit) && !count(value)))) ||
      (value && typeof value === 'object' && 'amount' in value && !number(value.amount)))
    return metric(unit, null, 'invalid', 'aggregate-out-of-range', refs);
  return metric(unit, value, 'observed', 'explicit-evidence', refs, { denominator: rows.length });
}
const SINGLE = (values) => values[0];
const SUM = (values) => values.reduce((a, b) => a + b, 0);
const KNOWN_SUM = (values) => values.includes(null) ? null : SUM(values);

function measureCase(c, options) {
  if (!safe(c.id)) fail('case_identity_invalid');
  if (c.conditions !== undefined && (!Array.isArray(c.conditions) || c.conditions.some((v) => !safe(v)))) fail('conditions_invalid');
  const diagnostics = [];
  const { records, documents, provenance } = observationsFor(c, options.roots, diagnostics);
  const bool = (o) => typeof o.value === 'boolean' && safe(o.check_id) ? o.value : undefined;
  const dimensions = {};
  for (const kind of ['functional', 'uat', 'canonical_autonomy', 'exception'])
    dimensions[kind] = evidenceMetric(records, kind, 'boolean', bool, SINGLE);
  for (const kind of ['interruptions', 'interventions'])
    dimensions[kind] = evidenceMetric(records, kind, 'count', (o) => Number.isSafeInteger(o.value) && o.value >= 0 ? o.value : undefined, SUM);
  dimensions.tests = evidenceMetric(records, 'tests', 'ratio', (o) => {
    if (!Array.isArray(o.checks) || !o.checks.length || new Set(o.checks.map((r) => r.id)).size !== o.checks.length ||
        o.checks.some((r) => !safe(r.id) || !Number.isInteger(r.exit_code)) ||
        o.passed !== o.checks.every((r) => r.exit_code === 0)) return undefined;
    return { passed: o.checks.filter((r) => r.exit_code === 0).length, total: o.checks.length };
  }, (values) => values.reduce((a, b) => ({ passed: a.passed + b.passed, total: a.total + b.total }), { passed: 0, total: 0 }));
  if (dimensions.tests.value !== null) {
    const v = dimensions.tests.value;
    Object.assign(dimensions.tests, { value: v.passed / v.total, numerator: v.passed, denominator: v.total,
      state: 'derived', confidence: 'method-limited' });
  }
  dimensions.human_effort = evidenceMetric(records, 'human_effort', 'ms', (o) =>
    o.measurement === 'active-work' && o.unit === 'ms' && number(o.value) ? o.value : undefined, SUM);
  // Reuse the canonical source/attribution and interval/dedupe algorithms.
  let autonomy = null;
  if (c.autonomy) {
    const manifest = c.autonomy;
    if (![manifest.owner_root, manifest.code_root || manifest.owner_root].every((root) =>
      typeof root === 'string' && options.roots.includes(path.resolve(root)))) diagnostics.push({ code: 'autonomy_root_foreign' });
    else {
      const loaded = loadAutonomySources(manifest);
      autonomy = buildAutonomyReport(manifest);
      // Both public helpers load the manifest themselves. Reject observable
      // drift instead of mixing documents/diagnostics from different snapshots.
      if (fingerprint(loaded) !== fingerprint(loadAutonomySources(manifest))) fail('autonomy_sources_changed');
      diagnostics.push(...autonomy.diagnostics);
      // Explicit inventory only. A foreign gate remains the same bytes/cwd and
      // is independently cited as a document; it never creates a canonical row.
      for (const d of loaded.diagnostics.filter((d) => d.code === 'gate_cwd_foreign')) {
        const file = manifest.sources.gates[d.source_index];
        try {
          const resolved = resolveSafeFile(file, options.roots, { base: manifest.owner_root, maxBytes: MAX_FILE_BYTES });
          if (resolved.error) fail(resolved.error);
          const read = readBoundedStableFile(resolved.path, MAX_FILE_BYTES, { expectedReal: resolved.path });
          if (read.error) fail(read.error);
          const original = JSON.parse(read.buffer.toString('utf8'));
          documents.push({ id: `foreign-gate-${d.source_index}`, sha256: sha256(read.buffer), origin: safe(original.origin) || 'unknown', collector: 'canonical-loader',
            source_kind: 'gates', source_index: d.source_index, pointer: '/', canonical: false, diagnostic: 'gate_cwd_foreign' });
        } catch { diagnostics.push({ code: 'document_unreadable' }); }
      }
    }
  }
  const canonical = (m) => m ? metric(m.unit, m.value, m.state, 'buildAutonomyReport', m.references,
    { coverage: m.coverage, limitations: m.limitations }) : metric('ms');
  dimensions.duration = canonical(autonomy?.families.time.measures.execution_wall_ms);
  const canonicalInterventions = canonical(autonomy?.families.human_interventions.measures.registered_human_answers);
  const responseLatency = canonical(autonomy?.families.human_interventions.measures.registered_response_latency_wall_ms);

  let telemetry = null;
  const packages = records.filter((r) => r.kind === 'package');
  dimensions.package_bytes = evidenceMetric(records, 'package', 'bytes', (o) => {
    const final = sanitizeFinal(o.final);
    return !final ? undefined : final.context.status === 'observed' ? final.context.bytes : null;
  }, KNOWN_SUM);
  dimensions.package_tokens = evidenceMetric(records, 'package', 'tokens', (o) => {
    const final = sanitizeFinal(o.final);
    if (final && o.context === undefined) return null;
    if (typeof o.context !== 'string' || final?.context.sha256 !== measure(o.context, 'baseline').sha256 ||
        final.context.bytes !== Buffer.byteLength(o.context)) return undefined;
    return countTokens(o.context);
  }, KNOWN_SUM);
  if (dimensions.package_tokens.state === 'observed') Object.assign(dimensions.package_tokens,
    { state: 'estimated', method: 'heuristic-chars-4', confidence: 'method-limited' });
  for (const key of ['package_bytes', 'package_tokens']) if (dimensions[key].value === null &&
      ['observed', 'estimated'].includes(dimensions[key].state)) Object.assign(dimensions[key],
    { state: 'unknown', confidence: 'unavailable', method: 'unavailable' });
  if (packages.length === 1 && !packages[0].conflict) {
    const f = sanitizeFinal(packages[0].data.final);
    if (f) telemetry = { context: f.context, request: f.request, model_requested: f.model_requested,
      model_sent: f.model_sent, model_observed: f.model_observed, host: f.host, worker: f.worker,
      transport: f.transport, effort: f.effort, budgets: f.budgets, provider_called: f.provider_called,
      captured_at: timestamp(packages[0].data.final.captured_at) };
  }
  for (const direction of ['input', 'output']) dimensions[`provider_${direction}_tokens`] = evidenceMetric(records,
    'provider_usage', 'tokens', (o) => safe(o.provider) && safe(o.model) && safe(o.usage_id) &&
    count(o[`${direction}_tokens`]) ? o[`${direction}_tokens`] : undefined, SUM);
  dimensions.cost = evidenceMetric(records, 'provider_usage', 'currency', (o) => {
    const p = o.price;
    if (!safe(o.provider) || !safe(o.model) || !safe(o.usage_id) || !count(o.input_tokens) || !count(o.output_tokens)) return undefined;
    if (!p) return null;
    if (!safe(p.source) || !safe(p.currency) || p.model !== o.model || p.unit !== 'per-token' ||
        !number(p.input) || !number(p.output)) return undefined;
    const amount = o.input_tokens * p.input + o.output_tokens * p.output;
    return number(amount) ? { amount, currency: p.currency } : undefined;
  }, (values) => values.some((v) => v === null) ? null : new Set(values.map((v) => v.currency)).size === 1
    ? { amount: values.reduce((sum, v) => sum + v.amount, 0), currency: values[0].currency } : undefined);
  if (dimensions.cost.value === null) Object.assign(dimensions.cost, { state: dimensions.cost.state === 'observed' ? 'unknown' : dimensions.cost.state,
    limitations: ['usage_and_compatible_explicit_price_required'] });
  else if (dimensions.cost.value === undefined) dimensions.cost = metric('currency', null, 'conflict', 'incompatible-currencies', dimensions.cost.references);
  else { dimensions.cost.unit = dimensions.cost.value.currency; dimensions.cost.value = dimensions.cost.value.amount;
    dimensions.cost.state = 'derived'; dimensions.cost.confidence = 'method-limited'; }

  let input = null;
  if (c.input) {
    const trusted = options.inputs?.[c.id];
    if (!trusted || !options.roots.includes(path.resolve(trusted.sourceRoot))) fail('input_authority_required');
    const view = buildAgentView(c.input.corpus, c.input.manifest, trusted);
    input = { sha256: view.sha256, digest: view.digest, split_digest: trusted.split.digest,
      graph_case_id: c.input.manifest.case_id, exposure_registry: trusted.split.exposure_registry };
  }
  return { id: c.id, delivery_id: safe(c.delivery_id) || c.id, dimensions, telemetry, input,
    canonical: { interventions: canonicalInterventions, response_latency: responseLatency, autonomy },
    documents, provenance, conditions: (c.conditions || []).filter(safe).slice(0, 32), diagnostics };
}

function buildEmpiricalBaseline(input, options = {}) {
  if (input?.schema_version !== 1 || !Array.isArray(input.cases) || input.cases.length > 100 ||
      !Array.isArray(options.roots) || !options.roots.length) fail('baseline_input_invalid');
  const roots = options.roots.map((root) => checkedPath(root));
  const unique = new Map();
  for (const c of input.cases) {
    if (unique.has(c.id) && fingerprint(unique.get(c.id)) !== fingerprint(c)) fail('case_conflict');
    unique.set(c.id, c);
  }
  const cases = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).map((c) => measureCase(c, { ...options, roots }));
  // Multiple versions of one delivery do not enlarge the population denominator.
  const deliveries = new Set(cases.map((c) => c.delivery_id)).size;
  const coverage = Object.fromEntries(DIMENSIONS.map((key) => [key, {
    numerator: new Set(cases.filter((c) => ['observed', 'derived', 'estimated'].includes(c.dimensions[key].state) &&
      c.dimensions[key].value !== null).map((c) => c.delivery_id)).size,
    denominator: deliveries, unit: 'deliveries_with_usable_measure',
    states: Object.fromEntries(STATES.map((state) => [state, cases.filter((c) => c.dimensions[key].state === state).length])) }]));
  const body = { schema_version: 1, synthetic: options.synthetic === true, cases, coverage,
    limitations: ['descriptive_not_causal', 'provided_sources_only', 'hash_is_not_authentication',
      'unknown_historical_versions_are_not_current_installation', 'response_latency_is_not_human_effort'],
    template_baseline: options.templateBaseline ? Object.fromEntries(Object.entries(options.templateBaseline)
      .filter(([key]) => key !== 'generated_at')) : null };
  return { ...body, digest: fingerprint(body), generated_at: new Date().toISOString() };
}

// Child-only read boundary: existing measureBaseline has no template/config/io
// injection seam. Keep its real renderer and aggregate, but give it an owned
// tree and a closed data-read policy. This is instrumentation, not an OS sandbox.
const TEMPLATE_CHILD = String.raw`
const fs=require('fs'),path=require('path');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const opened=[]; const runtime=request.runtime; const root=request.root;
const within=(base,p)=>{const r=path.relative(base,p);return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
const allowed=(p)=>within(root,p)||(within(runtime,p)&&p.endsWith('.js'));
for(const name of ['readFileSync','openSync']){const original=fs[name];fs[name]=function(file,...args){
 if(typeof file==='number')return original.call(this,file,...args);
 const p=path.resolve(String(file));if(!allowed(p))throw Error('measurement_read_forbidden');
 const result=original.call(this,file,...args);opened.push(p);return result;};}
const exists=fs.existsSync;fs.existsSync=function(p){return allowed(path.resolve(String(p)))&&exists.call(this,p);};
const {measureBaseline}=require(path.join(runtime,'forge-cost-baseline.js'));
const result=measureBaseline(root);
process.stdout.write(JSON.stringify({result,opened}));
`;

function measureTemplateBaseline(options) {
  const source = checkedPath(options.templateRoot);
  const root = checkedPath(options.measurementRoot);
  if (source === root || root === path.resolve(__dirname, '..')) fail('measurement_root_invalid');
  const inventory = Object.entries(TEMPLATE_FILES).map(([unit, name]) => {
    const file = checkedPath(path.join(source, name));
    const read = readBoundedStableFile(file, MAX_FILE_BYTES, { expectedReal: file });
    if (read.error) fail(read.error);
    return { unit, name, bytes: read.buffer.length, sha256: sha256(read.buffer), buffer: read.buffer };
  });
  // Custom template exports may supply a separate canonical procedure root.
  // Pin both resolver roots: an absent local manifest must never consult HOME.
  const procedureRoot = checkedPath(options.procedureRoot || path.resolve(source, '../../..'));
  if (procedureRoot === root) fail('measurement_root_invalid');
  const procedureOptions = { cwd: procedureRoot, forgeHome: procedureRoot };
  const loaded = loadManifest(procedureOptions);
  loadAllProcedureContexts(procedureOptions);
  const procedures = [MANIFEST_PATH, ...loaded.manifest.modules.filter(item => item.status === 'ready').map(item => item.path)].map(name => {
    const file = checkedPath(path.join(procedureRoot, name));
    const read = readBoundedStableFile(file, MAX_FILE_BYTES, { expectedReal: file });
    if (read.error) fail(read.error);
    const buffer = canonicalProcedureBytes(read.buffer);
    const hash = sha256(buffer);
    const expected = name === MANIFEST_PATH ? loaded.manifest_sha256 : loaded.manifest.modules.find(item => item.path === name).sha256;
    if (hash !== expected) fail('measurement_procedure_drift');
    return { name, bytes: buffer.length, sha256: hash, buffer, source_sha256: sha256(read.buffer) };
  });
  const destination = path.join(root, 'shared', 'templates', 'dispatch');
  const outputs = [...inventory.map(row => ({ ...row, target: path.join(destination, row.name), drift: 'measurement_template_drift' })),
    ...procedures.map(row => ({ ...row, target: path.join(root, row.name), drift: 'measurement_procedure_drift' }))];
  const allowed = new Set(outputs.map(row => row.target));
  const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = checkedPath(path.join(dir, entry.name));
    if (entry.isDirectory()) visit(file);
    else if (!allowed.has(file)) fail('measurement_tree_not_owned');
  } };
  visit(root);
  fs.mkdirSync(destination, { recursive: true });
  for (const row of outputs) {
    fs.mkdirSync(path.dirname(row.target), { recursive: true });
    if (fs.existsSync(row.target)) { if (sha256(fs.readFileSync(row.target)) !== row.sha256) fail(row.drift); }
    else fs.writeFileSync(row.target, row.buffer, { flag: 'wx' });
  }
  const child = spawnSync(process.execPath, ['-e', TEMPLATE_CHILD], { cwd: root, shell: false, windowsHide: true,
    input: JSON.stringify({ root, runtime: __dirname }), encoding: 'utf8', timeout: 30000, maxBuffer: 2 * MAX_FILE_BYTES });
  if (child.status !== 0 || child.error) fail('template_measurement_failed');
  const { result, opened } = JSON.parse(child.stdout);
  if (result.errors.length || Object.keys(result.by_unit_type).length !== inventory.length ||
      result.telemetry?.has_telemetry) fail('template_inventory_incomplete');
  if (options.onRead) opened.forEach(options.onRead);
  for (const row of outputs) if (sha256(fs.readFileSync(row.target)) !== row.sha256) fail(row.drift);
  for (const row of procedures) {
    const file = checkedPath(path.join(procedureRoot, row.name));
    const read = readBoundedStableFile(file, MAX_FILE_BYTES, { expectedReal: file });
    if (read.error || sha256(read.buffer) !== row.source_sha256) fail('measurement_procedure_drift');
  }
  const runtime = [...new Set(opened.filter((file) => file.startsWith(__dirname + path.sep)))].sort()
    .map((file) => ({ file: path.relative(__dirname, file).replace(/\\/g, '/'), sha256: sha256(fs.readFileSync(file)) }));
  const conditions = { policy: 'closed-tree-runtime-js-v1', measurement_root: root, runtime_root: __dirname,
    node: process.version, platform: process.platform, arch: process.arch, runtime,
    procedure_source: { root: procedureRoot, scope: loaded.scope, manifest_sha256: loaded.manifest_sha256,
      inventory: procedures.map(({ buffer, source_sha256, ...row }) => row) },
    configuration: { external_data: 'unavailable-by-read-policy', inputs: result.inputs,
      memory_tokens: 1200, standards_tokens: 3000, ledger_tokens: 1500, auto_commit: false,
      script_dir: __dirname, templates: 'complete-project-local-inventory' } };
  const body = { schema_version: 1, series: 'template-estimate', method: 'heuristic-chars-4', conditions,
    inventory: inventory.map(({ buffer, ...row }) => row), by_unit_type: result.by_unit_type, totals: result.totals,
    limitations: ['same_measurement_root_required', 'configuration_and_runtime_must_match', 'not_provider_usage', 'not_os_sandbox'] };
  return { ...body, digest: fingerprint(body), generated_at: result.generated_at };
}

function renderBaseline(report, options = {}) {
  if (options.public && !report.synthetic) fail('public_export_requires_synthetic');
  const lines = ['# Empirical baseline', '', '| Delivery | Dimension | Value | State | Denominator |', '| --- | --- | --- | --- | --- |'];
  for (const c of report.cases) for (const [name, m] of Object.entries(c.dimensions))
    lines.push(`| ${c.delivery_id} | ${name} | ${m.value === null ? 'unknown' : m.value} | ${m.state} | ${m.denominator ?? 'unknown'} |`);
  return lines.join('\n') + '\n';
}

module.exports = { buildEmpiricalBaseline, measureTemplateBaseline, renderBaseline };
if (require.main === module) {
  process.stderr.write('Use the API with explicit caller roots; imported JSON is not authority.\n');
  process.exitCode = 2;
}
