'use strict';
// forge-e2e-evidence: labels, provenance, files, sanitization, live handle and CLI.
// Every value below is synthetic. The `recorded`/`real` structures are built only
// in a temporary directory, are STRUCTURAL test inputs, and are never versioned
// or treated as a recording.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const evidence = require('./forge-e2e-evidence');
const { EVIDENCE_VERSION, LABELS, ORIGINS, EXECUTION_MODES, CHANNELS, REASON_CODES, LIMITS, ALLOWLIST_VERSION,
  sanitizeCapture, scanRecords, createLiveObservation, verifyEvidence, serializeRecords } = evidence;

const FIXTURE = path.join(__dirname, 'fixtures', 'issue-440', 'e2e-mock');
const MODULE = path.join(__dirname, 'forge-e2e-evidence.js');
const PIN_FILE = path.join(__dirname, '..', 'shared', 'schemas', 'codex-appserver-pin.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const H = label => sha(`structural-${label}`);
const covered = new Set();
const pass = name => console.log(`PASS ${name}`);
function refused(result, code, name) {
  assert.equal(result.ok, false, `${name}: must refuse`);
  assert.equal(result.reason_code, code, `${name}: reason`);
  assert.deepEqual(result.files, [], `${name}: no file facts on refusal`);
  covered.add(code); pass(`${name} -> ${code}`);
}
const fixtureBytes = () => Object.fromEntries(fs.readdirSync(FIXTURE).sort().map(name => [name, sha(fs.readFileSync(path.join(FIXTURE, name)))]));
const before = fixtureBytes();
const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-e2e-evidence-')));
let serial = 0;
function copyFixture() {
  const dir = path.join(temp, `case-${++serial}`); fs.mkdirSync(dir);
  for (const name of ['manifest.json', 'recording.jsonl']) fs.copyFileSync(path.join(FIXTURE, name), path.join(dir, name));
  return dir;
}
const readManifest = dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const writeManifest = (dir, manifest) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const readRecords = dir => fs.readFileSync(path.join(dir, 'recording.jsonl'), 'utf8').slice(0, -1).split('\n').map(line => JSON.parse(line));
function writeRecording(dir, text) {
  // Rebinds manifest hash/bytes/records so only the content property under test differs.
  fs.writeFileSync(path.join(dir, 'recording.jsonl'), text);
  const manifest = readManifest(dir), bytes = Buffer.from(text);
  Object.assign(manifest.files[0], { sha256: sha(bytes), bytes: bytes.length, records: text.split('\n').filter(Boolean).length });
  writeManifest(dir, manifest);
}
function mutate(dir, onRecords, onManifest) {
  if (onRecords) { const records = readRecords(dir); onRecords(records); writeRecording(dir, serializeRecords(records)); }
  if (onManifest) { const manifest = readManifest(dir); onManifest(manifest); writeManifest(dir, manifest); }
  return dir;
}
function cli(...args) {
  const run = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(run.error, undefined);
  assert.equal(run.stderr, '', 'the CLI never prints stacks or content to stderr');
  const lines = run.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one JSON line');
  const out = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(out), ['ok', 'label', 'origin', 'execution_mode', 'files', 'reason_code']);
  return { status: run.status, out };
}

