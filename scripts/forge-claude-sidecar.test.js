#!/usr/bin/env node
// forge-claude-sidecar.test.js â€” private-process and credential-boundary tests.
//
// Every account and provider process in this file is a fixture. The adapter is
// loaded with a stubbed forge-accounts export before each scenario, so neither
// the host registry nor Keychain/file-backed token stores are ever consulted.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ADAPTER_PATH = require.resolve('./forge-claude-sidecar');
const ACCOUNTS_PATH = require.resolve('./forge-accounts');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-sidecar-test-')));
const WORKSPACE = path.join(ROOT, 'workspace with spaces Î©');
const MISSING_REGISTRY = path.join(ROOT, 'registry-does-not-exist.json');
const PREVIOUS_REGISTRY = process.env.FORGE_ACCOUNTS_REGISTRY;
process.env.FORGE_ACCOUNTS_REGISTRY = MISSING_REGISTRY;
fs.mkdirSync(WORKSPACE, { recursive: true });

const accounts = require(ACCOUNTS_PATH);
const TOKEN_ENV = accounts.TOKEN_ENV;
const REAL_SPAWN = childProcess.spawn;
const REAL_RM_SYNC = fs.rmSync;
const FIXTURE_TOKEN = 'fixture-claude-token-never-print';
const FIXTURE_ACCOUNT = Object.freeze({ name: 'fixture-default', token: FIXTURE_TOKEN });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

function writeFixture(name, source) {
  const file = path.join(WORKSPACE, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function resultBlock(status, payload) {
  return [
    '---GSD-WORKER-RESULT---',
    `status: ${status}`,
    `result_json: ${JSON.stringify(payload)}`,
    '---END-RESULT---',
    '',
  ].join('\n');
}

// Every fixture answers like `claude -p --output-format json`: one result
// object whose modelUsage names the received --model. The 401/403 counters are
// deliberate: inside a JSON success they are data, never an auth failure.
const ENVELOPE_PRELUDE = `
function requestedModel() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--model');
  return index >= 0 ? argv[index + 1] : 'fixture-model-absent';
}
function structured(text) {try {const marker=text.lastIndexOf('result_json: ');return JSON.parse(text.slice(marker+13,text.indexOf('---END-RESULT---',marker)).trim());}catch{return undefined;}}
function envelope(text) {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, structured_output:structured(text),
    usage: { input_tokens: 401, output_tokens: 403 },
    modelUsage: { [requestedModel()]: { inputTokens: 401, outputTokens: 403 } } });
}
`;
const FIXTURE_MODEL = 'claude-fixture-model';

const HAPPY_FIXTURE = writeFixture('claude happy fixture.js', `
'use strict';
const fs = require('fs');
const crypto = require('crypto');
${ENVELOPE_PRELUDE}
const tokenKey = ${JSON.stringify(TOKEN_ENV)};
const expectedToken = ${JSON.stringify(FIXTURE_TOKEN)};
const args = process.argv.slice(2);
const instruction = args[args.indexOf('-p') + 1] || '';
const prefix = 'Read the complete task prompt from this UTF-8 file: ';
const suffix = '. Follow it exactly and return the required structured_output JSON.';
const promptPath = JSON.parse(instruction.slice(prefix.length, instruction.length - suffix.length));
const prompt = fs.readFileSync(promptPath, 'utf8');
const tokenSafe = process.env[tokenKey] === expectedToken
  && !args.some((arg) => String(arg).includes(expectedToken));
const digest = crypto.createHash('sha256').update(prompt).digest('hex');
function block(status, payload) {
  return ['---GSD-WORKER-RESULT---', 'status: ' + status,
    'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n');
}
process.stdout.write(envelope(block('blocked', {
  status: 'blocked', summary: 'decoy', must_haves_status: [], files_changed: []
}) + block('done', {
  status: 'done', summary: (tokenSafe ? 'prompt-sha256:' : 'fixture-boundary-failed:') + digest,
  must_haves_status: [{ item: 'fixture', status: 'met', note: 'observed', scope: 'task', reason: '' }],
  files_changed: ['fixture-output.txt']
})));
`);

const NONZERO_FIXTURE = writeFixture('claude nonzero fixture.js', `
'use strict';
const tokenKey = ${JSON.stringify(TOKEN_ENV)};
process.stdout.write(process.env[tokenKey] || '');
process.stderr.write(process.env[tokenKey] || '');
process.exit(7);
`);

const EMPTY_FIXTURE = writeFixture('claude empty fixture.js', `
'use strict';
process.stdout.write('  \\n\\t');
`);

const INVALID_FIXTURE = writeFixture('claude invalid fixture.js', `
'use strict';
${ENVELOPE_PRELUDE}
const payload = { status: 'partial', summary: 'mismatch', must_haves_status: [], files_changed: [] };
payload.status='complete';
process.stdout.write(envelope(['---GSD-WORKER-RESULT---', 'status: done',
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n')));
`);

const ABSENT_FIXTURE = writeFixture('claude absent fixture.js', `
'use strict';
${ENVELOPE_PRELUDE}
process.stdout.write(envelope('ordinary prose without a worker result'));
`);

const TIMEOUT_FIXTURE = writeFixture('claude timeout fixture.js', `
'use strict';
${ENVELOPE_PRELUDE}
const payload = { status: 'done', summary: 'must be discarded', must_haves_status: [], files_changed: [] };
process.stdout.write(envelope(['---GSD-WORKER-RESULT---', 'status: done',
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n')));
setInterval(() => {}, 1000);
`);

// Stays alive well past several heartbeat intervals before answering, so a
// single beat at spawn is distinguishable from a real cadence.
const SLOW_FIXTURE = writeFixture('claude slow fixture.js', `
'use strict';
${ENVELOPE_PRELUDE}
const payload = { status: 'done', summary: 'slow but healthy',
  must_haves_status: [], files_changed: [] };
setTimeout(() => {
  process.stdout.write(envelope(['---GSD-WORKER-RESULT---', 'status: done',
    'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n')));
}, 400);
`);

// Scenario-driven fixture for the identity/envelope/auth/secret matrices. The
// control file decides the exact stdout; the token value never enters it
// except where a scenario deliberately plants it.
const CONTROL_FILE = path.join(WORKSPACE, 'claude-control.json');
const CONTROL_FIXTURE = writeFixture('claude control fixture.js', `
'use strict';
const fs = require('fs');
${ENVELOPE_PRELUDE}
const control = JSON.parse(fs.readFileSync(${JSON.stringify(CONTROL_FILE)}, 'utf8'));
if (typeof control.raw === 'string') process.stdout.write(control.raw);
else {
  const value = { type: 'result', subtype: 'success', is_error: false, result: control.result, structured_output: structured(control.result),
    usage: { input_tokens: 401, output_tokens: 403 },
    modelUsage: { [requestedModel()]: { inputTokens: 401, outputTokens: 403 } }, ...(control.overrides || {}) };
  for (const key of control.remove || []) delete value[key];
  process.stdout.write(JSON.stringify(value));
}
if (control.stderr) process.stderr.write(control.stderr);
if (control.hang) setInterval(() => {}, 1000);
else if (control.exit) process.exitCode = control.exit;
`);

function loadAdapter({ resolver, spawnImpl } = {}) {
  const originalResolver = accounts.resolveLaunch;
  const originalSpawn = childProcess.spawn;
  accounts.resolveLaunch = resolver || (() => FIXTURE_ACCOUNT);
  childProcess.spawn = spawnImpl || REAL_SPAWN;
  delete require.cache[ADAPTER_PATH];
  try {
    return require(ADAPTER_PATH);
  } finally {
    accounts.resolveLaunch = originalResolver;
    childProcess.spawn = originalSpawn;
  }
}

function sourceEnvFor(fixture) {
  return {
    ...process.env,
    FORGE_XLLM_CLAUDE_BIN: fixture,
    [TOKEN_ENV]: 'ambient-token-must-not-win',
    ANTHROPIC_API_KEY: 'ambient-anthropic-key',
    OPENAI_API_KEY: 'ambient-openai-key',
    GEMINI_API_KEY: 'ambient-gemini-key',
    SERVICE_PASSWORD: 'ambient-password',
    FORGE_ACCOUNT: 'ambient-account',
  };
}

function recordingSpawn(records) {
  return (cmd, args, options) => {
    records.push({ cmd, args: args.slice(), options: { ...options, env: { ...options.env } } });
    return REAL_SPAWN(cmd, args, options);
  };
}

function tempPromptDirs() {
  return fs.readdirSync(WORKSPACE).filter((name) => name.startsWith('.forge-claude-sidecar-'));
}

async function expectCode(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  ok(caught, `expected rejection ${code}`);
  assert.strictEqual(caught.code, code);
  return caught;
}

test('reason codes are frozen and expose every named failure contract', () => {
  const adapter = loadAdapter();
  const codes = adapter.CLAUDE_SIDECAR_REASON_CODES;
  ok(Object.isFrozen(codes), 'reason-code object must be frozen');
  assert.deepStrictEqual([
    codes.ACCOUNT_UNAVAILABLE, codes.COMMAND_NOT_FOUND, codes.EXIT_NONZERO,
    codes.TIMEOUT, codes.EMPTY_OUTPUT, codes.INVALID_RESULT,
  ], [
    'claude-account-unavailable', 'claude-command-not-found', 'claude-exit-nonzero',
    'claude-timeout', 'claude-empty-output', 'claude-invalid-result',
  ]);
});

test('Claude env is allowlist-built and replaces every ambient credential', () => {
  const adapter = loadAdapter();
  const source = sourceEnvFor(HAPPY_FIXTURE);
  source.PATH = 'fixture-path';
  source.HOME = 'fixture-home';
  source.SystemRoot = 'fixture-system-root';
  const env = adapter.buildClaudeSidecarEnv(FIXTURE_ACCOUNT, source, 'win32');
  assert.strictEqual(env.PATH, 'fixture-path');
  assert.strictEqual(env.HOME, 'fixture-home');
  assert.strictEqual(env.SystemRoot, 'fixture-system-root');
  assert.strictEqual(env.FORGE_ACCOUNT, FIXTURE_ACCOUNT.name);
  assert.strictEqual(env[TOKEN_ENV], FIXTURE_TOKEN);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'SERVICE_PASSWORD', 'FORGE_XLLM_CLAUDE_BIN']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(env, key), false, `${key} was inherited`);
  }
  ok(!/\.\.\.process\.env/.test(adapter.buildClaudeSidecarEnv.toString()), 'env builder must not clone process.env');
});

