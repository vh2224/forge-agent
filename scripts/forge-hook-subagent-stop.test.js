#!/usr/bin/env node
'use strict';

// Contract tests for the native Claude Code SubagentStop repair loop.
// A malformed Forge worker gets one in-context correction; unrelated agents
// and the second hook pass remain fail-open.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hookPath = path.join(__dirname, 'forge-hook.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-subagent-stop-'));
let passed = 0;

function run(input, script = hookPath, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, 'subagent-stop'], {
    cwd,
    input: JSON.stringify({
      session_id: `subagent-stop-test-${process.pid}`,
      cwd,
      ...input,
    }),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

try {
  test('known Forge worker without result block is kept alive', () => {
    const output = run({
      agent_type: 'forge-executor',
      stop_hook_active: false,
      last_assistant_message: 'Implemented and verified the task.',
    });
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.decision, 'block');
    assert.match(parsed.reason, /GSD-WORKER-RESULT/);
    assert.match(parsed.reason, /forge-executor/);
    const live = JSON.parse(fs.readFileSync(
      path.join(os.tmpdir(), `forge-live-subagent-stop-test-${process.pid}.json`),
      'utf8',
    ));
    assert.strictEqual(live.status, 'repairing-contract');
  });

  test('valid Forge worker result is allowed', () => {
    const output = run({
      agent_type: 'forge-planner',
      stop_hook_active: false,
      last_assistant_message: '---GSD-WORKER-RESULT---\nstatus: done\nsummary: planned',
    });
    assert.strictEqual(output, '');
  });

  test('invalid status gets complete-answer feedback with the classifier enum', () => {
    for (const status of ['complete', 'ok', '']) {
      const parsed = JSON.parse(run({ agent_type: 'forge-researcher', stop_hook_active: false,
        last_assistant_message: `Research retained.\n---GSD-WORKER-RESULT---\nstatus: ${status}` }));
      assert.strictEqual(parsed.decision, 'block');
      assert(parsed.reason.includes(require('./forge-worker-result').resultStatusInstruction()));
      assert(parsed.reason.includes('COMPLETE final answer'));
      assert(parsed.reason.includes('Do not re-run tools'));
    }
    for (const status of ['done', 'partial', 'blocked']) assert.strictEqual(run({ agent_type: 'forge-researcher',
      last_assistant_message: `---GSD-WORKER-RESULT---\nstatus: ${status}` }), '');
  });

  test('both installed hook paths load the same result classifier', () => {
    for (const explicit of [true, false]) {
      const userHome = path.join(cwd, explicit ? 'explicit-user' : 'default-user');
      const home = path.join(userHome, '.claude');
      const forgeHome = explicit ? path.join(cwd, 'separate Forge core') : path.join(userHome, '.forge-agent');
      fs.mkdirSync(path.join(forgeHome, 'scripts'), { recursive: true });
      for (const file of ['forge-worker-result.js', 'forge-home.js']) fs.copyFileSync(path.join(__dirname, file), path.join(forgeHome, 'scripts', file));
      const env = { HOME: userHome, USERPROFILE: userHome, FORGE_HOME: explicit ? forgeHome : '' };
      for (const relative of ['forge-hook.js', 'hooks/forge-hook.js']) {
        const installed = path.join(home, relative);
        fs.mkdirSync(path.dirname(installed), { recursive: true });
        fs.copyFileSync(hookPath, installed);
        assert(!fs.existsSync(path.join(home, 'scripts')), 'the retired Claude-home runtime is absent');
        const response = JSON.parse(run({ agent_type: 'forge-researcher',
          last_assistant_message: '---GSD-WORKER-RESULT---\nstatus: complete' }, installed, env));
        assert.strictEqual(response.decision, 'block');
        assert(response.reason.includes(require('./forge-worker-result').resultStatusInstruction()));
        assert.strictEqual(run({ agent_type: 'forge-researcher', last_assistant_message: '---GSD-WORKER-RESULT---\nstatus: done' }, installed, env), '');
      }
    }
  });

  test('second hook pass is an escape hatch', () => {
    const output = run({
      agent_type: 'forge-reviewer',
      stop_hook_active: true,
      last_assistant_message: 'still malformed',
    });
    assert.strictEqual(output, '');
  });

  test('command-only forge-memory agent is not blocked', () => {
    const output = run({
      agent_type: 'forge-memory',
      stop_hook_active: false,
      last_assistant_message: '',
    });
    assert.strictEqual(output, '');
  });

  test('unrelated custom agents are not blocked', () => {
    const output = run({
      agent_type: 'code-reviewer',
      stop_hook_active: false,
      last_assistant_message: '',
    });
    assert.strictEqual(output, '');
  });

  // ── Failing open is not the same as succeeding ─────────────────────────────
  // The escape hatch must stay (no infinite hook loop), but a worker that never
  // emitted its contract must not be recorded as `done`: that stamps "finished"
  // onto the artifact whose whole job is to tell finished from truncated.

  const liveFile = path.join(os.tmpdir(), `forge-live-subagent-stop-test-${process.pid}.json`);
  const missFile = path.join(cwd, '.gsd', 'forge', 'contract-miss.jsonl');
  const readLive = () => JSON.parse(fs.readFileSync(liveFile, 'utf8'));
  const readMisses = () => fs.readFileSync(missFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

  test('no .gsd/forge → nothing is recorded and no directory is scaffolded', () => {
    run({ agent_type: 'forge-executor', stop_hook_active: true, last_assistant_message: 'cut off' });
    assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd')), false,
      'the hook created .gsd in a repo that is not a Forge project');
  });

  fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });

  test('invalid-status escape remains bounded and records a miss instead of done', () => {
    const before = fs.existsSync(missFile) ? readMisses().length : 0;
    assert.strictEqual(run({ agent_type: 'forge-researcher', stop_hook_active: true,
      last_assistant_message: 'Research retained.\n---GSD-WORKER-RESULT---\nstatus: complete' }), '');
    assert.strictEqual(readLive().status, 'contract-missed');
    assert.strictEqual(readMisses().length, before + 1);
    assert.strictEqual(readMisses().at(-1).phase, 'escaped');
  });

  test('the escape pass records `contract-missed`, not `done`', () => {
    const output = run({
      agent_type: 'forge-executor',
      agent_id: 'a4e38a47da744d58b',
      stop_hook_active: true,
      last_assistant_message: 'Implemented T05 and then the message stops mid-sen',
    });
    assert.strictEqual(output, '', 'the escape must still fail open');
    assert.strictEqual(readLive().status, 'contract-missed');

    const misses = readMisses();
    const last = misses[misses.length - 1];
    assert.strictEqual(last.phase, 'escaped');
    assert.strictEqual(last.agent_type, 'forge-executor');
    assert.strictEqual(last.agent_id, 'a4e38a47da744d58b',
      'the agent id is the only handle on a resume — it must survive');
    assert.ok(last.tail.endsWith('mid-sen'), 'the tail must show where the message stopped');
  });

  test('the first (blocking) pass is recorded too, under its own phase', () => {
    const before = readMisses().length;
    run({ agent_type: 'forge-planner', stop_hook_active: false, last_assistant_message: 'no block' });
    const misses = readMisses();
    assert.strictEqual(misses.length, before + 1);
    assert.strictEqual(misses[misses.length - 1].phase, 'repair-requested');
  });

  test('an escape whose worker DID emit the block is a plain `done`', () => {
    const before = readMisses().length;
    run({
      agent_type: 'forge-executor',
      stop_hook_active: true,
      last_assistant_message: 'fixed it\n---GSD-WORKER-RESULT---\nstatus: done',
    });
    assert.strictEqual(readLive().status, 'done');
    assert.strictEqual(readMisses().length, before, 'a repaired worker was recorded as a miss');
  });

  test('agents outside the contract set are never recorded as missing it', () => {
    const before = readMisses().length;
    run({ agent_type: 'forge-memory', stop_hook_active: true, last_assistant_message: '' });
    run({ agent_type: 'code-reviewer', stop_hook_active: true, last_assistant_message: '' });
    assert.strictEqual(readLive().status, 'done');
    assert.strictEqual(readMisses().length, before);
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
  try {
    fs.rmSync(path.join(os.tmpdir(), `forge-live-subagent-stop-test-${process.pid}.json`), { force: true });
  } catch {}
}
