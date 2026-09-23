#!/usr/bin/env node
// forge-cli-helpers — Shared helpers for /forge-auto, /forge-next, /forge-task
//
// Centralizes the multi-run CLI logic: arg parsing, active-run checking, refuse messages,
// run registration. Used by the orchestrator skills to avoid duplicating bash.
//
// Library exports:
//   resolveRunFromArgs(cwd, args, opts) → { run_id, kind, status, message }
//   listActiveSummary(cwd) → string (multi-line, formatted for user)
//   newTaskId(description, cwd) → string (T-<ts>-<slug> or TASK-00N per ids.format pref)
//   refuseMessage(activeRuns, command) → string
//   activateRun(cwd, opts) → registered RunRecord
//
// CLI:
//   node forge-cli-helpers.js --resolve-args --args "M065" [--cwd <path>]
//   node forge-cli-helpers.js --resolve-args --args "M-20260522143012-oauth" [--cwd <path>]
//   node forge-cli-helpers.js --list-active-summary [--cwd <path>]
//   node forge-cli-helpers.js --new-task-id --description "fix typo"

'use strict';

const path  = require('path');
const runs  = require('./forge-runs.js');
const ids   = require('./forge-ids.js');
const personal = require('./forge-personal-context');


// ── ID generation ───────────────────────────────────────────────────────────
// newTaskId delegates to forge-ids.js — no local slugify or crypto needed.
// Honors the `ids.format` pref (timestamp | sequential) via resolveTaskId.
function newTaskId(description, cwd) {
  return ids.resolveTaskId(cwd || process.cwd(), description || 'task');
}

// ── Arg resolution ──────────────────────────────────────────────────────────
// Input: raw argument string (e.g. "M065", "M-20260522143012-oauth",
//        "T-20260522143012-fix-typo", "task-fix-foo-a3f2", "", "resume")
// Output:
//   { run_id, kind: "milestone"|"task"|null, status: "ok"|"refuse"|"activate-new"|"resume"|"error"|"none", message }
function resolveRunFromArgs(cwd, argsRaw, opts) {
  const arg = String(argsRaw || '').trim();
  if (arg && ids.isValid(arg)) {
    const inspection = personal.readPersonalSnapshot({ ...opts, cwd, id: arg, inspect: true });
    if (inspection.status !== 'ok') return { run_id: null, kind: null, status: 'error', reason: inspection.reason, message: inspection.message || inspection.reason };
    return { ...resolveRunInProject(inspection.project, argsRaw, opts), project: inspection.project };
  }
  return resolveRunInProject(cwd, argsRaw, opts);
}

function resolveRunInProject(cwd, argsRaw, opts) {
  opts = opts || {};
  const arg = String(argsRaw || '').trim();

  // Direct ID arg
  if (arg) {
    // Validate the ID using forge-ids.js — handles both legacy and timestamp formats
    if (!ids.isValid(arg)) {
      return {
        run_id: null,
        kind: null,
        status: 'error',
        message: `Argumento "${arg}" não reconhecido. Use M###, M-<ts>..., TASK-### ou T-<ts>...`,
      };
    }

    const kind = ids.entityKind(arg);

    if (kind === 'milestone') {
      // Normalize lookup key: legacy IDs upper-case (existing behavior preserved);
      // timestamp IDs used verbatim — slug is lowercase, must NOT be upper-cased.
      const lookupId = ids.classify(arg) === 'legacy' ? arg.toUpperCase() : arg;
      const existing = runs.get(cwd, lookupId);
      if (existing && existing.active) {
        return { run_id: lookupId, kind: 'milestone', status: 'resume', message: `Retomando run ativa: ${lookupId}` };
      }
      return { run_id: lookupId, kind: 'milestone', status: 'activate-new', message: `Iniciando run: ${lookupId}` };
    }

    if (kind === 'task') {
      // Task lookup is format-agnostic — registry key is the ID string as-is
      const existing = runs.get(cwd, arg);
      if (existing && existing.active) {
        return { run_id: arg, kind: 'task', status: 'resume', message: `Retomando task run: ${arg}` };
      }
      return { run_id: null, kind: null, status: 'error', message: `Task ID "${arg}" não encontrado no registry.` };
    }

    // Neither milestone nor task. Reached by kind === 'item' (I-<ts>-<slug> work
    // items are valid IDs but are not runnable units — item commands live in
    // forge-items.js), and by kind === 'unknown' if a future ID shape validates
    // without a kind. Both error out gracefully here — never treated as a run.
    return { run_id: null, kind: null, status: 'error', message: `Argumento "${arg}" não reconhecido. Use M###, M-<ts>..., TASK-### ou T-<ts>...` };
  }

  const selection = personal.selectPersonalWork({ ...opts, cwd });
  if (selection.selected) return { run_id: selection.selected.id, kind: selection.selected.kind, project: selection.project, status: 'resume', reason: selection.reason, message: `Retomando trabalho pessoal: ${selection.selected.id}` };
  return { run_id: null, kind: null, status: selection.status === 'error' ? 'error' : selection.reason === 'selection-required' ? 'refuse' : 'none',
    reason: selection.reason, candidates: selection.candidates || [], message: selection.message || `Contexto pessoal: ${selection.reason}. Especifique um ID para retomada explícita.` };
}

