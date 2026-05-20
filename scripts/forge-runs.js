#!/usr/bin/env node
// forge-runs — Runs registry CRUD for multi-run workspace
//
// Manages .gsd/forge/runs/{id}.json — the truth source for active Forge orchestrators
// in a workspace. See shared/forge-state.md §2 for schema.
//
// Library exports (require from other scripts):
//   listAll(cwd) / listActive(cwd) / get(cwd, id)
//   add(cwd, record) / update(cwd, id, patch) / remove(cwd, id)
//   bumpHeartbeat(cwd, id) / cleanupStale(cwd, thresholdMs)
//   resolveBySessionId(cwd, sessionId) / oldestActive(cwd)
//   refreshLegacyAlias(cwd) / migrateLegacyState(cwd)
//
// CLI usage (see --help):
//   node forge-runs.js --list
//   node forge-runs.js --add --id M065 --kind milestone --session abc --cwd <path>
//   node forge-runs.js --bump M065
//   node forge-runs.js --cleanup-stale
//   node forge-runs.js --migrate-legacy

'use strict';

const fs   = require('fs');
const path = require('path');

const STALE_THRESHOLD_MS = 30 * 60 * 1000;   // 30min: garbage-collect
const ALIAS_FILE         = 'auto-mode.json'; // legacy alias

function runsDir(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'runs');
}

