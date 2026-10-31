#!/usr/bin/env node
'use strict';

// Fake executables only (run by process.execPath): no provider, no network, no
// credentials. Proves adapter behavior, not real-provider compatibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test: nodeTest, after } = require('node:test');
const transport = require('./forge-agy-transport');
const xllm = require('./forge-xllm');

// Emit only after this test's behavioral assertions finish successfully.
function test(name, run) {
  return nodeTest(name, async (...args) => {
    await run(...args);
    process.stdout.write(`PASS agy-transport: ${name}\n`);
  });
}

const { createPromptFile, probeAgyCapabilities, parseAgyHelp, planAgyArgs, runAgyStream,
  AGY_REASON_CODES, AGY_LIVENESS, CAPABILITY_SOURCES, EFFORT_VALUES } = transport;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agy-transport-'));
const strays = new Set();
after(() => {
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

const STREAM_HELP = [
  'Usage: agy [options]', '', 'Options:',
  '  -p, --print <prompt>       Run headless',
  '  --output-format <format>   Output format for print mode: text, json, stream-json',
  '  --effort <level>           Reasoning effort: low, medium, high',
  '  --sandbox                  Restrict terminal access', ''].join('\n');
const LEGACY_HELP = ['Usage: agy [options]', '', 'Options:', '  -p, --print <prompt>  Run headless',
  '  --sandbox             Restrict terminal access', ''].join('\n');
// A fast policy (all values below DEFAULTS, as normalizePolicy requires).
const POLICY = { startMs: 1000, suspectMs: 400, deadMs: 800, toolExtensionMs: 800 };

let counter = 0;
function dir(label) {
  const value = path.join(root, `${label}-${++counter}`);
  fs.mkdirSync(value, { recursive: true });
  return value;
}

/** Write a fake agy. Events are [line|object, delayMs] pairs emitted in order. */
function fixture(options = {}) {
  const base = dir('fixture');
  const file = path.join(base, 'agy.js');
  const log = path.join(base, 'calls.log');
  const pidFile = path.join(base, 'grandchild.pid');
  const events = (options.events || []).map(([line, delay]) => [typeof line === 'string' ? line : JSON.stringify(line), delay || 0]);
  fs.writeFileSync(file, [
    "'use strict';",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));`,
    "if (args.includes('--help')) {",
    `  ${options.helpSleepMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.helpSleepMs});` : ''}`,
    `  process.stdout.write(${JSON.stringify(options.help ?? STREAM_HELP)}.repeat(${options.helpRepeat || 1}));`,
    `  ${options.helpAfterWriteMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.helpAfterWriteMs});` : ''}`,
    `  process.exit(${options.helpExit || 0});`,
    '}',
    `const inline = args[args.indexOf('-p') + 1] || '';`,
    "const match = inline.match(/Read the file at (.+?) and follow/);",
    "let prompt = null; try { prompt = match ? fs.readFileSync(match[1], 'utf8') : null; } catch {}",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, args, prompt }) + '\\n');`,
    '(async () => {',
    options.startDelayMs ? `  await sleep(${options.startDelayMs});` : '',
    options.grandchild ? [
      "  require('child_process').spawn(process.execPath, ['-e',",
      `    ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}],`,
      `    { stdio: 'ignore', windowsHide:true, detached:${options.grandchildDetached===true} });`,
      `  while (!fs.existsSync(${JSON.stringify(pidFile)})) await sleep(20);`,
    ].join('\n') : '',
    `  for (const [line, delay] of ${JSON.stringify(events)}) { if (delay) await sleep(delay); process.stdout.write(line + '\\n'); }`,
    options.raw ? `  process.stdout.write(${JSON.stringify(options.raw)});` : '',
    options.flood ? `  process.stdout.write(Buffer.alloc(${options.flood}, 0x61));` : '',
    options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
    options.sleepMs ? `  await sleep(${options.sleepMs});` : '',
    `  process.exit(${options.exitCode || 0});`,
    '})();', ''].join('\n'));
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const grandchild = () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
  return { file, calls, grandchild };
}

function deps(fake, overrides = {}) {
  return { resolveCommand: () => ({ cmd: process.execPath, prefixArgs: [fake.file] }),
    buildSidecarEnv: xllm.buildSidecarEnv, terminateChild: xllm.terminateOwnedProcessTree,
    assertSafeForCmdShell: xllm.assertSafeForCmdShell, ...overrides };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  return !alive(pid);
}

function promptDirs(cwd) {
  return fs.readdirSync(cwd).filter(name => name.startsWith('.forge-xllm-'));
}

const init = { event: 'init', conversation_id: 'conv-1' };
const stepUpdate = (index, state, type, text) => ({ event: 'step_update',
  step_update: { conversation_id: 'conv-1', step_index: index, state, step_type: type, ...(text ? { text } : {}) } });
const success = response => ({ event: 'result', conversation_id: 'conv-1', status: 'SUCCESS', response });
const REVIEW = JSON.stringify({ objections: [] });

