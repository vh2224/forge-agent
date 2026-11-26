#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const headless = require('./forge-headless.js');

const fake = path.join(__dirname, 'fixtures', 'hooks-headless', 'fake-jsonl-cli.js');
let passed = 0;
async function test(name, fn) { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function base(root, runtime, scenario = 'success') {
  return { runtime, dispatchId: `dispatch-${runtime}`, workspaceRoot: root, cwd: root, sandbox: 'workspace-write', approval: 'never', binary: { command: process.execPath, args: [fake, scenario] }, prompt: 'PROMPT_SENTINEL', env: { ...process.env, SECRET_TOKEN: 'ENV_SENTINEL' }, timeoutMs: 1500 };
}

// Controlled owned ChildProcess seam: real Writable emits async EPIPE, no OS child.
async function earlyStdin(root, runtime, { exitCode, partial = false, synchronous = false, programmer = false }) {
  const { EventEmitter } = require('events'), { PassThrough, Writable } = require('stream');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let resolved = false, closeObserved = false, kills = 0, closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; });
  child.kill = () => { kills++; };
  const finish = () => setImmediate(() => {
    assert.strictEqual(resolved, false, 'pipe error alone must not settle the operation');
    closeObserved = true; child.emit('close', exitCode, null); closeResolve();
  });
  const failure = () => Object.assign(new Error('PROMPT_SENTINEL ENV_SENTINEL private stdin error'), { code: 'EPIPE' });
  if (synchronous || programmer) {
    child.stdin = new EventEmitter();
    child.stdin.end = () => { finish(); if (programmer) throw new TypeError('private programmer error'); throw failure(); };
  } else child.stdin = new Writable({ write(_chunk, _encoding, callback) {
    if (partial) {
      const values = runtime === 'codex'
        ? [{ type: 'thread.started', thread_id: 'pipe-thread' }, { type: 'item.completed', item: { type: 'agent_message', text: 'partial-safe' } }, { type: 'usage', usage: { input_tokens: 2, output_tokens: 1 } }]
        : [{ type: 'system', subtype: 'init', session_id: 'pipe-session' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'partial-safe' }], usage: { input_tokens: 2, output_tokens: 1 } } }];
      child.stdout.write(values.map(value => JSON.stringify(value) + '\n').join(''));
    }
    callback(failure()); finish();
  } });
  const pending = headless.run(base(root, runtime), { spawn() { return child; } });
  if (programmer) {
    await assert.rejects(pending, TypeError); await closed; assert.strictEqual(kills, 0); return;
  }
  pending.then(() => { resolved = true; });
  const result = await pending; await closed;
  assert.strictEqual(closeObserved, true); assert.strictEqual(kills, 0);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.reason_code, runtime + (exitCode === 0 ? '-orphan' : '-exit-nonzero'));
  assert.deepStrictEqual(result.stdin_error, { stage: 'stdin-write', code: 'EPIPE', child_close: { exit_code: exitCode, signal: null } });
  assert.strictEqual(Object.hasOwn(result, 'provider_called'), false, 'pipe reset is not evidence of a provider call or no-spawn');
  assert(!JSON.stringify(result).includes('PROMPT_SENTINEL')); assert(!JSON.stringify(result).includes('ENV_SENTINEL'));
  if (partial) { assert.strictEqual(result.output, 'partial-safe'); assert.strictEqual(result.usage.input_tokens, 2); assert.strictEqual(result.usage.output_tokens, 1); }
  const before = JSON.stringify(result);
  assert.doesNotThrow(() => child.stdin.emit('error', failure()), 'late owned stream error remains handled');
  assert.strictEqual(JSON.stringify(result), before, 'late error cannot rewrite earlier result');
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless Ω-'));
  try {
    for (const runtime of ['claude', 'codex']) {
      await test(runtime + ' owned stdin EPIPE waits for actual close and preserves failure/partial result', async () => {
        for (const config of [{ exitCode: 0 }, { exitCode: 7 }, { exitCode: 7, partial: true }, { exitCode: 7, synchronous: true }])
          await earlyStdin(root, runtime, config);
      });
    }
    await test('unrelated synchronous stdin programmer error still rejects', () => earlyStdin(root, 'codex', { exitCode: 7, programmer: true }));
    for (const platform of ['win32', 'darwin', 'linux']) {
      await test(`${platform} invocation is argv-only, sandboxed and offline`, async () => {
        const invocation = headless.buildInvocation({ ...base(root, 'codex'), platform, claudeHome: path.join(root, 'absent-claude'), codexHome: path.join(root, 'absent-codex') });
        assert.strictEqual(invocation.command, process.execPath);
        assert.strictEqual(invocation.shell, false);
        assert(invocation.args.includes('--sandbox') && invocation.args.includes('workspace-write'));
        assert(invocation.args.includes('--ask-for-approval') && invocation.args.includes('never'));
        assert(!invocation.args.includes('PROMPT_SENTINEL'));
        assert.strictEqual(invocation.env.SECRET_TOKEN, undefined);
      });
    }
    for (const runtime of ['claude', 'codex']) {
      await test(`${runtime} JSONL success has one normalized terminal`, async () => {
        const result = await headless.run(base(root, runtime));
        assert.strictEqual(result.status, 'succeeded');
        assert.strictEqual(result.events.filter((event) => event.type === 'terminal').length, 1);
        assert(!JSON.stringify(result.events).includes('PROMPT_SENTINEL'));
      });
      await test(`${runtime} malformed and truncated JSONL fail closed`, async () => {
        for (const scenario of ['malformed', 'truncated']) {
          const result = await headless.run(base(root, runtime, scenario));
          assert.strictEqual(result.reason_code, 'output-invalid');
        }
      });
      await test(`${runtime} timeout terminates only the owned child`, async () => {
        const result = await headless.run({ ...base(root, runtime, 'timeout'), timeoutMs: 60 });
        assert.strictEqual(result.reason_code, `${runtime}-timeout`);
      });
      await test(`${runtime} orphan has a terminal S06-style reason`, async () => {
        const result = await headless.run(base(root, runtime, 'orphan'));
        assert.strictEqual(result.reason_code, `${runtime}-orphan`);
      });
      await test(`${runtime} credential sentinel is redacted from result and telemetry`, async () => {
        const result = await headless.run({ ...base(root, runtime, 'secret'), redactValues: ['TOKEN_SENTINEL'] });
        assert(!JSON.stringify(result).includes('TOKEN_SENTINEL'));
        assert(result.output.includes('[REDACTED]'));
      });
    }
    await test('resume and partial usage preserve identity/counters without duplicate events', async () => {
      const resume = await headless.run(base(root, 'codex', 'resume'));
      assert.strictEqual(resume.resume, 'thread-resume');
      const partial = await headless.run(base(root, 'codex', 'partial'));
      assert.deepStrictEqual(partial.usage, { input_tokens: 5, output_tokens: 5, cached_tokens: 0 });
      const parser = new headless.JsonlParser({ runtime: 'codex', dispatchId: 'd' });
      const start = JSON.stringify({ type: 'thread.started', event_id: 'same' });
      parser.push(`${start}\n${start}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
      assert.strictEqual(parser.finish().events.length, 2);
    });
    await test('dispatch/protocol mismatch is output-invalid', async () => {
      const parser = new headless.JsonlParser({ runtime: 'codex', dispatchId: 'expected' });
      assert.throws(() => parser.push(`${JSON.stringify({ protocol_version: '9', dispatch_id: 'other', type: 'start' })}\n`), (error) => error.reason_code === 'output-invalid');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write(`\n${passed} passed, 0 failed\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