test('command override treats a JavaScript fixture as one Node argv entry', () => {
  const adapter = loadAdapter();
  assert.deepStrictEqual(adapter.resolveClaudeCommand({ FORGE_XLLM_CLAUDE_BIN: HAPPY_FIXTURE }), {
    cmd: process.execPath, prefixArgs: [HAPPY_FIXTURE],
  });
  const smuggled = `${HAPPY_FIXTURE} --extra-argument`;
  assert.deepStrictEqual(adapter.resolveClaudeCommand({ FORGE_XLLM_CLAUDE_BIN: smuggled }), {
    cmd: smuggled, prefixArgs: [],
  });
});

test('child deadline is strictly below its parent by the fixed grace window', () => {
  const adapter = loadAdapter();
  const parent = adapter.TIMEOUT_GRACE_MS + 1234;
  assert.strictEqual(adapter.deriveChildTimeoutMs(parent), 1234);
  assert.throws(() => adapter.deriveChildTimeoutMs(adapter.TIMEOUT_GRACE_MS),
    (error) => error.code === adapter.CLAUDE_SIDECAR_REASON_CODES.TIMEOUT);
});

test('missing default account rejects before prompt creation or spawn', async () => {
  const calls = [];
  let spawnCalls = 0;
  const adapter = loadAdapter({
    resolver: (...args) => { calls.push(args); return null; },
    spawnImpl: () => { spawnCalls++; throw new Error('spawn must not run'); },
  });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'unused', timeoutMs: 10000, sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.ACCOUNT_UNAVAILABLE);
  assert.deepStrictEqual(calls, [[null]]);
  assert.strictEqual(spawnCalls, 0);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('happy path uses file transport, child-only token env, and structured output', async () => {
  const calls = [];
  const records = [];
  const adapter = loadAdapter({
    resolver: (...args) => { calls.push(args); return FIXTURE_ACCOUNT; },
    spawnImpl: recordingSpawn(records),
  });
  const prompt = `large-prompt-sentinel:${'abc123\n'.repeat(12000)}`;
  const digest = crypto.createHash('sha256').update(prompt + '\n\n' + require('./forge-worker-result-contract').contract().instruction('claude-cli')).digest('hex');
  const result = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt, timeoutMs: 15000, model: FIXTURE_MODEL, sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
  });
  assert.deepStrictEqual(calls, [[null]]);
  assert.strictEqual(records.length, 1);
  const record = records[0];
  assert.strictEqual(record.cmd, process.execPath);
  assert.strictEqual(record.args[0], HAPPY_FIXTURE);
  assert.strictEqual(record.options.shell, false);
  assert.deepStrictEqual(record.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.strictEqual(record.options.env[TOKEN_ENV], FIXTURE_TOKEN);
  assert.strictEqual(record.options.env.FORGE_ACCOUNT, FIXTURE_ACCOUNT.name);
  ok(!record.args.some((arg) => String(arg).includes(FIXTURE_TOKEN)), 'token reached argv');
  ok(!record.args.some((arg) => String(arg).includes('large-prompt-sentinel')), 'full prompt reached argv');
  ok(Buffer.byteLength(record.args[record.args.indexOf('-p') + 1]) <= adapter.MAX_PROMPT_INSTRUCTION_BYTES,
    'inline file instruction exceeded bound');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'SERVICE_PASSWORD']) {
    assert.strictEqual(record.options.env[key], undefined);
  }
  assert.strictEqual(result.candidate.status, 'done');
  assert.strictEqual(result.candidate.summary, `prompt-sha256:${digest}`);
  assert.deepStrictEqual(result.candidate.files_changed, ['fixture-output.txt']);
  assert.strictEqual(result.metadata.marker_count, 0);
  assert.strictEqual(result.metadata.exit_code, 0);
  ok(result.metadata.stdout_bytes <= adapter.MAX_CAPTURE_BYTES_PER_STREAM, 'stdout was not bounded');
  assert.strictEqual(result.telemetry.model_observed, FIXTURE_MODEL);
  assert.strictEqual(result.telemetry.model_observed_source, 'claude-json-modelUsage');
  assert.strictEqual(result.telemetry.effort_applied, null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'observedModel'), false,
    'the internal observation slot never leaves the adapter');
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('argv adds JSON output and invocation-only settings; everything else keeps the baseline', async () => {
  for (const readOnly of [false, true]) {
    const records = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    let captured;
    await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'argv', timeoutMs: 15000, model: FIXTURE_MODEL, readOnly,
      onPackagedContext: value => { captured = value.final_evidence; },
      sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
    });
    const args = records[0].args;
    assert.strictEqual(captured.request.sha256, crypto.createHash('sha256')
      .update(JSON.stringify({ cmd: records[0].cmd, args })).digest('hex'));
    assert.strictEqual(captured.context.sha256, crypto.createHash('sha256').update('argv' + '\n\n' + require('./forge-worker-result-contract').contract().instruction('claude-cli')).digest('hex'));
    assert.strictEqual(captured.transport, 'claude-cli');
    ok(!JSON.stringify(captured).includes(FIXTURE_TOKEN), 'credential reached evidence');
    ok(!JSON.stringify(captured).includes('Read the complete task prompt'), 'instruction reached evidence');
    const tools = readOnly ? ['--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep']
      : ['--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--permission-mode', 'acceptEdits'];
    assert.deepStrictEqual(args.slice(0, -1), [HAPPY_FIXTURE, '--model', FIXTURE_MODEL,
      '--no-session-persistence', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true,"switchModelsOnFlag":false}',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', JSON.stringify(require('./forge-worker-result-contract').contract().schema), ...tools, '-p']);
    assert.deepStrictEqual(JSON.parse(args[args.indexOf('--settings') + 1]),
      { disableAllHooks: true, switchModelsOnFlag: false });
    assert.strictEqual(args.filter((arg) => arg === '--settings').length, 1,
      'only inline invocation settings; no settings file path is named');
    assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '',
      'user, project and local settings files are excluded; managed policy is not a setting source');
    assert.strictEqual(records[0].options.shell, false);
  }
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('an absent model refuses as claude-model-required before any probe, prompt file or spawn', async () => {
  const records = [];
  const probes = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  let promptDirs = 0;
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => { promptDirs++; return mkdtemp(...args); };
  let error;
  try {
    error = await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'no model', timeoutMs: 15000, effort: 'high',
      sourceEnv: sourceEnvFor(HAPPY_FIXTURE), probeRunner: countingProbe(probes),
    }), 'claude-model-required');
  } finally { fs.mkdtempSync = mkdtemp; }
  assert.strictEqual(error.provider_called, false);
  assert.deepStrictEqual(error.diagnostic, { version: 1, stage: 'identity', reason: 'model-required' });
  assert.strictEqual(promptDirs, 0);
  assert.strictEqual(probes.length, 0);
  assert.strictEqual(records.length, 0, 'an unverifiable turn is never spawned');
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('non-zero exit rejects once without returning child stdout, stderr, or token text', async () => {
  const records = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  let ownStdout = '';
  let ownStderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => { ownStdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { ownStderr += String(chunk); return true; };
  let error;
  try {
    error = await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'nonzero', timeoutMs: 10000, model: FIXTURE_MODEL, sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  assert.strictEqual(records.length, 1);
  ok(!error.message.includes(FIXTURE_TOKEN), 'token reached adapter error');
  ok(!ownStdout.includes(FIXTURE_TOKEN), 'token reached module stdout');
  ok(!ownStderr.includes(FIXTURE_TOKEN), 'token reached module stderr');
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('missing executable has the frozen command-not-found code and no retry', async () => {
  const records = [];
  const missing = path.join(WORKSPACE, 'definitely-missing-claude-binary');
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'missing command', timeoutMs: 10000, model: FIXTURE_MODEL,
    sourceEnv: sourceEnvFor(missing),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.COMMAND_NOT_FOUND);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('exit zero plus whitespace-only stdout is never a silent success', async () => {
  const records = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'empty', timeoutMs: 10000, model: FIXTURE_MODEL, sourceEnv: sourceEnvFor(EMPTY_FIXTURE),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('status mismatch and absent worker blocks are invalid results', async () => {
  for (const fixture of [INVALID_FIXTURE, ABSENT_FIXTURE]) {
    const records = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'invalid', timeoutMs: 10000, model: FIXTURE_MODEL, sourceEnv: sourceEnvFor(fixture),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

test('timeout terminates exactly once and discards an already-complete stdout block', async () => {
  const records = [];
  let terminations = 0;
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE,
    prompt: 'timeout',
    model: FIXTURE_MODEL,
    timeoutMs: adapter.TIMEOUT_GRACE_MS + 80,
    sourceEnv: sourceEnvFor(TIMEOUT_FIXTURE),
    terminateChild(child) { terminations++; child.kill('SIGKILL'); },
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.TIMEOUT);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(terminations, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('stdout capture limit terminates a runaway child with a stable code', async () => {
  const adapterForConstant = loadAdapter();
  const outputFixture = writeFixture('claude output limit fixture.js', `
'use strict';
process.stdout.write('x'.repeat(${adapterForConstant.MAX_CAPTURE_BYTES_PER_STREAM + 1}));
setInterval(() => {}, 1000);
`);
  const records = [];
  let terminations = 0;
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE,
    prompt: 'bounded output',
    model: FIXTURE_MODEL,
    timeoutMs: 15000,
    sourceEnv: sourceEnvFor(outputFixture),
    terminateChild(child) { terminations++; child.kill('SIGKILL'); },
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.OUTPUT_LIMIT);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(terminations, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('cleanup failure never masks the primary adapter error', async () => {
  const adapter = loadAdapter();
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (path.basename(target).startsWith('.forge-claude-sidecar-')) {
      const error = new Error('fixture cleanup failure');
      error.code = 'EACCES';
      throw error;
    }
    return REAL_RM_SYNC(target, options);
  };
  try {
    await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'primary wins', timeoutMs: 10000, model: FIXTURE_MODEL,
      sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  } finally {
    fs.rmSync = originalRmSync;
    for (const name of tempPromptDirs()) {
      REAL_RM_SYNC(path.join(WORKSPACE, name), { recursive: true, force: true });
    }
  }
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('execute candidate validator requires complete payload fields and matching status', () => {
  const adapter = loadAdapter();
  const valid = { status: 'partial', summary: 'valid candidate', must_haves_status: [], files_changed: [] };
  assert.deepStrictEqual(adapter.parseExecuteCandidate(resultBlock('partial', valid)).candidate, valid);
  for (const payload of [
    { ...valid, summary: '   ' },
    { ...valid, status: 'unknown' },
    { ...valid, must_haves_status: {} },
    { ...valid, files_changed: [42] },
  ]) {
    assert.throws(() => adapter.parseExecuteCandidate(resultBlock('partial', payload)),
      (error) => error.code === adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  }
});

// â”€â”€ JSON envelope, identity, auth and secret matrices (control fixture) â”€â”€â”€â”€â”€â”€
const CONTROL_MODEL = 'claude-opus-5';
const ESCAPED_TOKEN = FIXTURE_TOKEN.replace('f', '\\u0066');
function okBlock(summary = 'control fixture') {
  return resultBlock('done', { status: 'done', summary, must_haves_status: [], files_changed: [] });
}
function controlEnvelope(fields = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: okBlock(), structured_output: {status:'done',summary:'control fixture',must_haves_status:[],files_changed:[]},
    usage: { input_tokens: 401, output_tokens: 403 },
    modelUsage: { [CONTROL_MODEL]: { inputTokens: 401, outputTokens: 403 } }, ...fields };
}
async function runControl(control, options = {}) {
  fs.writeFileSync(CONTROL_FILE, JSON.stringify({ result: okBlock(), ...control }));
  const records = [];
  let validatorCalls = 0;
  let terminations = 0;
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  let result = null;
  let error = null;
  try {
    result = await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'control', timeoutMs: 15000, model: CONTROL_MODEL,
      sourceEnv: sourceEnvFor(CONTROL_FIXTURE),
      validateCandidate: (value) => { validatorCalls++; return value && value.status === 'done'; },
      terminateChild(child) { terminations++; child.kill('SIGKILL'); },
      ...options,
    });
  } catch (caught) { error = caught; }
  assert.strictEqual(records.length, 1, 'exactly one turn spawn');
  assert.deepStrictEqual(tempPromptDirs(), []);
  if (error) {
    for (const text of [error.message, JSON.stringify(error.diagnostic || {})]) {
      ok(!text.includes(FIXTURE_TOKEN), 'token reached the adapter error');
      ok(!text.includes('control fixture'), 'worker text reached the adapter error');
    }
  }
  return { adapter, records, validatorCalls, terminations, result, error };
}

test('modelUsage naming only the requested model yields the inner parser candidate and the observation', async () => {
  const run = await runControl({}, { validateCandidate: undefined });
  ok(!run.error, run.error && run.error.code);
  assert.deepStrictEqual(run.result.candidate, run.adapter.parseExecuteCandidate(okBlock()).candidate,
    'the JSON transport must not alter the unit parser candidate');
  assert.deepStrictEqual(Object.fromEntries(Object.entries(run.result.telemetry).filter(([k])=>!['observation','calibration_proposal'].includes(k))), {
    model_argument: CONTROL_MODEL, model_observed: CONTROL_MODEL, model_observed_source: 'claude-json-modelUsage',
    effort_sent: null, effort_applied: null, effort_applied_source: null, cli_version: null, policy_diagnostics: [],
  });
});

test('identity matrix: a different model is substituted; anything unprovable is unverified; validator never runs', async () => {
  const cases = [
    ['different model', CONTROL_MODEL, { overrides: { modelUsage: { 'claude-sonnet-5': { inputTokens: 1 } } } }, 'claude-model-substituted'],
    ['absent', CONTROL_MODEL, { remove: ['modelUsage'] }, 'claude-model-unverified'],
    ['null', CONTROL_MODEL, { overrides: { modelUsage: null } }, 'claude-model-unverified'],
    ['empty', CONTROL_MODEL, { overrides: { modelUsage: {} } }, 'claude-model-unverified'],
    ['array', CONTROL_MODEL, { overrides: { modelUsage: [{ [CONTROL_MODEL]: {} }] } }, 'claude-model-unverified'],
    ['malformed list key', CONTROL_MODEL, { overrides: { modelUsage: { 'claude-opus-5, claude-sonnet-5': {} } } }, 'claude-model-unverified'],
    ['flag-shaped key', CONTROL_MODEL, { overrides: { modelUsage: { '--model': {} } } }, 'claude-model-unverified'],
    ['malformed usage value', CONTROL_MODEL, { overrides: { modelUsage: { [CONTROL_MODEL]: 7 } } }, 'claude-model-unverified'],
    ['multiple with auxiliary Haiku', CONTROL_MODEL,
      { overrides: { modelUsage: { [CONTROL_MODEL]: {}, 'claude-haiku-4-5-20251001': {} } } }, 'claude-model-unverified'],
    ['another date', 'claude-haiku-4-5-20251001',
      { overrides: { modelUsage: { 'claude-haiku-4-5-20250101': {} } } }, 'claude-model-unverified'],
    ['[1m] suffix', CONTROL_MODEL, { overrides: { modelUsage: { 'claude-opus-5[1m]': {} } } }, 'claude-model-unverified'],
    ['alias requested', 'opus', { overrides: { modelUsage: { [CONTROL_MODEL]: {} } } }, 'claude-model-unverified'],
    ['alias echoed', 'opus', { overrides: { modelUsage: { opus: {} } } }, 'claude-model-unverified'],
    ['near family (Opus 5 for Opus 5.5)', 'claude-opus-5-5',
      { overrides: { modelUsage: { 'claude-opus-5': {} } } }, 'claude-model-unverified'],
  ];
  for (const [label, model, control, code] of cases) {
    const run = await runControl(control, { model });
    ok(run.error, `${label}: was admitted`);
    assert.strictEqual(run.error.code, code, label);
    assert.strictEqual(run.validatorCalls, 0, `${label}: the unit validator ran`);
    assert.strictEqual(run.error.diagnostic.stage, 'identity', label);
    if (code === 'claude-model-substituted') {
      assert.strictEqual(run.error.diagnostic.model_observed, 'claude-sonnet-5');
      assert.strictEqual(run.error.diagnostic.model_count, 1);
    } else {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(run.error.diagnostic, 'model_observed'), false,
        `${label}: an unverified id must never be persisted`);
    }
  }
});

test('wrapper matrix: every invalid envelope is claude-invalid-result with a closed reason and admits nothing', async () => {
  const base = JSON.stringify(controlEnvelope());
  const earlier = JSON.stringify(controlEnvelope({ result: okBlock('earlier success') }));
  const failure = JSON.stringify(controlEnvelope({ subtype: 'error_during_execution', is_error: true, result: '' }));
  const cases = [
    ['array', { raw: JSON.stringify([controlEnvelope()]) }, 'result-envelope-invalid'],
    ['other type', { overrides: { type: 'assistant' } }, 'result-envelope-invalid'],
    ['error subtype', { overrides: { subtype: 'error_max_turns' } }, 'result-error'],
    ['is_error true', { overrides: { is_error: true } }, 'result-error'],
    ['is_error absent', { remove: ['is_error'] }, 'result-envelope-invalid'],
    ['structured output absent', { remove: ['structured_output'] }, 'result-envelope-invalid'],
    ['structured output wrong shape', { overrides: { structured_output: { status: 'complete' } } }, 'schema-invalid'],
    ['leading text', { raw: `Here is the result: ${base}` }, 'json-invalid'],
    ['trailing text', { raw: `${base}\nDone.` }, 'json-invalid'],
    ['truncated', { raw: base.slice(0, -9) }, 'json-invalid'],
    ['duplicated object', { raw: `${base}\n${base}` }, 'duplicate-terminal'],
    ['earlier success then failure', { raw: `${earlier}\n${failure}` }, 'duplicate-terminal'],
    ['duplicate result member', { raw: base.replace('{', `{"result":${JSON.stringify(okBlock('earlier success'))},`) }, 'json-invalid'],
    ['duplicate modelUsage member', { raw: base.replace('{', '{"modelUsage":{"claude-sonnet-5":{}},') }, 'json-invalid'],
  ];
  for (const [label, control, reason] of cases) {
    const run = await runControl(control);
    ok(run.error, `${label}: was admitted`);
    assert.strictEqual(run.error.code, 'claude-invalid-result', label);
    assert.strictEqual(run.error.diagnostic.reason, reason, label);
    assert.strictEqual(run.validatorCalls, 0, `${label}: an invalid wrapper reached the unit validator`);
  }
});

test('structured auth uses api_error_status 401/403 only; counters and JSON text never become auth', async () => {
  for (const [label, control, code] of [
    ['401 status', { overrides: { is_error: true, api_error_status: 401, result: 'Failed to authenticate' }, exit: 1 }, 'claude-auth-failed'],
    ['403 status on exit zero', { overrides: { is_error: true, api_error_status: 403, result: 'Forbidden' } }, 'claude-auth-failed'],
    ['401 text inside JSON error', { overrides: { is_error: true, result: 'API Error: 401 authentication_error' }, exit: 1 }, 'claude-exit-nonzero'],
    ['401 counters without structured output', { remove:['structured_output'], overrides: { result: 'no worker block, 401 403' } }, 'claude-invalid-result'],
    ['non-JSON stderr login prompt', { raw: 'not json', stderr: 'Please run /login', exit: 1 }, 'claude-exit-nonzero'],
  ]) {
    const run = await runControl(control);
    ok(run.error, `${label}: was admitted`);
    assert.strictEqual(run.error.code, code, label);
  }
  const counters = await runControl({ overrides: { usage: { input_tokens: 401, output_tokens: 403, status: 401 } } });
  ok(!counters.error, 'a success with 401/403 counters is a success');
  assert.strictEqual(counters.result.telemetry.model_observed, CONTROL_MODEL);
});

test('raw and Unicode-escaped tokens in values, names, modelUsage keys and the candidate are secret-output', async () => {
  const plantEscaped = (value) => JSON.stringify(value).replace(FIXTURE_TOKEN, ESCAPED_TOKEN);
  const cases = [
    ['raw value', { overrides: { note: FIXTURE_TOKEN } }],
    ['escaped value', { raw: plantEscaped(controlEnvelope({ note: FIXTURE_TOKEN })) }],
    ['escaped property name', { raw: plantEscaped(controlEnvelope({ extra: { [FIXTURE_TOKEN]: 1 } })) }],
    ['escaped modelUsage key', { raw: plantEscaped(controlEnvelope({ modelUsage: { [FIXTURE_TOKEN]: {} } })) }],
    ['escaped candidate', { raw:plantEscaped(controlEnvelope({structured_output:{status:'done',summary:FIXTURE_TOKEN,must_haves_status:[],files_changed:[]}})) }],
  ];
  for (const [label, control] of cases) {
    if (label !== 'raw value') {
      const planted = control.raw || JSON.stringify(controlEnvelope({ result: control.result }));
      ok(!planted.includes(FIXTURE_TOKEN), `${label}: fixture must hide the token from the raw scan`);
    }
    const run = await runControl(control);
    ok(run.error, `${label}: was admitted`);
    assert.strictEqual(run.error.code, 'claude-invalid-result', label);
    assert.strictEqual(run.error.diagnostic.reason, 'secret-output', label);
  }
});

test('escape-inflated stdout over 1 MiB fails with output-limit and never truncates', async () => {
  const adapter = loadAdapter();
  assert.strictEqual(adapter.MAX_CAPTURE_BYTES_PER_STREAM, 1024 * 1024, 'the stream cap is unchanged');
  const inner = okBlock('"'.repeat(300 * 1024));
  ok(Buffer.byteLength(inner) <= 900 * 1024, 'the inner payload stays within the 900 KiB budget');
  ok(Buffer.byteLength(JSON.stringify(controlEnvelope({ result: inner }))) > 1024 * 1024,
    'escaping must push the JSON stream over 1 MiB');
  const run = await runControl({ result: inner, hang: true });
  ok(run.error, 'an over-limit stream was admitted');
  assert.strictEqual(run.error.code, 'claude-output-limit');
  assert.strictEqual(run.terminations, 1);
  assert.strictEqual(run.validatorCalls, 0);
});

test('a healthy long turn beats on the published cadence with the real child pid', async () => {
  const records = [];
  const children = [];
  const adapter = loadAdapter({
    spawnImpl: (cmd, args, options) => {
      records.push({ cmd, args: args.slice() });
      const child = REAL_SPAWN(cmd, args, options);
      children.push(child);
      return child;
    },
  });
  const beats = [];
  const result = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE,
    prompt: 'slow but healthy',
    model: FIXTURE_MODEL,
    timeoutMs: 20000,
    heartbeatIntervalMs: 40,
    onHeartbeat: (pid) => { beats.push({ pid, at: Date.now() }); },
    sourceEnv: sourceEnvFor(SLOW_FIXTURE),
  });
  assert.strictEqual(result.candidate.status, 'done');
  assert.strictEqual(children.length, 1);
  const childPid = children[0].pid;
  // One beat at spawn plus a real cadence. A single beat is exactly the defect:
  // the reaper kills on the second consecutive stale-alive.
  ok(beats.length >= 3, `expected periodic beats, got ${beats.length}`);
  for (const beat of beats) {
    assert.strictEqual(beat.pid, childPid, 'a beat published a pid that is not the Claude child');
  }
  assert.notStrictEqual(childPid, process.pid, 'child pid must stay distinct from the adapter pid');
  const settledCount = beats.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(beats.length, settledCount, 'the heartbeat interval outlived the turn');
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('the heartbeat interval is cleared on a failing exit path too', async () => {
  const adapter = loadAdapter();
  const beats = [];
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'nonzero', timeoutMs: 10000, heartbeatIntervalMs: 20, model: FIXTURE_MODEL,
    onHeartbeat: (pid) => { beats.push(pid); },
    sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  const settledCount = beats.length;
  ok(settledCount >= 1, 'the spawn beat must publish the pid before failure');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(beats.length, settledCount, 'the heartbeat interval survived a rejection');
  ok(!beats.some((pid) => String(pid).includes(FIXTURE_TOKEN)), 'a beat carried more than a pid');
});

test('native prompt-file I/O errors are re-wrapped as the frozen prompt-io code', async () => {
  const originalMkdtemp = fs.mkdtempSync;
  const originalWriteFile = fs.writeFileSync;
  const leakySuffix = 'secret-path-fragment-must-not-leak';
  const cases = [
    ['mkdtempSync', 'EACCES', () => {
      fs.mkdtempSync = (prefix, options) => {
        if (path.basename(String(prefix)).startsWith('.forge-claude-sidecar-')) {
          const error = new Error(`EACCES: permission denied, mkdtemp '${prefix}${leakySuffix}'`);
          error.code = 'EACCES';
          throw error;
        }
        return originalMkdtemp(prefix, options);
      };
    }],
    ['writeFileSync', 'ENOSPC', () => {
      fs.writeFileSync = (file, data, options) => {
        if (path.basename(String(file)) === 'prompt.txt') {
          const error = new Error(`ENOSPC: no space left on device, write '${file}${leakySuffix}'`);
          error.code = 'ENOSPC';
          throw error;
        }
        return originalWriteFile(file, data, options);
      };
    }],
  ];
  for (const [label, nativeCode, install] of cases) {
    let spawnCalls = 0;
    const adapter = loadAdapter({ spawnImpl: () => { spawnCalls++; throw new Error('spawn must not run'); } });
    install();
    let error;
    try {
      error = await expectCode(adapter.invokeClaudeSidecar({
        cwd: WORKSPACE, prompt: 'prompt io', timeoutMs: 10000, model: FIXTURE_MODEL,
        sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
      }), adapter.CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO);
    } finally {
      fs.mkdtempSync = originalMkdtemp;
      fs.writeFileSync = originalWriteFile;
      for (const name of tempPromptDirs()) {
        REAL_RM_SYNC(path.join(WORKSPACE, name), { recursive: true, force: true });
      }
    }
    assert.notStrictEqual(error.code, nativeCode, `${label}: native ${nativeCode} escaped the wrap`);
    ok(!error.message.includes(leakySuffix), `${label}: the native path-bearing message leaked`);
    assert.strictEqual(spawnCalls, 0, `${label}: a failed prompt file must not spawn Claude`);
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

test('a missing or blank prompt refuses before spending any subscription quota', async () => {
  for (const prompt of [undefined, '', '   \n\t', 42]) {
    let spawnCalls = 0;
    const adapter = loadAdapter({ spawnImpl: () => { spawnCalls++; throw new Error('spawn must not run'); } });
    await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt, timeoutMs: 10000, sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.MISSING_PROMPT);
    assert.strictEqual(spawnCalls, 0, 'a promptless launch reached the real CLI');
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

test('a declared model reaches argv, and a malformed launch option is refused', async () => {
  const records = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  const result = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'model forwarding', timeoutMs: 15000,
    model: 'claude-fixture-model',
    sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
  });
  assert.strictEqual(result.candidate.status, 'done');
  assert.strictEqual(records.length, 1);
  const modelIndex = records[0].args.indexOf('--model');
  ok(modelIndex > -1, 'the declared model never reached the CLI invocation');
  assert.strictEqual(records[0].args[modelIndex + 1], 'claude-fixture-model');
  ok(records[0].args.indexOf('-p') > modelIndex, 'the model flag must precede the prompt instruction');

  for (const options of [
    { model: '' }, { model: '--dangerously-skip-permissions' }, { model: 7 },
    { heartbeatIntervalMs: 0 }, { heartbeatIntervalMs: -5 }, { heartbeatIntervalMs: 1.5 },
  ]) {
    let spawnCalls = 0;
    const strict = loadAdapter({ spawnImpl: () => { spawnCalls++; throw new Error('spawn must not run'); } });
    await expectCode(strict.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'invalid options', timeoutMs: 10000,
      sourceEnv: sourceEnvFor(HAPPY_FIXTURE), ...options,
    }), strict.CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
    assert.strictEqual(spawnCalls, 0, `${JSON.stringify(options)} was not refused before spawn`);
  }
  assert.deepStrictEqual(tempPromptDirs(), []);
});

// Model-policy fixtures: `--version` answers first (the probe runs with the
// minimal env, so the version is baked into each file), then a normal turn.
function versionFixture(label, versionOutput, versionExit = 0) {
  return writeFixture(`claude version ${label} fixture.js`, `
'use strict';
${ENVELOPE_PRELUDE}
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(${JSON.stringify(versionOutput)});
  process.exit(${versionExit});
}
const payload = { status: 'done', summary: 'policy fixture', must_haves_status: [], files_changed: [] };
process.stdout.write(envelope(['---GSD-WORKER-RESULT---', 'status: done',
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n')));
`);
}
const VERSION_CURRENT = versionFixture('current', '2.1.284 (Claude Code)\n');
const VERSION_OLD = versionFixture('old', '2.1.200 (Claude Code)\n');
const VERSION_GARBAGE = versionFixture('garbage', 'no version here\n');
const VERSION_FAILING = versionFixture('failing', '', 3);

function countingProbe(calls) {
  return (cmd, args, options) => {
    calls.push({ cmd, args: args.slice(), shell: options.shell, env: { ...options.env } });
    return childProcess.spawnSync(cmd, args, options);
  };
}

const LEGACY_ARGV_TAIL = ['--no-session-persistence', '--disable-slash-commands',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true,"switchModelsOnFlag":false}',
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', JSON.stringify(require('./forge-worker-result-contract').contract('execute').schema),
  '--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--permission-mode', 'acceptEdits', '-p'];

test('Sonnet 5.5 sends the full id and exact effort after a satisfied version probe', async () => {
  const records = [];
  const probes = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  const result = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'sonnet 5.5', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort: 'high',
    sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
  });
  assert.strictEqual(result.candidate.status, 'done');
  assert.strictEqual(probes.length, 1, 'exactly one version probe');
  assert.deepStrictEqual(probes[0].args, [VERSION_CURRENT, '--version'], 'probe uses the resolved command');
  assert.strictEqual(probes[0].cmd, process.execPath);
  assert.strictEqual(probes[0].shell, false);
  assert.strictEqual(probes[0].env[TOKEN_ENV], undefined, 'the probe never receives the account token');
  assert.strictEqual(probes[0].env.FORGE_ACCOUNT, undefined, 'the probe never receives the account name');
  assert.strictEqual(records.length, 1, 'one turn spawn');
  const args = records[0].args;
  assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5', 'full id, never an alias');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  ok(!args.some((arg) => /thinking|between/i.test(String(arg))), 'no thinking flag is invented');
  assert.deepStrictEqual(Object.fromEntries(Object.entries(result.telemetry).filter(([k])=>!['observation','calibration_proposal'].includes(k))), {
    model_argument: 'claude-sonnet-5-5', model_observed: 'claude-sonnet-5-5',
    model_observed_source: 'claude-json-modelUsage', effort_sent: 'high', effort_applied: null,
    effort_applied_source: null, cli_version: '2.1.284', policy_diagnostics: [],
  });
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('a known older CLI refuses before the turn spawn', async () => {
  const records = [];
  const probes = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  const error = await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'old cli', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort: 'medium',
    sourceEnv: sourceEnvFor(VERSION_OLD), probeRunner: countingProbe(probes),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.CLI_VERSION_UNSUPPORTED);
  assert.strictEqual(probes.length, 1);
  assert.strictEqual(records.length, 0, 'the turn was never spawned');
  assert.deepStrictEqual(error.policy, { cli_version: '2.1.200', min_version: '2.1.284', model: 'claude-sonnet-5-5' });
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('an unverifiable version is diagnosed and the turn still runs', async () => {
  for (const fixture of [VERSION_GARBAGE, VERSION_FAILING]) {
    const records = [];
    const probes = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    const result = await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'unverified', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort: 'max',
      sourceEnv: sourceEnvFor(fixture), probeRunner: countingProbe(probes),
    });
    assert.strictEqual(result.candidate.status, 'done');
    assert.strictEqual(probes.length, 1);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(result.telemetry.cli_version, null);
    assert.deepStrictEqual(result.telemetry.policy_diagnostics.map((item) => item.code), ['transport-version-unverified']);
  }
});

test('models without a minimum version keep the exact argv and spawn count', async () => {
  for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5-20251001']) {
    const records = [];
    const probes = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    const result = await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'legacy', timeoutMs: 15000, model, effort: 'medium',
      sourceEnv: sourceEnvFor(VERSION_OLD), probeRunner: countingProbe(probes),
    });
    assert.strictEqual(result.candidate.status, 'done');
    assert.strictEqual(probes.length, 0, `${model} must not be probed`);
    assert.strictEqual(records.length, 1);
    const args = records[0].args;
    assert.deepStrictEqual(args.slice(0, args.length - 1),
      [VERSION_OLD, '--model', model, '--effort', 'medium', ...LEGACY_ARGV_TAIL]);
    assert.strictEqual(result.telemetry.cli_version, null);
  }
});

test('between_tools refuses before any probe or spawn', async () => {
  const records = [];
  const probes = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'between tools', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort: 'low',
    thinkingRequested: 'between_tools', sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.THINKING_TRANSPORT_UNSUPPORTED);
  assert.strictEqual(probes.length, 0);
  assert.strictEqual(records.length, 0);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('direct Sonnet 5.5 thinking refusals happen before probes, prompt files and inference', async () => {
  for (const [mode, code] of [['disabled', 'thinking-disabled-incompatible'],
    ['enabled', 'thinking-enabled-incompatible'], ['ENABLED', 'thinking-enabled-incompatible'],
    ['unknown', 'thinking-mode-unknown']]) {
    const records = [];
    const probes = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    let promptWrites = 0;
    const mkdtemp = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => { promptWrites++; return mkdtemp(...args); };
    try {
      const error = await expectCode(adapter.invokeClaudeSidecar({
        cwd: WORKSPACE, prompt: 'direct thinking', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort: 'high',
        thinkingRequested: mode, sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
      }), code);
      assert(Object.values(adapter.CLAUDE_SIDECAR_REASON_CODES).includes(error.code), 'named frozen reason code');
      assert.strictEqual(error.provider_called, false);
      assert.strictEqual(error.layer, 'model-policy');
      assert.strictEqual(error.policy.reason_code, code);
    } finally { fs.mkdtempSync = mkdtemp; }
    assert.strictEqual(promptWrites, 0);
    assert.strictEqual(probes.length, 0);
    assert.strictEqual(records.length, 0);
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

test('direct Sonnet 5.5 adaptive thinking preserves exact medium/high/xhigh/max effort argv', async () => {
  for (const effort of ['medium', 'high', 'xhigh', 'max']) {
    const records = [];
    const probes = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    const result = await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'adaptive thinking', timeoutMs: 15000, model: 'claude-sonnet-5-5', effort,
      thinkingRequested: 'adaptive', sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
    });
    assert.strictEqual(result.candidate.status, 'done');
    assert.strictEqual(probes.length, 1);
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0].args.slice(0, -1),
      [VERSION_CURRENT, '--model', 'claude-sonnet-5-5', '--effort', effort, ...LEGACY_ARGV_TAIL]);
    assert.strictEqual(result.telemetry.effort_sent, effort);
    assert.strictEqual(result.telemetry.effort_applied, null);
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

test('an effort the model policy does not document refuses before any probe or spawn', async () => {
  const records = [];
  const probes = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'sonnet 4.6 xhigh', timeoutMs: 15000, model: 'claude-sonnet-4-6', effort: 'xhigh',
    sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.EFFORT_UNSUPPORTED_BY_MODEL);
  assert.strictEqual(probes.length, 0);
  assert.strictEqual(records.length, 0, 'the undocumented effort never reached argv');
  assert.deepStrictEqual(tempPromptDirs(), []);
  // A documented value for the same model keeps the exact launch.
  const ok46 = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'sonnet 4.6 max', timeoutMs: 15000, model: 'claude-sonnet-4-6', effort: 'max',
    sourceEnv: sourceEnvFor(VERSION_CURRENT), probeRunner: countingProbe(probes),
  });
  assert.strictEqual(ok46.candidate.status, 'done');
  assert.strictEqual(records[0].args[records[0].args.indexOf('--effort') + 1], 'max');
});

test('progress milestones are closed, observer failures are ignored, and structured fatal events fail fast', async () => {
  const streamFixture = writeFixture('claude stream progress fixture.js', `
${ENVELOPE_PRELUDE}
process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'message_start',message:{id:'private-session-id',role:'assistant'}}})+'\\n');
setTimeout(()=>process.stdout.write(envelope('unused')+'\\n'),25);
`);
  // Use a complete contract candidate instead of the legacy fixture helper.
  fs.writeFileSync(streamFixture, fs.readFileSync(streamFixture, 'utf8').replace("envelope('unused')",
    "envelope(" + JSON.stringify(okBlock()) + ")"));
  const snapshots = [];
  const adapter = loadAdapter();
  const result = await adapter.invokeClaudeSidecar({ cwd: WORKSPACE, prompt: 'progress', model: FIXTURE_MODEL,
    timeoutMs: 15000, sourceEnv: sourceEnvFor(streamFixture), onProgress(snapshot) {
      snapshots.push(snapshot);
      if (snapshots.length === 1) throw Error('observer failure');
      return Promise.reject(Error('async observer failure'));
    } });
  assert.equal(result.candidate.status, 'done');
  assert.equal(snapshots[0].phase, 'local-start');
  assert(snapshots.some(value => value.phase === 'remote-activity'));
  assert(snapshots.some(value => value.phase === 'terminal'));
  assert.equal(snapshots.at(-1).phase, 'closed');
  assert.equal(snapshots.at(-1).process_exit_observed, true);
  assert(!JSON.stringify(snapshots).includes('private-session-id'));
  assert(!JSON.stringify(snapshots).includes('control fixture'));
  const fatal = await runControl({ raw: JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }) + '\n', hang: true });
  assert.equal(fatal.error.diagnostic.reason, 'result-error');
  assert.equal(fatal.terminations, 1);
  assert.equal(fatal.error.diagnostic.observation.process_exit_observed, false);
  assert(fatal.error.diagnostic.observation.elapsed_ms < 5000, 'structured failure does not wait for hard timeout');
});

test('throwing semantic validator retains its validation reason and observation', async () => {
  const run = await runControl({}, { validateCandidate() { throw Error('private-validator-path'); } });
  assert.equal(run.error.code, 'claude-invalid-result');
  assert.equal(run.error.diagnostic.reason, 'validator-failed');
  assert.equal(run.error.diagnostic.observation.process_exit_observed, true);
  assert(!JSON.stringify(run.error).includes('private-validator-path'));
});

test('unreadable calibration is visible in progress and returned telemetry', async () => {
  const calibration = require('./forge-sidecar-calibration');
  const calibrationOptions = { userHome: path.join(ROOT, 'corrupt-calibration-home') };
  fs.mkdirSync(calibration.directory(calibrationOptions), { recursive: true });
  fs.writeFileSync(path.join(calibration.directory(calibrationOptions), 'calibration.json'), 'private-invalid-json');
  const progress = [];
  const run = await runControl({}, { calibrationOptions, onProgress: value => progress.push(value) });
  assert.equal(run.result.telemetry.observation.calibration.diagnostic, 'calibration-unavailable');
  assert(progress.every(value => value.calibration.diagnostic === 'calibration-unavailable'));
  assert(!JSON.stringify(run.result.telemetry).includes('private-invalid-json'));
});

// Migrated in S01/T03: liveness is now the primary kill authority. A persisted
// v1 initial calibration (>= 120000) never tightens the locked 60000 start
// limit, so the same silent child now dies as dead-start at the locked default.
// The ceiling is also enforced on the injected clock now, so timeoutMs is
// widened (15000 -> 3600000) to keep the start limit, not the ceiling, in play.
test('persisted calibrated silence aborts locally (now dead-start at the locked 60000 default) without treating kill promise as observed exit', async () => {
  const calibration = require('./forge-sidecar-calibration');
  const calibrationOptions = { userHome: path.join(ROOT, 'calibration-home') };
  const id = { model: FIXTURE_MODEL, effort: 'medium', phase: 'execute' };
  for (let i = 0; i < 5; i++) assert(calibration.commit(calibration.propose(id,
    { initial_sample_ms: 100, gap_sample_ms: null }), { receipt: 'fixture', fingerprint: 'fixture' }, calibrationOptions).committed);
  const silentFixture = writeFixture('claude silent fixture.js', 'setInterval(()=>{},1000);');
  let now = 0, kills = 0;
  const adapter = loadAdapter();
  const error = await expectCode(adapter.invokeClaudeSidecar({ cwd: WORKSPACE, prompt: 'silence', model: FIXTURE_MODEL,
    timeoutMs: 3600000, calibrationOptions, monotonicClock: () => now, livenessIntervalMs: 25,
    sourceEnv: sourceEnvFor(silentFixture), onHeartbeat() { now = 120001; },
    terminateChild(child) { kills++; child.kill('SIGKILL'); return Promise.reject(Error('termination unconfirmed')); },
  }), 'claude-anomalous-silence');
  assert.equal(kills, 1);
  assert.equal(error.diagnostic.observation.silence.cause, 'indeterminate');
  assert.equal(error.diagnostic.observation.silence.dimension, 'initial');
  assert.equal(error.diagnostic.observation.silence.threshold_ms, 60000);
  assert.equal(error.diagnostic.observation.silence.source, 'locked-default');
  assert.equal(error.liveness.termination, 'dead-start');
  assert.equal(error.diagnostic.observation.process_exit_observed, false);
  assert.deepEqual(tempPromptDirs(), []);
});

// ── Liveness watchdog (S01/T03) — accelerated injected clock, no long real waits ──
// The watchdog consults forge-sidecar-liveness on every livenessIntervalMs tick
// using the injected monotonicClock. `fromFirstRemote` keeps real time until the
// first remote event so a slow child start on a loaded CI host cannot be read
// as an accelerated dead-start; the dead-start test accelerates from spawn.
function acceleratedClock(factor, { fromFirstRemote = false } = {}) {
  const t0 = performance.now();
  let pivotReal = fromFirstRemote ? null : t0, pivotValue = 0;
  return {
    now() {
      const real = performance.now();
      return pivotReal === null ? real - t0 : pivotValue + (real - pivotReal) * factor;
    },
    accelerate() {
      if (pivotReal !== null) return;
      const real = performance.now();
      pivotValue = real - t0;
      pivotReal = real;
    },
  };
}

const STREAM_PRELUDE = `
'use strict';
${ENVELOPE_PRELUDE}
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const delta = () => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
  delta: { type: 'text_delta', text: 'x' } } });
out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-live', role: 'assistant' } } });
out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
`;

// Streams a text_delta every ~30 ms; after finishAfterMs real ms (if given)
// closes the message and writes a valid result envelope.
function activeStreamFixture(name, finishAfterMs) {
  return writeFixture(name, `${STREAM_PRELUDE}
const stopAt = ${finishAfterMs === null ? 'null' : `Date.now() + ${finishAfterMs}`};
const tick = setInterval(() => {
  delta();
  if (stopAt !== null && Date.now() >= stopAt) {
    clearInterval(tick);
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    process.stdout.write(envelope(${JSON.stringify(okBlock('liveness active'))}) + '\\n');
  }
}, 30);
`);
}

// Emits N=3 remote events (message_start + two text deltas) and then stays silent.
const SILENT_AFTER_EVENTS_FIXTURE = writeFixture('claude silent after events fixture.js', `${STREAM_PRELUDE}
delta();
delta();
setInterval(() => {}, 1000);
`);
const SILENT_FROM_START_FIXTURE = writeFixture('claude silent from start fixture.js', 'setInterval(() => {}, 1000);');

async function runLive(fixture, clock, options = {}) {
  const children = [];
  const transitions = [];
  let terminations = 0, result = null, error = null;
  const adapter = loadAdapter({ spawnImpl: (cmd, args, spawnOptions) => {
    const child = REAL_SPAWN(cmd, args, spawnOptions);
    children.push(child);
    return child;
  } });
  const started = performance.now();
  try {
    result = await adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'liveness', model: FIXTURE_MODEL, timeoutMs: 3600000,
      sourceEnv: sourceEnvFor(fixture), monotonicClock: clock.now, livenessIntervalMs: 25,
      onProgress(snapshot) { if (snapshot.phase !== 'local-start') clock.accelerate(); },
      onLiveness(transition) { transitions.push(transition); },
      terminateChild(child) { terminations++; child.kill('SIGKILL'); },
      ...options,
    });
  } catch (caught) { error = caught; }
  finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
  const realMs = performance.now() - started;
  assert.strictEqual(children.length, 1, 'exactly one turn spawn');
  assert.deepStrictEqual(tempPromptDirs(), []);
  ok(realMs < 5000, `liveness test waited ${Math.round(realMs)} real ms`);
  return { result, error, transitions, terminations, realMs };
}

function gapCalibration(label, gapSampleMs) {
  const calibration = require('./forge-sidecar-calibration');
  const calibrationOptions = { userHome: path.join(ROOT, `calibration-gap-${label}`) };
  const id = { model: FIXTURE_MODEL, effort: 'medium', phase: 'execute' };
  for (let i = 0; i < 5; i++) {
    assert(calibration.commit(calibration.propose(id, { initial_sample_ms: null, gap_sample_ms: gapSampleMs }),
      { receipt: 'fixture', fingerprint: 'fixture' }, calibrationOptions).committed);
  }
  const record = calibration.read(id, calibrationOptions);
  assert.strictEqual(record.gap.calibrated, true);
  return { calibrationOptions, threshold: record.gap.threshold_ms };
}

test('liveness: an active stream survives past 300000 injected ms under a 3600000 ceiling', async () => {
  const fixture = activeStreamFixture('claude active stream fixture.js', 1200);
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }));
  assert.strictEqual(run.error, null, run.error && `${run.error.code} ${JSON.stringify(run.error.liveness)}`);
  assert.strictEqual(run.result.candidate.status, 'done');
  ok(run.result.metadata.observation.elapsed_ms > 300000,
    `elapsed ${run.result.metadata.observation.elapsed_ms} must exceed 300000 injected ms`);
  assert.strictEqual(run.terminations, 0);
  ok(!run.transitions.some(t => t.to === 'dead'), 'an active stream never reached dead');
});

test('liveness: no remote event dies once as dead-start at the locked 60000 default', async () => {
  const run = await runLive(SILENT_FROM_START_FIXTURE, acceleratedClock(300));
  ok(run.error, 'expected rejection');
  assert.strictEqual(run.error.code, 'claude-anomalous-silence');
  assert.strictEqual(run.error.liveness.termination, 'dead-start');
  assert.strictEqual(run.error.liveness.state, 'dead');
  const silence = run.error.diagnostic.observation.silence;
  assert.strictEqual(silence.dimension, 'initial');
  assert.strictEqual(silence.threshold_ms, 60000);
  assert.strictEqual(silence.source, 'locked-default');
  assert.strictEqual(silence.policy, 'forge-liveness-v1');
  assert.strictEqual(silence.cause, 'indeterminate');
  assert.strictEqual(run.terminations, 1);
  assert.deepStrictEqual(run.transitions.map(t => t.to), ['starting', 'dead']);
});

test('liveness: silence after N events passes slow-suspect (120000) before dead-silence (240000)', async () => {
  const run = await runLive(SILENT_AFTER_EVENTS_FIXTURE, acceleratedClock(200, { fromFirstRemote: true }));
  ok(run.error, 'expected rejection');
  assert.strictEqual(run.error.code, 'claude-anomalous-silence');
  assert.strictEqual(run.error.liveness.termination, 'dead-silence');
  const silence = run.error.diagnostic.observation.silence;
  assert.strictEqual(silence.dimension, 'gap');
  assert.strictEqual(silence.threshold_ms, 240000);
  assert.strictEqual(silence.source, 'locked-default');
  ok(silence.window_ms > 240000);
  const suspect = run.transitions.findIndex(t => t.from === 'working' && t.to === 'slow-suspect');
  const dead = run.transitions.findIndex(t => t.from === 'slow-suspect' && t.to === 'dead');
  ok(suspect >= 0, `slow-suspect transition missing: ${JSON.stringify(run.transitions)}`);
  ok(dead > suspect, `dead must follow slow-suspect: ${JSON.stringify(run.transitions)}`);
  ok(run.transitions[suspect].at_ms > 120000 && run.transitions[suspect].at_ms < run.transitions[dead].at_ms);
  assert.strictEqual(run.terminations, 1);
});

test('liveness: an active stream reaching the injected ceiling is claude-timeout budget-exceeded-while-active', async () => {
  // timeoutMs 60000 gives a 55000 ms child ceiling. On the accelerated clock the
  // watchdog reaches it in ~0.2 s real; the real setTimeout backstop (55 s) does not fire.
  const fixture = activeStreamFixture('claude endless stream fixture.js', null);
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }), { timeoutMs: 60000 });
  ok(run.error, 'expected rejection');
  assert.strictEqual(run.error.code, 'claude-timeout');
  assert.strictEqual(run.error.liveness.termination, 'budget-exceeded-while-active');
  assert.strictEqual(run.error.liveness.state, 'working');
  assert.strictEqual(run.error.diagnostic.observation.silence, undefined);
  ok(run.realMs < 4000, 'the injected ceiling, not the real backstop, terminated the turn');
  assert.strictEqual(run.terminations, 1);
});

