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
    fs.writeFileSync(path.join(dir, `${fixture.milestone}-ROADMAP.md`), '- [x] **S01: Done** `depends:[]`\n- [ ] **S02: Next** `depends:[S01]`\n');
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

function testCumulativeSummaryDoesNotCloseMilestone() {
  const fixture = setup();
  try {
    const dir = path.join(fixture.cwd, '.gsd', 'milestones', fixture.milestone);
    fs.writeFileSync(path.join(dir, `${fixture.milestone}-ROADMAP.md`), '- [x] **S01: Done**\n');
    fs.writeFileSync(path.join(dir, `${fixture.milestone}-SUMMARY.md`), '## S01: written by complete-slice\n');
    fs.mkdirSync(path.join(dir, 'slices', 'S01'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'slices', 'S01', 'S01-PLAN.md'), '- [x] T01: Work\n');
    fs.writeFileSync(path.join(dir, 'slices', 'S01', 'S01-SUMMARY.md'), 'done\n');
    const options = { prefsReader: () => ({ ok: true, prefs: { skip_discuss: true, skip_research: true, skip_slice_research: true } }) };
    const pick = () => controller.select(fixture.cwd, { milestone: fixture.milestone }, options);
    assert.strictEqual(pick().unit.type, 'complete-milestone', 'cumulative SUMMARY alone must not skip the milestone close');
    fs.writeFileSync(path.join(fixture.cwd, '.gsd', 'LEDGER.md'), `## ${fixture.milestone}-other\n`);
    assert.strictEqual(pick().unit.type, 'complete-milestone', 'a heading for another id does not close this milestone');
    fs.writeFileSync(path.join(fixture.cwd, '.gsd', 'LEDGER.md'), `# Ledger\n\n## ${fixture.milestone}\n`);
    assert.strictEqual(pick().done, true, 'legacy global LEDGER heading proves the close');
    fs.writeFileSync(path.join(fixture.cwd, '.gsd', 'LEDGER.md'), `# Ledger\n\n## ${fixture.milestone} — Título antigo\n`);
    assert.strictEqual(pick().done, true, 'pre-fragment "## <id> — <title>" heading proves the close');
    fs.rmSync(path.join(fixture.cwd, '.gsd', 'LEDGER.md'));
    const events = path.join(dir, `${fixture.milestone}-events.jsonl`);
    const transition = outcome => JSON.stringify({ event: 'unit-transition', action: 'complete', outcome,
      unit: `complete-milestone/${fixture.milestone}`, milestone: fixture.milestone }) + '\n';
    fs.writeFileSync(events, 'not json\n' + transition('failed'));
    assert.strictEqual(pick().unit.type, 'complete-milestone', 'a failed close transition is not a close');
    fs.appendFileSync(events, transition('succeeded'));
    assert.strictEqual(pick().done, true, 'committed complete-milestone transition proves the close without a ledger write');
    fs.rmSync(events);
    fs.mkdirSync(path.join(fixture.cwd, '.gsd', 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(fixture.cwd, '.gsd', 'ledger', `${fixture.milestone}.md`), 'closed\n');
    assert.strictEqual(pick().done, true, 'ledger fragment written by complete-milestone proves the close');
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

// --- S02/T06: time options in pure selection and in the shared mutating guard ---------
const timeSelection = require('./forge-milestone-time-selection.js');
const milestoneTime = require('./forge-milestone-time.js');
const pendingQuestions = require('./forge-pending-questions.js');
const { digest } = require('./forge-code-roots.js');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const TM = PROPOSALS.milestone, TNOW = Date.parse('2026-11-02T12:00:00.000Z');
let timeSerial = 0;

function testPureTimeOptionSelection() {
  const current = { milestone: 'M1', active_slice: 'S01' };
  const slice = { id: 'S01', plan_exists: true, research_exists: true, tasks: [{ id: 'T08', checked: false }, { id: 'T10', checked: false }] };
  const inventory = { roadmap_exists: true, context_exists: true, research_exists: true, slices: [slice] };
  const choose = changes => controller.selectNextUnit({ state: current, inventory: { ...inventory, ...changes }, prefs: {} });
  // Without time_options every branch is the legacy order.
  assert.strictEqual(choose({ roadmap_exists: false }).unit.type, 'plan-milestone');
  assert.strictEqual(choose({}).unit.id, 'T08', 'legacy keeps the checklist order');
  const estimate = choose({ roadmap_exists: false, time_options: { status: 'estimate-required', key_suffix: 'a'.repeat(24) } });
  assert.deepStrictEqual([estimate.unit.key, estimate.key_suffix], ['estimate-milestone/M1', 'a'.repeat(24)]);
  for (const status of ['materialization-required', 'decision-pending', 'activation-pending']) {
    const timeOptions = { status, options_sha256: 'b'.repeat(64) };
    assert.deepStrictEqual(choose({ roadmap_exists: false, time_options: timeOptions }), { ok: false, reason: 'time-option-pending', done: false, milestone: 'M1', time_options: timeOptions }, status);
  }
  assert.strictEqual(choose({ roadmap_exists: false, time_options: { status: 'options-invalid' } }).reason, 'time-options-invalid');
  assert.strictEqual(choose({ roadmap_exists: false, time_options: { status: 'decided', contract: null } }).unit.type, 'plan-milestone');
  for (const [roadmap, reason] of [['nonconformant', 'time-roadmap-nonconformant'], ['allocation-pending', 'time-allocation-pending'], ['scope-unallocated', 'time-scope-unallocated']]) {
    const blocked = choose({ context_exists: false, research_exists: false, time_options: { status: 'decided', contract: {}, roadmap: { status: roadmap } } });
    assert.deepStrictEqual([blocked.ok, blocked.reason, blocked.done], [false, reason, false], 'blocks before discuss, research and slices');
  }
  for (const timeOptions of [{ status: 'decided', contract: {}, roadmap: { status: 'conformant' } }, undefined]) {
    assert.strictEqual(choose({ context_exists: false, ...(timeOptions ? { time_options: timeOptions } : {}) }).unit.type, 'discuss-milestone', 'current plan/discuss/research order');
  }
  // An enrolled milestone with a ROADMAP but no attested choice is never legacy, whatever the inventory claims.
  for (const roadmap_exists of [true, false]) {
    const rogue = choose({ roadmap_exists, time_options: { status: 'roadmap-preexisting', options_recorded: 0 } });
    assert.deepStrictEqual([rogue.ok, rogue.reason, rogue.done], [false, 'time-roadmap-selection-missing', false], 'roadmap-preexisting blocks');
  }
  // Scoped DAG: an inverted checklist never replaces the dependency map.
  const dag = (rows, extra = {}) => ({ task_dag: true, slices: [{ ...slice, ...extra, task_dag: { status: 'valid', reasons: [], tasks: rows } }] });
  assert.strictEqual(choose(dag([{ id: 'T08', depends: ['T10'], completion: 'unproven' }, { id: 'T10', depends: [], completion: 'unproven' }])).unit.id, 'T10');
  const checkedOnly = choose(dag([{ id: 'T08', depends: ['T10'], completion: 'unproven' }, { id: 'T10', depends: [], completion: 'unproven' }],
    { tasks: [{ id: 'T08', checked: false }, { id: 'T10', checked: true }] }));
  assert.deepStrictEqual([checkedOnly.reason, checkedOnly.slice], ['time-task-dependency-pending', 'S01'], 'a checked box is not a proven predecessor');
  assert.strictEqual(choose(dag([{ id: 'T08', depends: ['T10'], completion: 'unproven' }, { id: 'T10', depends: [], completion: 'proven' }],
    { tasks: [{ id: 'T08', checked: false }, { id: 'T10', checked: true }] })).unit.id, 'T08');
  for (const [status, reason] of [['unknown', 'time-task-dependency-unknown'], ['cycle', 'time-task-dependency-cycle'], ['ambiguous', 'time-task-identity-ambiguous']]) {
    const refused = choose({ task_dag: true, slices: [{ ...slice, task_dag: { status, reasons: ['fixture'], tasks: [] } }] });
    assert.deepStrictEqual([refused.ok, refused.reason, refused.task_dag.status], [false, reason, status]);
  }
}

// Owner fixtures through the canonical T01/T03 APIs; controller records via its own writer.
function timeRoot() {
  const cwd = temp();
  for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) writeFile(cwd, `.gsd/milestones/${TM}/${TM}-${k}.md`, `# ${k}\nEscopo sintético\n`);
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
  state.write(cwd, { milestone: TM, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
  return cwd;
}
function writeFile(cwd, relative, content) {
  const file = path.join(cwd, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
}
function enrolledRoot() {
  const cwd = timeRoot();
  assert.strictEqual(timeSelection.enroll(cwd, TM, { source: 'owner', now: TNOW - 3600000 }).status, 'enrolled');
  return cwd;
}
const timePrefs = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
function testEnrolledCliSelectionParity() {
  const cwd = enrolledRoot();
  try {
    writeFile(cwd, '.gsd/forge-prefs.jsonc', JSON.stringify(timePrefs().prefs));
    const snapshot = () => {
      const rows = [];
      const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else rows.push([path.relative(cwd, file), fs.readFileSync(file).toString('base64')]);
        }
      };
      visit(path.join(cwd, '.gsd'));
      return rows;
    };
    const before = snapshot();
    const expected = controller.select(cwd, { milestone: TM }, { prefsReader: timePrefs });
    assert.strictEqual(expected.ok, true);
    assert.strictEqual(expected.unit.type, 'estimate-milestone');
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-controller.js'), '--select', TM, '--cwd', cwd], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, FORGE_HOME: path.join(cwd, '.forge-agent') },
    });
    assert.strictEqual(cli.status, 0, cli.stderr);
    const actual = JSON.parse(cli.stdout);
    assert.deepStrictEqual(actual.unit, expected.unit);
    assert.strictEqual(actual.ok, true);
    assert(!cli.stderr.includes('circular dependency'), 'CLI exports are available to the time-selection proof');
    assert.deepStrictEqual(snapshot(), before, 'API and CLI selection create no lease, transaction or artifact');
  } finally { cleanup(cwd); }
}
function timeOptions(offset = 0, extra = {}) { return { prefsReader: timePrefs, now: () => TNOW + offset, ...extra }; }
function estimateCompleted(cwd) {
  const before = timeSelection.readSelectionState(cwd, TM);
  const key = timeSelection.estimateBeginKey(TM, before.key_suffix), unit = `estimate-milestone/${TM}`;
  const begun = controller.begin(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'estimate-owner', idempotency_key: key }, timeOptions(-1800000));
  controller.complete(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'estimate-owner', generation: begun.generation,
    idempotency_key: `${key}:complete`, result: { status: 'succeeded' } }, timeOptions(-1700000));
  writeFile(cwd, `.gsd/milestones/${TM}/${TM}-OPTIONS.json`, JSON.stringify(PROPOSALS.base, null, 2));
  return key;
}
function answerRound(cwd, label) {
  const opened = timeSelection.nextRound({ cwd, milestone: TM });
  assert.strictEqual(opened.status, 'open', JSON.stringify(opened));
  assert.strictEqual(timeSelection.answerRound({ cwd, milestone: TM, round: opened.question_id, response: label, source: 'user-text' }).status, 'answered');
}
function live(cwd) {
  return { getDecisionHandle(request) {
    const read = pendingQuestions.continuation({ cwd, identity: request.question.identity_sha256 });
    const row = read.ok ? read.questions.find(q => q.id === request.question.id) : null;
    const record = { reference: 'fixture-' + request.question.id, status: 'resolved', answer: row && row.answer, source: 'user-text',
      resolved_at: new Date(TNOW - 1000).toISOString(), question: { ...request.question } };
    return milestoneTime.createDecisionAuthority(() => record).issue(record.reference, { milestone: request.milestone, kind: request.kind,
      request_sha256: digest(request.request), expires_at: TNOW + 60000 }, () => TNOW);
  } };
}
function decidedRoot(options = {}) {
  const cwd = enrolledRoot();
  estimateCompleted(cwd);
  assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW - 600000 }).status, 'materialized');
  answerRound(cwd, 'Escolher posição'); answerRound(cwd, 'Escopo completo (curta) (Recomendado)');
  const decided = timeSelection.decide({ cwd, milestone: TM, liveAdapter: live(cwd), now: TNOW, prefsReader: options.prefsReader || timePrefs,
    ...(options.failpoint ? { failpoint: options.failpoint } : {}) });
  if (!options.failpoint) assert.strictEqual(decided.status, 'decided', JSON.stringify(decided));
  return cwd;
}
const ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
  { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
  { id: 's4', kind: 'slice', slice: 'S04', ms: 1200000, nodes: ['N4'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
  { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
function conformantRoadmap(cwd, checked = [], s02Depends = 'S01') {
  const skeleton = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(timeSelection.promptBlock(cwd, TM))[1]);
  const box = id => (checked.includes(id) ? 'x' : ' ');
  writeFile(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, `# ${TM}: Fixture — Roadmap\n\n## Slices\n\n- [${box('S01')}] **S01: Contrato** \`risk:low\` \`depends:[]\`\n`
    + `- [${box('S02')}] **S02: Seleção** \`risk:low\` \`depends:[${s02Depends}]\`\n- [${box('S03')}] **S03: Resumo** \`risk:low\` \`depends:[]\`\n- [ ] **S04: Relatório** \`risk:low\` \`depends:[S02]\`\n\n`
    + `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify({ ...skeleton, allocation: ALLOCATION }, null, 2)}\n\`\`\`\n`);
}
function explicitBegin(cwd, unit, key, extra = {}, options = timeOptions()) {
  return controller.begin(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner', idempotency_key: key, ...extra }, options);
}
function refusedWithoutWrites(cwd, unit, key, code, extra, options) {
  const before = fs.existsSync(controller.transactionDir(cwd)) ? fs.readdirSync(controller.transactionDir(cwd)).length : 0;
  assert.throws(() => explicitBegin(cwd, unit, key, extra, options), error => error.code === code, `${unit}/${key} -> ${code}`);
  assert.strictEqual(controller.lookupRecord(cwd, 'transaction', key), null, 'no transaction');
  assert.strictEqual(fs.existsSync(controller.transactionDir(cwd)) ? fs.readdirSync(controller.transactionDir(cwd)).length : 0, before, 'no new record');
  assert.strictEqual(lease.observe(cwd, unit).lease, null, 'no lease');
}
// Forged caller data: an injected inventory claiming a decided selection with a roadmap.
const forgedInventory = { inventoryReader: () => ({ roadmap_exists: false, time_options: { status: 'decided', contract: null } }) };

function testTimeOptionGuardEveryState() {
  const roots = [];
  try {
    // Unenrolled: inventory keeps exactly its legacy keys and the guard is a no-op.
    const legacy = timeRoot(); roots.push(legacy);
    assert.deepStrictEqual(Object.keys(controller.discoverInventory(legacy, TM, state.read(legacy, TM))),
      ['roadmap_exists', 'context_exists', 'research_exists', 'active_slice', 'slices', 'dependency_validation', 'milestone_complete']);
    assert.strictEqual(explicitBegin(legacy, `plan-milestone/${TM}`, 'legacy-plan').ok, true);
    // estimate-required: only the estimate of the current basis with its exact key.
    const cwd = enrolledRoot(); roots.push(cwd);
    const required = timeSelection.readSelectionState(cwd, TM), key = timeSelection.estimateBeginKey(TM, required.key_suffix);
    const inventory = controller.discoverInventory(cwd, TM, state.read(cwd, TM));
    assert.deepStrictEqual([inventory.time_options.status, inventory.time_options.key_suffix], ['estimate-required', required.key_suffix]);
    const selected = controller.select(cwd, { milestone: TM }, timeOptions());
    assert.deepStrictEqual([selected.unit.key, selected.key_suffix], [`estimate-milestone/${TM}`, required.key_suffix]);
    refusedWithoutWrites(cwd, `plan-milestone/${TM}`, 'early-plan', 'time-option-pending');
    refusedWithoutWrites(cwd, `plan-milestone/${TM}`, 'early-plan-forged', 'time-option-pending', {}, timeOptions(0, forgedInventory));
    refusedWithoutWrites(cwd, `estimate-milestone/${TM}`, `${key}x`, 'time-option-pending');
    refusedWithoutWrites(cwd, 'execute-task/T01', 'early-task', 'time-option-pending', { state_patch: { active_slice: 'S01' }, slice: 'S01' });
    const begun = explicitBegin(cwd, `estimate-milestone/${TM}`, key, {}, timeOptions(-1800000));
    assert.strictEqual(begun.ok, true);
    // Replay of the committed begin stays idempotent, before the guard.
    assert.strictEqual(explicitBegin(cwd, `estimate-milestone/${TM}`, key, {}, timeOptions(-1790000)).reason, 'already-committed');
    controller.complete(cwd, { milestone: TM, unit: `estimate-milestone/${TM}`, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation,
      idempotency_key: `${key}:complete`, result: { status: 'succeeded' } }, timeOptions(-1700000));
    writeFile(cwd, `.gsd/milestones/${TM}/${TM}-OPTIONS.json`, JSON.stringify(PROPOSALS.base, null, 2));
    // materialization-required: nothing new is admitted, the old begin still replays.
    assert.strictEqual(timeSelection.readSelectionState(cwd, TM).status, 'materialization-required');
    refusedWithoutWrites(cwd, `plan-milestone/${TM}`, 'mat-plan', 'time-option-pending', {}, timeOptions(0, forgedInventory));
    assert.strictEqual(explicitBegin(cwd, `estimate-milestone/${TM}`, key, {}, timeOptions(-1600000)).reason, 'already-committed');
    // decision-pending: plan-milestone and every dependent unit refused, even with forged inventory/snapshot.
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW - 600000 }).status, 'materialized');
    assert.strictEqual(timeSelection.readSelectionState(cwd, TM).status, 'decision-pending');
    refusedWithoutWrites(cwd, `plan-milestone/${TM}`, 'pending-plan', 'time-option-pending', {}, timeOptions(0, forgedInventory));
    refusedWithoutWrites(cwd, `estimate-milestone/${TM}`, 'pending-estimate', 'time-option-pending');
    // activation-pending (crash after the selection): still pending.
    const activation = decidedRoot({ failpoint: name => name === 'after-selection' }); roots.push(activation);
    assert.strictEqual(timeSelection.readSelectionState(activation, TM).status, 'activation-pending');
    refusedWithoutWrites(activation, `plan-milestone/${TM}`, 'activation-plan', 'time-option-pending', {}, timeOptions(0, forgedInventory));
    // options-invalid (a selection whose answers do not exist) fails closed.
    const invalid = enrolledRoot(); roots.push(invalid);
    fs.copyFileSync(milestoneTime.timePaths({ cwd: activation, milestone: TM }).selection, milestoneTime.timePaths({ cwd: invalid, milestone: TM }).selection);
    assert.strictEqual(timeSelection.readSelectionState(invalid, TM).status, 'options-invalid');
    refusedWithoutWrites(invalid, `plan-milestone/${TM}`, 'invalid-plan', 'time-options-invalid', {}, timeOptions(0, forgedInventory));
    // decided without roadmap: only plan-milestone; estimate and tasks are not admitted.
    const decided = decidedRoot(); roots.push(decided);
    refusedWithoutWrites(decided, `estimate-milestone/${TM}`, 'decided-estimate', 'time-unit-not-admitted');
    refusedWithoutWrites(decided, 'execute-task/T01', 'decided-task', 'time-unit-not-admitted', { state_patch: { active_slice: 'S01' }, slice: 'S01' });
    assert.strictEqual(explicitBegin(decided, `plan-milestone/${TM}`, 'decided-plan', {}, timeOptions(1000)).ok, true);
  } finally { for (const cwd of roots) cleanup(cwd); }
}

function testTimeOptionGuardRoadmapAndBudgetPriority() {
  const cwd = decidedRoot();
  try {
    writeFile(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, `# ${TM}\n\n- [ ] **S01: Contrato** \`depends:[]\`\n`);
    const slice = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    refusedWithoutWrites(cwd, 'plan-slice/S01', 'nonconformant-slice', 'time-roadmap-nonconformant', slice);
    // Budget refusal keeps its priority over the S02 refusal (both apply after the ceiling).
    const ceiling = milestoneTime.readContract({ cwd, milestone: TM }).contract.ceiling_ms;
    refusedWithoutWrites(cwd, 'plan-slice/S01', 'exhausted-slice', 'milestone-budget-exhausted', slice, timeOptions(ceiling + 60000));
    conformantRoadmap(cwd);
    refusedWithoutWrites(cwd, 'plan-slice/S01', 'allocation-slice', 'time-allocation-pending', slice);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    assert.strictEqual(explicitBegin(cwd, 'plan-slice/S01', 'conformant-slice', slice, timeOptions(2000)).ok, true);
  } finally { cleanup(cwd); }
}

// R46: a ROADMAP written after enrollment but before an attested choice is not legacy.
const ROGUE_ROADMAP = `# ${TM}\n\n- [ ] **S01: Contrato** \`depends:[]\`\n`;
function testRogueRoadmapAfterEnrollment() {
  const legacy = timeRoot(), cwd = enrolledRoot();
  try {
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    // Genuine legacy control: no enrollment, a ROADMAP keeps the legacy admission.
    writeFile(legacy, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, ROGUE_ROADMAP);
    assert.strictEqual(timeSelection.readSelectionState(legacy, TM), null);
    assert.strictEqual(explicitBegin(legacy, 'plan-slice/S01', 'legacy-roadmap', s01).ok, true);
    // Enrolled with an estimate pending, then the ROADMAP appears without any attested choice.
    const key = timeSelection.estimateBeginKey(TM, timeSelection.readSelectionState(cwd, TM).key_suffix);
    writeFile(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, ROGUE_ROADMAP);
    assert.strictEqual(timeSelection.readSelectionState(cwd, TM).status, 'roadmap-preexisting');
    const next = controller.select(cwd, { milestone: TM }, timeOptions());
    assert.deepStrictEqual([next.ok, next.reason], [false, 'time-roadmap-selection-missing']);
    const legacyInventory = { inventoryReader: () => ({ roadmap_exists: true, time_options: null }) };
    for (const [unit, id, extra] of [['plan-slice/S01', 'rogue-plan', s01], ['execute-task/T01', 'rogue-task', s01], [`estimate-milestone/${TM}`, key, {}]]) {
      refusedWithoutWrites(cwd, unit, id, 'time-roadmap-selection-missing', extra);
      refusedWithoutWrites(cwd, unit, `${id}-forged`, 'time-roadmap-selection-missing', extra, timeOptions(0, legacyInventory));
    }
  } finally { cleanup(legacy); cleanup(cwd); }
}
function testRogueRoadmapBlocksReentry() {
  const cwd = enrolledRoot();
  try {
    const key = timeSelection.estimateBeginKey(TM, timeSelection.readSelectionState(cwd, TM).key_suffix), unit = `estimate-milestone/${TM}`;
    // A failure needs a slice in its begin state to pass the ancestry check; the estimate unit itself is still the admitted one.
    const begun = explicitBegin(cwd, unit, key, { state_patch: { active_slice: 'S01' }, slice: 'S01' }, timeOptions(-1800000));
    assert.strictEqual(begun.ok, true);
    const recovery = require('./forge-attempt-recovery.js');
    const request = { cwd, contextRoot: cwd, milestoneId: TM, sliceId: null, taskId: null, scope: 'milestone', phase: 'estimate', unitType: 'estimate-milestone',
      roadmapFile: path.join(cwd, `.gsd/milestones/${TM}/${TM}-SCOPE.md`), route: { host_runtime: 'codex', resolved_worker_engine: 'codex' } };
    const receipt = writeFile(cwd, 'receipt.json', JSON.stringify({ phase: 'failed', recovery_identity_sha256: digest(recovery.requestIdentity(request)),
      failure: { reason_code: 'claude-timeout', provider_called: 'unknown' } }));
    const live = timeOptions(-1700000, { processProbe: () => 'stopped',
      inspectAttempt: () => ({ receipt_path: receipt, request, roots: [{ root_id: 'primary', path: cwd }], pending_questions: [] }),
      reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
      captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: cwd }] }),
      entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) });
    const consumed = controller.consumeFailure(cwd, { begin_key: key, unit, milestone: TM, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation }, live);
    assert.strictEqual(consumed.reason, 'failure-consumed');
    writeFile(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, ROGUE_ROADMAP);
    const entry = { entry_id: 'rogue-entry', failure_key: consumed.failure_key, failure_checksum: consumed.failure_checksum, authorization_ref: 'conversation:fixture' };
    assert.throws(() => controller.reenter(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner', entry }, live),
      error => error.code === 'time-roadmap-selection-missing');
    assert.strictEqual(controller.lookupRecord(cwd, 'transaction', `linked-entry:${require('crypto').createHash('sha256').update('rogue-entry').digest('hex')}`), null);
    assert.strictEqual(lease.observe(cwd, unit).lease, null);
  } finally { cleanup(cwd); }
}