function ensureRunsDir(cwd) {
  const dir = runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runFile(cwd, id) {
  return path.join(runsDir(cwd), `${id}.json`);
}

// ── Read ────────────────────────────────────────────────────────────────────
function listAll(cwd) {
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function listActive(cwd) {
  return listAll(cwd).filter(r => r.active === true);
}

function get(cwd, id) {
  const f = runFile(cwd, id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
}

function resolveBySessionId(cwd, sessionId) {
  if (!sessionId) return null;
  return listActive(cwd).find(r => r.session_id === sessionId) || null;
}

function oldestActive(cwd) {
  const active = listActive(cwd);
  if (active.length === 0) return null;
  return active.reduce((a, b) => (a.started_at <= b.started_at ? a : b));
}

// ── Write (atomic via temp+rename) ──────────────────────────────────────────
function writeAtomic(filePath, record) {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath);
  // Random suffix avoids collisions if two writers hit the same id concurrently
  const tmp  = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function add(cwd, record) {
  if (!record || !record.id || !record.kind || !record.session_id) {
    throw new Error('forge-runs.add: record requires id, kind, session_id');
  }
  ensureRunsDir(cwd);
  const now = Date.now();
  const full = {
    kind: record.kind,
    id: record.id,
    session_id: record.session_id,
    active: record.active !== false,
    started_at: record.started_at || now,
    last_heartbeat: record.last_heartbeat || now,
    worker: record.worker || null,
    worker_started: record.worker_started || null,
    isolation_mode: record.isolation_mode || 'shared',
    milestone_dir: record.milestone_dir || (record.kind === 'milestone' ? `.gsd/milestones/${record.id}/` : null),
    cwd: record.cwd || cwd,
  };
  if (record.kind === 'task') {
    full.task_description = record.task_description || '';
    full.pending_decisions = record.pending_decisions || [];
    full.pending_memories  = record.pending_memories  || [];
  }
  writeAtomic(runFile(cwd, record.id), full);
  refreshLegacyAlias(cwd);
  return full;
}

function update(cwd, id, patch) {
  const current = get(cwd, id);
  if (!current) throw new Error(`forge-runs.update: run ${id} not found`);
  const next = Object.assign({}, current, patch);
  writeAtomic(runFile(cwd, id), next);
  refreshLegacyAlias(cwd);
  return next;
}

function remove(cwd, id) {
  const f = runFile(cwd, id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  refreshLegacyAlias(cwd);
}

function bumpHeartbeat(cwd, id, ts) {
  return update(cwd, id, { last_heartbeat: ts || Date.now() });
}

function cleanupStale(cwd, thresholdMs) {
  const threshold = thresholdMs || STALE_THRESHOLD_MS;
  const now = Date.now();
  const removed = [];
  for (const r of listAll(cwd)) {
    if ((now - (r.last_heartbeat || 0)) > threshold) {
      remove(cwd, r.id);
      removed.push(r.id);
    }
  }
  return removed;
}

// ── Legacy alias (auto-mode.json mirror of oldest active) ───────────────────
function refreshLegacyAlias(cwd) {
  const aliasPath = path.join(cwd, '.gsd', 'forge', ALIAS_FILE);
  const oldest = oldestActive(cwd);
  let mirror;
  if (oldest) {
    mirror = {
      active: true,
      started_at: oldest.started_at,
      last_heartbeat: oldest.last_heartbeat,
      worker: oldest.worker,
      worker_started: oldest.worker_started,
    };
  } else {
    mirror = { active: false };
  }
  try {
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.writeFileSync(aliasPath, JSON.stringify(mirror), 'utf8');
  } catch { /* alias is best-effort */ }
}

// ── Migration ───────────────────────────────────────────────────────────────
// Detect a pre-M004 STATE.md and migrate to M###-STATE.md + dashboard regen.
// Idempotent: if STATE.md already has the AUTO-GENERATED marker, no-op.
function migrateLegacyState(cwd) {
  const statePath = path.join(cwd, '.gsd', 'STATE.md');
  if (!fs.existsSync(statePath)) return { migrated: false, reason: 'no STATE.md' };

  const raw = fs.readFileSync(statePath, 'utf8');
  if (raw.startsWith('<!-- AUTO-GENERATED')) {
    return { migrated: false, reason: 'already dashboard' };
  }

  // Parse legacy fields
  const m = raw.match(/\*\*Active Milestone:\*\*\s*([^\n]+)/i);
  if (!m) return { migrated: false, reason: 'no Active Milestone field' };

  const milestoneText = m[1].trim();
  const milestoneId = (milestoneText.match(/^(M\d+)/i) || [])[1];
  if (!milestoneId) {
    // Legacy STATE.md exists but no active milestone — just write empty dashboard
    return { migrated: false, reason: 'no active milestone in legacy STATE' };
  }

  const milestoneDir = path.join(cwd, '.gsd', 'milestones', milestoneId);
  if (!fs.existsSync(milestoneDir)) {
    return { migrated: false, reason: `milestone dir ${milestoneId} not found` };
  }

  // Extract optional fields
  const slice = (raw.match(/\*\*Active Slice:\*\*\s*([^\n]+)/i)   || [, '—'])[1].trim();
  const task  = (raw.match(/\*\*Active Task:\*\*\s*([^\n]+)/i)    || [, '—'])[1].trim();
  const phase = (raw.match(/\*\*Phase:\*\*\s*([^\n]+)/i)          || [, 'idle'])[1].trim();
  const auto  = (raw.match(/\*\*Auto-mode:\*\*\s*([^\n]+)/i)      || [, 'off'])[1].trim();
  const nextActMatch = raw.match(/## Next Action\s*\n([\s\S]*?)(?=\n##|\n---|\n\*\*|$)/i);
  const nextAction = nextActMatch ? nextActMatch[1].trim() : '(see legacy STATE.md backup)';

  // Write per-milestone state
  const nowIso = new Date().toISOString();
  const perMilestonePath = path.join(milestoneDir, `${milestoneId}-STATE.md`);
  const content = `---
milestone: ${milestoneId}
kind: milestone
created: ${nowIso}
last_updated: ${nowIso}
isolation_mode: shared
---

# ${milestoneId} State

**Active Slice:** ${slice}
**Active Task:** ${task}
**Phase:** ${phase}
**Auto-mode:** ${auto}
**Next Action:** ${nextAction}

## Notes (migrated from legacy STATE.md)

Run record migrated by forge-runs.js on ${nowIso}. Legacy single-run STATE.md was overwritten as dashboard.
`;
  fs.writeFileSync(perMilestonePath, content, 'utf8');
  return { migrated: true, milestoneId, perMilestonePath };
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

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help || (Object.keys(args).length === 0)) {
    process.stdout.write(`forge-runs — registry CRUD

Flags:
  --list                   list all runs (active + inactive)
  --list-active            list only active runs
  --get <id>               get single run record
  --add --id <id> --kind <milestone|task> --session <id>  create
  --update <id> --json <patch-json>                       update fields
  --remove <id>            delete record
  --bump <id>              bump last_heartbeat to now
  --cleanup-stale [--threshold-ms <n>]   garbage-collect stale records
  --resolve-session <id>   find active run for session_id
  --refresh-legacy-alias   rewrite auto-mode.json mirror
  --migrate-legacy         detect legacy STATE.md, migrate
  --cwd <path>             override working directory
`);
    return;
  }

  try {
    if (args.list) {
      process.stdout.write(JSON.stringify(listAll(cwd), null, 2) + '\n');
    } else if (args['list-active']) {
      process.stdout.write(JSON.stringify(listActive(cwd), null, 2) + '\n');
    } else if (args.get) {
      const r = get(cwd, args.get);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else if (args.add) {
      const r = add(cwd, {
        id: args.id,
        kind: args.kind,
        session_id: args.session,
        isolation_mode: args['isolation-mode'] || 'shared',
        task_description: args['task-description'],
        cwd,
      });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.update) {
      const patch = args.json ? JSON.parse(args.json) : {};
      const r = update(cwd, args.update, patch);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.remove) {
      remove(cwd, args.remove);
      process.stdout.write('ok\n');
    } else if (args.bump) {
      const r = bumpHeartbeat(cwd, args.bump);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args['cleanup-stale']) {
      const threshold = args['threshold-ms'] ? parseInt(args['threshold-ms'], 10) : STALE_THRESHOLD_MS;
      const removed = cleanupStale(cwd, threshold);
      process.stdout.write(JSON.stringify({ removed }, null, 2) + '\n');
    } else if (args['resolve-session']) {
      const r = resolveBySessionId(cwd, args['resolve-session']);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else if (args['refresh-legacy-alias']) {
      refreshLegacyAlias(cwd);
      process.stdout.write('ok\n');
    } else if (args['migrate-legacy']) {
      const result = migrateLegacyState(cwd);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stderr.write('forge-runs: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-runs error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  listAll, listActive, get,
  add, update, remove,
  bumpHeartbeat, cleanupStale,
  resolveBySessionId, oldestActive,
  refreshLegacyAlias, migrateLegacyState,
  runsDir, runFile,
  STALE_THRESHOLD_MS,
};
