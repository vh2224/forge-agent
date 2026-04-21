#!/usr/bin/env node
// forge-parallelism.js — compute a parallel batch of ready tasks for execute-task dispatch.
//
// Usage:
//   node scripts/forge-parallelism.js --slice-plan <path> [--max-concurrent N]
//
// Reads:
//   - <slice-plan>        : S##-PLAN.md listing tasks (checkbox state = done/pending)
//   - sibling tasks/T##/T##-PLAN.md frontmatter for each task (depends: [], writes: [])
//
// Output (stdout): single-line JSON
//   { mode: "parallel" | "single" | "legacy" | "blocked" | "none",
//     batch: [{id, planPath}],
//     reason: string,
//     details?: object }
//
// Modes:
//   parallel  — batch.length >= 2, orchestrator dispatches multiple Agent() in one message
//   single    — batch.length == 1, normal single dispatch (modern plan, but only 1 ready)
//   legacy    — any task in slice is missing depends OR writes frontmatter → force sequential
//   blocked   — there are pending tasks but none have all deps satisfied (shouldn't happen in valid plans)
//   none      — all tasks already marked done

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function emit(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj));
  if (typeof exitCode === 'number') process.exit(exitCode);
}

// Convert a glob-ish path pattern into a RegExp. Supports **, *, ?, and literal segments.
// Always uses forward slashes (Windows-safe).
function globToRegex(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// Two write-declarations conflict iff any literal-or-glob on one side matches the other.
function pathsOverlap(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return true; // defensive: empty path = unknown = conflict
  if (na === nb) return true;

  // Directory prefix: "src/" should conflict with anything under it.
  if (na.endsWith('/*') || na.endsWith('/**')) {
    const prefix = na.replace(/\/\*\*?$/, '') + '/';
    if (nb === prefix.slice(0, -1) || nb.startsWith(prefix)) return true;
  }
  if (nb.endsWith('/*') || nb.endsWith('/**')) {
    const prefix = nb.replace(/\/\*\*?$/, '') + '/';
    if (na === prefix.slice(0, -1) || na.startsWith(prefix)) return true;
  }

  // Bidirectional glob match (either side may be the pattern).
  try {
    if (globToRegex(na).test(nb)) return true;
    if (globToRegex(nb).test(na)) return true;
  } catch (_) {
    return true; // malformed glob → treat as conflict
  }
  return false;
}

function writesConflict(writesA, writesB) {
  if (!Array.isArray(writesA) || !Array.isArray(writesB)) return true;
  if (writesA.length === 0 || writesB.length === 0) return false; // empty = no writes = no conflict
  for (const a of writesA) {
    for (const b of writesB) {
      if (pathsOverlap(a, b)) return true;
    }
  }
  return false;
}

// Parse the YAML frontmatter of a task plan. Returns { depends, writes } where each is an
// array or null (null = field absent → legacy).
function parseTaskFrontmatter(planPath) {
  if (!planPath || !fs.existsSync(planPath)) return null;
  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch (_) {
    return null;
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = m[1];

  const depends = parseListField(fm, 'depends');
  const writes = parseListField(fm, 'writes');
  return { depends, writes };
}

// Parse either inline (`key: [a, b]`) or block (`key:\n  - a\n  - b`) YAML list.
// Returns array (possibly empty) or null if key not present.
function parseListField(fm, key) {
  const inlineRe = new RegExp('^' + key + ':\\s*\\[([^\\]]*)\\]\\s*$', 'm');
  const mi = fm.match(inlineRe);
  if (mi) {
    const raw = mi[1].trim();
    if (!raw) return [];
    return raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  // Block form
  const blockRe = new RegExp('^' + key + ':\\s*\\n((?:[ \\t]+-[ \\t]+.+\\n?)+)', 'm');
  const mb = fm.match(blockRe);
  if (mb) {
    const items = [];
    for (const line of mb[1].split(/\r?\n/)) {
      const mm = line.match(/^[ \t]+-[ \t]+(.+?)\s*$/);
      if (mm) items.push(mm[1].replace(/^["']|["']$/g, ''));
    }
    return items;
  }
  // Also accept `key:` with empty value as []
  const emptyRe = new RegExp('^' + key + ':\\s*$', 'm');
  if (emptyRe.test(fm)) return [];
  return null;
}

// Discover tasks by scanning the sibling `tasks/T##/` directories on disk.
// A task is "done" iff its `T##-SUMMARY.md` exists — this matches the dispatch table's
// source-of-truth (orchestrator already uses SUMMARY presence as the done signal).
function discoverTasks(sliceDir) {
  const tasksRoot = path.join(sliceDir, 'tasks');
  if (!fs.existsSync(tasksRoot)) return [];
  const entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^T\d+$/.test(e.name)) continue;
    const id = e.name;
    const taskDir = path.join(tasksRoot, id);
    const planPath = path.join(taskDir, id + '-PLAN.md');
    const summaryPath = path.join(taskDir, id + '-SUMMARY.md');
    if (!fs.existsSync(planPath)) continue;
    tasks.push({
      id,
      done: fs.existsSync(summaryPath),
      planPath,
    });
  }
  // Sort by numeric suffix so T01 < T02 < T10.
  tasks.sort((a, b) => {
    const na = parseInt(a.id.slice(1), 10);
    const nb = parseInt(b.id.slice(1), 10);
    return na - nb;
  });
  return tasks;
}

function main() {
  const args = parseArgs(process.argv);
  const slicePlanPath = args['slice-plan'];
  const maxConcurrent = Math.max(1, parseInt(args['max-concurrent'] || '3', 10) || 3);

  if (!slicePlanPath) {
    emit({ mode: 'error', batch: [], reason: 'missing --slice-plan argument' }, 1);
    return;
  }
  if (!fs.existsSync(slicePlanPath)) {
    emit({ mode: 'error', batch: [], reason: 'slice-plan not found: ' + slicePlanPath }, 1);
    return;
  }

  const sliceDir = path.dirname(slicePlanPath);
  const tasks = discoverTasks(sliceDir);

  if (tasks.length === 0) {
    emit({ mode: 'none', batch: [], reason: 'no tasks/T##/T##-PLAN.md files found under slice' });
    return;
  }

  // Enrich with frontmatter. Use forward-slash paths in output.
  let anyMissing = false;
  const enriched = tasks.map(t => {
    const fm = parseTaskFrontmatter(t.planPath);
    const depends = fm && fm.depends !== null ? fm.depends : null;
    const writes = fm && fm.writes !== null ? fm.writes : null;
    if (depends === null || writes === null) anyMissing = true;
    return {
      id: t.id,
      done: t.done,
      depends,
      writes,
      planPath: normalizePath(t.planPath),
    };
  });

  const pending = enriched.filter(t => !t.done);
  if (pending.length === 0) {
    emit({ mode: 'none', batch: [], reason: 'all tasks complete' });
    return;
  }

  // Legacy mode: any task in the slice is missing depends/writes → force sequential.
  if (anyMissing) {
    const next = pending[0];
    emit({
      mode: 'legacy',
      batch: [{ id: next.id, planPath: next.planPath }],
      reason: 'legacy plan — at least one task missing depends/writes frontmatter; forcing sequential',
    });
    return;
  }

  // Modern mode: build ready set.
  const doneIds = new Set(enriched.filter(t => t.done).map(t => t.id));
  const knownIds = new Set(enriched.map(t => t.id));
  const ready = pending.filter(t =>
    (t.depends || []).every(d => doneIds.has(d))
  );

  if (ready.length === 0) {
    emit({
      mode: 'blocked',
      batch: [],
      reason: 'all pending tasks have unmet dependencies',
      details: {
        pending: pending.map(t => ({
          id: t.id,
          depends: t.depends,
          unmet: (t.depends || []).filter(d => !doneIds.has(d)),
        })),
      },
    });
    return;
  }

  // Conflict resolution — greedy pick preserving plan order.
  const batch = [];
  const claimed = [];
  const skipped = [];
  for (const t of ready) {
    if (batch.length >= maxConcurrent) {
      skipped.push({ id: t.id, reason: 'max-concurrent reached' });
      continue;
    }
    const w = t.writes || [];
    const conflictWith = claimed.find(c => writesConflict(c.writes, w));
    if (conflictWith) {
      skipped.push({ id: t.id, reason: 'writes conflict with ' + conflictWith.id });
      continue;
    }
    // Also: if any unknown dep id appears in depends, warn (defensive).
    const strayDeps = (t.depends || []).filter(d => !knownIds.has(d));
    if (strayDeps.length > 0) {
      skipped.push({ id: t.id, reason: 'unknown dependency ids: ' + strayDeps.join(',') });
      continue;
    }
    batch.push({ id: t.id, planPath: t.planPath });
    claimed.push({ id: t.id, writes: w });
  }

  if (batch.length === 0) {
    // Every ready task was filtered out — surface as blocked so orchestrator can react.
    emit({
      mode: 'blocked',
      batch: [],
      reason: 'all ready tasks filtered out (conflicts or stray deps)',
      details: { skipped },
    });
    return;
  }

  const mode = batch.length > 1 ? 'parallel' : 'single';
  emit({
    mode,
    batch,
    reason: mode === 'parallel'
      ? batch.length + ' independent tasks ready (' + ready.length + ' in ready set)'
      : 'single task ready (' + ready.length + ' in ready set)',
    details: {
      readyCount: ready.length,
      pendingCount: pending.length,
      maxConcurrent,
      skipped,
    },
  });
}

try {
  main();
} catch (e) {
  emit({ mode: 'error', batch: [], reason: 'parser error: ' + (e && e.message || String(e)) }, 1);
}