test('liveness: a calibrated v1 gap only tightens the dead limit and never exceeds 240000', async () => {
  const loose = gapCalibration('loose', 100000);
  ok(loose.threshold > 240000, `v1 threshold ${loose.threshold} must exceed the locked default`);
  const capped = await runLive(SILENT_AFTER_EVENTS_FIXTURE, acceleratedClock(200, { fromFirstRemote: true }),
    { calibrationOptions: loose.calibrationOptions });
  assert.strictEqual(capped.error.code, 'claude-anomalous-silence');
  assert.strictEqual(capped.error.liveness.termination, 'dead-silence');
  assert.strictEqual(capped.error.diagnostic.observation.silence.threshold_ms, 240000);
  assert.strictEqual(capped.error.diagnostic.observation.silence.source, 'locked-default');

  const tight = gapCalibration('tight', 100);
  assert.strictEqual(tight.threshold, 120000);
  const tightened = await runLive(SILENT_AFTER_EVENTS_FIXTURE, acceleratedClock(200, { fromFirstRemote: true }),
    { calibrationOptions: tight.calibrationOptions });
  assert.strictEqual(tightened.error.code, 'claude-anomalous-silence');
  assert.strictEqual(tightened.error.liveness.termination, 'dead-silence');
  const silence = tightened.error.diagnostic.observation.silence;
  assert.strictEqual(silence.threshold_ms, 120000);
  assert.strictEqual(silence.source, 'persisted-calibration');
  ok(silence.window_ms > 120000 && silence.window_ms < 240000, `window ${silence.window_ms}`);
});

