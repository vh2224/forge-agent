#!/usr/bin/env node
'use strict';

/**
 * Standalone suite for the runtime-evidence collector wired into the execute
 * adapter (S04/T02).
 *
 * What it holds, and why each one is here rather than "obviously fine":
 *
 *   1. ADDITIVITY. `runtime_evidence` may not cost a single existing key. The
 *      baseline key set below was read off the result construction BEFORE this
 *      change; the assertion is set equality in BOTH directions, so a renamed
 *      or dropped field fails just as loudly as an unannounced new one.
 *   2. COLLECTED-AND-EMPTY ≠ ABSENT. A turn of pure narration must produce
 *      `outcome:'collected', admitted:0, entries:[]` — a present, empty report.
 *      Silence in the artifact a human reads is indistinguishable from a broken
 *      collector, which is the defect this milestone exists to remove.
 *   3. `exit_code` COMES FROM THE STREAM. Including `null`. A defaulted 0 would
 *      manufacture a success nothing measured — the single most damaging edit
 *      available in this area, so it is asserted against a mock that emits both.
 *   4. COLLECTOR-FAILED NEVER TAKES THE UNIT DOWN. Proven end to end through
 *      the real CLI with the collector module poisoned at require time, not by
 *      reasoning about the try/catch.
 *   5. THE REQUIRE STAYS LATE (IN-15). In-process scan in the mold of
 *      scanXllmContracts — `fs.readFileSync`, zero shell-out, because the grep
 *      of this shell honors .gitignore and is not proof.
 *
 * The mock is a Node program (no shell syntax, no POSIX utility, no quoting),
 * the same shape used by forge-xllm-appserver.test.js.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  runExecute,
  invokeCodexAppServer,
  collectRuntimeEvidence,
  readTurnStatus,
  validateExecuteResult,
} = require('./forge-xllm');

// The exact keys the result object carried before `runtime_evidence` existed,
// for the `conforming` (git, non-degraded, capability-recognised) path. Keys
// that are themselves conditional in the source (`degradation`, `vcs`,
// `capability_declared`, `capability_event`) are absent from this path by
// construction and are therefore absent here too — EXCEPT `capability_declared`,
// which IS present and listed below: the fixture plan declares no capability, so
// `cap.declared !== cap.capability` holds. Measured against the pre-change code,
// and listed rather than filtered out of the comparison.
const BASELINE_RESULT_KEYS = Object.freeze([
  'status', 'protocol_version', 'summary', 'must_haves_status', 'files_changed',
  'files_changed_declared', 'pre_dirty', 'start_sha', 'head_sha', 'started_at',
  'finished_at', 'duration_secs', 'dispatch_id', 'input_tokens', 'output_tokens',
  'token_method', 'parse_path', 'capability', 'capability_declared', 'appserver',
]);

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

function gitCommand(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Forge Test', GIT_AUTHOR_EMAIL: 'forge@example.invalid',
      GIT_COMMITTER_NAME: 'Forge Test', GIT_COMMITTER_EMAIL: 'forge@example.invalid',
    },
  });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Fixture repos live BENEATH `root`: main()'s finally removes only `root`, so a
// repo mkdtemp'd straight into os.tmpdir() would leak one per run.
function fixtureRepo(root) {
  const cwd = fs.mkdtempSync(path.join(root, 'evidence-repo-'));
  gitCommand(['init', '-q'], cwd);
  gitCommand(['config', 'user.name', 'Forge Test'], cwd);
  gitCommand(['config', 'user.email', 'forge@example.invalid'], cwd);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'initial\n');
  gitCommand(['add', 'fixture.txt'], cwd);
  gitCommand(['commit', '-q', '-m', 'initial'], cwd);
  return cwd;
}

// Scenarios differ ONLY in the items emitted before the final answer, so any
// difference observed downstream is attributable to the stream and nothing else.
function writeMock(dir) {
  const source = String.raw`'use strict';
const scenario = process.env.FORGE_MOCK_SCENARIO || 'narration-only';
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function answer() {
  return JSON.stringify({ status: 'done', summary: 'evidence fixture', must_haves_status: [], files_changed: [] });
}
function extraItems() {
  if (scenario === 'narration-only') {
    return [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'plan', steps: [] },
    ];
  }
  if (scenario === 'commands') {
    return [
      { type: 'commandExecution', command: 'node -e ""', cwd: '/tmp', exitCode: 3, durationMs: 12, status: 'completed' },
      // exitCode null is an OBSERVED value the runtime reported; the assertion
      // downstream is that it survives as null and is never defaulted to 0.
      { type: 'commandExecution', command: 'sleep 1', cwd: '/tmp', exitCode: null, durationMs: 5, status: 'failed' },
      { type: 'fileChange', status: 'completed', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }] },
      { type: 'quantumThing', note: 'a variant nobody classified' },
    ];
  }
  return [];
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (Object.prototype.hasOwnProperty.call(message, 'jsonrpc')) process.exit(91);
    if (message.method === 'initialize') send({ id: message.id, result: { serverInfo: { name: 'evidence-mock' } } });
    else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'thread/start') {
      if (!initialized) process.exit(92);
      send({ id: message.id, result: { thread: { id: 'thread-ev' } } });
    } else if (message.method === 'turn/start') {
      if (!initialized) process.exit(93);
      send({ id: message.id, result: { turn: { id: 'turn-ev' } } });
      for (const item of extraItems()) send({ method: 'item/completed', params: { item: item } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: answer() } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-ev', status: 'completed' } } });
      setTimeout(() => process.exit(0), 50);
    }
  }
});
setInterval(() => {}, 1000);
`;
  const file = path.join(dir, 'mock-app-server.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function planFile(dir) {
  const file = path.join(dir, 'T02-PLAN.md');
  fs.writeFileSync(file, '# evidence fixture plan\n\nExecute this fixture task.\n');
  return file;
}

function withMock(mock, scenario, action) {
  const previous = { bin: process.env.FORGE_XLLM_CODEX_BIN, scenario: process.env.FORGE_MOCK_SCENARIO };
  process.env.FORGE_XLLM_CODEX_BIN = mock;
  process.env.FORGE_MOCK_SCENARIO = scenario;
  return Promise.resolve().then(action).finally(() => {
    if (previous.bin === undefined) delete process.env.FORGE_XLLM_CODEX_BIN;
    else process.env.FORGE_XLLM_CODEX_BIN = previous.bin;
    if (previous.scenario === undefined) delete process.env.FORGE_MOCK_SCENARIO;
    else process.env.FORGE_MOCK_SCENARIO = previous.scenario;
  });
}

// ── 1. The transport return object gains `evidence`, loses nothing ──────────
async function testTransportShape(mock, root) {
  const repo = fixtureRepo(root);
  const out = await withMock(mock, 'commands', () => invokeCodexAppServer({
    cwd: repo, prompt: 'evidence', schema: TEST_SCHEMA, timeoutSecs: 20, envPolicy: 'inherit',
    evidenceUnit: 'execute-task/T02',
  }));
  for (const key of ['finalText', 'agentTexts', 'diagnostics']) {
    assert(Object.prototype.hasOwnProperty.call(out, key), `invokeCodexAppServer must keep ${key}`);
  }
  assert.strictEqual(typeof out.finalText, 'string');
  assert.strictEqual(typeof out.agentTexts, 'string');
  assert.strictEqual(typeof out.diagnostics.discarded.count, 'number');
  assert(out.evidence && out.evidence.census && Array.isArray(out.evidence.entries),
    'invokeCodexAppServer must return {census, entries}');
  // The stream carried a real turn/completed; the census records it verbatim.
  assert.strictEqual(out.evidence.census.turn_status, 'completed');
  assert.strictEqual(out.evidence.entries[0].unit, 'execute-task/T02');
}

// ── 2. Additivity of the result-file, both directions ───────────────────────
async function testResultAdditivity(mock, root) {
  const repo = fixtureRepo(root);
  const resultFile = path.join(root, 'additive-result.json');
  const result = await withMock(mock, 'commands', () => runExecute({
    cwd: repo, planFile: planFile(root), resultFile, timeoutSecs: 20, dispatchId: 'T02-additive',
  }));
  const onDisk = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.deepStrictEqual(onDisk, result, 'the result-file is the returned object');

  const keys = Object.keys(result);
  const missing = BASELINE_RESULT_KEYS.filter((key) => !keys.includes(key));
  const added = keys.filter((key) => !BASELINE_RESULT_KEYS.includes(key));
  assert.deepStrictEqual(missing, [], `pre-existing keys disappeared: ${missing.join(', ')}`);
  assert.deepStrictEqual(added, ['runtime_evidence'],
    `exactly one key may be added, got: ${added.join(', ')}`);

  // Shape of every pre-existing key is untouched, not merely its name.
  assert.strictEqual(result.status, 'done');
  assert.strictEqual(result.parse_path, 'output-schema');
  assert.strictEqual(result.capability, 'workspace');
  assert(Array.isArray(result.files_changed) && Array.isArray(result.must_haves_status));
  assert.strictEqual(typeof result.appserver.discarded_count, 'number');
  return result;
}

// ── 3. validateExecuteResult never came to require the new field ────────────
function testValidatorRetrocompat(result) {
  const without = { ...result };
  delete without.runtime_evidence;
  assert.strictEqual(validateExecuteResult(without), true,
    'a result WITHOUT runtime_evidence must stay valid');
  assert.strictEqual(validateExecuteResult(result), true,
    'a result WITH runtime_evidence must stay valid');
  // Bite in the other direction: the validator still rejects a real deviation,
  // so the two asserts above are not passing because it accepts everything.
  assert.strictEqual(validateExecuteResult({ ...without, status: 'finished' }), false);
}

// ── 4. Collected-and-empty is a REPORT, not an absence ──────────────────────
async function testCollectedAndEmpty(mock, root) {
  const repo = fixtureRepo(root);
  const resultFile = path.join(root, 'empty-result.json');
  const result = await withMock(mock, 'narration-only', () => runExecute({
    cwd: repo, planFile: planFile(root), resultFile, timeoutSecs: 20, dispatchId: 'T02-empty',
  }));
  const evidence = result.runtime_evidence;
  assert(evidence, 'the field is PRESENT even when nothing was admitted');
  assert.strictEqual(evidence.census.outcome, 'collected');
  assert.strictEqual(evidence.census.admitted, 0);
  assert.deepStrictEqual(evidence.entries, []);
  // The narration WAS seen — otherwise "admitted 0" would only prove the stream
  // was empty, which is a different fact.
  assert.strictEqual(evidence.census.inadmissible, 3, JSON.stringify(evidence.census));
  assert.strictEqual(evidence.census.items_received, 3);
  assert.strictEqual(evidence.census.outcome === 'not-collected', false,
    'collected-and-empty must never collapse into not-collected');
}

// ── 5. exit_code comes from the stream, null included ───────────────────────
function testExitCodeFromStream(result) {
  const entries = result.runtime_evidence.entries;
  const commands = entries.filter((entry) => entry.kind === 'command');
  assert.strictEqual(commands.length, 2, JSON.stringify(entries));
  assert.strictEqual(commands[0].exit_code, 3, 'a non-zero exit code survives verbatim');
  assert.strictEqual(commands[1].exit_code, null,
    'a null exit code is an observed value and must NEVER be defaulted to 0');
  assert.notStrictEqual(commands[1].exit_code, 0);
  assert.strictEqual(commands[0].status, 'completed');
  assert.strictEqual(commands[1].status, 'failed');

  // One entry per change, and the unknown variant is rejected, never relayed.
  const files = entries.filter((entry) => entry.kind === 'file');
  assert.strictEqual(files.length, 2, JSON.stringify(files));
  assert.deepStrictEqual(result.runtime_evidence.census.rejected, [{ type: 'quantumThing', count: 1 }]);
  assert.strictEqual(entries.some((entry) => entry.kind === 'quantumThing'), false);
  assert.strictEqual(entries.every((entry) => entry.source === 'codex-runtime'), true);
  assert.strictEqual(entries.every((entry) => typeof entry.ts === 'string'), true);
}

// ── 6. collector-failed, in-process and end-to-end ──────────────────────────
function testCollectorFailedInProcess() {
  // A ThreadItem whose `changes` accessor throws — the class of malformed input
  // that reaches this code from a binary we do not control.
  const poisoned = { type: 'fileChange', status: 'completed' };
  Object.defineProperty(poisoned, 'changes', {
    enumerable: true,
    get() { throw new Error('poisoned changes accessor'); },
  });
  const evidence = collectRuntimeEvidence([poisoned], [{ method: 'turn/completed', params: { turn: { status: 'completed' } } }], 'T02');
  assert.strictEqual(evidence.census.outcome, 'collector-failed');
  assert.match(evidence.census.reason, /poisoned changes accessor/);
  assert.deepStrictEqual(evidence.entries, []);
  assert.strictEqual(evidence.census.turn_status, 'completed');

  // No turn/completed observed → null. Never 'completed' by optimism (S02 R15).
  assert.strictEqual(readTurnStatus([{ method: 'item/completed', params: {} }]), null);
  assert.strictEqual(readTurnStatus(undefined), null);
  assert.strictEqual(readTurnStatus([{ method: 'turn/completed', params: { turn: { status: 'failed' } } }]), 'failed');
  assert.strictEqual(collectRuntimeEvidence([], [], 'T02').census.turn_status, null);
}

function testCollectorFailedEndToEnd(mock, root) {
  // The module itself is poisoned at require time, through the REAL CLI. This
  // is the only way to prove "the unit still completes" rather than assert it.
  const poison = path.join(root, 'poison-admit.js');
  fs.writeFileSync(poison, [
    "'use strict';",
    "const Module = require('module');",
    'const load = Module._load;',
    'Module._load = function (request) {',
    "  if (String(request).includes('forge-evidence-admit')) {",
    "    throw new Error('poisoned: forge-evidence-admit unavailable');",
    '  }',
    '  return load.apply(this, arguments);',
    '};',
    '',
  ].join('\n'), 'utf8');

  const repo = fixtureRepo(root);
  const resultFile = path.join(root, 'poisoned-result.json');
  const run = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-xllm.js'), '--mode', 'execute',
    '--plan', planFile(root), '--result-file', resultFile, '--cwd', repo, '--timeout', '20',
  ], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env,
      FORGE_XLLM_CODEX_BIN: mock,
      FORGE_MOCK_SCENARIO: 'commands',
      NODE_OPTIONS: `--require "${poison.replace(/\\/g, '/')}"`,
    },
  });
  assert.strictEqual(run.status, 0,
    `a failed collector must NOT take the unit down: status=${run.status} stderr=${run.stderr}`);
  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.strictEqual(parsed.status, 'done');
  assert.strictEqual(parsed.runtime_evidence.census.outcome, 'collector-failed');
  assert.match(parsed.runtime_evidence.census.reason, /forge-evidence-admit/,
    'the reason must NAME the failure, not merely exist');
  assert.deepStrictEqual(parsed.runtime_evidence.entries, []);
  // Everything else about the unit is unaffected — the degradation is scoped.
  assert.strictEqual(parsed.parse_path, 'output-schema');
  assert(Array.isArray(parsed.files_changed));
}

// ── 7. The require stays late (IN-15) ───────────────────────────────────────
// In-process scan, `fs` only. Counting is exact (split length), never
// includes() over the whole document.
function scanAdmitRequires(source) {
  const pattern = /require\(['"]\.\/forge-evidence-admit(\.js)?['"]\)/;
  let top = 0;
  let lazy = 0;
  for (const line of String(source).split('\n')) {
    if (!pattern.test(line)) continue;
    if (/^\S/.test(line)) top += 1; else lazy += 1;
  }
  return { top, lazy };
}

function testLateRequire() {
  const source = fs.readFileSync(path.join(__dirname, 'forge-xllm.js'), 'utf8');
  const scan = scanAdmitRequires(source);
  assert.strictEqual(scan.top, 0,
    'a top-level require would load the collector on the agy path (IN-15)');
  assert(scan.lazy >= 1, 'the collector must actually be required somewhere inside a function');

  // The scanner bites: on a synthetic source with the require hoisted, the very
  // assertion above must go false. A scanner that only says "yes" is the defect.
  const bitten = scanAdmitRequires([
    "const x = require('./forge-evidence-admit');",
    'function f() { return x; }',
    '',
  ].join('\n'));
  assert.strictEqual(bitten.top, 1);
  assert.strictEqual(bitten.lazy, 0);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-evidence-'));
  try {
    const mock = writeMock(root);
    await testTransportShape(mock, root);
    const result = await testResultAdditivity(mock, root);
    testValidatorRetrocompat(result);
    testExitCodeFromStream(result);
    await testCollectedAndEmpty(mock, root);
    testCollectorFailedInProcess();
    testCollectorFailedEndToEnd(mock, root);
    testLateRequire();
    process.stdout.write('forge-xllm-evidence: 8 test groups passed\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
