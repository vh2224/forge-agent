#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const controller = require('./forge-unit-controller.js');
const state = require('./forge-state.js');
const lease = require('./forge-unit-lease.js');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge controller espaço-測試-')); }
function setup() {
  const cwd = temp();
  const milestone = 'M-20260801000000-controller-test';
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, kind: 'milestone', phase: 'execute-task', active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
  return { cwd, milestone };
}
function cleanup(cwd) { fs.rmSync(cwd, { recursive: true, force: true }); }
function prefsReader() { return { ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }; }
function request(fixture, extra) { return Object.assign({ milestone: fixture.milestone, unit: 'execute-task/T01', host_runtime: 'claude', session: 'session-neutral', owner_token: 'owner-a' }, extra || {}); }
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function testPureSelection() {
  const selected = controller.selectNextUnit({
    state: { milestone: 'M1', active_slice: 'S01' },
    prefs: { workflow: { skip_discuss: true, skip_research: true } },
    inventory: { roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [{ id: 'T01', checked: false }] }] },
  });
  assert.deepStrictEqual({ type: selected.unit.type, id: selected.unit.id }, { type: 'execute-task', id: 'T01' });
}

function testSelectionPhasesAndCanonicalPrefs() {
  const current = { milestone: 'M1', active_slice: 'S01' };
  const slice = { id: 'S01', plan_exists: true, research_exists: true, tasks: [{ id: 'T01', checked: false }] };
  const inventory = { roadmap_exists: true, context_exists: true, research_exists: true, slices: [slice] };
  const choose = (changes = {}, prefs = {}) => controller.selectNextUnit({ state: current, inventory: { ...inventory, ...changes }, prefs });
  for (const [changes, type] of [
    [{ roadmap_exists: false }, 'plan-milestone'],
    [{ context_exists: false }, 'discuss-milestone'],
    [{ research_exists: false }, 'research-milestone'],
    [{ slices: [{ ...slice, plan_exists: false }] }, 'plan-slice'],
    [{ slices: [{ ...slice, research_exists: false }] }, 'research-slice'],
    [{}, 'execute-task'],
    [{ slices: [{ ...slice, tasks: [] }] }, 'complete-slice'],
    [{ slices: [{ ...slice, checked: true }] }, 'complete-milestone'],
  ]) assert.strictEqual(choose(changes).unit.type, type);
  assert.strictEqual(choose({ milestone_complete: true, slices: [{ ...slice, checked: true }] }).done, true);
  assert.strictEqual(choose({ context_exists: false }, { skip_discuss: true }).unit.type, 'execute-task');
  assert.strictEqual(choose({ context_exists: false }, { skip_discuss: false, workflow: { skip_discuss: true } }).unit.type, 'discuss-milestone');
  const missingResearch = { research_exists: false, slices: [{ ...slice, research_exists: false }] };
  assert.strictEqual(choose(missingResearch, { skip_research: true }).unit.type, 'research-slice');
  assert.strictEqual(choose(missingResearch, { skip_slice_research: true }).unit.type, 'research-milestone');
  assert.strictEqual(choose(missingResearch, { skip_research: true, skip_slice_research: true }).unit.type, 'execute-task');
  assert.strictEqual(choose(missingResearch, { workflow: { skip_research: true } }).unit.type, 'execute-task', 'legacy aliases remain readable');

  const nextSlice = { ...slice, id: 'S02', research_exists: false };
  for (const previous of [{ ...slice, checked: true }, { ...slice, tasks: [], summary_exists: true }]) {
    const next = choose({ slices: [previous, nextSlice] });
    assert.strictEqual(next.unit.type, 'research-slice', 'next slice uses the same phase rules');
    assert.strictEqual(next.slice, 'S02', 'stale STATE cannot select a checked slice');
  }
}

