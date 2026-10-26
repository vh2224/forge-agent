#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, fork } = require('child_process');
const adapter = require('./forge-long-workflow-adapter');
const controller = require('./forge-unit-controller');
const recovery = require('./forge-attempt-recovery');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });

function fixture(host = 'codex', mode = 'auto', executeTask = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-failure-Ω-'));
  const milestone = 'M-20261023000000-failure';
  const dir = path.join(cwd, '.gsd', 'milestones', milestone);
  fs.mkdirSync(dir, { recursive: true });
  state.write(cwd, { milestone, kind: 'milestone', phase: 'idle', active_slice: 'S03', active_task: '—', auto_mode: 'on' });
  const roadmapFile = path.join(dir, `${milestone}-ROADMAP.md`);
  fs.writeFileSync(roadmapFile, '# Roadmap\n- [x] **S01: First** `depends:[]`\n- [x] **S02: Second** `depends:[]`\n- [ ] **S03: Failed** `depends:[S01,S02]`\n- [ ] **S04: Independent** `depends:[S01,S02]`\n- [ ] **S05: Dependent** `depends:[S03]`\n');
  if (executeTask) {
    for (const slice of ['S03', 'S04']) {
      const sliceDir = path.join(dir, 'slices', slice);
      fs.mkdirSync(sliceDir, { recursive: true });
      fs.writeFileSync(path.join(sliceDir, `${slice}-PLAN.md`), '# Plan\n- [ ] **T01: Work**\n');
    }
  }
  const input = { cwd, milestone, workflow_id: 'failure-fixture', owner_token: 'fixture-owner', max_steps: 4 };
  const options = { prefsReader };
  const selected = adapter.invoke(host, mode, 'next', input, null, options).result;
  assert.strictEqual(selected.outcome, 'dispatch_required', JSON.stringify(selected));
  assert.strictEqual(selected.unit.key, executeTask ? 'execute-task/T01' : 'plan-slice/S03');
  const begin = selected.controller_result.details.transaction;
  const request = { cwd, contextRoot: cwd, milestoneId: milestone, sliceId: 'S03', taskId: executeTask ? 'T01' : undefined, scope: 'milestone', phase: executeTask ? 'execute' : 'plan',
    unitType: executeTask ? 'execute-task' : 'plan-slice', roadmapFile, route: { host_runtime: host, resolved_worker_engine: host } };
  const receiptFile = path.join(cwd, 'old-receipt.json');
  const recoveryFile = path.join(cwd, 'old-recovery.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', recovery_identity_sha256: require('./forge-code-roots').digest(recovery.requestIdentity(request)),
    failure: { reason_code: 'claude-timeout', provider_called: 'unknown' } }));
  fs.writeFileSync(recoveryFile, JSON.stringify({ started_at: 100, sidecar_deadline_at: 60100, attempts: [{ reason_code: 'claude-timeout' }] }));
  const f = { cwd, milestone, input, host, mode, selected, begin, request, receiptFile, recoveryFile };
  fs.writeFileSync(path.join(cwd, 'fixture.json'), JSON.stringify(f));
  return f;
}
function liveOptions(f, changes = {}) {
  return { prefsReader, processProbe: () => 'stopped',
    inspectAttempt: () => ({ receipt_path: f.receiptFile, request: f.request, roots: [{ root_id: 'primary', path: f.cwd }],
      pending_questions: [], provenance_gaps: ['historical-root-manifest-missing'] }),
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: f.cwd }] }),
    entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })),
    ...changes };
}
function invoke(f, command, snapshot = f.selected.snapshot, extra = {}, options = liveOptions(f)) {
  return adapter.invoke(f.host, f.mode, command, { ...f.input, ...extra }, snapshot, options).result;
}
function consume(f, options = liveOptions(f)) { return invoke(f, 'consume-failure', f.selected.snapshot, {}, options); }
function entryInput(f, consumed, id = 'fixture-entry-1') {
  return { unit: f.selected.unit, entry: { entry_id: id, failure_key: consumed.controller_result.details.failure_key,
    failure_checksum: consumed.controller_result.details.failure_checksum, authorization_ref: 'conversation:fixture-entry' } };
}
function history(f) {
  return [controller.transactionFile(f.cwd, f.begin.idempotency_key), f.receiptFile, f.recoveryFile].map(file => digest(fs.readFileSync(file)));
}
function cleanup(f) { fs.rmSync(f.cwd, { recursive: true, force: true }); }
function test(name, fn) { fn(); console.log(`ok - ${name}`); }
function restartEntry(f, snapshot, input, answers) {
  const file = path.join(f.cwd, 'restart-entry.json');
  fs.writeFileSync(file, JSON.stringify({ f, snapshot, input, answers }));
  const result = spawnSync(process.execPath, ['-e', `
    const t = require(process.argv[1]), data = JSON.parse(require('fs').readFileSync(process.argv[2]));
    const options = t.liveOptions(data.f);
    if (data.answers) options.questionStateAdapter = ({ previous }) => ({ answers: [
      ...previous.questions.filter(q => q.status === 'resolved').map(q => ({ id: q.id, answer: q.answer })), ...data.answers] });
    process.stdout.write(JSON.stringify(t.invoke(data.f, 'reenter', data.snapshot, data.input, options)));
  `, __filename, file], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function worker(f, operation) {
  const child = fork(__filename, [operation, f.cwd], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${operation}: ${code} ${stderr}`))); });
  const ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  return { child, ready, exited };
}

async function main() {
  test('211: second linked failure reenters through verified ancestors after restart', () => {
    const f = fixture();
    try {
      const first = consume(f);
      const entered = invoke(f, 'reenter', first.snapshot, entryInput(f, first));
      assert.strictEqual(entered.reason_code, 'entry-ready');
      const historical = history(f);
      f.request = recovery.bindLinkedRequest({ ...f.request, linked_begin_key: entered.controller_result.details.transaction.idempotency_key },
        { ...liveOptions(f), ownerToken: f.input.owner_token });
      f.receiptFile = path.join(f.cwd, 'second-receipt.json');
      fs.writeFileSync(f.receiptFile, JSON.stringify({ phase: 'failed', recovery_identity_sha256: require('./forge-code-roots').digest(recovery.requestIdentity(f.request)),
        failure: { reason_code: 'claude-timeout', provider_called: 'unknown' } }));
      const second = invoke(f, 'consume-failure', JSON.parse(JSON.stringify(entered.snapshot)));
      assert.strictEqual(second.reason_code, 'failure-consumed');
      const next = restartEntry(f, second.snapshot, entryInput(f, second, 'second-entry'));
      assert.strictEqual(next.reason_code, 'entry-ready');
      const bound = recovery.bindLinkedRequest({ ...f.request, linked_begin_key: next.controller_result.details.transaction.idempotency_key },
        { ...liveOptions(f), ownerToken: f.input.owner_token });
      assert.notDeepStrictEqual(recovery.requestIdentity(bound), recovery.requestIdentity(f.request));
      assert.strictEqual(digest(fs.readFileSync(controller.transactionFile(f.cwd, f.begin.idempotency_key))), historical[0]);
      assert.strictEqual(digest(fs.readFileSync(path.join(f.cwd, 'old-receipt.json'))), historical[1]);
    } finally { cleanup(f); }
  });
  test('211: current explicit answers survive partial refusal and restart without mutating failure', () => {
    const f = fixture();
    try {
      const questions = [{ id: 'q1', question: 'First?', status: 'pending' }, { id: 'q2', question: 'Second?', status: 'pending' }];
      const options = liveOptions(f);
      const inspect = options.inspectAttempt;
      options.inspectAttempt = () => ({ ...inspect(), pending_questions: questions });
      const consumed = consume(f, options), input = entryInput(f, consumed);
      const file = controller.transactionFile(f.cwd, input.entry.failure_key), before = fs.readFileSync(file);
      const partial = invoke(f, 'reenter', consumed.snapshot, input, liveOptions(f, {
        questionStateAdapter: () => ({ answers: [{ id: 'q1', answer: 'yes' }] })
      }));
      assert.strictEqual(partial.reason_code, 'pending-questions');
      assert.strictEqual(partial.snapshot.pending_questions.find(q => q.id === 'q1').status, 'resolved');
      const done = restartEntry(f, partial.snapshot, input, [{ id: 'q2', answer: 'yes' }]);
      assert.strictEqual(done.reason_code, 'entry-ready');
      assert(done.snapshot.pending_questions.every(q => q.status === 'resolved'));
      assert.deepStrictEqual(fs.readFileSync(file), before);
      const live = liveOptions(f, { questionStateAdapter: ({ previous }) => ({ answers: previous.questions.map(q => ({ id: q.id, answer: q.answer })) }) });
      assert.strictEqual(invoke(f, 'next', done.snapshot, {}, live).reason_code, 'entry-ready');
      const newlyPending = liveOptions(f, { questionStateAdapter: ({ previous }) => ({
        answers: previous.questions.map(q => ({ id: q.id, answer: q.answer })),
        questions: [{ id: 'q3', question: 'New decision?', status: 'resolved', answer: 'forged' }]
      }) });
      const blocked = invoke(f, 'next', done.snapshot, {}, newlyPending);
      assert.strictEqual(blocked.reason_code, 'pending-questions');
      assert.strictEqual(blocked.snapshot.pending_questions.find(q => q.id === 'q3').status, 'pending');
      const answered = liveOptions(f, { questionStateAdapter: ({ previous }) => ({ answers: previous.questions.map(q => ({ id: q.id, answer: q.answer || 'yes' })) }) });
      const resumed = invoke(f, 'next', JSON.parse(JSON.stringify(blocked.snapshot)), {}, answered);
      assert.strictEqual(resumed.reason_code, 'entry-ready');
      assert(resumed.snapshot.pending_questions.every(q => q.status === 'resolved'));
      const observed = liveOptions(f, { ...answered,
        inspectAttempt: () => ({ ...inspect(), pending_questions: [{ id: 'q4', question: 'Observed at dispatch?', status: 'pending' }] }) });
      const waiting = invoke(f, 'next', resumed.snapshot, {}, observed);
      assert.strictEqual(waiting.reason_code, 'pending-questions');
      assert(waiting.snapshot.pending_questions.some(q => q.id === 'q4' && q.status === 'pending'));
      const stillPending = invoke(f, 'next', waiting.snapshot, {}, liveOptions(f, {
        questionStateAdapter: ({ previous }) => ({ answers: previous.questions.filter(q => q.status === 'resolved').map(q => ({ id: q.id, answer: q.answer })) })
      }));
      assert.strictEqual(stillPending.reason_code, 'pending-questions');
      assert.deepStrictEqual(fs.readFileSync(file), before);
    } finally { cleanup(f); }
  });
  test('211: imported flags and invalid answers cannot authorize entry', () => {
    for (const answers of [[], [{ id: 'foreign', answer: 'yes' }], [{ id: 'q', answer: '' }],
      [{ id: 'q', answer: 'yes' }, { id: 'q', answer: 'yes' }]]) {
      const f = fixture();
      try {
        const options = liveOptions(f), inspect = options.inspectAttempt;
        options.inspectAttempt = () => ({ ...inspect(), pending_questions: [{ id: 'q', question: 'Decision?', status: 'pending' }] });
        const consumed = consume(f, options), entry = entryInput(f, consumed);
        const original = fs.readFileSync(controller.transactionFile(f.cwd, entry.entry.failure_key));
        const result = invoke(f, 'reenter', consumed.snapshot, { ...entry, answers: [{ id: 'q', answer: 'yes' }],
          questionStateAdapter: { resolved: true } }, liveOptions(f, {
          questionStateAdapter: () => ({ answers, questions: [{ id: 'q', question: 'Decision?', status: 'resolved', answer: 'yes' }] })
        }));
        assert.strictEqual(result.outcome, 'blocked');
        assert.strictEqual(lease.observe(f.cwd, f.selected.unit.key).lease, null);
        assert.deepStrictEqual(fs.readFileSync(controller.transactionFile(f.cwd, entry.entry.failure_key)), original);
      } finally { cleanup(f); }
    }
  });
  test('211: persisted answers require reattestation and reject scope/path/conflict drift', () => {
    for (const variant of ['no-adapter', 'unattested', 'conflict', 'scope', 'path']) {
      const f = fixture();
      try {
        const options = liveOptions(f), inspect = options.inspectAttempt;
        options.inspectAttempt = () => ({ ...inspect(), pending_questions: [
          { id: 'q1', question: 'First?', status: 'pending' }, { id: 'q2', question: 'Second?', status: 'pending' }] });
        const consumed = consume(f, options), entry = entryInput(f, consumed);
        const partial = invoke(f, 'reenter', consumed.snapshot, entry, liveOptions(f, { questionStateAdapter: () => ({ answers: [{ id: 'q1', answer: 'yes' }] }) }));
        assert.strictEqual(partial.reason_code, 'pending-questions');
        const dir = path.join(f.cwd, '.gsd', 'forge', 'entry-questions'), file = path.join(dir, fs.readdirSync(dir)[0]);
        const saved = fs.readFileSync(file);
        let live = liveOptions(f, { questionStateAdapter: () => ({ answers: [{ id: 'q1', answer: variant === 'conflict' ? 'no' : 'yes' }, { id: 'q2', answer: 'yes' }] }) });
        if (variant === 'no-adapter') live = liveOptions(f);
        if (variant === 'unattested') live.questionStateAdapter = () => ({ answers: [{ id: 'q2', answer: 'yes' }] });
        if (variant === 'scope') { const data = JSON.parse(saved); data.identity_sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(data)); }
        if (variant === 'path') { fs.renameSync(dir, dir + '-original'); fs.symlinkSync(dir + '-original', dir, process.platform === 'win32' ? 'junction' : 'dir'); }
        const result = invoke(f, 'reenter', JSON.parse(JSON.stringify(partial.snapshot)), entry, live);
        assert.strictEqual(result.outcome, 'blocked', variant);
        assert.strictEqual(lease.observe(f.cwd, f.selected.unit.key).lease, null);
        if (variant !== 'scope') assert.deepStrictEqual(fs.readFileSync(file), saved);
      } finally { cleanup(f); }
    }
  });
  test('211: ancestor corruption, foreign scope and loose/cyclic links fail closed', () => {
    for (const variant of ['tamper', 'foreign-owner', 'foreign-roots', 'loose', 'cycle']) {
      const f = fixture();
      try {
        const first = consume(f), entered = invoke(f, 'reenter', first.snapshot, entryInput(f, first));
        const second = invoke(f, 'consume-failure', entered.snapshot), input = entryInput(f, second, 'second');
        const beginKey = entered.controller_result.details.transaction.idempotency_key;
        const begin = controller.lookupRecord(f.cwd, 'transaction', beginKey);
        if (variant === 'tamper') begin.linked_entry.failure_checksum = '0'.repeat(64);
        if (variant === 'foreign-owner') begin.linked_entry.owner_digest = 'foreign';
        if (variant === 'foreign-roots') begin.linked_entry.roots = [];
        if (variant === 'loose') begin.linked_entry.failure_key = 'missing';
        if (variant === 'cycle') begin.linked_entry.failure_key = input.entry.failure_key;
        controller.writeAtomic(controller.transactionFile(f.cwd, beginKey), begin);
        // Keep the terminal begin checksum internally consistent, so this
        // regression reaches lineage validation rather than storage corruption.
        const failure = controller.lookupRecord(f.cwd, 'transaction', input.entry.failure_key);
        failure.terminal_failure.begin_checksum = require('./forge-orchestrate').checksum(begin);
        controller.writeAtomic(controller.transactionFile(f.cwd, input.entry.failure_key), failure);
        input.entry.failure_checksum = require('./forge-orchestrate').checksum(failure);
        const result = invoke(f, 'reenter', second.snapshot, input);
        assert.strictEqual(result.outcome, 'blocked', variant);
        assert(['entry-ancestry-invalid', 'record-conflict'].includes(result.reason_code), result.reason_code);
        assert.strictEqual(lease.observe(f.cwd, f.selected.unit.key).lease, null);
      } finally { cleanup(f); }
    }
  });

  test('consumed T01 failure is scoped to its slice, preserving original recovery gate', () => {
    for (const host of ['codex', 'claude']) {
      const f = fixture(host, 'auto', true);
      try {
        const consumed = consume(f), before = history(f);
        assert.strictEqual(consumed.reason_code, 'failure-consumed');
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S03',
          host_runtime: host, idempotency_key: 'same-slice' }, liveOptions(f)), error => error.code === 'failure-deferred');
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01',
          host_runtime: host, idempotency_key: 'ambiguous-slice' }, liveOptions(f)), error => error.code === 'failure-deferred');
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T02', slice: 'S03',
          host_runtime: host, idempotency_key: 'unresolved-slice' }, liveOptions(f)), error => error.code === 'failure-deferred');
        for (const patch of [undefined, { active_slice: 'S03' }]) {
          assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S04',
            state_patch: patch, host_runtime: host, idempotency_key: 'scope-mismatch' }, liveOptions(f)),
          error => error.code === 'unit-identity-mismatch');
          assert.strictEqual(lease.observe(f.cwd, 'execute-task/T01').lease, null);
        }
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S99',
          state_patch: { active_slice: 'S99' }, host_runtime: host, idempotency_key: 'unknown-slice' }, liveOptions(f)),
        error => error.code === 'failure-deferred');
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S04',
          state_patch: { active_slice: 'S04' }, host_runtime: host, idempotency_key: 'unknown-task' },
        liveOptions(f, { inventoryReader: () => ({ slices: [{ id: 'S04', tasks: [{ id: 'T02' }] }] }) })),
        error => error.code === 'failure-deferred');
        const next = invoke(f, 'next', consumed.snapshot);
        assert.strictEqual(next.reason_code, 'unit-ready');
        assert.strictEqual(next.controller_result.state.active_slice, 'S04');
        assert.strictEqual(next.unit.key, 'execute-task/T01');
        for (const value of [null, '', ' ', '—', false, 0]) {
          assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01',
            state_patch: { active_slice: value }, host_runtime: host, idempotency_key: 'invalid-scope' }, liveOptions(f)),
          error => error.code === 'unit-identity-mismatch');
          assert.strictEqual(controller.lookupRecord(f.cwd, 'transaction', 'invalid-scope'), null);
        }
        assert.deepStrictEqual(history(f), before);
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S03',
          state_patch: { active_slice: 'S03' }, host_runtime: host,
          idempotency_key: next.controller_result.details.transaction.idempotency_key }, liveOptions(f)),
        error => error.code === 'record-conflict');
        const replay = invoke(f, 'next', consumed.snapshot);
        assert.strictEqual(replay.controller_result.details.transaction.idempotency_key,
          next.controller_result.details.transaction.idempotency_key);
        assert.deepStrictEqual(history(f), before);
      } finally { cleanup(f); }
    }
  });
  test('linked recovered task failure does not poison another slice with the same task ID', () => {
    const f = fixture('codex', 'auto', true);
    try {
      const consumed = consume(f), entered = invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed));
      assert.strictEqual(entered.reason_code, 'entry-ready');
      const completed = invoke(f, 'complete', entered.snapshot, { result: { status: 'done' } });
      assert.strictEqual(completed.reason_code, 'transition-committed');
      const before = history(f);
      assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S03',
        host_runtime: f.host, idempotency_key: 'same-linked' }, liveOptions(f)), error => error.code === 'failure-deferred');
      const independent = controller.begin(f.cwd, { ...f.input, unit: 'execute-task/T01', slice: 'S04',
        state_patch: { active_slice: 'S04' }, host_runtime: f.host, idempotency_key: 'independent-linked' }, liveOptions(f));
      assert.strictEqual(independent.ok, true);
      assert.deepStrictEqual(history(f), before);
    } finally { cleanup(f); }
  });
  test('R1: only evidenced terminal failures can be consumed', () => {
    for (const variant of ['started', 'failed-without-reason', 'completed', 'terminal-intent']) {
      const f = fixture();
      try {
        if (variant === 'started' || variant === 'failed-without-reason') {
          const receipt = JSON.parse(fs.readFileSync(f.receiptFile));
          receipt.phase = variant === 'started' ? 'started' : 'failed'; delete receipt.failure;
          fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
        } else {
          const options = liveOptions(f, variant === 'terminal-intent' ? { failpoint: point => point === 'after-intent' } : {});
          try {
            controller.complete(f.cwd, { ...f.input, unit: f.selected.unit, host_runtime: f.host, generation: f.begin.generation,
              idempotency_key: 'durable-completion', result: { status: 'succeeded' } }, options);
          } catch (error) { if (variant !== 'terminal-intent') throw error; }
        }
        const before = history(f), stateBefore = state.read(f.cwd, f.milestone), eventsBefore = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
        const result = consume(f);
        assert.strictEqual(result.reason_code, variant === 'started' || variant === 'failed-without-reason' ? 'terminal-failure-required' : 'terminal-conflict');
        assert.deepStrictEqual(history(f), before);
        assert.deepStrictEqual(state.read(f.cwd, f.milestone), stateBefore);
        assert.deepStrictEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)), eventsBefore);
      } finally { cleanup(f); }
    }
  });
  test('R2: linked reentry revalidates current prerequisite declarations and completion', () => {
    for (const variant of ['pending', 'missing', 'invalid']) {
      const f = fixture();
      try {
        const consumed = consume(f), before = history(f), file = f.request.roadmapFile;
        let roadmap = fs.readFileSync(file, 'utf8');
        roadmap = variant === 'pending' ? roadmap.replace('[x] **S01', '[ ] **S01')
          : roadmap.replace('`depends:[S01,S02]`', variant === 'missing' ? '' : '`depends:[S99]`');
        fs.writeFileSync(file, roadmap);
        assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed)).reason_code, 'dependencies-blocked');
        assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S03').lease, null);
        assert.strictEqual(controller.pendingTransactions(f.cwd).length, 0);
        assert.deepStrictEqual(history(f), before);
      } finally { cleanup(f); }
    }
  });
  test('R3: pre-durable entry errors roll back exactly their own lease; durable intents replay', () => {
    for (const point of ['before-write', 'after-write-before-rename', 'after-rename']) {
      const f = fixture();
      try {
        const consumed = consume(f), entry = entryInput(f, consumed), before = history(f);
        assert.throws(() => invoke(f, 'reenter', consumed.snapshot, entry, liveOptions(f, { failpoint: name => name === point })),
          error => error.code === 'CONTROLLER_FAILPOINT');
        const durable = point === 'after-rename';
        assert.strictEqual(controller.pendingTransactions(f.cwd).length, durable ? 1 : 0);
        assert.strictEqual(!!lease.observe(f.cwd, 'plan-slice/S03').lease, durable);
        assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entry).reason_code, 'entry-ready');
        assert.deepStrictEqual(history(f), before);
      } finally { cleanup(f); }
    }
    const f = fixture();
    try {
      const consumed = consume(f), entry = entryInput(f, consumed);
      let successor;
      assert.throws(() => invoke(f, 'reenter', consumed.snapshot, entry, liveOptions(f, { failpoint: point => {
        if (point !== 'before-write') return false;
        const held = lease.observe(f.cwd, 'plan-slice/S03').lease;
        assert(lease.release(f.cwd, 'plan-slice/S03', f.input.owner_token, held.generation).ok);
        successor = lease.acquire(f.cwd, 'plan-slice/S03', { ownerToken: 'successor', requestId: 'different-request', hostRuntime: f.host });
        return true;
      } })), error => error.code === 'CONTROLLER_FAILPOINT');
      assert(successor.ok);
      assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S03').lease.generation, successor.generation);
      assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entry).reason_code, 'lease-active');
    } finally { cleanup(f); }
  });
  test('R4: legacy pending binding supports next and consume without inventing historical checksum', () => {
    const f = fixture();
    try {
      const binding = f.selected.snapshot.last_decision.controller_result.details.transaction;
      f.selected.snapshot.last_decision.controller_result.details.transaction = { idempotency_key: binding.idempotency_key, phase: binding.phase };
      const before = history(f), legacy = f.selected.snapshot.last_decision.controller_result.details.transaction;
      assert.strictEqual(invoke(f, 'next').outcome, 'dispatch_required');
      assert.strictEqual(Object.hasOwn(legacy, 'begin_checksum'), false);
      for (const checksum of ['b'.repeat(64), null, '']) {
        legacy.begin_checksum = checksum;
        assert.strictEqual(invoke(f, 'next').reason_code, 'unit-identity-mismatch');
        assert.strictEqual(consume(f).reason_code, 'unit-identity-mismatch');
      }
      delete legacy.begin_checksum;
      const consumed = consume(f);
      assert.strictEqual(consumed.reason_code, 'failure-consumed');
      assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed)).reason_code, 'entry-ready');
      assert.deepStrictEqual(history(f), before);
    } finally { cleanup(f); }
    const nextFixture = fixture();
    try {
      const binding = nextFixture.selected.snapshot.last_decision.controller_result.details.transaction;
      nextFixture.selected.snapshot.last_decision.controller_result.details.transaction = { idempotency_key: binding.idempotency_key, phase: binding.phase };
      const consumed = consume(nextFixture), next = invoke(nextFixture, 'next', consumed.snapshot);
      assert.strictEqual(next.outcome, 'dispatch_required');
      assert.strictEqual(next.unit.key, 'plan-slice/S04');
    } finally { cleanup(nextFixture); }
  });
  test('real bridge consumes failure, selects independent slice, and links explicit entry', () => {
    const f = fixture();
    try {
      const before = history(f), consumed = consume(f);
      assert.strictEqual(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
      assert.strictEqual(consumed.snapshot.step_count, 1);
      assert.strictEqual(consumed.lifecycle, 'idle');
      assert.strictEqual(consumed.boundary.kind, 'failed-persisted');
      assert.strictEqual(consumed.boundary.reason_code, 'claude-timeout');
      assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S03').lease, null);
      assert.strictEqual(controller.select(f.cwd, { milestone: f.milestone }, liveOptions(f)).unit.key, 'plan-slice/S04');
      const entered = invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed));
      assert.strictEqual(entered.reason_code, 'entry-ready', JSON.stringify(entered));
      assert.strictEqual(entered.snapshot.step_count, 2);
      const replay = invoke(f, 'reenter', entered.snapshot, entryInput(f, consumed));
      assert.strictEqual(replay.snapshot.step_count, 2);
      const oldReplay = consume(f);
      assert.strictEqual(oldReplay.reason_code, 'failure-consumed');
      assert.ok(lease.observe(f.cwd, 'plan-slice/S03').lease, 'old committed replay preserves successor lease');
      assert.deepStrictEqual(history(f), before);
      const events = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
      assert.strictEqual(events.filter(e => e.action === 'fail').length, 1);
    } finally { cleanup(f); }
  });
  {
    const f = fixture(), outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-linked-output-')),
      xllm = require('./forge-xllm'), sidecar = require('./forge-unit-sidecar'), original = xllm.runPlan;
    try {
      const binding = f.selected.snapshot.last_decision.controller_result.details.transaction;
      f.selected.snapshot.last_decision.controller_result.details.transaction = { idempotency_key: binding.idempotency_key, phase: binding.phase };
      const consumed = consume(f), entered = invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed));
      const before = history(f);
      fs.writeFileSync(path.join(f.cwd, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: { standard: ['claude-sonnet-5'] }, effort: { 'plan-slice': 'medium' } }));
      const promptFile = path.join(outputDir, 'prompt.md');
      fs.writeFileSync(promptFile, 'Fixture only.');
      const request = { ...f.request, promptFile, workflowId: 'failure-fixture', dispatchId: 'linked-transport', resultFile: path.join(outputDir, 'new-result.json'),
        linked_begin_key: entered.controller_result.details.transaction.idempotency_key };
      request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.cwd, hostRuntime: f.host, unitType: 'plan-slice',
        milestoneId: f.milestone, unitId: 'S03', roadmapPath: request.roadmapFile });
      let calls = 0;
      xllm.runPlan = async () => { calls++; throw Object.assign(Error('fixture timeout'), { code: 'claude-timeout', provider_called: true }); };
      const linkedEntryOptions = { ...liveOptions(f), ownerToken: f.input.owner_token };
      await assert.rejects(sidecar.runUnitSidecar(request, { linkedEntryOptions }), error => error.code === 'claude-timeout');
      assert.strictEqual(calls, 1);
      const captured = JSON.parse(fs.readFileSync(`${request.resultFile}.recovery.json`));
      assert.strictEqual(captured.request_identity.linked_entry.classification, 'new-unit');
      assert.strictEqual(captured.request_identity.linked_entry.entry_id, 'fixture-entry-1');
      assert.strictEqual(captured.schema_version, 2);
      assert.strictEqual(captured.budget, 'tier-ceiling');
      for (const key of ['deadline_at', 'budget_remaining_ms', 'clock_high_water', 'migrated_from']) {
        assert.ok(!Object.hasOwn(captured, key), `fresh linked entry must not inherit ${key}`);
      }
      assert.deepStrictEqual(history(f), before);
      await assert.rejects(sidecar.runUnitSidecar({ ...request, dispatchId: 'forged', linkedEntryBinding: {}, entry: { approved: true } }), /authority|required/);
      assert.strictEqual(calls, 1);
      await assert.rejects(sidecar.runUnitSidecar({ ...request, dispatchId: 'new-question' }, { linkedEntryOptions: {
        ...linkedEntryOptions, questionStateAdapter: () => ({ answers: [], questions: [{ id: 'dispatch-q', question: 'New choice?' }] })
      } }), error => error.code === 'pending-questions');
      assert.strictEqual(calls, 1, 'pending functional question must refuse before transport');
      assert.deepStrictEqual(history(f), before);
      console.log('ok - real unit-sidecar validates linked entry before simulated transport and captures fresh identity');
    } finally { xllm.runPlan = original; cleanup(f); fs.rmSync(outputDir, { recursive: true, force: true }); }
  }
  for (const host of ['claude', 'codex']) for (const mode of ['auto', 'task']) test(`${host}/${mode}: absent lease and unknown provenance remain consumable with current proofs`, () => {
    const f = fixture(host, mode);
    try {
      const old = history(f);
      assert(lease.release(f.cwd, 'plan-slice/S03', f.input.owner_token, f.begin.generation).ok);
      const result = consume(f);
      assert.strictEqual(result.reason_code, 'failure-consumed', JSON.stringify(result));
      assert.strictEqual(result.lifecycle, mode === 'task' ? 'failed' : 'idle');
      assert.strictEqual(result.snapshot.step_count, 1);
      assert.deepStrictEqual(history(f), old);
      const terminal = controller.lookupRecord(f.cwd, 'transaction', result.controller_result.details.failure_key);
      assert.strictEqual(terminal.terminal_failure.lease_at_intent, 'proven-absent');
    } finally { cleanup(f); }
  });
  for (const [name, changes, expected] of [
    ['unknown process', { processProbe: () => 'unknown' }, 'process-not-stopped'],
    ['live process', { processProbe: () => 'alive' }, 'process-not-stopped'],
    ['unreconciled root', { reconcileRoots: () => ({ reconciled: false }) }, 'roots-unreconciled'],
    ['missing live adapter', { inspectAttempt: null }, 'failure-inspector-required'],
  ]) test(name, () => {
    const f = fixture();
    try {
      if (name === 'unreconciled root') {
        const receipt = JSON.parse(fs.readFileSync(f.receiptFile)); receipt.execution = {};
        fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
      }
      const before = history(f), result = consume(f, liveOptions(f, changes));
      assert.strictEqual(result.reason_code, expected, JSON.stringify(result));
      assert.deepStrictEqual(history(f), before);
      assert.strictEqual(controller.pendingTransactions(f.cwd).length, 0);
      assert.ok(lease.observe(f.cwd, 'plan-slice/S03').lease);
    } finally { cleanup(f); }
  });
  test('saved candidate goes through original replay before any terminal write', () => {
    const f = fixture();
    try {
      const receipt = JSON.parse(fs.readFileSync(f.receiptFile)); receipt.saved_candidate = { file: 'candidate.json' };
      fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
      let replays = 0;
      const result = consume(f, liveOptions(f, { replaySavedResponse: () => { replays++; } }));
      assert.strictEqual(result.reason_code, 'saved-response-replay-required'); assert.strictEqual(replays, 1);
      assert.strictEqual(controller.pendingTransactions(f.cwd).length, 0);
    } finally { cleanup(f); }
  });
  test('durable identity, receipt identity, successor and corrupt lease fail closed', () => {
    for (const variant of ['snapshot', 'receipt', 'successor', 'corrupt']) {
      const f = fixture();
      try {
        if (variant === 'snapshot') f.selected.snapshot.last_decision.controller_result.details.transaction.begin_checksum = 'b'.repeat(64);
        if (variant === 'receipt') f.request.sliceId = 'S04';
        if (variant === 'successor') {
          lease.release(f.cwd, 'plan-slice/S03', f.input.owner_token, f.begin.generation);
          lease.acquire(f.cwd, 'plan-slice/S03', { ownerToken: 'successor', requestId: 'new', hostRuntime: f.host });
        }
        if (variant === 'corrupt') fs.writeFileSync(lease.leaseFile(f.cwd, 'plan-slice/S03'), '{');
        const result = consume(f);
        assert.notStrictEqual(result.reason_code, 'failure-consumed', variant);
        assert.strictEqual(controller.pendingTransactions(f.cwd).length, 0);
      } finally { cleanup(f); }
    }
  });
  test('pending functional IDs block cached next and survive failure consumption', () => {
    const f = fixture();
    try {
      const base = liveOptions(f), inspect = base.inspectAttempt;
      base.inspectAttempt = arg => ({ ...inspect(arg), pending_questions: [{ id: 'functional-1', question: 'Choose behavior', status: 'pending' }] });
      const next = invoke(f, 'next', f.selected.snapshot, {}, base);
      assert.strictEqual(next.reason_code, 'pending-questions');
      const consumed = consume(f, base);
      assert.strictEqual(consumed.lifecycle, 'blocked');
      assert.strictEqual(consumed.snapshot.pending_questions[0].id, 'functional-1');
      assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed), base).reason_code, 'pending-questions');
    } finally { cleanup(f); }
  });
  test('canonical dependencies diagnose invalid graph while independent slice proceeds', () => {
    const rows = require('./forge-status').parseRoadmap('- [ ] **S01: Missing**\n- [ ] **S02: Empty** `depends:[]`\n- [ ] **S03: Unknown** `depends:[S99]`\n- [ ] **S04: Cycle** `depends:[S05]`\n- [ ] **S05: Cycle** `depends:[S04]`\n- [ ] **S06: Duplicate** `depends:[S02,S02]`\n- [ ] **S07: Bad** `depends:[S02`\n').slices;
    assert.strictEqual(rows[0].dependency_status, 'missing');
    assert.strictEqual(rows[1].dependency_status, 'valid');
    for (const row of rows.slice(2)) assert.strictEqual(row.dependency_status, 'invalid', row.id);
    const choice = controller.selectNextUnit({ state: { milestone: 'M001', active_slice: 'S04' }, prefs: prefsReader().prefs,
      inventory: { roadmap_exists: true, dependency_validation: true, slices: rows } });
    assert.strictEqual(choice.unit.id, 'S02');
    rows[1].checked = true;
    const blocked = controller.selectNextUnit({ state: { milestone: 'M001' }, prefs: prefsReader().prefs,
      inventory: { roadmap_exists: true, dependency_validation: true, slices: rows } });
    assert.strictEqual(blocked.reason, 'units-blocked'); assert.strictEqual(blocked.done, false);
  });
  test('JSON inventory cannot authorize selection or resurrect explicit begin', () => {
    const f = fixture();
    try {
      const consumed = consume(f);
      assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'plan-slice/S03', host_runtime: f.host, idempotency_key: 'arbitrary' }, liveOptions(f)), /reentrada/);
      const json = JSON.parse(JSON.stringify({ ...f.input, inventory: { milestone_complete: true, slices: [] } }));
      const next = require('./forge-orchestrate').run('next', json, liveOptions(f));
      assert.strictEqual(next.unit.key, 'plan-slice/S04');
      assert.strictEqual(consumed.snapshot.step_count, 1);
    } finally { cleanup(f); }
  });
  test('entry authority, baseline, roots, entry_id and max_steps are revalidated', () => {
    const f = fixture();
    try {
      const consumed = consume(f), entry = entryInput(f, consumed);
      const otherHost = f.host === 'codex' ? 'claude' : 'codex';
      assert.throws(() => adapter.invoke(otherHost, f.mode, 'reenter', { ...f.input, ...entry }, consumed.snapshot, liveOptions(f)), error => error.code === 'host-runtime-mismatch');
      assert.throws(() => controller.reenter(f.cwd, { ...f.input, ...entry, host_runtime: otherHost }, liveOptions(f)), error => error.code === 'entry-failure-mismatch');
      assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entry, liveOptions(f, { entryAuthority: {} })).reason_code, 'entry-authority-required');
      const exhausted = { ...consumed.snapshot, max_steps: 1 };
      assert.strictEqual(invoke(f, 'reenter', exhausted, entry).reason_code, 'step-budget-exhausted');
      const entered = invoke(f, 'reenter', consumed.snapshot, entry);
      assert.strictEqual(entered.reason_code, 'entry-ready');
      const changed = liveOptions(f, { captureEntryBaseline: () => ({ sha256: 'b'.repeat(64), roots: [{ root_id: 'primary', path: f.cwd }] }) });
      assert.strictEqual(invoke(f, 'reenter', entered.snapshot, entry, changed).reason_code, 'entry-conflict');
      assert.strictEqual(invoke(f, 'reenter', entered.snapshot, entryInput(f, consumed, 'different')).reason_code, 'entry-conflict');
      const key = entered.controller_result.details.transaction.idempotency_key;
      assert.throws(() => recovery.requestIdentity({ ...f.request, linked_begin_key: key, linkedEntryBinding: {} }), /linked-entry-binding-required/);
      const bound = recovery.bindLinkedRequest({ ...f.request, linked_begin_key: key }, { ...liveOptions(f), ownerToken: f.input.owner_token });
      const fresh = recovery.createRecovery({ unit: 'plan-slice/S03', roots_sha256: 'roots', request: bound, clock: () => 90000 }).snapshot();
      assert.strictEqual(fresh.started_at, 90000);
      assert.strictEqual(fresh.schema_version, 2);
      assert.strictEqual(fresh.budget, 'tier-ceiling');
      assert.ok(!Object.hasOwn(fresh, 'deadline_at'));
      const old = recovery.createRecovery({ unit: 'plan-slice/S03', roots_sha256: 'roots', request: f.request, clock: () => 100 }).snapshot();
      assert.throws(() => recovery.createRecovery({ unit: 'plan-slice/S03', roots_sha256: 'roots', request: bound, state: old, clock: () => 90000 }), /identity-mismatch/);
      const resumed = recovery.createRecovery({ unit: 'plan-slice/S03', roots_sha256: 'roots', request: f.request, state: old, clock: () => 90000 }).snapshot();
      assert.strictEqual(resumed.started_at, 100);
      assert.strictEqual(resumed.schema_version, 2);
      assert.strictEqual(resumed.budget, 'tier-ceiling');
      assert.ok(!Object.hasOwn(resumed, 'deadline_at'));
    } finally { cleanup(f); }
  });
  test('omitted physical code root prevents consumption and complete reconciliation permits it', () => {
    const f = fixture(), code = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-failure-code-'));
    try {
      f.request.cwd = code;
      const options = liveOptions(f), inspect = options.inspectAttempt;
      const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'));
      receipt.recovery_identity_sha256 = require('./forge-code-roots').digest(recovery.requestIdentity(f.request));
      receipt.execution = {};
      fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
      assert.strictEqual(consume(f, options).reason_code, 'roots-unverified');
      options.inspectAttempt = arg => ({ ...inspect(arg), roots: [{ root_id: 'owner', path: f.cwd }, { root_id: 'code', path: code }] });
      const reconciled = [];
      options.reconcileRoots = ({ root }) => { reconciled.push(root.root_id); return { root_id: root.root_id, process_stopped: true, reconciled: true }; };
      const consumed = consume(f, options);
      assert.strictEqual(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
      assert.ok(reconciled.includes('owner') && reconciled.includes('code'));
      assert.strictEqual(invoke(f, 'reenter', consumed.snapshot, entryInput(f, consumed)).reason_code, 'entry-roots-mismatch');
    } finally { cleanup(f); fs.rmSync(code, { recursive: true, force: true }); }
  });
  for (const point of ['after-intent', 'after-result-published', 'after-event-published', 'after-boundary-pending', 'after-state-published', 'after-lease-release-pending', 'after-lease-released', 'after-boundary-ready', 'after-committed']) test(`subprocess crash/restart ${point}`, () => {
    const f = fixture();
    try {
      const before = history(f);
      const child = spawnSync(process.execPath, [__filename, '--consume-worker', f.cwd, point], { encoding: 'utf8', timeout: 15000 });
      assert.strictEqual(child.status, 23, child.stderr || child.stdout);
      if (point !== 'after-committed') {
        assert.throws(() => controller.begin(f.cwd, { ...f.input, unit: 'plan-slice/S04', host_runtime: f.host, idempotency_key: 'during-pending' }, liveOptions(f)), /incompleta|pendente/);
      }
      const result = consume(f);
      assert.strictEqual(result.reason_code, 'failure-consumed', JSON.stringify(result));
      assert.strictEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).filter(row => row.action === 'fail').length, 1);
      assert.deepStrictEqual(history(f), before);
    } finally { cleanup(f); }
  });
  {
    const f = fixture(), held = worker(f, '--guard-worker');
    try {
      await held.ready;
      const lock = require('./forge-lock'), guardName = lease.mutexName('plan-slice/S03');
      const bytes = fs.readFileSync(lock.metaPath(lock.lockPath(f.cwd, guardName)));
      assert.throws(() => lock.acquireProcessSync(f.cwd, guardName, { retries: 1, now: () => Date.now() + 86400000 }), error => error.code === 'LOCK_BUSY');
      assert.strictEqual(lease.recover(f.cwd, 'plan-slice/S03', { now: () => Date.now() + 86400000 }).ok, false);
      assert.strictEqual(lease.acquire(f.cwd, 'plan-slice/S03', { ownerToken: 'racer', requestId: 'racer', hostRuntime: f.host, now: () => Date.now() + 86400000 }).ok, false);
      assert.deepStrictEqual(fs.readFileSync(lock.metaPath(lock.lockPath(f.cwd, guardName))), bytes);
      held.child.stdin.end('release'); await held.exited;
      assert.strictEqual(consume(f).reason_code, 'failure-consumed');
      console.log('ok - IPC barrier protects expired terminal guard from live recovery/acquire');
    } finally { held.child.kill(); cleanup(f); }
  }
  {
    const f = fixture(), a = worker(f, '--race-worker'), b = worker(f, '--race-worker');
    try {
      await Promise.all([a.ready, b.ready]); a.child.stdin.end('go'); b.child.stdin.end('go');
      await Promise.all([a.exited, b.exited]);
      assert.strictEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).filter(row => row.action === 'fail').length, 1);
      assert.strictEqual(lease.observe(f.cwd, 'plan-slice/S03').lease, null);
      console.log('ok - simultaneous IPC consumers publish one terminal result/event');
    } finally { a.child.kill(); b.child.kill(); cleanup(f); }
  }
}

if (require.main === module) {
  if (['--consume-worker', '--guard-worker', '--race-worker'].includes(process.argv[2])) {
    const f = JSON.parse(fs.readFileSync(path.join(process.argv[3], 'fixture.json')));
    if (process.argv[2] === '--guard-worker') {
      lease.withTerminalGuard(f.cwd, 'plan-slice/S03', () => {
        const lock = require('./forge-lock'), file = lock.metaPath(lock.lockPath(f.cwd, lease.mutexName('plan-slice/S03')));
        const meta = JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file, JSON.stringify({ ...meta, renewed_at: 1, ttl_ms: 1 }));
        process.send('held'); fs.readSync(0, Buffer.alloc(20), 0, 20, null);
      });
    } else if (process.argv[2] === '--race-worker') {
      process.send('ready'); fs.readSync(0, Buffer.alloc(20), 0, 20, null);
      assert.strictEqual(consume(f).reason_code, 'failure-consumed');
    } else consume(f, liveOptions(f, { failpoint: point => { if (point === process.argv[4]) process.exit(23); return false; } }));
    if (process.connected) process.disconnect();
  } else main().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { fixture, liveOptions, invoke, consume, entryInput, history, cleanup, main };
