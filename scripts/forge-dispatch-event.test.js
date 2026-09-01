#!/usr/bin/env node
'use strict';

// Acceptance for the single dispatch-event emitter.
//
// The load-bearing case is the last one: it starts at the real resolver process
// and ends at a persisted line in a real events.jsonl, because that round trip —
// not an ephemeral JSON verdict — is what an operator reads after a run. Before
// this emitter existed, all five skill emissions wrote posture-blind lines, so a
// refused leg and a routine observation were indistinguishable in the log.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EMITTER = path.join(__dirname, 'forge-dispatch-event.js');
const RESOLVER = path.join(__dirname, 'forge-dispatch-resolve.js');
const emitter = require('./forge-dispatch-event.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error.message}\n`);
  }
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-event-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runEmitter(args, options = {}) {
  return spawnSync(process.execPath, [EMITTER, ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function resolveContract(cwd, extraArgs) {
  const child = spawnSync(process.execPath, [RESOLVER,
    '--json', '--unit-type', 'execute-task', '--cwd', cwd, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.strictEqual(child.status, 0, child.stderr);
  return child.stdout.trim();
}

process.stdout.write('forge-dispatch-event acceptance\n');

test('the rendered line is one JSON object carrying every posture axis', () => {
  const event = emitter.buildDispatchEvent({
    unit: 'execute-task/T01',
    slice: 'S01',
    milestone: 'M001',
  }, {
    host_runtime: 'claude',
    worker_mode: 'native',
    resolved_worker_engine: 'claude',
    dispatch_allowed: true,
    dispatch_reason_code: 'runtime-posture-observed',
    dispatch_posture: 'observe',
    dispatch_decision: 'advisory',
    model: 'claude-opus-5',
  }, '2026-09-01T00:00:00Z');
  assert.strictEqual(event.event, 'dispatch');
  assert.strictEqual(event.host_runtime, 'claude');
  assert.strictEqual(event.worker_mode, 'native');
  assert.strictEqual(event.dispatch_allowed, true);
  assert.strictEqual(event.dispatch_reason_code, 'runtime-posture-observed');
  assert.strictEqual(event.dispatch_posture, 'observe');
  assert.strictEqual(event.dispatch_decision, 'advisory');
  assert.strictEqual(event.leg, 'claude→claude');
  const line = emitter.renderDispatchEvent({ unit: 'execute-task/T01' }, {
    host_runtime: 'claude', worker_mode: 'native', resolved_worker_engine: 'claude',
    dispatch_allowed: true, dispatch_reason_code: 'runtime-posture-observed',
    dispatch_posture: 'observe', dispatch_decision: 'advisory',
  }, '2026-09-01T00:00:00Z');
  assert.strictEqual(line.split('\n').length, 2, 'exactly one line plus its terminator');
  assert.doesNotThrow(() => JSON.parse(line));
});

// The identity/allowance axes and the three verdict axes are refused for the
// same reason but are NOT the same guarantee, so they get their own cases. A
// single case named after "posture" while only removing `dispatch_allowed` is
// how the verdict axes went unguarded through three review rounds: the name
// claimed coverage the body never exercised.
test('an event missing its runtime identity or allowance is refused, never written half-blind', () => withTempDir((dir) => {
  const target = path.join(dir, 'events.jsonl');
  const missingAllowance = runEmitter(['--unit', 'execute-task/T01',
    '--host-runtime', 'claude', '--worker-mode', 'native',
    '--resolved-worker-engine', 'claude', '--events', target]);
  assert.strictEqual(missingAllowance.status, 2, missingAllowance.stdout);
  assert.match(missingAllowance.stderr, /dispatch_allowed/);

  const missingHost = runEmitter(['--unit', 'execute-task/T01',
    '--dispatch-allowed', 'true', '--events', target]);
  assert.strictEqual(missingHost.status, 2, missingHost.stdout);

  // A truthy string is not a boolean: silently coercing it is how a refused
  // dispatch would end up logged as allowed.
  const notBoolean = runEmitter(['--unit', 'execute-task/T01',
    '--host-runtime', 'claude', '--worker-mode', 'native',
    '--resolved-worker-engine', 'claude', '--dispatch-allowed', 'yes',
    '--events', target]);
  assert.strictEqual(notBoolean.status, 2, notBoolean.stdout);
  assert.strictEqual(fs.existsSync(target), false, 'a refused render writes nothing');
}));

// A fully-named dispatch, from which each verdict axis is removed in turn. The
// axes are supplied as flags rather than a route so the case isolates the
// emitter's own guarantee: even a caller that names everything else is refused
// when one axis is absent.
const NAMED_DISPATCH = Object.freeze({
  '--unit': 'execute-task/T01',
  '--host-runtime': 'claude',
  '--worker-mode': 'native',
  '--resolved-worker-engine': 'claude',
  '--dispatch-allowed': 'true',
  '--dispatch-reason-code': 'runtime-posture-observed',
  '--dispatch-posture': 'observe',
  '--dispatch-decision': 'advisory',
});

function argsWithout(flag, override) {
  const args = [];
  for (const [name, value] of Object.entries(NAMED_DISPATCH)) {
    if (name === flag) {
      if (override === undefined) continue;
      args.push(name, override);
      continue;
    }
    args.push(name, value);
  }
  return args;
}

// One case per axis, deliberately not lumped: a single "posture incomplete"
// case would again test less than its name claims, and each axis answers a
// different question in the log (why / how strict / what was done).
for (const [flag, field] of [
  ['--dispatch-reason-code', 'dispatch_reason_code'],
  ['--dispatch-posture', 'dispatch_posture'],
  ['--dispatch-decision', 'dispatch_decision'],
]) {
  test(`a dispatch that cannot name its ${field} is refused, never written half-blind`, () => withTempDir((dir) => {
    const target = path.join(dir, 'events.jsonl');

    const omitted = runEmitter([...argsWithout(flag), '--events', target]);
    assert.strictEqual(omitted.status, 2, `omitted ${field} must exit 2, got: ${omitted.stdout}`);
    assert.match(omitted.stderr, new RegExp(field));
    assert.strictEqual(fs.existsSync(target), false, `omitted ${field} wrote a line`);

    // The reproduction that exposed this hole produced `""`, not `undefined`:
    // a truthiness check that lets the empty string through leaves it open.
    const empty = runEmitter([...argsWithout(flag, ''), '--events', target]);
    assert.strictEqual(empty.status, 2, `empty ${field} must exit 2, got: ${empty.stdout}`);
    assert.match(empty.stderr, new RegExp(field));
    assert.strictEqual(fs.existsSync(target), false, `empty ${field} wrote a line`);

    const blank = runEmitter([...argsWithout(flag, '   '), '--events', target]);
    assert.strictEqual(blank.status, 2, `whitespace ${field} must exit 2, got: ${blank.stdout}`);
    assert.match(blank.stderr, new RegExp(field));
    assert.strictEqual(fs.existsSync(target), false, `whitespace ${field} wrote a line`);

    // Control: with every axis named, the same invocation is accepted — the
    // refusals above are about the missing axis, not about the arg shape.
    const named = runEmitter([...argsWithout(null), '--events', target]);
    assert.strictEqual(named.status, 0, named.stderr);
    const written = JSON.parse(fs.readFileSync(target, 'utf8').trim());
    assert.strictEqual(written[field], NAMED_DISPATCH[flag]);
  }));
}

// A route carrying every axis is the shape all six skill call sites pass, so
// the emitter must accept it untouched: the tightening above must not turn a
// real dispatch into a refusal.
test('a resolver contract carries all three verdict axes for every routable leg', () => withTempDir((dir) => {
  for (const legArgs of [
    ['--host-runtime', 'claude'],
    ['--host-runtime', 'claude', '--worker-engine', 'codex'],
    ['--host-runtime', 'codex', '--worker-engine', 'codex'],
    ['--host-runtime', 'codex', '--worker-engine', 'claude'],
  ]) {
    const contract = JSON.parse(resolveContract(dir, legArgs));
    const event = emitter.buildDispatchEvent({ unit: 'execute-task/T01' }, contract, '2026-09-01T00:00:00Z');
    for (const field of ['dispatch_reason_code', 'dispatch_posture', 'dispatch_decision']) {
      assert.notStrictEqual(event[field], '', `${legArgs.join(' ')} → empty ${field}`);
    }
  }
}));

test('the emitter appends to the log and creates its directory', () => withTempDir((dir) => {
  const target = path.join(dir, 'nested', 'forge', 'events.jsonl');
  const contract = resolveContract(dir, ['--host-runtime', 'claude']);
  for (const unit of ['execute-task/T01', 'execute-task/T02']) {
    const child = runEmitter(['--route-json', contract, '--unit', unit, '--events', target]);
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(child.stdout, '', 'the line goes to the log, not stdout');
  }
  const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((line) => JSON.parse(line).unit),
    ['execute-task/T01', 'execute-task/T02']);
}));

// END-TO-END: real resolver process → real emitter process → persisted file.
test('a refused leg and a routine one are distinguishable in the written events.jsonl', () => withTempDir((dir) => {
  const target = path.join(dir, '.gsd', 'forge', 'events.jsonl');
  const refusedContract = resolveContract(dir, ['--host-runtime', 'codex', '--worker-engine', 'claude']);
  const routineContract = resolveContract(dir, ['--host-runtime', 'codex', '--worker-engine', 'codex']);

  for (const [unit, contract] of [['execute-task/T01', refusedContract], ['execute-task/T02', routineContract]]) {
    const child = runEmitter(['--route-json', contract, '--unit', unit,
      '--slice', 'S01', '--milestone', 'M001', '--transport', 'in-process',
      '--vcs', 'git', '--events', target]);
    assert.strictEqual(child.status, 0, child.stderr);
  }

  const written = fs.readFileSync(target, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(written.length, 2);
  const [refused, routine] = written;

  assert.strictEqual(refused.dispatch_allowed, false);
  assert.strictEqual(refused.dispatch_decision, 'refuse');
  assert.strictEqual(refused.dispatch_posture, 'enforce');
  assert.strictEqual(refused.dispatch_reason_code, 'codex-claude-unroutable');
  assert.strictEqual(refused.leg, 'codex→claude');
  assert.strictEqual(refused.host_runtime, 'codex');
  assert.strictEqual(refused.resolved_worker_engine, 'claude');

  assert.strictEqual(routine.dispatch_allowed, true);
  assert.strictEqual(routine.dispatch_decision, 'advisory');
  assert.strictEqual(routine.dispatch_posture, 'observe');
  assert.strictEqual(routine.dispatch_reason_code, 'runtime-posture-observed');
  assert.strictEqual(routine.leg, 'codex→codex');

  // The distinction must survive in the file itself: every posture axis differs,
  // so no reader has to guess which of the two it is looking at.
  for (const field of ['dispatch_allowed', 'dispatch_decision', 'dispatch_posture', 'dispatch_reason_code', 'leg']) {
    assert.notStrictEqual(refused[field], routine[field], field);
  }
}));

test('every skill dispatch event is rendered by this one emitter', () => {
  const skills = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md'];
  let invocations = 0;
  for (const relative of skills) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const calls = source.split('\n').filter((line) => line.includes('forge-dispatch-event.js'));
    assert(calls.length > 0, `${relative} does not use the emitter`);
    invocations += calls.length;
    const handwritten = source.split('\n').filter((line) => (
      /\b(?:echo|printf)\b/.test(line) && /event\\?"?"?\s*:?\s*\\?"?dispatch/.test(line)
      && /"event/.test(line)
    ));
    assert.strictEqual(handwritten.length, 0,
      `${relative} still hand-writes a dispatch event: ${handwritten.join(' | ')}`);
  }
  assert.strictEqual(invocations, 6, `emitter call sites across the three skills: ${invocations}`);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