function stream(fake, extra = {}) {
  const cwd = extra.cwd || dir('cwd');
  return runAgyStream(deps(fake, extra.deps), { cwd, args: ['--sandbox', '-p', 'x', '--print-timeout', `${extra.timeoutSecs || 30}s`,
    '--output-format', 'stream-json'], timeoutSecs: extra.timeoutSecs || 30, livenessPolicy: POLICY,
  livenessIntervalMs: 25, clock: extra.clock, exitWaitMs: extra.exitWaitMs, signal: extra.signal, onHeartbeat: extra.onHeartbeat,
  onLiveness: extra.onLiveness, processSignals: extra.processSignals });
}

// These fixtures test post-start behavior, not OS scheduling. Keep logical time
// at zero until an actual output chunk arrives, then measure real silence.
function afterFirstOutput() {
  let first = null;
  return { clock: () => first === null ? 0 : performance.now() - first,
    deps: { spawn(cmd, args, options) {
      const child = spawn(cmd, args, options);
      child.stdout.prependOnceListener('data', () => { first = performance.now(); });
      return child;
    } } };
}
function grandchildReady(fake) {
  return new Promise((resolve, reject) => {
    let watcher, timer;
    const finish = (error, pid) => { clearTimeout(timer); watcher?.close(); error ? reject(error) : resolve(pid); };
    const inspect = () => { const pid = fake.grandchild(); if (Number.isInteger(pid) && pid > 0) finish(null, pid); };
    watcher = fs.watch(path.dirname(fake.file), inspect);
    watcher.once('error', error => finish(error));
    timer = setTimeout(() => finish(new Error('fixture grandchild did not become ready')), 10000);
    inspect();
  });
}