function testSelectionDiscoversArtifactsWithoutWriting() {
  const fixture = setup();
  try {
    const dir = path.join(fixture.cwd, '.gsd', 'milestones', fixture.milestone);
    fs.writeFileSync(path.join(dir, `${fixture.milestone}-ROADMAP.md`), '- [x] **S01: Done**\n- [ ] **S02: Next**\n');
    fs.mkdirSync(path.join(dir, 'slices', 'S02'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'slices', 'S02', 'S02-PLAN.md'), '- [ ] T01: Work\n');
    const file = state.statePath(fixture.cwd, fixture.milestone);
    const before = fs.readFileSync(file);
    const options = { prefsReader: () => ({ ok: true, prefs: { skip_discuss: true, skip_research: true, skip_slice_research: true } }) };
    const result = controller.select(fixture.cwd, { milestone: fixture.milestone }, options);
    assert.strictEqual(result.unit.type, 'execute-task');
    assert.strictEqual(result.slice, 'S02');
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(controller.pendingTransactions(fixture.cwd).length, 0);
    assert.strictEqual(lease.observe(fixture.cwd, result.unit).lease, null);
    const prefsFile = path.join(fixture.cwd, '.gsd', 'forge-prefs.jsonc');
    fs.writeFileSync(prefsFile, JSON.stringify(options.prefsReader().prefs));
    const invoke = () => spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-controller.js'), '--select', fixture.milestone, '--cwd', fixture.cwd], {
      encoding: 'utf8', env: { ...process.env, HOME: fixture.cwd, USERPROFILE: fixture.cwd, FORGE_HOME: path.join(fixture.cwd, '.forge-agent') },
    });
    const cli = invoke();
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.strictEqual(JSON.parse(cli.stdout).slice, 'S02');
    assert.strictEqual(JSON.parse(cli.stdout).unit.type, 'execute-task');
    fs.writeFileSync(prefsFile, '{');
    assert.strictEqual(invoke().status, 1, 'broken preference JSON stops the CLI');
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.throws(() => controller.select(fixture.cwd, { milestone: fixture.milestone }, {
      prefsReader: () => ({ ok: false, errors: [{ message: 'broken prefs' }] }),
    }), /prefs-invalid|prefer/);
    assert.deepStrictEqual(fs.readFileSync(file), before);
  } finally { cleanup(fixture.cwd); }
}

function testBeginCompleteHandoffAndResume() {
  const fixture = setup();
  try {
    const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
    assert.strictEqual(begin.ok, true);
    assert.strictEqual(begin.reason, 'transition-committed');
    assert(begin.owner_token && begin.generation);
    const complete = controller.complete(fixture.cwd, request(fixture, {
      owner_token: begin.owner_token,
      generation: begin.generation,
      result: { status: 'succeeded', summary: 'done', output: { files: ['x'] } },
    }), { prefsReader });
    assert.strictEqual(complete.transaction.phase, 'committed');
    assert.strictEqual(lease.observe(fixture.cwd, request(fixture).unit).lease, null);
    const handoff = controller.handoff(fixture.cwd, { unit: request(fixture).unit, next_host_runtime: 'codex' }, { prefsReader });
    assert.strictEqual(handoff.reason, 'handoff-ready');
    assert.strictEqual(handoff.previous_host_runtime, 'claude');
    assert.strictEqual(handoff.next_host_runtime, 'codex');
    assert(!Object.prototype.hasOwnProperty.call(handoff, 'owner_token'));
    assert(!Object.prototype.hasOwnProperty.call(handoff, 'session'));
    const resumed = controller.resume(fixture.cwd, { idempotency_key: complete.transaction.idempotency_key, owner_token: begin.owner_token, generation: begin.generation }, { prefsReader });
    assert.strictEqual(resumed.results[0].reason, 'already-committed');
  } finally { cleanup(fixture.cwd); }
}

function testLeaseNegativeAndBoundaryDeny() {
  const fixture = setup();
  try {
    const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
    assert.throws(() => controller.complete(fixture.cwd, request(fixture, { owner_token: 'other', generation: begin.generation }), { prefsReader }), /lease-owner-mismatch|lease-active/);
    assert.throws(() => controller.handoff(fixture.cwd, { unit: request(fixture).unit, next_host_runtime: 'codex' }, { prefsReader }), /transaction-pending|boundary-missing/);
  } finally { cleanup(fixture.cwd); }
}