// Opt-in TaskPlan binding: exact selected options digest, position and one allocated node/part (owner state, never caller JSON).
const NODE_OF = { S01: 'N1', S02: 'N2', S03: 'N3', S04: 'N4' };
function bindingLines(cwd, slice, node = NODE_OF[slice]) {
  const selected = timeSelection.readSelectionState(cwd, TM);
  return `time_options_sha256: ${selected.options_sha256}\ntime_position_id: ${selected.position_id}\ntime_node: ${node}\n`;
}
function taskPlanFile(cwd, slice, id, depends, node) {
  writeFile(cwd, `.gsd/milestones/${TM}/slices/${slice}/tasks/${id}/${id}-PLAN.md`, `---\nid: ${id}\ndepends: [${depends.join(', ')}]\n${bindingLines(cwd, slice, node)}---\n# ${id}\n`);
}
function slicePlanFile(cwd, slice, ids) {
  writeFile(cwd, `.gsd/milestones/${TM}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n\n## Tasks\n${ids.map(([id, checked]) => `- [${checked ? 'x' : ' '}] **${id}: Trabalho**`).join('\n')}\n`);
}
// Genuine canonical historical proof: a structured multi-criterion plan with declared writes, the
// captured verification and artifact envelopes of one workspace (concrete blob per declared path),
// the delivery input and the output produced by the public builder (no hand-made verified JSON).
const BLOB = 'b'.repeat(40);
function taskDelivery(cwd, slice, task, options = {}) {
  const milestone = options.milestone || TM;
  const delivery = require('./forge-delivery.js'), unit = { type: 'task', id: task, slice, milestone }, key = delivery.unitKey(unit);
  const base = `.gsd/milestones/${milestone}/slices/${slice}/tasks/${task}`, rel = name => `${base}/${task}-${name}`, source = `src/${task}.js`;
  // bare: a genuine delivery whose plan declares no source path at all (no inventory to bind).
  const planText = options.bare
    ? `---\nid: ${task}\ndepends: []\n${bindingLines(cwd, slice, options.node)}must_haves:\n  truths:\n    - "${task} comportamento observável"\n    - "${task} segundo comportamento"\n  artifacts: []\n  key_links: []\nexpected_output: []\n---\n# ${task}\n`
    : `---\nid: ${task}\ndepends: []\n${bindingLines(cwd, slice, options.node)}writes:\n  - "${source}"\nmust_haves:\n  truths:\n    - "${task} comportamento observável"\n`
    + `    - "${task} segundo comportamento"\n  artifacts:\n    - path: "${source}"\n      provides: "${task} source"\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - "${source}"\n---\n# ${task}\n`;
  writeFile(cwd, rel('PLAN.md'), planText);
  const at = new Date(TNOW).toISOString();
  const context = { schema_version: 1, unit, plan_fingerprint: delivery.sha256(planText), code_dir: cwd, revision: 'abc123',
    workspace: [{ path: source, hash: BLOB }], environment: 'node-test', captured_at: at };
  const checks = [{ command: 'node check.js one', exitCode: options.exitCode || 0 }, { command: 'node check.js two', exitCode: 0 }];
  writeFile(cwd, rel('VERIFY-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'verification', result: { passed: !options.exitCode, checks } }));
  writeFile(cwd, rel('ARTIFACT-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'artifact', result: { passed: true, rows: [{ path: source, exists: true }] } }));
  const input = { schema_version: 1, unit, plan: rel('PLAN.md'), plan_fingerprint: delivery.sha256(planText), bindings: [
    { criterion_id: `${key}:truth:0`, coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 0 } },
    { criterion_id: `${key}:truth:1`, coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 1 } },
    ...(options.bare ? [] : [{ criterion_id: `${key}:artifact:0`, coverage: 'structural', source: { kind: 'artifact', path: rel('ARTIFACT-ENVELOPE.json'), row_index: 0, property: 'exists' } }])] };
  writeFile(cwd, rel('DELIVERY-INPUT.json'), JSON.stringify(input));
  const built = delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd });
  if (!options.exitCode) assert.ok(built.criteria.length === (options.bare ? 2 : 3) && built.criteria.every(item => item.status === 'verificado'), JSON.stringify(built.diagnostics));
  return writeFile(cwd, rel('DELIVERY.json'), JSON.stringify(built));
}
function completeTask(cwd, slice, task, offset, completeKey) {
  const key = `dag-${slice}-${task}`, unit = `execute-task/${task}`;
  const begun = explicitBegin(cwd, unit, key, { state_patch: { active_slice: slice }, slice }, timeOptions(offset));
  // The completion key is the caller's choice; lineage, not its spelling, binds it to the begin.
  controller.complete(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation,
    idempotency_key: completeKey || `${key}-finish-${task}`, result: { status: 'succeeded' } }, timeOptions(offset + 500));
}
// Genuine canonical slice closure: the review gate record, the slice delivery built by the public
// builder over the exact slice plan and every child delivery, then the real complete-slice transition.
function closeSlice(cwd, slice, tasks, offset, options = {}) {
  const milestone = options.milestone || TM;
  const delivery = require('./forge-delivery.js'), base = `.gsd/milestones/${milestone}/slices/${slice}`;
  if (options.review !== false) writeFile(cwd, `${base}/${slice}-REVIEW.md`, `# ${slice} review\n\n**Outcome:** 0 resolved · 0 conceded · 0 open\n`);
  const planText = fs.readFileSync(path.join(cwd, ...`${base}/${slice}-PLAN.md`.split('/')), 'utf8');
  const input = { schema_version: 1, unit: { type: 'slice', id: slice, milestone }, plan: `${base}/${slice}-PLAN.md`, plan_fingerprint: delivery.sha256(planText), bindings: [],
    expected_children: tasks.map(task => ({ unit: { type: 'task', id: task, slice, milestone }, delivery: `${base}/tasks/${task}/${task}-DELIVERY.json` })),
    facts: options.facts || { review: { status: 'completed with 0 open', reference: `${slice}-REVIEW.md` } } };
  writeFile(cwd, `${base}/${slice}-DELIVERY-INPUT.json`, JSON.stringify(input));
  writeFile(cwd, `${base}/${slice}-DELIVERY.json`, JSON.stringify(delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd })));
  if (options.complete === false) return;
  const key = options.milestone ? `close-${milestone}-${slice}` : `close-${slice}`, unit = `complete-slice/${slice}`;
  const begun = controller.begin(cwd, { milestone, unit, host_runtime: 'codex', owner_token: 'explicit-owner', idempotency_key: key, state_patch: { active_slice: slice }, slice }, timeOptions(offset));
  controller.complete(cwd, { milestone, unit, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation,
    idempotency_key: `${key}-done`, result: { status: 'succeeded' } }, timeOptions(offset + 500));
}
function taskProof(cwd, slice, task) {
  return controller.discoverInventory(cwd, TM, state.read(cwd, TM), timeOptions()).slices.find(item => item.id === slice).task_dag.tasks.find(item => item.id === task).completion;
}
function testHistoricalProofTamperAndLineage() {
  const cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S01', 'T08', ['T10']); taskPlanFile(cwd, 'S01', 'T10', []);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    // A genuine delivery without a committed completion stays blocked.
    taskDelivery(cwd, 'S01', 'T10');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'unproven');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-delivery-only', 'time-task-dependency-pending', s01);
    // Independent completion key through the real begin/complete: lineage proves it.
    completeTask(cwd, 'S01', 'T10', 3000, 'finish-T10');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven');
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T08');
    // Replay of the same completion stays idempotent and the proof is unchanged.
    const begun = controller.lookupRecord(cwd, 'transaction', 'dag-S01-T10');
    const replay = controller.complete(cwd, { milestone: TM, unit: 'execute-task/T10', host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.lease_generation,
      idempotency_key: 'finish-T10', result: { status: 'succeeded' } }, timeOptions(3500));
    assert.strictEqual(replay.ok, true);
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven');
    // Legitimate later code changes never invalidate completed history.
    writeFile(cwd, 'scripts/unrelated.js', 'module.exports = 2;\n');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven');
    const dir = `.gsd/milestones/${TM}/slices/S01/tasks/T10`, read = name => fs.readFileSync(path.join(cwd, dir, `T10-${name}`), 'utf8');
    const delivery = require('./forge-delivery.js');
    const forge = (name, edit) => { const value = JSON.parse(read(name)); edit(value); return JSON.stringify(value); };
    const put = (name, text) => writeFile(cwd, `${dir}/T10-${name}`, text);
    const names = ['DELIVERY.json', 'VERIFY-ENVELOPE.json', 'PLAN.md', 'DELIVERY-INPUT.json'];
    const tampers = {
      'forged status re-fingerprinted': () => put('DELIVERY.json', JSON.stringify(delivery.finalizeOutput(JSON.parse(forge('DELIVERY.json', v => { v.criteria[0].status = 'verificado'; v.criteria[0].pending = []; v.criteria[0].evidence = []; }))))),
      'evidence flipped': () => put('VERIFY-ENVELOPE.json', forge('VERIFY-ENVELOPE.json', v => { v.result.checks[0].exitCode = 1; v.result.passed = false; })),
      'plan edited': () => put('PLAN.md', `${read('PLAN.md')}\nextra\n`),
      'input retargeted': () => put('DELIVERY-INPUT.json', forge('DELIVERY-INPUT.json', v => { v.unit.id = 'T11'; })),
      'foreign root': () => put('VERIFY-ENVELOPE.json', forge('VERIFY-ENVELOPE.json', v => { v.code_dir = os.tmpdir(); })),
      'input missing': () => fs.rmSync(path.join(cwd, dir, 'T10-DELIVERY-INPUT.json')),
    };
    let index = 0;
    for (const [label, tamper] of Object.entries(tampers)) {
      const saved = Object.fromEntries(names.map(name => [name, read(name)]));
      tamper();
      assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'unproven', label);
      assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T10', `next ${label}`);
      refusedWithoutWrites(cwd, 'execute-task/T08', `T08-tamper-${index++}`, 'time-task-dependency-pending', s01);
      for (const [name, text] of Object.entries(saved)) put(name, text);
      assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven', `restored ${label}`);
    }
    // A genuine completion with a failing capture never proves.
    taskDelivery(cwd, 'S01', 'T10', { exitCode: 1 });
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'unproven');
    // Foreign scope: the same delivery in another slice has no completion of its own.
    slicePlanFile(cwd, 'S03', [['T10', false]]); taskPlanFile(cwd, 'S03', 'T10', []); taskDelivery(cwd, 'S03', 'T10');
    assert.strictEqual(taskProof(cwd, 'S03', 'T10'), 'unproven');
  } finally { cleanup(cwd); }
}

