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

function legacyFile(cwd, kind, key) {
  const dir = kind === 'transaction' ? controller.transactionDir(cwd) : kind === 'result' ? controller.resultDir(cwd) : controller.boundaryDir(cwd);
  return path.join(dir, `${Buffer.from(key).toString('base64url')}.json`);
}

function testBoundedNamesAndLongKeys() {
  for (const key of ['k'.repeat(156), 'k'.repeat(900), '測'.repeat(500)]) {
    const fixture = setup();
    try {
      const oldName = path.basename(legacyFile(fixture.cwd, 'transaction', key));
      if (key.length === 156) {
        assert.strictEqual(oldName.length, 213);
        assert.strictEqual(`.${oldName}.12345.${'u'.repeat(36)}.tmp`.length, 261);
      } else assert(oldName.length > 255);
      const unit = `execute-task/${'u'.repeat(700)}`;
      let captured;
      assert.throws(() => controller.begin(fixture.cwd, request(fixture, { unit, idempotency_key: key }), {
        prefsReader, failpoint: name => { if (name === 'after-intent') { captured = lease.readLease(lease.leaseFile(fixture.cwd, unit)).record; return true; } return false; },
      }), /failpoint/);
      const record = controller.readJson(controller.transactionFile(fixture.cwd, key));
      assert.strictEqual(record.idempotency_key, key);
      assert.strictEqual(record.unit.key, unit);
      assert.strictEqual(controller.resume(fixture.cwd, { owner_token: captured.owner_token, generation: captured.generation }, { prefsReader }).recovered, 1);
      controller.complete(fixture.cwd, request(fixture, { unit, idempotency_key: `${key}-done`, generation: captured.generation, result: { output: { sentinel: key } } }), { prefsReader });
      const result = controller.lookupRecord(fixture.cwd, 'result', `${key}-done`);
      assert.strictEqual(result.output.sentinel, key);
      assert.strictEqual(controller.handoff(fixture.cwd, { unit, next_host_runtime: 'codex' }, { prefsReader }).ok, true);
      for (const dir of [controller.transactionDir(fixture.cwd), controller.resultDir(fixture.cwd), controller.boundaryDir(fixture.cwd), lease.leasesDir(fixture.cwd), path.join(fixture.cwd, '.gsd', '.locks')]) {
        for (const name of fs.readdirSync(dir)) { assert(name.length < 160, name); assert(!name.endsWith('.tmp')); }
      }
      assert.strictEqual(controller.resume(fixture.cwd, { idempotency_key: `${key}-done` }, { prefsReader }).results[0].reason, 'already-committed');
      assert.strictEqual(controller.readEvents(controller.eventsFile(fixture.cwd, fixture.milestone)).length, 2);
    } finally { cleanup(fixture.cwd); }
  }
}

function testLegacyLookupAndConflicts() {
  const fixture = setup();
  try {
    const key = 'old-request'; let generation;
    assert.throws(() => controller.begin(fixture.cwd, request(fixture, { idempotency_key: key }), { prefsReader, failpoint: name => name === 'after-intent' }), /failpoint/);
    generation = controller.readJson(controller.transactionFile(fixture.cwd, key)).lease_generation;
    const modern = controller.transactionFile(fixture.cwd, key); const legacy = legacyFile(fixture.cwd, 'transaction', key);
    const record = controller.readJson(modern); fs.writeFileSync(legacy, JSON.stringify(record)); fs.unlinkSync(modern);
    assert.strictEqual(controller.transactionFile(fixture.cwd, key), legacy, 'public path/readJson callers resolve legacy records');
    assert.strictEqual(controller.readJson(controller.transactionFile(fixture.cwd, key)).idempotency_key, key);
    assert.strictEqual(controller.pendingTransactions(fixture.cwd).length, 1);
    controller.resume(fixture.cwd, { idempotency_key: key, owner_token: 'owner-a', generation }, { prefsReader });
    assert.strictEqual(fs.existsSync(modern), false, 'legacy is not destructively migrated');
    const done = controller.complete(fixture.cwd, request(fixture, { generation, idempotency_key: 'old-complete' }), { prefsReader });
    for (const [kind, identity, file] of [
      ['result', 'old-complete', controller.resultFile(fixture.cwd, 'old-complete')],
      ['boundary', request(fixture).unit, controller.boundaryFile(fixture.cwd, request(fixture).unit)],
    ]) {
      const previous = controller.readJson(file);
      fs.writeFileSync(legacyFile(fixture.cwd, kind, identity), JSON.stringify(previous)); fs.unlinkSync(file);
    }
    assert.strictEqual(controller.handoff(fixture.cwd, { unit: request(fixture).unit, next_host_runtime: 'codex' }, { prefsReader }).ok, true);
    assert.strictEqual(controller.projectLogicalHistory(fixture.cwd, fixture.milestone).results.length, 1);
    fs.writeFileSync(modern, fs.readFileSync(legacy));
    assert.strictEqual(controller.resume(fixture.cwd, { idempotency_key: key }, { prefsReader }).recovered, 1);
    const altered = controller.readJson(legacy); altered.host_runtime = 'codex'; fs.writeFileSync(legacy, JSON.stringify(altered));
    const before = fs.readFileSync(modern);
    assert.throws(() => controller.resume(fixture.cwd, { idempotency_key: key }, { prefsReader }), /record-conflict/);
    assert.deepStrictEqual(fs.readFileSync(modern), before);
    assert.throws(() => controller.pendingTransactions(fixture.cwd), /record-conflict/);
    assert.throws(() => controller.readJson(controller.transactionFile(fixture.cwd, key)), /record-conflict/, 'direct readers refuse divergent records too');
    assert.strictEqual(controller.readEvents(controller.eventsFile(fixture.cwd, fixture.milestone)).length, 2);
    assert.strictEqual(done.ok, true);
  } finally { cleanup(fixture.cwd); }
}

