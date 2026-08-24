#!/usr/bin/env node
// forge-dashboard — Regenerate .gsd/STATE.md as a workspace dashboard
//
// Reads:
//   .gsd/forge/runs/*.json           (active runs)
//   .gsd/LEDGER.md                   (recent completed milestones, tail)
//   .gsd/milestones/M###/M###-events.jsonl  (per-run activity tail)
//
// Writes:
//   .gsd/STATE.md (overwrite under .gsd/.locks/STATE.md/ lock)
//
// Called from:
//   - skills/forge-auto activation (boot/exit/phase-change)
//   - skills/forge-status on demand
//
// CLI:
//   node forge-dashboard.js [--cwd <path>] [--dry-run]

'use strict';

const fs   = require('fs');
const path = require('path');

const runs = require('./forge-runs.js');
const lock = require('./forge-lock.js');
const forgeState = require('./forge-state.js');
const { isProject } = require('./forge-workspace.js');
const { parseEvidenceFileName, collectKnownMilestoneIds } = require('./forge-evidence-path.js');
const { readJsonl } = require('./forge-jsonl.js');

const STALE_WARNING_MS = 5  * 60 * 1000;  // yellow chip
const STALE_MS         = 15 * 60 * 1000;  // red chip / "stale" label (M005.3+: 15min matches statusline)

// Compute effective heartbeat age from multiple sources (M005+).
// Some bugs leave runs/{id}.json.last_heartbeat stale (e.g. session_id mismatch
// pre-v1.13.3), but the worker is still alive — events.jsonl, STATE.md mtime
// and per-run evidence files reveal that. Use the MOST RECENT signal as truth.
function effectiveHeartbeatAge(r, now, cwd) {
  let minAge = now - (r.last_heartbeat || 0);
  if (r.milestone_dir) {
    const candidates = [
      path.join(cwd, r.milestone_dir, `${r.id}-events.jsonl`),
      path.join(cwd, r.milestone_dir, `${r.id}-STATE.md`),
    ];
    for (const f of candidates) {
      try {
        const age = now - fs.statSync(f).mtimeMs;
        if (age < minAge) minAge = age;
      } catch {}
    }
  }
  // M005.3+: per-run evidence files (hook-writes a line per tool call —
  // freshest per-run signal available; bypasses opus-thinking gaps where
  // no other mtime updates for 5-10min).
  // S01/T04: classify each file via parseEvidenceFileName (the module that
  // owns the file-name shape) instead of matching `-${r.id}-` by substring —
  // the composite/legacy forms are not all shaped that way, and a loose
  // substring match silently degrades freshness for the new form (R3).
  try {
    const forgeDir = path.join(cwd, '.gsd', 'forge');
    const knownMilestoneIds = collectKnownMilestoneIds(cwd);
    for (const ef of fs.readdirSync(forgeDir)) {
      if (!ef.startsWith('evidence') || !ef.endsWith('.jsonl')) continue;
      const parsed = parseEvidenceFileName(ef, { knownMilestoneIds });
      if (parsed.form === 'unrecognized' || parsed.milestone !== r.id) continue;
      try {
        const age = now - fs.statSync(path.join(forgeDir, ef)).mtimeMs;
        if (age < minAge) minAge = age;
      } catch {}
    }
  } catch {}
  return minAge;
}

function fmtAgo(ms) {
  if (ms < 1000)        return `${ms}ms ago`;
  if (ms < 60_000)      return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000)   return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  // Local-time HH:MM:SS — operators read this, so local is OK
  return d.toTimeString().slice(0, 8);
}

function formatActiveRunLine(r, now, cwd) {
  // Use effective heartbeat (cross-referenced with events.jsonl + STATE.md mtime)
  const age = effectiveHeartbeatAge(r, now, cwd);
  let staleness = '';
  if (age > STALE_MS) staleness = ' · ⚠ STALE';
  else if (age > STALE_WARNING_MS) staleness = ' · ⚠ slow';

  // M005+: cross-reference M###-STATE.md for real phase/slice/task
  // (runs/{id}.json schema doesn't have phase field — STATE has the truth)
  let phase = '—';
  let sliceTask = '';
  if (r.kind === 'milestone') {
    try {
      const state = forgeState.read(cwd, r.id);
      if (state) {
        phase = state.phase || '—';
        const slice = state.active_slice && state.active_slice !== '—' ? state.active_slice : '';
        const task  = state.active_task  && state.active_task  !== '—' ? state.active_task  : '';
        if (slice) sliceTask += ` · slice: ${slice}`;
        if (task)  sliceTask += ` · task: ${task}`;
      }
    } catch { /* best-effort; fall back to '—' */ }
  }

  const worker = r.worker ? ` · worker: ${r.worker.split('/').pop()}` : '';
  const desc   = r.kind === 'task' && r.task_description
    ? ` · "${r.task_description.slice(0, 60)}${r.task_description.length > 60 ? '…' : ''}"`
    : '';

  return `- **${r.id}** — ${r.kind} · phase: ${phase}${sliceTask}${worker} · heartbeat: ${fmtAgo(age)} · isolation: ${r.isolation_mode || 'shared'} · session: ${r.session_id || '—'}${staleness}${desc}`;
}