test('liveness: an invalid livenessIntervalMs is refused before any spawn', async () => {
  for (const value of [0, -1, 1.5, '25']) {
    const records = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    await expectCode(adapter.invokeClaudeSidecar({ cwd: WORKSPACE, prompt: 'interval', model: FIXTURE_MODEL,
      timeoutMs: 15000, livenessIntervalMs: value, sourceEnv: sourceEnvFor(HAPPY_FIXTURE) }),
    adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
    assert.strictEqual(records.length, 0);
    assert.deepStrictEqual(tempPromptDirs(), []);
  }
});

// ── Tool liveness (S02/T04) — local proof, extension and loop detector ──
// Proofs are injected through the internal localProofFactory seam, so every
// three-state branch (win32 unavailable, dead pid, Linux without proof) runs on
// every platform. Tool arguments carry a sentinel that must never surface.
const TOOL_ARG_SENTINEL = 'forge-t04-private-tool-argument-sentinel';

// Emits one tool_use cycle per entry of `inputs` (stream block + assistant
// message), optionally a tool_result per cycle, then either hangs (tool still in
// flight) or finishes with a text message and a valid result envelope.
//   holdMs: real ms to keep the LAST tool in flight before its tool_result
//   result: false keeps the last tool in flight forever (no tool_result/result)
//   pauseAfter/sentinelFile: after cycle N, wait, touch a file, wait again
function toolFixture(name, { inputs, gapMs = 15, holdMs = 0, result = true, pauseAfter = null, sentinelFile = null }) {
  return writeFixture(name, `
'use strict';
const fs = require('fs');
${ENVELOPE_PRELUDE}
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const inputs = ${JSON.stringify(inputs)};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function toolUse(index, input) {
  const id = 'toolu_t04_' + index, message = 'msg-tool-' + index;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: message, role: 'assistant' } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id, name: 'Bash', input: {} } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id: message, role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
  return id;
}
function toolResult(id) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
    content: 'fixture-tool-output' }] }, parent_tool_use_id: null, session_id: 'fixture-session' });
}
(async () => {
  for (let index = 0; index < inputs.length; index++) {
    const id = toolUse(index, inputs[index]);
    const last = index === inputs.length - 1;
    if (last && ${result === false}) { setInterval(() => {}, 1000); return; }
    await sleep(last ? ${holdMs} : ${gapMs});
    toolResult(id);
    if (${pauseAfter === null ? -1 : pauseAfter} === index + 1) {
      await sleep(150);
      fs.writeFileSync(${JSON.stringify(sentinelFile)}, 'written');
      await sleep(300);
    }
  }
  await sleep(250);
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-final', role: 'assistant' } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  process.stdout.write(envelope(${JSON.stringify(okBlock('tool liveness'))}) + '\\n');
})();
`);
}

function privateInput(extra = {}) {
  return { command: `echo ${TOOL_ARG_SENTINEL}`, description: 'volatile description', ...extra };
}

// Programmable fake provider: current() returns the injected proof; sample()
// is counted; onWrite is exposed so a test can simulate a filesystem delta.
function fakeProof(initial, { writeWhen } = {}) {
  const state = { proof: initial, samples: 0, currents: 0, stops: 0, options: null, wrote: false };
  state.factory = (options) => {
    state.options = options;
    return {
      sample() {
        state.samples++;
        if (writeWhen && !state.wrote && writeWhen()) { state.wrote = true; options.onWrite(); }
        return Promise.resolve();
      },
      current() { state.currents++; return state.proof; },
      stop() { state.stops++; },
    };
  };
  return state;
}

function assertToolKill(run, reason, { extension = null } = {}) {
  ok(run.error, `expected a ${reason} kill`);
  assert.strictEqual(run.error.code, 'claude-anomalous-silence');
  assert.strictEqual(run.error.liveness.termination, 'dead-silence');
  assert.strictEqual(run.error.liveness.state, 'dead');
  assert.strictEqual(run.error.liveness.reason, reason);
  assert.strictEqual(run.error.liveness.extension_ms, extension);
  assert.strictEqual(run.error.liveness.version, 1);
  const silence = run.error.diagnostic.observation.silence;
  ok(silence, 'observation.silence must be accepted by the diagnostic allowlist');
  assert.strictEqual(silence.dimension, 'gap');
  assert.strictEqual(silence.threshold_ms, 240000);
  assert.strictEqual(silence.policy, 'forge-liveness-v1');
  assert.strictEqual(silence.source, 'locked-default');
  ok(silence.window_ms > silence.threshold_ms, `window ${silence.window_ms}`);
  assert.strictEqual(run.terminations, 1);
  assertPrivate(run);
  return silence;
}

function assertPrivate(run) {
  for (const [label, value] of [['transitions', run.transitions], ['error.liveness', run.error?.liveness],
    ['observation', run.error?.diagnostic?.observation ?? run.result?.metadata?.observation]]) {
    ok(!JSON.stringify(value ?? null).includes(TOOL_ARG_SENTINEL), `${label} leaked tool argument text`);
  }
}

test('liveness/tool: positive local proof survives past 240000 injected ms and is accepted', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'positive' });
  const fixture = toolFixture('claude tool positive fixture.js', { inputs: [privateInput()], holdMs: 1100 });
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }),
    { localProofFactory: fake.factory });
  assert.strictEqual(run.error, null, run.error && `${run.error.code} ${JSON.stringify(run.error.liveness)}`);
  assert.strictEqual(run.result.candidate.status, 'done');
  assert.strictEqual(run.terminations, 0);
  ok(run.transitions.some(t => t.to === 'slow-suspect' && t.reason === 'tool-extended' && t.at_ms > 240000),
    `tool-extended past 240000 expected: ${JSON.stringify(run.transitions)}`);
  ok(!run.transitions.some(t => t.to === 'dead'));
  assertPrivate(run);
});

