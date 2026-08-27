#!/usr/bin/env node
// forge-claude-sidecar.test.js — private-process and credential-boundary tests.
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-sidecar-test-'));
const WORKSPACE = path.join(ROOT, 'workspace with spaces Ω');
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

const HAPPY_FIXTURE = writeFixture('claude happy fixture.js', `
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const tokenKey = ${JSON.stringify(TOKEN_ENV)};
const expectedToken = ${JSON.stringify(FIXTURE_TOKEN)};
const args = process.argv.slice(2);
const instruction = args[args.indexOf('-p') + 1] || '';
const prefix = 'Read the complete task prompt from this UTF-8 file: ';
const suffix = '. Follow it exactly and finish with its required worker-result block.';
const promptPath = JSON.parse(instruction.slice(prefix.length, instruction.length - suffix.length));
const prompt = fs.readFileSync(promptPath, 'utf8');
const tokenSafe = process.env[tokenKey] === expectedToken
  && !args.some((arg) => String(arg).includes(expectedToken));
const digest = crypto.createHash('sha256').update(prompt).digest('hex');
function block(status, payload) {
  return ['---GSD-WORKER-RESULT---', 'status: ' + status,
    'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n');
}
process.stdout.write(block('blocked', {
  status: 'blocked', summary: 'decoy', must_haves_status: [], files_changed: []
}));
process.stdout.write(block('done', {
  status: 'done', summary: (tokenSafe ? 'prompt-sha256:' : 'fixture-boundary-failed:') + digest,
  must_haves_status: [{ item: 'fixture', status: 'met', note: 'observed', scope: 'task', reason: '' }],
  files_changed: ['fixture-output.txt']
}));
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
const payload = { status: 'partial', summary: 'mismatch', must_haves_status: [], files_changed: [] };
process.stdout.write(['---GSD-WORKER-RESULT---', 'status: done',
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n'));
`);

const ABSENT_FIXTURE = writeFixture('claude absent fixture.js', `
'use strict';
process.stdout.write('ordinary prose without a worker result');
`);

const TIMEOUT_FIXTURE = writeFixture('claude timeout fixture.js', `
'use strict';
const payload = { status: 'done', summary: 'must be discarded', must_haves_status: [], files_changed: [] };
process.stdout.write(['---GSD-WORKER-RESULT---', 'status: done',
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n'));
setInterval(() => {}, 1000);
`);

// Stays alive well past several heartbeat intervals before answering, so a
// single beat at spawn is distinguishable from a real cadence.
const SLOW_FIXTURE = writeFixture('claude slow fixture.js', `
'use strict';
const payload = { status: 'done', summary: 'slow but healthy',
  must_haves_status: [], files_changed: [] };
setTimeout(() => {
  process.stdout.write(['---GSD-WORKER-RESULT---', 'status: done',
    'result_json: ' + JSON.stringify(payload), '---END-RESULT---', ''].join('\\n'));
}, 400);
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

test('happy path uses file transport, child-only token env, and the last marker', async () => {
  const calls = [];
  const records = [];
  const adapter = loadAdapter({
    resolver: (...args) => { calls.push(args); return FIXTURE_ACCOUNT; },
    spawnImpl: recordingSpawn(records),
  });
  const prompt = `large-prompt-sentinel:${'abc123\n'.repeat(12000)}`;
  const digest = crypto.createHash('sha256').update(prompt).digest('hex');
  const result = await adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt, timeoutMs: 15000, sourceEnv: sourceEnvFor(HAPPY_FIXTURE),
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
  assert.strictEqual(result.metadata.marker_count, 2);
  assert.strictEqual(result.metadata.exit_code, 0);
  ok(result.metadata.stdout_bytes <= adapter.MAX_CAPTURE_BYTES_PER_STREAM, 'stdout was not bounded');
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
      cwd: WORKSPACE, prompt: 'nonzero', timeoutMs: 10000, sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO);
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
    cwd: WORKSPACE, prompt: 'missing command', timeoutMs: 10000,
    sourceEnv: sourceEnvFor(missing),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.COMMAND_NOT_FOUND);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('exit zero plus whitespace-only stdout is never a silent success', async () => {
  const records = [];
  const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
  await expectCode(adapter.invokeClaudeSidecar({
    cwd: WORKSPACE, prompt: 'empty', timeoutMs: 10000, sourceEnv: sourceEnvFor(EMPTY_FIXTURE),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(tempPromptDirs(), []);
});

test('status mismatch and absent worker blocks are invalid results', async () => {
  for (const fixture of [INVALID_FIXTURE, ABSENT_FIXTURE]) {
    const records = [];
    const adapter = loadAdapter({ spawnImpl: recordingSpawn(records) });
    await expectCode(adapter.invokeClaudeSidecar({
      cwd: WORKSPACE, prompt: 'invalid', timeoutMs: 10000, sourceEnv: sourceEnvFor(fixture),
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
      cwd: WORKSPACE, prompt: 'primary wins', timeoutMs: 10000,
      sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
    }), adapter.CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO);
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
    cwd: WORKSPACE, prompt: 'nonzero', timeoutMs: 10000, heartbeatIntervalMs: 20,
    onHeartbeat: (pid) => { beats.push(pid); },
    sourceEnv: sourceEnvFor(NONZERO_FIXTURE),
  }), adapter.CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO);
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
        cwd: WORKSPACE, prompt: 'prompt io', timeoutMs: 10000,
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