// Synthetic raw capture in the documented contract, with secrets, paths and IDs to remove.
const FAKE_KEY = 'sk-' + 'SYNTHETICFAKEKEY0001';
const FAKE_UUID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const FAKE_MAIL = 'structural.user' + '@' + 'example.com';
function structuralRaw(tag = 'a', overrides = {}) {
  const lab = `C:\\Users\\structural-user\\lab-${tag}`, forge = 'C:\\Users\\structural-user\\forge';
  return {
    placeholders: { [lab]: '<LAB>', [forge]: '<FORGE_SOURCE>' },
    host: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: FAKE_UUID, cwd: lab, model: 'claude-structural-model',
        claude_code_version: overrides.host || 'test-structural-2.0.0', permissionMode: 'default', tools: ['Read', 'Bash'], mcp_servers: [] }),
      JSON.stringify({ type: 'assistant', session_id: FAKE_UUID, message: { id: 'msg_structural', content: [
        { type: 'text', text: 'private assistant narration' },
        { type: 'tool_use', id: 'toolu_structural_1', name: 'Bash', input: {
          command: `node ${forge}\\scripts\\forge-unit-sidecar.js --request ${lab}\\request.json`, description: 'private description' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_structural_1', is_error: false,
        content: 'private log line\n{"status":"done","artifact":"private"}' }] } }),
      'not json at all',
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 4200, session_id: FAKE_UUID,
        total_cost_usd: 0.1, modelUsage: { 'claude-structural-model': {} }, usage: { input_tokens: 100, output_tokens: 20, service_tier: 'standard' } }),
    ],
    worker: [
      { direction: 'client', offset_ms: 0, line: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'forge-structural', version: '1.0.0' } } }) },
      { direction: 'server', offset_ms: 4, line: JSON.stringify({ id: 0, result: { userAgent: `codex_cli_rs/${overrides.worker || 'test-structural-0.170.0'} (Windows 10; x86_64) private-terminal` } }) },
      { direction: 'client', offset_ms: 5, line: JSON.stringify({ id: 1, method: 'thread/start', params: { model: 'gpt-structural', approvalPolicy: 'never', ephemeral: true, sandbox: 'workspace-write', cwd: lab } }) },
      { direction: 'server', offset_ms: 7, line: JSON.stringify({ id: 1, result: { thread: { id: 'thr_structural' } } }) },
      { direction: 'client', offset_ms: 8, line: JSON.stringify({ id: 2, method: 'turn/start', params: { threadId: 'thr_structural',
        input: [{ type: 'text', text: `private prompt for ${FAKE_MAIL}` }], outputSchema: { type: 'object' }, effort: 'low',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [lab] } } }) },
      { direction: 'server', offset_ms: 9, line: JSON.stringify({ id: 2, result: { turn: { id: 'turn_structural' } } }) },
      { direction: 'server', offset_ms: 12, line: JSON.stringify({ method: 'item/completed', params: { threadId: 'thr_structural', turnId: 'turn_structural',
        item: { type: 'reasoning', id: 'item_reasoning', text: 'private reasoning text' } } }) },
      { direction: 'server', offset_ms: 15, line: JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'item_final',
        phase: 'final_answer', status: 'completed', text: `{"status":"done","note":"wrote ${lab}\\out.md for ${FAKE_MAIL} with ${FAKE_KEY} id ${FAKE_UUID} under /home/structural-user/x"}` } } }) },
      { direction: 'server', offset_ms: 18, line: JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_structural', status: 'completed',
        usage: { input_tokens: 50, output_tokens: 9 } } } }) },
      { direction: 'sideways', offset_ms: 1, line: '{}' },
    ],
    attempt: [
      { kind: 'identity', value: { dispatch_sha256: H('dispatch'), fingerprint_sha256: H('fingerprint'), recovery_identity_sha256: H('recovery'),
        claim_sha256: H('claim'), lease_generation: 3, request_bytes: 10, request_sha256: H('request'), context_bytes: 20,
        context_sha256: H('context'), operator: FAKE_MAIL } },
      { kind: 'receipt', value: { phase: 'started', provider_called: true } },
      { kind: 'custody', value: { method: 'windows-job-object', status: 'stopped', joined: true, active: 0, pid: 4242 } },
      { kind: 'event', value: { name: 'sidecar-attempt-started', status: 'recorded' } },
      { kind: 'receipt', value: { phase: 'ready', provider_called: true } },
      { kind: 'unknown-kind', value: {} },
    ],
  };
}
const pinBytes = fs.readFileSync(PIN_FILE);
const pinVersion = JSON.parse(pinBytes.toString('utf8')).meta.codex_version;
function writeStructural(dir, raw, { label = 'recorded', origin = 'captured', mode = 'replay', worker = 'test-structural-0.170.0' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const sanitized = sanitizeCapture(raw);
  const text = serializeRecords(sanitized.records), bytes = Buffer.from(text);
  const identity = sanitized.records.find(r => r.kind === 'identity'), init = sanitized.records.find(r => r.kind === 'init');
  const per = ch => sanitized.records.filter(r => r.channel === ch).length;
  fs.writeFileSync(path.join(dir, 'recording.jsonl'), bytes);
  writeManifest(dir, { evidence_version: EVIDENCE_VERSION, label, origin, execution_mode: mode,
    route: { host: 'claude-code', worker: 'codex', transport: 'app-server', worker_mode: 'sidecar' },
    provenance: { captured_at: '2026-11-22T10:00:00.000Z', method: 'structural-test-capture', tools: [{ name: 'forge-e2e-evidence', sha256: sha(fs.readFileSync(MODULE)) }],
      versions: { host: init.claude_code_version, worker, node: process.version, forge: { revision: '0'.repeat(40), dirty: true },
        appserver_schema_pin: { path: 'shared/schemas/codex-appserver-pin.json', sha256: sha(pinBytes), codex_version: pinVersion },
        os: { platform: process.platform, release: 'structural-release', arch: process.arch } },
      attempt: Object.fromEntries(['dispatch_sha256', 'fingerprint_sha256', 'recovery_identity_sha256', 'claim_sha256', 'lease_generation'].map(k => [k, identity[k]])),
      raw_capture_sha256: sanitized.transform.raw_capture_sha256,
      sanitizer: { version: sanitized.transform.sanitizer_version, allowlist_version: sanitized.transform.allowlist_version },
      environment_overrides: ['FORGE_XLLM_CODEX_BIN'] },
    files: [{ path: 'recording.jsonl', sha256: sha(bytes), bytes: bytes.length, records: sanitized.records.length }],
    counts: { records: sanitized.records.length, host: per('host'), worker: per('worker'), attempt: per('attempt') },
    limits: { ...LIMITS } });
  return dir;
}

try {
  // ── API surface ────────────────────────────────────────────────────────────
  assert.equal(EVIDENCE_VERSION, 'e2e-evidence-v1');
  assert.deepEqual([LABELS, ORIGINS, EXECUTION_MODES, CHANNELS], [['mock', 'recorded', 'real'], ['synthetic', 'captured'], ['synthetic', 'replay', 'live'], ['host', 'worker', 'attempt']]);
  for (const list of [LABELS, ORIGINS, EXECUTION_MODES, CHANNELS, REASON_CODES, LIMITS, evidence.ALLOWLIST, evidence.ALLOWLIST.host.init.fields]) assert(Object.isFrozen(list));
  for (const code of ['e2e-version-unknown', 'e2e-manifest-invalid', 'e2e-label-invalid', 'e2e-label-origin-mismatch', 'e2e-real-requires-live',
    'e2e-synthetic-promotion', 'e2e-provenance-missing', 'e2e-provenance-unbound', 'e2e-file-missing', 'e2e-file-unsafe', 'e2e-file-too-large',
    'e2e-file-hash-mismatch', 'e2e-record-invalid', 'e2e-sanitization-field', 'e2e-sanitization-secret', 'e2e-sanitization-path',
    'e2e-sanitization-identity', 'e2e-expect-mismatch']) assert(REASON_CODES.includes(code), code);
  assert.equal(new Set(REASON_CODES).size, REASON_CODES.length);
  assert.throws(() => { REASON_CODES.push('e2e-anything'); });
  pass('exports frozen closed vocabulary e2e-evidence-v1 / ' + ALLOWLIST_VERSION);

  // ── Mock fixture on disk ───────────────────────────────────────────────────
  const mock = verifyEvidence(FIXTURE, { expect: 'mock' });
  assert.equal(mock.ok, true, mock.reason_code);
  assert.deepEqual([mock.label, mock.origin, mock.execution_mode, mock.reason_code], ['mock', 'synthetic', 'synthetic', null]);
  assert.deepEqual(mock.files, [{ path: 'recording.jsonl', sha256: before['recording.jsonl'], bytes: fs.statSync(path.join(FIXTURE, 'recording.jsonl')).size, records: 19 }]);
  const mockRecords = readRecords(FIXTURE);
  assert(scanRecords(mockRecords).ok, 'the mock fixture itself passes the scan');
  assert(mockRecords.every(r => r.origin === 'synthetic'));
  assert.deepEqual([...new Set(mockRecords.map(r => r.channel))], ['host', 'worker', 'attempt']);
  assert.deepEqual(mockRecords.filter(r => r.channel === 'host').map(r => r.kind), ['init', 'tool_use', 'tool_result', 'result']);
  assert.deepEqual(mockRecords.filter(r => r.channel === 'worker' && r.direction === 'client').map(r => r.method), ['initialize', 'thread/start', 'turn/start']);
  for (const method of ['item/completed', 'turn/completed']) assert(mockRecords.some(r => r.method === method), method);
  assert(mockRecords.some(r => r.phase === 'started') && mockRecords.some(r => r.phase === 'ready') && mockRecords.some(r => r.kind === 'custody'));
  assert(mockRecords.filter(r => r.claude_code_version || r.server_version || r.client_version).every(r => /^mock-/.test(r.claude_code_version || r.server_version || r.client_version)));
  const mockManifest = readManifest(FIXTURE);
  assert.notEqual(mockManifest.provenance.versions.worker, mockManifest.provenance.versions.appserver_schema_pin.codex_version, 'worker version and schema pin version are distinct facts');
  const readme = fs.readFileSync(path.join(FIXTURE, 'README.md'), 'utf8');
  for (const term of ['mock', 'synthetic', before['manifest.json'], before['recording.jsonl'], ALLOWLIST_VERSION, ...REASON_CODES]) assert(readme.includes(term), `README documents ${term}`);
  pass('mock fixture verifies as mock/synthetic/synthetic; README documents label, hashes and codes');

  // ── CLI positive and negatives (executed, not only described) ──────────────
  let run = cli('--verify', FIXTURE, '--expect', 'mock');
  assert.equal(run.status, 0); assert.deepEqual([run.out.ok, run.out.label, run.out.reason_code], [true, 'mock', null]);
  run = cli('--expect', 'mock', '--verify', FIXTURE); assert.equal(run.status, 0, 'pair order is free');
  run = cli('--verify', FIXTURE); assert.equal(run.status, 0);
  run = cli('--verify', FIXTURE, '--expect', 'recorded'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-expect-mismatch'); covered.add('e2e-expect-mismatch');
  run = cli('--verify', FIXTURE, '--expect', 'real'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-expect-mismatch');
  for (const args of [[], ['--verify'], ['--verify', FIXTURE, '--verify', FIXTURE], ['--verify', FIXTURE, '--expect', 'gold'], ['--unknown', 'x'], ['--verify', FIXTURE, '--expect']]) {
    run = cli(...args); assert.equal(run.status, args.includes('gold') ? 1 : 2, JSON.stringify(args)); assert.equal(run.out.reason_code, 'e2e-arguments-invalid');
  }
  covered.add('e2e-arguments-invalid');
  pass('CLI --verify mock exit 0; --expect mismatch exit 1; malformed arguments refused');
  refused(verifyEvidence(FIXTURE, { expect: 'recorded' }), 'e2e-expect-mismatch', 'mock verified with --expect recorded');

  // ── Relabel / promotion negatives on temporary copies ──────────────────────
  for (const label of ['recorded', 'real']) {
    const dir = mutate(copyFixture(), null, m => { m.label = label; });
    refused(verifyEvidence(dir), 'e2e-label-origin-mismatch', `manifest-only relabel to ${label}`);
    run = cli('--verify', dir, '--expect', label); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-label-origin-mismatch');
  }
  const promoted = mutate(copyFixture(), records => records.forEach(r => { r.origin = 'captured'; }), m => Object.assign(m, { label: 'recorded', origin: 'captured', execution_mode: 'replay' }));
  refused(verifyEvidence(promoted), 'e2e-synthetic-promotion', 'manifest and record origins relabeled recorded, synthetic bytes kept');
  run = cli('--verify', promoted, '--expect', 'recorded'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-synthetic-promotion');
  const deMocked = mutate(copyFixture(), records => records.forEach(r => { r.origin = 'captured'; }), m => {
    Object.assign(m, { label: 'recorded', origin: 'captured', execution_mode: 'replay' });
    Object.assign(m.provenance, { captured_at: '2026-11-22T10:00:00.000Z', method: 'controlled-capture' });
    Object.assign(m.provenance.versions, { host: 'claude-2.0.0', worker: 'codex-0.170.0' }); m.provenance.versions.forge.revision = 'a'.repeat(40);
  });
  refused(verifyEvidence(deMocked), 'e2e-synthetic-promotion', 'provenance de-mocked but recorded bytes keep synthetic versions');
  const keptOrigin = mutate(copyFixture(), null, m => {
    Object.assign(m, { label: 'recorded', origin: 'captured', execution_mode: 'replay' });
    Object.assign(m.provenance, { captured_at: '2026-11-22T10:00:00.000Z', method: 'controlled-capture' });
    Object.assign(m.provenance.versions, { host: 'claude-2.0.0', worker: 'codex-0.170.0' }); m.provenance.versions.forge.revision = 'a'.repeat(40);
  });
  refused(verifyEvidence(keptOrigin), 'e2e-label-origin-mismatch', 'record origin synthetic under a captured manifest');
  const toReal = mutate(copyFixture(), records => records.forEach(r => { r.origin = 'captured'; }), m => Object.assign(m, { label: 'real', origin: 'captured', execution_mode: 'live' }));
  refused(verifyEvidence(toReal), 'e2e-real-requires-live', 'mock promoted to real offline');
  run = cli('--verify', toReal, '--expect', 'real'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-real-requires-live');
  const tampered = copyFixture();
  fs.writeFileSync(path.join(tampered, 'recording.jsonl'), fs.readFileSync(path.join(tampered, 'recording.jsonl'), 'utf8').replace('mock final answer', 'mock final answeR'));
  refused(verifyEvidence(tampered), 'e2e-file-hash-mismatch', 'one recording byte altered');
  run = cli('--verify', tampered, '--expect', 'mock'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-file-hash-mismatch');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.files[0].bytes += 1; })), 'e2e-file-hash-mismatch', 'manifest byte count diverges');

  // ── Manifest structure, version and provenance ─────────────────────────────
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.evidence_version = 'e2e-evidence-v0'; })), 'e2e-version-unknown', 'unknown evidence_version');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.sanitizer.allowlist_version = 'e2e-allowlist-v0'; })), 'e2e-version-unknown', 'unknown allowlist version');
  const notJson = copyFixture(); fs.writeFileSync(path.join(notJson, 'manifest.json'), '{"evidence_version":');
  refused(verifyEvidence(notJson), 'e2e-manifest-invalid', 'manifest is not JSON');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.authority = 'granted'; })), 'e2e-manifest-invalid', 'imported authority field');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.limits.max_line_bytes = 1 << 30; })), 'e2e-manifest-invalid', 'manifest raises its own limits');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.label = 'verified'; })), 'e2e-label-invalid', 'unknown label');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.execution_mode = 'replayed'; })), 'e2e-label-invalid', 'unknown execution mode');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { delete m.provenance.attempt; })), 'e2e-provenance-missing', 'attempt provenance missing');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { delete m.route.transport; })), 'e2e-provenance-missing', 'route transport missing');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.appserver_schema_pin.sha256 = undefined; })), 'e2e-provenance-missing', 'schema pin hash missing');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.host = 'mock-claude-code-9.9.9'; })), 'e2e-provenance-unbound', 'host version differs from recorded init');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.worker = 'mock-codex-9.9.9'; })), 'e2e-provenance-unbound', 'worker version differs from recorded initialize');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.appserver_schema_pin.sha256 = 'f'.repeat(64); })), 'e2e-provenance-unbound', 'schema pin hash is no current or historical pin');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.appserver_schema_pin.codex_version = '0.170.0'; })), 'e2e-provenance-unbound', 'schema pin relabeled with another version');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.attempt.dispatch_sha256 = 'e'.repeat(64); })), 'e2e-provenance-unbound', 'attempt hash differs from attempt channel');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.counts.worker += 1; })), 'e2e-provenance-unbound', 'channel count differs');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.files[0].records -= 1; })), 'e2e-provenance-unbound', 'record count differs');
  const historical = fs.readdirSync(path.join(__dirname, 'fixtures', 'schema-pin')).filter(n => n.endsWith('.json')).sort()[0];
  const historicalBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-pin', historical));
  const historicalOk = verifyEvidence(mutate(copyFixture(), null, m => { m.provenance.versions.appserver_schema_pin = {
    path: `scripts/fixtures/schema-pin/${historical}`, sha256: sha(historicalBytes), codex_version: JSON.parse(historicalBytes).meta.codex_version }; }));
  assert.equal(historicalOk.ok, true, historicalOk.reason_code);
  pass('historical schema pin accepted only with its own path, sha256 and codex_version');

  // ── Files: missing, unsafe, links, case, size ──────────────────────────────
  const missing = copyFixture(); fs.rmSync(path.join(missing, 'recording.jsonl'));
  refused(verifyEvidence(missing), 'e2e-file-missing', 'listed recording missing');
  refused(verifyEvidence(path.join(temp, 'absent-dir')), 'e2e-file-missing', 'evidence directory missing');
  const noManifest = copyFixture(); fs.rmSync(path.join(noManifest, 'manifest.json'));
  refused(verifyEvidence(noManifest), 'e2e-file-missing', 'manifest missing');
  for (const bad of ['../recording.jsonl', 'sub/recording.jsonl', '..\\recording.jsonl', 'recording.json', '.hidden.jsonl']) {
    refused(verifyEvidence(mutate(copyFixture(), null, m => { m.files[0].path = bad; })), 'e2e-file-unsafe', `escape or unsafe path ${JSON.stringify(bad)}`);
  }
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.files[0].path = 'Recording.jsonl'; })), 'e2e-file-unsafe', 'manifest path differs from disk only by case');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.files.push({ ...m.files[0], path: 'RECORDING.jsonl' }); })), 'e2e-file-unsafe', 'manifest lists a case collision');
  const hard = copyFixture();
  try {
    fs.linkSync(path.join(hard, 'recording.jsonl'), path.join(hard, 'alias.jsonl'));
    refused(verifyEvidence(hard), 'e2e-file-unsafe', 'hard link (nlink 2)');
  } catch (error) { if (error.code && /^E/.test(error.code)) console.log(`SKIP hard link: ${error.code}`); else throw error; }
  const symlinkDir = copyFixture();
  try {
    fs.renameSync(path.join(symlinkDir, 'recording.jsonl'), path.join(temp, `outside-${serial}.jsonl`));
    fs.symlinkSync(path.join(temp, `outside-${serial}.jsonl`), path.join(symlinkDir, 'recording.jsonl'), 'file');
    refused(verifyEvidence(symlinkDir), 'e2e-file-unsafe', 'recording is a symbolic link outside the directory');
  } catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) console.log(`SKIP file symlink: ${error.code} (platform requires privilege)`); else throw error; }
  const junctionTarget = copyFixture(), junction = path.join(temp, 'junction-dir');
  try {
    fs.symlinkSync(junctionTarget, junction, 'junction');
    refused(verifyEvidence(junction), 'e2e-file-unsafe', 'evidence directory is a junction/link');
  } catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) console.log(`SKIP junction: ${error.code}`); else throw error; }
  const caseDir = copyFixture();
  fs.writeFileSync(path.join(caseDir, 'RECORDING.jsonl'), 'x\n');
  if (fs.readdirSync(caseDir).length === 3) refused(verifyEvidence(caseDir), 'e2e-file-unsafe', 'on-disk case collision');
  else console.log('SKIP on-disk case collision: case-insensitive filesystem cannot hold both names (manifest-level collision covered)');
  refused(verifyEvidence(copyFixture(), { limits: { max_line_bytes: 200 } }), 'e2e-file-too-large', 'line above the bounded line limit');
  refused(verifyEvidence(copyFixture(), { limits: { max_file_bytes: 1000 } }), 'e2e-file-too-large', 'file above the bounded file limit');
  refused(verifyEvidence(copyFixture(), { limits: { max_records: 5 } }), 'e2e-file-too-large', 'record count above the bound');
  assert.equal(verifyEvidence(FIXTURE, { limits: { max_line_bytes: 1 << 30 } }).ok, true, 'caller limits can only lower the module bounds');

  // ── Records: canonical form, allowlist, scan ───────────────────────────────
  const nonCanonical = copyFixture();
  writeRecording(nonCanonical, fs.readFileSync(path.join(nonCanonical, 'recording.jsonl'), 'utf8').replace('{"channel":"host","claude', '{ "channel":"host","claude'));
  refused(verifyEvidence(nonCanonical), 'e2e-record-invalid', 'non-canonical JSON line');
  const crlf = copyFixture(); writeRecording(crlf, fs.readFileSync(path.join(crlf, 'recording.jsonl'), 'utf8').replace(/\n/g, '\r\n'));
  refused(verifyEvidence(crlf), 'e2e-record-invalid', 'CRLF recording');
  refused(verifyEvidence(mutate(copyFixture(), records => { records[3].seq = 7; })), 'e2e-record-invalid', 'sequence gap');
  refused(verifyEvidence(mutate(copyFixture(), records => { records[0].kind = 'banner'; })), 'e2e-record-invalid', 'unknown record kind');
  refused(verifyEvidence(mutate(copyFixture(), records => { records[0].cwd = 'workspace'; })), 'e2e-sanitization-field', 'field outside the allowlist');
  refused(verifyEvidence(mutate(copyFixture(), records => { records[12].text = 'progress narration'; })), 'e2e-sanitization-field', 'free text outside the final answer');
  const finalIndex = mockRecords.findIndex(r => r.text);
  const withText = text => mutate(copyFixture(), records => { records[finalIndex].text = text; });
  const secretResult = verifyEvidence(withText(`leaked ${FAKE_KEY}`));
  refused(secretResult, 'e2e-sanitization-secret', 'secret in final answer');
  assert(!JSON.stringify(secretResult).includes('SYNTHETICFAKE'), 'diagnostics never carry content');
  refused(verifyEvidence(withText('see C:/Users/structural-user/notes')), 'e2e-sanitization-path', 'personal path in final answer');
  refused(verifyEvidence(withText(`mail ${FAKE_MAIL}`)), 'e2e-sanitization-email', 'e-mail in final answer');
  refused(verifyEvidence(withText(`session ${FAKE_UUID}`)), 'e2e-sanitization-identity', 'raw session UUID in final answer');
  refused(verifyEvidence(mutate(copyFixture(), null, m => { m.route.worker_mode = 'sidecar'; m.provenance.tools[0].name = `tool-${FAKE_UUID}`; })), 'e2e-sanitization-identity', 'raw identity inside the manifest');
  const base = mockRecords[finalIndex];
  for (const [code, text] of [
    ['e2e-sanitization-secret', FAKE_KEY], ['e2e-sanitization-secret', 'Bearer ' + 'SYNTHETICbearer0001'],
    ['e2e-sanitization-secret', 'eyJ' + 'hbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'], ['e2e-sanitization-secret', 'api_key=' + 'SYNTHETIC0001'],
    ['e2e-sanitization-secret', '"authorization": "' + 'SYNTHETIC0001"'], ['e2e-sanitization-secret', 'token: ' + 'SYNTHETIC0001'],
    ['e2e-sanitization-path', 'C:\\Users\\structural-user\\x'], ['e2e-sanitization-path', 'c:/users/structural-user'],
    ['e2e-sanitization-path', 'C:\\\\Users\\\\structural-user'], ['e2e-sanitization-path', 'at /home/structural-user/x'], ['e2e-sanitization-path', 'at /Users/structural-user/x'],
    ['e2e-sanitization-email', FAKE_MAIL], ['e2e-sanitization-identity', FAKE_UUID.toUpperCase()],
  ]) {
    const result = scanRecords([{ ...base, seq: 0, text }]);
    assert(!result.ok && result.violations.some(v => v.code === code), `${code} for ${text.slice(0, 12)}`);
    assert(result.violations.every(v => REASON_CODES.includes(v.code) && (v.field === null || typeof v.field === 'string')));
  }
  assert(scanRecords([{ ...base, seq: 0, text: 'placeholders <LAB>/x and <USER_PATH> stay clean' }]).ok);
  pass('scanRecords refuses secret/path/e-mail/identity patterns and accepts placeholders');

  // ── sanitizeCapture: clean, counted and deterministic ──────────────────────
  const raw = structuralRaw('a'), rawCopy = JSON.stringify(raw);
  const first = sanitizeCapture(raw), second = sanitizeCapture(structuralRaw('a'));
  assert.equal(JSON.stringify(raw), rawCopy, 'raw input is not mutated');
  const firstBytes = serializeRecords(first.records);
  assert.equal(firstBytes, serializeRecords(second.records), 'same input, same bytes');
  assert.deepEqual([first.counts, first.transform], [second.counts, second.transform]);
  assert(scanRecords(first.records).ok, JSON.stringify(scanRecords(first.records).violations));
  for (const leaked of ['structural-user', 'Users', 'SYNTHETICFAKE', FAKE_UUID, 'example.com', 'private', 'thr_structural', 'toolu_structural', 'item_final', 'msg_structural'])
    assert(!firstBytes.includes(leaked), `sanitized recording leaks ${leaked}`);
  assert(!Object.hasOwn(first.records.find(r => r.kind === 'custody'), 'pid'), 'a PID is never retained as evidence');
  for (const kept of ['<LAB>', '<FORGE_SOURCE>', '<REDACTED>', '<EMAIL>', '<ID-', '<USER_PATH>', 'scripts\\\\forge-unit-sidecar.js --request <LAB>']) assert(firstBytes.includes(kept), `sanitized recording keeps ${kept}`);
  assert.deepEqual(first.counts.input, { host: 6, worker: 10, attempt: 6 });
  assert.deepEqual(first.counts.records, { host: 5, worker: 9, attempt: 5 });
  assert.equal(first.counts.unparsed_lines, 1);
  assert(first.counts.dropped_lines >= 3, 'stream_event, invalid direction and unknown attempt kind are counted');
  assert(first.counts.dropped_fields >= 10, `dropped fields counted (${first.counts.dropped_fields})`);
  assert(first.counts.hashed_texts >= 3);
  for (const key of ['path', 'secret', 'email', 'identity']) assert(first.counts.redacted[key] >= 1, `redacted ${key}`);
  assert.deepEqual(first.transform.placeholder_tokens, ['<FORGE_SOURCE>', '<LAB>']);
  assert.equal(first.transform.allowlist_version, ALLOWLIST_VERSION);
  assert(first.records.every(r => r.origin === 'captured') && sanitizeCapture(raw, { origin: 'synthetic' }).records.every(r => r.origin === 'synthetic'));
  const init = first.records.find(r => r.kind === 'init');
  assert.deepEqual(init.tools, ['Bash', 'Read']); assert.equal(init.claude_code_version, 'test-structural-2.0.0');
  const ua = first.records.find(r => r.kind === 'response' && r.rpc_id === 0);
  assert.equal(ua.user_agent_product, 'codex_cli_rs/test-structural-0.170.0'); assert.match(ua.user_agent_sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.records.find(r => r.method === 'turn/start').input_bytes > 0, true);
  assert.equal(first.records.filter(r => Object.hasOwn(r, 'text')).length, 1, 'only the final answer keeps text');
  assert.throws(() => sanitizeCapture({ host: [], worker: [] }), /e2e-record-invalid/);
  assert.throws(() => sanitizeCapture({ host: [], worker: [], attempt: [], placeholders: { 'C:\\x': 'lowercase' } }), /e2e-record-invalid/);
  pass('sanitizeCapture removes secrets, paths, e-mail and IDs deterministically and counts every discard');

  // ── STRUCTURAL recorded (temp only) and live-only real ─────────────────────
  const recordedDir = writeStructural(path.join(temp, 'structural-recorded'), structuralRaw('a'));
  const recorded = verifyEvidence(recordedDir, { expect: 'recorded' });
  assert.equal(recorded.ok, true, recorded.reason_code);
  assert.deepEqual([recorded.label, recorded.origin, recorded.execution_mode, recorded.live_bound], ['recorded', 'captured', 'replay', false]);
  run = cli('--verify', recordedDir, '--expect', 'recorded'); assert.equal(run.status, 0); assert.equal(run.out.label, 'recorded');
  refused(verifyEvidence(mutate(writeStructural(path.join(temp, 'structural-worker'), structuralRaw('a')), null, m => { m.provenance.versions.worker = pinVersion; })),
    'e2e-provenance-unbound', 'observed worker version relabeled as the schema anchor version');
  refused(verifyEvidence(writeStructural(path.join(temp, 'structural-mode'), structuralRaw('a'), { mode: 'live' })), 'e2e-label-origin-mismatch', 'recorded with live execution mode');
  pass('STRUCTURAL recorded temp evidence (not a recording) verifies through the real sanitizer');

  // Exercise the real canonical lease producer; these evidence inputs remain structural.
  const lease = require('./forge-unit-lease'), leaseRoot = path.join(temp, 'canonical-lease');
  fs.mkdirSync(leaseRoot);
  const acquired = lease.acquire(leaseRoot, 'capture-test/T01', { ownerToken: 'synthetic-owner', requestId: 'synthetic-request' });
  assert(acquired.ok, acquired.reason);
  const generation = acquired.generation;
  assert.match(generation, /^[a-f0-9]{32}$/);
  const generationRaw = structuralRaw('canonical-generation');
  generationRaw.attempt.find(x => x.kind === 'identity').value.lease_generation = generation;
  const generationRecords = sanitizeCapture(generationRaw).records;
  assert.equal(generationRecords.find(x => x.kind === 'identity').lease_generation, generation);
  assert(scanRecords(generationRecords).ok);
  const generationDir = writeStructural(path.join(temp, 'canonical-generation-recorded'), generationRaw);
  assert(verifyEvidence(generationDir, { expect: 'recorded' }).ok);
  const generationReal = writeStructural(path.join(temp, 'canonical-generation-live'), generationRaw, { label: 'real', mode: 'live' });
  assert(verifyEvidence(generationReal, { expect: 'real', live: createLiveObservation(generationRaw) }).ok);
  assert.equal(sanitizeCapture(structuralRaw('legacy-generation')).records.find(x => x.kind === 'identity').lease_generation, 3);
  for (const invalidGeneration of [null, {}, [], true, false, -1, 1.5, 'not-a-generation', 'a'.repeat(31), crypto.randomUUID()]) {
    const invalidRaw = structuralRaw('invalid-generation');
    invalidRaw.attempt.find(x => x.kind === 'identity').value.lease_generation = invalidGeneration;
    const invalidRecords = sanitizeCapture(invalidRaw).records;
    assert(!Object.hasOwn(invalidRecords.find(x => x.kind === 'identity'), 'lease_generation'));
    assert.equal(scanRecords(invalidRecords).ok, false);
  }
  refused(verifyEvidence(mutate(writeStructural(path.join(temp, 'canonical-generation-mismatch'), generationRaw), null,
    m => { m.provenance.attempt.lease_generation = generation === 'b'.repeat(32) ? 'a'.repeat(32) : 'b'.repeat(32); })),
    'e2e-provenance-unbound', 'canonical lease generation differs between manifest and captured record');
  assert(lease.release(leaseRoot, 'capture-test/T01', 'synthetic-owner', generation).ok);
  pass('canonical hex32 lease generation preserved; legacy counter supported; invalid generations refused');

  const realDir = writeStructural(path.join(temp, 'structural-real'), structuralRaw('a'), { label: 'real', mode: 'live' });
  refused(verifyEvidence(realDir), 'e2e-real-requires-live', 'real refused offline');
  run = cli('--verify', realDir, '--expect', 'real'); assert.equal(run.status, 1); assert.equal(run.out.reason_code, 'e2e-real-requires-live');
  refused(verifyEvidence(realDir, { live: Object.freeze({ kind: 'e2e-live-observation' }) }), 'e2e-real-requires-live', 'forged look-alike handle');
  refused(verifyEvidence(realDir, { live: JSON.parse(JSON.stringify({ kind: 'e2e-live-observation', pid: process.pid })) }), 'e2e-real-requires-live', 'imported JSON handle with PID');
  refused(verifyEvidence(realDir, { live: createLiveObservation(structuralRaw('b')) }), 'e2e-real-requires-live', 'live handle from a different capture');
  const handle = createLiveObservation(structuralRaw('a'));
  assert(Object.isFrozen(handle)); assert.deepEqual(Object.keys(handle), ['kind']);
  const real = verifyEvidence(realDir, { live: handle, expect: 'real' });
  assert.equal(real.ok, true, real.reason_code); assert.deepEqual([real.label, real.live_bound], ['real', true]);
  const alteredReal = mutate(writeStructural(path.join(temp, 'structural-real-altered'), structuralRaw('a'), { label: 'real', mode: 'live' }),
    records => { records[records.length - 1].phase = 'altered'; });
  refused(verifyEvidence(alteredReal, { live: handle }), 'e2e-real-requires-live', 'live handle does not cover altered content');
  const replayed = verifyEvidence(recordedDir, { live: handle });
  assert.equal(replayed.label, 'recorded', 'a live handle never promotes recorded replay');
  refused(verifyEvidence(recordedDir, { live: handle, expect: 'real' }), 'e2e-expect-mismatch', 'recorded replay expected as real');
  assert.throws(() => createLiveObservation(structuralRaw('m', { host: 'mock-claude-code-0.0.0', worker: 'mock-codex-0.0.0' })), /e2e-synthetic-promotion/);
  covered.add('e2e-synthetic-promotion');
  pass('real accepted only with the same-process live handle bound to the same capture');

  // ── Coverage and byte preservation ─────────────────────────────────────────
  assert.deepEqual(REASON_CODES.filter(code => !covered.has(code)), [], 'one named case per REASON_CODE');
  assert.deepEqual(fixtureBytes(), before, 'fixture bytes unchanged by the suite');
  console.log(`PASS forge-e2e-evidence: ${REASON_CODES.length}/${REASON_CODES.length} reason codes exercised; synthetic mock never promoted; real offline refused`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
