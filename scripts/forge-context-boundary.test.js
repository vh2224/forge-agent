#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { consume } = require('./forge-context-boundary');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-boundary-'));
const cliFile = __filename.replace(/\.test\.js$/, '.js');
function cli(args) {
  const run = spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
try {
  const planDir = path.join(cwd, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01');
  fs.mkdirSync(planDir, { recursive: true });
  const plan = path.join(planDir, 'T01-PLAN.md');
  fs.writeFileSync(plan, '# plan\n');
  const unknown = consume({ appserver: { context_health: { scope: 'sidecar-thread', measurement: 'unknown' },
    context_boundary: { indicator: 'ctx ? compact x1', severity: 'critical', additionalContext: 'invented', checkpoint: true } } }, cwd);
  assert.deepStrictEqual(unknown, { indicator: 'ctx ? compact x1', severity: 'none', additional_context: '', checkpoint_required: false, consumed: false });
  const measured = { appserver: { context_health: { version: 2, host_runtime: 'codex', source: 'codex-app-server', capability: true,
    timestamp: Date.now(), remaining_percentage: 0.38, scope: 'sidecar-thread', measurement: 'measured', session_id: 't/1', epoch: '2' },
    context_boundary: { indicator: 'ctx 62% used/38% remaining compact x2', severity: 'checkpoint', additionalContext: 'safe checkpoint', checkpoint: true } } };
  const unit = 'execute-task/T01';
  const scopeArgs = ['--run', 'run-a', '--milestone', 'M001', '--slice', 'S01', '--task', 'T01', '--unit', unit];
  const first = consume(measured, cwd, plan, { run: 'run-a', unit, step: 'post-sidecar-poll' });
  assert.strictEqual(first.checkpoint_required, true);
  const continueFile = path.join(cwd, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'continue.md');
  const checkpoint = fs.readFileSync(continueFile, 'utf8');
  for (const value of ['milestone: M001', 'slice: S01', 'task: T01', 'step: post-sidecar-poll', 'total_steps:', 'saved_at:',
    '## Completed Work', '## Remaining Work', '## Decisions Made', '## Next Action']) assert(checkpoint.includes(value), value);
  assert.strictEqual(path.dirname(continueFile), path.join(cwd, '.gsd', 'milestones', 'M001', 'slices', 'S01'), 'resume lookup uses canonical slice path');

  // A richer canonical resume document is user/orchestrator state and must remain byte-identical.
  const richPlanDir = path.join(cwd, '.gsd', 'milestones', 'M002', 'slices', 'S02', 'tasks', 'T02');
  fs.mkdirSync(richPlanDir, { recursive: true });
  const richPlan = path.join(richPlanDir, 'T02-PLAN.md');
  const richContinue = '# Continue Here\n\n## Completed Work\n\n- detailed state\n\n## Remaining Work\n\n- exact item\n\n## Decisions Made\n\n- keep\n\n## Next Action\n\n- resume exact command\n';
  const richContinueFile = path.join(cwd, '.gsd', 'milestones', 'M002', 'slices', 'S02', 'continue.md');
  fs.writeFileSync(richPlan, '# plan\n'); fs.writeFileSync(richContinueFile, richContinue);
  const distinct = JSON.parse(JSON.stringify(measured)); distinct.appserver.context_health.session_id = 't/2';
  consume(distinct, cwd, richPlan, { run: 'run-b', unit: 'execute-task/T02', step: 'post-sidecar-poll' });
  assert.strictEqual(fs.readFileSync(richContinueFile, 'utf8'), richContinue);

  // Loose tasks keep their separately resumable task checkpoint and never masquerade as a slice.
  const looseDir = path.join(cwd, '.gsd', 'tasks', 'T-loose');
  const loosePlan = path.join(looseDir, 'T-loose-PLAN.md'); fs.mkdirSync(looseDir, { recursive: true }); fs.writeFileSync(loosePlan, '# plan\n');
  const looseMeasured = JSON.parse(JSON.stringify(measured)); looseMeasured.appserver.context_health.session_id = 'loose';
  consume(looseMeasured, cwd, loosePlan, { run: 'T-loose', unit: 'execute-task/T-loose', step: 'post-sidecar-poll' });
  const looseCheckpoint = fs.readFileSync(path.join(looseDir, 'continue.md'), 'utf8');
  assert(looseCheckpoint.includes('task: T-loose')); assert(!looseCheckpoint.includes('milestone:'));

  // Cross-process pending context is retry-safe: peek is non-destructive, wrong ack cannot clear it,
  // and a matching ack atomically moves it to the delivered ledger.
  const peek1 = cli(['--action', 'peek', '--cwd', cwd, ...scopeArgs]);
  assert.strictEqual(peek1.additional_context, 'safe checkpoint');
  // Repeated T01 in another run/milestone cannot see or acknowledge run-a's record.
  const foreign = ['--run', 'run-x', '--milestone', 'M009', '--slice', 'S01', '--task', 'T01', '--unit', unit];
  assert.strictEqual(cli(['--action', 'peek', '--cwd', cwd, ...foreign]).pending, false);
  assert.strictEqual(cli(['--action', 'ack', '--cwd', cwd, ...foreign, '--pending-id', peek1.pending_id]).acknowledged, false);
  const originalRecord = fs.readFileSync(peek1.pending_file, 'utf8');
  const tampered = JSON.parse(originalRecord); tampered.scope.run = 'run-x'; fs.writeFileSync(peek1.pending_file, `${JSON.stringify(tampered)}\n`);
  assert.strictEqual(cli(['--action', 'peek', '--cwd', cwd, ...scopeArgs]).pending, false, 'stored scope must match exactly');
  assert.strictEqual(cli(['--action', 'ack', '--cwd', cwd, ...scopeArgs, '--pending-id', peek1.pending_id]).acknowledged, false);
  fs.writeFileSync(peek1.pending_file, originalRecord);
  assert.strictEqual(cli(['--action', 'ack', '--cwd', cwd, ...scopeArgs, '--pending-id', 'wrong']).acknowledged, false);
  assert.strictEqual(cli(['--action', 'peek', '--cwd', cwd, ...scopeArgs]).pending, true);
  assert.strictEqual(cli(['--action', 'ack', '--cwd', cwd, ...scopeArgs, '--pending-id', peek1.pending_id]).acknowledged, true);
  assert.strictEqual(cli(['--action', 'peek', '--cwd', cwd, ...scopeArgs]).pending, false);
  assert.strictEqual(cli(['--action', 'ack', '--cwd', cwd, ...scopeArgs, '--pending-id', peek1.pending_id]).acknowledged, true);

  const resultFile = path.join(os.tmpdir(), `forge-context-result-${process.pid}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(measured));
  assert.strictEqual(cli(['--result', resultFile, '--cwd', cwd, '--plan', plan, ...scopeArgs]).consumed, false);
  fs.rmSync(resultFile, { force: true });
  for (const relative of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md', 'shared/forge-dispatch.md']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert(source.includes('--action peek'), `${relative} must retrieve durable pending context`);
    assert(source.includes('--action ack'), `${relative} must acknowledge only after handoff`);
    assert(source.includes('PENDING_CONTEXT_FILE'), `${relative} must carry the durable pending path`);
    assert(source.includes('--pending-context-file'), `${relative} must splice pending context into the rendered prompt artifact`);
    assert(source.includes('--run'), `${relative} must scope pending context by run`);
    assert(source.includes('--task'), `${relative} must scope pending context by task`);
    if (relative !== 'skills/forge-task/SKILL.md') {
      assert(source.includes('--milestone') && source.includes('--slice'), `${relative} must scope milestone tasks by both axes`);
    }
  }
  assert(fs.readFileSync(path.join(__dirname, '..', 'skills/forge-task/SKILL.md'), 'utf8')
    .includes('read `.gsd/tasks/{TASK_ID}/continue.md` when present'), 'loose-task resume lookup reads its checkpoint');
  process.stdout.write('forge-context-boundary.test.js: ok\n');
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