test('liveness/tool: Linux/macOS without proof (available/none) dies at 240000 as tool-unproven', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'none' });
  const fixture = toolFixture('claude tool unproven fixture.js', { inputs: [privateInput()], result: false });
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }),
    { localProofFactory: fake.factory });
  const silence = assertToolKill(run, 'tool-unproven');
  ok(silence.window_ms < 660000, `killed at ${silence.window_ms}, not after the extension`);
  assert.deepStrictEqual(run.error.liveness.proof, { capability: 'available', proof: 'none' });
});

test('liveness/tool: a dead child pid (available/negative) dies at 240000 as tool-proof-negative', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'negative' });
  const fixture = toolFixture('claude tool negative fixture.js', { inputs: [privateInput()], result: false });
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }),
    { localProofFactory: fake.factory });
  const silence = assertToolKill(run, 'tool-proof-negative');
  ok(silence.window_ms < 660000, `killed at ${silence.window_ms}`);
  assert.deepStrictEqual(run.error.liveness.proof, { capability: 'available', proof: 'negative' });
});

test('liveness/tool: Windows without CPU (unavailable/none) stays slow-suspect past 240000 and dies at 660001, not at the ceiling', async () => {
  const fake = fakeProof({ capability: 'unavailable', proof: 'none' });
  const fixture = toolFixture('claude tool unavailable fixture.js', { inputs: [privateInput()], result: false });
  // timeoutMs 905000 gives a 900000 ms child ceiling, above the 660000 tool maximum.
  const run = await runLive(fixture, acceleratedClock(400, { fromFirstRemote: true }),
    { localProofFactory: fake.factory, timeoutMs: 905000 });
  const silence = assertToolKill(run, 'tool-proof-unavailable-expired', { extension: 420000 });
  assert.notStrictEqual(run.error.code, 'claude-timeout');
  assert.notStrictEqual(run.error.liveness.termination, 'budget-exceeded-while-active');
  ok(silence.window_ms > 660000, `window ${silence.window_ms}`);
  const suspect = run.transitions.find(t => t.to === 'slow-suspect');
  ok(suspect && suspect.reason === 'proof-unavailable' && suspect.at_ms > 120000 && suspect.at_ms <= 240001,
    `slow-suspect/proof-unavailable expected: ${JSON.stringify(run.transitions)}`);
  const dead = run.transitions.find(t => t.to === 'dead');
  ok(dead && dead.at_ms > 660000 && dead.at_ms < 900000, `dead at ${dead && dead.at_ms}`);
  // Alive and slow-suspect at 240001: no transition between suspect and dead.
  assert.strictEqual(run.transitions.indexOf(dead), run.transitions.indexOf(suspect) + 1);
  assert.deepStrictEqual(run.error.liveness.proof, { capability: 'unavailable', proof: 'none' });
  ok(run.realMs < 4000, `real ${Math.round(run.realMs)} ms`);
});