function refuseMessage(activeRuns, command) {
  const lines = [
    `Múltiplas runs ativas (${activeRuns.length}). Especifique um ID:`,
    '',
  ];
  for (const r of activeRuns) {
    const worker = r.worker ? ` · ${r.worker.split('/').pop()}` : '';
    const desc = r.kind === 'task' && r.task_description
      ? ` — "${r.task_description.slice(0, 40)}…"`
      : '';
    lines.push(`  - ${r.id} (${r.kind})${worker}${desc}`);
  }
  lines.push('');
  lines.push(`Exemplos:`);
  lines.push(`  /${command} ${activeRuns[0].id}`);
  if (activeRuns.length > 1) lines.push(`  /${command} ${activeRuns[1].id}`);
  return lines.join('\n');
}

function listActiveSummary(cwd) {
  const active = runs.listActive(cwd);
  if (active.length === 0) return '(no active runs)';
  return active.map(r => {
    const age = Math.round((Date.now() - r.last_heartbeat) / 1000);
    const worker = r.worker || '—';
    return `${r.id}\t${r.kind}\t${worker}\t${age}s ago\t${r.isolation_mode}`;
  }).join('\n');
}

// ── Activate (register) a new run ──────────────────────────────────────────
function activateRun(cwd, opts) {
  if (!opts.id || !opts.kind || !opts.session_id) {
    throw new Error('activateRun: id, kind, session_id required');
  }
  const record = runs.add(cwd, {
    id: opts.id,
    kind: opts.kind,
    session_id: opts.session_id,
    active: true,
    isolation_mode: opts.isolation_mode || 'shared',
    milestone_dir: opts.kind === 'milestone' ? `.gsd/milestones/${opts.id}/` : null,
    cwd: opts.cwd || cwd,
    task_description: opts.task_description,
    worktrees: opts.worktrees,
    branch: opts.branch,
  });
  const binding = personal.bindWork({ ...opts, project: cwd, intent: opts.intent || 'create' });
  if (binding.status !== 'ok') return { status: 'partial', reason: 'personal-bind-failed', id: opts.id, record, binding,
    message: `Run ${opts.id} criada; vínculo pessoal falhou (${binding.reason}). Recupere com forge-personal-context.js --bind --project <WORKING_DIR> --id ${opts.id} --intent explicit-resume.` };
  return record;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help) {
    process.stdout.write(`forge-cli-helpers — shared multi-run CLI logic

Flags:
  --resolve-args --args "<arg>" [--command forge-auto]
                                resolve user input to a {run_id,kind,status,message}
                                e.g. "M065", "M-20260522143012-oauth", "T-20260522143012-fix-typo"
  --list-active-summary         human-readable summary of active runs
  --new-task-id --description "<text>"
                                generate T-<ts>-<slug> ID
  --refuse-msg --command <name> (assumes >=2 active) print refuse message
  --cwd <path>                  override working directory
`);
    return;
  }

  try {
    if (args['resolve-args']) {
      const r = resolveRunFromArgs(cwd, args.args || '', { command: args.command });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args['list-active-summary']) {
      process.stdout.write(listActiveSummary(cwd) + '\n');
    } else if (args['new-task-id']) {
      process.stdout.write(newTaskId(args.description || 'adhoc', cwd) + '\n');
    } else if (args['refuse-msg']) {
      const active = runs.listActive(cwd);
      process.stdout.write(refuseMessage(active, args.command || 'forge-auto') + '\n');
    } else {
      process.stderr.write('forge-cli-helpers: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-cli-helpers error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  resolveRunFromArgs, listActiveSummary, newTaskId, refuseMessage, activateRun,
};