function testPauseAndFailureBoundaries() {
  for (const action of ['pause', 'fail']) {
    const fixture = setup();
    try {
      const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
      const done = controller[action](fixture.cwd, request(fixture, { owner_token: begin.owner_token, generation: begin.generation, result: { status: action === 'pause' ? 'cancelled' : 'failed' } }), { prefsReader });
      assert.strictEqual(done.transaction.phase, 'committed');
      const handoff = controller.handoff(fixture.cwd, { unit: request(fixture).unit, next_host_runtime: action === 'pause' ? 'codex' : 'claude' }, { prefsReader });
      assert.strictEqual(handoff.boundary_kind, action === 'pause' ? 'paused' : 'failed-persisted');
    } finally { cleanup(fixture.cwd); }
  }
}

function testCrashRecoveryIdempotency() {
  const fixture = setup();
  try {
    assert.throws(() => controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'crash-1' }), { prefsReader, failpoint: point => point === 'after-intent' }), error => error.code === 'CONTROLLER_FAILPOINT');
    const pending = controller.pendingTransactions(fixture.cwd);
    assert.strictEqual(pending.length, 1);
    const recovered = controller.resume(fixture.cwd, { idempotency_key: 'crash-1', owner_token: 'owner-a' }, { prefsReader });
    assert.strictEqual(recovered.recovered, 1);
    assert.strictEqual(recovered.results[0].reason, 'transition-committed');
    const again = controller.resume(fixture.cwd, { idempotency_key: 'crash-1', owner_token: 'owner-a' }, { prefsReader });
    assert.strictEqual(again.results[0].reason, 'already-committed');
  } finally { cleanup(fixture.cwd); }
}

function testRecoveryRequiresLeaseAndUsesReleaseMarker() {
  {
    const fixture = setup();
    try {
      let now = 1000;
      assert.throws(() => controller.begin(fixture.cwd, request(fixture, {
        idempotency_key: 'lease-required-after-crash', ttl_ms: 10, grace_ms: 5,
      }), { prefsReader, now: () => now, failpoint: point => point === 'after-intent' }), error => error.code === 'CONTROLLER_FAILPOINT');
      const pending = controller.pendingTransactions(fixture.cwd)[0];
      assert(pending && pending.phase === 'intent');
      now = 1016; // expiry (1010) + grace (5), strictly beyond recovery edge
      const recoveredLease = lease.recover(fixture.cwd, request(fixture).unit, { now });
      assert.strictEqual(recoveredLease.reason, 'recovered');
      assert.throws(() => controller.resume(fixture.cwd, {
        idempotency_key: 'lease-required-after-crash', owner_token: 'owner-a', generation: pending.lease_generation,
      }, { prefsReader, now: () => now }), error => error.code === 'lease-required');
    } finally { cleanup(fixture.cwd); }
  }
  {
    const fixture = setup();
    try {
      const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
      assert.throws(() => controller.complete(fixture.cwd, request(fixture, {
        owner_token: begin.owner_token, generation: begin.generation,
        result: { status: 'succeeded' },
      }), { prefsReader, failpoint: point => point === 'after-lease-release-pending' }), error => error.code === 'CONTROLLER_FAILPOINT');
      const pending = controller.pendingTransactions(fixture.cwd)[0];
      assert.strictEqual(pending.phase, 'lease-release-pending');
      const resumed = controller.resume(fixture.cwd, {
        idempotency_key: pending.idempotency_key, owner_token: begin.owner_token, generation: begin.generation,
      }, { prefsReader });
      assert.strictEqual(resumed.results[0].transaction.phase, 'committed');
      assert.strictEqual(lease.observe(fixture.cwd, request(fixture).unit).lease, null);
    } finally { cleanup(fixture.cwd); }
  }
  {
    const fixture = setup();
    try {
      const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
      assert.throws(() => controller.complete(fixture.cwd, request(fixture, {
        owner_token: begin.owner_token, generation: begin.generation,
        result: { status: 'succeeded' },
      }), { prefsReader, failpoint: point => point === 'after-lease-released' }), error => error.code === 'CONTROLLER_FAILPOINT');
      const pending = controller.pendingTransactions(fixture.cwd)[0];
      assert.strictEqual(pending.phase, 'lease-released');
      const resumed = controller.resume(fixture.cwd, { idempotency_key: pending.idempotency_key }, { prefsReader });
      assert.strictEqual(resumed.results[0].transaction.phase, 'committed');
    } finally { cleanup(fixture.cwd); }
  }
}

