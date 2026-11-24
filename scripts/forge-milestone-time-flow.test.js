#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const adapter = require('./forge-long-workflow-adapter');
const controller = require('./forge-unit-controller');
const orchestrate = require('./forge-orchestrate');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const time = require('./forge-milestone-time');
const admission = require('./forge-milestone-time-admission');
const recovery = require('./forge-attempt-recovery');
const { digest } = require('./forge-code-roots');
const BASE = Date.parse('2026-11-01T12:00:00.000Z'), M = 'M001';
const roots = [];
let serial = 0;
const iso = n => new Date(BASE + n).toISOString();
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
function test(name, fn) { fn(); console.log('PASS ' + name); }
function write(cwd, ref, value) {
  const file = path.join(cwd, ref); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); return file;
}
function decision(f, kind, request, answer) {
  const questions = require('./forge-pending-questions'), id = 'time-question-' + ++serial;
  const opened = questions.openQuestions({ cwd: f.cwd, milestone: M, unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Escolha explícita da fixture?' }] });
  questions.answer({ cwd: f.cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const live = { reference: 'fixture-' + id, status: 'resolved', answer, source: 'user-text', resolved_at: iso(f.at),
    question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference,
    { milestone: M, kind, request_sha256: digest(request), expires_at: BASE + f.at + 60000 }, () => BASE + f.at);
}
function fixture(host = 'codex', contract = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-time-flow-')); roots.push(cwd);
  fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
  const f = { cwd, host, at: 0, nextSlice: 'S01', done: false };
  f.input = { cwd, milestone: M, workflow_id: 'time-fixture', owner_token: 'time-fixture-owner', max_steps: 10 };
  f.options = optionsOf(f);
  if (contract) {
    const payload = { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
      option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
      activated_at: iso(0), preselection_started_at: iso(-5), ceiling_ms: 100,
      endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
      allocation: null, linked_task: null, chain_forecast: null };
    time.activateContract({ cwd, milestone: M, contract: payload, now: BASE,
      handle: decision(f, 'activation', payload, 'option:balanced') });
  }
  fs.mkdirSync(path.join(cwd, '.gsd/milestones', M), { recursive: true });
  state.write(cwd, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on', created: iso(0), heartbeat: iso(0) });
  // The injected inventory still selects planning; these are its legitimate eventual outputs.
  for (const slice of ['S01', 'S02', 'S03']) {
    write(cwd, `.gsd/milestones/${M}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n- [ ] **T01**: Fixture\n`);
    write(cwd, `.gsd/milestones/${M}/slices/${slice}/tasks/T01/T01-PLAN.md`, '---\nid: T01\ndepends: []\nwrites:\n  - src/result.js\nmust_haves:\n  truths:\n    - Time fixture behavior is observable.\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/result.js\n---\n# T01\n');
  }
  return f;
}
function optionsOf(f) {
  return { now: () => BASE + f.at, prefsReader,
    inventoryReader: () => ({ roadmap_exists: true, context_exists: true, research_exists: true,
      ...(f.blockSelection ? { dependency_validation: true } : {}),
      slices: [{ id: f.nextSlice, checked: false, plan_exists: false, tasks: [],
        ...(f.blockSelection ? { dependency_status: 'invalid', dependencies: [] } : {}) }] }),
    userHome: path.join(f.cwd, 'home'), env: { HOME: path.join(f.cwd, 'home'), USERPROFILE: path.join(f.cwd, 'home') },
    inspectAttempt: ({ begin }) => {
      const request = { cwd: f.cwd, contextRoot: f.cwd, milestoneId: M, sliceId: begin.after.state.active_slice,
        unitType: begin.unit.type, scope: 'milestone', phase: 'plan', route: { host_runtime: f.host, resolved_worker_engine: f.host, tier: 'standard' } };
      const receipt_path = path.join(f.cwd, 'receipt.json');
      return { receipt_path, request, roots: [{ root_id: 'primary', path: f.cwd }], pending_questions: [] };
    }, processProbe: () => f.probe || 'alive' };
}
function invoke(f, command, snapshot, extra = {}, options = f.options) {
  return adapter.invoke(f.host, 'auto', command, { ...f.input, ...extra }, snapshot, options).result;
}
function extend(f, ceiling = 1000, handle = true) {
  const request = { kind: 'extension', reason: 'Extensão explícita de fixture', patch: { ceiling_ms: ceiling } };
  return time.amendContract({ cwd: f.cwd, milestone: M, ...request, now: BASE + f.at,
    ...(handle ? { handle: decision(f, 'extension', request, 'extend:' + ceiling) } : {}) });
}
function omitVolatile(value) {
  if (Array.isArray(value)) return value.map(omitVolatile);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['lease_generation', 'storage_checksum'].includes(k))
    .map(([k, v]) => [k, omitVolatile(v)]));
}
function noContractTrace(host, bridge = { controller, adapter }) {
  const f = fixture(host, false), oldAcquire = lease.acquire;
  const call = (command, snapshot, extra = {}) => bridge.adapter.invoke(f.host, 'auto', command,
    { ...f.input, ...extra }, snapshot, f.options).result;
  // Generation affects derived checksums as well as its own field. Keep the
  // native lease token deterministic rather than removing additional fields.
  lease.acquire = (cwd, unit, options) => oldAcquire(cwd, unit, { ...options, tokenFactory: () => 'baseline-generation' });
  try {
    f.at = 1; const first = call('next');
    assert.equal(first.outcome, 'dispatch_required'); assert(!first.controller_result.details.time);
    f.at = 2; call('complete', first.snapshot, { result: { status: 'done' } });
    f.nextSlice = 'S02'; f.at = 3; const paused = call('pause');
    assert.equal(paused.outcome, 'needs_input');
    f.at = 4; const resumed = call('resume', paused.snapshot, { response: 'yes' });
    assert.equal(resumed.outcome, 'resumed');
    f.nextSlice = 'S03'; f.at = 5; const failed = call('next');
    const begin = bridge.controller.lookupRecord(f.cwd, 'transaction', failed.controller_result.details.transaction.idempotency_key);
    f.at = 6; bridge.controller.transition(f.cwd, { action: 'fail', milestone: M, unit: failed.unit, host_runtime: host,
      owner_token: f.input.owner_token, generation: begin.lease_generation, idempotency_key: 'baseline-fail', result: { status: 'failed' } }, f.options);
    const directory = bridge.controller.transactionDir(f.cwd);
    const transactions = fs.readdirSync(directory).filter(name => name.endsWith('.json'))
      .map(name => omitVolatile(bridge.controller.readJson(path.join(directory, name))))
      .sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key));
    const events = fs.readFileSync(path.join(f.cwd, '.gsd/milestones', M, M + '-events.jsonl'), 'utf8');
    assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/time')));
    const replay = replayHistoricalTrace(f);
    assert.deepStrictEqual(replay, { transactions, events }, 'current committed replay preserves original trace');
    return { transactions, events };
  } finally { lease.acquire = oldAcquire; }
}
function baseline() {
  const file = path.join(__dirname, 'fixtures/milestone-time/no-contract-baseline.json');
  const trace = withBaselineBridge(bridge => Object.fromEntries(['claude', 'codex'].map(host => [host, noContractTrace(host, bridge)])));
  if (process.argv.includes('--capture-baseline')) {
    assert.equal(digest(fs.readFileSync(require.resolve('./forge-unit-controller'))), '19b64b7b540f1133e3900ac6e682dd7d115f74cc56de9eef2b28c12345c185ac', 'capture requires unchanged 14260f8 controller');
    assert.equal(digest(fs.readFileSync(require.resolve('./forge-orchestrate'))), '98026cd8638c8f1b10306742653c20a118dd9ec775c6e013783a04b175c59652', 'capture requires unchanged 14260f8 orchestrate');
    const provenance = { revision: 'b73ba3b825b38c6a9589d019072d63109deff326', reference_revision: '14260f8',
      controller_sha256: digest(fs.readFileSync(require.resolve('./forge-unit-controller'))),
      orchestrate_sha256: digest(fs.readFileSync(require.resolve('./forge-orchestrate'))),
      clock: iso(0), owner_token: 'time-fixture-owner', lease_token: 'baseline-generation',
      method: 'Public adapter invoke; injected single clock and native lease tokenFactory; remove only lease_generation and storage_checksum' };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ provenance, trace }, null, 2) + '\n');
    console.log('PASS no-contract-baseline-captured-before-controller-orchestrate-edits');
  } else assert.equal(JSON.stringify(trace), JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).trace), 'baseline trace differs');
}
function beginRecord(f, selected) { return controller.lookupRecord(f.cwd, 'transaction', selected.controller_result.details.transaction.idempotency_key); }
function liveReceipt(f, selected, phase = 'executing') {
  const begun = beginRecord(f, selected), context = f.options.inspectAttempt({ begin: begun });
  write(f.cwd, 'receipt.json', { phase, recovery_identity_sha256: digest(recovery.requestIdentity(context.request)),
    ...(phase === 'failed' ? { failure: { reason_code: 'fixture-failure', provider_called: false } } : {}) });
}
function entryOptions(f) {
  return { ...f.options, processProbe: () => 'stopped',
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: f.cwd }] }),
    entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: iso(f.at) })) };
}
function withBaselineBridge(callback) {
  // Re-run the immutable pre-edit blobs in the same physical temporary owner.
  // Root device/inode and the linked security hashes must not be normalized.
  const Module = require('module'), names = ['forge-unit-controller', 'forge-orchestrate', 'forge-loop-controller', 'forge-long-workflow-adapter'];
  const saved = names.map(name => require.cache[require.resolve('./' + name)]);
  const loaded = [];
  try {
    for (const [index, name] of names.entries()) {
      const filename = require.resolve('./' + name);
      let source;
      if (index < 2) {
        const old = spawnSync('git', ['show', '14260f8:scripts/' + name + '.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
        assert.equal(old.status, 0, old.stderr); source = old.stdout;
        const fixture = require('./fixtures/milestone-time/no-contract-baseline.json');
        const expected = index === 0 ? fixture.provenance.controller_sha256 : fixture.provenance.orchestrate_sha256;
        assert.equal(digest(Buffer.from(source)), expected, 'immutable baseline source differs');
      } else source = fs.readFileSync(filename, 'utf8');
      const instance = new Module(filename, module); instance.filename = filename; instance.paths = module.paths;
      require.cache[filename] = instance; instance._compile(source, filename); loaded.push(instance.exports);
    }
    return callback({ controller: loaded[0], adapter: loaded[3] });
  } finally {
    names.forEach((name, index) => { require.cache[require.resolve('./' + name)] = saved[index]; });
  }
}
function linkedTrace(f, bridge) {
  const oldAcquire = lease.acquire;
  lease.acquire = (cwd, unit, options) => oldAcquire(cwd, unit, { ...options, tokenFactory: () => 'baseline-generation' });
  try {
    const call = (command, snapshot, extra = {}, options = f.options) => bridge.adapter.invoke(f.host, 'auto', command,
      { ...f.input, ...extra }, snapshot, options).result;
    f.at = 1; const selected = bridge.begin ? bridge.begin() : call('next'); liveReceipt(f, selected, 'failed'); f.at = 2;
    const options = entryOptions(f), consumed = call('consume-failure', selected.snapshot, {}, options);
    assert.equal(consumed.reason_code, 'failure-consumed');
    f.at = 3;
    const entered = call('reenter', consumed.snapshot, { unit: selected.unit,
      entry: { entry_id: 'baseline-linked-entry', authorization_ref: 'fixture-entry',
        failure_key: consumed.controller_result.details.failure_key, failure_checksum: consumed.controller_result.details.failure_checksum } }, options);
    assert.equal(entered.outcome, 'dispatch_required', JSON.stringify(entered));
    const dir = bridge.controller.transactionDir(f.cwd);
    const transactions = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
      .map(name => omitVolatile(bridge.controller.readJson(path.join(dir, name))))
      .sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key));
    assert(transactions.some(row => row.linked_entry)); assert(transactions.every(row => !Object.hasOwn(row, 'time_admission')));
    assert(!entered.controller_result.details.time); assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/time')));
    return { transactions, events: fs.readFileSync(path.join(f.cwd, '.gsd/milestones/M001/M001-events.jsonl'), 'utf8') };
  } finally { lease.acquire = oldAcquire; }
}
function replayHistoricalTrace(f) {
  const directory = controller.transactionDir(f.cwd), files = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  const before = new Map(files.map(name => [name, fs.readFileSync(path.join(directory, name))]));
  const eventFile = controller.eventsFile(f.cwd, M), eventsBefore = fs.readFileSync(eventFile);
  for (const name of files) {
    const row = controller.readJson(path.join(directory, name));
    assert(!Object.hasOwn(row, 'plan_generation'), 'actual historical producer did not enroll its begin');
    assert.deepStrictEqual(controller.lookupRecord(f.cwd, 'transaction', row.idempotency_key), row);
    if (row.action !== 'begin') {
      const replay = controller.transition(f.cwd, { action: row.action, milestone: M, unit: row.unit, host_runtime: row.host_runtime,
        owner_token: f.input.owner_token, generation: row.lease_generation, idempotency_key: row.idempotency_key, result: row.result }, f.options);
      assert.equal(replay.reason, 'already-committed');
    }
  }
  assert.deepStrictEqual(fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort(), files.sort(), 'zero new transactions');
  for (const [name, bytes] of before) assert.deepStrictEqual(fs.readFileSync(path.join(directory, name)), bytes);
  assert.deepStrictEqual(fs.readFileSync(eventFile), eventsBefore, 'historical replay adds zero events');
  return { transactions: files.map(name => omitVolatile(controller.readJson(path.join(directory, name))))
    .sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key)), events: eventsBefore.toString('utf8') };
}
function linkedBaseline(host) {
  const f = fixture(host, false);
  const original = withBaselineBridge(bridge => linkedTrace(f, bridge));
  // Preserve the same owner/inode; reset only this test's disposable GSD, as before.
  assert(roots.includes(f.cwd));
  fs.rmSync(path.join(f.cwd, '.gsd'), { recursive: true, force: true });
  fs.mkdirSync(path.join(f.cwd, '.gsd/milestones/M001'), { recursive: true });
  state.write(f.cwd, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—',
    auto_mode: 'on', created: iso(0), heartbeat: iso(0) });
  for (const slice of ['S01', 'S02', 'S03']) {
    write(f.cwd, `.gsd/milestones/${M}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n- [ ] **T01**: Fixture\n`);
    write(f.cwd, `.gsd/milestones/${M}/slices/${slice}/tasks/T01/T01-PLAN.md`, '---\nid: T01\ndepends: []\nwrites:\n  - src/result.js\nmust_haves:\n  truths:\n    - Time fixture behavior is observable.\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/result.js\n---\n# T01\n');
  }
  // Only the predecessor begin comes from the actual immutable old producer.
  // consume-failure and reenter below execute NOW through current adapter/controller.
  const current = linkedTrace(f, { controller, adapter, begin: () => withBaselineBridge(bridge =>
    bridge.adapter.invoke(f.host, 'auto', 'next', f.input, null, f.options).result) });
  assert.deepStrictEqual(current, original);
  const records = fs.readdirSync(controller.transactionDir(f.cwd)).filter(name => name.endsWith('.json'))
    .map(name => controller.readJson(path.join(controller.transactionDir(f.cwd), name)));
  assert(records.some(row => row.linked_entry && row.phase === 'committed'), 'CURRENT linked reentry committed');
  assert(records.every(row => !Object.hasOwn(row, 'plan_generation')), 'current continuation inherits actual historical predecessor classification');
  assert.deepStrictEqual(replayHistoricalTrace(f), current, 'current continuation is byte-identical under committed replay');
}
function transition(f, selected, action) {
  const begun = beginRecord(f, selected);
  return controller.transition(f.cwd, { action, milestone: M, unit: selected.unit, host_runtime: f.host,
    owner_token: f.input.owner_token, generation: begun.lease_generation, idempotency_key: 'transition-' + action,
    result: { status: action === 'fail' ? 'failed' : 'succeeded' } }, f.options);
}
function restart(f, snapshotFile, command, extra = {}) {
  const dataFile = write(f.cwd, 'restart-input.json', { f: { cwd: f.cwd, host: f.host, input: f.input, at: f.at, nextSlice: f.nextSlice }, extra });
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), t = require(process.argv[1]), data = JSON.parse(fs.readFileSync(process.argv[2]));
    data.f.options = t.optionsOf(data.f);
    const snapshot = JSON.parse(fs.readFileSync(process.argv[3]));
    process.stdout.write(JSON.stringify(t.invoke(data.f, process.argv[4], snapshot, data.extra)));
  `, __filename, dataFile, snapshotFile, command], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
function main() {
  test('historical-producer-no-contract-golden-and-current-readonly-committed-replay', baseline);
  if (process.argv.includes('--capture-baseline')) return;
  test('current-no-contract-native-plan-enrolled-and-completed-through-canonical-result', () => {
    for (const host of ['claude', 'codex']) {
      const f = fixture(host, false); f.at = 1;
      const selected = invoke(f, 'next'), begin = beginRecord(f, selected);
      assert(begin.plan_generation, 'a newly produced native begin is enrolled even without a time contract');
      f.at = 2;
      const completed = invoke(f, 'complete', selected.snapshot, { result: { status: 'done' } });
      assert.equal(completed.outcome, 'completed', JSON.stringify(completed));
      const record = controller.lookupRecord(f.cwd, 'transaction', begin.idempotency_key + ':complete');
      require('./forge-plan-validation').verifyPlanValidation(record.result.plan_validation, begin.plan_generation);
      assert(!Object.hasOwn(record, 'plan_validation'), 'no top-level evidence alias');
      assert(!selected.controller_result.details.time, 'the real begin has no time contract admission');
    }
  });
  test('declared-artifacts-and-key-links-substantive', () => {
    for (const [name, minimum] of [['forge-unit-controller.js', 1400], ['forge-orchestrate.js', 475],
      ['forge-milestone-time-flow.test.js', 260], ['fixtures/milestone-time/no-contract-baseline.json', 20]]) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert(source.split('\n').length >= minimum, name);
      if (name === 'forge-unit-controller.js' || name === 'forge-orchestrate.js') assert(!/\b(?:TODO|TBD|FIXME)\b/.test(source));
    }
    const provenance = require('./fixtures/milestone-time/no-contract-baseline.json').provenance;
    assert.equal(provenance.reference_revision, '14260f8'); assert.equal(provenance.revision, 'b73ba3b825b38c6a9589d019072d63109deff326');
  });
  for (const host of ['claude', 'codex']) {
    test(host + ': no-contract-linked-reentry-exact-pre-edit-blobs-same-root-no-security-normalization', () => linkedBaseline(host));
    test(host + ': public-admission-presence-digest-and-replay-without-reevaluation', () => {
      const f = fixture(host); f.at = 1;
      const selected = invoke(f, 'next', null, { time_session: 'private-time-session', session: 'lease-session' });
      assert.equal(selected.outcome, 'dispatch_required', JSON.stringify(selected));
      const begin = beginRecord(f, selected); assert.equal(begin.time_admission.decision, 'admitted');
      const journal = time.readJournal({ cwd: f.cwd, milestone: M });
      assert.equal(journal.records[0].session_sha256, digest('private-time-session'));
      assert(!JSON.stringify(journal).includes('private-time-session'));
      f.at = 150;
      const original = admission.decideAdmission; admission.decideAdmission = () => { throw Error('replay reevaluated'); };
      try {
        assert(controller.begin(f.cwd, { milestone: M, unit: selected.unit, host_runtime: host,
          owner_token: f.input.owner_token, idempotency_key: begin.idempotency_key }, f.options).ok);
      } finally { admission.decideAdmission = original; }
      assert.deepStrictEqual(controller.lookupRecord(f.cwd, 'transaction', begin.idempotency_key), begin);
    });
    test(host + ': mutex-before-lease-and-all-time-reasons-map-blocked-with-details', () => {
      for (const code of admission.TIME_REASON_CODES) {
        assert(controller.REASON_CODES.includes(code)); assert(orchestrate.REASON_CODES.includes(code));
        const f = fixture(host); f.at = 1;
        const original = admission.decideAdmission, savedAcquire = lease.acquire;
        let calls = 0, acquisitions = 0;
        admission.decideAdmission = (cwd, options) => {
          calls++; assert(require('./forge-lock').status(cwd, 'unit-controller-transactions').held);
          return { allowed: false, reason_code: code, details: { state: 'active', ceiling_ms: 100,
            consumed_ms: 1, unknown_ms: 1, remaining_ms: 99, open_writers: [], unknowns: ['unattributed-time'] } };
        };
        lease.acquire = (...args) => { acquisitions++; return savedAcquire(...args); };
        try {
          const result = invoke(f, 'next');
          assert.equal(result.outcome, 'blocked'); assert.equal(result.reason_code, code);
          assert.equal(result.controller_result.details.time.ceiling_ms, 100);
          assert.equal(calls, 1); assert.equal(acquisitions, 0);
          assert(!fs.existsSync(controller.transactionDir(f.cwd)));
          assert(!fs.existsSync(path.join(f.cwd, '.gsd/milestones/M001/M001-events.jsonl')));
        } finally { admission.decideAdmission = original; lease.acquire = savedAcquire; }
      }
    });
    test(host + ': cap-drains-live-writer-without-kill-lease-theft-or-new-attempt-and-completes', () => {
      const f = fixture(host); f.at = 1; const selected = invoke(f, 'next'); liveReceipt(f, selected);
      const generation = beginRecord(f, selected).lease_generation;
      const savedAcquire = lease.acquire, savedKill = process.kill; let acquisitions = 0, kills = 0;
      lease.acquire = (...args) => { acquisitions++; return savedAcquire(...args); };
      process.kill = (pid, signal) => { if (signal !== 0) kills++; return savedKill(pid, signal); };
      try {
        f.at = 150; f.nextSlice = 'S02';
        const blocked = invoke(f, 'next');
        assert.equal(blocked.reason_code, 'milestone-budget-draining', JSON.stringify(blocked));
        assert.equal(blocked.controller_result.details.time.checkpoint.status, 'not-drained');
        assert.equal(blocked.controller_result.details.time.checkpoint.drain.writers[0].classification, 'healthy');
        assert.equal(lease.observe(f.cwd, selected.unit.key).lease.generation, generation);
        assert.equal(acquisitions, 0); assert.equal(kills, 0);
        f.at = 170;
        assert.equal(invoke(f, 'complete', selected.snapshot, { result: { status: 'done' }, time_session: 'private-time-session' }).outcome, 'completed');
        const exhausted = invoke(f, 'next');
        assert.equal(exhausted.reason_code, 'milestone-budget-exhausted');
        const checkpoint = exhausted.controller_result.details.time.checkpoint;
        assert.equal(checkpoint.status, 'checkpointed', JSON.stringify(checkpoint));
        assert(checkpoint.record.decision_pending); assert.equal(checkpoint.record.overshoot_ms, 70);
        assert.equal(acquisitions, 0); assert.equal(kills, 0);
      } finally { lease.acquire = savedAcquire; process.kill = savedKill; }
    });
    test(host + ': same-persisted-blocked-snapshot-restarts-extends-and-really-dispatches', () => {
      const f = fixture(host); f.at = 150;
      const blocked = invoke(f, 'next'); assert.equal(blocked.reason_code, 'milestone-budget-exhausted');
      const file = write(f.cwd, 'workflow-snapshot.json', blocked.snapshot), original = fs.readFileSync(file);
      assert.equal(restart(f, file, 'next').reason_code, 'workflow-terminal');
      assert.equal(restart(f, file, 'resume-budget').reason_code, 'budget-extension-required');
      assert.throws(() => extend(f, 1000, false), e => e.code === 'time-decision-attestation-required');
      assert.equal(restart(f, file, 'resume-budget').outcome, 'blocked');
      extend(f);
      const resumed = restart(f, file, 'resume-budget');
      assert.equal(resumed.outcome, 'dispatch_required', JSON.stringify(resumed));
      assert.equal(resumed.workflow_id, blocked.workflow_id); assert.equal(resumed.unit.key, blocked.controller_result.unit.key);
      assert.equal(resumed.snapshot.step_count, blocked.snapshot.step_count + 1);
      assert.equal(beginRecord(f, resumed).time_admission.decision, 'admitted');
      assert.equal(admission.readTimeStatus(f.cwd, M, f.options).clocks.consumed_ms, 150);
      assert.deepStrictEqual(fs.readFileSync(file), original);
    });
    test(host + ': resume-keeps-real-pending-functional-question-without-invented-answer', () => {
      const f = fixture(host); f.at = 150; const blocked = invoke(f, 'next');
      const file = write(f.cwd, 'workflow-snapshot.json', blocked.snapshot);
      const questions = require('./forge-pending-questions');
      const opened = questions.openQuestions({ cwd: f.cwd, milestone: M,
        unit: 'plan-slice/S01', decision_set: 'functional-choice', questions: [{ id: 'functional-id', question: 'Decisão funcional?' }] });
      extend(f);
      assert.equal(restart(f, file, 'resume-budget').reason_code, 'pending-questions');
      const pending = questions.listPendingQuestions({ cwd: f.cwd, filter: { type: 'milestone', id: M } });
      assert(pending.questions.some(q => q.id === 'functional-id' && q.status === 'pending'));
      questions.answer({ cwd: f.cwd, identity: opened.identity_sha256, answers: [{ id: 'functional-id', answer: 'yes', source: 'user-text' }] });
      assert.equal(restart(f, file, 'resume-budget').outcome, 'dispatch_required');
    });
    test(host + ': cap-transition-pause-fail-expired-safe-persist-result-and-boundary-continuation', () => {
      for (const action of ['pause', 'fail', 'expired-safe', 'persist-result']) {
        const f = fixture(host); f.at = 1; const selected = invoke(f, 'next'); f.at = 150;
        assert(transition(f, selected, action).ok, action);
        if (action === 'pause') {
          const boundary = controller.lookupRecord(f.cwd, 'boundary', selected.unit.key);
          const resumed = orchestrate.next({ ...f.input, host_runtime: host, boundary, response: 'yes' }, f.options);
          assert.equal(resumed.outcome, 'completed', JSON.stringify(resumed));
          const begin = controller.lookupRecord(f.cwd, 'transaction', 'forge-orchestrate-resume:' + boundary.idempotency_key);
          assert.equal(begin.time_admission.decision, 'boundary-continuation');
        }
      }
    });
    test(host + ': public-linked-reentry-refused-at-cap-admitted-only-after-attested-extension', () => {
      const f = fixture(host); f.at = 1; const selected = invoke(f, 'next'); liveReceipt(f, selected, 'failed');
      f.at = 150; const options = entryOptions(f);
      const consumed = invoke(f, 'consume-failure', selected.snapshot, {}, options);
      assert.equal(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
      const entry = { unit: selected.unit, entry: { entry_id: 'flow-entry', authorization_ref: 'fixture-entry',
        failure_key: consumed.controller_result.details.failure_key, failure_checksum: consumed.controller_result.details.failure_checksum } };
      const refused = invoke(f, 'reenter', consumed.snapshot, entry, options);
      assert.equal(refused.reason_code, 'milestone-budget-exhausted', JSON.stringify(refused));
      assert.equal(refused.controller_result.details.time.ceiling_ms, 100);
      assert.equal(lease.observe(f.cwd, selected.unit.key).lease, null);
      const deferred = invoke(f, 'next', consumed.snapshot, {}, options);
      assert.equal(deferred.reason_code, 'milestone-budget-exhausted');
      extend(f);
      const entered = invoke(f, 'reenter', consumed.snapshot, entry, options);
      assert.equal(entered.outcome, 'dispatch_required', JSON.stringify(entered));
      const begin = beginRecord(f, entered); assert.equal(begin.time_admission.decision, 'admitted');
      assert(begin.linked_entry); assert.equal(begin.linked_entry.failure_key, entry.entry.failure_key);
      f.at = 1200;
      assert.equal(invoke(f, 'reenter', entered.snapshot, entry, options).outcome, 'dispatch_required');
    });
    test(host + ': unknown-writer-no-checkpoint-and-corrupt-contract-fails-closed', () => {
      const f = fixture(host); f.at = 1; const selected = invoke(f, 'next'); liveReceipt(f, selected);
      f.at = 150; f.nextSlice = 'S02'; f.probe = 'unknown';
      const blocked = invoke(f, 'next');
      assert.equal(blocked.controller_result.details.time.checkpoint.drain.state, 'incomplete-unknown');
      assert.equal(time.readCheckpoints({ cwd: f.cwd, milestone: M }).records.length, 0);
      fs.writeFileSync(time.timePaths({ cwd: f.cwd, milestone: M }).contract, '{broken');
      const corrupt = invoke(f, 'next');
      assert.equal(corrupt.outcome, 'blocked'); assert.equal(corrupt.reason_code, 'milestone-time-invalid');
    });
    test(host + ': blocked-forecast-warning-stable-id-no-duplicate-and-normalization-compatibility', () => {
      const f = fixture(host), roadmap = '# Roadmap\n';
      write(f.cwd, '.gsd/milestones/M001/M001-ROADMAP.md', roadmap);
      const request = { kind: 'allocation', reason: 'Alocação explícita', patch: { allocation: { roadmap_sha256: digest(roadmap),
        items: [{ id: 'integration', kind: 'integration', ms: 101 }] } } };
      time.amendContract({ cwd: f.cwd, milestone: M, ...request, now: BASE,
        handle: decision(f, 'allocation', request, 'allocation:' + digest(roadmap)) });
      f.blockSelection = true;
      const first = invoke(f, 'next');
      const warning = first.controller_result.details.time.warning;
      assert(warning?.warning); assert.equal(warning.classification, 'exceeds'); assert(/^[a-f0-9]{64}$/.test(warning.id));
      const again = invoke(f, 'next'); assert(!again.controller_result.details.time.warning);
      assert.equal(time.listWarnings({ cwd: f.cwd, milestone: M }).records[0].id, warning.id);
      assert.equal(time.listWarnings({ cwd: f.cwd, milestone: M }).records.length, 1);
      assert(!Object.hasOwn(orchestrate.normalizeInput(f.input), 'time_session'));
      assert(Object.hasOwn(orchestrate.normalizeInput({ ...f.input, time_session: '' }), 'time_session'));
    });
  }
}
if (require.main === module) try { main(); } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
module.exports = { main, fixture, invoke, extend, decision, noContractTrace, optionsOf };
