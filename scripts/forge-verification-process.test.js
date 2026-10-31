#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWindowsRunner, runWindowsCommand } = require('./forge-verification-process');

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function mockRunner(change = row => row) {
  const calls = [];
  const run = createWindowsRunner({ spawnSyncImpl(_file, args, options) {
    calls.push({ mode: args.at(-1), options });
    if (args.at(-1) === 'Compile') return { status: 0, stdout: JSON.stringify({ schema: 1, assembly: 'YWJj' }) };
    const packet = JSON.parse(options.input);
    const outcome = change({ started: true, joined: true, active: 0, status: 0, timedOut: false, overflow: false,
      reason: 'joined', stdout: Buffer.from('ok').toString('base64'), stderr: '', pid: 42 });
    return { status: 0, pid: 41, stdout: JSON.stringify({ schema: 1, nonce: packet.nonce, outcome }) };
  } });
  return { calls, run };
}
const options = { cwd: process.cwd(), env: { EXAMPLE: 'value' }, timeoutMs: 500 };
{
  const f = mockRunner();
  assert.strictEqual(f.run('first', options).stdout, 'ok');
  assert.strictEqual(f.run('second', options).cleanup.status, 'joined');
  assert.deepStrictEqual(f.calls.map(c => c.mode), ['Compile', 'Run', 'Run']);
  assert.strictEqual(f.calls[1].options.env, options.env);
  assert.strictEqual(JSON.parse(f.calls[2].options.input).command, 'second');
  assert.notStrictEqual(JSON.parse(f.calls[1].options.input).nonce, JSON.parse(f.calls[2].options.input).nonce);
  console.log('PASS protocol: private compiled bytes reused, environment and command preserved, fresh job identity');
}
for (const change of [row => ({ ...row, joined: false, active: 1 }), row => ({ ...row, active: 1 }),
  row => ({ ...row, stdout: 'not base64' })]) {
  const result = mockRunner(change).run('fixture', options);
  assert.strictEqual(result.stop, true); assert.strictEqual(result.cleanup.status, 'unproved');
}
{
  let calls = 0;
  const run = createWindowsRunner({ spawnSyncImpl() { calls++; return { status: 1, stdout: '{}' }; } });
  const result = run('fixture', options);
  assert.strictEqual(calls, 1); assert.strictEqual(result.cleanup.started, false); assert.strictEqual(result.cleanup.status, 'unproved');
  assert.strictEqual(result.stop, true);
  assert.strictEqual(run('fixture', { ...options, timeoutMs: -1 }).cleanup.started, false);
  assert.strictEqual(run('prefix\0ignored verification', options).cleanup.started, false);
  assert.strictEqual(run('fixture', { ...options, cwd: options.cwd + '\0foreign' }).cleanup.started, false);
  assert.strictEqual(calls, 1, 'invalid command/cwd must not invoke compiler or process');
  console.log('PASS failed compile/preflight launches no requested command; unknown join/protocol never declares stopped');
}
if (process.platform === 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verification-job-'));
  try {
    const child = path.join(dir, 'child.cjs'), beat = path.join(dir, 'heartbeat.txt');
    fs.writeFileSync(child, `const cp=require('child_process'),fs=require('fs');
if(process.argv[2]==='writer'){fs.appendFileSync(process.argv[3],'start\\n');setInterval(()=>fs.appendFileSync(process.argv[3],'tick\\n'),20);}
else {cp.spawn(process.execPath,[__filename,'writer',process.argv[3]],{stdio:'ignore',windowsHide:true,detached:process.argv[2]==='orphan'});if(process.argv[2]==='orphan')process.exit(0);}
`);
    const command = mode => `node child.cjs ${mode} heartbeat.txt`;
    for (const mode of ['parent', 'orphan']) {
      const result = runWindowsCommand(command(mode), { cwd: dir, env: process.env, timeoutMs: 1200 });
      assert.strictEqual(result.error?.code, 'ETIMEDOUT', JSON.stringify({ status: result.status, stderr: result.stderr, cleanup: result.cleanup })); assert.strictEqual(result.cleanup.status, 'joined');
      assert.strictEqual(result.cleanup.active_processes, 0); assert(fs.existsSync(beat), 'owned descendant actually wrote');
      const bytes = fs.readFileSync(beat); pause(150); assert.deepStrictEqual(fs.readFileSync(beat), bytes);
      fs.unlinkSync(beat);
      console.log(`PASS real Windows ${mode}: descendant heartbeat stops before joined return`);
    }
    fs.writeFileSync(path.join(dir, 'exit.cjs'), "console.log(process.env.FORGE_VERIFY_EXAMPLE);console.error('stderr');process.exit(7);");
    const normal = runWindowsCommand('node exit.cjs', { cwd: dir, env: { ...process.env, FORGE_VERIFY_EXAMPLE: 'unicode Ω' }, timeoutMs: 5000 });
    assert.strictEqual(normal.status, 7); assert(normal.stdout.includes('unicode Ω')); assert(normal.stderr.includes('stderr'));
    const unicode = path.join(dir, 'space Ω'); fs.mkdirSync(unicode);
    fs.writeFileSync(path.join(unicode, 'unicode.cjs'), "console.log('unicode Ω');");
    const utf = runWindowsCommand('node unicode.cjs', { cwd: unicode, env: process.env, timeoutMs: 5000 });
    assert.strictEqual(utf.status, 0); assert(utf.stdout.includes('unicode Ω'));
    const bin = path.join(dir, 'quoted bin'); fs.mkdirSync(bin);
    const executable = path.join(bin, 'cmd.exe'), argument = path.join(dir, 'quoted argument.txt');
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), executable);
    fs.writeFileSync(argument, 'quoted path success');
    const quoted = runWindowsCommand(`"${executable}" /c type "${argument}"`, { cwd: dir, env: process.env, timeoutMs: 5000 });
    assert.strictEqual(quoted.status, 0, quoted.stderr); assert(quoted.stdout.includes('quoted path success'));
    console.log('PASS quoted executable path with spaces and a quoted argument through actual Windows shell');
    const large = runWindowsCommand('node -e "process.stdout.write(Buffer.alloc(1200000,65))"', { cwd: dir, env: process.env, timeoutMs: 5000 });
    assert.strictEqual(large.error?.code, 'ENOBUFS'); assert.strictEqual(large.cleanup.status, 'joined'); assert.strictEqual(large.stop, true);
    const marker = path.join(dir, 'following.txt'); let released = 0, releaseHeartbeat;
    const gate = require('./forge-verify').runVerificationGate({ cwd: dir, commandTimeoutMs: 1200,
      preferenceCommands: [command('parent'), 'node -e "require(\'fs\').writeFileSync(\'following.txt\',\'ran\')"'], resourceEventSink() {},
      requireCommandRewrite: () => ({ looksLikeRunnerCommand: () => true, planRewrite: c => ({ outcome: 'rewritten', command: c, reason: 'fixture', runner: 'fixture' }) }),
      requireResources: () => ({ acquireCommandBudget: () => ({ workers: 1, heapMb: 512, pool: { handle: { slots: [1] } } }),
        releaseCommandBudget() { released++; releaseHeartbeat = fs.readFileSync(beat); pause(100); assert.deepStrictEqual(fs.readFileSync(beat), releaseHeartbeat); } }) });
    assert.strictEqual(gate.passed, false); assert.strictEqual(gate.checks.length, 1); assert.strictEqual(gate.checks[0].exitCode, 124);
    assert.strictEqual(released, 1); assert.strictEqual(fs.existsSync(marker), false);
    assert.deepStrictEqual(fs.readFileSync(beat), releaseHeartbeat); assert.strictEqual(gate.checks[0].cleanup.status, 'joined');
    assert.strictEqual(gate.stopped.not_run.length, 1);
    console.log('PASS actual gate: descendant stopped before budget release, timeout prevents following command');
    console.log('PASS real Windows nonzero status, Unicode cwd/environment/stdout and bounded overflow join');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else console.log('SKIP actual Windows job fixtures on this platform; protocol checks ran');
console.log('forge-verification-process checks passed');