function testInterruptedDualRecordPublication() {
  const fixture = setup();
  try {
    const key = 'interrupted-dual-record';
    assert.throws(() => controller.begin(fixture.cwd, request(fixture, { idempotency_key: key }),
      { prefsReader, failpoint: name => name === 'after-intent' }), /failpoint/);
    const modern = controller.transactionFile(fixture.cwd, key);
    const legacy = legacyFile(fixture.cwd, 'transaction', key);
    fs.copyFileSync(modern, legacy);
    const oldBytes = fs.readFileSync(legacy);
    const generation = controller.readJson(modern).lease_generation;
    assert.throws(() => controller.resume(fixture.cwd, { idempotency_key: key, owner_token: 'owner-a', generation },
      { prefsReader, failpoint: name => name === 'after-rename' }), /failpoint/);
    assert.deepStrictEqual(fs.readFileSync(legacy), oldBytes, 'only modern is published');
    assert.strictEqual(controller.readJson(modern).idempotency_key, key, 'interrupted publication remains readable');
    assert.strictEqual(controller.resume(fixture.cwd, { idempotency_key: key, owner_token: 'owner-a', generation },
      { prefsReader }).recovered, 1);
    assert.strictEqual(controller.pendingTransactions(fixture.cwd).length, 0);
    const foreign = JSON.parse(oldBytes); foreign.host_runtime = 'foreign'; delete foreign.storage_checksum;
    fs.writeFileSync(legacy, JSON.stringify(foreign));
    assert.throws(() => controller.readJson(modern), /record-conflict/);
  } finally { cleanup(fixture.cwd); }
}

function testChecksumsAndAddressCollisions() {
  const fixture = setup();
  try {
    const first = controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'identity' }), { prefsReader });
    assert.throws(() => controller.begin(fixture.cwd, request(fixture, { unit: 'execute-task/T99', idempotency_key: 'identity' }), { prefsReader }), /record-conflict/);
    const file = controller.transactionFile(fixture.cwd, 'identity');
    const bytes = fs.readFileSync(file); const forged = JSON.parse(bytes); forged.action = 'complete'; fs.writeFileSync(file, JSON.stringify(forged));
    assert.throws(() => controller.resume(fixture.cwd, { idempotency_key: 'identity' }, { prefsReader }), /checksum/);
    fs.writeFileSync(file, bytes);
    const foreign = controller.readJson(file); foreign.idempotency_key = 'foreign'; fs.writeFileSync(file, JSON.stringify(foreign));
    assert.throws(() => controller.resume(fixture.cwd, { idempotency_key: 'identity' }, { prefsReader }), /record-conflict/);
    assert.strictEqual(lease.observe(fixture.cwd, request(fixture).unit).lease.generation, first.generation);
  } finally { cleanup(fixture.cwd); }
}

function testObservationalPathCompatibility() {
  const fixture = setup();
  try {
    const key = 'observed-partial';
    const modern = controller.transactionFile(fixture.cwd, key);
    const legacy = legacyFile(fixture.cwd, 'transaction', key);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const observation = { idempotency_key: key, phase: 'intent', unit: { key: request(fixture).unit } };
    fs.writeFileSync(legacy, JSON.stringify(observation));
    assert.strictEqual(controller.transactionFile(fixture.cwd, key), legacy);
    assert.deepStrictEqual(controller.readJson(controller.transactionFile(fixture.cwd, key)), observation);
    assert.throws(() => controller.resume(fixture.cwd, { idempotency_key: key }, { prefsReader }), /record-conflict/, 'observation never authorizes replay');
    fs.writeFileSync(modern, JSON.stringify({ ...observation, phase: 'committed' }));
    assert.throws(() => controller.readJson(controller.transactionFile(fixture.cwd, key)), /record-conflict/);
  } finally { cleanup(fixture.cwd); }
}