// R53: captured metadata the rebuilt delivery fingerprint does not cover (capture time, declared-source
// bindings, consistency between the verification and artifact captures of one workspace).
function captureTampers(cwd, dir, task) {
  const file = name => path.join(cwd, dir, `${task}-${name}`);
  const edit = (name, change) => { const value = JSON.parse(fs.readFileSync(file(name), 'utf8')); change(value); fs.writeFileSync(file(name), JSON.stringify(value)); };
  const both = change => { edit('VERIFY-ENVELOPE.json', change); edit('ARTIFACT-ENVELOPE.json', change); };
  return {
    'capture after the committed completion': () => both(v => { v.captured_at = new Date(TNOW + 86400000).toISOString(); }),
    'capture time malformed': () => both(v => { v.captured_at = 'ontem'; }),
    'declared source binding missing': () => both(v => { v.workspace = []; }),
    'undeclared path in place of the declared one': () => both(v => { v.workspace = [{ path: 'src/other.js', hash: BLOB }]; }),
    'source binding changed in one capture': () => edit('VERIFY-ENVELOPE.json', v => { v.workspace[0].hash = 'd'.repeat(40); }),
    'artifact captured before verification': () => edit('ARTIFACT-ENVELOPE.json', v => { v.captured_at = new Date(TNOW - 60000).toISOString(); }),
  };
}
const CAPTURE_FILES = ['DELIVERY.json', 'DELIVERY-INPUT.json', 'PLAN.md', 'VERIFY-ENVELOPE.json', 'ARTIFACT-ENVELOPE.json'];
function completionTs(cwd, key) { return controller.readEvents(controller.eventsFile(cwd, TM)).find(item => item.idempotency_key === key).ts; }
function testHistoricalCaptureMetadataAndInventory() {
  const cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S01', 'T08', ['T10']); taskPlanFile(cwd, 'S01', 'T10', []);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    completeTask(cwd, 'S01', 'T10', 3000, 'finish-T10');
    taskDelivery(cwd, 'S01', 'T10');
    const clock = require('./forge-milestone-time-clock.js'), delivery = require('./forge-delivery.js');
    const request = { cwd, milestone: TM, slice: 'S01', task: 'T10', completedAt: completionTs(cwd, 'finish-T10') };
    // Positive: structured multi-criterion plan, declared writes and the two real captures of one workspace.
    const before = treeSnapshot(cwd);
    const proof = clock.readHistoricalTaskDelivery(request);
    assert.deepStrictEqual([proof.status, proof.coverage, proof.current_source_conformity, proof.captures.length], ['proven', { criteria: 3, captures: 2, sources: 1 }, 'not-evaluated', 2]);
    assert.strictEqual(treeSnapshot(cwd), before, 'readonly proof');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven');
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T08');
    // The capture never postdates the committed completion instant; a malformed instant proves nothing.
    assert.strictEqual(clock.readHistoricalTaskDelivery({ ...request, completedAt: new Date(TNOW - 1).toISOString() }).reason, 'delivery-capture-time-invalid');
    assert.strictEqual(clock.readHistoricalTaskDelivery({ ...request, completedAt: 'agora' }).reason, 'delivery-completion-time-invalid');
    assert.strictEqual(clock.readHistoricalTaskDelivery({ ...request, task: '../T10' }).reason, 'delivery-task-invalid');
    // Legitimate later code changes never invalidate the history (today's bytes are not compared).
    writeFile(cwd, 'src/T10.js', 'module.exports = "later";\n');
    assert.strictEqual(clock.readHistoricalTaskDelivery(request).status, 'proven');
    const dir = `.gsd/milestones/${TM}/slices/S01/tasks/T10`, file = name => path.join(cwd, dir, `T10-${name}`);
    const stored = () => JSON.parse(fs.readFileSync(file('DELIVERY.json'), 'utf8')).delivery_fingerprint;
    let index = 0;
    for (const [label, tamper] of Object.entries(captureTampers(cwd, dir, 'T10'))) {
      const saved = Object.fromEntries(CAPTURE_FILES.map(name => [name, fs.readFileSync(file(name))]));
      tamper();
      try {
        // Metadata tampering keeps the rebuilt fingerprint: it must not pass merely because of that.
        const rebuilt = delivery.buildDelivery(JSON.parse(fs.readFileSync(file('DELIVERY-INPUT.json'), 'utf8')), { ownerRoot: cwd, codeDir: cwd });
        assert.strictEqual(rebuilt.delivery_fingerprint, stored(), `${label}: fingerprint unchanged`);
        const refused = clock.readHistoricalTaskDelivery(request);
        assert.strictEqual(refused.status, 'unproven', label);
        assert.match(refused.reason, /^delivery-/, label);
        assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'unproven', label);
        assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T10', `next ${label}`);
        refusedWithoutWrites(cwd, 'execute-task/T08', `T08-capture-${index++}`, 'time-task-dependency-pending', s01);
      } finally { for (const [name, bytes] of Object.entries(saved)) fs.writeFileSync(file(name), bytes); }
      assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven', `restored ${label}`);
    }
    // A genuine delivery whose plan declares no source path has no inventory to bind.
    taskDelivery(cwd, 'S01', 'T10', { bare: true });
    assert.strictEqual(clock.readHistoricalTaskDelivery(request).reason, 'delivery-source-inventory-missing');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-capture-bare', 'time-task-dependency-pending', s01);
    taskDelivery(cwd, 'S01', 'T10');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven');
  } finally { cleanup(cwd); }
}
// R54: the published begin and completion events are bound symmetrically to the committed
// transactions (only the stream sequence removed), with finite ordered safe-integer sequences.
function testCompletionEventLineage() {
  const cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S01', 'T08', ['T10']); taskPlanFile(cwd, 'S01', 'T10', []);
    completeTask(cwd, 'S01', 'T10', 3000, 'finish-T10');
    taskDelivery(cwd, 'S01', 'T10');
    assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven', 'real committed begin/completion positive');
    const file = controller.eventsFile(cwd, TM), original = fs.readFileSync(file, 'utf8');
    const editEvent = (key, change) => {
      const rows = original.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      change(rows.find(row => row.idempotency_key === key));
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    };
    const cases = [
      ['begin unit (scope) edited', 'dag-S01-T10', row => { row.unit = 'execute-task/T11'; }],
      ['begin host edited', 'dag-S01-T10', row => { row.host_runtime = 'claude'; }],
      ['begin action edited', 'dag-S01-T10', row => { row.action = 'complete'; }],
      ['begin milestone edited', 'dag-S01-T10', row => { row.milestone = 'M-OUTRA'; }],
      ['begin event name edited', 'dag-S01-T10', row => { row.event = 'unit-transition'; }],
      ['begin event missing', 'dag-S01-T10', row => { row.idempotency_key = 'dag-S01-T10-renamed'; }],
      ['begin sequence not an integer', 'dag-S01-T10', row => { row.sequence = String(row.sequence); }],
      ['begin sequence zero', 'dag-S01-T10', row => { row.sequence = 0; }],
      ['begin sequence after the completion', 'dag-S01-T10', row => { row.sequence = 9999; }],
      ['completion sequence fractional', 'finish-T10', row => { row.sequence += 0.5; }],
      ['completion sequence unsafe', 'finish-T10', row => { row.sequence = Number.MAX_SAFE_INTEGER + 2; }],
      ['completion outcome edited', 'finish-T10', row => { row.outcome = 'failed'; }],
    ];
    for (const [label, key, change] of cases) {
      editEvent(key, change);
      try { assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'unproven', label); }
      finally { fs.writeFileSync(file, original); }
      assert.strictEqual(taskProof(cwd, 'S01', 'T10'), 'proven', `restored ${label}`);
    }
    // The same refusal at next and at an explicit begin of the dependent, with zero writes.
    editEvent('dag-S01-T10', row => { row.host_runtime = 'claude'; });
    try {
      assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T10');
      refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-begin-host-edited', 'time-task-dependency-pending', { state_patch: { active_slice: 'S01' }, slice: 'S01' });
    } finally { fs.writeFileSync(file, original); }
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T08');
  } finally { cleanup(cwd); }
}
// R55: review.mode disabled is a named incompatibility before a contracted activation and for every
// new admission after it; no-contract and unenrolled milestones keep their normal behavior.
function testReviewModeIncompatibleWithContract() {
  const disabled = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true }, review: { mode: 'disabled' } } });
  const roots = [];
  try {
    const cwd = enrolledRoot(); roots.push(cwd);
    estimateCompleted(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW - 600000 }).status, 'materialized');
    answerRound(cwd, 'Escolher posição'); answerRound(cwd, 'Escopo completo (curta) (Recomendado)');
    assert.deepStrictEqual(timeSelection.contractCompatibility(cwd, TM, { prefsReader: disabled }), { status: 'incompatible', reason: 'review-disabled', review_mode: 'disabled' });
    assert.deepStrictEqual(timeSelection.contractCompatibility(cwd, TM, { prefsReader: timePrefs }), { status: 'compatible', reason: null, review_mode: 'enabled' });
    assert.strictEqual(timeSelection.contractCompatibility(cwd, TM, { prefsReader: () => ({ ok: false, errors: [] }) }).status, 'unknown');
    // The contracted choice is refused by name before any host callback or write.
    let called = 0;
    const counting = { getDecisionHandle: request => { called++; return live(cwd).getDecisionHandle(request); } };
    const before = treeSnapshot(cwd);
    const refused = timeSelection.decide({ cwd, milestone: TM, liveAdapter: counting, now: TNOW, prefsReader: disabled });
    assert.deepStrictEqual([refused.status, refused.reason, called], ['refused', 'time-review-disabled-incompatible', 0]);
    assert.strictEqual(timeSelection.decide({ cwd, milestone: TM, liveAdapter: counting, now: TNOW, prefsReader: () => ({ ok: false, errors: [] }) }).reason, 'time-review-mode-unknown');
    assert.strictEqual(treeSnapshot(cwd), before, 'no selection, contract or question written');
    assert.strictEqual(timeSelection.readSelectionState(cwd, TM).status, 'decision-pending');
    // Restoring a compatible mode activates the same recorded answers, without a new question.
    assert.strictEqual(timeSelection.decide({ cwd, milestone: TM, liveAdapter: live(cwd), now: TNOW, prefsReader: timePrefs }).status, 'decided');
    // After activation: a new admission is refused with zero writes; an admitted begin still replays.
    refusedWithoutWrites(cwd, `plan-milestone/${TM}`, 'review-off-plan', 'time-review-disabled-incompatible', {}, timeOptions(1000, { prefsReader: disabled }));
    assert.strictEqual(explicitBegin(cwd, `plan-milestone/${TM}`, 'review-on-plan', {}, timeOptions(2000)).ok, true);
    assert.strictEqual(explicitBegin(cwd, `plan-milestone/${TM}`, 'review-on-plan', {}, timeOptions(2500, { prefsReader: disabled })).reason, 'already-committed');
    // activation-pending recovery waits too, then resumes with the compatible mode.
    const pending = decidedRoot({ failpoint: name => name === 'after-selection' }); roots.push(pending);
    assert.strictEqual(timeSelection.readSelectionState(pending, TM).status, 'activation-pending');
    assert.strictEqual(timeSelection.decide({ cwd: pending, milestone: TM, liveAdapter: live(pending), now: TNOW, prefsReader: disabled }).reason, 'time-review-disabled-incompatible');
    assert.strictEqual(timeSelection.readSelectionState(pending, TM).status, 'activation-pending');
    assert.strictEqual(timeSelection.decide({ cwd: pending, milestone: TM, liveAdapter: live(pending), now: TNOW, prefsReader: timePrefs }).resumed, true);
    // Unenrolled and attested no-contract milestones keep their behavior with review disabled.
    const legacy = timeRoot(); roots.push(legacy);
    assert.strictEqual(explicitBegin(legacy, `plan-milestone/${TM}`, 'legacy-review-off', {}, timeOptions(0, { prefsReader: disabled })).ok, true);
    const none = enrolledRoot(); roots.push(none);
    estimateCompleted(none);
    assert.strictEqual(timeSelection.prepareBoundary(none, TM, { now: TNOW - 600000 }).status, 'materialized');
    answerRound(none, 'Sem contrato');
    assert.strictEqual(timeSelection.decide({ cwd: none, milestone: TM, liveAdapter: live(none), now: TNOW, prefsReader: disabled }).choice, 'no-contract');
    assert.strictEqual(explicitBegin(none, `plan-milestone/${TM}`, 'none-review-off', {}, timeOptions(1000, { prefsReader: disabled })).ok, true);
  } finally { for (const cwd of roots) cleanup(cwd); }
}

