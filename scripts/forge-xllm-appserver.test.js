#!/usr/bin/env node
'use strict';

/**
 * Standalone integration suite for the execute app-server transport.
 * The mock is deliberately a Node program: no shell syntax, POSIX utilities, or
 * platform-specific quoting is involved in the protocol fixture.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  runExecute,
  invokeCodexAppServer,
  buildAppServerSandboxPolicy,
  validateExecuteResult,
  resolveCodexCommand,
} = require('./forge-xllm');

// The public adapter intentionally exports the validator, not its private schema.
// This is the smallest valid schema accepted by the direct transport call; the
// runExecute assertions below inspect the full private schema placed on the wire.
const TEST_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'must_haves_status', 'files_changed'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    must_haves_status: { type: 'array', items: { type: 'object' } },
    files_changed: { type: 'array', items: { type: 'string' } },
  },
};

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function command(args, cwd) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Forge Test', GIT_AUTHOR_EMAIL: 'forge@example.invalid',
      GIT_COMMITTER_NAME: 'Forge Test', GIT_COMMITTER_EMAIL: 'forge@example.invalid' },
  });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Fixture repos live BENEATH `root` on purpose: main()'s finally removes only `root`,
// so a repo mkdtemp'd directly in os.tmpdir() survives every run and the suite leaks
// one git repo per call site.
function fixtureRepo(root) {
  const cwd = fs.mkdtempSync(path.join(root, 'forge-xllm-appserver-repo-'));
  command(['init', '-q'], cwd);
  command(['config', 'user.name', 'Forge Test'], cwd);
  command(['config', 'user.email', 'forge@example.invalid'], cwd);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'initial\n');
  command(['add', 'fixture.txt'], cwd);
  command(['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-q', '-m', 'initial'], cwd);
  return cwd;
}

// This mock speaks the app-server's JSONL dialect (not JSON-RPC): every request
// is a line without a jsonrpc member, and notifications have no id.
function writeMock(dir) {
  const source = String.raw`'use strict';
const fs = require('fs');
const cp = require('child_process');
const scenario = process.env.FORGE_MOCK_SCENARIO || 'conforming';
const capture = process.env.FORGE_MOCK_CAPTURE;
let initialized = false;
let threadParams;
let turnParams;
let turnStarts = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function captureState() {
  if (capture) fs.writeFileSync(capture, JSON.stringify({ threadParams, turnParams, turnStarts }, null, 2));
}
function result(model) {
  return { status: 'done', summary: model || 'mock result', must_haves_status: [], files_changed: [] };
}
function answer(model) {
  if (scenario === 'narrated') {
    return 'Completed the task.\nHere is the result:\n' + JSON.stringify(result(model)) + '\nEnd.';
  }
  if (scenario === 'nojson') return 'The work is complete, but there is no structured result.';
  return JSON.stringify(result(model));
}
function respondTurn(message) {
  const params = message.params || {};
  fs.writeFileSync(capture, JSON.stringify({ threadParams, turnParams: params, turnStarts }, null, 2));
  if (scenario === 'git-commit') {
    cp.spawnSync('git', ['-C', process.cwd(), 'commit', '--allow-empty', '-m', 'mock commit'], { stdio: 'ignore' });
  }
  if (scenario === 'gsd-write') {
    fs.mkdirSync('.gsd', { recursive: true });
    fs.writeFileSync('.gsd/poison.txt', 'mock touched protected metadata\n');
  }
  const emit = () => {
    send({ id: message.id, result: { turn: { id: 'turn-1' }, echoParams: params } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: answer(params.model) } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  };
  if (scenario === 'silent-then-reply') setTimeout(emit, 320); else emit();
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (Object.prototype.hasOwnProperty.call(message, 'jsonrpc')) process.exit(91);
    if (message.method === 'initialize') send({ id: message.id, result: { serverInfo: { name: 'forge-test' } } });
    else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'thread/start') {
      if (!initialized) process.exit(92);
      threadParams = message.params || {};
      send({ id: message.id, result: { thread: { id: 'thread-fixed' } } });
    } else if (message.method === 'turn/start') {
      if (!initialized) process.exit(93);
      if (!capture) process.exit(94);
      turnStarts += 1;
      turnParams = message.params || {};
      captureState();
      respondTurn(message);
    }
  }
});
setInterval(() => {}, 1000);
`;
  const file = path.join(dir, 'mock-app-server.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * TASK-022 — a SECOND mock, added ALONGSIDE the one above, never replacing it.
 *
 * Every pre-existing mock in this repo answers `initialize` with
 * `{serverInfo:{name:'mock'}}`; a real `codex-cli 0.144.4` answers with
 * `{userAgent, codexHome, platformFamily, platformOs}` and NO `serverInfo`, and
 * carries the CLI version on `thread.cliVersion`. Proving the version extraction
 * against the OLD mocks would prove nothing about production — it would prove the
 * extractor agrees with a fixture that does not resemble the server. So this mock
 * speaks the MEASURED shape, and the serverInfo mock stays byte-unchanged as the
 * tolerance fixture (`forge-appserver-client.test.js` asserts serverInfo.name).
 */
function writeRealShapeMock(dir) {
  const source = String.raw`'use strict';
const fs = require('fs');
const mode = process.env.FORGE_MOCK_MODE || 'execute';
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
const TASK_PLAN = [
  '---',
  'id: T01',
  'must_haves:',
  '  truths:',
  '    - "it works"',
  '  artifacts:',
  '    - path: "scripts/foo.js"',
  '      provides: "does stuff"',
  '      min_lines: 10',
  '  key_links: []',
  'expected_output:',
  '  - scripts/foo.js',
  '---',
  '',
  '# T01',
].join('\n');
function answer() {
  if (mode === 'plan') {
    return JSON.stringify({
      status: 'done',
      summary: 'plan',
      slice_plan: { filename: 'S01-PLAN.md', content: '# Slice plan\n' },
      task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: TASK_PLAN }],
    });
  }
  return JSON.stringify({ status: 'done', summary: 'real-shape mock', must_haves_status: [], files_changed: [] });
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      // The MEASURED shape: userAgent, no serverInfo.
      send({ id: message.id, result: {
        userAgent: 'codex-cli/0.144.4 (Mac OS 26.5.2; arm64)',
        codexHome: '/h',
        platformFamily: 'mac',
        platformOs: 'Mac OS 26.5.2',
      } });
    } else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'thread/start') {
      if (!initialized) process.exit(92);
      send({ id: message.id, result: { thread: { id: 't1', cliVersion: '0.144.4' } } });
    } else if (message.method === 'turn/start') {
      if (!initialized) process.exit(93);
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: answer() } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
  }
});
setInterval(() => {}, 1000);
`;
  const file = path.join(dir, 'mock-real-shape-app-server.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function planFile(dir) {
  const file = path.join(dir, 'T03-PLAN.md');
  fs.writeFileSync(file, '# fixture plan\n\nExecute this fixture task.\n');
  return file;
}

async function expectReject(action, pattern) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  assert(error, `expected rejection matching ${pattern}`);
  assert.match(error.message, pattern);
  return error;
}