function testFirstPersistenceRollbackAndDurableReplay() {
  for (const point of ['before-make-transaction', 'before-write', 'after-write-before-rename', 'after-rename', 'after-result-published']) {
    const fixture = setup();
    try {
      let error;
      try { controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'fault' }), { prefsReader, failpoint: name => name === point }); } catch (caught) { error = caught; }
      assert(error, point);
      const durable = ['after-rename', 'after-result-published'].includes(point);
      const held = lease.readLease(lease.leaseFile(fixture.cwd, request(fixture).unit)).record;
      assert.strictEqual(!!held, durable, point);
      assert.strictEqual(controller.pendingTransactions(fixture.cwd).length, durable ? 1 : 0);
      assert(!fs.readdirSync(controller.transactionDir(fixture.cwd)).some(name => name.endsWith('.tmp')));
      if (durable) controller.resume(fixture.cwd, { owner_token: held.owner_token, generation: held.generation }, { prefsReader });
      else assert.strictEqual(error.rollback.reason, 'released');
      const repeated = controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'fault', generation: held && held.generation }), { prefsReader });
      assert.strictEqual(repeated.ok, true);
      assert.strictEqual(controller.readEvents(controller.eventsFile(fixture.cwd, fixture.milestone)).length, 1);
    } finally { cleanup(fixture.cwd); }
  }
}

function testRollbackPreservesReusedChangedAndAmbiguousLeases() {
  for (const scenario of ['reused', 'request', 'generation', 'owner', 'ambiguous', 'release-fails']) {
    const fixture = setup();
    try {
      const unit = request(fixture).unit;
      if (scenario === 'reused') lease.acquire(fixture.cwd, unit, { ownerToken: 'owner-a', requestId: 'fault', hostRuntime: 'claude' });
      let original; let caught;
      try {
        controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'fault' }), { prefsReader, failpoint: name => {
          if (name === 'before-make-transaction') {
            original = lease.readLease(lease.leaseFile(fixture.cwd, unit)).record;
            if (['request', 'generation', 'owner'].includes(scenario)) {
              const child = spawnSync(process.execPath, ['-e', `
                const fs = require('fs'); const lease = require(process.argv[4]); const lock = require(process.argv[5]);
                const handle = lock.acquireSync(process.argv[1], lease.mutexName(process.argv[2]), { allowStaleRecovery: false });
                try {
                  const file = lease.leaseFile(process.argv[1], process.argv[2]); const next = JSON.parse(fs.readFileSync(file, 'utf8'));
                  next[process.argv[3] === 'request' ? 'request_id' : process.argv[3] === 'owner' ? 'owner_token' : 'generation'] = 'successor';
                  fs.writeFileSync(file, JSON.stringify(next));
                } finally { handle.release(); }
              `, fixture.cwd, unit, scenario, path.join(__dirname, 'forge-unit-lease.js'), path.join(__dirname, 'forge-lock.js')], { encoding: 'utf8', timeout: 5000 });
              assert.strictEqual(child.status, 0, child.stderr);
            }
            if (scenario === 'ambiguous') fs.writeFileSync(controller.transactionFile(fixture.cwd, 'fault'), '{');
            if (scenario !== 'release-fails') return true;
          }
          return scenario === 'release-fails' && ['before-write', 'before-rollback-release'].includes(name);
        } });
      } catch (error) { caught = error; }
      assert(caught && caught.reconciliation && caught.reconciliation.required, scenario);
      const held = lease.readLease(lease.leaseFile(fixture.cwd, unit)).record;
      assert(held, scenario);
      assert.strictEqual(held[scenario === 'request' ? 'request_id' : scenario === 'owner' ? 'owner_token' : 'generation'],
        ['request', 'generation', 'owner'].includes(scenario) ? 'successor' : original.generation);
    } finally { cleanup(fixture.cwd); }
  }
}