function testScopedTaskDagGuardAndReentry() {
  const cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S01', 'T08', ['T10']); taskPlanFile(cwd, 'S01', 'T10', []);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    // Inverted list: selection admits T10; an explicit begin of T08 before T10 is refused.
    const inventory = controller.discoverInventory(cwd, TM, state.read(cwd, TM));
    assert.deepStrictEqual([inventory.task_dag, inventory.slices[0].task_dag.status], [true, 'valid']);
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-before-T10', 'time-task-dependency-pending', s01);
    // A checked box and a SUMMARY alone never prove the predecessor.
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', true]]); writeFile(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/T10/T10-SUMMARY.md`, '# T10\n');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-summary-only', 'time-task-dependency-pending', s01);
    completeTask(cwd, 'S01', 'T10', 3000);
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-no-delivery', 'time-task-dependency-pending', s01);
    const deliveryPath = taskDelivery(cwd, 'S01', 'T10');
    // Same task IDs in S03 do not collide with S01's proof.
    slicePlanFile(cwd, 'S03', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S03', 'T08', ['T10']); taskPlanFile(cwd, 'S03', 'T10', []);
    refusedWithoutWrites(cwd, 'execute-task/T08', 'S03-T08', 'time-task-dependency-pending', { state_patch: { active_slice: 'S03' }, slice: 'S03' });
    // A present but malformed or repeated depends declaration never becomes an empty list (T08 would turn into a root).
    const planOf = text => writeFile(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/T08/T08-PLAN.md`, `---\nid: T08\n${text}---\n# T08\n`);
    for (const [label, text] of [['scalar', 'depends: T10\n'], ['broken-inline', 'depends: [T10\n'], ['duplicate', 'depends: [T10]\ndepends: []\n']]) {
      planOf(text);
      const blockedNext = controller.select(cwd, { milestone: TM }, timeOptions());
      assert.deepStrictEqual([blockedNext.ok, blockedNext.reason], [false, 'time-task-dependency-unknown'], `next ${label}`);
      refusedWithoutWrites(cwd, 'execute-task/T08', `T08-malformed-${label}`, 'time-task-dependency-unknown', s01);
    }
    taskPlanFile(cwd, 'S01', 'T08', ['T10']);
    // T08 begins once the scoped completion and verified delivery exist; then fails and is consumed.
    const begun = explicitBegin(cwd, 'execute-task/T08', 'T08-begin', s01, timeOptions(5000));
    assert.strictEqual(begun.ok, true);
    const recovery = require('./forge-attempt-recovery.js');
    const request = { cwd, contextRoot: cwd, milestoneId: TM, sliceId: 'S01', taskId: 'T08', scope: 'milestone', phase: 'execute', unitType: 'execute-task',
      roadmapFile: path.join(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`), route: { host_runtime: 'codex', resolved_worker_engine: 'codex' } };
    const receipt = writeFile(cwd, 'receipt.json', JSON.stringify({ phase: 'failed', recovery_identity_sha256: digest(recovery.requestIdentity(request)),
      failure: { reason_code: 'claude-timeout', provider_called: 'unknown' } }));
    const live = timeOptions(6000, { processProbe: () => 'stopped',
      inspectAttempt: () => ({ receipt_path: receipt, request, roots: [{ root_id: 'primary', path: cwd }], pending_questions: [] }),
      reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
      captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: cwd }] }),
      entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) });
    const consumed = controller.consumeFailure(cwd, { begin_key: 'T08-begin', unit: 'execute-task/T08', milestone: TM, host_runtime: 'codex', owner_token: 'explicit-owner',
      generation: begun.generation }, live);
    assert.strictEqual(consumed.reason, 'failure-consumed');
    const entry = { entry_id: 'T08-entry', failure_key: consumed.failure_key, failure_checksum: consumed.failure_checksum, authorization_ref: 'conversation:fixture' };
    const reenter = () => controller.reenter(cwd, { milestone: TM, unit: 'execute-task/T08', host_runtime: 'codex', owner_token: 'explicit-owner', entry }, live);
    // A malformed or repeated depends declaration refuses reentry too, before any lease or transaction.
    const entryKey = `linked-entry:${require('crypto').createHash('sha256').update('T08-entry').digest('hex')}`;
    for (const [label, text] of [['scalar', 'depends: T10\n'], ['broken-inline', 'depends: [T10\n'], ['duplicate', 'depends: [T10]\ndepends: []\n']]) {
      planOf(text);
      assert.throws(reenter, error => error.code === 'time-task-dependency-unknown', `reentry ${label}`);
      assert.strictEqual(controller.lookupRecord(cwd, 'transaction', entryKey), null, `reentry ${label}: no transaction`);
      assert.strictEqual(lease.observe(cwd, 'execute-task/T08').lease, null, `reentry ${label}: no lease`);
    }
    taskPlanFile(cwd, 'S01', 'T08', ['T10']);
    // Reentry with the predecessor proof gone is refused before any lease or transaction.
    fs.renameSync(deliveryPath, deliveryPath + '.away');
    assert.throws(reenter, error => error.code === 'time-task-dependency-pending');
    assert.strictEqual(controller.lookupRecord(cwd, 'transaction', `linked-entry:${require('crypto').createHash('sha256').update('T08-entry').digest('hex')}`), null);
    assert.strictEqual(lease.observe(cwd, 'execute-task/T08').lease, null);
    fs.renameSync(deliveryPath + '.away', deliveryPath);
    // A tampered captured envelope (status in DELIVERY.json left intact) refuses reentry too.
    const envelopePath = deliveryPath.replace('-DELIVERY.json', '-VERIFY-ENVELOPE.json'), envelopeText = fs.readFileSync(envelopePath, 'utf8');
    fs.writeFileSync(envelopePath, envelopeText.replace('"exitCode":0', '"exitCode":1'));
    assert.throws(reenter, error => error.code === 'time-task-dependency-pending');
    assert.strictEqual(lease.observe(cwd, 'execute-task/T08').lease, null);
    fs.writeFileSync(envelopePath, envelopeText);
    // R53 at a new reentry: future/malformed capture time and missing/changed source bindings refuse with zero writes.
    const t10Dir = `.gsd/milestones/${TM}/slices/S01/tasks/T10`, t10File = name => path.join(cwd, t10Dir, `T10-${name}`);
    for (const [label, tamper] of Object.entries(captureTampers(cwd, t10Dir, 'T10'))) {
      const saved = Object.fromEntries(CAPTURE_FILES.map(name => [name, fs.readFileSync(t10File(name))]));
      tamper();
      try {
        assert.throws(reenter, error => error.code === 'time-task-dependency-pending', `reentry ${label}`);
        assert.strictEqual(controller.lookupRecord(cwd, 'transaction', entryKey), null, `reentry ${label}: no transaction`);
        assert.strictEqual(lease.observe(cwd, 'execute-task/T08').lease, null, `reentry ${label}: no lease`);
      } finally { for (const [name, bytes] of Object.entries(saved)) fs.writeFileSync(t10File(name), bytes); }
    }
    // A missing or unallocated task-node binding (same choice, roadmap and contract) refuses reentry too, with zero writes.
    const t08Plan = path.join(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/T08/T08-PLAN.md`), t08Saved = fs.readFileSync(t08Plan, 'utf8');
    for (const [label, edit] of [['binding removed', text => text.replace(/^time_.*\n/gm, '')], ['unallocated node', text => text.replace(/time_node: .*/, 'time_node: N9')]]) {
      fs.writeFileSync(t08Plan, edit(t08Saved));
      assert.throws(reenter, error => error.code === 'time-scope-unallocated', `reentry ${label}`);
      assert.strictEqual(controller.lookupRecord(cwd, 'transaction', entryKey), null, `reentry ${label}: no transaction`);
      assert.strictEqual(lease.observe(cwd, 'execute-task/T08').lease, null, `reentry ${label}: no lease`);
    }
    fs.writeFileSync(t08Plan, t08Saved);
    const entered = reenter();
    assert.strictEqual(entered.reason, 'entry-ready');
    // A committed entry replays without consulting the guard again.
    fs.renameSync(deliveryPath, deliveryPath + '.away');
    assert.strictEqual(reenter().reason, 'entry-ready');
    fs.renameSync(deliveryPath + '.away', deliveryPath);
    // R54: a genuine completion after the linked reentry (independent key) proves T08 through the
    // reentry's own committed begin/completion events; the failed first begin never pairs with it.
    assert.strictEqual(taskProof(cwd, 'S01', 'T08'), 'unproven');
    const entryRecord = controller.lookupRecord(cwd, 'transaction', entryKey);
    assert.notStrictEqual(entryRecord.lease_generation, begun.generation);
    controller.complete(cwd, { milestone: TM, unit: 'execute-task/T08', host_runtime: entryRecord.host_runtime, owner_token: 'explicit-owner',
      generation: entryRecord.lease_generation, idempotency_key: 'finish-T08-after-reentry', result: { status: 'succeeded' } }, timeOptions(7000));
    taskDelivery(cwd, 'S01', 'T08');
    assert.strictEqual(taskProof(cwd, 'S01', 'T08'), 'proven', 'completion after linked reentry');
  } finally { cleanup(cwd); }
}

// Begin a task, fail it and consume the failure so reentry can be exercised against the current owner plans.
function failedBegin(cwd, slice, task, beginKey, offset, entryId) {
  const recovery = require('./forge-attempt-recovery.js'), unit = `execute-task/${task}`;
  const begun = explicitBegin(cwd, unit, beginKey, { state_patch: { active_slice: slice }, slice }, timeOptions(offset));
  assert.strictEqual(begun.ok, true);
  const request = { cwd, contextRoot: cwd, milestoneId: TM, sliceId: slice, taskId: task, scope: 'milestone', phase: 'execute', unitType: 'execute-task',
    roadmapFile: path.join(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`), route: { host_runtime: 'codex', resolved_worker_engine: 'codex' } };
  const receipt = writeFile(cwd, `receipt-${task}.json`, JSON.stringify({ phase: 'failed', recovery_identity_sha256: digest(recovery.requestIdentity(request)),
    failure: { reason_code: 'claude-timeout', provider_called: 'unknown' } }));
  const live = timeOptions(offset + 1000, { processProbe: () => 'stopped',
    inspectAttempt: () => ({ receipt_path: receipt, request, roots: [{ root_id: 'primary', path: cwd }], pending_questions: [] }),
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: cwd }] }),
    entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) });
  const consumed = controller.consumeFailure(cwd, { begin_key: beginKey, unit, milestone: TM, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation }, live);
  assert.strictEqual(consumed.reason, 'failure-consumed');
  const entry = { entry_id: entryId, failure_key: consumed.failure_key, failure_checksum: consumed.failure_checksum, authorization_ref: 'conversation:fixture' };
  return { reenter: () => controller.reenter(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner', entry }, live),
    refuses(code, label) {
      assert.throws(this.reenter, error => error.code === code, `reentry ${label}`);
      assert.strictEqual(controller.lookupRecord(cwd, 'transaction', `linked-entry:${require('crypto').createHash('sha256').update(entryId).digest('hex')}`), null, `reentry ${label}: no transaction`);
      assert.strictEqual(lease.observe(cwd, unit).lease, null, `reentry ${label}: no lease`);
    } };
}
function testCompleteDependsDeclarations() {
  const cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    // T08 and T10 realize the same allocated node N1: only the LOCAL depends edge orders them.
    slicePlanFile(cwd, 'S01', [['T08', false], ['T10', false]]); taskPlanFile(cwd, 'S01', 'T10', []);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' }, t08 = `.gsd/milestones/${TM}/slices/S01/tasks/T08/T08-PLAN.md`;
    const planOf = text => writeFile(cwd, t08, `---\nid: T08\n${text}${bindingLines(cwd, 'S01')}---\n# T08\n`);
    const declared = () => controller.discoverInventory(cwd, TM, state.read(cwd, TM)).slices[0].task_dag;
    // Supported forms keep their meaning: inline, block (LF and CRLF), empty and missing.
    for (const [label, text, expected] of [['inline', 'depends: [T10]\n', ['T10']], ['block', 'depends:\n  - T10\n', ['T10']], ['crlf block', 'depends:\r\n  - T10\r\n', ['T10']],
      ['empty inline', 'depends: []\n', []], ['empty value', 'depends:\n', []], ['missing', '', []]]) {
      planOf(text);
      const dag = declared();
      assert.deepStrictEqual([dag.status, dag.tasks.find(item => item.id === 'T08').depends], ['valid', expected], label);
    }
    // An incomplete declaration never turns T08 into a root, through next and explicit begin.
    const malformed = [['multiline scalar', 'depends:\n  T10\n'], ['broken block', 'depends:\n  - T10\n  garbage\n'], ['mixed block', 'depends:\n  - T10\n  T11\n'],
      ['blank inside block', 'depends:\n  - T10\n\n  - T11\n'], ['leading blank before block', 'depends:\n\n  - T10\n'], ['inline with continuation', 'depends: [T10]\n  - T10\n'],
      ['empty with continuation', 'depends: []\n  T10\n'], ['empty item', 'depends: [T10,,T11]\n'], ['scalar', 'depends: T10\n'], ['duplicate', 'depends: [T10]\ndepends: []\n']];
    malformed.forEach(([label, text], index) => {
      planOf(text);
      const next = controller.select(cwd, { milestone: TM }, timeOptions());
      assert.deepStrictEqual([next.ok, next.reason], [false, 'time-task-dependency-unknown'], `next ${label}`);
      refusedWithoutWrites(cwd, 'execute-task/T08', `T08-incomplete-${index}`, 'time-task-dependency-unknown', s01);
    });
    // The valid list still waits for T10, then admits T08 after its proven completion; reentry refuses every malformed form.
    planOf('depends:\n  - T10\n');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-same-node-pending', 'time-task-dependency-pending', s01);
    completeTask(cwd, 'S01', 'T10', 3000); taskDelivery(cwd, 'S01', 'T10');
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T08');
    const failed = failedBegin(cwd, 'S01', 'T08', 'T08-begin', 5000, 'T08-entry');
    malformed.forEach(([label, text]) => { planOf(text); failed.refuses('time-task-dependency-unknown', label); });
    planOf('depends:\n  - T10\n');
    assert.strictEqual(failed.reenter().reason, 'entry-ready');
  } finally { cleanup(cwd); }
}
function testIntermediatePlanLinksRefuse() {
  const cwd = decidedRoot(), foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-foreign-plan-'));
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    slicePlanFile(cwd, 'S01', [['T08', false]]); taskPlanFile(cwd, 'S01', 'T08', []);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' }, tasks = path.join(cwd, `.gsd/milestones/${TM}/slices/S01/tasks`), t08 = path.join(tasks, 'T08');
    // A junction at the intermediate task directory points at a foreign regular plan with the three matching scalars.
    const regular = fs.readFileSync(path.join(t08, 'T08-PLAN.md'), 'utf8');
    fs.writeFileSync(path.join(foreign, 'T08-PLAN.md'), regular);
    const swap = (link, real, target) => { fs.renameSync(link, real); fs.symlinkSync(target, link, 'junction'); };
    const unswap = (link, real) => { fs.rmSync(link, { recursive: true, force: true }); fs.renameSync(real, link); };
    const cases = [['task directory junction', t08, t08 + '.real', foreign, 'task-plan-link:T08'],
      ['tasks directory junction', tasks, tasks + '.real', tasks + '.real', 'task-plan-link:T08']];
    for (const [label, link, real, target, reason] of cases) {
      swap(link, real, target);
      try {
        const next = controller.select(cwd, { milestone: TM }, timeOptions());
        assert.deepStrictEqual([next.ok, next.reason], [false, 'time-task-dependency-unknown'], `next ${label}`);
        refusedWithoutWrites(cwd, 'execute-task/T08', `T08-link-${label}`, 'time-task-dependency-unknown', s01);
        const dag = controller.discoverInventory(cwd, TM, state.read(cwd, TM)).slices[0].task_dag;
        assert.deepStrictEqual(dag.reasons, [reason], label);
      } finally { unswap(link, real); }
    }
    // The real plan admits the begin; after its failure, reentry refuses every linked plan with zero writes.
    const failed = failedBegin(cwd, 'S01', 'T08', 'T08-begin', 5000, 'T08-entry');
    for (const [label, link, real, target] of cases) {
      swap(link, real, target);
      try { failed.refuses('time-task-dependency-unknown', label); } finally { unswap(link, real); }
    }
    // The actual regular file is admitted again.
    assert.strictEqual(failed.reenter().reason, 'entry-ready');
  } finally { cleanup(cwd); fs.rmSync(foreign, { recursive: true, force: true }); }
}
function testCompletedLocalSubtasksProveDependencies() {
  const clock = require('./forge-milestone-time-clock.js'), cwd = decidedRoot();
  try {
    conformantRoadmap(cwd);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    // The existing local grammar: T03.1 completes through the normal controller and unlocks its dependent.
    slicePlanFile(cwd, 'S01', [['T03.1', false], ['T04', false]]); taskPlanFile(cwd, 'S01', 'T03.1', []); taskPlanFile(cwd, 'S01', 'T04', ['T03.1']);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T03.1');
    refusedWithoutWrites(cwd, 'execute-task/T04', 'T04-before-T03.1', 'time-task-dependency-pending', s01);
    completeTask(cwd, 'S01', 'T03.1', 3000);
    refusedWithoutWrites(cwd, 'execute-task/T04', 'T04-no-delivery', 'time-task-dependency-pending', s01);
    taskDelivery(cwd, 'S01', 'T03.1');
    assert.strictEqual(taskProof(cwd, 'S01', 'T03.1'), 'proven');
    slicePlanFile(cwd, 'S01', [['T03.1', true], ['T04', false]]);
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.key, 'execute-task/T04');
    const failed = failedBegin(cwd, 'S01', 'T04', 'T04-begin', 5000, 'T04-entry');
    assert.strictEqual(failed.reenter().reason, 'entry-ready');
    // Unsafe or path-like identifiers stay invalid; supported ones pass the identifier check (T1 has no files here).
    const completedAt = new Date(TNOW + 3000).toISOString();
    const reasonOf = task => clock.readHistoricalTaskDelivery({ cwd, milestone: TM, slice: 'S01', task, completedAt }).reason;
    for (const task of ['../T01', 'T01/..', 'T01/T02', 'T01\\T02', ' T01', 'T01 ', 'T01\n', 'T.1', 'T1.', 'T03..1', 'T03.1.2', 'T03.1/../T04', '']) {
      assert.strictEqual(reasonOf(task), 'delivery-task-invalid', JSON.stringify(task));
    }
    for (const task of ['T1', 'T03.1', 'T01']) assert.notStrictEqual(reasonOf(task), 'delivery-task-invalid', task);
  } finally { cleanup(cwd); }
}

// --- task-to-selected-node binding (R49) --------------------------------------------
function treeSnapshot(dir) {
  const rows = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file); else { const stat = fs.statSync(file); rows.push([path.relative(dir, file), stat.size, stat.mtimeMs]); }
    }
  })(dir);
  return JSON.stringify(rows);
}
const PARTS = { N1: ['N1a', 'N1b', 'N1c'], N2: ['N2a', 'N2b', 'N2c'] };
// One slice realizing eight allocated identifiers: refinement parts of N1 and N2 plus N3 and N4.
function refinedRoadmap(cwd) {
  const skeleton = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(timeSelection.promptBlock(cwd, TM))[1]);
  const allocation = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] },
    { id: 's1', kind: 'slice', slice: 'S01', ms: 3600000, nodes: [...PARTS.N1, ...PARTS.N2, 'N3', 'N4'] },
    { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] }, { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
  const refinements = Object.entries(PARTS).map(([node, parts]) => ({ node, parts }));
  writeFile(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`, `# ${TM}: Fixture — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato** \`risk:low\` \`depends:[]\`\n\n`
    + `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify({ ...skeleton, allocation, refinements }, null, 2)}\n\`\`\`\n`);
}
const EIGHT = [['T01', 'N1a', []], ['T02', 'N1b', []], ['T03', 'N1c', []], ['T04', 'N2a', ['T01', 'T02', 'T03']], ['T05', 'N2b', ['T01', 'T02', 'T03']],
  ['T06', 'N2c', ['T01', 'T02', 'T03']], ['T10', 'N2c', ['T01', 'T02', 'T03']], ['T07', 'N3', []], ['T08', 'N4', ['T04', 'T05', 'T06', 'T10']]];