function readLedgerTail(cwd, maxEntries) {
  const file = path.join(cwd, '.gsd', 'LEDGER.md');
  if (!fs.existsSync(file)) return [];
  try {
    // Form A/funnel (S03-FIXSET.json): normalize once at the read — LEDGER.md
    // is only ever displayed here, never rewritten by this module — so the
    // `split('\n')` below never leaves a stray CR at the end of a header
    // line. `/\r\n?/g`, never `/\r\n/g` (a lone CR degrades identically).
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    // LEDGER entries are blocks separated by "## " headers (typical Forge LEDGER format)
    // We just want short summaries — pull header lines and their first non-blank line
    const lines = raw.split('\n');
    const entries = [];
    let current = null;
    for (const line of lines) {
      const head = line.match(/^##\s+(.+)$/);
      if (head) {
        if (current) entries.push(current);
        current = { title: head[1].trim(), first: '' };
      } else if (current && !current.first && line.trim()) {
        current.first = line.trim();
      }
    }
    if (current) entries.push(current);
    return entries.slice(-maxEntries).reverse();
  } catch { return []; }
}

function readEventsTail(cwd, milestoneDir, maxLines) {
  const file = path.join(cwd, milestoneDir, path.basename(milestoneDir.replace(/\/$/, '')) + '-events.jsonl');
  if (!fs.existsSync(file)) {
    // Fallback to global events.jsonl for legacy / non-migrated runs.
    // Delegates to forge-jsonl.js (Form A/funnel: normalize once at the
    // read — events.jsonl is never rewritten by this module, only displayed).
    const fallback = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    return readJsonl(fallback, { maxLines }).lines;
  }
  // Same delegation as the fallback path above.
  return readJsonl(file, { maxLines }).lines;
}

function tierIcon(unitType) {
  const TIER_ICON = {
    'memory-extract':    '🪶',
    'complete-slice':    '🪶',
    'complete-milestone':'🪶',
    'execute-task':      '⚡',
    'plan-milestone':    '🔥',
    'plan-slice':        '🔥',
    'discuss-milestone': '🔥',
    'discuss-slice':     '🔥',
    'research-milestone':'🔬',
    'research-slice':    '🔬',
    'dispatch':          '·',
  };
  return TIER_ICON[unitType] || '·';
}

function statusIcon(status) {
  if (status === 'done')    return '✓';
  if (status === 'blocked') return '✗';
  if (status === 'partial') return '○';
  return '·';
}

function formatActivityLine(ev, runId) {
  const ts = ev.ts ? new Date(ev.ts).getTime() : 0;
  const clock = fmtClock(ts);
  const unit = ev.unit || (ev.event || '?');
  const [unitType] = unit.split('/');
  const icon = ev.status ? statusIcon(ev.status) : tierIcon(unitType);
  const agent = ev.agent ? ` (${ev.agent})` : '';
  const summary = ev.summary ? ` — ${ev.summary.slice(0, 80)}` : '';
  return `- ${icon} [${clock}] ${runId}/${unit} — ${ev.status || ev.event || 'event'}${agent}${summary}`;
}

// `eol` is the line ending of the .gsd/STATE.md projection already on disk. This
// render IS the serialisation regenerate() writes, so joining with LF by decree
// would re-write every line of a CRLF projection on each regen (D-S03-2). Defaults
// to LF when there is no file yet — nothing to preserve.
function render(cwd, eol) {
  const nl = eol || '\n';
  const now = Date.now();
  const active = runs.listActive(cwd);
  const ledgerEntries = readLedgerTail(cwd, 5);

  // Collect recent activity across all runs (last 5 events total, sorted by ts desc)
  const allEvents = [];
  for (const r of active) {
    if (!r.milestone_dir) continue;  // task-runs don't have a separate events file
    const tail = readEventsTail(cwd, r.milestone_dir, 20);
    for (const ev of tail) allEvents.push({ ev, runId: r.id });
  }
  allEvents.sort((a, b) => {
    const ta = a.ev.ts ? new Date(a.ev.ts).getTime() : 0;
    const tb = b.ev.ts ? new Date(b.ev.ts).getTime() : 0;
    return tb - ta;
  });
  const recentActivity = allEvents.slice(0, 5);

  // Build markdown
  const out = [];
  out.push(`<!-- AUTO-GENERATED by scripts/forge-dashboard.js — do not edit by hand -->`);
  out.push(`<!-- Last regen: ${new Date(now).toISOString()} -->`);
  out.push('');
  out.push(`# GSD Dashboard`);
  out.push('');

  if (active.length === 0) {
    out.push(`No active runs.`);
    if (ledgerEntries.length > 0) {
      out.push(`Last completed: ${ledgerEntries[0].title}.`);
    }
    out.push('');
    out.push(`Run \`/forge-auto <M###>\` or \`/forge-task <descrição>\` to start.`);
  } else {
    out.push(`## Active runs (${active.length})`);
    out.push('');
    for (const r of active) {
      out.push(formatActiveRunLine(r, now, cwd));
    }
    out.push('');
  }

  if (ledgerEntries.length > 0) {
    out.push(`## Recently completed`);
    out.push('');
    for (const e of ledgerEntries) {
      const detail = e.first ? ` — ${e.first.slice(0, 100)}` : '';
      out.push(`- ${e.title}${detail}`);
    }
    out.push('');
    out.push(`(See \`.gsd/LEDGER.md\` for full history.)`);
    out.push('');
  }

  if (recentActivity.length > 0) {
    out.push(`## Recent activity (last 5 units, across all runs)`);
    out.push('');
    for (const { ev, runId } of recentActivity) {
      out.push(formatActivityLine(ev, runId));
    }
    out.push('');
    out.push(`(See \`.gsd/milestones/M###/M###-events.jsonl\` for per-run history.)`);
    out.push('');
  }

  const rendered = out.join(nl);
  return nl === '\n' ? rendered : rendered.replace(/\r\n?|\n/g, nl);
}

async function regenerate(cwd, opts) {
  opts = opts || {};
  // Form B: capture the EOL of the projection already on disk and re-emit it.
  let existingEol = '\n';
  try {
    const prior = fs.readFileSync(path.join(cwd, '.gsd', 'STATE.md'), 'utf8');
    existingEol = (prior.match(/\r\n|\n|\r/) || ['\n'])[0];
  } catch {
    // No projection yet (or unreadable) — LF, the default for a new file.
  }
  const content = render(cwd, existingEol);
  if (opts.dryRun) return content;

  // A dashboard describes a project's runs; rendering one into a directory
  // that is not a project *creates* the project. That is not hypothetical:
  // `~/Development/.gsd` — one level above every real project on the author's
  // machine — contained exactly `.locks/` and a STATE.md written here. The
  // detector then read it as a project containing fifteen others.
  //
  // Refusing costs nothing (there are no runs to report in an uninitialised
  // directory) and is loud rather than silent, so a genuine misconfiguration
  // surfaces instead of quietly enrolling a folder.
  if (!isProject(cwd)) {
    const err = new Error(
      `forge-dashboard: ${cwd} is not a Forge project (.gsd/ absent or holds only runtime scratch) — nothing regenerated`);
    err.code = 'ENOTPROJECT';
    throw err;
  }

  // Acquire .gsd/.locks/STATE.md/ — short TTL since regen is idempotent and fast
  let held;
  try {
    held = await lock.acquire(cwd, 'STATE.md', {
      ttlMs: 5_000,
      retries: 5,
      backoffMin: 50,
      backoffMax: 150,
      holderRunId: opts.holderRunId || `dashboard:${process.pid}`,
    });
  } catch (e) {
    // Could not acquire — another orchestrator just regenerated, our data
    // will be picked up next time. Idempotent regen reads fresh state.
    return null;
  }

  try {
    const statePath = path.join(cwd, '.gsd', 'STATE.md');
    fs.writeFileSync(statePath, content, 'utf8');
    return content;
  } finally {
    held.release();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

async function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help) {
    process.stdout.write(`forge-dashboard — regenerate .gsd/STATE.md as dashboard

Flags:
  --dry-run        print to stdout, do not write
  --cwd <path>     override working directory
  --holder <id>    tag lock holder for debugging

Default: acquires .gsd/.locks/STATE.md/ and overwrites .gsd/STATE.md.
If lock busy: silently skip (idempotent — next regen picks up).
`);
    return;
  }

  try {
    const result = await regenerate(cwd, {
      dryRun: !!args['dry-run'],
      holderRunId: args.holder,
    });
    if (args['dry-run']) {
      process.stdout.write(result);
    } else {
      process.stdout.write(result === null ? 'skipped (lock busy)\n' : 'regenerated\n');
    }
  } catch (e) {
    process.stderr.write(`forge-dashboard error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  regenerate, render,
  formatActiveRunLine, formatActivityLine,
  effectiveHeartbeatAge,
};
