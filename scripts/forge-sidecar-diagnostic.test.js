#!/usr/bin/env node
'use strict';

// Fixtures only: never read a real account, run a real provider, or touch WDMA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diagnostic-'));
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
const token = 'fixture-secret-never-log';
accounts.resolveLaunch = () => ({ name: 'fixture', token });
const claude = require('./forge-claude-sidecar');
const unit = require('./forge-unit-sidecar');
const { diagnostic, observation, progressLine, readProgressLine } = require('./forge-sidecar-diagnostic');
const { resolveDispatch } = require('./forge-dispatch-resolve');
const { loadProcedureContext } = require('./forge-procedure-context');
const sourceRoot = path.resolve(__dirname, '..');
test('observation silence preserves the v1 snapshot and serialized bytes', () => {
  for (const dimension of ['initial', 'gap']) {
    for (const threshold of [120000, 300000, Number.MAX_SAFE_INTEGER - 1]) {
      const snapshot = { dimension, window_ms: threshold + 1, threshold_ms: threshold,
        policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
      const result = observation({ silence: { ...snapshot, raw: token } });
      assert.deepEqual(result.silence, snapshot);
      assert.equal(JSON.stringify(result), JSON.stringify({ ...observation(), silence: snapshot }));
      assert.deepEqual(observation(result), result);
    }
  }
  assert(!Object.hasOwn(observation({ silence: { dimension: 'gap', window_ms: 120000,
    threshold_ms: 119999, policy: 'claude-silence-v1', source: 'persisted-calibration',
    cause: 'indeterminate' } }), 'silence'));
});

test('observation silence accepts liveness defaults and tightened thresholds for both sources', () => {
  for (const source of ['locked-default', 'persisted-calibration']) {
    for (const [dimension, threshold_ms, window_ms] of [
      ['initial', 60000, 60001], ['gap', 240000, 241000], ['initial', 1, 2], ['gap', 1, 2],
    ]) {
      const silence = { dimension, window_ms, threshold_ms, policy: 'forge-liveness-v1',
        source, cause: 'indeterminate' };
      const result = observation({ silence: { ...silence, raw: token } });
      assert.deepEqual(result, { ...observation(), silence });
      assert.deepEqual(Object.keys(result.silence), ['dimension', 'window_ms', 'threshold_ms', 'policy', 'source', 'cause']);
      assert.deepEqual(observation(result), result);
      assert.deepEqual(diagnostic('anomalous-silence', { observation: result }).observation, result);
    }
  }
});

test('observation silence rejects unknown vocabulary, invalid numbers and thresholds above dimension ceilings', () => {
  const valid = { dimension: 'gap', window_ms: 400000, threshold_ms: 240000,
    policy: 'forge-liveness-v1', source: 'locked-default', cause: 'indeterminate' };
  for (const change of [
    { threshold_ms: 300000 }, { threshold_ms: 240001 },
    { dimension: 'initial', threshold_ms: 60001 },
    { policy: 'forge-liveness-v2' }, { policy: 'claude-silence-v2' },
    { source: 'invented' }, { cause: 'timeout' }, { cause: null }, { dimension: 'other' },
    { threshold_ms: 0 }, { threshold_ms: -1 }, { threshold_ms: 1.5 },
    { threshold_ms: '1' }, { threshold_ms: NaN }, { threshold_ms: Infinity },
    { threshold_ms: Number.MAX_SAFE_INTEGER + 1 },
    { window_ms: 240000 }, { window_ms: 239999 }, { window_ms: '400000' },
    { window_ms: NaN }, { window_ms: Infinity }, { window_ms: 400000.5 },
    { window_ms: Number.MAX_SAFE_INTEGER + 1 },
    { policy: 'claude-silence-v1' },
  ]) {
    assert.deepEqual(observation({ silence: { ...valid, ...change } }), observation(), JSON.stringify(change));
  }
});

test('observation silence adds no keys to an observation without silence', () => {
  assert.deepEqual(Object.keys(observation({ raw: token })), [
    'version', 'elapsed_ms', 'transport_ms', 'verification_ms', 'stdout_bytes', 'stderr_bytes',
    'event_count', 'remote_event_count', 'first_remote_ms', 'last_remote_ms', 'initial_sample_ms',
    'gap_sample_ms', 'remote_silence_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_write_tokens', 'phase', 'cost_usd', 'cost_source', 'remote_source', 'usage_source',
    'gap_suspended', 'process_exit_observed', 'denials',
  ]);
});

test('calibration read outcome survives shared observation and failure projection without open fields', () => {
  const calibration = { diagnostic: 'calibration-unavailable', initial: 'calibrating', gap: 'calibrated' };
  const input = { calibration: { ...calibration, raw: token }, raw: token };
  assert.deepEqual(observation(input).calibration, calibration);
  assert.deepEqual(diagnostic('provider-exit', { observation: input }).observation.calibration, calibration);
  assert.deepEqual(observation(observation(input)), observation(input));
  assert.deepEqual(observation({ calibration: { diagnostic: token, initial: token, gap: token } }).calibration,
    { diagnostic: null, initial: 'uncalibrated', gap: 'uncalibrated' });
  assert(!JSON.stringify(observation(input)).includes(token));
});
test('observation records CLI sources and keeps unknown usage distinct from zero', () => {
  const unknown = observation({ stdout_bytes: 12, remote_event_count: 0, raw: token });
  assert.equal(unknown.remote_source, null);
  assert.equal(unknown.input_tokens, null);
  assert.equal(unknown.usage_source, null);
  const observed = observation({ remote_event_count: 1, input_tokens: 0, output_tokens: -1, cost_usd: 0 });
  assert.equal(observed.remote_source, 'cli-reported-protocol');
  assert.equal(observed.usage_source, 'cli-reported-usage');
  assert.equal(observed.input_tokens, 0);
  assert.equal(observed.output_tokens, null);
  assert.equal(observed.cost_source, 'cli-estimate-usd');
  assert(!JSON.stringify(unknown).includes(token));
});
const procedure = loadProcedureContext({ cwd: sourceRoot, phase: 'research-milestone' });
const oldBin = process.env.FORGE_XLLM_CLAUDE_BIN;
const provider = path.join(root, 'provider.js');
fs.writeFileSync(provider, `
const fs = require('fs');
fs.appendFileSync('calls.txt', 'call\\n');
const args = process.argv.slice(2);
const instruction = args[args.indexOf('-p') + 1];
const prefix = 'Read the complete task prompt from this UTF-8 file: ';
const suffix = '. Follow it exactly and return the required structured_output JSON.';
const prompt = fs.readFileSync(JSON.parse(instruction.slice(prefix.length, -suffix.length)), 'utf8');
fs.writeFileSync('observed-prompt.txt', prompt);
const output = fs.readFileSync('output.txt', 'utf8');
if (fs.existsSync('stderr.txt')) process.stderr.write(fs.readFileSync('stderr.txt'));
// claude -p --output-format json: one result object; modelUsage names the
// received --model unless a scenario supplies model-usage.json.
let structured;
try { structured = JSON.parse(output.slice(output.lastIndexOf('result_json: ') + 13, output.lastIndexOf('---END-RESULT---')).trim()); } catch {}
const model = args[args.indexOf('--model') + 1];
const modelUsage = fs.existsSync('model-usage.json')
  ? JSON.parse(fs.readFileSync('model-usage.json', 'utf8')) : { [model]: { inputTokens: 1 } };
process.stdout.write(fs.existsSync('raw-output') ? output : JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: output, structured_output: structured, modelUsage }));
`);
process.env.FORGE_XLLM_CLAUDE_BIN = provider;
after(() => {
  accounts.resolveLaunch = originalLookup;
  if (oldBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN;
  else process.env.FORGE_XLLM_CLAUDE_BIN = oldBin;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
const requiredPath = '.gsd/milestones/M001/M001-RESEARCH.md';
const optionalPath = '.gsd/CODING-STANDARDS.md';
const allowed = [requiredPath, optionalPath];
const required = [requiredPath];
function payload() { return { status: 'done', summary: 'Research complete', questions: [],
  artifacts: [{ path: requiredPath, content: '# Pesquisa Ω\r\n\n```json\n{"á":"ação"}\n```\nLiteral ---GSD-WORKER-RESULT--- and ---END-RESULT---.' }] }; }
function block(value = payload(), pretty = false, status = value.status) {
  return `---GSD-WORKER-RESULT---\nstatus: ${status}\nresult_json: ${JSON.stringify(value, null, pretty ? 2 : undefined)}\n---END-RESULT---`;
}
const validate = value => unit.inspectArtifacts(value, allowed, required, unit.MAX_ARTIFACT_PAYLOAD_BYTES);
function rejected(text, reason, validator = validate) {
  assert.throws(() => claude.parseExecuteCandidate(text, validator), error => {
    assert.equal(error.code, 'claude-invalid-result');
    assert.equal(error.diagnostic.reason, reason);
    assert(!JSON.stringify(error).includes('private-sentinel'));
    return true;
  });
}
let sequence = 0;
function request(output) {
  const cwd = path.join(root, `workspace-${++sequence}`);
  fs.mkdirSync(path.join(cwd, '.gsd/milestones/M001'), { recursive: true });
  // Stage the actual mandatory closure in the project fixture. Isolated HOME and
  // an absent personal installation must not prevent reaching the adapter seam.
  fs.mkdirSync(path.join(cwd, 'shared'));
  fs.copyFileSync(path.join(sourceRoot, 'shared/forge-procedures.json'), path.join(cwd, 'shared/forge-procedures.json'));
  for (const module of procedure.modules) fs.copyFileSync(path.join(sourceRoot, module.path), path.join(cwd, module.path));
  fs.writeFileSync(path.join(cwd, '.gsd/PROJECT.md'), '# Fixture project');
  fs.writeFileSync(path.join(cwd, '.gsd/milestones/M001/M001-CONTEXT.md'), '# Fixture context');
  fs.writeFileSync(path.join(cwd, '.gsd/forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' },
  }));
  fs.writeFileSync(path.join(cwd, 'output.txt'), output);
  return { cwd, unitType: 'research-milestone', milestoneId: 'M001', description: 'Fixture research',
    route: resolveDispatch({ cwd, unitType: 'research-milestone', hostRuntime: 'codex', milestoneId: 'M001', unitId: 'M001' }),
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}`,
    resultFile: path.join(root, `result-${sequence}.json`),
    constraints: { auto_commit: false, deploy: false } };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
test('calibration-unavailable survives adapter failure, persisted receipt and zero-provider replay', async () => {
  const calibration = require('./forge-sidecar-calibration');
  const options = { userHome: path.join(root, 'corrupt-calibration') };
  fs.mkdirSync(calibration.directory(options), { recursive: true });
  fs.writeFileSync(path.join(calibration.directory(options), 'calibration.json'), 'private-invalid-json');
  const originalRead = calibration.read;
  calibration.read = id => originalRead(id, options);
  try {
    const r = request('invalid provider envelope');
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(unit.runUnitSidecar(r), error => {
        assert.equal(error.diagnostic.observation.calibration.diagnostic, 'calibration-unavailable');
        return true;
      });
      const failure = readJson(r.resultFile), receipt = readJson(r.resultFile + '.receipt.json');
      assert.deepEqual(failure.diagnostic.observation.calibration,
        { diagnostic: 'calibration-unavailable', initial: 'uncalibrated', gap: 'uncalibrated' });
      assert.deepEqual(receipt.failure.diagnostic, failure.diagnostic);
      assert(!JSON.stringify({ failure, receipt }).includes('private-invalid-json'));
    }
    assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  } finally { calibration.read = originalRead; }
});
test('execution receipt and replay retain closed calibration telemetry', async () => {
  const r = request(block());
  Object.assign(r, { unitType: 'execute-task', sliceId: 'S01', taskId: 'T01' });
  const taskDir = path.join(r.cwd, '.gsd/milestones/M001/slices/S01/tasks/T01');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, '../..', 'S01-PLAN.md'), '# Fixture slice\n');
  r.planFile = path.join(taskDir, 'T01-PLAN.md');
  fs.writeFileSync(r.planFile, '---\nid: T01\ntier: standard\nworker: claude\neffort: medium\n---\nFixture plan');
  r.route = resolveDispatch({ cwd: r.cwd, unitType: r.unitType, hostRuntime: 'codex',
    milestoneId: r.milestoneId, sliceId: r.sliceId, unitId: r.taskId, planPath: r.planFile });
  // Load the execution closure into the isolated fixture; no checkout or git writes.
  const procedure = loadProcedureContext({ cwd: sourceRoot, phase: 'execute-task' });
  for (const module of procedure.modules) fs.copyFileSync(path.join(sourceRoot, module.path), path.join(r.cwd, module.path));
  const safe = { diagnostic: 'calibration-unavailable', initial: 'uncalibrated', gap: 'calibrated' };
  // Resume exactly at the persisted execution boundary: the same shared
  // projection constructs trustedTransportRecord after the adapter returns.
  const receiptFile = r.resultFile + '.receipt.json';
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'executed',
    fingerprint: unit.artifactFingerprint(r), dispatch_id: r.dispatchId, before: {},
    telemetry: { observation: observation({ calibration: { ...safe, raw: 'private-calibration' } }) },
    result: { status: 'partial', summary: 'Stopped fixture', questions: [], files_changed: [] } }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const replay = await unit.runUnitSidecar(r);
    const receipt = readJson(receiptFile);
    assert.equal(receipt.phase, 'ready');
    assert.deepEqual(receipt.telemetry.observation.calibration, safe);
    assert(!JSON.stringify(receipt).includes('private-calibration'));
    assert.deepEqual(replay.transport_telemetry.observation.calibration, safe);
    assert.deepEqual(readJson(r.resultFile).transport_telemetry.observation.calibration, safe);
    assert(!fs.existsSync(path.join(r.cwd, 'calls.txt')), 'execution replay never calls the provider');
  }
});
function assertSafeFailureRecords(failure, receipt, events, route, secrets, privatePaths) {
  // Compare the retained resolver observation before allowing its exact path
  // fields. Other route fields (including policy diagnostics) get no exemption.
  assert.deepEqual(receipt.route, route);
  function inspect(value, field) {
    if (typeof value === 'string') {
      for (const secret of secrets) assert(!value.includes(secret), `${field}: provider content leaked`);
      const authorityPath = /^receipt\.route\.(?:resolution_context\.(?:owner|roadmap|plan)|resolution_options\.(?:cwd|planPath|roadmapPath)|resolution_sources\.\d+\.(?:path|physical_path))$/.test(field);
      if (!authorityPath) for (const privatePath of privatePaths) {
        assert(!value.includes(privatePath), `${field}: private path leaked`);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        inspect(key, `${field}.[decoded-key]`);
        inspect(JSON.stringify(key), `${field}.[key]`);
        inspect(entry, `${field}.${key}`);
      }
    }
  }
  inspect(failure, 'failure');
  inspect(receipt, 'receipt');
  inspect(events, 'events');
}

test('failure record assertions decode strings and reject Windows/POSIX diagnostic leaks', () => {
  for (const privatePath of ['C:\\Users\\fixture\\workspace', '/tmp/fixture/workspace']) {
    const route = { resolution_context: { owner: privatePath, roadmap: `${privatePath}/ROADMAP.md` },
      resolution_options: { cwd: privatePath }, resolution_sources: [{ path: privatePath, physical_path: privatePath }] };
    const clean = { failure: { diagnostic: { reason: 'adapter-failed' } },
      receipt: { route, failure: { diagnostic: { reason: 'adapter-failed' } } },
      events: [{ diagnostic: { reason: 'adapter-failed' } }] };
    const check = records => assertSafeFailureRecords(records.failure, records.receipt, records.events,
      route, [token], [privatePath]);
    check(clean);
    for (const surface of ['failure', 'receipt', 'events', 'route-diagnostic']) {
      for (const leaked of [privatePath, token]) {
        const records = JSON.parse(JSON.stringify(clean));
        const target = surface === 'failure' ? records.failure.diagnostic
          : surface === 'receipt' ? records.receipt.failure.diagnostic
            : surface === 'events' ? records.events[0].diagnostic : records.receipt.route;
        target.tail = { nested: [leaked] };
        const expectedRoute = surface === 'route-diagnostic' ? records.receipt.route : route;
        assert.throws(() => assertSafeFailureRecords(records.failure, records.receipt, records.events,
          expectedRoute, [token], [privatePath]), /(?:private path|provider content) leaked/,
        `${surface} must reject decoded leakage`);
        target.tail = { [leaked]: true };
        assert.throws(() => assertSafeFailureRecords(records.failure, records.receipt, records.events,
          expectedRoute, [token], [privatePath]), /(?:private path|provider content) leaked/,
        `${surface} must reject decoded key leakage`);
      }
    }
    // Even authenticated provenance cannot retain provider content or secrets.
    const secretRoute = { ...route, resolution_options: { cwd: token } };
    const records = JSON.parse(JSON.stringify(clean));
    records.receipt.route = secretRoute;
    assert.throws(() => assertSafeFailureRecords(records.failure, records.receipt, records.events,
      secretRoute, [token], [privatePath]), /provider content leaked/);
  }
});

test('compact/multiline JSON carries Markdown, literal markers, Unicode and CRLF intact', () => {
  for (const pretty of [true, false]) {
    const parsed = claude.parseExecuteCandidate(block(payload(), pretty).replace(/\n/g, '\r\n'), validate);
    assert.deepEqual(parsed.candidate, payload());
    assert.deepEqual(parsed.classification, { marker_count: 1 });
  }
});
test('last framed block wins; an invalid last block cannot recover an earlier success', () => {
  const partial = { ...payload(), status: 'partial', questions: ['Need a decision'] };
  assert.equal(claude.parseExecuteCandidate(block() + '\n' + block(partial), validate).candidate.status, 'partial');
  rejected(block() + '\n---GSD-WORKER-RESULT---\nstatus: done', 'end-marker-missing');
});
test('envelope and JSON failures have distinct safe reasons', () => {
  for (const [text, reason] of [
    ['', 'output-empty'], ['private-sentinel', 'marker-missing'],
    ['---GSD-WORKER-RESULT---\n---END-RESULT---', 'status-missing'],
    [block().replace('status: done', 'status: wat'), 'status-invalid'],
    [block().replace(/result_json:.*\n/, ''), 'result-json-missing'],
    [block().replace(/result_json:.*\n/, 'result_json: {"private-sentinel":\n'), 'json-invalid'],
    [block().replace(/\n---END-RESULT---$/, ''), 'end-marker-missing'],
    [block().replace('status: done', 'status: partial'), 'status-mismatch'],
    [block().replace(/result_json:.*\n/, 'result_json: null\n'), 'schema-invalid'],
    [block().replace(/result_json:.*\n/, 'result_json: {} {}\n'), 'json-invalid'],
    [block().replace('result_json:', 'status: blocked\nresult_json:'), 'result-json-missing'],
  ]) rejected(text, reason);
  rejected(block(), 'validator-failed', () => { throw Error('private-sentinel'); });
  rejected(block(), 'adapter-failed', () => ({ ok: false, reason: 'private-sentinel' }));
  rejected(block(), 'schema-invalid', () => false);
});
test('artifact diagnostics identify schema, paths, duplicates, missing artifacts, questions and limits', () => {
  const cases = [
    [{ ...payload(), extra: 'private-sentinel' }, 'schema-invalid'],
    [{ ...payload(), artifacts: [{ path: '../private-sentinel', content: 'x' }] }, 'artifact-path-invalid'],
    [{ ...payload(), artifacts: [payload().artifacts[0], payload().artifacts[0]] }, 'artifact-duplicate'],
    [{ ...payload(), artifacts: [] }, 'artifact-missing'],
    [{ ...payload(), questions: ['private-sentinel'] }, 'questions-on-done'],
    [{ ...payload(), artifacts: Array(33).fill(payload().artifacts[0]) }, 'artifact-limit'],
    [{ ...payload(), artifacts: [{ path: requiredPath, content: 'á'.repeat(unit.MAX_ARTIFACT_BYTES / 2 + 1) }] }, 'artifact-limit'],
    [{ ...payload(), summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES) }, 'payload-limit'],
    [{ ...payload(), artifacts: [{ path: requiredPath, content: '   ' }] }, 'schema-invalid'],
  ];
  for (const [value, reason] of cases) {
    assert.equal(validate(value).reason, reason);
    assert.equal(unit.validateArtifacts(value, allowed, required, unit.MAX_ARTIFACT_PAYLOAD_BYTES), false);
    rejected(block(value), reason);
  }
  // The Claude stream budget must not silently restrict the Codex transport.
  assert.equal(unit.validateArtifacts({ ...payload(), summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES) }, allowed, required), true);
});
test('typed delivery rejection preserves its closed reason without artifact content', () => {
  const artifactPath = 'S03-DELIVERY.json';
  const value = { status: 'done', summary: 'Completed', questions: [],
    artifacts: [{ path: artifactPath, content: JSON.stringify({ private: token }) }] };
  const verdict = unit.inspectArtifacts(value, [artifactPath], [artifactPath], Infinity,
    { [artifactPath]: { kind: 'delivery', unit: { type: 'slice', id: 'S03' } } });
  assert.deepEqual(verdict, { ok: false, reason: 'delivery-artifact-invalid' });
  const safe = diagnostic(verdict.reason, { stdout_bytes: 42, content: value.artifacts[0].content });
  assert.deepEqual(safe, { version: 1, stage: 'validation', reason: 'delivery-artifact-invalid', stdout_bytes: 42 });
  assert.deepEqual(diagnostic(safe.reason, safe), safe);
  assert(!JSON.stringify(safe).includes(token));
});
test('safe diagnostic is a closed vocabulary with numeric metadata only', () => {
  assert.deepEqual(diagnostic('private-sentinel', { stdout_bytes: 3, stderr_bytes: 'private-sentinel',
    duration_ms: -1, tail: 'private-sentinel', marker_count: Infinity, model_observed: 'claude-haiku-4-5' }),
  { version: 1, stage: 'adapter', reason: 'adapter-failed', stdout_bytes: 3 });
});
test('review failures preserve closed resolver/output causes without arbitrary messages', () => {
  const { reviewFailureDiagnostic } = require('./forge-xllm');
  for (const code of ['effort-transport-unsupported', 'effort-unsupported-by-model', 'review-effort-invalid']) {
    const safe = reviewFailureDiagnostic({ code, provider_called: false, message: 'private-sentinel' });
    assert.equal(safe.reason_code, code); assert.equal(safe.provider_called, false);
    assert(!JSON.stringify(safe).includes('private-sentinel'));
  }
  const empty = reviewFailureDiagnostic({ code: 'agy-output-empty', diagnostic: diagnostic('output-empty', { stdout_bytes: 0 }) });
  assert.equal(empty.reason_code, 'agy-output-empty'); assert.equal(empty.diagnostic.reason, 'output-empty');
  assert.equal(empty.provider_called, null);
  const reasons = { 'agy-timeout': 'provider-timeout', 'agy-cancelled': 'provider-cancelled', 'agy-output-limit': 'output-limit',
    'agy-stream-invalid': 'result-error', 'agy-anomalous-silence': 'anomalous-silence', 'agy-exit-nonzero': 'provider-exit',
    'budget-exceeded-while-active': 'budget-exceeded-while-active', 'agy-process-exit-unconfirmed': 'adapter-failed' };
  for (const code of Object.values(require('./forge-agy-transport').AGY_REASON_CODES)) {
    for (const provider_called of [false, null]) {
      const safe = reviewFailureDiagnostic({ code, provider_called: provider_called ?? undefined, message: 'private-sentinel',
        diagnostic: diagnostic(reasons[code], { stdout_bytes: 5, tail: 'private-sentinel' }) });
      assert.equal(safe.reason_code, code); assert.equal(safe.provider_called, provider_called);
      assert.equal(safe.diagnostic.reason, reasons[code]); assert.equal(safe.model_observed, null);
      assert(!JSON.stringify(safe).includes('private-sentinel'));
    }
  }
  const pending = reviewFailureDiagnostic({ code: 'agy-process-exit-unconfirmed', ownership_pending: true,
    ownership: { state: 'pending', pid: 4242, path: 'private-sentinel' }, message: 'private-sentinel' });
  assert.equal(pending.ownership_pending, true); assert.equal(pending.pid, 4242);
  assert(!JSON.stringify(pending).includes('private-sentinel'));
  for (const pid of [0, -1, 1.5, '4242', null, undefined]) {
    const odd = reviewFailureDiagnostic({ code: 'agy-process-exit-unconfirmed', ownership_pending: true, ownership: { pid } });
    assert.equal(odd.ownership_pending, true); assert.equal('pid' in odd, false);
  }
  for (const other of ['agy-timeout', 'private-sentinel']) {
    const leaked = reviewFailureDiagnostic({ code: other, ownership_pending: true, ownership: { pid: 4242 } });
    assert.equal('ownership_pending' in leaked, false); assert.equal('pid' in leaked, false);
  }
  assert.equal('ownership_pending' in reviewFailureDiagnostic({ code: 'agy-process-exit-unconfirmed' }), false);
  process.stdout.write('PASS agy diagnostic codes preserve provider observations without private text\n');
  const unknown =reviewFailureDiagnostic({ code: 'private-sentinel', message: 'private-sentinel', diagnostic: { reason: 'private-sentinel', tail: 'private-sentinel' } });
  assert.equal(unknown.reason_code, 'adapter-failed'); assert.equal(unknown.provider_called, null);
  assert(!JSON.stringify(unknown).includes('private-sentinel'));
});
test('identity stage carries model_count and, only on substitution, the validated observed id', () => {
  for (const reason of ['model-substituted', 'model-unverified', 'model-required']) {
    assert.equal(diagnostic(reason).stage, 'identity');
  }
  for (const reason of ['result-error', 'result-envelope-invalid']) assert.equal(diagnostic(reason).stage, 'envelope');
  assert.deepEqual(diagnostic('model-substituted', { model_count: 1, model_observed: 'claude-haiku-4-5-20251001' }),
    { version: 1, stage: 'identity', reason: 'model-substituted', model_count: 1, model_observed: 'claude-haiku-4-5-20251001' });
  for (const unsafe of ['private-sentinel, other', '../private-sentinel', '-flag', '', 42, 'x'.repeat(200)]) {
    assert.deepEqual(diagnostic('model-substituted', { model_count: 1, model_observed: unsafe }),
      { version: 1, stage: 'identity', reason: 'model-substituted', model_count: 1 });
  }
  assert.deepEqual(diagnostic('model-unverified', { model_count: 2, model_observed: 'claude-haiku-4-5' }),
    { version: 1, stage: 'identity', reason: 'model-unverified', model_count: 2 });
});
test('model-not-found is a closed identity reason that never carries provider text or a model id', () => {
  // S01/T04 (issue 279): the requested route's model does not exist on the provider.
  assert.deepEqual(diagnostic('model-not-found'), { version: 1, stage: 'identity', reason: 'model-not-found' });
  const safe = diagnostic('model-not-found', { message: 'private-sentinel', tail: 'private-sentinel',
    model_observed: 'gpt-missing', stderr_bytes: 7, observation: { phase: 'failed', elapsed_ms: 12, text: 'private-sentinel' } });
  assert.equal(safe.reason, 'model-not-found');
  assert.equal(safe.stage, 'identity');
  assert.equal(safe.stderr_bytes, 7);
  assert.equal(safe.observation.phase, 'failed');
  assert(!('model_observed' in safe), 'only a substitution names an observed model');
  assert(!JSON.stringify(safe).includes('private-sentinel'));
  // The vocabulary stays closed: an unknown reason still collapses to adapter-failed.
  for (const unknown of ['modelNotFound', 'model-not-found ', 'private-sentinel', undefined]) {
    assert.deepEqual(diagnostic(unknown), { version: 1, stage: 'adapter', reason: 'adapter-failed' });
  }
});
test('real rendered research prompt, simulated provider, publication and replay use one invocation', async () => {
  const p = payload();
  p.artifacts.push({ path: optionalPath, content: '# Standards' });
  const r = request(block(p, true));
  const result = await unit.runUnitSidecar(r);
  assert.equal(result.status, 'done');
  const prompt = fs.readFileSync(path.join(r.cwd, 'observed-prompt.txt'), 'utf8');
  assert(prompt.includes(procedure.content), 'real research prompt retains the staged mandatory closure');
  for (const text of ['Research codebase', 'Sidecar delivery contract', requiredPath,
    '921600', '524288', 'structured_output', 'auto_commit', `effort: ${r.route.effort}`]) assert(prompt.includes(text), text);
  for (const artifact of p.artifacts) assert.equal(fs.readFileSync(path.join(r.cwd, artifact.path), 'utf8'), artifact.content);
  fs.unlinkSync(path.join(r.cwd, requiredPath));
  await unit.runUnitSidecar(r);
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
});
test('each rejection persists sanitized diagnostics in result, receipt and event; replay never calls provider', async () => {
  for (const [output, reason] of [
    ['private-sentinel', 'result-envelope-invalid'],
    [block({ ...payload(), status: 'complete' }), 'schema-invalid'],
    [block({ ...payload(), artifacts: [] }), 'artifact-missing'],
    [block({ ...payload(), artifacts: [{ path: '../private-sentinel', content: 'x' }] }), 'artifact-path-invalid'],
    [block({ ...payload(), summary: token }), 'secret-output'],
    [block().replace('Research complete', token.replace('f', '\\u0066')), 'secret-output'],
    ['x'.repeat(1024 * 1024 + 10), 'output-limit'],
  ]) {
    const r = request(output);
    const code = reason === 'output-limit' ? 'claude-output-limit' : 'claude-invalid-result';
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code);
    const failure = readJson(r.resultFile);
    const receipt = readJson(r.resultFile + '.receipt.json');
    const events = fs.readFileSync(path.join(r.cwd, '.gsd/forge/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(failure.diagnostic.reason, reason);
    assert.equal(failure.recovery, 'operator-required');
    assert(Number.isSafeInteger(failure.diagnostic.duration_ms));
    assert.deepEqual(receipt.failure.diagnostic, failure.diagnostic);
    assert.deepEqual(events.at(-1).diagnostic, failure.diagnostic);
    assertSafeFailureRecords(failure, receipt, events, r.route,
      [token, 'private-sentinel'], [r.cwd, fs.realpathSync.native(r.cwd)]);
    assert(!fs.existsSync(path.join(r.cwd, requiredPath)));
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code);
    assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  }
});
test('identity and envelope refusals persist only closed metadata, publish nothing and replay without a provider', async () => {
  const substitute = 'claude-haiku-4-5-20251001';
  for (const [label, prepare, code, expected] of [
    ['substituted', r => fs.writeFileSync(path.join(r.cwd, 'model-usage.json'), JSON.stringify({ [substitute]: {} })),
      'claude-model-substituted', { stage: 'identity', reason: 'model-substituted', model_count: 1, model_observed: substitute }],
    ['auxiliary second model', r => fs.writeFileSync(path.join(r.cwd, 'model-usage.json'),
      JSON.stringify({ [r.route.model_resolved]: {}, [substitute]: {} })),
    'claude-model-unverified', { stage: 'identity', reason: 'model-unverified', model_count: 2 }],
    ['absent modelUsage', r => fs.writeFileSync(path.join(r.cwd, 'model-usage.json'), 'null'),
      'claude-model-unverified', { stage: 'identity', reason: 'model-unverified', model_count: 0 }],
    ['non-JSON stdout', r => fs.writeFileSync(path.join(r.cwd, 'raw-output'), ''),
      'claude-invalid-result', { stage: 'json', reason: 'json-invalid' }],
  ]) {
    const r = request(block());
    assert.notEqual(r.route.model_resolved, substitute, 'the substitute must differ from the route model');
    prepare(r);
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code, label);
    const failure = readJson(r.resultFile);
    const receipt = readJson(r.resultFile + '.receipt.json');
    const events = fs.readFileSync(path.join(r.cwd, '.gsd/forge/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(failure.diagnostic[key], value, `${label}: ${key}`);
    if (!expected.model_observed) assert(!('model_observed' in failure.diagnostic), `${label}: unproven id persisted`);
    assert.equal(failure.reason_code, code);
    assert.equal(failure.error_class, 'terminal');
    assert.equal(failure.recovery, 'operator-required');
    assert.equal(receipt.phase, 'failed');
    assert.deepEqual(receipt.failure.diagnostic, failure.diagnostic);
    assert.deepEqual(events.at(-1).diagnostic, failure.diagnostic);
    assertSafeFailureRecords(failure, receipt, events, r.route,
      [token, 'Research complete', '"usage"', 'inputTokens'], [r.cwd, fs.realpathSync.native(r.cwd)]);
    assert(!fs.existsSync(path.join(r.cwd, requiredPath)), `${label}: an artifact was published`);
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code);
    assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  }
});
test('stderr token on successful exit is refused without persisting output', async () => {
  const r = request(block());
  fs.writeFileSync(path.join(r.cwd, 'stderr.txt'), token);
  await assert.rejects(unit.runUnitSidecar(r), e => e.diagnostic.reason === 'secret-output');
  assert(!fs.readFileSync(r.resultFile, 'utf8').includes(token));
});
test('partial/blocked worker outcomes are preserved and not classified as adapter failures', async () => {
  for (const status of ['partial', 'blocked']) {
    const r = request(block({ ...payload(), status, artifacts: [], questions: ['Human decision needed'] }));
    assert.equal((await unit.runUnitSidecar(r)).status, status);
    assert(!fs.existsSync(path.join(r.cwd, requiredPath)));
    assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  }
});
test('interrupted publication preserves validated receipt and resumes without another provider turn', async () => {
  const p = payload();
  p.artifacts.push({ path: optionalPath, content: '# Standards' });
  const r = request(block(p));
  // macOS temp paths can be aliases (/var -> /private/var). Exercise that
  // difference on every host: production canonicalizes cwd before publication.
  const alias = path.join(root, `workspace-alias-${sequence}`);
  fs.symlinkSync(r.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  r.contextRoot = r.cwd;
  r.cwd = alias;
  const interruptedTarget = path.join(fs.realpathSync(r.cwd), optionalPath);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === interruptedTarget) { const error = Error('private-sentinel'); error.code = 'EACCES'; throw error; }
    return originalRename(from, to);
  };
  try { await assert.rejects(unit.runUnitSidecar(r), e => e.code === 'EACCES'); }
  finally { fs.renameSync = originalRename; }
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  assert.equal(readJson(r.resultFile).diagnostic.reason, 'publication-failed');
  assert.equal(readJson(r.resultFile).recovery, 'replay-publication');
  assert(fs.existsSync(path.join(r.cwd, requiredPath)));
  assert(!fs.existsSync(path.join(r.cwd, optionalPath)));
  await unit.runUnitSidecar(r);
  assert.equal(fs.readFileSync(path.join(r.cwd, optionalPath), 'utf8'), '# Standards');
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  fs.writeFileSync(path.join(r.cwd, optionalPath), 'concurrent edit');
  await assert.rejects(unit.runUnitSidecar(r), e => e.code === 'artifact-conflict');
  assert.equal(fs.readFileSync(path.join(r.cwd, optionalPath), 'utf8'), 'concurrent edit');
  assert.equal(readJson(r.resultFile).diagnostic.reason, 'publication-failed');
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
});

test('budget-exceeded-while-active is a closed transport diagnostic, not adapter-failed', () => {
  const value = diagnostic('budget-exceeded-while-active', { duration_ms: 12 });
  assert.equal(value.stage, 'transport');
  assert.equal(value.reason, 'budget-exceeded-while-active');
  assert.equal(value.duration_ms, 12);
  assert.equal(diagnostic('not-a-reason').reason, 'adapter-failed');
});

const beat = { version: 1, state: 'slow-suspect', since_ms: 120025, reason: 'silence' };

test('observation liveness block is preserved when valid, with optional closed termination', () => {
  assert.deepEqual(observation({ liveness: beat }).liveness, beat);
  for (const termination of ['dead-start', 'dead-silence', 'budget-exceeded-while-active']) {
    const dead = { ...beat, state: 'dead', termination };
    assert.deepEqual(observation({ liveness: dead }).liveness, dead);
  }
  assert(!('termination' in observation({ liveness: beat }).liveness));
  assert.deepEqual(observation(observation({ liveness: beat })).liveness, beat);
});

test('observation liveness block omits invalid input and keeps absent output byte-identical', () => {
  const base = { elapsed_ms: 5, event_count: 2, raw: token };
  const baseline = JSON.stringify(observation(base));
  for (const bad of [undefined, null, 'slow-suspect', 7, [beat], { ...beat, state: 'sleeping' },
    { ...beat, version: 2 }, { ...beat, version: '1' }, { state: 'working' }]) {
    const result = observation({ ...base, liveness: bad });
    assert(!('liveness' in result), JSON.stringify(bad));
    assert.equal(JSON.stringify(result), baseline);
  }
  assert.deepEqual(Object.keys(observation({ ...base, liveness: beat })).slice(0, -1), Object.keys(observation(base)));
});

test('observation liveness block coerces fields and never leaks extras', () => {
  const sentinel = 'sentinel-secret-/path/prompt';
  const result = observation({ liveness: { ...beat, reason: sentinel, since_ms: -1, termination: sentinel,
    fingerprint: sentinel, detail: sentinel, text: sentinel } }).liveness;
  assert.deepEqual(result, { version: 1, state: 'slow-suspect', since_ms: null, reason: null });
  assert.equal(observation({ liveness: { ...beat, since_ms: 1.5 } }).liveness.since_ms, null);
  assert.equal(observation({ liveness: { ...beat, since_ms: '3' } }).liveness.since_ms, null);
  assert(!JSON.stringify(observation({ liveness: { ...beat, fingerprint: sentinel, detail: sentinel } })).includes(sentinel));
});

test('readProgressLine round-trips progressLine and never throws', () => {
  for (const input of [{ elapsed_ms: 9 }, { elapsed_ms: 9, liveness: beat },
    { liveness: { ...beat, state: 'dead', termination: 'dead-silence' } }]) {
    assert.deepEqual(readProgressLine(progressLine(input)), observation(input));
  }
  assert.deepEqual(readProgressLine('[forge-sidecar-progress] ' + JSON.stringify({ liveness: beat })).liveness, beat);
  for (const bad of ['', 'plain text', '[forge-sidecar-progress]{}', '[forge-sidecar-progress] {nope',
    '[forge-sidecar-progress] []', '[forge-sidecar-progress] null', '[forge-sidecar-progress] 5',
    undefined, null, 7, {}, ['x']]) {
    assert.equal(readProgressLine(bad), null, String(bad));
  }
});

test('observation silence accepts claude-silence-v2 only inside [floor, default]', () => {
  const v2 = (dimension, threshold, extra = {}) => ({ dimension, window_ms: threshold + 1, threshold_ms: threshold,
    policy: 'claude-silence-v2', source: 'persisted-calibration', cause: 'indeterminate', ...extra });
  for (const [dimension, limits] of [['initial', [30000, 45000, 60000]], ['gap', [120000, 215000, 240000]]]) {
    for (const threshold of limits) for (const source of ['persisted-calibration', 'model-fallback']) {
      const snapshot = v2(dimension, threshold, { source });
      const result = observation({ silence: { ...snapshot, raw: token } });
      assert.deepEqual(result.silence, snapshot);
      assert.deepEqual(readProgressLine(progressLine({ silence: snapshot })).silence, snapshot);
    }
  }
  const refused = [v2('gap', 240001), v2('gap', 119999), v2('initial', 29999), v2('initial', 60001),
    v2('gap', 215000, { source: 'locked-default' }), v2('gap', 215000, { cause: 'measured' }),
    v2('gap', 215000, { window_ms: 215000 }), v2('gap', 215000, { window_ms: 1000 }),
    v2('gap', 215000.5), v2('gap', 215000, { dimension: 'other' })];
  for (const bad of refused) assert(!('silence' in observation({ silence: bad })), JSON.stringify(bad));
});

test('observation v2 branch does not change v1 or liveness-v1 projections', () => {
  const v1 = { dimension: 'gap', window_ms: 130001, threshold_ms: 130000, policy: 'claude-silence-v1',
    source: 'persisted-calibration', cause: 'indeterminate' };
  assert.deepEqual(observation({ silence: v1 }).silence, v1);
  const live = { dimension: 'gap', window_ms: 100001, threshold_ms: 100000, policy: 'forge-liveness-v1',
    source: 'persisted-calibration', cause: 'indeterminate' };
  const liveOut = observation({ silence: live }).silence;
  assert.equal(liveOut.policy, live.policy);
  assert.deepEqual(Object.keys(observation({ calibration: { initial: 'calibrated', gap: 'calibrated' } }).calibration),
    ['diagnostic', 'initial', 'gap']);
});
