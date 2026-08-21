#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { usableSnapshot } = require('./forge-context-monitor');

function sanitize(value) { return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown'; }
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}
function atomicJson(file, value) { atomicWrite(file, `${JSON.stringify(value)}\n`); }
function unitIdentity(planFile, unit, step, axes = {}) {
  const normalized = planFile ? path.resolve(planFile).replace(/\\/g, '/') : '';
  const milestone = normalized.match(/\/milestones\/(M[^/]+)\//i);
  const slice = normalized.match(/\/slices\/(S[^/]+)\//i);
  const task = normalized.match(/\/tasks\/([^/]+)\//i) || normalized.match(/\/([^/]+)-PLAN\.md$/i);
  return { unit: unit || (task ? `execute-task/${task[1]}` : 'unknown'), milestone: axes.milestone || (milestone && milestone[1]),
    slice: axes.slice || (slice && slice[1]), task: axes.task || (task && task[1]), step: step || 'next-safe-agent-boundary' };
}
function buildScope(identity, options = {}) {
  const loose = !identity.milestone || !identity.slice;
  return { version: 1, kind: loose ? 'task' : 'milestone',
    run: String(options.run || (loose ? identity.task || identity.unit : identity.milestone)),
    milestone: loose ? null : identity.milestone, slice: loose ? null : identity.slice,
    task: identity.task || null, unit: identity.unit };
}
function scopeKey(scope) {
  const canonical = JSON.stringify(scope);
  const label = [scope.kind, scope.run, scope.milestone || '-', scope.slice || '-', scope.unit].map(sanitize).join('__').slice(0, 96);
  return `${label}__${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}
function sameScope(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function checkpointContent(identity, health) {
  const frontmatter = identity.milestone && identity.slice
    ? `---\nmilestone: ${identity.milestone}\nslice: ${identity.slice}\ntask: ${identity.task}\nstep: ${identity.step}\ntotal_steps: unknown\nsaved_at: ${new Date().toISOString()}\n---\n`
    : `---\ntask: ${identity.task}\nstep: ${identity.step}\ntotal_steps: unknown\nsaved_at: ${new Date().toISOString()}\n---\n`;
  return `${frontmatter}\n## Completed Work\n\n- The Codex sidecar reached a terminal poll boundary and persisted its result.\n`
    + '\n## Remaining Work\n\n- Resume the authoritative active plan; this checkpoint does not claim that its remaining steps are complete.\n'
    + '\n## Decisions Made\n\n- Context health is sidecar-scoped. The run was not paused automatically.\n'
    + `- Checkpoint source: Codex sidecar session ${health.session_id}, epoch ${health.epoch}.\n`
    + '\n## Next Action\n\n'
    + `- Continue ${identity.unit} at ${identity.step}, using the active plan as the source of truth.\n`;
}
function checkpointPath(cwd, planFile, identity) {
  if (identity.milestone && identity.slice) return path.join(cwd, '.gsd', 'milestones', identity.milestone, 'slices', identity.slice, 'continue.md');
  return path.join(path.dirname(path.resolve(planFile)), 'continue.md');
}
function pathsFor(cwd, scope, pendingId) {
  const root = path.join(cwd, '.gsd', 'forge', 'context');
  return { pending: path.join(root, 'pending', `${scopeKey(scope)}.json`),
    delivered: path.join(root, 'delivered', `${sanitize(pendingId)}.json`) };
}
function peek(cwd, identity, options) {
  const scope = buildScope(identity, options);
  const file = pathsFor(cwd, scope).pending;
  if (!fs.existsSync(file)) return { pending: false, scope, additional_context: '' };
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!sameScope(record.scope, scope)) return { pending: false, scope, additional_context: '' };
  return { pending: true, scope, pending_id: record.pending_id, additional_context: record.additional_context, pending_file: file };
}
function acknowledge(cwd, identity, options, pendingId) {
  const scope = buildScope(identity, options);
  const files = pathsFor(cwd, scope, pendingId);
  if (!fs.existsSync(files.pending)) return { acknowledged: fs.existsSync(files.delivered), pending: false };
  const record = JSON.parse(fs.readFileSync(files.pending, 'utf8'));
  if (!pendingId || record.pending_id !== pendingId || !sameScope(record.scope, scope)) return { acknowledged: false, pending: true };
  fs.mkdirSync(path.dirname(files.delivered), { recursive: true });
  fs.renameSync(files.pending, files.delivered);
  return { acknowledged: true, pending: false, pending_id: pendingId };
}
function consume(result, cwd, planFile, options = {}) {
  const appserver = result && result.appserver;
  const health = appserver && appserver.context_health;
  const boundary = appserver && appserver.context_boundary;
  const fallback = { indicator: 'ctx ?', severity: 'none', additional_context: '', checkpoint_required: false, consumed: false };
  if (!health || health.scope !== 'sidecar-thread' || !boundary || typeof boundary.indicator !== 'string') return fallback;
  const output = { indicator: boundary.indicator, severity: boundary.severity || 'none',
    additional_context: typeof boundary.additionalContext === 'string' ? boundary.additionalContext : '',
    checkpoint_required: false, consumed: false };
  if (health.measurement !== 'measured' || !usableSnapshot(health)) { output.severity = 'none'; output.additional_context = ''; return output; }
  const identity = unitIdentity(planFile, options.unit, options.step, options);
  const scope = buildScope(identity, options);
  const key = `${scopeKey(scope)}-${sanitize(health.session_id)}-${sanitize(health.epoch)}`;
  const marker = path.join(cwd, '.gsd', 'forge', 'context', 'boundaries', `${key}.json`);
  if (fs.existsSync(marker)) return output;
  if (output.additional_context) {
    const pendingFile = pathsFor(cwd, scope).pending;
    if (!fs.existsSync(pendingFile)) {
      atomicJson(pendingFile, { version: 2, pending_id: key, scope,
        additional_context: output.additional_context, created_at: new Date().toISOString() });
      output.pending_id = key;
    } else {
      const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      if (!pending.additional_context.includes(output.additional_context)) {
        pending.additional_context += `\n\n${output.additional_context}`;
        atomicJson(pendingFile, pending);
      }
      output.pending_id = pending.pending_id;
    }
  }
  if (boundary.checkpoint === true && planFile) {
    const continueFile = checkpointPath(cwd, planFile, identity);
    if (!fs.existsSync(continueFile)) atomicWrite(continueFile, checkpointContent(identity, health));
    output.checkpoint_required = true;
  }
  atomicJson(marker, { version: 3, telemetry_scope: 'sidecar-thread', dispatch_scope: scope, session_id: health.session_id,
    epoch: health.epoch, pending_id: output.pending_id || null, consumed_at: new Date().toISOString() });
  output.consumed = true;
  return output;
}
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return args;
}
module.exports = { acknowledge, buildScope, checkpointContent, checkpointPath, consume, peek, scopeKey, unitIdentity };
if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (typeof args.cwd !== 'string') throw new Error('--cwd is required');
    const cwd = path.resolve(args.cwd);
    const action = args.action || 'consume';
    const identity = unitIdentity(args.plan, args.unit, args.step, args);
    const scopeOptions = { run: args.run };
    if (action === 'peek') process.stdout.write(`${JSON.stringify(peek(cwd, identity, scopeOptions))}\n`);
    else if (action === 'ack') process.stdout.write(`${JSON.stringify(acknowledge(cwd, identity, scopeOptions, args['pending-id']))}\n`);
    else {
      if (typeof args.result !== 'string') throw new Error('--result is required for consume');
      const result = JSON.parse(fs.readFileSync(args.result, 'utf8'));
      process.stdout.write(`${JSON.stringify(consume(result, cwd, args.plan, { unit: args.unit, step: args.step, run: args.run,
        milestone: args.milestone, slice: args.slice, task: args.task }))}\n`);
    }
  } catch (error) { process.stderr.write(`forge-context-boundary: ${error.message}\n`); process.exitCode = 2; }
}
