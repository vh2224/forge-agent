#!/usr/bin/env node
// forge-cli-helpers — Shared helpers for /forge-auto, /forge-next, /forge-task
//
// Centralizes the multi-run CLI logic: arg parsing, active-run checking, refuse messages,
// run registration. Used by the orchestrator skills to avoid duplicating bash.
//
// Library exports:
//   resolveRunFromArgs(cwd, args, opts) → { run_id, kind, status, message }
//   listActiveSummary(cwd) → string (multi-line, formatted for user)
//   newTaskId(description) → string (task-{slug}-{shortuuid4})
//   refuseMessage(activeRuns, command) → string
//   activateRun(cwd, opts) → registered RunRecord
//
// CLI:
//   node forge-cli-helpers.js --resolve-args --args "M065" [--cwd <path>]
//   node forge-cli-helpers.js --list-active-summary [--cwd <path>]
//   node forge-cli-helpers.js --new-task-id --description "fix typo"

'use strict';

const path  = require('path');
const crypto = require('crypto');
const runs  = require('./forge-runs.js');

// ── Prefs read (multi_run.refused_when_active_count) ────────────────────────
function readPref(cwd, dottedKey, fallback) {
  const fs = require('fs');
  const os = require('os');
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];
  const [section, key] = dottedKey.split('.');
  let value = fallback;
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const re = new RegExp(`^${section}:[ \\t]*\\n([\\s\\S]*?)(?=^\\w|\\Z)`, 'm');
      const m = raw.match(re);
      if (m) {
        const kre = new RegExp(`^[ \\t]+${key}:[ \\t]*([^\\n]+)`, 'm');
        const km = m[1].match(kre);
        if (km) value = km[1].trim();
      }
    } catch {}
  }
  return value;
}

// ── ID generation ───────────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function newTaskId(description) {
  const slug = slugify(description || 'task');
  const suffix = crypto.randomBytes(2).toString('hex');
  return `task-${slug}-${suffix}`;
}

// ── Arg resolution ──────────────────────────────────────────────────────────
// Input: raw argument string (e.g. "M065", "task-fix-foo-a3f2", "", "resume", "ignored-text")
// Output:
//   { run_id: "M###" | "task-...", kind: "milestone"|"task", status: "ok"|"refuse"|"activate-new"|"resume-only", message }
function resolveRunFromArgs(cwd, argsRaw, opts) {
  opts = opts || {};
  const arg = String(argsRaw || '').trim();
  const active = runs.listActive(cwd);
  const refuseThreshold = parseInt(readPref(cwd, 'multi_run.refused_when_active_count', '2'), 10);

  // Direct ID arg
  if (arg) {
    // Milestone-style ID (M### where ### is digits)
    if (/^M\d+$/i.test(arg)) {
      const id = arg.toUpperCase();
      const existing = runs.get(cwd, id);
      if (existing && existing.active) {
        return { run_id: id, kind: 'milestone', status: 'resume', message: `Retomando run ativa: ${id}` };
      }
      return { run_id: id, kind: 'milestone', status: 'activate-new', message: `Iniciando run: ${id}` };
    }
    // Task-style ID
    if (/^task-/.test(arg)) {
      const existing = runs.get(cwd, arg);
      if (existing && existing.active) {
        return { run_id: arg, kind: 'task', status: 'resume', message: `Retomando task run: ${arg}` };
      }
      return { run_id: null, kind: null, status: 'error', message: `Task ID "${arg}" não encontrado no registry.` };
    }
    // Unknown arg
    return { run_id: null, kind: null, status: 'error', message: `Argumento "${arg}" não reconhecido. Use M### ou task-...` };
  }

  // No arg — decide based on active count
  if (active.length === 0) {
    // Legacy single-run: read .gsd/STATE.md for active milestone
    return { run_id: null, kind: null, status: 'legacy', message: 'Sem runs ativas. Verifique .gsd/STATE.md legado para Active Milestone.' };
  }

  if (active.length === 1) {
    const r = active[0];
    return { run_id: r.id, kind: r.kind, status: 'resume', message: `↺ Retomando única run ativa: ${r.id}` };
  }

  // 2+ active and arg absent — apply refuse threshold
  if (active.length >= refuseThreshold) {
    return { run_id: null, kind: null, status: 'refuse', message: refuseMessage(active, opts.command || 'forge-auto') };
  }

  // (Below threshold but >1) — fall back to resume the oldest? Conservative: refuse anyway with friendly message.
  return { run_id: null, kind: null, status: 'refuse', message: refuseMessage(active, opts.command || 'forge-auto') };
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
  return runs.add(cwd, {
    id: opts.id,
    kind: opts.kind,
    session_id: opts.session_id,
    active: true,
    isolation_mode: opts.isolation_mode || 'shared',
    milestone_dir: opts.kind === 'milestone' ? `.gsd/milestones/${opts.id}/` : null,
    cwd: opts.cwd || cwd,
    task_description: opts.task_description,
  });
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
  --list-active-summary         human-readable summary of active runs
  --new-task-id --description "<text>"
                                generate task-{slug}-{shortuuid} ID
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
      process.stdout.write(newTaskId(args.description || 'adhoc') + '\n');
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
