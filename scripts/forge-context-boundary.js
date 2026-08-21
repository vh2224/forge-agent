#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { usableSnapshot } = require('./forge-context-monitor');

function sanitize(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown';
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function consume(result, cwd, planFile) {
  const appserver = result && result.appserver;
  const health = appserver && appserver.context_health;
  const boundary = appserver && appserver.context_boundary;
  const fallback = { indicator: 'ctx ?', severity: 'none', additional_context: '', checkpoint_required: false, consumed: false };
  if (!health || health.scope !== 'sidecar-thread' || !boundary || typeof boundary.indicator !== 'string') return fallback;
  const output = { indicator: boundary.indicator, severity: boundary.severity || 'none',
    additional_context: typeof boundary.additionalContext === 'string' ? boundary.additionalContext : '',
    checkpoint_required: false, consumed: false };
  if (health.measurement !== 'measured' || !usableSnapshot(health)) {
    output.severity = 'none'; output.additional_context = '';
  }
  if (boundary.checkpoint === true && health.measurement === 'measured') {
    const key = `${sanitize(health.session_id)}-${sanitize(health.epoch)}`;
    const marker = path.join(cwd, '.gsd', 'forge', 'context', 'boundaries', `${key}.json`);
    if (!fs.existsSync(marker)) {
      if (planFile) {
        const resolvedPlan = path.resolve(planFile);
        const continueFile = path.join(path.dirname(resolvedPlan), 'continue.md');
        const content = '# Continue Here\n\n'
          + 'Checkpoint seguro solicitado pelo monitor de contexto da thread sidecar Codex.\n\n'
          + `- Session: ${health.session_id}\n- Epoch: ${health.epoch}\n- Scope: sidecar-thread\n`
          + '- A run não foi pausada automaticamente; retome no próximo boundary seguro.\n';
        fs.writeFileSync(`${continueFile}.tmp`, content, 'utf8');
        fs.renameSync(`${continueFile}.tmp`, continueFile);
      }
      atomicJson(marker, { version: 1, scope: 'sidecar-thread', session_id: health.session_id,
        epoch: health.epoch, consumed_at: new Date().toISOString() });
      output.checkpoint_required = true;
      output.consumed = true;
    }
  }
  return output;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return args;
}

module.exports = { consume };

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (typeof args.result !== 'string' || typeof args.cwd !== 'string') throw new Error('--result and --cwd are required');
    const result = JSON.parse(fs.readFileSync(args.result, 'utf8'));
    process.stdout.write(`${JSON.stringify(consume(result, path.resolve(args.cwd), args.plan))}\n`);
  } catch (error) {
    process.stderr.write(`forge-context-boundary: ${error.message}\n`);
    process.exitCode = 2;
  }
}