function testFilesystemPersistenceFailures() {
  for (const operation of ['partial-write', 'rename']) {
    const fixture = setup();
    const write = fs.writeFileSync; const rename = fs.renameSync;
    try {
      fs.writeFileSync = (file, content, ...args) => {
        if (operation === 'partial-write' && typeof file === 'number') {
          write(file, String(content).slice(0, 12));
          throw Object.assign(new Error('fixture partial write'), { code: 'EIO' });
        }
        return write(file, content, ...args);
      };
      fs.renameSync = (source, target) => {
        if (operation === 'rename' && path.basename(source).startsWith('.atomic-')) throw Object.assign(new Error('fixture rename'), { code: 'EIO' });
        return rename(source, target);
      };
      assert.throws(() => controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'filesystem-fault' }), { prefsReader }), error => error.code === 'EIO' && error.rollback.reason === 'released');
      assert.strictEqual(lease.observe(fixture.cwd, request(fixture).unit).lease, null);
      assert.strictEqual(controller.pendingTransactions(fixture.cwd).length, 0);
      assert(!fs.readdirSync(controller.transactionDir(fixture.cwd)).some(name => name.endsWith('.tmp')));
      fs.writeFileSync = write; fs.renameSync = rename;
      assert.strictEqual(controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'filesystem-fault' }), { prefsReader }).ok, true);
      assert.strictEqual(controller.readEvents(controller.eventsFile(fixture.cwd, fixture.milestone)).length, 1);
    } finally { fs.writeFileSync = write; fs.renameSync = rename; cleanup(fixture.cwd); }
  }
}

function testOwnTemporaryCleanupAndPathDiagnostics() {
  const fixture = setup();
  try {
    const file = controller.transactionFile(fixture.cwd, 'cleanup');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreign = path.join(path.dirname(file), '.atomic-foreign.tmp'); fs.writeFileSync(foreign, 'preserve');
    const unlink = fs.unlinkSync;
    try {
      fs.unlinkSync = target => { if (String(target).includes('.atomic-') && target !== foreign) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return unlink(target); };
      assert.throws(() => controller.writeAtomic(file, { value: 1 }, false, { failpoint: name => name === 'after-write-before-rename' }), error => error.cleanup && error.cleanup.code === 'EACCES');
    } finally { fs.unlinkSync = unlink; }
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'preserve');
    assert.throws(() => controller.preflightPaths(fixture.cwd, 'x', 'execute-task/T01', 'm'.repeat(256)), error => error.code === 'path-component-limit');
    const mkdir = fs.mkdirSync;
    try {
      fs.mkdirSync = () => { throw Object.assign(new Error('fixture total'), { code: 'ENAMETOOLONG' }); };
      assert.throws(() => controller.preflightPaths(fixture.cwd, 'x', 'execute-task/T01', fixture.milestone), error => error.code === 'path-total-unsupported');
    } finally { fs.mkdirSync = mkdir; }
    const write = fs.writeFileSync; const acquire = lease.acquire; let acquired = false;
    try {
      fs.writeFileSync = (file, ...args) => {
        if (typeof file === 'string' && path.basename(file).startsWith('.probe-')) throw Object.assign(new Error('fixture path unsupported'), { code: 'ENAMETOOLONG' });
        return write(file, ...args);
      };
      lease.acquire = (...args) => { acquired = true; return acquire(...args); };
      assert.throws(() => controller.begin(fixture.cwd, request(fixture, { idempotency_key: 'bad-total-path' }), { prefsReader }), error => error.code === 'path-total-unsupported');
      assert.strictEqual(acquired, false, 'observed path failure precedes lease acquisition');
    } finally { fs.writeFileSync = write; lease.acquire = acquire; }
    const deep = path.join(fixture.cwd, ...Array(8).fill('long-directory-name'.repeat(3)));
    controller.preflightPaths(deep, 'x', 'execute-task/T01', fixture.milestone);
    assert.strictEqual(lease.observe(fixture.cwd, 'execute-task/T01').lease, null);
    console.log(`path diagnostics: component and observed total failure distinct; actual >260 preflight supported on ${process.platform}`);
  } finally { cleanup(fixture.cwd); }
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
  test('bounded names reproduce 213/261 and oversized legacy destinations', testBoundedNamesAndLongKeys);
  test('legacy lookup, discovery, result/boundary handoff and divergence refusal', testLegacyLookupAndConflicts);
  test('interrupted modern/legacy publication resumes with one authority', testInterruptedDualRecordPublication);
  test('checksums and identity collisions fail closed', testChecksumsAndAddressCollisions);
  test('public path helpers preserve observation without authorizing partial replay', testObservationalPathCompatibility);
  test('first persistence rollback and durable replay before/after rename', testFirstPersistenceRollbackAndDurableReplay);
  test('rollback preserves reused, changed and ambiguous leases', testRollbackPreservesReusedChangedAndAmbiguousLeases);
  test('partial filesystem write and failed rename leave no lease or own temporary', testFilesystemPersistenceFailures);
  test('own temporary cleanup and distinct path capability diagnostics', testOwnTemporaryCleanupAndPathDiagnostics);
  console.log('forge-unit-controller tests passed');
}
main();
