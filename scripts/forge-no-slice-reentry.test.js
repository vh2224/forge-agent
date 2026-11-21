'use strict';

// Synthetic host observations; real controller transactions, no provider calls.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const legacy = require('./forge-loop-failure.test');
const adapter = require('./forge-long-workflow-adapter');
const state = require('./forge-state');
const recovery = require('./forge-attempt-recovery');
const roots = require('./forge-code-roots');
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });

function fixture(host) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-no-slice-reentry-'));
  const milestone = 'M-20261119150000-no-slice-reentry';
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, phase: 'idle', active_slice: '\u2014', active_task: '\u2014', auto_mode: 'off' });
  const input = { cwd, milestone, workflow_id: 'no-slice-fixture', owner_token: 'fixture-owner', max_steps: 4 };
  const selected = adapter.invoke(host, 'auto', 'next', input, null, { prefsReader }).result;
  assert.equal(selected.outcome, 'dispatch_required');
  assert.equal(selected.unit.type, 'plan-milestone');
  const request = { cwd, contextRoot: cwd, milestoneId: milestone, scope: 'milestone', phase: 'plan',
    unitType: 'plan-milestone', route: { host_runtime: host, resolved_worker_engine: host } };
  const receiptFile = path.join(cwd, 'failed-receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed',
    recovery_identity_sha256: roots.digest(recovery.requestIdentity(request)),
    failure: { reason_code: 'fixture-invalid-result', provider_called: 'unknown' } }));
  return { cwd, milestone, input, host, mode: 'auto', selected, request, receiptFile,
    begin: selected.controller_result.details.transaction };
}

function cleanup(f) {
  const target = fs.realpathSync.native(f.cwd), temporary = fs.realpathSync.native(os.tmpdir());
  assert.equal(path.dirname(target).toLowerCase(), temporary.toLowerCase());
  assert(path.basename(target).startsWith('forge-no-slice-reentry-'));
  legacy.cleanup(f);
}

let passed = 0;
for (const host of ['codex', 'claude']) {
  const f = fixture(host);
  try {
    const consumed = legacy.consume(f);
    assert.equal(consumed.reason_code, 'failure-consumed');
    const entered = legacy.invoke(f, 'reenter', consumed.snapshot, legacy.entryInput(f, consumed));
    assert.equal(entered.outcome, 'dispatch_required', JSON.stringify(entered));
    assert.equal(entered.unit.type, 'plan-milestone');
    assert.notEqual(entered.controller_result.details.transaction.generation, f.begin.generation);
    const replay = legacy.invoke(f, 'reenter', entered.snapshot, legacy.entryInput(f, consumed));
    assert.equal(replay.reason_code, 'entry-ready');
    assert.equal(replay.snapshot.step_count, entered.snapshot.step_count);
    passed++;
    console.log(`ok - ${host}: no-slice failure reenters idempotently with a fresh generation`);
  } finally { cleanup(f); }

  const rejected = fixture(host);
  try {
    const consumed = legacy.consume(rejected), input = legacy.entryInput(rejected, consumed);
    const wrongOwner = legacy.invoke(rejected, 'reenter', consumed.snapshot, { ...input, owner_token: 'foreign-owner' });
    assert.equal(wrongOwner.reason_code, 'entry-failure-mismatch');
    const other = path.join(rejected.cwd, 'other-root'); fs.mkdirSync(other);
    const wrongRoot = legacy.invoke(rejected, 'reenter', consumed.snapshot, input, legacy.liveOptions(rejected, {
      captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: [{ root_id: 'primary', path: other }] }),
    }));
    assert.equal(wrongRoot.reason_code, 'entry-roots-mismatch');
    passed++;
    console.log(`ok - ${host}: no-slice normalization retains owner and physical-root checks`);
  } finally { cleanup(rejected); }

  const pending = fixture(host);
  try {
    const base = legacy.liveOptions(pending);
    const consumed = legacy.consume(pending, { ...base, inspectAttempt: () => ({ ...base.inspectAttempt(),
      pending_questions: [{ id: 'required-fixture-decision', question: 'Choose the fixture behavior', status: 'pending' }] }) });
    assert.equal(consumed.reason_code, 'failure-consumed');
    const entered = legacy.invoke(pending, 'reenter', consumed.snapshot, legacy.entryInput(pending, consumed));
    assert.equal(entered.reason_code, 'pending-questions');
    passed++;
    console.log(`ok - ${host}: no-slice reentry preserves unanswered decisions`);
  } finally { cleanup(pending); }
}
console.log(JSON.stringify({ passed, provider_calls: 0 }));