async function rejectsWith(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert(caught, `expected rejection with ${code}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

async function rejectsAfterClose(promise,code,reason){
  const error=await rejectsWith(promise,process.platform==='win32'?'agy-process-exit-unconfirmed':code);
  if(process.platform==='win32'){assert.equal(error.ownership_pending,true);assert.equal(error.cause_code,code);}
  else if(reason)assert.equal(error.diagnostic.reason,reason);
  return error;
}

// ── Module boundary ──────────────────────────────────────────────────────────

test('new agy modules load with every other provider module poisoned', () => {
  const poisoned = ['forge-claude-sidecar', 'forge-appserver-client', 'forge-claude-stream', 'forge-claude-session',
    'forge-appserver-liveness', 'forge-xllm'];
  const script = [
    "const Module = require('module'); const load = Module._load;",
    `const poisoned = ${JSON.stringify(poisoned)};`,
    "Module._load = function (request) { if (poisoned.some(name => String(request).includes(name))) throw new Error('poisoned ' + request); return load.apply(this, arguments); };",
    `require(${JSON.stringify(path.join(__dirname, 'forge-agy-stream.js'))});`,
    `const t = require(${JSON.stringify(path.join(__dirname, 'forge-agy-transport.js'))});`,
    "process.stdout.write(typeof t.runAgyStream);"].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function');
});

test('closed vocabularies are frozen', () => {
  assert.deepEqual(Object.values(AGY_REASON_CODES), ['agy-timeout', 'agy-cancelled', 'agy-output-limit',
    'agy-stream-invalid', 'agy-anomalous-silence', 'agy-exit-nonzero', 'budget-exceeded-while-active',
    'agy-process-exit-unconfirmed']);
  assert.deepEqual({ ...AGY_LIVENESS }, { supervised: 'stream-json', legacy: 'unsupported-legacy' });
  assert(Object.isFrozen(AGY_REASON_CODES) && Object.isFrozen(AGY_LIVENESS) && Object.isFrozen(CAPABILITY_SOURCES));
});

// ── Help parsing and argv planning ───────────────────────────────────────────

test('help parsing requires stream-json inside the --output-format region', () => {
  assert.deepEqual(parseAgyHelp(STREAM_HELP), { stream: true, effort: true, effort_values: ['low', 'medium', 'high'] });
  assert.deepEqual(parseAgyHelp(LEGACY_HELP), { stream: false, effort: false, effort_values: [] });
  const inputOnly = ['Options:', '  --input-format <format>   Input: text, stream-json',
    '  --output-format <format>  Output: text, json', ''].join('\n');
  assert.equal(parseAgyHelp(inputOnly).stream, false);
  const examples = ['Options:', '  --output-format <format>  text or json', 'Examples:',
    '  agy -p x --input-format stream-json', ''].join('\n');
  assert.equal(parseAgyHelp(examples).stream, false);
  const wrapped = ['Options:', '  --output-format <format>  Output format, one of:', '                            text, json, stream-json',
    '  --model <name>            Model', ''].join('\n');
  assert.equal(parseAgyHelp(wrapped).stream, true);
  assert.equal(parseAgyHelp('  --output-format <f>  stream-jsonl\n').stream, false);
  assert.equal(parseAgyHelp('  --output-format text --input-format stream-json\n').stream, false);
  const hostile = parseAgyHelp('  --effort <v>  high; rm -rf / && echo "max" ultra $(x)\n');
  assert.deepEqual(hostile.effort_values, ['high', 'max']);
  assert(hostile.effort_values.every(value => EFFORT_VALUES.includes(value)));
});

test('planAgyArgs keeps legacy argv and gates stream/effort flags', () => {
  const legacy = { stream: false, effort: false, effort_values: [] };
  const streamProbe = { stream: true, effort: true, effort_values: ['low', 'high'] };
  assert.deepEqual(planAgyArgs({ probe: legacy, inline: 'I', timeoutSecs: 300 }),
    ['--sandbox', '-p', 'I', '--print-timeout', '300s']);
  assert.deepEqual(planAgyArgs({ probe: legacy, inline: 'I', timeoutSecs: 300, model: 'Gemini 3.1 Pro (High)' }),
    ['--sandbox', '-p', 'I', '--print-timeout', '300s', '--model', 'Gemini 3.1 Pro (High)']);
  assert.deepEqual(planAgyArgs({ probe: streamProbe, inline: 'I', timeoutSecs: 300, model: 'M', effort: 'high' }),
    ['--sandbox', '-p', 'I', '--print-timeout', '300s', '--output-format', 'stream-json', '--model', 'M', '--effort', 'high']);
  assert.deepEqual(planAgyArgs({ probe: streamProbe, inline: 'I', timeoutSecs: 5, effort: null }),
    ['--sandbox', '-p', 'I', '--print-timeout', '5s', '--output-format', 'stream-json']);
  for (const [probe, effort] of [[legacy, 'high'], [streamProbe, 'medium'], [streamProbe, 'ultra'],
    [{ stream: true, effort: false, effort_values: ['high'] }, 'high']]) {
    assert.throws(() => planAgyArgs({ probe, inline: 'I', timeoutSecs: 5, effort }),
      error => error.code === 'effort-transport-unsupported' && error.provider_called === false);
  }
});

// ── Capability probe ─────────────────────────────────────────────────────────

test('probe reports advertised, not-advertised and failed help without a provider turn', async () => {
  const advertised = await probeAgyCapabilities(deps(fixture()), { cwd: dir('cwd') });
  assert.equal(advertised.stream, true);
  assert.equal(advertised.source, 'advertised');
  assert.deepEqual(advertised.effort_values, ['low', 'medium', 'high']);
  assert(advertised.help_bytes > 0 && Number.isInteger(advertised.probe_ms));
  const legacyFake = fixture({ help: LEGACY_HELP });
  const legacy = await probeAgyCapabilities(deps(legacyFake), { cwd: dir('cwd') });
  assert.deepEqual([legacy.stream, legacy.effort, legacy.source], [false, false, 'not-advertised']);
  assert.equal(legacyFake.calls().length, 0, 'the probe never runs a print turn');
  const failedProbe = probeAgyCapabilities(deps(fixture({ helpExit: 2 })), { cwd: dir('cwd') });
  if(process.platform==='win32')assert.equal((await rejectsWith(failedProbe,'agy-process-exit-unconfirmed')).cause_code,'probe-failed');
  else {const failed=await failedProbe;assert.deepEqual([failed.stream,failed.source],[false,'probe-failed']);}
  const flood = await probeAgyCapabilities(deps(fixture({ helpRepeat: 200,helpAfterWriteMs:20000 })), { cwd: dir('cwd'), maxBytes: 1000 });
  assert.deepEqual([flood.stream, flood.source], [false, 'probe-failed']);
});

test('probe timeout kills the owned process and spawn failure is named', async () => {
  const started = Date.now();
  const timeout = await probeAgyCapabilities(deps(fixture({ helpSleepMs: 20000 })), { cwd: dir('cwd'), timeoutMs: 300 });
  assert.deepEqual([timeout.stream, timeout.source], [false, 'probe-timeout']);
  assert(Date.now() - started < 4000);
  const missing = await probeAgyCapabilities(deps(fixture(), {
    resolveCommand: () => ({ cmd: path.join(root, 'does-not-exist.exe'), prefixArgs: [] }) }), { cwd: dir('cwd') });
  assert.deepEqual([missing.stream, missing.source], [false, 'probe-spawn-failed']);
  await assert.rejects(probeAgyCapabilities(deps(fixture(), {
    resolveCommand: () => ({ cmd: 'cmd.exe', prefixArgs: ['/c', 'agy&calc.cmd'], viaCmdShell: true }) }), { cwd: dir('cwd') }),
  /cmd\.exe metacharacter/);
});

test('probe with an unconfirmed exit refuses instead of answering', async () => {
  const error = await rejectsWith(probeAgyCapabilities(deps(fixture({ helpSleepMs: 20000 }),
    { terminateChild: () => ({ ok: false }) }), { cwd: dir('cwd'), timeoutMs: 200, exitWaitMs: 200 }),
  'agy-process-exit-unconfirmed');
  assert.equal(error.ownership.state, 'pending');
  assert.equal(error.capability_source, 'probe-timeout');
  strays.add(error.ownership.pid);
  process.kill(error.ownership.pid, 'SIGKILL');
});

test('probe and stream preserve resolved argv, ignored stdin and minimal env without caching', async () => {
  const fake = fixture({ events: [[init], [success(REVIEW)]] });
  const observed = [];
  const wrapped = deps(fake, { spawn(cmd, argv, options) {
    observed.push({ cmd, argv, options });
    return spawn(cmd, argv, options);
  } });
  const previous = process.env.FORGE_TEST_SECRET;
  process.env.FORGE_TEST_SECRET = 'private-sentinel';
  try {
    await probeAgyCapabilities(wrapped, { cwd: dir('cwd') });
    await probeAgyCapabilities(wrapped, { cwd: dir('cwd') });
    const args = planAgyArgs({ probe: parseAgyHelp(STREAM_HELP), inline: 'I', model: 'M', timeoutSecs: 300 });
    assert.equal(await runAgyStream(wrapped, { cwd: dir('cwd'), args, timeoutSecs: 300 }), REVIEW);
    assert.deepEqual(observed.map(call => call.argv), [[fake.file, '--help'], [fake.file, '--help'], [fake.file, ...args]]);
    for (const call of observed) {
      assert.equal(call.cmd, process.execPath);
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.detached, process.platform !== 'win32');
      assert.equal(call.options.env.FORGE_TEST_SECRET, undefined);
    }
    let started = false;
    assert.throws(() => runAgyStream(deps(fake, { spawn() { started = true; },
      resolveCommand: () => ({ cmd: 'cmd.exe', prefixArgs: ['/c', 'agy.cmd'], viaCmdShell: true }) }),
    { cwd: dir('cwd'), args: ['--model', 'M&calc'], timeoutSecs: 300 }), /cmd\.exe metacharacter/);
    assert.equal(started, false);
  } finally {
    if (previous === undefined) delete process.env.FORGE_TEST_SECRET;
    else process.env.FORGE_TEST_SECRET = previous;
  }
});

// Synthetic ownership races use no OS pid: only the injected terminator sees it.
function syntheticChild(onStart) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => { child.emit('spawn'); onStart?.(child); });
  return child;
}

test('a failed tree kill remains unconfirmed even when the parent closes', async () => {
  let child, kills = 0;
  const injected = deps(fixture(), {
    spawn: () => (child = syntheticChild()),
    terminateChild(owned) { assert.equal(owned, child); kills++; queueMicrotask(() => child.emit('close', 0)); return { ok: false }; },
  });
  const error = await rejectsWith(probeAgyCapabilities(injected,
    { cwd: dir('cwd'), timeoutMs: 20, exitWaitMs: 50 }), 'agy-process-exit-unconfirmed');
  assert.equal(error.ownership.pid, child.pid);
  assert.equal(kills, 1);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

test('the real termination helper: a parent-only kill with a failed tree step stays unconfirmed', async () => {
  for (const [label, runner, expected] of [
    ['taskkill fails', () => ({ status: 1 }), 'agy-process-exit-unconfirmed'],
    ['taskkill errors', () => ({ error: new Error('x'), status: null }), 'agy-process-exit-unconfirmed']]) {
    let child, parentKills = 0;
    const injected = deps(fixture(), {
      spawn: () => (child = syntheticChild()),
      terminateChild(owned) {
        owned.kill = () => { parentKills++; queueMicrotask(() => owned.emit('close', 0)); return false; };
        return xllm.terminateOwnedProcessTree(owned, 'win32', runner);
      },
    });
    const error = await rejectsWith(probeAgyCapabilities(injected,
      { cwd: dir('cwd'), timeoutMs: 20, exitWaitMs: 50 }), expected);
    assert.equal(error.ownership_pending, true, label);
    assert.equal(error.ownership.pid, child.pid, label);
    assert.equal(parentKills, 1, label);
  }
  let child;
  const confirmed = await probeAgyCapabilities(deps(fixture(), {
    spawn: () => (child = syntheticChild()),
    terminateChild(owned) {
      owned.kill = () => { queueMicrotask(() => owned.emit('close', 0)); return true; };
      return xllm.terminateOwnedProcessTree(owned, 'win32', () => ({ status: 0 }));
    },
  }), { cwd: dir('cwd'), timeoutMs: 20, exitWaitMs: 50 });
  assert.equal(confirmed.stream, false, 'a genuine tree kill plus close is confirmed');
});

test('closed parent and taskkill128 never prove descendant termination', async () => {
  for(const status of [1,128])for(const probe of [false,true]){
    let parentKills=0;
    const injected=deps(fixture(),{
      spawn:()=>syntheticChild(child=>{
        child.exitCode=7;child.kill=()=>{parentKills++;return false;};
        child.emit('close',7);
      }),
      terminateChild:child=>xllm.terminateOwnedProcessTree(child,'win32',()=>({status})),
    });
    const options={cwd:dir('closed-parent'),args:[],timeoutSecs:5,exitWaitMs:30,processSignals:false};
    const error=await rejectsWith(probe?probeAgyCapabilities(injected,options):runAgyStream(injected,options),'agy-process-exit-unconfirmed');
    assert.equal(error.ownership_pending,true);assert.equal(error.ownership.pid,424242);
    assert.equal(error.cause_code,probe?'probe-failed':'agy-exit-nonzero');assert.equal(parentKills,1);
  }
});

test('a real surviving grandchild stays pending when the Windows tree step cannot confirm', async () => {
  const fake=fixture({grandchild:true,grandchildDetached:true,events:[[init]],exitCode:7});
  try{
    // Real parent/descendant, injected taskkill failure: no timing-dependent OS census.
    const error=await rejectsWith(stream(fake,{deps:{terminateChild:child=>xllm.terminateOwnedProcessTree(child,'win32',()=>({status:128}))}}),'agy-process-exit-unconfirmed');
    const pid=fake.grandchild();assert(Number.isSafeInteger(pid));
    assert.equal(error.ownership_pending,true);assert(alive(pid),'ignored-stdio descendant outlives parent');
  }finally{
    const pid=fake.grandchild();if(pid&&alive(pid)){process.kill(pid,'SIGKILL');assert(await gone(pid));}
  }
});

test('a signal sent without close confirmation never settles as success', async () => {
  let child, kills = 0;
  const injected = deps(fixture(), {
    spawn: () => (child = syntheticChild(owned => owned.stdout.write(JSON.stringify(init) + '\n'))),
    terminateChild() { kills++; return { ok: true }; },
  });
  const controller = new AbortController();
  const pending = runAgyStream(injected, { cwd: dir('cwd'), args: [], timeoutSecs: 5,
    signal: controller.signal, exitWaitMs: 50, processSignals: false });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const error = await rejectsWith(pending, 'agy-process-exit-unconfirmed');
  assert.equal(error.ownership.pid, child.pid);
  assert.equal(kills, 1);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
});

// ── Stream owner ─────────────────────────────────────────────────────────────

test('genuine progress resolves only after close with a valid SUCCESS', async () => {
  const fake = fixture({ events: [[init], ...[1, 2, 3, 4, 5].map(i => [stepUpdate(i, 'ACTIVE', 'agent_response', `c${i}`), 150]),
    [success(REVIEW), 100]] });
  const pids = [];
  const transitions = [];
  const text = await stream(fake, { onHeartbeat: pid => pids.push(pid), onLiveness: value => { transitions.push(value); throw new Error('observer'); } });
  assert.equal(text, REVIEW);
  assert.equal(pids.length, 1);
  assert.equal(pids[0], fake.calls()[0].pid);
  assert(transitions.length >= 1 && transitions.every(value => value.version === 1));
});

test('silence before the first event kills as dead-start', async () => {
  const fake = fixture({ sleepMs: 20000 });
  const started = Date.now();
  const error = await rejectsWith(stream(fake), 'agy-anomalous-silence');
  assert.equal(error.liveness.termination, 'dead-start');
  assert.equal(error.diagnostic.reason, 'anomalous-silence');
  assert(Date.now() - started < 5000);
  assert(await gone(fake.calls()[0].pid));
});

test('duplicate ACTIVE spam does not renew liveness', async () => {
  const spam = stepUpdate(1, 'ACTIVE', 'agent_response', 'same');
  const fake = fixture({ events: [[init], [spam], ...Array.from({ length: 60 }, () => [spam, 50]), [success(REVIEW)]] });
  const error = await rejectsWith(stream(fake), 'agy-anomalous-silence');
  assert.equal(error.liveness.termination, 'dead-silence');
});

test('malformed and unknown lines do not renew liveness', async () => {
  const fake = fixture({ events: [[init], ...Array.from({ length: 60 }, (_, i) => [i % 2 ? 'garbage {' : { event: 'noise', i }, 50])] });
  const error = await rejectsWith(stream(fake), 'agy-anomalous-silence');
  assert.equal(error.liveness.termination, 'dead-silence');
});

test('an open tool window extends silence up to dead + tool extension only', async () => {
  const ok = fixture({ events: [[init], [stepUpdate(1, 'ACTIVE', 'tool')], [stepUpdate(1, 'DONE', 'tool'), 1200],
    [success(REVIEW), 50]] });
  assert.equal(await stream(ok), REVIEW);
  const stuck = fixture({ events: [[init], [stepUpdate(1, 'ACTIVE', 'tool')]], sleepMs: 20000 });
  const started = Date.now();
  const error = await rejectsWith(stream(stuck), 'agy-anomalous-silence');
  assert.equal(error.liveness.reason, 'tool-proof-unavailable-expired');
  assert(Date.now() - started >= POLICY.deadMs + POLICY.toolExtensionMs);
});

test('truncated, error and foreign terminals never become a review', async () => {
  const truncated = fixture({ events: [[init]], raw: '{"event":"result","status":"SUCC' });
  await rejectsAfterClose(stream(truncated),'agy-stream-invalid','result-envelope-invalid');
  const noResult = fixture({ events: [[init], [stepUpdate(1, 'DONE', 'agent_response', REVIEW)]] });
  await rejectsAfterClose(stream(noResult),'agy-stream-invalid','result-envelope-invalid');
  const failed = fixture({ events: [[init], [{ event: 'result', conversation_id: 'conv-1', status: 'ERROR', response: 'private-sentinel' }]], sleepMs: 20000 });
  const e3 = await rejectsWith(stream(failed), 'agy-stream-invalid');
  assert.equal(e3.diagnostic.reason, 'result-error');
  assert(!JSON.stringify(e3.diagnostic).includes('private-sentinel'));
  assert(await gone(failed.calls()[0].pid));
  const duplicate = fixture({ events: [[init], [success(REVIEW)], [success(REVIEW)]], sleepMs:20000 });
  assert.equal((await rejectsWith(stream(duplicate), 'agy-stream-invalid')).diagnostic.reason, 'duplicate-terminal');
  const foreign = fixture({ events: [[init], [{ ...success(REVIEW), conversation_id: 'conv-2' }]], sleepMs:20000 });
  assert.equal((await rejectsWith(stream(foreign), 'agy-stream-invalid')).diagnostic.reason, 'result-envelope-invalid');
  const empty = fixture({});
  await rejectsAfterClose(stream(empty),'agy-output-empty','output-empty');
});

test('non-zero exit keeps the literal message with a bounded stderr tail', async () => {
  const fake = fixture({ events: [[init]], stderr: 'x'.repeat(500) + 'tail-marker', exitCode: 7 });
  const error = await rejectsAfterClose(stream(fake),'agy-exit-nonzero','provider-exit');
  if(process.platform!=='win32'){
    assert.match(error.message, /^agy exited 7: x+tail-marker$/);
    assert(error.message.length <= 'agy exited 7: '.length + 200);
  }else assert(!error.message.includes('tail-marker'),'ownership error does not expose stderr');
  const missing = runAgyStream(deps(fixture(), { resolveCommand: () => ({ cmd: path.join(root, 'nope.exe'), prefixArgs: [] }) }),
    { cwd: dir('cwd'), args: [], timeoutSecs: 5 });
  await assert.rejects(missing, /^Error: agy spawn failed: ENOENT$/);
});

test('a delayed real fixture reproduces startup winning before post-start behavior', async () => {
  const fake = fixture({ startDelayMs: 1100, events: [[init]], sleepMs: 20000 });
  const error = await rejectsWith(stream(fake), 'agy-anomalous-silence');
  assert.equal(error.liveness.termination, 'dead-start');
});

test('output overflow kills the owner with agy-output-limit', async () => {
  const fake = fixture({ startDelayMs: 1100, events: [[init]], flood: 2 * 1048576, sleepMs: 20000 });
  // Overflow remains a real owned process. A fixed test clock prevents startup
  // and flood throughput from selecting an unrelated liveness classification.
  const error = await rejectsWith(stream(fake, { clock: () => 0 }), 'agy-output-limit');
  assert.equal(error.diagnostic.reason, 'output-limit');
  assert(await gone(fake.calls()[0].pid));
});

test('the ceiling classifies starting as timeout and active as budget exceeded', async () => {
  // Classification is deterministic in-process; OS tree termination remains
  // covered by the real cancellation and dead-silence fixtures below.
  const synthetic = onStart => deps(fixture(), { spawn: () => syntheticChild(onStart),
    terminateChild(child) { queueMicrotask(() => child.emit('close', 0)); return { ok: true, tree_terminated: true }; } });
  const startPolicy = { ...POLICY, startMs: 5000 };
  const e1 = await rejectsWith(runAgyStream(synthetic(), { cwd: dir('cwd'), args: [], timeoutSecs: 1, clock: () => 0,
    livenessPolicy: startPolicy, livenessIntervalMs: 25 }), 'agy-timeout');
  assert.equal(e1.diagnostic.reason, 'provider-timeout');
  const busy = synthetic(child => child.stdout.write(JSON.stringify(init) + '\n' + JSON.stringify(stepUpdate(0, 'ACTIVE', 'agent_response', 'active')) + '\n'));
  const e2 = await rejectsWith(runAgyStream(busy, { cwd: dir('cwd'), args: [], timeoutSecs: 1, clock: () => 0,
    livenessPolicy: POLICY, livenessIntervalMs: 25 }), 'budget-exceeded-while-active');
  assert.equal(e2.liveness.termination, 'budget-exceeded-while-active');
  assert.equal(e2.diagnostic.reason, 'budget-exceeded-while-active');
  assert(!/unavailable/i.test(e1.message + e2.message));
});

test('cancellation kills the whole owned tree, grandchild included', async () => {
  const fake = fixture({ grandchild: true, events: [[init]], sleepMs: 20000 });
  const controller = new AbortController();
  const pending = stream(fake, { signal: controller.signal, clock: () => 0 });
  const grandchild = await grandchildReady(fake).catch(async error => { controller.abort(); await pending.catch(() => {}); throw error; });
  assert(grandchild, 'grandchild started');
  strays.add(grandchild);
  controller.abort();
  const error = await rejectsWith(pending, 'agy-cancelled');
  assert.equal(error.diagnostic.reason, 'provider-cancelled');
  assert(await gone(fake.calls()[0].pid));
  assert(await gone(grandchild), 'grandchild survived the owned tree kill');
  await rejectsWith(stream(fixture(), { signal: AbortSignal.abort() }), 'agy-cancelled');
});

test('silence kill also reaches the grandchild and process signals cancel once', async () => {
  const fake = fixture({ startDelayMs: 1100, grandchild: true, events: [[init]], sleepMs: 20000 });
  const error = await rejectsWith(stream(fake, afterFirstOutput()), 'agy-anomalous-silence');
  assert.equal(error.liveness.termination, 'dead-silence');
  const grandchild = fake.grandchild();
  strays.add(grandchild);
  assert(await gone(grandchild));
  // Invoke only the listener this owner added: the test harness may own others.
  const before = process.rawListeners('SIGTERM');
  const beforeInt = process.listenerCount('SIGINT');
  const signalled = fixture({ events: [[init]], sleepMs: 20000 });
  const pending = stream(signalled);
  while (signalled.calls().length === 0) await new Promise(resolve => setTimeout(resolve, 20));
  const added = process.rawListeners('SIGTERM').filter(listener => !before.includes(listener));
  assert.equal(added.length, 1);
  added[0]('SIGTERM');
  await rejectsWith(pending, 'agy-cancelled');
  assert.equal(process.listenerCount('SIGTERM'), before.length, 'listeners removed on finish');
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
});

test('a kill that cannot be confirmed rejects with ownership pending', async () => {
  const fake = fixture({ sleepMs: 20000 });
  const error = await rejectsWith(stream(fake, { deps: { terminateChild: () => ({ ok: false }) }, exitWaitMs: 200 }),
    'agy-process-exit-unconfirmed');
  assert.equal(error.ownership.state, 'pending');
  assert.equal(error.ownership.pid, fake.calls()[0].pid);
  assert.equal(error.cause_code, 'agy-anomalous-silence');
  assert.equal(error.diagnostic.reason, 'adapter-failed');
  strays.add(error.ownership.pid);
  process.kill(error.ownership.pid, 'SIGKILL');
});

// ── invokeAgy integration (prompt file, probe, legacy, cleanup) ──────────────

async function invoke(fake, opts = {}) {
  const previous = process.env.FORGE_XLLM_AGY_BIN;
  process.env.FORGE_XLLM_AGY_BIN = fake.file;
  const cwd = opts.cwd || dir('cwd');
  const telemetry = [];
  try {
    const text = await xllm.invokeAgy({ prompt: 'DIFF START payload', cwd, timeoutSecs: 30, envPolicy: 'minimal',
      onTransportTelemetry: value => telemetry.push(value), ...opts });
    return { text, telemetry, cwd };
  } finally {
    if (previous === undefined) delete process.env.FORGE_XLLM_AGY_BIN; else process.env.FORGE_XLLM_AGY_BIN = previous;
  }
}

async function invokeRejects(fake, code, opts = {}) {
  const cwd = opts.cwd || dir('cwd');
  const error = await rejectsWith(invoke(fake, { ...opts, cwd }), code);
  return { error, cwd };
}

test('invokeAgy streams when advertised, with prompt file and argv contract', async () => {
  const fake = fixture({ events: [[init], [success(REVIEW)]] });
  const pids = [];
  const { text, telemetry, cwd } = await invoke(fake, { model: 'Gemini 3.1 Pro (High)', timeoutSecs: 300, onHeartbeat: pid => pids.push(pid) });
  assert.equal(text, REVIEW);
  const [call] = fake.calls();
  assert.deepEqual(call.args.slice(0, 2), ['--sandbox', '-p']);
  assert.deepEqual(call.args.slice(3), ['--print-timeout', '300s', '--output-format', 'stream-json', '--model', 'Gemini 3.1 Pro (High)']);
  assert.equal(call.prompt, 'DIFF START payload');
  assert.deepEqual(pids, [call.pid]);
  assert.deepEqual(telemetry, [{ engine: 'agy', transport: 'agy-cli', liveness: 'stream-json', capability_source: 'advertised',
    probe_ms: telemetry[0].probe_ms, model_observed: null, effort_applied: null }]);
  assert.deepEqual(promptDirs(cwd), []);
});

test('invokeAgy keeps the labelled legacy path when stream-json is not advertised', async () => {
  const fake = fixture({ help: LEGACY_HELP, raw: 'narration\n' + REVIEW });
  const { text, telemetry, cwd } = await invoke(fake, { model: 'M' });
  assert.equal(text, 'narration\n' + REVIEW);
  const [call] = fake.calls();
  assert.deepEqual(call.args.slice(3), ['--print-timeout', '30s', '--model', 'M']);
  assert(!call.args.includes('--output-format') && !call.args.includes('--effort'));
  assert.equal(telemetry[0].liveness, 'unsupported-legacy');
  assert.equal(telemetry[0].capability_source, 'not-advertised');
  assert.deepEqual(promptDirs(cwd), []);
  const probeFailed = fixture({ helpExit: 1, raw: REVIEW });
  if(process.platform==='win32'){
    const pending=await invokeRejects(probeFailed,'agy-process-exit-unconfirmed');
    assert.equal(probeFailed.calls().length,0);assert.equal(promptDirs(pending.cwd).length,1);
  }else{const second=await invoke(probeFailed);assert.deepEqual([second.telemetry[0].liveness,second.telemetry[0].capability_source],['unsupported-legacy','probe-failed']);}
  const empty = await invokeRejects(fixture({ help: LEGACY_HELP }), 'agy-output-empty');
  assert.deepEqual(empty.error.diagnostic, { version: 1, stage: 'envelope', reason: 'output-empty', stdout_bytes: 0 });
  assert.equal(empty.error.agy_transport.liveness, 'unsupported-legacy');
  const exit = await rejectsWith(invoke(fixture({ help: LEGACY_HELP, stderr: 'boom', exitCode: 3 })), undefined);
  assert.equal(exit.message, 'agy exited 3: boom');
});

test('invokeAgy refuses an effort it cannot honour before any provider turn', async () => {
  const fake = fixture({ help: LEGACY_HELP, raw: REVIEW });
  const { error, cwd } = await invokeRejects(fake, 'effort-transport-unsupported', { effort: 'high' });
  assert.equal(error.provider_called, false);
  assert.equal(fake.calls().length, 0);
  assert.deepEqual(promptDirs(cwd), []);
  const advertised = fixture({ events: [[init], [success(REVIEW)]] });
  await invokeRejects(advertised, 'effort-transport-unsupported', { effort: 'max' });
  assert.equal(advertised.calls().length, 0);
});

test('invokeAgy removes the prompt after failure, cancellation, timeout and overflow', async () => {
  const exit = await invokeRejects(fixture({ events: [[init]], exitCode: 4 }), process.platform==='win32'?'agy-process-exit-unconfirmed':'agy-exit-nonzero');
  assert.equal(exit.error.agy_transport.liveness, 'stream-json');
  assert.equal(promptDirs(exit.cwd).length,process.platform==='win32'?1:0);
  const controller = new AbortController();
  const slow = fixture({ events: [[init]], sleepMs: 20000 });
  const cwd = dir('cwd');
  const pending = invokeRejects(slow, 'agy-cancelled', { cwd, signal: controller.signal });
  while (slow.calls().length === 0) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await pending;
  assert.deepEqual(promptDirs(cwd), []);
  const timeout = await invokeRejects(fixture({ sleepMs: 20000 }), 'agy-timeout', { timeoutSecs: 1 });
  assert.deepEqual(promptDirs(timeout.cwd), []);
  const overflow = await invokeRejects(fixture({ events: [[init]], flood: 2 * 1048576, sleepMs: 20000 }), 'agy-output-limit');
  assert.deepEqual(promptDirs(overflow.cwd), []);
});

test('invokeAgy keeps the prompt and never falls back when the exit is unconfirmed', async () => {
  const fake = fixture({ events: [[init]], sleepMs: 20000 });
  const controller = new AbortController();
  const cwd = dir('cwd');
  const pending = invokeRejects(fake, 'agy-process-exit-unconfirmed', { cwd, signal: controller.signal,
    _agyDeps: { terminateChild: () => ({ ok: false }) } });
  while (fake.calls().length === 0) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const { error } = await pending;
  strays.add(error.ownership.pid);
  assert.equal(error.agy_transport.liveness, 'stream-json');
  assert.equal(promptDirs(cwd).length, 1, 'the prompt of an unreconciled writer is retained');
  assert.equal(fake.calls().length, 1, 'no legacy fallback after an unconfirmed exit');
  process.kill(error.ownership.pid, 'SIGKILL');
  assert(await gone(error.ownership.pid));
});

test('an unconfirmed probe prevents the provider/fallback and retains its prompt', async () => {
  const cwd = dir('cwd');
  let spawns = 0;
  const fake = fixture({ help: LEGACY_HELP, raw: REVIEW });
  const { error } = await invokeRejects(fake, 'agy-process-exit-unconfirmed', { cwd, _agyDeps: {
    spawn() { spawns++; return syntheticChild(child => child.emit('error', new Error('private-sentinel'))); },
    terminateChild: () => ({ ok: false }),
  } });
  assert.equal(error.agy_transport.capability_source, 'probe-failed');
  assert.equal(error.ownership_pending, true);
  assert.equal(spawns, 1, 'neither a second provider spawn nor legacy fallback is allowed');
  assert.equal(fake.calls().length, 0);
  assert.equal(promptDirs(cwd).length, 1);
  assert(!JSON.stringify(error).includes('private-sentinel'));
});

test('createPromptFile replicates the in-cwd prompt and inline instruction', () => {
  const cwd = dir('cwd');
  const file = createPromptFile({ cwd, prompt: 'P' });
  assert.equal(path.dirname(file.tmpDir), cwd);
  assert(path.basename(file.tmpDir).startsWith('.forge-xllm-'));
  assert.equal(fs.readFileSync(file.promptFile, 'utf8'), 'P');
  assert.equal(file.inline, `Read the file at ${file.promptFile} and follow the instructions in it exactly. `
    + 'Your entire response must be ONLY the JSON object it specifies — no prose, no markdown fences.');
  file.cleanup();
  assert.deepEqual(promptDirs(cwd), []);
  assert.throws(() => createPromptFile({ cwd: path.join(cwd, 'missing'), prompt: 'P' }), /^Error: failed to create tmpdir: /);
});
