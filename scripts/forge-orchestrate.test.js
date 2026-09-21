#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const orchestrate = require('./forge-orchestrate');
const state = require('./forge-state');

const roots = [];
const milestone = 'M-20260804000000-orchestrate-test';
function temp() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-orchestrate-Ω-')); roots.push(cwd); return cwd; }
function prefsReader() { return { ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }; }
function setup() {
  const cwd = temp();
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', next_action: 'plan', auto_mode: 'off' });
  return cwd;
}
function nextInput(cwd, host) {
  return {
    cwd, milestone, host_runtime: host, owner_token: 'owner-neutral', idempotency_key: 'next-neutral-1', prefsReader,
    inventory: {
      roadmap_exists: true, context_exists: true, research_exists: true,
      slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, summary_exists: false, tasks: [{ id: 'T01', checked: false }] }],
      milestone_complete: false,
    },
  };
}
function withoutVolatile(value) { const copy = JSON.parse(JSON.stringify(value)); delete copy.details?.project_created; return copy; }

try {
  // init writes through forge-state and is byte/idempotency stable on retry.
  const cwd = temp();
  const first = orchestrate.init({ cwd, milestone, host_runtime: 'claude', project: 'Fixture', description: 'fixture project' });
  const second = orchestrate.init({ cwd, milestone, host_runtime: 'codex', project: 'Changed', description: 'ignored on retry' });
  assert.strictEqual(first.protocol_version, '1.0.0');
  assert.deepStrictEqual(first, second);
  assert(fs.existsSync(path.join(cwd, '.gsd', 'milestones', milestone, `${milestone}-STATE.md`)));

  // status is pure-read and omits provider/session metadata.
  const status = orchestrate.status({ cwd, milestone, host_runtime: 'codex', session: 'secret-session' });
  assert.strictEqual(status.reason_code, 'status-ready');
  assert.strictEqual(status.state.milestone, milestone);
  assert(!JSON.stringify(status).includes('secret-session'));

  // The same normalized next input has identical unit/state/event/outcome for both hosts.
  const claude = setup();
  const codex = setup();
  const left = orchestrate.next(nextInput(claude, 'claude'));
  const right = orchestrate.next(nextInput(codex, 'codex'));
  assert.deepStrictEqual(left, right);
  assert.strictEqual(left.outcome, 'completed');
  assert.strictEqual(left.unit.key, 'execute-task/T01');
  assert.strictEqual(left.events[0].event, 'unit-began');

  // A stale active slice is corrected by the same transaction that leases work.
  const advanced = nextInput(setup(), 'codex');
  advanced.inventory.slices.unshift({ id: 'S00', checked: true });
  advanced.inventory.slices[1].id = 'S02';
  const nextSlice = orchestrate.next(advanced);
  assert.strictEqual(nextSlice.unit.key, 'execute-task/T01');
  assert.strictEqual(nextSlice.state.active_slice, 'S02');
  assert.strictEqual(state.read(advanced.cwd, milestone).active_slice, 'S02');

  // Retry after a crash between intent and publication recovers the S02 transaction.
  const crash = setup();
  assert.throws(() => orchestrate.next(nextInput(crash, 'claude'), { failpoint: point => point === 'after-intent' }), /failpoint/);
  const recovered = orchestrate.next(nextInput(crash, 'codex'));
  const repeated = orchestrate.next(nextInput(crash, 'claude'));
  assert.strictEqual(recovered.outcome, 'completed');
  assert.deepStrictEqual(recovered, repeated);
  const eventFile = path.join(crash, '.gsd', 'milestones', milestone, `${milestone}-events.jsonl`);
  const events = fs.readFileSync(eventFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter((item) => item.idempotency_key === 'next-neutral-1');
  assert.strictEqual(events.length, 1);

  // A response without a durable boundary cannot be accepted as a resume.
  const needs = orchestrate.next({ cwd: setup(), milestone, response: { choice: 'x' } });
  assert.strictEqual(needs.outcome, 'blocked');
  assert.strictEqual(needs.reason_code, 'needs-input-boundary');

  // No work is a stable terminal outcome and does not acquire a lease.
  const done = setup();
  const noWork = orchestrate.next({ cwd: done, milestone, owner_token: 'owner-neutral', prefsReader, inventory: { roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S01', checked: true, plan_exists: true, research_exists: true, tasks: [] }], milestone_complete: true } });
  assert.strictEqual(noWork.outcome, 'no_work');
  assert.strictEqual(noWork.reason_code, 'no-next-unit');
  console.log('forge-orchestrate tests passed');
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