test('liveness/tool: persistent positive proof dies after 660000 as tool-extension-exhausted', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'positive' });
  const fixture = toolFixture('claude tool exhausted fixture.js', { inputs: [privateInput()], result: false });
  const run = await runLive(fixture, acceleratedClock(400, { fromFirstRemote: true }),
    { localProofFactory: fake.factory, timeoutMs: 905000 });
  const silence = assertToolKill(run, 'tool-extension-exhausted', { extension: 420000 });
  ok(silence.window_ms > 660000, `window ${silence.window_ms}`);
  assert.deepStrictEqual(run.error.liveness.proof, { capability: 'available', proof: 'positive' });
});

test('liveness/tool: a ceiling below 660000 classifies with the current proof (positive tool stays working)', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'positive' });
  const fixture = toolFixture('claude tool ceiling fixture.js', { inputs: [privateInput()], result: false });
  // timeoutMs 205000 gives a 200000 ms child ceiling: the tool is in its
  // local-proof window (120000..240000), so it is active, never dead.
  const run = await runLive(fixture, acceleratedClock(300, { fromFirstRemote: true }),
    { localProofFactory: fake.factory, timeoutMs: 205000 });
  ok(run.error, 'expected the ceiling');
  assert.strictEqual(run.error.code, 'claude-timeout');
  assert.strictEqual(run.error.liveness.termination, 'budget-exceeded-while-active');
  assert.strictEqual(run.error.liveness.state, 'working');
  assert.strictEqual(run.error.liveness.reason, 'local-proof');
  assert.strictEqual(run.terminations, 1);
  assertPrivate(run);
});

