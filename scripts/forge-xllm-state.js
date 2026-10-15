#!/usr/bin/env node
/**
 * Resolve durable xllm state paths. Writes always use the milestone-qualified
 * name; reads retain the two historical names so runs crossing an upgrade live.
 * Exports: canonicalPath, legacyCandidates, resolvePath.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Path contract:
// - taskId is intentionally independent of milestones because it is unique.
// - task paths include milestone when supplied, then slice and task.
// - slice-only paths are Branch D plan-slice state.
// - a missing milestone degrades to the immediately previous format.
// - legacy candidates are read-only and are never selected by write mode.
// - components are sanitized independently, never as a whole path.
// - an empty component never produces a doubled separator.
// - filesystem existence is evaluated in documented precedence order.
// - callers receive only a path on stdout so command substitution is safe.
// - invalid target identity is exit 2, not an uncaught exception.

function clean(value) { return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_'); }
function value(opts, key) { return clean(opts && opts[key]); }
function stateDir(opts) { return opts && opts.dir ? String(opts.dir) : '.'; }
function file(opts, name) { return path.join(stateDir(opts), name); }

function canonicalPath(opts) {
  const taskId = value(opts, 'taskId');
  if (taskId) return file(opts, `xllm-state-${taskId}.json`);
  const slice = value(opts, 'slice');
  const task = value(opts, 'task');
  const milestone = value(opts, 'milestone');
  const attempt = value(opts, 'attempt');
  if (!slice) return '';
  const prefix = milestone ? `${milestone}-` : '';
  if (task) return file(opts, `xllm-state-${prefix}${slice}-${task}-attempt-${attempt}.json`);
  return file(opts, `xllm-state-${prefix}${slice}-attempt-${attempt}.json`);
}

function legacyCandidates(opts) {
  if (value(opts, 'taskId')) return [];
  const slice = value(opts, 'slice');
  const task = value(opts, 'task');
  const attempt = value(opts, 'attempt');
  if (!slice) return [];
  if (task) return [file(opts, `xllm-state-${slice}-${task}-attempt-${attempt}.json`), file(opts, `xllm-state-${task}-attempt-${attempt}.json`)];
  return [file(opts, `xllm-state-${slice}-attempt-${attempt}.json`)];
}

function resolvePath(opts) {
  const canonical = canonicalPath(opts);
  if (opts && opts.mode === 'read') return [canonical].concat(legacyCandidates(opts)).find((candidate) => fs.existsSync(candidate)) || canonical;
  return canonical;
}

function parseArgs(args) {
  const out = { mode: 'write', dir: '.' };
  const fields = { '--mode': 'mode', '--dir': 'dir', '--milestone': 'milestone', '--slice': 'slice', '--task': 'task', '--attempt': 'attempt', '--task-id': 'taskId' };
  for (let i = 0; i < args.length; i += 1) if (fields[args[i]] && args[i + 1] !== undefined) { out[fields[args[i]]] = args[i + 1]; i += 1; }
  return out;
}

// Manual argv parsing is intentional: this helper must stay zero-dependency and
// usable during recovery, before optional packages or project setup exist.
// Unknown flags are ignored for forward compatibility with orchestration prose;
// missing values remain invalid only when they leave us without a target.
// `attempt` is not numerically constrained: it is a path component, and older
// recovery state can contain a string attempt. Sanitization makes it harmless.
// `--mode write` remains the default because state initialization is the common
// operation; every recovery site opts into `--mode read` explicitly.

function runCli(args) {
  const opts = parseArgs(args);
  if (!value(opts, 'taskId') && !value(opts, 'slice')) return 2;
  process.stdout.write(`${resolvePath(opts)}\n`);
  return 0;
}

// Exporting the three small operations keeps the policy testable with fixtures:
// canonicalPath tests naming alone, legacyCandidates tests compatibility alone,
// and resolvePath exercises real disk precedence. This separation is important
// because no shell mirror should duplicate any fallback branch.
// The CLI has no write side effect: it only resolves a path.
// State initialization remains owned by forge-surgical-reset.
// This lets recovery safely ask for a candidate before any reset occurs.

function saveRecovery(file, state) {
  require('./forge-attempt-recovery').validateState(state);
  require('./forge-surgical-reset').writeJsonAtomic(file, state);
  return state;
}
function loadRecovery(file) {
  return require('./forge-attempt-recovery').validateState(JSON.parse(require('fs').readFileSync(file, 'utf8')));
}
module.exports = { canonicalPath, legacyCandidates, resolvePath, parseArgs, runCli, saveRecovery, loadRecovery };
if (require.main === module) process.exit(runCli(process.argv.slice(2)));
