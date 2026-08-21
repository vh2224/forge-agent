#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { consume } = require('./forge-context-boundary');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-boundary-'));
try {
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  const plan = path.join(cwd, '.gsd', 'T01-PLAN.md');
  fs.writeFileSync(plan, '# plan\n');
  const unknown = consume({ appserver: { context_health: { scope: 'sidecar-thread', measurement: 'unknown' },
    context_boundary: { indicator: 'ctx ? compact x1', severity: 'critical', additionalContext: 'invented', checkpoint: true } } }, cwd);
  assert.deepStrictEqual(unknown, { indicator: 'ctx ? compact x1', severity: 'none', additional_context: '', checkpoint_required: false, consumed: false });
  const measured = { appserver: { context_health: { version: 2, host_runtime: 'codex', source: 'codex-app-server', capability: true,
    timestamp: Date.now(), remaining_percentage: 0.38, scope: 'sidecar-thread', measurement: 'measured', session_id: 't/1', epoch: '2' },
    context_boundary: { indicator: 'ctx 62% usado/38% restante compact x2', severity: 'checkpoint', additionalContext: 'checkpoint seguro', checkpoint: true } } };
  const first = consume(measured, cwd, plan);
  assert.strictEqual(first.checkpoint_required, true);
  assert.strictEqual(first.additional_context, 'checkpoint seguro');
  assert(fs.existsSync(path.join(cwd, '.gsd', 'continue.md')), 'safe consumer materializes Continue-Here checkpoint');
  const replay = consume(measured, cwd, plan);
  assert.strictEqual(replay.checkpoint_required, false);
  assert.strictEqual(replay.consumed, false);
  for (const relative of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md', 'shared/forge-dispatch.md']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert(source.includes('--context-root "$WORKING_DIR"'), `${relative} must pass the real context root`);
    assert(source.includes('forge-context-boundary.js'), `${relative} must consume the terminal context boundary`);
    assert(/next (?:safe )?(?:Agent )?boundary|próximo boundary seguro/i.test(source), `${relative} must defer injection to a safe boundary`);
  }
  const resultFile = path.join(os.tmpdir(), `forge-context-result-${process.pid}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(measured));
  const cli = spawnSync(process.execPath, [__filename.replace(/\.test\.js$/, '.js'), '--result', resultFile, '--cwd', cwd, '--plan', plan], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.strictEqual(JSON.parse(cli.stdout).checkpoint_required, false, 'CLI replay observes the same durable consumption marker');
  fs.rmSync(resultFile, { force: true });
  process.stdout.write('forge-context-boundary.test.js: ok\n');
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