test('liveness/tool: ceiling and tool deadline crossed in one tick keep budget-exceeded-while-active (R7)', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'none' });
  const fixture = toolFixture('claude tool both boundaries fixture.js', { inputs: [privateInput()], result: false });
  // One clock jump beyond both the 240000 ms ceiling and the 240000 ms tool deadline.
  const t0 = performance.now();
  let pivot = null;
  const clock = {
    now() {
      const real = performance.now();
      return pivot === null ? real - t0 : (real - t0) + (real - pivot > 400 ? 241000 : 0);
    },
    accelerate() { if (pivot === null) pivot = performance.now(); },
  };
  const run = await runLive(fixture, clock, { localProofFactory: fake.factory, timeoutMs: 245000 });
  ok(run.error, 'expected the ceiling');
  assert.strictEqual(run.error.code, 'claude-timeout');
  assert.strictEqual(run.error.liveness.termination, 'budget-exceeded-while-active');
  assert.strictEqual(run.error.liveness.state, 'slow-suspect');
});

test('liveness/tool: five identical tool calls without a write report no-progress once and never kill', async () => {
  const fake = fakeProof({ capability: 'available', proof: 'none' });
  const fixture = toolFixture('claude tool loop fixture.js', { inputs: Array(5).fill(privateInput()) });
  const run = await runLive(fixture, acceleratedClock(1, { fromFirstRemote: true }),
    { localProofFactory: fake.factory });
  assert.strictEqual(run.error, null, run.error && `${run.error.code} ${JSON.stringify(run.error.liveness)}`);
  assert.strictEqual(run.result.candidate.status, 'done');
  assert.strictEqual(run.terminations, 0);
  const loops = run.transitions.filter(t => t.reason === 'no-progress');
  assert.strictEqual(loops.length, 1, JSON.stringify(run.transitions));
  assert.strictEqual(loops[0].to, 'slow-suspect');
  assert.strictEqual(loops[0].progress.repeats, 5);
  ok(/^[0-9a-f]{16}$/.test(loops[0].progress.fingerprint_sha256), loops[0].progress.fingerprint_sha256);
  assert.deepStrictEqual(Object.keys(loops[0].progress).sort(), ['fingerprint_sha256', 'repeats']);
  assertPrivate(run);
});