function withMock(mock, scenario, capture, action) {
  const previous = {
    bin: process.env.FORGE_XLLM_CODEX_BIN,
    scenario: process.env.FORGE_MOCK_SCENARIO,
    capture: process.env.FORGE_MOCK_CAPTURE,
  };
  process.env.FORGE_XLLM_CODEX_BIN = mock;
  process.env.FORGE_MOCK_SCENARIO = scenario;
  process.env.FORGE_MOCK_CAPTURE = capture;
  return Promise.resolve().then(action).finally(() => {
    for (const [key, value] of Object.entries({ FORGE_XLLM_CODEX_BIN: previous.bin, FORGE_MOCK_SCENARIO: previous.scenario, FORGE_MOCK_CAPTURE: previous.capture })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function executeOptions(repo, plan, result, model) {
  return { cwd: repo, planFile: plan, resultFile: result, model, timeoutSecs: 3, dispatchId: 'T03-test' };
}

async function testHappyAndWire(mock, root) {
  const repo = fixtureRepo(root);
  const capture = path.join(root, 'happy-capture.json');
  const resultFile = path.join(root, 'happy-result.json');
  const plan = planFile(root);
  const model = 'gpt-test-model';
  const result = await withMock(mock, 'conforming', capture, () => runExecute(executeOptions(repo, plan, resultFile, model)));
  assert(validateExecuteResult(result));
  assert.strictEqual(result.parse_path, 'output-schema');
  assert(!Object.prototype.hasOwnProperty.call(result, 'degradation'));
  assert.strictEqual(result.summary, model, 'read-back must come from the mock response');
  const wire = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.strictEqual(wire.threadParams.model, model);
  assert.strictEqual(wire.turnParams.model, model);
  assert.strictEqual(wire.turnParams.outputSchema.type, 'object');
  assert.strictEqual(wire.turnParams.outputSchema.additionalProperties, false);
  assert.deepStrictEqual(wire.turnParams.outputSchema.required, ['status', 'summary', 'must_haves_status', 'files_changed']);
  // Derived FROM the exported capability→policy gate, exactly as the gate's
  // own comment in forge-xllm.js prescribes ("what lets a test derive the
  // expected policy FROM the capability"). A hardcoded workspaceWrite literal
  // asserted the posix policy on every platform, but on win32 production
  // deliberately returns {type:'dangerFullAccess'} (documented escape hatch
  // for upstream Codex sandbox breakage — see the platform branch at
  // forge-xllm.js#buildAppServerSandboxPolicy). runExecute defaults the
  // capability to 'workspace-write' and the running platform, so the same
  // call here is the contract, not a copy of it; the per-platform table
  // itself is pinned by the explicit-platform asserts further down.
  assert.deepStrictEqual(wire.turnParams.sandboxPolicy, buildAppServerSandboxPolicy('workspace-write'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), result);
}

async function testDegradation(mock, root) {
  const repo = fixtureRepo(root);
  const plan = planFile(root);
  const narratedFile = path.join(root, 'narrated.json');
  const narrated = await withMock(mock, 'narrated', path.join(root, 'narrated-capture.json'), () => runExecute(executeOptions(repo, plan, narratedFile, 'narrated-model')));
  assert.strictEqual(narrated.parse_path, 'extract-last-json-block');
  assert.strictEqual(narrated.degradation, 'output-schema-not-honored');
  assert(validateExecuteResult(narrated));
  const noJsonRepo = fixtureRepo(root);
  const noJsonResult = path.join(root, 'nojson.json');
  const capture = path.join(root, 'nojson-capture.json');
  await expectReject(() => withMock(mock, 'nojson', capture, async () => {
    await runExecute(executeOptions(noJsonRepo, plan, noJsonResult, 'nojson-model'));
  }), /no parseable\/valid execute result/);
  assert.strictEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).turnStarts, 1, 'invalid output must not trigger a retry');
}

async function testHeartbeat(mock, root) {
  const repo = fixtureRepo(root);
  let beats = 0;
  await withMock(mock, 'silent-then-reply', path.join(root, 'heartbeat-capture.json'), () => invokeCodexAppServer({
    cwd: repo, prompt: 'heartbeat', schema: TEST_SCHEMA, model: 'heartbeat-model', timeoutSecs: 2,
    heartbeatIntervalMs: 50, onHeartbeat: () => { beats += 1; }, envPolicy: 'inherit',
  }));
  assert(beats >= 3, `expected at least three timer heartbeats during silence, got ${beats}`);

  // S05 review R2. `heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS` accepted every
  // bad value by conflating it with absence: 0 and NaN silently became the 30s
  // production cadence (so a test asking for 0 measured a contract it never
  // exercised), and a NEGATIVE reached setInterval, which clamps to 1ms — a tight
  // loop firing onHeartbeat for the whole turn. Being documented test-only with a
  // single caller is a reason to validate cheaply, not a reason to trust.
  const base = {
    cwd: repo, prompt: 'x', schema: TEST_SCHEMA, timeoutSecs: 2, onHeartbeat: () => {}, envPolicy: 'inherit',
  };
  for (const bad of [0, -1, -1000, NaN, Infinity, 1.5, '50', null]) {
    assert.throws(
      () => invokeCodexAppServer({ ...base, heartbeatIntervalMs: bad }),
      /heartbeatIntervalMs must be a finite positive integer/,
      `heartbeatIntervalMs ${JSON.stringify(bad)} must be refused`,
    );
  }
  // Controls in the other direction, so the guard is a finding about bad input
  // rather than a function that refuses everything: (1) the accepted 50ms run
  // above completed a real turn and produced its beats; (2) ABSENCE is still
  // absence — every other invokeCodexAppServer call in this suite and in
  // runExecute omits the option entirely and continues to pass.
}

async function testGuards(mock, root) {
  const plan = planFile(root);
  const commitRepo = fixtureRepo(root);
  const before = command(['rev-parse', 'HEAD'], commitRepo);
  await expectReject(() => withMock(mock, 'git-commit', path.join(root, 'commit-capture.json'), () => runExecute(executeOptions(commitRepo, plan, path.join(root, 'commit-result.json'), 'guard-model'))), /no-commit invariant/);
  assert.notStrictEqual(command(['rev-parse', 'HEAD'], commitRepo), before, 'control must prove the mock really committed');
  const protectedRepo = fixtureRepo(root);
  await expectReject(() => withMock(mock, 'gsd-write', path.join(root, 'gsd-capture.json'), () => runExecute(executeOptions(protectedRepo, plan, path.join(root, 'gsd-result.json'), 'guard-model'))), /protected \.gsd/);
  assert(fs.existsSync(path.join(protectedRepo, '.gsd', 'poison.txt')));
}

function testPolicies() {
  assert.deepStrictEqual(buildAppServerSandboxPolicy('workspace-write', 'win32'), { type: 'dangerFullAccess' });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('workspace-write', 'linux'), { type: 'workspaceWrite', networkAccess: false });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('read-only', 'darwin'), { type: 'readOnly', networkAccess: false });
  assert.deepStrictEqual(buildAppServerSandboxPolicy('read-only', 'win32'), { type: 'readOnly', networkAccess: false });
}