function testResultAndEventAreSinglePublication() {
  const fixture = setup();
  try {
    const begin = controller.begin(fixture.cwd, request(fixture), { prefsReader });
    const complete = controller.complete(fixture.cwd, request(fixture, { owner_token: begin.owner_token, generation: begin.generation, idempotency_key: 'same-result', result: { status: 'succeeded', output: { count: 1 } } }), { prefsReader });
    const resultFiles = fs.readdirSync(path.join(fixture.cwd, '.gsd', 'forge', 'results')).filter(name => name.endsWith('.json'));
    const eventFile = path.join(fixture.cwd, '.gsd', 'milestones', fixture.milestone, `${fixture.milestone}-events.jsonl`);
    const events = fs.readFileSync(eventFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert(resultFiles.length >= 1);
    assert.strictEqual(events.filter(event => event.idempotency_key === complete.transaction.idempotency_key).length, 1);
    assert(events.every(event => !Object.prototype.hasOwnProperty.call(event, 'owner_token')));
  } finally { cleanup(fixture.cwd); }
}

function testLegacyFixtureRemainsReadable() {
  const fixture = setup();
  try {
    const file = state.statePath(fixture.cwd, fixture.milestone);
    const raw = fs.readFileSync(file, 'utf8').replace(/\n---\n[\s\S]*$/, '\n');
    fs.writeFileSync(file, raw, 'utf8');
    const read = state.read(fixture.cwd, fixture.milestone);
    assert.strictEqual(read.host_runtime, undefined);
    assert.strictEqual(read.worker_engine, undefined);
    assert.strictEqual(controller.logicalState(read).milestone, fixture.milestone);
  } finally { cleanup(fixture.cwd); }
}

function testProviderProjectionIsNeutral() {
  const run = host => {
    const fixture = setup();
    try {
      const begin = controller.begin(fixture.cwd, request(fixture, { host_runtime: host, owner_token: `owner-${host}` }), { prefsReader });
      controller.complete(fixture.cwd, request(fixture, { host_runtime: host, owner_token: begin.owner_token, generation: begin.generation, result: { status: 'succeeded', output: { value: 1 } } }), { prefsReader });
      const projection = controller.projectLogicalHistory(fixture.cwd, fixture.milestone);
      delete projection.state.created;
      return projection;
    } finally { cleanup(fixture.cwd); }
  };
  assert.deepStrictEqual(run('claude'), run('codex'));
}

function main() {
  console.log(`forge-unit-controller tests on ${process.platform}`);
  test('pure deterministic selection', testPureSelection);
  test('phase ordering, canonical skip preferences and stale slice selection', testSelectionPhasesAndCanonicalPrefs);
  test('artifact discovery selects without leases or STATE writes', testSelectionDiscoversArtifactsWithoutWriting);
  test('begin/complete/handoff/resume', testBeginCompleteHandoffAndResume);
  test('lease negative and boundary deny', testLeaseNegativeAndBoundaryDeny);
  test('pause and failure boundaries', testPauseAndFailureBoundaries);
  test('crash recovery and idempotency', testCrashRecoveryIdempotency);
  test('recovery requires lease and release marker is durable', testRecoveryRequiresLeaseAndUsesReleaseMarker);
  test('single result and event publication', testResultAndEventAreSinglePublication);
  test('legacy fixture remains readable', testLegacyFixtureRemainsReadable);
  test('Claude/Codex logical projection is neutral', testProviderProjectionIsNeutral);
  console.log('forge-unit-controller tests passed');
}
main();
