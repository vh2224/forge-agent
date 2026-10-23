#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const loop = require('./forge-loop-controller.js');
const state = require('./forge-state.js');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'long-workflows', 'platform-vectors.json'), 'utf8'));
const roots = [];
const milestone = 'M-20260804000000-loop-test';
function temp(platform, host) { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `forge-loop-${platform}-${host}-Ω-`)); roots.push(cwd); return cwd; }
function prefsReader() { return { ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }; }
function setup(platform, host) {
  const cwd = path.join(temp(platform, host), vectors.path_suffix); fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', next_action: 'plan', auto_mode: 'off' });
  return cwd;
}
function input(cwd, owner = 'owner-neutral', key = 'loop-neutral-1') {
  return {
    cwd, milestone, owner_token: owner, idempotency_key: key, prefsReader,
    description: vectors.crlf_description,
    inventory: {
      roadmap_exists: true, context_exists: true, research_exists: true,
      slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, summary_exists: false, tasks: [{ id: 'T01', checked: false }] }],
      milestone_complete: false,
    },
  };
}

try {
  {
    const f = require('./forge-loop-failure.test').fixture();
    try {
      const held = require('./forge-unit-lease');
      assert(held.release(f.cwd, f.selected.unit.key, f.input.owner_token, f.begin.generation).ok);
      const repeated = loop.advance(f.selected.snapshot, 'next', { ...f.input, host_runtime: f.host });
      assert.strictEqual(repeated.reason_code, 'lease-owner-mismatch');
      assert.strictEqual(repeated.snapshot.step_count, 1);
    } finally { require('./forge-loop-failure.test').cleanup(f); }
  }
  let cases = 0;
  for (const platform of vectors.platforms) for (const host of vectors.hosts) {
    cases += 1;
    const cwd = setup(platform, host);
    const initial = loop.create({ mode: 'auto', workflow_id: `${platform}-${host}`, host_runtime: host, max_steps: 3 });
    const first = loop.advance(initial, 'next', input(cwd));
    assert.strictEqual(first.outcome, 'dispatch_required');
    assert.strictEqual(first.action, 'dispatch');
    assert.strictEqual(first.unit.key, 'execute-task/T01');
    assert.strictEqual(first.snapshot.step_count, 1);
    assert.strictEqual(first.host_runtime, host);
    const repeated = loop.advance(first.snapshot, 'next', input(cwd));
    assert.deepStrictEqual(repeated, first, `${platform}/${host} retry is idempotent`);

    const paused = loop.advance(first.snapshot, 'pause', input(cwd));
    assert.strictEqual(paused.outcome, 'needs_input');
    assert.strictEqual(paused.lifecycle, 'paused');
    assert(paused.boundary && paused.boundary.idempotency_key);
    const resumed = loop.advance(paused.snapshot, 'resume', { ...input(cwd), host_runtime: host === 'claude' ? 'codex' : 'claude', response: { choice: 'continue' } });
    assert.strictEqual(resumed.outcome, 'resumed');
    assert.strictEqual(resumed.lifecycle, 'idle');
    assert.strictEqual(resumed.host_runtime, host === 'claude' ? 'codex' : 'claude');
    assert.strictEqual(JSON.stringify(resumed).includes(vectors.crlf_description), false);
  }
  assert.strictEqual(cases, 6);

  // A second owner cannot convert an active lease into a new dispatch.
  const contested = setup('win32', 'claude');
  const ownerA = loop.advance(loop.create({ mode: 'auto', workflow_id: 'lease-a', host_runtime: 'claude' }), 'next', input(contested, 'owner-a', 'lease-a'));
  assert.strictEqual(ownerA.outcome, 'dispatch_required');
  const ownerB = loop.advance(loop.create({ mode: 'auto', workflow_id: 'lease-b', host_runtime: 'codex' }), 'next', input(contested, 'owner-b', 'lease-b'));
  assert.strictEqual(ownerB.outcome, 'blocked');
  assert.strictEqual(ownerB.reason_code, 'lease-active');

  // Task mode over a MILESTONE unit: the same controller with a one-unit budget
  // and terminal resume. `input()` supplies a milestone and a milestone-shaped
  // inventory, so this covers the budget/terminal semantics only — never a
  // standalone task. That gap is what let the missing selection path ship green;
  // the block further below is what actually exercises it.
  const taskCwd = setup('darwin', 'codex');
  const task = loop.advance(loop.create({ mode: 'task', workflow_id: 'task-one', host_runtime: 'codex' }), 'pause', input(taskCwd, 'task-owner', 'task-one'));
  assert.strictEqual(task.lifecycle, 'paused');
  const taskDone = loop.advance(task.snapshot, 'resume', { ...input(taskCwd, 'task-owner', 'task-one'), response: { value: 'done' } });
  assert.strictEqual(taskDone.lifecycle, 'completed');
  assert.strictEqual(taskDone.action, 'stop');
  assert.strictEqual(loop.advance(taskDone.snapshot, 'next', input(taskCwd)).reason_code, 'workflow-terminal');

  // A STANDALONE task (no milestone) has no selectable unit in this layer and is
  // refused by name — not by a generic invalid-request thrown from the delegate.
  const looseCwd = setup('linux', 'claude');
  const loose = { cwd: looseCwd, owner_token: 'loose-owner', idempotency_key: 'loose-1', prefsReader };
  const refused = loop.advance(loop.create({ mode: 'task', workflow_id: 'loose-task', host_runtime: 'claude' }), 'next', loose);
  assert.strictEqual(refused.outcome, 'blocked');
  assert.strictEqual(refused.reason_code, 'task-scope-unsupported');
  assert.strictEqual(refused.action, 'stop');
  assert.strictEqual(refused.unit, null);
  assert.strictEqual(refused.controller_result, null, 'refusal must never reach forge-orchestrate');
  // The request is refused, the workflow is untouched: no transition, no step
  // consumed, and a repeat answers identically instead of decaying to terminal.
  assert.strictEqual(refused.lifecycle, 'idle');
  assert.strictEqual(refused.snapshot.step_count, 0);
  assert.deepStrictEqual(loop.advance(refused.snapshot, 'next', loose), refused);
  assert.strictEqual(loop.advance(loop.create({ mode: 'task', workflow_id: 'loose-pause', host_runtime: 'claude' }), 'pause', loose).reason_code, 'task-scope-unsupported');
  // Nothing durable may be written for a request that was never delegated.
  for (const dir of ['leases', 'transactions', 'boundaries', 'results']) {
    assert.strictEqual(fs.existsSync(path.join(looseCwd, '.gsd', 'forge', dir)), false, `refusal must not write .gsd/forge/${dir}`);
  }
  // `auto` deliberately keeps throwing: there a milestone always exists, so its
  // absence is a caller bug. Asserted so nobody quiets it for symmetry.
  assert.throws(() => loop.advance(loop.create({ mode: 'auto', workflow_id: 'auto-no-milestone', host_runtime: 'claude' }), 'next', loose), (error) => error.code === 'invalid-request');
  // Positive control: the guard must not blanket-refuse task mode. A task unit
  // scoped to a milestone still dispatches exactly as before.
  const scopedCwd = setup('win32', 'codex');
  const scoped = loop.advance(loop.create({ mode: 'task', workflow_id: 'scoped-task', host_runtime: 'codex' }), 'next', input(scopedCwd, 'scoped-owner', 'scoped-1'));
  assert.strictEqual(scoped.outcome, 'dispatch_required');
  assert.strictEqual(scoped.unit.key, 'execute-task/T01');

  assert.throws(() => loop.advance(loop.create({ mode: 'auto', workflow_id: 'host-lock', host_runtime: 'claude' }), 'next', { ...input(setup('linux', 'claude')), host_runtime: 'codex' }), (error) => error.code === 'host-runtime-mismatch');
  assert.throws(() => loop.create({ mode: 'unknown', workflow_id: 'bad', host_runtime: 'claude' }), (error) => error.code === 'invalid-mode');

  const source = fs.readFileSync(path.join(__dirname, 'forge-loop-controller.js'), 'utf8');
  assert.strictEqual(/child_process|\bspawn(?:Sync)?\s*\(/.test(source), false, 'controller must not spawn');
  console.log(`forge-loop-controller tests passed (${cases} host/platform vectors)`);
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