function testValidatorBoundary() {
  // These negative cases keep the integration assertions sensitive to a
  // validator accidentally becoming permissive while the transport evolves.
  assert.strictEqual(validateExecuteResult({ status: 'done', summary: 'ok', must_haves_status: [], files_changed: [] }), true);
  assert.strictEqual(validateExecuteResult({ status: 'done', summary: '', must_haves_status: [], files_changed: [] }), false);
  assert.strictEqual(validateExecuteResult({ status: 'done', summary: 'ok', must_haves_status: [], files_changed: ['fixture.txt'] }), true);
  assert.strictEqual(validateExecuteResult({ status: 'done', summary: 'ok', must_haves_status: [{ item: 'x', status: 'wat', note: '' }], files_changed: [] }), false);
}

function testCommandOverride(mock) {
  const old = process.env.FORGE_XLLM_CODEX_BIN;
  process.env.FORGE_XLLM_CODEX_BIN = mock;
  try {
    const resolved = resolveCodexCommand();
    assert.strictEqual(resolved.cmd, process.execPath);
    assert.deepStrictEqual(resolved.prefixArgs, [mock]);
  } finally {
    if (old === undefined) delete process.env.FORGE_XLLM_CODEX_BIN;
    else process.env.FORGE_XLLM_CODEX_BIN = old;
  }
}

function assertResultFile(resultFile, expectedPath) {
  assert(fs.existsSync(resultFile), `result-file must be created at ${resultFile}`);
  const stored = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.deepStrictEqual(stored, JSON.parse(JSON.stringify(stored)), 'result-file must contain JSON');
  assert.strictEqual(stored.parse_path, expectedPath);
  assert.strictEqual(stored.status, 'done');
  assert(Array.isArray(stored.files_changed));
  assert(Array.isArray(stored.must_haves_status));
}

async function testResultFileContract(mock, root) {
  const repo = fixtureRepo(root);
  const resultFile = path.join(root, 'contract-result.json');
  await withMock(mock, 'conforming', path.join(root, 'contract-capture.json'), () => runExecute({
    cwd: repo, planFile: planFile(root), resultFile, timeoutSecs: 3,
  }));
  assertResultFile(resultFile, 'output-schema');
  const raw = fs.readFileSync(resultFile, 'utf8');
  assert(!raw.includes('undefined'));
}

/**
 * The unit guard below pins OUR side (we always send the policy). It cannot detect a
 * regression on the CODEX side — if a future codex stops letting the turn override the
 * thread's inherited readOnly, no mock can see it. The only instrument for that is the
 * live `nongit-write` probe, so the probe staying registered and dispatchable is itself
 * the thing to pin: losing it would leave the codex-side question unmeasurable and the
 * loss would be silent.
 */
function testNonGitWriteProbeStaysRegistered() {
  const probe = require('./forge-appserver-probe.js');
  assert.strictEqual(typeof probe.probeNonGitWrite, 'function', 'nongit-write probe must remain exported');
  const usage = spawnSync(process.execPath, [path.join(__dirname, 'forge-appserver-probe.js'), '--probe', 'nope'], { encoding: 'utf8' });
  assert(
    String(usage.stderr).includes('nongit-write'),
    'nongit-write must stay in the dispatchable PROBES list — it is the only instrument that can re-measure the codex-side override',
  );
}

/**
 * TASK-023 — the cross-root probe, pinned the same way its neighbour is, plus the
 * verdict ladder exercised WITHOUT the binary.
 *
 * The ladder is a pure function precisely so these asserts can run with no codex,
 * no network and no auth. Two of them are non-degradation asserts, and they are the
 * point of the whole suite: a probe that quietly turns "did not run" into "measured
 * and negative", or "the control also wrote" into "proven", would print a verdict in
 * the same channel and shape as a real measurement — ready to be pasted into an
 * artifact as evidence.
 */