function eightPlans(cwd, edit = {}) {
  // A delivered (checked) task keeps its canonical historical plan bytes.
  for (const [id, node, depends] of EIGHT) if (!(edit.checked || []).includes(id)) taskPlanFile(cwd, 'S01', id, edit[id]?.depends || depends, edit[id]?.node || node);
  slicePlanFile(cwd, 'S01', EIGHT.filter(([id]) => !(edit.omit || []).includes(id)).map(([id]) => [id, (edit.checked || []).includes(id)]));
}
function testTaskBindingContextAndEightIdentifiers() {
  const legacy = timeRoot(), pending = enrolledRoot(), cwd = decidedRoot();
  try {
    // absent: genuine unenrolled; blocked: enrolled without a decision; invalid: malformed identity.
    assert.deepStrictEqual(timeSelection.taskBindingContext(legacy, TM, { sliceId: 'S01' }).status, 'absent');
    assert.deepStrictEqual(['blocked', 'estimate-required'], [timeSelection.taskBindingContext(pending, TM, { sliceId: 'S01' }).status, timeSelection.taskBindingContext(pending, TM, { sliceId: 'S01' }).reason]);
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: '../S01' }).status, 'invalid');
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, {}).status, 'invalid');
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S01' }).reason, 'roadmap-absent');
    refinedRoadmap(cwd);
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S01' }).reason, 'allocation-pending', 'the immutable selection alone is not a current allocation');
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    const before = treeSnapshot(cwd), selected = JSON.stringify(timeSelection.readSelectionState(cwd, TM));
    const context = timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S01' });
    assert.deepStrictEqual([context.status, context.slice, context.option_id, context.position_id], ['ready', 'S01', 'curta', 'curta']);
    assert.deepStrictEqual(context.allocated.map(item => [item.id, item.parent, item.part, item.slice]),
      [...PARTS.N1.map(id => [id, 'N1', true, 'S01']), ...PARTS.N2.map(id => [id, 'N2', true, 'S01']), ['N3', 'N3', false, 'S01'], ['N4', 'N4', false, 'S01']]);
    assert.strictEqual(context.allocated.length, 8);
    assert.deepStrictEqual([context.slice_dependencies, context.prerequisite_slices, context.roadmap_slices], [[], [], [{ id: 'S01', dependencies: [] }]]);
    assert.deepStrictEqual(context.edges.map(edge => `${edge.from}>${edge.to}`).sort(), ['N1>PREP', 'N2>N1', 'N3>PREP', 'N4>N2']);
    const edge = context.edges.find(item => item.from === 'N4');
    assert.deepStrictEqual([edge.dependent, edge.prerequisite.map(item => item.id)], [[{ id: 'N4', slice: 'S01' }], PARTS.N2]);
    for (const key of ['selection_sha256', 'contract_sha256', 'contract_base_sha256', 'roadmap_sha256', 'structure_sha256']) assert.match(context.sources[key], /^[a-f0-9]{64}$/, key);
    assert.match(context.options_sha256, /^[a-f0-9]{64}$/);
    // The old immutable skeleton keeps its empty plan-milestone allocation; the projection never rewrites it.
    assert.deepStrictEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(timeSelection.promptBlock(cwd, TM))[1]).allocation, []);
    assert.deepStrictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S01' }), context, 'repeatable');
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S09' }).reason, 'slice-unknown');
    assert.deepStrictEqual([treeSnapshot(cwd), JSON.stringify(timeSelection.readSelectionState(cwd, TM))], [before, selected], 'readonly projection');

    // Positive: eight identifiers, one node refined by several tasks, the selected edges realized by real task depends.
    eightPlans(cwd);
    const s01 = { state_patch: { active_slice: 'S01' }, slice: 'S01' };
    const inventory = controller.discoverInventory(cwd, TM, state.read(cwd, TM));
    assert.deepStrictEqual([inventory.slices[0].task_dag.status, inventory.slices[0].task_dag.tasks.length], ['valid', 9]);
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.id, 'T01');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-eight-before', 'time-task-dependency-pending', s01);
    const done = [];
    for (const [index, id] of ['T01', 'T02', 'T03'].entries()) { completeTask(cwd, 'S01', id, 3000 + index * 1000); taskDelivery(cwd, 'S01', id, { node: PARTS.N1[index] }); done.push(id); }
    eightPlans(cwd, { checked: done });
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.id, 'T04');
    refusedWithoutWrites(cwd, 'execute-task/T08', 'T08-eight-after', 'time-task-dependency-pending', s01);

    // Negatives with unchanged choice, roadmap and contract: every mutation refuses next and explicit begin with zero writes.
    const roadmap = fs.readFileSync(path.join(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`), 'utf8'), baseState = JSON.stringify(timeSelection.readSelectionState(cwd, TM));
    const planFile = id => path.join(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/${id}/${id}-PLAN.md`);
    const rewrite = (id, edit) => { const text = fs.readFileSync(planFile(id), 'utf8'); fs.writeFileSync(planFile(id), edit(text)); return text; };
    const selected8 = timeSelection.readSelectionState(cwd, TM);
    const negatives = [
      ['required edge removed', { T08: { depends: ['T04', 'T05', 'T06'] } }, 'time-task-dependency-unknown'],
      ['required edge inverted', { T10: { depends: ['T01', 'T02', 'T03', 'T08'] }, T08: { depends: ['T04', 'T05', 'T06'] } }, 'time-task-dependency-unknown'],
      ['part edge removed', { T04: { depends: [] } }, 'time-task-dependency-unknown'],
      ['unallocated node', { T07: { node: 'N9' } }, 'time-scope-unallocated'],
      ['refined parent is not an allocated identifier', { T07: { node: 'N1' } }, 'time-scope-unallocated'],
      ['uncovered identifier', { omit: ['T07'] }, 'time-scope-unallocated'],
    ];
    for (const [label, edit, code] of negatives) {
      eightPlans(cwd, { ...edit, checked: done });
      const blocked = controller.select(cwd, { milestone: TM }, timeOptions());
      assert.deepStrictEqual([blocked.ok, blocked.reason], [false, code], `next ${label}`);
      refusedWithoutWrites(cwd, 'execute-task/T07', `neg-${label.replace(/\W+/g, '-')}`, code, s01);
      assert.deepStrictEqual([fs.readFileSync(path.join(cwd, `.gsd/milestones/${TM}/${TM}-ROADMAP.md`), 'utf8'), JSON.stringify(timeSelection.readSelectionState(cwd, TM))], [roadmap, baseState], label);
    }
    const sha = selected8.options_sha256;
    const metadata = [
      ['missing binding', text => text.replace(/^time_.*\n/gm, '')],
      ['foreign digest', text => text.replace(sha, 'f'.repeat(64))],
      ['foreign position', text => text.replace('time_position_id: curta', 'time_position_id: outra')],
      ['duplicate node', text => text.replace(/time_node: N3\n/, 'time_node: N3\ntime_node: N4\n')],
      ['partial binding', text => text.replace(/time_options_sha256: .*\n/, '')],
      ['malformed value', text => text.replace('time_node: N3', 'time_node: "N3 # x"')],
    ];
    eightPlans(cwd, { checked: done });
    for (const [label, edit] of metadata) {
      const original = rewrite('T07', edit);
      const blocked = controller.select(cwd, { milestone: TM }, timeOptions());
      assert.deepStrictEqual([blocked.ok, blocked.reason], [false, 'time-scope-unallocated'], `next ${label}`);
      refusedWithoutWrites(cwd, 'execute-task/T07', `neg-meta-${label.replace(/\W+/g, '-')}`, 'time-scope-unallocated', s01);
      fs.writeFileSync(planFile('T07'), original);
    }
    eightPlans(cwd, { checked: done });
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions()).unit.id, 'T04', 'restored plans admit again');
  } finally { cleanup(legacy); cleanup(pending); cleanup(cwd); }
}
function testCrossSliceBarriersAndDuplicateTaskIds() {
  const cwd = decidedRoot();
  try {
    // Checkboxes alone satisfy the roadmap-level slice guard; the task barrier asks for the real proof.
    conformantRoadmap(cwd, ['S01', 'S02']);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    const forSlice = slice => ({ state_patch: { active_slice: slice }, slice });
    const context = timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S04' });
    assert.deepStrictEqual([context.status, context.slice_dependencies, context.prerequisite_slices], ['ready', ['S02'], ['S01', 'S02']]);
    assert.deepStrictEqual(context.edges.map(edge => `${edge.from}>${edge.to}`).sort(), ['N4>N2']);
    // The same local T01 in every slice; independent S03 is never blocked by unplanned or unproven slices.
    for (const slice of ['S01', 'S03', 'S04']) { slicePlanFile(cwd, slice, [['T01', false]]); taskPlanFile(cwd, slice, 'T01', []); }
    refusedWithoutWrites(cwd, 'execute-task/T01', 'S04-prereq-unplanned', 'time-task-dependency-pending', forSlice('S04'));
    assert.ok(assertThrowsDetails(() => explicitBegin(cwd, 'execute-task/T01', 'S04-prereq-unplanned-2', forSlice('S04'), timeOptions()), 'barrier').some(item => item.slice === 'S02' && item.reason === 'slice-unplanned'));
    completeTask(cwd, 'S03', 'T01', 3000);
    taskDelivery(cwd, 'S03', 'T01');
    assert.strictEqual(taskProof(cwd, 'S03', 'T01'), 'proven', 'S03/T01 proof is independent of S01/T01');
    assert.strictEqual(taskProof(cwd, 'S01', 'T01'), 'unproven');
    slicePlanFile(cwd, 'S02', [['T01', false]]); taskPlanFile(cwd, 'S02', 'T01', []);
    // S02/T01 waits for the real predecessor proof of S01/T01, never for S03/T01's.
    refusedWithoutWrites(cwd, 'execute-task/T01', 'S02-before-S01', 'time-task-dependency-pending', forSlice('S02'));
    completeTask(cwd, 'S01', 'T01', 5000);
    taskDelivery(cwd, 'S01', 'T01');
    assert.strictEqual(taskProof(cwd, 'S01', 'T01'), 'proven');
    // Task proof alone is not the slice: the unchecked slice without SUMMARY still blocks the dependent slice.
    const barrierOf = (offset = 0) => assertThrowsDetails(() => explicitBegin(cwd, 'execute-task/T01', `S02-barrier-${Math.random()}`, forSlice('S02'), timeOptions(offset)), 'barrier');
    const slicesOf = barrier => barrier.map(item => [item.slice, item.task, item.reason, item.proof]);
    assert.deepStrictEqual(slicesOf(barrierOf()), [['S01', null, 'slice-incomplete', 'delivery-completion-missing']]);
    // R52: checked box, SUMMARY and every task proven still do not close the slice without its canonical closure.
    slicePlanFile(cwd, 'S01', [['T01', true]]); writeFile(cwd, `.gsd/milestones/${TM}/slices/S01/S01-SUMMARY.md`, '# S01\n');
    assert.strictEqual(timeSelection.taskBindingContext(cwd, TM, { sliceId: 'S02' }).status, 'ready', 'a checkbox keeps the allocation');
    assert.strictEqual(taskProof(cwd, 'S01', 'T01'), 'proven');
    assert.deepStrictEqual(slicesOf(barrierOf()), [['S01', null, 'slice-incomplete', 'delivery-completion-missing']], 'checked + SUMMARY + all tasks done');
    refusedWithoutWrites(cwd, 'execute-task/T01', 'S02-summary-only', 'time-task-dependency-pending', forSlice('S02'), timeOptions(1000));
    // A genuine slice delivery without the committed complete-slice transition still blocks.
    closeSlice(cwd, 'S01', ['T01'], 0, { complete: false });
    assert.deepStrictEqual(slicesOf(barrierOf(1000)), [['S01', null, 'slice-incomplete', 'delivery-completion-missing']], 'delivery without completion');
    // The genuine closure: review record, verified historical slice delivery and committed complete-slice.
    closeSlice(cwd, 'S01', ['T01'], 6000);
    const later = timeOptions(9000);
    const s02Dag = () => controller.discoverInventory(cwd, TM, state.read(cwd, TM), later).slices.find(item => item.id === 'S02').task_dag;
    assert.deepStrictEqual([s02Dag().status, s02Dag().tasks[0].barrier], ['valid', []], 'closed and reviewed S01 clears the S02 barrier');
    // Negatives on the closed slice: each tamper refuses with zero writes and its typed proof, then is restored.
    const base = `.gsd/milestones/${TM}/slices/S01`, file = name => path.join(cwd, ...`${base}/${name}`.split('/'));
    const tamperedSlice = (label, tamper, reason, proof) => {
      const names = ['S01-DELIVERY.json', 'S01-DELIVERY-INPUT.json', 'S01-PLAN.md', 'S01-REVIEW.md', 'tasks/T01/T01-DELIVERY.json'];
      const saved = Object.fromEntries(names.filter(name => fs.existsSync(file(name))).map(name => [name, fs.readFileSync(file(name))]));
      tamper();
      try {
        const barrier = assertThrowsDetails(() => explicitBegin(cwd, 'execute-task/T01', `S02-${label.replace(/\W+/g, '-')}`, forSlice('S02'), later), 'barrier');
        const row = barrier.find(item => item.slice === 'S01' && item.task === null);
        assert.ok(row && row.reason === reason && (!proof || row.proof === proof), `${label}: ${JSON.stringify(barrier)}`);
        refusedWithoutWrites(cwd, 'execute-task/T01', `S02-${label.replace(/\W+/g, '-')}-z`, 'time-task-dependency-pending', forSlice('S02'), later);
      } finally {
        for (const name of names) if (!saved[name] && fs.existsSync(file(name))) fs.rmSync(file(name));
        for (const [name, bytes] of Object.entries(saved)) fs.writeFileSync(file(name), bytes);
      }
    };
    const delivery = require('./forge-delivery.js');
    const edit = (name, change) => { const value = JSON.parse(fs.readFileSync(file(name), 'utf8')); change(value); fs.writeFileSync(file(name), JSON.stringify(value)); };
    tamperedSlice('forged slice status re-fingerprinted', () => {
      const value = JSON.parse(fs.readFileSync(file('S01-DELIVERY.json'), 'utf8')); value.diagnostics = []; value.criteria[0].note = 'forged';
      fs.writeFileSync(file('S01-DELIVERY.json'), JSON.stringify(delivery.finalizeOutput(value)));
    }, 'slice-incomplete', 'delivery-projection-changed');
    tamperedSlice('slice input missing', () => fs.rmSync(file('S01-DELIVERY-INPUT.json')), 'slice-incomplete');
    tamperedSlice('current slice plan gains an unknown child', () => slicePlanFile(cwd, 'S01', [['T01', true], ['T09', true]]), 'slice-incomplete');
    tamperedSlice('child inventory dropped', () => {
      edit('S01-DELIVERY-INPUT.json', v => { v.expected_children = []; });
      fs.writeFileSync(file('S01-DELIVERY.json'), JSON.stringify(delivery.buildDelivery(JSON.parse(fs.readFileSync(file('S01-DELIVERY-INPUT.json'), 'utf8')), { ownerRoot: cwd, codeDir: cwd })));
    }, 'slice-incomplete');
    tamperedSlice('foreign slice delivery', () => edit('S01-DELIVERY.json', v => { v.unit.id = 'S03'; }), 'slice-incomplete');
    tamperedSlice('child task delivery forged', () => edit('tasks/T01/T01-DELIVERY.json', v => { v.criteria[0].status = 'verificado'; v.criteria[0].evidence = []; }), 'slice-incomplete');
    tamperedSlice('review record missing', () => fs.rmSync(file('S01-REVIEW.md')), 'slice-unreviewed', 'slice-review-missing');
    tamperedSlice('review record empty', () => fs.writeFileSync(file('S01-REVIEW.md'), ''), 'slice-unreviewed', 'slice-review-invalid');
    for (const [label, facts, proof] of [['review fact missing', {}, 'slice-review-fact-missing'],
      ['review fact foreign', { review: { status: 'completed', reference: 'S03-REVIEW.md' } }, 'slice-review-fact-foreign']]) {
      tamperedSlice(label, () => {
        edit('S01-DELIVERY-INPUT.json', v => { v.facts = facts; });
        fs.writeFileSync(file('S01-DELIVERY.json'), JSON.stringify(delivery.buildDelivery(JSON.parse(fs.readFileSync(file('S01-DELIVERY-INPUT.json'), 'utf8')), { ownerRoot: cwd, codeDir: cwd })));
      }, 'slice-unreviewed', proof);
    }
    // Legitimate later code changes never invalidate the completed slice history.
    writeFile(cwd, 'scripts/unrelated-later.js', 'module.exports = 3;\n');
    // Proof removed or tampered: refused again with zero writes.
    const taskDeliveryFile = path.join(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/T01/T01-DELIVERY.json`);
    fs.renameSync(taskDeliveryFile, taskDeliveryFile + '.away');
    refusedWithoutWrites(cwd, 'execute-task/T01', 'S02-proof-gone', 'time-task-dependency-pending', forSlice('S02'), later);
    fs.renameSync(taskDeliveryFile + '.away', taskDeliveryFile);
    // The selected N2>N1 edge needs a real S01 task realizing N1 (binding removed there refuses the dependent).
    const s01Plan = path.join(cwd, `.gsd/milestones/${TM}/slices/S01/tasks/T01/T01-PLAN.md`), saved = fs.readFileSync(s01Plan);
    fs.writeFileSync(s01Plan, saved.toString('utf8').replace(/^time_node: .*\n/m, ''));
    refusedWithoutWrites(cwd, 'execute-task/T01', 'S02-prereq-unbound', 'time-task-dependency-unknown', forSlice('S02'), later);
    fs.writeFileSync(s01Plan, saved);
    // Removing the slice dependency from the real roadmap breaks conformance: the dependent never starts.
    conformantRoadmap(cwd, ['S01', 'S02'], '');
    assert.throws(() => explicitBegin(cwd, 'execute-task/T01', 'S02-no-slice-edge', forSlice('S02'), later),
      error => ['time-roadmap-nonconformant', 'time-scope-unallocated'].includes(error.code));
    conformantRoadmap(cwd, ['S01', 'S02']);
    const admitted = explicitBegin(cwd, 'execute-task/T01', 'S02-admitted', forSlice('S02'), timeOptions(12000));
    assert.strictEqual(admitted.ok, true, 'S02/T01 starts once S01 tasks, deliveries, slice closure and review exist');
    // The admitted begin replays idempotently even after the review record disappears.
    fs.rmSync(file('S01-REVIEW.md'));
    assert.strictEqual(explicitBegin(cwd, 'execute-task/T01', 'S02-admitted', forSlice('S02'), timeOptions(12500)).reason, 'already-committed');
  } finally { cleanup(cwd); }
}
function testScopedSliceProofSurvivesOtherMilestone() {
  const cwd = decidedRoot(), other = 'M992';
  try {
    conformantRoadmap(cwd, ['S01']);
    assert.strictEqual(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status, 'allocated');
    for (const slice of ['S01', 'S02']) { slicePlanFile(cwd, slice, [['T01', false]]); taskPlanFile(cwd, slice, 'T01', []); }
    completeTask(cwd, 'S01', 'T01', 3000); taskDelivery(cwd, 'S01', 'T01');
    slicePlanFile(cwd, 'S01', [['T01', true]]);
    closeSlice(cwd, 'S01', ['T01'], 4000);
    const txFile = controller.transactionFile(cwd, 'close-S01-done'), original = fs.readFileSync(txFile);
    const proof = () => require('./forge-milestone-time-clock').readHistoricalDeliveries({ cwd, milestone: TM, slices: ['S01'], now: TNOW + 20000 });
    assert.strictEqual(proof().proven.length, 1);
    // B closes the SAME SliceID using genuine task capture, slice delivery/review,
    // and committed controller transactions in the SAME physical owner.
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', other), { recursive: true });
    state.write(cwd, { milestone: other, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on', next_action: 'complete-slice' });
    const base = `.gsd/milestones/${other}/slices/S01`;
    writeFile(cwd, `.gsd/milestones/${other}/${other}-ROADMAP.md`, '# B\n\n- [x] **S01: B** `depends:[]`\n');
    writeFile(cwd, `${base}/S01-PLAN.md`, '# S01\n\n- [x] T01: B task\n');
    taskDelivery(cwd, 'S01', 'T01', { milestone: other });
    const began = controller.begin(cwd, { milestone: other, unit: 'execute-task/T01', slice: 'S01', state_patch: { active_slice: 'S01' }, host_runtime: 'codex', owner_token: 'B', idempotency_key: 'B-task' }, timeOptions(8000));
    controller.complete(cwd, { milestone: other, unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'B', generation: began.generation, idempotency_key: 'B-task-done', result: { status: 'succeeded' } }, timeOptions(8500));
    closeSlice(cwd, 'S01', ['T01'], 9000, { milestone: other });
    assert.strictEqual(controller.lookupRecord(cwd, 'boundary', 'complete-slice/S01').milestone, other);
    assert.strictEqual(require('./forge-milestone-time-clock').readHistoricalDeliveries({ cwd, milestone: other, slices: ['S01'], now: TNOW + 20000 }).proven.length, 1);
    assert.strictEqual(proof().proven.length, 1, JSON.stringify(proof()));
    assert.deepStrictEqual(fs.readFileSync(txFile), original, 'A completion is never rewritten');
    assert.strictEqual(controller.select(cwd, { milestone: TM }, timeOptions(20000)).unit.key, 'execute-task/T01');
    const explicit = explicitBegin(cwd, 'execute-task/T01', 'A-S02-fresh-begin', { slice: 'S02', state_patch: { active_slice: 'S02' } }, timeOptions(14000));
    assert.strictEqual(explicit.ok, true);
    controller.complete(cwd, { milestone: TM, unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'explicit-owner', generation: explicit.generation,
      idempotency_key: 'A-S02-explicit-done', result: { status: 'succeeded' } }, timeOptions(14500));
    const failed = failedBegin(cwd, 'S02', 'T01', 'A-S02-after-handoff', 15000, 'A-S02-new-entry');
    // A new entry is not replay: the guard must rebuild the historical slice proof.
    assert.strictEqual(failed.reenter().reason, 'entry-ready');
    const entryKey = `linked-entry:${require('crypto').createHash('sha256').update('A-S02-new-entry').digest('hex')}`;
    const entry = controller.lookupRecord(cwd, 'transaction', entryKey);
    controller.complete(cwd, { milestone: TM, unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'explicit-owner', generation: entry.lease_generation,
      idempotency_key: 'A-S02-entry-done', result: { status: 'succeeded' } }, timeOptions(21000));
    // Storage-checksum corruption still fails closed despite the unrelated ready slot.
    const corrupt = JSON.parse(original); corrupt.boundary.milestone = other;
    fs.writeFileSync(txFile, JSON.stringify(corrupt));
    try { assert.strictEqual(proof().proven.length, 0); } finally { fs.writeFileSync(txFile, original); }
    assert.strictEqual(proof().proven.length, 1);
  } finally { cleanup(cwd); }
}
function assertThrowsDetails(fn, key) {
  try { fn(); } catch (error) {
    if (!error.details?.task_dag) throw new assert.AssertionError({ message: `expected a task_dag refusal, got ${error.code}: ${error.message}` });
    return error.details.task_dag[key];
  }
  throw new assert.AssertionError({ message: 'expected a refusal' });
}

// All observations below belong to disposable fixtures; no native Agent or
// provider is called or represented by a fabricated receipt.
function interruptionFixture(cwd) {
  const crypto = require('crypto'), runs = require('./forge-runs');
  const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(sort(value))).digest('hex');
  function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])); }
  if (!cwd) {
    cwd = temp();
    const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/incomplete-resume/legacy-two-begins.json')));
    for (const [relative, row] of Object.entries(legacy.files)) {
      assert(relative.split('/').every(part => part && !['.','..'].includes(part)));
      assert.strictEqual(digest(row.content), row.sha256);
      const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.content);
    }
    process.env.CODEX_THREAD_ID = 'fixture375-old';
    runs.add(cwd, { id: legacy.milestone, kind: 'milestone', session_id: process.env.CODEX_THREAD_ID,
      host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID', pending_decisions: [] });
    const first = controller.lookupRecord(cwd, 'transaction', 'old-complete-slice');
    const later = controller.lookupRecord(cwd, 'transaction', 'new-successor');
    const seed = { milestone: legacy.milestone, expectedRecordSha256: digest(fs.readFileSync(runs.runFile(cwd, legacy.milestone)).toString('utf8')),
      lineage: { begin_key: first.idempotency_key, begin_checksum: digest(first), successors: [{ key: later.idempotency_key, checksum: digest(later) }] } };
    fs.writeFileSync(path.join(cwd, 'fixture375-seed.json'), JSON.stringify(seed));
  }
  const seed = JSON.parse(fs.readFileSync(path.join(cwd, 'fixture375-seed.json')));
  process.env.CODEX_THREAD_ID = 'fixture375-new';
  const options = { hostRuntime: 'codex', expectedSession: process.env.CODEX_THREAD_ID, prefsReader,
    expectedRecordSha256: seed.expectedRecordSha256, lineage: seed.lineage,
    inspectInterruption: ({ begin, role }) => ({ begin_key: begin.idempotency_key, begin_checksum: digest(begin),
      invocation_status: role === 'original' ? 'invoked-unverified' : 'not-invoked', receipt_path: null,
      saved_response: 'none-observed', roots: [{ root_id: 'primary', path: cwd }], pending_questions: [],
      observation_reference: 'disposable fixture: positive synthetic host observation, zero actual native/provider calls' }),
    processProbe: () => 'stopped',
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    attestOwnerInterruption: challenge => ({ challenge_sha256: digest(challenge), previous_owner_stopped: true,
      workspace_quiescent: true, reference: 'disposable fixture trusted-host attestation, not imported consent' }) };
  const monitored = () => Object.fromEntries([runs.runFile(cwd, seed.milestone), state.statePath(cwd, seed.milestone),
    controller.eventsFile(cwd, seed.milestone), ...['old-complete-slice','new-successor'].map(key => controller.transactionFile(cwd, key)),
    ...['complete-slice/S01','plan-slice/S02'].map(unit => lease.leaseFile(cwd, unit))].map(file => [file, fs.existsSync(file) ? digest(fs.readFileSync(file).toString('utf8')) : null]));
  return { cwd, seed, options, runs, digest, monitored, settle: () => runs.settleInterruptedOwner(cwd, seed.milestone, options) };
}
function testInterruptedOwnerLineage() {
  const oldSession = process.env.CODEX_THREAD_ID;
  try {
    const f = interruptionFixture();
    try {
      const originals = ['old-complete-slice','new-successor'].map(key => fs.readFileSync(controller.transactionFile(f.cwd, key)));
      const result = f.settle();
      assert.strictEqual(result.status, 'interrupted-and-transferred');
      assert.strictEqual(result.record.session_id, 'fixture375-new');
      assert.strictEqual(result.record.owner_resume_history.length, 1);
      assert.strictEqual(result.interruption.artifacts_accepted, false);
      assert.strictEqual(controller.pendingOwnerInterruptions(f.cwd).length, 0);
      assert.strictEqual(lease.observe(f.cwd, 'complete-slice/S01').lease, null);
      assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S02').lease, null);
      for (let i = 0; i < originals.length; i++) assert(fs.readFileSync(controller.transactionFile(f.cwd, ['old-complete-slice','new-successor'][i])).equals(originals[i]));
      for (const pin of result.interruption.terminals) {
        const tx = controller.lookupRecord(f.cwd, 'transaction', pin.key);
        assert.strictEqual(tx.result.status, 'failed'); assert.strictEqual(tx.result.output.worker_result, 'unverified');
        assert.strictEqual(tx.result.output.provider_called, 'unknown'); assert.strictEqual(tx.result.output.artifacts_accepted, false);
      }
      const failures = controller.failureProjection(f.cwd, f.seed.milestone);
      assert.strictEqual(failures.length, 1); assert.strictEqual(failures[0].slice, 'S01');
      assert.strictEqual(controller.incompleteUnits(f.cwd, f.seed.milestone).length, 1);
      assert.throws(() => controller.beginSerial(f.cwd, { milestone: f.seed.milestone, unit: 'plan-slice/S02',
        owner_token: 'new-token', host_runtime: 'codex', idempotency_key: 'cannot-skip-S01' }, { prefsReader }), error => error.code === 'unit-incomplete');
      const beforeReplay = f.monitored();
      assert.strictEqual(f.settle().status, 'already-settled'); assert.deepStrictEqual(f.monitored(), beforeReplay);
      const oldLineage = f.options.lineage; f.options.lineage = { ...oldLineage, successors: [] };
      assert.throws(f.settle, error => error.code === 'owner-interruption-lineage-invalid');
      assert.deepStrictEqual(f.monitored(), beforeReplay); f.options.lineage = oldLineage;
      const recovery = require('./forge-attempt-recovery');
      const measuredBaseline = f.digest(f.monitored());
      const live = { ...f.options, captureEntryBaseline: () => ({ sha256: measuredBaseline, roots: [{ root_id: 'primary', path: f.cwd }] }),
        entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) };
      const request = { milestone: f.seed.milestone, unit: 'complete-slice/S01', host_runtime: 'codex', owner_token: 'new375-owner-token',
        entry: { entry_id: 'new375-S01', failure_key: failures[0].transaction.idempotency_key,
          failure_checksum: f.digest(failures[0].transaction), authorization_ref: 'conversation:fixture375' } };
      const historicalToken = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/incomplete-resume/legacy-two-begins.json'))).owner_token;
      assert.throws(() => controller.reenter(f.cwd, { ...request, owner_token: historicalToken }, live),
        error => error.code === 'owner-interruption-actor-mismatch');
      const entered = controller.reenter(f.cwd, request, live);
      const begun = controller.lookupRecord(f.cwd, 'transaction', entered.transaction.idempotency_key);
      assert.strictEqual(begun.action, 'begin'); assert.strictEqual(begun.unit.key, 'complete-slice/S01');
      assert.notStrictEqual(begun.lease_generation, failures[0].begin.lease_generation);
      assert.notStrictEqual(begun.owner_digest, failures[0].begin.owner_digest);
      assert.strictEqual(begun.result, null, 'administrative closure did not fabricate new delivery');
      assert.strictEqual(controller.validateLinkedEntry(f.cwd, begun.idempotency_key, { ...live, ownerToken: request.owner_token }).classification, 'new-unit');
    } finally { cleanup(f.cwd); }
    {
      const f = interruptionFixture();
      try {
        const git = spawnSync('git', ['init', '--quiet', f.cwd], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.strictEqual(git.status, 0, 'disposable Git checkout creation');
        const claim = require('./forge-write-claim').normalizeClaim({ source: 'plan-writes', code_dir: f.cwd, paths: ['src/input.js'] });
        f.runs.update(f.cwd, f.seed.milestone, { write_claim: claim, pending_questions: [{ id: 'fixture375-q', question: 'Fixture pending decision', status: 'pending' }] });
        f.seed.expectedRecordSha256 = f.digest(fs.readFileSync(f.runs.runFile(f.cwd, f.seed.milestone)).toString('utf8'));
        f.options.expectedRecordSha256 = f.seed.expectedRecordSha256;
        const beforeClaim = JSON.stringify(f.runs.get(f.cwd, f.seed.milestone).write_claim);
        const result = f.settle();
        assert.strictEqual(JSON.stringify(result.record.write_claim), beforeClaim, 'held claim stays byte-equivalent and unreleased');
        assert(require('./forge-write-claim').isHeld(result.record.write_claim));
        assert.strictEqual(result.record.pending_questions[0].status, 'pending');
        const failed = controller.failureProjection(f.cwd, f.seed.milestone)[0];
        assert.strictEqual(failed.transaction.terminal_failure.safety.pending_questions[0].status, 'pending');
        const intervals = require('./forge-phase-cost').analyzeEventIntervals(fs.readFileSync(controller.eventsFile(f.cwd, f.seed.milestone)));
        assert.strictEqual(intervals.open.length, 0); assert.strictEqual(intervals.ambiguous.length, 0);
        const beforeLease = lease.observe(f.cwd, failed.begin.unit.key);
        assert.strictEqual(beforeLease.lease, null);
        const recovery = require('./forge-attempt-recovery'), baseline = f.digest(f.monitored());
        const entry = { entry_id: 'pending375', failure_key: failed.transaction.idempotency_key,
          failure_checksum: f.digest(failed.transaction), authorization_ref: 'conversation:fixture375' };
        assert.throws(() => controller.reenter(f.cwd, { milestone: f.seed.milestone, unit: failed.begin.unit,
          host_runtime: 'codex', owner_token: 'new-pending375', entry }, { ...f.options,
          captureEntryBaseline: () => ({ sha256: baseline, roots: [{ root_id: 'primary', path: f.cwd }] }),
          entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) }),
        error => error.code === 'pending-questions');
        assert.strictEqual(lease.observe(f.cwd, failed.begin.unit.key).lease, null, 'a pending decision never acquires a new lease');
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        const result = f.settle(), first = result.interruption.terminals[0];
        const file = controller.transactionFile(f.cwd, first.key), raw = fs.readFileSync(file), tx = controller.lookupRecord(f.cwd, 'transaction', first.key);
        tx.owner_interruption.actor.session_sha256 = 'f'.repeat(64);
        controller.writeAtomic(file, tx);
        assert.throws(() => controller.incompleteUnits(f.cwd, f.seed.milestone), error => ['record-conflict','owner-interruption-witness-invalid'].includes(error.code),
          're-sealing one administrative terminal cannot replace the independent run witness');
        fs.writeFileSync(file, raw);
        f.runs.update(f.cwd, f.seed.milestone, { owner_resume_history: [] });
        assert.strictEqual(controller.incompleteUnits(f.cwd, f.seed.milestone).length, 2, 'unwitnessed administrative shape closes neither old begin');
        assert.strictEqual(controller.failureProjection(f.cwd, f.seed.milestone).length, 0, 'unwitnessed failed shape grants no linked entry');
        assert.strictEqual(controller.pendingOwnerInterruptions(f.cwd).length, 1);
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        f.options.failpoint = point => point === 'owner-interruption-after-manifest';
        assert.throws(f.settle, /failpoint/); delete f.options.failpoint;
        const dir = path.join(f.cwd, '.gsd/forge/owner-interruptions'), file = path.join(dir, fs.readdirSync(dir)[0]);
        const basis = controller.readJson(file); basis.targets[1].generation = 'foreign-generation'; controller.writeAtomic(file, basis);
        const before = f.monitored();
        assert.throws(f.settle, error => error.code === 'owner-interruption-lineage-changed');
        assert.deepStrictEqual(f.monitored(), before, 're-sealed manifest cannot expand old target authority');
      } finally { cleanup(f.cwd); }
    }

    const negatives = [
      ['active process', f => { f.options.processProbe = () => 'running'; }, 'process-not-stopped'],
      ['unknown process', f => { f.options.processProbe = () => 'unknown'; }, 'process-not-stopped'],
      ['invoked successor', f => { const old = f.options.inspectInterruption; f.options.inspectInterruption = q => ({ ...old(q), invocation_status: 'invoked-unverified' }); }, 'owner-interruption-invocation-unknown'],
      ['unknown successor', f => { const old = f.options.inspectInterruption; f.options.inspectInterruption = q => ({ ...old(q), invocation_status: 'unknown' }); }, 'owner-interruption-invocation-unknown'],
      ['canonical saved response', f => { const old = f.options.inspectInterruption; f.options.inspectInterruption = q => ({ ...old(q), saved_response: 'present' }); }, 'saved-response-replay-required'],
      ['missing live host', f => { delete f.options.attestOwnerInterruption; }, 'owner-interruption-inspector-required'],
      ['JSON is not host attestation', f => { f.options.attestOwnerInterruption = () => ({ approved: true, previous_owner_stopped: true, workspace_quiescent: true }); }, 'owner-interruption-attestation-required'],
      ['unreconciled root', f => { f.options.reconcileRoots = () => ({ reconciled: false }); }, 'roots-unreconciled'],
      ['omitted roots', f => { const old = f.options.inspectInterruption; f.options.inspectInterruption = q => ({ ...old(q), roots: [] }); }, 'roots-unverified'],
      ['missing successor', f => { f.options.lineage = { ...f.options.lineage, successors: [] }; }, 'owner-interruption-lineage-invalid'],
      ['unknown transaction debris', f => { fs.writeFileSync(path.join(controller.transactionDir(f.cwd), 'unknown.tmp'), 'unknown'); }, 'owner-resume-transactions-unknown'],
      ['genuine foreign-owner later begin', f => {
        controller.begin(f.cwd, { milestone: f.seed.milestone, unit: 'research-slice/S03', host_runtime: 'codex', owner_token: 'genuine-foreign375', idempotency_key: 'foreign-later375' }, { prefsReader });
        const later = controller.lookupRecord(f.cwd, 'transaction', 'foreign-later375');
        f.options.lineage = { ...f.options.lineage, successors: f.options.lineage.successors.concat({ key: later.idempotency_key, checksum: f.digest(later) }) };
      }, 'owner-interruption-foreign-lineage'],
      ['foreign generation', f => { const file = lease.leaseFile(f.cwd, 'plan-slice/S02'), row = JSON.parse(fs.readFileSync(file)); row.generation = 'foreign-generation'; fs.writeFileSync(file, JSON.stringify(row)); }, 'lease-owner-mismatch'],
    ];
    for (const [label, change, code] of negatives) {
      const f = interruptionFixture();
      try { change(f); const before = f.monitored(); assert.throws(f.settle, error => error.code === code, label);
        assert.deepStrictEqual(f.monitored(), before, label + ': no run/begin/lease/event/state effect');
        assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/owner-interruptions')), label + ': no administrative intent');
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        fs.unlinkSync(lease.leaseFile(f.cwd, 'complete-slice/S01'));
        const r = f.settle(); assert.strictEqual(r.status, 'interrupted-and-transferred');
        assert.strictEqual(f.settle().status, 'already-settled');
        assert.strictEqual(controller.failureProjection(f.cwd, f.seed.milestone).length, 1);
      } finally { cleanup(f.cwd); }
    }
    for (const point of ['owner-interruption-after-manifest','owner-interruption-after-intent','after-result-published',
      'after-event-published','after-boundary-pending','after-state-published','after-lease-release-pending',
      'after-lease-released','after-boundary-ready','after-committed','owner-interruption-before-owner-transfer']) {
      const f = interruptionFixture();
      try {
        f.options.failpoint = actual => actual === point;
        assert.throws(f.settle, /failpoint/, point);
        assert.strictEqual(f.runs.get(f.cwd, f.seed.milestone).session_id, 'fixture375-old');
        assert(controller.pendingOwnerInterruptions(f.cwd).length > 0);
        assert.throws(() => controller.begin(f.cwd, { milestone: f.seed.milestone, unit: 'plan-slice/S02',
          owner_token: 'new-token', host_runtime: 'codex' }, { prefsReader }), error => error.code === 'owner-interruption-pending');
        const child = spawnSync(process.execPath, [__filename, '--owner-interruption-fixture-child', f.cwd], {
          env: process.env, cwd: f.cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 65536 });
        assert.strictEqual(child.status, 0, point + ': fresh-process resume: ' + child.stderr);
        assert.strictEqual(controller.pendingOwnerInterruptions(f.cwd).length, 0);
        assert.strictEqual(f.runs.get(f.cwd, f.seed.milestone).owner_resume_history.length, 1);
        assert.strictEqual(controller.readEvents(controller.eventsFile(f.cwd, f.seed.milestone)).filter(row => row.reason_code === 'owner-stopped-unverified-lineage').length, 2);
      } finally { cleanup(f.cwd); }
    }
  } finally { if (oldSession === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = oldSession; }
}

function testInterruptedOwnerReviewGuards() {
  const oldSession = process.env.CODEX_THREAD_ID;
  try {
    {
      const f = interruptionFixture();
      try {
        const inspect = f.options.inspectInterruption;
        f.options.inspectInterruption = query => ({ ...inspect(query), pending_questions: query.role === 'successor'
          ? [{ id: 'successor-only375', question: 'Decision observed only on S02', status: 'pending' }] : [] });
        const result = f.settle(), failure = controller.failureProjection(f.cwd, f.seed.milestone)[0];
        assert.deepStrictEqual(failure.transaction.terminal_failure.safety.pending_questions.map(q => q.id), ['successor-only375']);
        assert.deepStrictEqual(result.record.pending_questions.map(q => q.id), ['successor-only375']);
        assert.strictEqual(result.record.pending_questions[0].status, 'pending');
        const recovery = require('./forge-attempt-recovery'), baseline = f.digest(f.monitored());
        assert.throws(() => controller.reenter(f.cwd, { milestone: f.seed.milestone, unit: failure.begin.unit,
          host_runtime: 'codex', owner_token: 'new-review375', entry: { entry_id: 'successor-only375-entry',
            failure_key: failure.transaction.idempotency_key, failure_checksum: f.digest(failure.transaction),
            authorization_ref: 'conversation:fixture375' } }, { ...f.options,
          captureEntryBaseline: () => ({ sha256: baseline, roots: [{ root_id: 'primary', path: f.cwd }] }),
          entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) }),
        error => error.code === 'pending-questions');
        assert.strictEqual(lease.observe(f.cwd, failure.begin.unit.key).lease, null, 'successor-only question prevents reentry lease');
      } finally { cleanup(f.cwd); }
    }
    for (const action of ['remove', 'cleanupStale']) {
      const f = interruptionFixture();
      try {
        const settled = f.settle();
        if (action === 'remove') f.runs.remove(f.cwd, f.seed.milestone);
        else { f.runs.update(f.cwd, f.seed.milestone, { last_heartbeat: 1 });
          assert(f.runs.cleanupStale(f.cwd, 1000).includes(f.seed.milestone)); }
        assert.strictEqual(f.runs.get(f.cwd, f.seed.milestone), null);
        assert.strictEqual(controller.pendingOwnerInterruptions(f.cwd).length, 0);
        assert.strictEqual(controller.failureProjection(f.cwd, f.seed.milestone).length, 1, 'archival preserves failed/unverified lineage');
        const milestone = 'M-20261109120312-unrelated375';
        fs.mkdirSync(path.join(f.cwd, '.gsd/milestones', milestone), { recursive: true });
        state.write(f.cwd, { milestone, kind: 'milestone', phase: 'research-slice', active_slice: 'S99', active_task: '\u2014', auto_mode: 'off' });
        assert.strictEqual(controller.begin(f.cwd, { milestone, unit: 'research-slice/S99',
          host_runtime: 'codex', owner_token: 'unrelated375', idempotency_key: 'unrelated-after-' + action }, { prefsReader }).ok, true);
        const archive = path.join(f.cwd, '.gsd/forge/owner-interruption-witnesses', settled.interruption.operation_id + '.json');
        const archived = controller.readJson(archive);
        archived.witness.terminals[0].sha256 = 'f'.repeat(64); controller.writeAtomic(archive, archived);
        assert.throws(() => controller.pendingOwnerInterruptions(f.cwd), error => error.code === 'owner-interruption-witness-invalid',
          'archive re-seal cannot replace manifest/terminal authority');
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        f.options.failpoint = point => point === 'owner-interruption-after-manifest';
        assert.throws(f.settle, /failpoint/);
        const before = f.monitored();
        assert.throws(() => f.runs.remove(f.cwd, f.seed.milestone), error => error.code === 'owner-interruption-pending');
        assert.deepStrictEqual(f.monitored(), before, 'canonical remove preserves the unfinished anchor');
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        const file = f.runs.runFile(f.cwd, f.seed.milestone);
        f.runs.update(f.cwd, f.seed.milestone, { padding: '' });
        const record = JSON.parse(fs.readFileSync(file));
        const padding = 65261 - Buffer.byteLength(JSON.stringify(record, null, 2));
        assert(padding > 0); f.runs.update(f.cwd, f.seed.milestone, { padding: 'x'.repeat(padding) });
        assert.strictEqual(fs.statSync(file).size, 65261, 'valid record below the existing64KiB read bound');
        f.options.expectedRecordSha256 = f.digest(fs.readFileSync(file).toString('utf8'));
        const before = f.monitored();
        for (let i = 0; i < 2; i++) {
          assert.throws(f.settle, error => error.code === 'owner-resume-history-limit');
          assert.deepStrictEqual(f.monitored(), before, 'capacity refusal occurs before terminals/events/lease release');
          assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/owner-interruptions')), 'no manifest was published');
        }
      } finally { cleanup(f.cwd); }
    }
    {
      const f = interruptionFixture();
      try {
        f.runs.update(f.cwd, f.seed.milestone, { padding: 'x'.repeat(60000) });
        f.options.expectedRecordSha256 = f.digest(fs.readFileSync(f.runs.runFile(f.cwd, f.seed.milestone)).toString('utf8'));
        assert.strictEqual(f.settle().status, 'interrupted-and-transferred', 'bounded large record still transfers');
        assert(fs.statSync(f.runs.runFile(f.cwd, f.seed.milestone)).size <= 65536);
      } finally { cleanup(f.cwd); }
    }
  } finally { if (oldSession === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = oldSession; }
}

// Synthetic historical observations exercise the public administrative API;
// they are not fabricated receipts for a real worker or provider invocation.
function supersededInterruptionFixture(options = {}) {
  const f = interruptionFixture(), sidecar = require('./forge-unit-sidecar');
  const external = temp(), resultFile = path.join(external, 'prior-blocked.json');
  const request = { unitType: 'complete-slice', milestoneId: f.seed.milestone, sliceId: 'S01',
    cwd: f.cwd, contextRoot: f.cwd, resultFile, dispatchId: 'fixture378-codex-first', workflowId: f.seed.milestone,
    route: { host_runtime: 'codex', resolved_worker_engine: 'codex', worker_mode: 'sidecar' } };
  const receiptFile = sidecar.artifactAttemptFiles(request).receiptFile;
  const receipt = { phase: 'ready', fingerprint: sidecar.artifactFingerprint(request), dispatch_id: request.dispatchId,
    recovery_identity_sha256: require('./forge-code-roots').digest(require('./forge-attempt-recovery').requestIdentity(require('./forge-attempt-recovery').canonicalRequest(request))),
    provider_called: true, pending_questions: [], result: { status: 'blocked', artifacts: [], questions: [] } };
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const eventFile = controller.eventsFile(f.cwd, options.milestone ? f.seed.milestone : undefined);
  const eol = options.crlf ? '\r\n' : '\n';
  const prior = (fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '').replace(/\r?\n/g, eol);
  const prefix = prior && !prior.endsWith('\n') ? prior + eol : prior;
  const eventLine = '  ' + JSON.stringify({ event: 'route-chain-advance', fixture_only: true,
    unit: 'complete-slice/S01', milestone: f.seed.milestone, from_dispatch: request.dispatchId, to_native: 'fixture378-native-final' }) + ' ';
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  fs.writeFileSync(eventFile, prefix + eventLine + eol);
  const routeEvidence = { path: eventFile, line: prefix.split('\n').length,
    sha256: require('crypto').createHash('sha256').update(eventLine + (options.crlf ? '\r' : '')).digest('hex') };
  const finalNative = { id: 'fixture378-native-final', host_runtime: 'codex', worker_mode: 'native',
    status: 'partial', receipt_path: null, observation_reference: 'fixture-only observed native final partial; no actual Agent call' };
  const previous = f.options.inspectInterruption;
  f.options.inspectInterruption = query => ({ ...previous(query), ...(query.role === 'original' ? {
    receipt_path: receiptFile, saved_response: 'ready/blocked', request,
    supersession: { route_evidence: [routeEvidence], final_native_attempt: finalNative } } : {}) });
  f.options.attestSupersededAttempt = challenge => {
    assert.strictEqual(challenge.begin_key, f.seed.lineage.begin_key);
    assert.strictEqual(challenge.begin_checksum, f.seed.lineage.begin_checksum);
    assert.strictEqual(challenge.evidence.receipt.dispatch_id, request.dispatchId);
    assert.strictEqual(challenge.evidence.final_native_attempt.id, finalNative.id);
    assert.deepStrictEqual(challenge.evidence.route_evidence, [{ ...routeEvidence, path: fs.realpathSync.native(eventFile) }]);
    return { challenge_sha256: f.digest(challenge), superseded: true, final_native_receiptless: true,
      final_native_status: 'partial', reference: 'fixture-only live supersession attestation' };
  };
  return { ...f, request, receipt, receiptFile, eventFile, routeEvidence, finalNative,
    cleanup: () => { cleanup(f.cwd); cleanup(external); } };
}
function testSupersededInterruptedOwner() {
  const oldSession = process.env.CODEX_THREAD_ID;
  try {
    for (const options of [{ milestone: true, crlf: true }, { milestone: true, crlf: false }, { milestone: false, crlf: true }]) {
      const f = supersededInterruptionFixture(options);
      try {
        const before = fs.readFileSync(f.eventFile);
        assert.strictEqual(f.settle().status, 'interrupted-and-transferred');
        const after = fs.readFileSync(f.eventFile);
        assert(after.subarray(0, before.length).equals(before), 'preserve complete historical event bytes and formatting');
        const line = after.toString('utf8').split('\n')[f.routeEvidence.line - 1];
        assert.strictEqual(require('crypto').createHash('sha256').update(line).digest('hex'), f.routeEvidence.sha256);
        const settled = f.monitored();
        assert.strictEqual(f.settle().status, 'already-settled');
        assert.deepStrictEqual(f.monitored(), settled, 'terminal event replay is idempotent');
        assert(fs.readFileSync(f.eventFile).equals(after));
      } finally { f.cleanup(); }
    }
    {
      const f = supersededInterruptionFixture();
      try {
        f.receipt.pending_questions = [{ id: 'earlier378-question', question: 'Earlier unresolved decision', status: 'pending' }];
        f.receipt.result.questions = [{ id: 'result378-question', question: 'Result unresolved decision', status: 'pending' }];
        fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
        const beforeReceipt = fs.readFileSync(f.receiptFile), beforeEvents = fs.readFileSync(f.eventFile);
        const result = f.settle();
        assert.strictEqual(result.status, 'interrupted-and-transferred');
        assert.strictEqual(result.interruption.artifacts_accepted, false);
        assert.deepStrictEqual(result.record.pending_questions.map(q => q.id).sort(), ['earlier378-question', 'result378-question']);
        assert(fs.readFileSync(f.receiptFile).equals(beforeReceipt));
        assert(fs.readFileSync(f.eventFile).equals(beforeEvents));
        const terminal = controller.lookupRecord(f.cwd, 'transaction', result.interruption.terminals[0].key);
        assert.strictEqual(terminal.result.status, 'failed');
        assert.strictEqual(terminal.result.output.worker_result, 'unverified');
        assert.strictEqual(terminal.terminal_failure.safety.superseded_attempt.receipt.dispatch_id, f.request.dispatchId);
        assert.strictEqual(terminal.terminal_failure.safety.receipt_sha256,
          require('crypto').createHash('sha256').update(beforeReceipt).digest('hex'));
        assert.strictEqual(lease.observe(f.cwd, 'complete-slice/S01').lease, null);
        assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S02').lease, null);
        assert.strictEqual(f.settle().status, 'already-settled');
      } finally { f.cleanup(); }
    }
    const negatives = [
      ['missing live attester', f => { delete f.options.attestSupersededAttempt; }, 'saved-response-replay-required'],
      ['JSON is not an attester', f => { f.options.attestSupersededAttempt = { approved: true }; }, 'saved-response-replay-required'],
      ['unbound attestation', f => { f.options.attestSupersededAttempt = () => ({ approved: true }); }, 'owner-interruption-supersession-attestation-required'],
      ['current done receipt', f => { f.receipt.result.status = 'done'; }, 'saved-response-replay-required'],
      ['current partial receipt', f => { f.receipt.result.status = 'partial'; }, 'saved-response-replay-required'],
      ['executed receipt', f => { f.receipt.phase = 'executed'; }, 'saved-response-replay-required'],
      ['saved candidate', f => { f.receipt.saved_candidate = { status: 'done' }; }, 'saved-response-replay-required'],
      ['foreign dispatch', f => { f.receipt.dispatch_id = 'foreign'; }, 'attempt-identity-mismatch'],
      ['foreign fingerprint', f => { f.receipt.fingerprint = 'f'.repeat(64); }, 'attempt-identity-mismatch'],
      ['foreign recovery identity', f => { f.receipt.recovery_identity_sha256 = 'f'.repeat(64); }, 'attempt-identity-mismatch'],
      ['foreign request unit', f => { f.request.sliceId = 'S02'; }, 'attempt-identity-mismatch'],
      ['changed historical event', f => { fs.appendFileSync(f.eventFile, ''); f.routeEvidence.sha256 = 'f'.repeat(64); }, 'owner-interruption-evidence-changed'],
      ['no recorded route advance', f => { const raw = JSON.stringify({ event: 'unrelated' }); fs.writeFileSync(f.eventFile, raw + '\n'); f.routeEvidence.line = 1; f.routeEvidence.sha256 = require('crypto').createHash('sha256').update(raw).digest('hex'); }, 'owner-interruption-supersession-invalid'],
      ['native done', f => { f.finalNative.status = 'done'; }, 'saved-response-replay-required'],
      ['native foreign host', f => { f.finalNative.host_runtime = 'claude'; }, 'saved-response-replay-required'],
      ['native receipt present', f => { f.finalNative.receipt_path = f.receiptFile; }, 'saved-response-replay-required'],
      ['native unknown process', f => { f.options.processProbe = () => 'unknown'; }, 'process-not-stopped'],
      ['invoked successor with receipt', f => { const old = f.options.inspectInterruption; f.options.inspectInterruption = query => ({ ...old(query), receipt_path: f.receiptFile, saved_response: 'ready/blocked' }); }, 'saved-response-replay-required'],
    ];
    for (const [label, change, code] of negatives) {
      const f = supersededInterruptionFixture();
      try {
        change(f); fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
        const before = f.monitored();
        assert.throws(f.settle, error => error.code === code, label);
        assert.deepStrictEqual(f.monitored(), before, label + ' has no terminal/lease/run effect');
        assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/owner-interruptions')), label + ' publishes no manifest');
      } finally { f.cleanup(); }
    }
    {
      const f = supersededInterruptionFixture();
      try {
        f.options.failpoint = point => point === 'owner-interruption-after-manifest';
        assert.throws(f.settle, /failpoint/); delete f.options.failpoint;
        const before = f.monitored(), original = fs.readFileSync(f.receiptFile);
        f.receipt.pending_questions = [{ id: 'changed378-q', question: 'Changed historical evidence', status: 'pending' }];
        fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
        assert.throws(f.settle, error => error.code === 'owner-interruption-evidence-changed');
        assert.deepStrictEqual(f.monitored(), before, 'changed receipt cannot continue the old durable manifest');
        fs.writeFileSync(f.receiptFile, original);
        assert.strictEqual(f.settle().status, 'interrupted-and-transferred', 'exact original evidence safely replays');
      } finally { f.cleanup(); }
    }
    {
      const f = supersededInterruptionFixture();
      try {
        const original = fs.readFileSync(f.receiptFile);
        let changed = false;
        f.options.failpoint = point => {
          if (point === 'owner-interruption-after-intent' && !changed) {
            changed = true; f.receipt.provider_called = false;
            fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
          }
          return false;
        };
        assert.throws(f.settle, error => error.code === 'owner-interruption-evidence-changed',
          'every terminal phase is bound to the durable original receipt');
        assert(lease.observe(f.cwd, 'complete-slice/S01').lease);
        assert(lease.observe(f.cwd, 'plan-slice/S02').lease);
        fs.writeFileSync(f.receiptFile, original); delete f.options.failpoint;
        assert.strictEqual(f.settle().status, 'interrupted-and-transferred');
      } finally { f.cleanup(); }
    }
  } finally { if (oldSession === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = oldSession; }
}

function main() {
  test('378: superseded blocked receipt, live native-partial attestation, evidence retention and replay refusals', testSupersededInterruptedOwner);
  test('interrupted owner review R1/R2/R3: successor questions, cleanup archive and prepublication capacity', testInterruptedOwnerReviewGuards);
  test('receiptless interrupted-owner lineage: actor separation, failure-only settlement, zero-effect negatives and eleven fresh-process crashes', testInterruptedOwnerLineage);
  console.log(`forge-unit-controller tests on ${process.platform}`);
  test('fresh enrolled milestone CLI matches API before OPTIONS and selection is read-only', testEnrolledCliSelectionParity);
  test('S02 review R60: scoped completed slice proof survives another milestone boundary', testScopedSliceProofSurvivesOtherMilestone);
  test('S02 task binding: readonly current-allocation projection, eight identifiers and every mutation negative', testTaskBindingContextAndEightIdentifiers);
  test('S02 task binding: cross-slice barriers, duplicate T01 identities and unplanned independent slices', testCrossSliceBarriersAndDuplicateTaskIds);
  test('S02 pure selection with and without time_options, roadmap blocks and scoped task DAG', testPureTimeOptionSelection);
  test('S02 guard: every selection state, forged inventory, replay and zero lease/transaction', testTimeOptionGuardEveryState);
  test('S02 guard: roadmap conformance blocks dependents with budget priority', testTimeOptionGuardRoadmapAndBudgetPriority);
  test('S02 guard: scoped task DAG on explicit begin and on reentry', testScopedTaskDagGuardAndReentry);
  test('S02 guard: historical canonical proof, independent completion key and tamper negatives', testHistoricalProofTamperAndLineage);
  test('S02 guard R53: captured time, declared-source bindings and capture consistency bound to the committed completion', testHistoricalCaptureMetadataAndInventory);
  test('S02 guard R54: begin and completion events bound symmetrically with finite ordered sequences', testCompletionEventLineage);
  test('S02 guard R55: review disabled is a named incompatibility before activation and for new admissions; legacy/no-contract unchanged', testReviewModeIncompatibleWithContract);
  test('S02 guard R57: complete depends declarations reject malformed blocks before admission', testCompleteDependsDeclarations);
  test('S02 guard R58: intermediate plan links refuse before admission', testIntermediatePlanLinksRefuse);
  test('S02 guard R59: completed local subtasks prove dependencies safely', testCompletedLocalSubtasksProveDependencies);
  test('S02 guard: ROADMAP written after enrollment without a choice is not legacy', testRogueRoadmapAfterEnrollment);
  test('S02 guard: rogue ROADMAP refuses reentry before lease or transaction', testRogueRoadmapBlocksReentry);
  test('pure deterministic selection', testPureSelection);
  test('phase ordering, canonical skip preferences and stale slice selection', testSelectionPhasesAndCanonicalPrefs);
  test('artifact discovery selects without leases or STATE writes', testSelectionDiscoversArtifactsWithoutWriting);
  test('cumulative milestone SUMMARY does not skip complete-milestone', testCumulativeSummaryDoesNotCloseMilestone);
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
if (process.argv[2] === '--superseded-interruption-only') {
  testSupersededInterruptedOwner();
} else if (process.argv[2] === '--owner-interruption-fixture-child') {
  const fixture = interruptionFixture(process.argv[3]);
  assert.strictEqual(fixture.settle().status, 'interrupted-and-transferred');
} else main();