test('liveness/tool: distinct tool calls, or a write between identical ones, report no no-progress', async () => {
  const distinct = await runLive(toolFixture('claude tool distinct fixture.js',
    { inputs: [0, 1, 2, 3, 4].map(n => privateInput({ step: n })) }),
  acceleratedClock(1, { fromFirstRemote: true }), { localProofFactory: fakeProof({ capability: 'available', proof: 'none' }).factory });
  assert.strictEqual(distinct.error, null, distinct.error && distinct.error.code);
  ok(!distinct.transitions.some(t => t.reason === 'no-progress'), JSON.stringify(distinct.transitions));

  const marker = path.join(WORKSPACE, 'claude-t04-write-marker.txt');
  try { fs.rmSync(marker, { force: true }); } catch { /* absent */ }
  const fake = fakeProof({ capability: 'available', proof: 'none' }, { writeWhen: () => fs.existsSync(marker) });
  const written = await runLive(toolFixture('claude tool write fixture.js',
    { inputs: Array(5).fill(privateInput()), pauseAfter: 3, sentinelFile: marker }),
  acceleratedClock(1, { fromFirstRemote: true }), { localProofFactory: fake.factory, localProofIntervalMs: 20 });
  fs.rmSync(marker, { force: true });
  assert.strictEqual(written.error, null, written.error && written.error.code);
  ok(fake.wrote, 'the fake provider observed the write between the 3rd and 4th call');
  ok(!written.transitions.some(t => t.reason === 'no-progress'), JSON.stringify(written.transitions));
});

test('liveness/tool: the provider gets pid/roots/ignore, samples off the watchdog tick and stops at finish', async () => {
  const extra = path.join(ROOT, 'writable extra root');
  fs.mkdirSync(extra, { recursive: true });
  const fast = fakeProof({ capability: 'unavailable', proof: 'none' });
  const ignored = path.join(ROOT, 'result.json');
  const run = await runLive(SLOW_FIXTURE, acceleratedClock(1, { fromFirstRemote: true }), {
    localProofFactory: fast.factory, localProofIntervalMs: 20,
    writableRoots: [extra, WORKSPACE], localProofIgnore: [ignored, 7, ignored] });
  assert.strictEqual(run.error, null, run.error && run.error.code);
  ok(Number.isSafeInteger(fast.options.pid) && fast.options.pid > 0, 'real child pid');
  assert.deepStrictEqual(fast.options.roots, [path.resolve(WORKSPACE), path.resolve(extra)]);
  assert.deepStrictEqual(fast.options.ignore, { prefixes: [path.resolve(ignored)] });
  assert.strictEqual(typeof fast.options.onWrite, 'function');
  ok(fast.samples > 1, `samples ${fast.samples}`);
  assert.strictEqual(fast.stops, 1);
  const settledSamples = fast.samples;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.strictEqual(fast.samples, settledSamples, 'sampling stops after finish');

  // A long cadence leaves only the initial sample even though the 25 ms
  // watchdog ticked many times: the tick reads current(), it never samples.
  const slow = fakeProof({ capability: 'unavailable', proof: 'none' });
  const readOnly = await runLive(SLOW_FIXTURE, acceleratedClock(1, { fromFirstRemote: true }), {
    localProofFactory: slow.factory, localProofIntervalMs: 600000, readOnly: true, writableRoots: [extra] });
  assert.strictEqual(readOnly.error, null, readOnly.error && readOnly.error.code);
  assert.strictEqual(slow.samples, 1);
  ok(slow.currents > 1, `current() reads ${slow.currents}`);
  assert.deepStrictEqual(slow.options.roots, []);
});

test('liveness/tool: an invalid localProofFactory or localProofIntervalMs is refused before any spawn', async () => {
  for (const extra of [{ localProofFactory: 'createLocalProof' }, { localProofIntervalMs: 0 },
    { localProofIntervalMs: 1.5 }, { localProofIntervalMs: '20' }]) {
    const records = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    await expectCode(adapter.invokeClaudeSidecar({ cwd: WORKSPACE, prompt: 'proof options', model: FIXTURE_MODEL,
      timeoutMs: 15000, sourceEnv: sourceEnvFor(HAPPY_FIXTURE), ...extra }),
    adapter.CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
    assert.strictEqual(records.length, 0);
  }
});

test('liveness/tool: a throwing or malformed provider reads as unavailable and never breaks the run', async () => {
  const run = await runLive(SLOW_FIXTURE, acceleratedClock(1, { fromFirstRemote: true }), {
    localProofFactory: () => ({ sample() { throw new Error('boom'); }, current() { return { capability: 'bogus' }; },
      stop() { throw new Error('boom'); } }), localProofIntervalMs: 20 });
  assert.strictEqual(run.error, null, run.error && run.error.code);
  const thrown = await runLive(SLOW_FIXTURE, acceleratedClock(1, { fromFirstRemote: true }), {
    localProofFactory: () => { throw new Error('cannot start'); } });
  assert.strictEqual(thrown.error, null, thrown.error && thrown.error.code);
});

test('liveness/tool: the real provider on a read-only turn scans no filesystem root and the result is accepted', async () => {
  const fsp = fs.promises;
  const original = { readdir: fsp.readdir, lstat: fsp.lstat };
  const touched = [];
  const inside = value => typeof value === 'string' && path.resolve(value).startsWith(path.resolve(ROOT));
  fsp.readdir = function (target, ...rest) { if (inside(target)) touched.push(target); return original.readdir.call(this, target, ...rest); };
  fsp.lstat = function (target, ...rest) { if (inside(target)) touched.push(target); return original.lstat.call(this, target, ...rest); };
  let run;
  try {
    run = await runLive(SLOW_FIXTURE, acceleratedClock(1, { fromFirstRemote: true }),
      { readOnly: true, localProofIntervalMs: 20 });
  } finally {
    fsp.readdir = original.readdir;
    fsp.lstat = original.lstat;
  }
  assert.strictEqual(run.error, null, run.error && run.error.code);
  assert.strictEqual(run.result.candidate.status, 'done');
  assert.deepStrictEqual(touched, []);
});

async function main() {
  let passed = 0;
  const failures = [];
  for (const entry of tests) {
    try {
      await entry.fn();
      passed++;
      console.log(`  \u2713 ${entry.name}`);
    } catch (error) {
      failures.push({ name: entry.name, error });
      console.log(`  \u2717 ${entry.name}: ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().finally(() => {
  if (PREVIOUS_REGISTRY === undefined) delete process.env.FORGE_ACCOUNTS_REGISTRY;
  else process.env.FORGE_ACCOUNTS_REGISTRY = PREVIOUS_REGISTRY;
  try { REAL_RM_SYNC(ROOT, { recursive: true, force: true }); } catch { /* test cleanup */ }
});