async function testCrossRootProbe() {
  const probe = require('./forge-appserver-probe.js');
  assert.strictEqual(typeof probe.probeCrossRootWrite, 'function', 'crossroot-write probe must be exported');
  assert.strictEqual(typeof probe.crossRootVerdict, 'function', 'the verdict ladder must be exported as a pure function');
  const usage = spawnSync(process.execPath, [path.join(__dirname, 'forge-appserver-probe.js'), '--probe', 'nope'], { encoding: 'utf8' });
  assert(String(usage.stderr).includes('crossroot-write'), 'crossroot-write must stay in the dispatchable PROBES list');

  // The probe must isolate only SQLite. CODEX_HOME remains the source of auth,
  // config and projections; mutating or copying it would widen credential exposure.
  const baseEnv = { CODEX_HOME: path.resolve('codex-home'), PATH: 'sentinel-path' };
  const sqliteHome = path.resolve('sqlite-arm-a');
  const isolated = probe.buildIsolatedSqliteEnv(baseEnv, sqliteHome);
  assert.notStrictEqual(isolated, baseEnv, 'per-arm env must be a clone');
  assert.strictEqual(isolated.CODEX_HOME, baseEnv.CODEX_HOME, 'CODEX_HOME/auth/config must be preserved');
  assert.strictEqual(isolated.PATH, baseEnv.PATH, 'unrelated allowlisted env must be preserved');
  assert.strictEqual(isolated.CODEX_SQLITE_HOME, sqliteHome, 'only the SQLite runtime is redirected');
  assert.strictEqual(baseEnv.CODEX_SQLITE_HOME, undefined, 'base env must not be mutated');
  assert.throws(() => probe.buildIsolatedSqliteEnv(baseEnv, 'relative/sqlite'), /absolute path/,
    'a relative SQLite home could escape under a model-controlled cwd');
  assert.strictEqual(probe.crossPlatformWriteCommand('/tmp/a b', 'linux'), "touch '/tmp/a b'",
    'POSIX keeps the already-measured touch command');
  const windowsWrite = probe.crossPlatformWriteCommand("C:\\tmp\\a'b.txt", 'win32');
  assert.strictEqual(windowsWrite, "Set-Content -LiteralPath 'C:\\tmp\\a''b.txt' -Value '' -NoNewline",
    'Windows must emit a shell-native cmdlet because app-server already wraps it in PowerShell');
  assert(!/powershell(?:\.exe)?\s/i.test(windowsWrite),
    'the probe must not nest a second PowerShell process and make quoting part of the capability test');
  assert(!/\[System\.|::/.test(windowsWrite),
    'the probe must not depend on static .NET calls rejected by ConstrainedLanguage mode');
  assert(windowsWrite.includes("a''b.txt"), 'PowerShell single-quoted paths must double embedded quotes');

  const fixturePrefixes = [];
  await probe.withTrackedProbeResources({
    fsApi: {
      mkdtempSync(prefix) { fixturePrefixes.push(prefix); return `${prefix}owned`; },
      realpathSync(value) { return value; },
      mkdirSync() {},
      rmSync() {},
    },
    osApi: { tmpdir: () => path.resolve('os-temp') },
    pathApi: path,
  }, async ({ makeTempAt }) => {
    makeTempAt(path.resolve('probe-cwd'), '.forge-xroot-a-');
    makeTempAt(path.resolve('probe-cwd'), '.forge-xroot-b-');
  });
  assert(fixturePrefixes.every(prefix => prefix.startsWith(path.resolve('probe-cwd'))),
    'cross-root fixtures must live outside os.tmpdir so excludeTmp flags do not deny their own cwd');
  await assert.rejects(
    probe.withTrackedProbeResources({
      fsApi: { mkdtempSync() { throw new Error('must not create'); }, realpathSync(v) { return v; }, mkdirSync() {}, rmSync() {} },
      osApi: { tmpdir: () => path.resolve('os-temp') },
      pathApi: path,
    }, async ({ makeTempAt }) => makeTempAt('relative-root', 'x-')),
    /must be absolute/,
    'a caller-provided resource root must not escape through cwd-relative resolution');

  const resourceFixture = (failAt) => {
    const removed = [];
    let made = 0;
    const fsApi = {
      mkdtempSync(prefix) {
        made += 1;
        if (made === failAt) throw new Error(`mkdtemp-${made}`);
        return `${prefix}made-${made}`;
      },
      realpathSync(value) { return value; },
      mkdirSync() {},
      rmSync(value) { removed.push(value); },
    };
    return { fsApi, removed };
  };
  const resolveFailure = resourceFixture(99);
  await assert.rejects(
    probe.withTrackedProbeResources(
      { fsApi: resolveFailure.fsApi, osApi: { tmpdir: () => path.resolve('tmp') }, pathApi: path },
      async ({ makeTemp }) => { makeTemp('sqlite-'); throw new Error('resolveCommand failed'); },
    ),
    /resolveCommand failed/,
  );
  assert.strictEqual(resolveFailure.removed.length, 1,
    'resolveCommand failure after sqliteRoot acquisition must clean the one created path');

  const partialCreation = resourceFixture(3);
  await assert.rejects(
    probe.withTrackedProbeResources(
      { fsApi: partialCreation.fsApi, osApi: { tmpdir: () => path.resolve('tmp') }, pathApi: path },
      async ({ makeTemp }) => { makeTemp('sqlite-'); makeTemp('repo-a-'); makeTemp('repo-b-'); },
    ),
    /mkdtemp-3/,
  );
  assert.strictEqual(partialCreation.removed.length, 2,
    'failure while creating B must clean exactly sqliteRoot and A, never an uncreated B');

  const lockedFs = {
    mkdtempSync(prefix) { return `${prefix}locked`; },
    realpathSync(value) { return value; },
    mkdirSync() {},
    rmSync() { throw new Error('EPERM locked'); },
  };
  let cleanupOnly;
  try {
    await probe.withTrackedProbeResources(
      { fsApi: lockedFs, osApi: { tmpdir: () => path.resolve('tmp') }, pathApi: path },
      async ({ makeTemp }) => { makeTemp('sqlite-'); return 'would-have-succeeded'; },
    );
  } catch (error) { cleanupOnly = error; }
  assert(cleanupOnly instanceof AggregateError && cleanupOnly.code === 'PROBE_CLEANUP_FAILED',
    'cleanup failure after success must become an infrastructure AggregateError');
  assert(/EPERM locked/.test(cleanupOnly.errors[0].message), 'cleanup diagnostic must preserve the lock error');

  const primary = new Error('primary measurement outage');
  let combined;
  try {
    await probe.withTrackedProbeResources(
      { fsApi: lockedFs, osApi: { tmpdir: () => path.resolve('tmp') }, pathApi: path },
      async ({ makeTemp }) => { makeTemp('sqlite-'); throw primary; },
    );
  } catch (error) { combined = error; }
  assert(combined instanceof AggregateError && combined.cause === primary,
    'cleanup failure must preserve the primary error as cause');
  assert.strictEqual(combined.errors[0], primary, 'aggregate must retain the primary error verbatim');
  let diagnostic = '';
  const fakeProcess = { exitCode: 0 };
  probe.reportProbeInfraFailure(combined, {
    stderr: { write(value) { diagnostic += value; } }, processRef: fakeProcess,
  });
  assert.strictEqual(fakeProcess.exitCode, 2, 'cleanup failure must surface as infrastructure exit 2');
  assert(/primary measurement outage/.test(diagnostic) && /EPERM locked/.test(diagnostic),
    'stderr must carry both the primary failure and cleanup failure');

  const { crossRootVerdict, CROSSROOT_VERDICTS: V } = probe;
  const wrote = { exists: true };
  const absent = { exists: false };
  // An arm that did NOT write but DID run: a completed commandExecution citing its own
  // target. This is the shape review R1 requires before any absence may be read as a
  // sandbox denial.
  const ranButAbsent = (target, exitCode) => ({
    exists: false,
    target,
    items: [{ type: 'commandExecution', status: 'completed', command: `/bin/zsh -lc "touch '${target}'"`, exitCode }],
  });

  const requestedWrite = (arm, threadSandbox = { type: 'workspaceWrite' }) => ({
    ...arm, requestedThreadSandbox: 'workspace-write', threadSandbox,
  });

  const liveWrote = requestedWrite({ exists: true });
  const liveAbsent = (target) => requestedWrite(ranButAbsent(target, 1));
  const sequence = async (answers) => {
    let index = 0;
    return probe.runCrossRootArmSequence({
      dirA: '/A', dirB: '/B', policyBase: { type: 'workspaceWrite' },
      runArm: async () => answers[index++],
    });
  };
  const denyFailed = await sequence([liveWrote, { error: 'deny outage' }]);
  assert.deepStrictEqual(denyFailed.executed, ['CTRL-ATTEMPT', 'CTRL-DENY'],
    'invalid CTRL-DENY must prevent TREAT and REPLACE-CHECK');
  assert.strictEqual(denyFailed.terminal.verdict, V.UNKNOWN);
  const treatFailed = await sequence([liveWrote, liveAbsent('/B/deny.txt'), { error: 'treat outage' }]);
  assert.deepStrictEqual(treatFailed.executed, ['CTRL-ATTEMPT', 'CTRL-DENY', 'TREAT'],
    'invalid TREAT must prevent REPLACE-CHECK');
  assert.strictEqual(treatFailed.terminal.verdict, V.UNKNOWN);
  const negative = await sequence([liveWrote, liveAbsent('/B/deny.txt'), liveAbsent('/B/treat.txt')]);
  assert.deepStrictEqual(negative.executed, ['CTRL-ATTEMPT', 'CTRL-DENY', 'TREAT'],
    'REPLACE-CHECK cannot contribute to a measured negative and must not run');
  const positive = await sequence([liveWrote, liveAbsent('/B/deny.txt'), liveWrote, liveWrote]);
  assert.deepStrictEqual(positive.executed, ['CTRL-ATTEMPT', 'CTRL-DENY', 'TREAT', 'REPLACE-CHECK'],
    'REPLACE-CHECK must run after a measured positive because it distinguishes sum from replacement');
  const replaceReadOnly = await sequence([
    liveWrote,
    liveAbsent('/B/deny.txt'),
    liveWrote,
    requestedWrite({ exists: true }, { type: 'readOnly' }),
  ]);
  assert.strictEqual(replaceReadOnly.outcome.verdict, V.PROVADA,
    'invalid REPLACE-CHECK must not erase the already-measured main conclusion');
  assert(/NÃO MEDIDO/.test(replaceReadOnly.outcome.reason) && !/semântica de SOMA/.test(replaceReadOnly.outcome.reason),
    'readOnly REPLACE-CHECK cannot be interpreted as sum or replacement');
  const runtimeReadOnly = probe.runtimeRootWritePrecondition({
    sandbox: { type: 'readOnly' }, activePermissionProfile: { id: ':read-only' },
  });
  assert(runtimeReadOnly && /workspaceWrite/.test(runtimeReadOnly.detail),
    'readOnly RUNTIME-ROOTS must be rejected before interpreting presence or absence');

  const readOnlyPrecondition = crossRootVerdict({
    ctrlAttempt: requestedWrite({ exists: false, items: [] }, { type: 'readOnly' }),
    ctrlDeny: requestedWrite(ranButAbsent('/B/deny.txt', 1)),
    treat: requestedWrite(wrote),
    replaceCheck: requestedWrite(wrote),
  });
  assert.strictEqual(readOnlyPrecondition.verdict, V.UNKNOWN,
    'a live arm whose requested thread grant was not effective is NOT MEASURED');
  assert(/CTRL-ATTEMPT/.test(readOnlyPrecondition.reason) && /workspaceWrite/.test(readOnlyPrecondition.reason),
    'the failed precondition must name the arm and expected effective sandbox');

  const source = fs.readFileSync(path.join(__dirname, 'forge-appserver-probe.js'), 'utf8');
  for (const label of ['HANDSHAKE', 'RUNTIME-ROOTS']) {
    assert(source.includes(`sessionEnv('${label}'`), `${label} must receive an isolated SQLite runtime`);
  }
  assert(source.includes('sessionEnv(label, env)'), 'every main runArm invocation must derive its own SQLite home from its label');
  for (const label of ['CTRL-ATTEMPT', 'CTRL-DENY', 'TREAT', 'REPLACE-CHECK']) {
    assert(source.includes(`run('${label}'`), `${label} must keep a distinct arm label for SQLite isolation`);
  }
  assert(source.includes("threadSandbox: 'workspace-write'"),
    'all four main arms must request the same writable thread sandbox');
  assert(source.includes("sandbox: 'workspace-write', runtimeWorkspaceRoots"),
    'the gated fifth arm must use the same writable thread precondition');

  // (1) NON-DEGRADATION: a timeout carries NO `infra` flag, so a ladder that read
  // `!infra` as "measured" would grade an outage as a measurement.
  const timedOut = crossRootVerdict({
    ctrlAttempt: wrote, ctrlDeny: absent,
    treat: { exists: false, error: 'timeout after 120s' }, replaceCheck: absent,
  });
  assert.strictEqual(timedOut.verdict, V.UNKNOWN, 'an arm that did not run is unknown');
  assert.notStrictEqual(timedOut.verdict, V.FALHOU, 'unknown must NEVER degrade into a negative verdict');
  assert(timedOut.reason.includes('TREAT') && timedOut.reason.includes('timeout after 120s'),
    'the unknown reason must name the arm and the message');
  for (const [label, arms] of [
    ['CTRL-ATTEMPT', { ctrlAttempt: { error: 'boom' }, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: wrote }],
    ['CTRL-DENY', { ctrlAttempt: wrote, ctrlDeny: { error: 'boom' }, treat: wrote }],
  ]) {
    const r = crossRootVerdict({ ...arms, replaceCheck: absent });
    assert.strictEqual(r.verdict, V.UNKNOWN, `${label} not measured => unknown`);
    assert.notStrictEqual(r.verdict, V.PROVADA, `${label} not measured must never read as proven`);
  }

  // (2) the positive control never executed: absence elsewhere is noise, not denial.
  const noAttempt = crossRootVerdict({ ctrlAttempt: absent, ctrlDeny: absent, treat: absent, replaceCheck: absent });
  assert.strictEqual(noAttempt.verdict, V.INCONCLUSIVA);
  assert(noAttempt.reason.includes('variante ii'), 'the prescribed re-run must be printed');

  // (3) NON-DEGRADATION: the negative control wrote => B was already writable.
  const denyWrote = crossRootVerdict({ ctrlAttempt: wrote, ctrlDeny: wrote, treat: wrote, replaceCheck: wrote });
  assert.strictEqual(denyWrote.verdict, V.INCONCLUSIVA, 'ctrlDeny writing must force inconclusiva');
  assert.notStrictEqual(denyWrote.verdict, V.PROVADA,
    'a treatment that wrote alongside a control that ALSO wrote proves nothing about writableRoots');

  // (4) proven — and the reason must carry the REPLACE-CHECK result in all three states.
  const sum = crossRootVerdict({ ctrlAttempt: wrote, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: wrote, replaceCheck: wrote });
  assert.strictEqual(sum.verdict, V.PROVADA);
  assert(/SOMA/.test(sum.reason), 'REPLACE-CHECK wrote => SUM semantics named in the reason');
  const replaced = crossRootVerdict({
    ctrlAttempt: wrote, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: wrote, replaceCheck: ranButAbsent('/A/rc.txt', 1),
  });
  assert.strictEqual(replaced.verdict, V.PROVADA);
  assert(/SUBSTITUI/.test(replaced.reason), 'REPLACE-CHECK absent => REPLACEMENT semantics named as a production risk');
  // R1, one level down: an absent REPLACE-CHECK with NO execution evidence must not
  // publish a production risk manufactured from a model that never ran the touch.
  const replaceNoEvidence = crossRootVerdict({ ctrlAttempt: wrote, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: wrote, replaceCheck: absent });
  assert.strictEqual(replaceNoEvidence.verdict, V.PROVADA, 'the main verdict is untouched by the REPLACE-CHECK arm');
  assert(/NÃO MEDIDO/.test(replaceNoEvidence.reason) && !/SUBSTITUI/.test(replaceNoEvidence.reason),
    'REPLACE-CHECK without execution evidence is NOT MEASURED, never "replacement"');
  const unmeasured = crossRootVerdict({
    ctrlAttempt: wrote, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: wrote, replaceCheck: { exists: false, error: 'timeout after 120s' },
  });
  assert.strictEqual(unmeasured.verdict, V.PROVADA,
    'a REPLACE-CHECK that did not run does not undo the main verdict — it is SAID, not inferred');
  assert(/NÃO MEDIDO/.test(unmeasured.reason), 'the unmeasured REPLACE-CHECK must be named in the reason');

  // (5) measured and negative: the field delimits, it does not enlarge. Both absent arms
  // must be EVIDENCED to have run — otherwise this is the exact substitution R1 attacks.
  const failed = crossRootVerdict({
    ctrlAttempt: wrote,
    ctrlDeny: ranButAbsent('/B/deny.txt', 1),
    treat: ranButAbsent('/B/treat.txt', 1),
    replaceCheck: wrote,
  });
  assert.strictEqual(failed.verdict, V.FALHOU);

  /* ---------------------------------------------------------------- R1 ---
   * Execution evidence per arm. `exists === false` is byte-identical between
   * "the sandbox denied it" and "the model completed the turn without running
   * the command", and the ladder used to read the first out of the second.
   */
  // (6a) CTRL-DENY absent with NO item and NO permissive same-dir control => unknown.
  const denyBlind = crossRootVerdict({
    ctrlAttempt: wrote, ctrlDeny: absent, treat: absent, replaceCheck: absent,
  });
  assert.strictEqual(denyBlind.verdict, V.UNKNOWN,
    'CTRL-DENY without execution evidence is NOT MEASURED — model refusal must never be published as sandbox denial');
  assert.notStrictEqual(denyBlind.verdict, V.FALHOU, 'unknown must never degrade into a negative verdict');
  assert(/CTRL-DENY/.test(denyBlind.reason) && /EVIDÊNCIA DE EXECUÇÃO/.test(denyBlind.reason),
    'the reason must name the arm and the missing evidence');

  // (6b) TREAT absent, evidence only on CTRL-DENY => still unknown. TREAT is itself the
  // permissive arm, so no control can stand in for it: only its own item admits FALHOU.
  const treatBlind = crossRootVerdict({
    ctrlAttempt: wrote, ctrlDeny: ranButAbsent('/B/deny.txt', 1), treat: absent, replaceCheck: wrote,
  });
  assert.strictEqual(treatBlind.verdict, V.UNKNOWN, 'TREAT without execution evidence is NOT MEASURED');
  assert(/TREAT/.test(treatBlind.reason), 'the reason must name TREAT');

  // (6c) The `control` route, borrowed verbatim from probeCapReadonly (:631-654): an arm
  // that emitted no item is still admissible when a PERMISSIVE arm against the SAME
  // target dir ran and wrote. Weaker than an own item, and LABELLED as such.
  const denyViaControl = crossRootVerdict({
    ctrlAttempt: wrote,
    ctrlDeny: { exists: false, items: [], targetDir: '/B', target: '/B/deny.txt' },
    treat: { exists: true, items: [{ type: 'commandExecution', status: 'completed', command: "touch '/B/treat.txt'", exitCode: 0 }], targetDir: '/B', target: '/B/treat.txt' },
    replaceCheck: wrote,
  });
  assert.strictEqual(denyViaControl.verdict, V.PROVADA, 'a permissive same-dir control admits the negative control');
  assert(/MAIS FRACA/.test(denyViaControl.reason), 'the control route must be reported as weaker evidence, not folded into a boolean');

  const denyWithFailedItem = crossRootVerdict({
    ctrlAttempt: wrote,
    ctrlDeny: { exists: false, targetDir: '/B', target: '/B/deny.txt', items: [{
      type: 'commandExecution', status: 'failed', command: "touch '/B/deny.txt'", exitCode: 1,
    }] },
    treat: { exists: true, targetDir: '/B', target: '/B/treat.txt', items: [{
      type: 'commandExecution', status: 'completed', command: "touch '/B/treat.txt'", exitCode: 0,
    }] },
    replaceCheck: wrote,
  });
  assert.strictEqual(denyWithFailedItem.verdict, V.PROVADA,
    'a failed command citing the denied target is direct terminal execution evidence');
  const windowsDenied = crossRootVerdict({
    ctrlAttempt: wrote,
    ctrlDeny: { exists: false, targetDir: 'C:\\repo-b', target: 'C:\\repo-b\\deny.txt', items: [{
      type: 'commandExecution', status: 'failed', command: "Set-Content -LiteralPath 'c:/REPO-B/deny.txt'", exitCode: 1,
    }] },
    treat: { exists: true, targetDir: 'C:\\repo-b', target: 'C:\\repo-b\\treat.txt', items: [] },
    replaceCheck: wrote,
  });
  assert.strictEqual(windowsDenied.verdict, V.PROVADA,
    'Windows execution evidence matching must be separator- and case-insensitive');

  // (6d) THE INVARIANT. Fed the shape MEASURED in probe-crossroot-write.log against
  // codex-cli 0.144.4, the ladder must still say `provada`. CTRL-DENY there emitted
  // `commandExecution items: []` (log:149) — it is admitted by the control route, via
  // TREAT, which ran and wrote into the SAME dir B. If this assert ever fails, the
  // refactor is wrong, not the published verdict.
  const A = '/private/tmp/forge-xroot-a-d4oycN';
  const B = '/private/tmp/forge-xroot-b-AWuaoE';
  const loggedItem = (target) => ({
    type: 'commandExecution', status: 'completed', exitCode: 0,
    command: `/bin/zsh -lc "touch '${target}'"`, cwd: A,
  });
  const measured = crossRootVerdict({
    ctrlAttempt: { exists: true, targetDir: A, target: `${A}/forge-write-probe-CTRL-ATTEMPT.txt`, items: [loggedItem(`${A}/forge-write-probe-CTRL-ATTEMPT.txt`)] },
    ctrlDeny: { exists: false, targetDir: B, target: `${B}/forge-write-probe-CTRL-DENY.txt`, items: [] },
    treat: { exists: true, targetDir: B, target: `${B}/forge-write-probe-TREAT.txt`, items: [loggedItem(`${B}/forge-write-probe-TREAT.txt`)] },
    replaceCheck: { exists: true, targetDir: A, target: `${A}/forge-write-probe-REPLACE-CHECK.txt`, items: [loggedItem(`${A}/forge-write-probe-REPLACE-CHECK.txt`)] },
  });
  assert.strictEqual(measured.verdict, V.PROVADA,
    'the verdict measured in probe-crossroot-write.log must survive the R1 refactor unchanged');
  assert(/SOMA/.test(measured.reason), 'and it must still carry the measured SUM semantics');

  /* ---------------------------------------------------------------- R2 ---
   * The fifth arm's evidence helper. The arm itself needs the binary, but the
   * predicate that decides whether its ABSENCE is reportable does not.
   */
  const { armExecution, CROSSROOT_EXEC: E } = probe;
  assert.strictEqual(armExecution({ exists: false, items: [], target: '/B/rr.txt' }, null).kind, E.NONE,
    'RUNTIME-ROOTS absent with no item is NOT evidence of a denial');
  assert.strictEqual(armExecution({ exists: false, target: '/B/rr.txt', items: [{ type: 'commandExecution', status: 'completed', command: "touch '/B/rr.txt'", exitCode: 1 }] }, null).kind, E.ITEM,
    'a completed item citing the target admits the absence');
  assert.strictEqual(armExecution({ exists: false, target: '/B/rr.txt', items: [{ type: 'commandExecution', status: 'completed', command: "touch '/OTHER/x.txt'", exitCode: 0 }] }, null).kind, E.NONE,
    'an item for a DIFFERENT target is not evidence about this one');
  assert(/exitCode:1/.test(armExecution({ exists: false, target: '/B/rr.txt', items: [{ type: 'commandExecution', status: 'completed', command: "touch '/B/rr.txt'", exitCode: 1 }] }, null).detail),
    'the exit status is carried when the server supplied one');

  // The fifth arm's caveat text must exist in BOTH branches of the source, not only
  // where it happened to write (R2, Decisão 6). Asserted structurally: one shared
  // constant, used by the positive branch and by the negative one.
  const src = source;
  const fifthBlock = src.slice(src.indexOf('ARM RUNTIME-ROOTS'));
  assert.strictEqual((fifthBlock.match(/\$\{FIFTH_CAVEAT\}/g) || []).length, 2,
    'the weaker-confidence caveat belongs to the ARM, so both the positive and the negative branch must carry it');
}

function binaryPresent(bin) {
  try { return spawnSync(bin, ['--version', '--quiet'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
}

/**
 * Regression guard for the M2 write measurement (task m2-svn-sandbox).
 *
 * Measured against codex-cli 0.144.4, with ground truth on disk: a thread started
 * with a NON-GIT cwd comes up `sandbox:{type:readOnly}` / profile `:read-only`, and
 * the turn's `sandboxPolicy` OVERRIDES it — the file really gets written. The same
 * cwd and command with `sandboxPolicy:{type:readOnly}` does not write. So SVN works
 * over the app-server transport for exactly one reason: the turn always carries an
 * EXPLICIT workspaceWrite policy.
 *
 * That makes `sandboxPolicy` load-bearing rather than redundant. Deleting it as
 * "the thread already defaults" would silently hand every SVN working copy a
 * read-only turn that completes without error and writes nothing — the silent
 * success class this milestone exists to kill. The existing wire assertion only
 * covers a git fixture, where the thread would come up writable anyway and the
 * omission would not bite; this one uses a real SVN working copy, where it does.
 */
async function testSvnTurnCarriesExplicitSandboxPolicy(mock, root) {
  if (process.platform === 'win32') {
    process.stdout.write('  skip svn explicit-sandboxPolicy guard — win32 policy is dangerFullAccess by design\n');
    return;
  }
  if (!(binaryPresent('svn') && binaryPresent('svnadmin'))) {
    if (process.env.CI && process.platform === 'linux') {
      throw new Error('svn/svnadmin missing on a runner that must gate SVN behavior');
    }
    process.stdout.write('  skip svn explicit-sandboxPolicy guard — svn/svnadmin not on PATH\n');
    return;
  }
  const svnRoot = fs.mkdtempSync(path.join(root, 'svn-'));
  const repo = path.join(svnRoot, 'repo');
  const wc = path.join(svnRoot, 'wc');
  const svn = (cwd, args) => spawnSync('svn', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(spawnSync('svnadmin', ['create', repo], { encoding: 'utf8' }).status, 0, 'svnadmin create');
  assert.strictEqual(svn(svnRoot, ['checkout', require('url').pathToFileURL(repo).href, wc]).status, 0, 'svn checkout');
  fs.writeFileSync(path.join(wc, 'fixture.txt'), 'initial\n');
  assert.strictEqual(svn(wc, ['add', 'fixture.txt']).status, 0, 'svn add');
  assert.strictEqual(svn(wc, ['commit', '-m', 'baseline']).status, 0, 'svn commit');
  // Without this the working copy stays at r0 and runExecute refuses with
  // svn-baseline-zero-revision before ever reaching turn/start.
  assert.strictEqual(svn(wc, ['update']).status, 0, 'svn update');

  // Preconditions, asserted rather than assumed: if this fixture were a git work
  // tree the guard would pass while testing nothing at all.
  assert(fs.existsSync(path.join(wc, '.svn')), 'fixture must be an SVN working copy');
  assert.notStrictEqual(
    spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: wc, encoding: 'utf8' }).stdout.trim(),
    'true',
    'fixture must NOT be a git work tree — otherwise this guard is vacuous',
  );

  const capture = path.join(root, 'svn-capture.json');
  await withMock(mock, 'conforming', capture, () => runExecute(
    executeOptions(wc, planFile(root), path.join(root, 'svn-result.json'), 'svn-guard-model'),
  ));
  const wire = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert(
    Object.prototype.hasOwnProperty.call(wire.turnParams, 'sandboxPolicy'),
    'turn/start for an SVN cwd must carry an EXPLICIT sandboxPolicy — a non-git thread inherits readOnly, so omitting it writes nothing while reporting success',
  );
  assert.deepStrictEqual(
    wire.turnParams.sandboxPolicy,
    { type: 'workspaceWrite', networkAccess: false },
    'SVN turn sandboxPolicy must be workspaceWrite',
  );
}

/**
 * TASK-022 — the transport field, end to end, in BOTH directions (D10).
 *
 * Positive: a real-shape session yields `app-server` + the observed version.
 * Tolerance: the serverInfo-shaped mock — which answers NEITHER `userAgent` NOR
 * `cliVersion` — still yields `app-server`, with the version at the named floor
 * `unknown` rather than an absent field (D4). An extractor that always matched
 * would pass the first leg and fail the second; one that never matched, the reverse.
 */
async function testTransportField(mock, realMock, root) {
  const { readTransportFromResult } = require('./forge-transport.js');

  // ── positive: execute, real shape ──────────────────────────────────────────
  const repo = fixtureRepo(root);
  const resultFile = path.join(root, 'transport-result.json');
  const withMode = (mode, action) => {
    const previous = process.env.FORGE_MOCK_MODE;
    process.env.FORGE_MOCK_MODE = mode;
    return Promise.resolve().then(action).finally(() => {
      if (previous === undefined) delete process.env.FORGE_MOCK_MODE; else process.env.FORGE_MOCK_MODE = previous;
    });
  };
  const result = await withMock(realMock, 'conforming', path.join(root, 'transport-capture.json'),
    () => withMode('execute', () => runExecute(executeOptions(repo, planFile(root), resultFile, 'transport-model'))));
  assert.strictEqual(result.appserver.transport, 'app-server');
  assert.strictEqual(result.appserver.transport_version, '0.144.4',
    'the version must come from the REAL shape (thread.cliVersion / userAgent), not from a serverInfo fixture');

  // The emitter reads the FILE, not the in-memory object — assert the file too.
  const fromFile = readTransportFromResult(resultFile);
  assert.deepStrictEqual(fromFile, { transport: 'app-server', transport_version: '0.144.4' });
  assert(!Object.prototype.hasOwnProperty.call(fromFile, 'transport_reason'),
    'transport_reason must be absent when the kind is app-server (D5)');

  // ── the additive-safety invariant, asserted here too ──────────────────────
  assert(!Object.prototype.hasOwnProperty.call(result, 'transport'),
    'transport must ride INSIDE appserver — a new top-level key fails BASELINE_RESULT_KEYS');

  // ── positive: plan (Branch D), real shape ─────────────────────────────────
  const planRepo = fixtureRepo(root);
  const contextFile = path.join(root, 'transport-plan-context.md');
  fs.writeFileSync(contextFile, '# Plan context\n\nPlan this fixture slice.\n');
  const planResultFile = path.join(root, 'transport-plan-result.json');
  const plan = await withMock(realMock, 'conforming', path.join(root, 'transport-plan-capture.json'),
    () => withMode('plan', () => require('./forge-xllm').runPlan({
      cwd: planRepo, planContextFile: contextFile, resultFile: planResultFile, timeoutSecs: 5, dispatchId: 'S01-test',
    })));
  assert.strictEqual(plan.appserver.transport, 'app-server',
    'runPlan must carry the transport — without it Branch D emits no-transport-field forever');
  assert.strictEqual(plan.appserver.transport_version, '0.144.4');
  assert.deepStrictEqual(readTransportFromResult(planResultFile),
    { transport: 'app-server', transport_version: '0.144.4' });

  // ── tolerance: the pre-existing serverInfo mock, untouched ────────────────
  const legacyRepo = fixtureRepo(root);
  const legacyResult = path.join(root, 'transport-legacy-result.json');
  const legacy = await withMock(mock, 'conforming', path.join(root, 'transport-legacy-capture.json'),
    () => runExecute(executeOptions(legacyRepo, planFile(root), legacyResult, 'legacy-model')));
  assert.strictEqual(legacy.appserver.transport, 'app-server',
    'kind is decided by PRESENCE — a session without userAgent/cliVersion is still an app-server session');
  assert.strictEqual(legacy.appserver.transport_version, 'unknown',
    "the version must be the named floor 'unknown', NEVER omitted (D4)");
  assert.deepStrictEqual(readTransportFromResult(legacyResult),
    { transport: 'app-server', transport_version: 'unknown' });

  // ── negative: the emitter's view of a result file that never carried it ───
  const preTaskFile = path.join(root, 'transport-pre-task-result.json');
  fs.writeFileSync(preTaskFile, JSON.stringify({ status: 'done', appserver: { discarded_count: 0 } }));
  assert.deepStrictEqual(readTransportFromResult(preTaskFile),
    { transport: 'unknown', transport_reason: 'no-transport-field' });
  assert.deepStrictEqual(readTransportFromResult(path.join(root, 'no-such-result.json')),
    { transport: 'unknown', transport_reason: 'no-result-file' });
}

async function main() {
  const root = tempDir('forge-xllm-appserver-test-');
  const mock = writeMock(root);
  const realMock = writeRealShapeMock(root);
  try {
    testPolicies();
    testValidatorBoundary();
    testCommandOverride(mock);
    await testHappyAndWire(mock, root);
    await testDegradation(mock, root);
    await testHeartbeat(mock, root);
    await testGuards(mock, root);
    await testResultFileContract(mock, root);
    await testSvnTurnCarriesExplicitSandboxPolicy(mock, root);
    await testTransportField(mock, realMock, root);
    testNonGitWriteProbeStaysRegistered();
    await testCrossRootProbe();
    process.stdout.write('forge-xllm-appserver.test.js: ok\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
