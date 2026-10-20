#!/usr/bin/env node
'use strict';

// Offline metadata only. Imported paths, commands, consent and provider claims
// are never followed. The fixture uses public sources and temporary roots.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256, fingerprint } = require('./forge-delivery');
const { captureFinal, measure } = require('./forge-attempt-telemetry');
const { buildContextComparison } = require('./forge-context-comparison');
const { renderPrompt } = require('./forge-prompt');
const { buildNativeInvocation } = require('./forge-native-invocation');
const { childEnv } = require('./run-tests');

const MAX_INPUT_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,80}\/MEM[0-9]{3,8}$/;
const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/;
const PUBLIC_CONTROLS = Object.freeze([
  { path: 'scripts/fixtures/empirical-corpus/baseline/cases.json', sha256: '12aedd45c5dcc0c00f1278aa9d4cba3b281d51bd0a167695974df733cf4fa2d7', slice: 'S02' },
  { path: 'scripts/fixtures/empirical-corpus/historical/s03-context-comparison.test.js.snapshot', sha256: 'a753b3bd990370a071e400950c8941469b2ef221df48286f97227861cb334690', slice: 'S03' },
]);
const REGRESSIONS = Object.freeze([
  { id: 'R4', file: 'forge-unit-sidecar.test.js', marker: 'native-initial R4 authority/correction/resume:' },
  { id: 'R5', file: 'forge-procedure-callers.test.js', marker: 'real caller/procedure tests passed' },
  { id: 'CLI', file: 'forge-xllm-review-cli.test.js', marker: '0 failed; synthetic adapter only' },
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && ID.test(id))
  && new Set(value).size === value.length;
function validBudgets(value) {
  return object(value) && Object.entries(value).every(([key, item]) => /^[a-z_]{1,60}$/.test(key)
    && (typeof item === 'number' ? Number.isFinite(item) && item >= 0 : validBudgets(item)));
}

// Inspect original shapes before S03 normalization (R1/R2). Null is unavailable,
// whereas an explicitly observed empty array/object remains a real observation.
function validateComparisonControls(row) {
  const failures = [];
  const policy = row?.controls?.budget_policy;
  const budgets = row?.final_evidence?.budgets, captured = row?.capture?.identity?.budgets;
  if (!validBudgets(policy) || !Object.keys(policy).length || !validBudgets(budgets) || !validBudgets(captured)
      || fingerprint(policy) !== fingerprint(budgets) || fingerprint(policy) !== fingerprint(captured)) failures.push('R1-budget-control-unobserved-or-invalid');
  if (!Array.isArray(row?.conditions?.flags) || row.conditions.flags.some(flag => typeof flag !== 'string' || !LABEL.test(flag))
      || new Set(row.conditions.flags).size !== row.conditions.flags.length) failures.push('R1-flags-control-unobserved-or-invalid');
  if (!['input_sha256', 'template_sha256'].every(key => typeof row?.conditions?.[key] === 'string' && HASH.test(row.conditions[key]))
      || !['harness_version', 'clock'].every(key => typeof row?.conditions?.[key] === 'string' && LABEL.test(row.conditions[key]))) failures.push('comparison-original-controls-unobserved-or-invalid');
  if (!HASH.test(row?.package?.template_sha256) || row.package.template_sha256 !== row?.conditions?.template_sha256) failures.push('package-template-binding-mismatch');
  if (!HASH.test(row?.package?.final_sha256) || row.package.final_sha256 !== row?.final_evidence?.context?.sha256
      || row.package.final_sha256 !== row?.capture?.context?.sha256) failures.push('package-final-binding-mismatch');
  for (const [name, ids] of [['selection', row?.selected_ids], ['delivery', row?.delivery?.delivered_ids], ['capture', row?.capture?.delivered_ids]]) {
    if (ids === null || ids === undefined) failures.push(`${name}-unknown`);
    else if (!validIds(ids)) failures.push(`R2-${name}-ids-invalid`);
  }
  if (!Array.isArray(row?.delivery?.omitted) || row.delivery.omitted.some(item => !object(item)
      || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.reason !== 'string' || !LABEL.test(item.reason))) failures.push('R2-omitted-ids-invalid');
  return failures;
}

function packageMetadata(row) {
  const evidence = row?.final_evidence;
  const item = row?.package;
  const measurement = measure(undefined, 'not-observed');
  const safeMeasurement = value => value?.status === 'observed' && Number.isInteger(value.bytes) && value.bytes >= 0
    && HASH.test(value.sha256) && ['utf8-sha256', 'json-utf8-sha256'].includes(value.method)
    ? { status: 'observed', bytes: value.bytes, sha256: value.sha256, method: value.method } : measurement;
  const ids = value => validIds(value) ? [...value] : null;
  const modules = Array.isArray(item?.modules) && item.modules.every(module => object(module) && typeof module.id === 'string' && LABEL.test(module.id)
    && HASH.test(module.sha256) && Number.isInteger(module.bytes) && module.bytes > 0)
    ? item.modules.map(module => ({ id: module.id, sha256: module.sha256, bytes: module.bytes })) : null;
  return { context: safeMeasurement(evidence?.context), request: safeMeasurement(evidence?.request),
    chars: Number.isInteger(item?.chars) && item.chars >= 0 ? item.chars : null,
    estimated_tokens: Number.isInteger(row?.input_tokens) && row.input_tokens >= 0 && row.token_method === 'heuristic-chars-4' ? row.input_tokens : null,
    token_method: 'heuristic-chars-4', provider_tokens: null,
    template_sha256: HASH.test(item?.template_sha256) ? item.template_sha256 : null,
    composition_sha256: HASH.test(item?.composition_sha256) ? item.composition_sha256 : null,
    final_sha256: HASH.test(item?.final_sha256) ? item.final_sha256 : null, modules,
    budgets: validBudgets(evidence?.budgets) ? evidence.budgets : null,
    selected_ids: ids(row?.selected_ids), delivered_ids: ids(row?.delivery?.delivered_ids),
    model_requested: typeof evidence?.model_requested === 'string' && LABEL.test(evidence.model_requested) ? evidence.model_requested : null,
    effort_requested: typeof evidence?.effort === 'string' && LABEL.test(evidence.effort) ? evidence.effort : null,
    model_observed: null, effort_observed: null, external_provider_called: 'unknown' };
}

function findings(regressions = []) {
  const result = [
    { id: 'R1', status: 'open-S05', file: 'scripts/forge-context-comparison.js', cause: 'Missing budgets/flags normalize to empty controls', required_test: 'Reject missing original controls before normalization' },
    { id: 'R2', status: 'open-S05', file: 'scripts/forge-context-comparison.js', cause: 'Invalid memory IDs are filtered before equality', required_test: 'Reject malformed original selected/delivered/captured IDs' },
    { id: 'R3', status: 'open-S05', file: 'scripts/forge-context-comparison.js', cause: 'Prior Markdown renderer displays null delivery as none', required_test: 'Distinguish unknown null from observed empty delivery in prior renderer' },
  ];
  for (const definition of REGRESSIONS) {
    const check = regressions.find(row => row.id === definition.id);
    const passed = check?.exit_code === 0 && check?.marker_observed === true && HASH.test(check?.source_sha256);
    result.push({ id: definition.id, status: passed ? 'corrected-local-regression' : 'unverified',
      file: `scripts/${definition.file}`, check: passed ? { command: `node scripts/${definition.file}`, exit_code: check.exit_code,
        source_sha256: check.source_sha256, stdout_sha256: check.stdout_sha256, duration_ms: check.duration_ms } : null,
      limitation: definition.id === 'CLI' ? 'Historical event cause remains unknown' : 'Synthetic adapters; independent final review pending' });
  }
  return result;
}

function buildProcedureEvidence(before, after, options = {}) {
  const variants = [before, after];
  if (variants.some(row => !object(row) || row.schema_version !== 1)) throw Error('procedure-evidence-input-invalid');
  const failures = variants.flatMap((row, index) => validateComparisonControls(row).map(reason => `${index ? 'after' : 'before'}:${reason}`));
  let comparison = null;
  // Commands/prose in inputs are data. Only validated original controls reach
  // the existing comparator; no repair/filter is used to make a case eligible.
  if (!failures.length) {
    try {
      const checked = buildContextComparison({ schema_version: 1, cases: [{ case_id: 'explicit-control',
        variants: [{ ...before, variant: 'baseline' }, { ...after, variant: 'current' }] }] });
      // S03's memory-selection-only label is not a supported attribution for
      // procedure packages. Keep its binding checks, replace that causal label.
      comparison = { ...checked, cases: checked.cases.map(item => ({ ...item,
        difference: { ...item.difference, changed: item.comparable ? 'observed-package-delta' : 'unknown' } })) };
    }
    catch { failures.push('comparison-input-invalid'); }
  }
  const comparable = Boolean(comparison?.cases[0].comparable);
  if (!comparable && !failures.length) failures.push('baseline-ineligible-or-final-capture-unbound');
  return { schema_version: 1, kind: 'procedure-package-evidence', synthetic: options.synthetic === true,
    comparative_ready: false, prospective_cases: 0, functional_gain: null,
    provenance: { input_sha256: variants.map(row => fingerprint(row)),
      public_controls: options.synthetic ? PUBLIC_CONTROLS : [], supplied_files_only: !options.synthetic,
      baseline_eligible: comparable, historical_baseline_eligible: false },
    before: packageMetadata(before), after: packageMetadata(after), comparable,
    difference: comparable ? comparison.cases[0].difference : { context_bytes: null, estimated_tokens: null, changed: 'unknown' },
    comparison, findings: findings(options.regressions),
    closure_guard: { status: 'pending-owner-closure', snapshot: 'immediately before S04 completer', verify: 'immediately after, same owner/run/CODE_DIR',
      historical_S03_guard: 'inconclusive; not reclassified' },
    limitations: [...new Set([...failures, 'synthetic-controls-are-not-historical-baseline', 'no-provider-execution-proof',
      'no-UAT-or-effectiveness-proof', 'zero-prospective-enrollments', 'freeze-future-protocol-before-outcomes',
      'S03-R1-R3-remain-open', 'text-reduction-alone-is-not-success'])].sort() };
}

function renderProcedureEvidence(report) {
  const memory = value => value === null ? 'unknown' : value.length ? value.join(', ') : 'none (observed empty)';
  const lines = ['# Procedure package evidence', '', report.synthetic ? 'SYNTHETIC public fixture; no provider inference.' : 'Explicit sanitized input metadata; provenance is supplied, not authenticated.', '',
    `Comparable technical control: ${report.comparable}; historical comparative_ready: false; prospective cases: 0.`,
    'Bytes and chars/4 estimates do not establish effectiveness, installation or human acceptance.', '',
    '| Measurement | Before | After |', '| --- | --- | --- |'];
  for (const key of ['chars', 'estimated_tokens', 'template_sha256', 'composition_sha256', 'final_sha256']) lines.push(`| ${key} | ${report.before[key] ?? 'unknown'} | ${report.after[key] ?? 'unknown'} |`);
  for (const key of ['context', 'request']) lines.push(`| ${key} bytes | ${report.before[key].bytes ?? 'unknown'} | ${report.after[key].bytes ?? 'unknown'} |`);
  lines.push(`| Delivered memory | ${memory(report.before.delivered_ids)} | ${memory(report.after.delivered_ids)} |`, '', '## Findings', '');
  for (const finding of report.findings) lines.push(`- ${finding.id}: ${finding.status}; ${finding.file}. ${finding.cause || finding.limitation}. ${finding.required_test || finding.check?.command || 'Regression not observed'}.`);
  lines.push('', '## Closure guard', '', 'Owner snapshot immediately before completer; verify immediately after with the same run and CODE_DIR. Pending future closure.',
    'The historical S03 guard remains inconclusive.', '', '## Limitations', '');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  return lines.join('\n') + '\n';
}

function runProcedureRegressions() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-regressions-'));
  try { return REGRESSIONS.map(definition => {
    const file = path.join(__dirname, definition.file), started = Date.now();
    const result = spawnSync(process.execPath, [file], { cwd: path.resolve(__dirname, '..'), shell: false, windowsHide: true,
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * MAX_INPUT_BYTES,
      // Reuse the runner's personal/config/keychain confinement; runtime
      // fallback is the explicit public checkout, never an operator install.
      env: { ...childEnv(home, definition.file), FORGE_HOME: path.resolve(__dirname, '..') } });
    return { id: definition.id, exit_code: result.status, marker_observed: (result.stdout || '').includes(definition.marker),
      source_sha256: sha256(fs.readFileSync(file)), stdout_sha256: sha256(result.stdout || ''), duration_ms: Date.now() - started };
  }); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function createProcedureFixture() {
  const source = path.resolve(__dirname, '..');
  for (const control of PUBLIC_CONTROLS) if (sha256(fs.readFileSync(path.join(source, control.path))) !== control.sha256) throw Error('public-control-source-drift');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-measure-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME'].map(key => [key, process.env[key]]));
  try {
    // Cached prefs resolve their global paths from the live environment. Keep
    // even absent-file probes inside this disposable fixture, then restore it.
    for (const key of Object.keys(previous)) process.env[key] = root;
    // Explicit public inputs; no project .gsd, memory store or private corpus.
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(path.join(root, '.gsd/forge-prefs.jsonc'), JSON.stringify({ token_budget: { auto_memory: 0, coding_standards: 0, ledger: 0 } }));
    const budgets = require('./forge-prefs').readPrefsCached(root).prefs.token_budget;
    const rendered = renderPrompt({ cwd: root, codeDir: source, templateDir: path.join(source, 'shared/templates/dispatch'), unitType: 'execute-task',
      milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', unitEffort: 'medium', autoCommit: false,
      memoryMaxTokens: 0, standardsMaxTokens: 0, ledgerMaxTokens: 0, memoryQuery: '', memories: '', ledger: '' });
    const route = { config_ok: true, dispatch_allowed: true, model: 'gpt-6-sol', model_requested: 'gpt-6-sol', effort: 'medium',
      host_runtime: 'codex', resolved_worker_engine: 'codex', worker_mode: 'native' };
    const caps = { available: true, tool: 'synthetic-spawn', models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
    function packaged(text, metadata) {
      const native = buildNativeInvocation({ hostRuntime: 'codex', activeCapabilities: caps, resolvedDispatch: route,
        agentType: 'forge-executor', taskName: 'public_fixture', prompt: text });
      if (!native.ok) throw Error('public-fixture-native-refused');
      const final_evidence = captureFinal({ request: native.args, context: native.args.message, identity: {
        unitType: 'execute-task', scope: 'milestone', phase: 'execute', dispatchId: 'public-fixture' },
        route, transport: 'native-tool', model: native.args.model, effort: native.args.reasoning_effort, budgets });
      return { schema_version: 1, final_evidence, controls: { budget_policy: budgets }, availability: 'present',
        execution_kind: 'transport-simulation', input_tokens: Math.ceil(text.length / 4), token_method: 'heuristic-chars-4',
        selected_ids: [], delivery: { delivered_ids: [], omitted: [] },
        capture: { context: measure(text, 'callback'), request: measure(native.args, 'callback', true), identity: { ...final_evidence },
          delivered_ids: [], input_tokens: Math.ceil(text.length / 4), token_method: 'heuristic-chars-4' },
        conditions: { input_sha256: fingerprint(PUBLIC_CONTROLS), template_sha256: metadata.template_sha256,
          harness_version: 'procedure-public-v1', clock: 'synthetic-fixed', flags: ['auto-commit-false', 'zero-optional-budgets'] },
        package: { ...metadata, chars: text.length, final_sha256: sha256(text) } };
    }
    // S03's frozen public control is literally "old". It is not an eligible
    // pre-S04 final package. A differing template hash forces an unknown delta.
    const before = packaged('old', { template_sha256: PUBLIC_CONTROLS[1].sha256 });
    const after = packaged(rendered.prompt, { template_sha256: rendered.template_sha256,
      composition_sha256: rendered.procedure_context.composition_sha256, modules: rendered.procedure_context.modules });
    return { before, after };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readSanitizedInput(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) throw Error('procedure-evidence-file-invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
module.exports = { validateComparisonControls, buildProcedureEvidence, renderProcedureEvidence, runProcedureRegressions, createProcedureFixture };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (Object.hasOwn(options, key)) throw Error('duplicate-argument');
      if (key === '--fixture') options[key] = true;
      else if (['--before-file', '--after-file', '--output-dir'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
      else throw Error('invalid-argument');
    }
    if (!options['--output-dir'] || (options['--fixture'] ? options['--before-file'] || options['--after-file'] : !options['--before-file'] || !options['--after-file'])) throw Error('invalid-mode');
    const input = options['--fixture'] ? createProcedureFixture() : { before: readSanitizedInput(options['--before-file']), after: readSanitizedInput(options['--after-file']) };
    const regressions = options['--fixture'] ? runProcedureRegressions() : [];
    const report = buildProcedureEvidence(input.before, input.after, { synthetic: Boolean(options['--fixture']), regressions });
    if (options['--fixture'] && report.findings.some(row => ['R4', 'R5', 'CLI'].includes(row.id) && row.status !== 'corrected-local-regression')) throw Error('required-regression-failed');
    fs.mkdirSync(options['--output-dir'], { recursive: true });
    fs.writeFileSync(path.join(options['--output-dir'], 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(options['--output-dir'], 'report.md'), renderProcedureEvidence(report));
    process.stdout.write(JSON.stringify({ written: ['report.json', 'report.md'], synthetic: report.synthetic, comparable: report.comparable }) + '\n');
  } catch { process.stderr.write('forge-procedure-evidence: invalid input or required local regression failed\n'); process.exitCode = 2; }
}
