#!/usr/bin/env node
// forge-status — Pure-read status engine for Forge Agent
//
// CONTRACT (LOCKED — see S01-PLAN.md § Hard invariants):
//   1. Pure-read absolute: NEVER fs.writeFileSync/appendFileSync/mkdirSync/
//      unlinkSync/renameSync anywhere in this file. NEVER require('./forge-lock.js').
//      NEVER call the write-side of reused libs (forge-runs.add/update/remove/
//      bumpHeartbeat/cleanupStale/refreshLegacyAlias/migrateLegacyState,
//      forge-state.write/updateFields/pushRecentUnit). Read-only exports only.
//   2. Never modify forge-dashboard.js nor forge-statusline.js — patterns are
//      mined (copied) here, never required from them (their call graph is the
//      write path).
//   3. Exports contract: parseRoadmap/parsePlanTasks/scanAutonomousTasks (T01) +
//      resolveFocus/collect (T02). renderTree + CLI land in T03.
//   4. Torn-read tolerance from day 1: every file read + JSON.parse wrapped in
//      try/catch. Malformed/truncated input degrades to empty/partial results,
//      never throws.
//   5. No network, no external deps: Node stdlib + repo libs only.
//   6. Milestone time (shared/forge-milestone-time.md): collect adds `time` only
//      to milestones with a contract, via the pure readers readTimeStatus and
//      summarizeTimeStatus; renderTree only formats model.time.
//
// Dashboard writes, status reads.

'use strict';

const fs = require('fs');
const path = require('path');
const ids = require('./forge-ids.js');

// Read-only reuse of forge-runs / forge-state — WHITELIST:
//   runs.listActive / runs.get / runs.oldestActive
//   forgeState.read / forgeState.readLegacyStateFile
// FORBIDDEN (write-side, never call): runs.add/update/remove/bumpHeartbeat/
// cleanupStale/refreshLegacyAlias/migrateLegacyState, forgeState.write/
// updateFields/pushRecentUnit.
const runs = require('./forge-runs.js');
const forgeState = require('./forge-state.js');
// Read-only reuse of forge-tokens.aggregate() (T01) — CLI layer only, never
// called from renderTree/collect (pure-read + purity invariants).
const tokens = require('./forge-tokens.js');

// ── Staleness helpers (COPIED from forge-dashboard.js ~L28-69 — do NOT require
// forge-dashboard, its call graph is the write path) ────────────────────────
const STALE_WARNING_MS = 5 * 60 * 1000;  // 5min: warn
const STALE_MS = 15 * 60 * 1000;         // 15min: stale

function fmtAgo(ms) {
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

// ── parseRoadmap ─────────────────────────────────────────────────────────────
// Extracts { title, slices: [{id, title, checked, risk}] } from ROADMAP markdown.
// Base anchor mined verbatim from scripts/forge-statusline.js (~line 147):
//   /^- \[( |x)\]\s+\*\*S\d+/gm
// Extended here with capture groups only — do NOT "improve" the anchor pattern.
function parseRoadmap(text) {
  const empty = { title: null, slices: [] };
  if (typeof text !== 'string' || !text) return empty;

  try {
    const slices = [];
    const sliceRe = /^- \[( |x)\]\s+\*\*(S\d+):\s*(.+)\*\*(?:.*?`risk:(\w+)`)?[^\n]*$/gm;
    let m;
    while ((m = sliceRe.exec(text)) !== null) {
      const declarations = m[0].match(/depends:/g) || [];
      const declaration = m[0].match(/`depends:\[([^\]]*)\]`/);
      const dependencies = declaration && declaration[1].trim() ? declaration[1].split(',').map(value => value.trim()) : [];
      const errors = [];
      if (declarations.length > 1) errors.push('duplicate-declaration');
      if (declarations.length && (!declaration || dependencies.some(value => !/^S\d+$/.test(value)))) errors.push('malformed-declaration');
      if (new Set(dependencies).size !== dependencies.length) errors.push('duplicate-dependency');
      slices.push({
        checked: m[1] === 'x',
        id: m[2],
        title: (m[3] || '').trim(),
        risk: m[4] || null,
        dependencies,
        dependency_status: !declarations.length ? 'missing' : errors.length ? 'invalid' : 'valid',
        dependency_errors: errors,
      });
    }
    const byId = new Map(slices.map(slice => [slice.id, slice]));
    for (const slice of slices) {
      if (slices.filter(other => other.id === slice.id).length !== 1) slice.dependency_errors.push('duplicate-slice-id');
      for (const id of slice.dependencies) {
        if (id === slice.id) slice.dependency_errors.push('self-dependency');
        else if (!byId.has(id)) slice.dependency_errors.push(`unknown-dependency:${id}`);
      }
      const visits = new Set();
      function reaches(id) {
        if (id === slice.id) return true;
        if (visits.has(id)) return false;
        visits.add(id);
        return (byId.get(id)?.dependencies || []).some(reaches);
      }
      if (slice.dependencies.some(reaches)) slice.dependency_errors.push('dependency-cycle');
      if (slice.dependency_errors.length) slice.dependency_status = 'invalid';
    }

    let title = null;
    const h1 = text.match(/^#\s+\S+:\s*(.+?)(?:\s+—\s+Roadmap)?\s*$/m);
    if (h1) title = h1[1].trim();

    return { title, slices };
  } catch {
    return empty;
  }
}

// ── parsePlanTasks ───────────────────────────────────────────────────────────
// Extracts [{id, title, checked}] from S##-PLAN.md task checkboxes. Tolerant of
// three variants: plain ('- [ ] T01: X'), bold container ('- [ ] **T03** ...'),
// and sub-tasks ('- [ ] T03.1: Y').
function parsePlanTasks(text) {
  if (typeof text !== 'string' || !text) return [];

  try {
    const tasks = [];
    const taskRe = /^\s*- \[( |x)\]\s+\*{0,2}(T\d+(?:\.\d+)?)\*{0,2}\s*:?\s*(.*)$/gm;
    let m;
    while ((m = taskRe.exec(text)) !== null) {
      let title = (m[3] || '').trim();
      // Best-effort strip of trailing bold markers / stray annotations.
      title = title.replace(/\*\*$/, '').trim();
      tasks.push({
        checked: m[1] === 'x',
        id: m[2],
        title,
      });
    }
    return tasks;
  } catch {
    return [];
  }
}

// ── scanAutonomousTasks ──────────────────────────────────────────────────────
// Lists autonomous tasks under .gsd/tasks/ (created via /forge-task), classifying
// both legacy ('TASK-001') and timestamp ('T-<14digits>-<slug>') ID formats via
// forge-ids, with status derived from SUMMARY/extra-files/BRIEF-only presence.
function scanAutonomousTasks(cwd) {
  const results = [];
  let tasksDir;
  try {
    tasksDir = path.join(cwd, '.gsd', 'tasks');
    if (!fs.existsSync(tasksDir)) return results;
  } catch {
    return results;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    try {
      if (!entry.isDirectory || !entry.isDirectory()) continue;
      const name = entry.name;
      if (!ids.isValid(name) || ids.entityKind(name) !== 'task') continue;

      const format = ids.classify(name);
      const dirPath = path.join(tasksDir, name);

      let files = [];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        files = [];
      }

      const summaryFile = `${name}-SUMMARY.md`;
      const briefFile = `${name}-BRIEF.md`;

      let status = 'pending';
      if (files.includes(summaryFile)) {
        status = 'done';
      } else if (files.some((f) => f.endsWith('.md') && f !== briefFile)) {
        status = 'in_progress';
      } else {
        status = 'pending';
      }

      let description = '—';
      try {
        const briefPath = path.join(dirPath, briefFile);
        if (fs.existsSync(briefPath)) {
          const briefText = fs.readFileSync(briefPath, 'utf8');
          const heading = briefText.match(/^#\s+(.+)$/m);
          if (heading) {
            let h = heading[1].trim();
            // Strip the ID prefix if present (e.g. "T-20260702-slug: Title" → "Title")
            h = h.replace(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:?\\s*'), '');
            description = h || '—';
          } else {
            const firstLine = briefText.split(/\r?\n/).find((l) => l.trim().length > 0);
            description = firstLine ? firstLine.trim() : '—';
          }
        }
      } catch {
        description = '—';
      }

      results.push({ id: name, format, description, status });
    } catch {
      // Skip malformed entry, continue scanning.
      continue;
    }
  }

  return results;
}

// ── resolveFocus ─────────────────────────────────────────────────────────────
// Decides which milestone the model should render: 0/1/N active runs, or an
// explicit positional milestoneId override. Never throws — degrades to
// { focused: null, note, error } shapes. See S01-PLAN §Steps step 4.
function resolveFocus(cwd, milestoneId, activeRuns) {
  let active = Array.isArray(activeRuns) ? activeRuns : [];
  if (!Array.isArray(activeRuns)) {
    try {
      active = runs.listActive(cwd) || [];
    } catch {
      active = [];
    }
  }

  if (milestoneId) {
    let dirExists = false;
    try {
      dirExists = fs.existsSync(path.join(cwd, '.gsd', 'milestones', milestoneId));
    } catch {
      dirExists = false;
    }
    let hasRun = false;
    try {
      hasRun = !!runs.get(cwd, milestoneId);
    } catch {
      hasRun = false;
    }
    if (!dirExists && !hasRun) {
      return {
        focused: null,
        note: null,
        error: `milestone não encontrado: ${milestoneId}`,
        not_found: { code: 'not_found', id: milestoneId },
      };
    }
    return { focused: milestoneId, note: null, error: null };
  }

  if (active.length === 1) {
    return { focused: active[0].id, note: null, error: null };
  }

  if (active.length > 1) {
    let oldest = null;
    try {
      oldest = runs.oldestActive(cwd);
    } catch {
      oldest = null;
    }
    if (!oldest) return { focused: null, note: null, error: null };
    return {
      focused: oldest.id,
      note: `${active.length} runs ativos; mostrando ${oldest.id} (mais antigo) — use forge-status <M-id> para focar outro`,
      error: null,
    };
  }

  // 0 active runs — fall back to legacy STATE.md, then a milestones scan.
  try {
    const legacy = forgeState.readLegacyStateFile(cwd);
    if (legacy && legacy.active_milestone) {
      const token = legacy.active_milestone.split(/\s/)[0];
      if (token && ids.isValid(token) && ids.entityKind(token) === 'milestone') {
        return {
          focused: token,
          note: 'nenhum run ativo — estado do STATE.md legado',
          error: null,
        };
      }
    }
  } catch {
    // ignore, fall through to milestones scan
  }

  try {
    const milestonesDir = path.join(cwd, '.gsd', 'milestones');
    let entries = [];
    try {
      entries = fs.readdirSync(milestonesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      entries = [];
    }

    let best = null;
    let bestTs = -1;
    for (const id of entries) {
      let state = null;
      try {
        state = forgeState.read(cwd, id);
      } catch {
        state = null;
      }
      if (!state || !state.last_updated) continue;
      const ts = Date.parse(state.last_updated);
      if (!Number.isNaN(ts) && ts > bestTs) {
        bestTs = ts;
        best = id;
      }
    }
    if (best) {
      return { focused: best, note: 'nenhum run ativo — último estado registrado', error: null };
    }
  } catch {
    // ignore
  }

  return { focused: null, note: null, error: null };
}

// ── Milestone time (read-only) ───────────────────────────────────────────────
// Only a milestone with a time contract gains a `time` block; contract-free work
// keeps the exact legacy model and render. readTimeStatus/summarizeTimeStatus
// (forge-milestone-time-admission) are pure readers, required lazily because the
// clock module itself requires this file. Owner writers (warnings, journal,
// checkpoints, amendments) are never reachable from here.
const TIME_REASON = /^[a-z][a-z0-9-]{0,100}$/;
const WORKER_EFFORT = new Set(['complete', 'partial', 'unknown']);

function timeMs(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function timeReason(value) {
  return typeof value === 'string' && TIME_REASON.test(value) ? value : null;
}

// Closed projection: no paths, sources, sessions or raw records, only the
// fields the status and personal views render.
function timeBlock(id, status, summary) {
  const clocks = status.clocks || {};
  const effort = clocks.effort && typeof clocks.effort === 'object' ? clocks.effort : null;
  const worker = effort && effort.worker && typeof effort.worker === 'object' ? effort.worker : null;
  const coverage = worker && worker.coverage ? worker.coverage : {};
  const endpoint = status.horizon && status.horizon.endpoint && status.horizon.endpoint.items ? status.horizon.endpoint.items : null;
  const forecast = status.forecast || {};
  const projection = forecast.projection || {};
  const block = {
    contract: status.contract === 'valid' ? 'valid' : 'invalid',
    contract_version: timeMs(status.contract_version),
    state: summary.state,
    horizon: status.horizon ? {
      ceiling_ms: summary.ceiling_ms,
      endpoint: endpoint ? Object.fromEntries(['publication', 'installation', 'manual-uat', 'external-waits']
        .map((key) => [key, timeReason(endpoint[key])])) : null,
    } : null,
    elapsed_ms: timeMs(clocks.elapsed_ms),
    consumed_ms: summary.consumed_ms,
    unknown_ms: summary.unknown_ms,
    remaining_ms: summary.remaining_ms,
    forecast: {
      status: summary.forecast,
      reason: timeReason(forecast.reason),
      low_ms: Number.isFinite(projection.low_ms) ? Math.round(projection.low_ms) : null,
      high_ms: Number.isFinite(projection.high_ms) ? Math.round(projection.high_ms) : null,
    },
    // The forecast reads historical deliveries; that is never current
    // integrated acceptance of the milestone endpoint.
    progress: { proof_kind: 'historical-delivery', current_integrated_acceptance: 'not-evaluated' },
    effort: effort ? {
      unit_interval_sum_ms: timeMs(effort.unit_interval_sum_ms),
      basis: 'controller-unit-intervals',
      unit_complete: effort.unit_complete === true,
      worker: {
        status: worker && WORKER_EFFORT.has(worker.status) ? worker.status : 'unknown',
        reason: worker ? timeReason(worker.reason) : 'worker-evidence-absent',
        worker_ms: worker ? timeMs(worker.worker_ms) : null,
        observed_worker_ms: worker ? timeMs(worker.observed_worker_ms) : null,
        invocations: worker ? timeMs(worker.invocations) : null,
        coverage: { units: timeMs(coverage.units), covered: timeMs(coverage.covered), partial: timeMs(coverage.partial), unobserved: timeMs(coverage.unobserved) },
      },
    } : null,
    last_warning: status.last_warning && summary.last_warning ? {
      id: summary.last_warning,
      classification: timeReason(status.last_warning.classification),
      warning: status.last_warning.warning === true,
    } : null,
    open_writers: Array.isArray(status.open_writers) ? status.open_writers.length : 0,
    checkpoint: status.checkpoint ? { decision_pending: summary.decision_pending, overshoot_ms: timeMs(status.checkpoint.overshoot_ms) } : null,
    unknowns: (Array.isArray(status.unknowns) ? status.unknowns : []).map(timeReason).filter(Boolean).slice(0, 16),
    summary,
    diagnostic: `node scripts/forge-milestone-time-admission.js --status --milestone ${id} --json`,
  };
  // New keys only for an endpoint or a linked milestone: the frozen proof, the separate task
  // horizon (its own ceiling governs task operations) and the derived chain that governs nothing.
  if (summary.endpoint) block.endpoint = { ...summary.endpoint };
  if (summary.task) {
    block.task = { ...summary.task };
    block.chain = summary.chain ? { ...summary.chain } : null;
  }
  return block;
}

// null for tasks, unreadable IDs and contract-free milestones.
function readMilestoneTime(cwd, id) {
  if (typeof id !== 'string' || !ids.isValid(id) || ids.entityKind(id) !== 'milestone') return null;
  let admission;
  try {
    admission = require('./forge-milestone-time-admission.js');
    const status = admission.readTimeStatus(cwd, id);
    if (!status || status.contract === 'absent') return null;
    return timeBlock(id, status, admission.summarizeTimeStatus(status));
  } catch {
    // A contract that cannot be read stays visible as unknown, never absent.
    const status = { contract: 'invalid', unknowns: ['time-source-unreadable'] };
    const summary = admission ? admission.summarizeTimeStatus(status) : { state: null, ceiling_ms: null, consumed_ms: null,
      unknown_ms: null, remaining_ms: null, forecast: 'unknown', last_warning: null, unknown: true, decision_pending: false };
    return timeBlock(id, status, summary);
  }
}

function withMilestoneTime(root, work, opts) {
  if (work && work.kind === 'task') return withLinkedTask(root, work, opts);
  if (!work || work.kind !== 'milestone' || typeof root !== 'string' || !root) return work;
  const time = readMilestoneTime(root, work.id);
  return time ? { ...work, time } : work;
}

// ── Linked task horizon (read-only) ──────────────────────────────────────────
// Only a task with a link record gains the closed `linked` block: exactly the
// summarizeLinkedStatus projection of forge-linked-task-horizon (task, milestone
// and chain horizons, which ceiling governs each operation, decision pending and
// unknowns). An unlinked task reads no time state and keeps its exact model.
function readLinkedTask(root, id, opts) {
  if (typeof root !== 'string' || !root || typeof id !== 'string' || !ids.isValid(id) || ids.entityKind(id) !== 'task') return null;
  const options = opts || {};
  try {
    const horizon = require('./forge-linked-task-horizon.js');
    const status = horizon.readLinkedStatus({ cwd: root, task: id,
      ...(options.userHome !== undefined ? { userHome: options.userHome } : {}), ...(options.env !== undefined ? { env: options.env } : {}) });
    return status === null ? null : horizon.summarizeLinkedStatus(status);
  } catch {
    // An unreadable horizon stays visible as unknown, never as absent.
    return { task_id: id, lifecycle: 'invalid', task: null, milestone: null, chain: null, decision_pending: false, unknown: true };
  }
}

function withLinkedTask(root, work, opts) {
  if (!work || typeof root !== 'string' || !root) return work;
  const linked = readLinkedTask(root, work.id, opts);
  return linked ? { ...work, linked } : work;
}

// ── collect ──────────────────────────────────────────────────────────────────
// Assembles the full status model per S01-PLAN.md § Shared contract. Pure-read,
// torn-read tolerant end to end. opts = { milestoneId }.
function collect(cwd, opts) {
  opts = opts || {};
  if (opts.scope !== 'workspace') {
    const snapshot = require('./forge-personal-context').readPersonalSnapshot({ ...opts, cwd, id: opts.milestoneId || opts.id, inspect: Boolean(opts.milestoneId || opts.id) });
    // Time is read from the snapshot's own project, never from a census.
    const works = (snapshot.works || []).map((work) => withMilestoneTime(snapshot.project, work, opts));
    return { ...snapshot, scope: snapshot.scope || (opts.milestoneId || opts.id ? 'inspection' : 'personal'), works, cwd, generated_at: new Date().toISOString(), warnings: snapshot.status === 'error' ? [snapshot.reason] : [] };
  }
  const warnings = [];
  const now = Date.now();

  let activeRuns = [];
  try {
    activeRuns = runs.listActive(cwd) || [];
  } catch {
    activeRuns = [];
  }

  const runsActiveModel = activeRuns.map((r) => {
    let phase = '—';
    if (r.kind === 'milestone') {
      try {
        const state = forgeState.read(cwd, r.id);
        if (state) phase = state.phase || '—';
      } catch {
        // keep '—'
      }
    }
    const age = now - (r.last_heartbeat || 0);
    return {
      id: r.id,
      kind: r.kind,
      phase,
      heartbeat_age_ms: age,
      stale: age > STALE_MS,
      isolation_mode: r.isolation_mode || 'shared',
      session_id: r.session_id || null,
      task_description: r.task_description || null,
    };
  });

  const focus = resolveFocus(cwd, opts.milestoneId, activeRuns);
  if (focus.error) warnings.push(focus.error);

  let milestoneModel = null;
  const focusedId = focus.focused;

  if (focusedId) {
    let state = null;
    try {
      state = forgeState.read(cwd, focusedId);
    } catch {
      state = null;
    }
    if (!state) {
      warnings.push(`estado não encontrado para ${focusedId} — campos exibidos como '—'`);
    }

    let roadmapParsed = { title: null, slices: [] };
    try {
      const roadmapPath = path.join(cwd, '.gsd', 'milestones', focusedId, `${focusedId}-ROADMAP.md`);
      if (fs.existsSync(roadmapPath)) {
        const text = fs.readFileSync(roadmapPath, 'utf8');
        roadmapParsed = parseRoadmap(text);
      } else {
        warnings.push('ROADMAP não encontrado — árvore de slices omitida');
      }
    } catch {
      warnings.push('ROADMAP não encontrado — árvore de slices omitida');
    }

    const activeSlice = state ? state.active_slice : null;
    const activeTask = state ? state.active_task : null;

    let doneCount = 0;
    const slices = (roadmapParsed.slices || []).map((s) => {
      if (s.checked) doneCount++;
      let status = 'pending';
      if (s.checked) status = 'done';
      else if (activeSlice && activeSlice !== '—' && s.id === activeSlice) status = 'active';

      // Tasks are expanded for EVERY slice that has a PLAN.md (default view).
      // A missing plan only warns on the active slice — pending slices
      // legitimately have no plan yet, and cleaned-up slices may have lost it.
      // Task ids repeat across slices (each slice has its own T01..), so the
      // 'active' status only applies inside the active slice.
      let tasks = [];
      const isActiveSlice = Boolean(activeSlice && activeSlice !== '—' && s.id === activeSlice);
      try {
        const sliceDir = path.join(cwd, '.gsd', 'milestones', focusedId, 'slices', s.id);
        const planPath = path.join(sliceDir, `${s.id}-PLAN.md`);
        if (fs.existsSync(planPath)) {
          const planText = fs.readFileSync(planPath, 'utf8');
          const parsedTasks = parsePlanTasks(planText);
          tasks = parsedTasks.map((t) => {
            // The plan checkbox is not reliably ticked by executors — completion
            // ground truth is the slice checkbox (complete-slice only runs after
            // all tasks) or the task's own T##-SUMMARY.md (written on execution).
            let done = t.checked || s.checked;
            if (!done) {
              try {
                done = fs.existsSync(path.join(sliceDir, 'tasks', t.id, `${t.id}-SUMMARY.md`));
              } catch { /* degrade to plan checkbox */ }
            }
            let tStatus = 'pending';
            if (done) tStatus = 'done';
            else if (isActiveSlice && activeTask && activeTask !== '—' && t.id === activeTask) tStatus = 'active';
            return { id: t.id, title: t.title, checked: done, status: tStatus };
          });
        } else if (isActiveSlice) {
          warnings.push(`${s.id}-PLAN.md não encontrado — tasks omitidas`);
        }
      } catch {
        if (isActiveSlice) warnings.push(`${s.id}-PLAN.md não encontrado — tasks omitidas`);
      }

      return { id: s.id, title: s.title, checked: s.checked, risk: s.risk || null, status, tasks };
    });

    milestoneModel = {
      id: focusedId,
      title: roadmapParsed.title || focusedId,
      phase: state ? state.phase : '—',
      active_slice: state ? state.active_slice : '—',
      active_task: state ? state.active_task : '—',
      auto_mode: state ? state.auto_mode : '—',
      next_action: state ? state.next_action : '—',
      progress: { done: doneCount, total: slices.length },
      slices,
    };
    const time = readMilestoneTime(cwd, focusedId);
    if (time) milestoneModel.time = time;
  }

  let autonomousTasks = [];
  try {
    autonomousTasks = scanAutonomousTasks(cwd);
  } catch {
    autonomousTasks = [];
  }
  // Workspace scope: linked tasks gain the same closed block; unlinked entries stay identical.
  autonomousTasks = autonomousTasks.map((task) => withLinkedTask(cwd, task, opts));

  return {
    scope: 'workspace',
    cwd,
    generated_at: new Date().toISOString(),
    runs: {
      active: runsActiveModel,
      focused: focusedId || null,
      note: focus.note || null,
    },
    milestone: milestoneModel,
    autonomous_tasks: autonomousTasks,
    warnings,
    not_found: focus.not_found || null,
  };
}

// ── renderTree ───────────────────────────────────────────────────────────────
// Pure string builder over the model produced by collect(). No fs access here
// — S03's --watch calls collect()+renderTree() per refresh; any fs read here
// would double the torn-read surface. Mirrors skills/forge-status/SKILL.md
// dashboard template (icons, markers) minus the tokens/version blocks.
const STATUS_PT = {
  done: 'concluída',
  in_progress: 'em andamento',
  pending: 'pendente',
};

// ── ANSI colors ──────────────────────────────────────────────────────────────
// Opt-in per render call ({color: true}). The CLI only enables colors on a
// real TTY (respecting NO_COLOR and --color/--no-color) — piped output (the
// /forge-status chat shim, --json consumers, tests) stays byte-identical to
// the plain render. Invariant: stripping /\x1b\[[0-9;]*m/g from a colored
// render yields exactly the plain render.
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function makePaint(enabled) {
  const wrap = (code) => (enabled ? (s) => code + s + ANSI.reset : (s) => s);
  return {
    header: wrap(ANSI.bold),
    id: wrap(ANSI.cyan),
    done: wrap(ANSI.green),
    active: wrap(ANSI.yellow),
    warn: wrap(ANSI.yellow),
    dim: wrap(ANSI.dim),
  };
}

// Time block rendering — pure over model.time, shared by every scope.
const TIME_STATE_PT = {
  active: 'ativo',
  warning: 'aviso',
  exhausted: 'esgotado',
  draining: 'em drain',
  checkpointed: 'em checkpoint',
  extended: 'estendido',
  'endpoint-proven': 'marco final comprovado (consumo congelado)',
};
const TASK_STATE_PT = {
  'not-started': 'não iniciada',
  active: 'ativa',
  exhausted: 'no teto',
  draining: 'em drain',
  checkpointed: 'em checkpoint',
  extended: 'estendida',
  completed: 'encerrada',
  'chain-closed': 'cadeia encerrada',
  unknown: 'desconhecido',
};
const LIFECYCLE_PT = {
  blocked: 'bloqueada (predecessora não comprovada)',
  'handoff-ready': 'handoff pronto',
  open: 'aberta',
  started: 'iniciada',
  closed: 'encerrada',
  'chain-closed': 'cadeia encerrada',
  invalid: 'inválida',
};
const FORECAST_PT = { fits: 'cabe no saldo', 'at-risk': 'em risco', exceeds: 'excede o saldo', unknown: 'desconhecida' };
const ENDPOINT_PT = { publication: 'publicação', installation: 'instalação', 'manual-uat': 'UAT manual', 'external-waits': 'esperas externas' };
const ENDPOINT_STATE_PT = { included: 'incluída', pending: 'pendente', completed: 'concluída', deferred: 'adiada', 'not-applicable': 'não se aplica' };

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'desconhecido';
  const value = Math.max(0, Math.round(ms));
  if (value < 60_000) return `${Math.floor(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}min`;
  const minutes = Math.floor(value / 60_000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`;
}

function workerEffortText(worker) {
  const coverage = worker.coverage || {};
  const covered = `${Number.isInteger(coverage.covered) ? coverage.covered : '?'}/${Number.isInteger(coverage.units) ? coverage.units : '?'} unidades cobertas`;
  if (worker.status === 'complete') return `${fmtDuration(worker.worker_ms)} (cobertura completa, ${covered})`;
  if (worker.status === 'partial') return `parcial, ao menos ${fmtDuration(worker.observed_worker_ms)} observados (${covered})`;
  return `desconhecido (${covered}; ${worker.reason || 'sem evidência observada'})`;
}

function timeLines(time) {
  if (time.contract !== 'valid') {
    return [
      `Contrato de tempo inválido; estado desconhecido (${time.unknowns.join(', ') || 'motivo desconhecido'})`,
      `Diagnóstico: ${time.diagnostic}`,
    ];
  }
  const lines = [`Estado: ${TIME_STATE_PT[time.state] || 'desconhecido'}`];
  const endpoint = time.horizon && time.horizon.endpoint
    ? Object.entries(time.horizon.endpoint).map(([key, value]) => `${ENDPOINT_PT[key]}: ${ENDPOINT_STATE_PT[value] || 'desconhecido'}`).join(', ')
    : 'desconhecido';
  lines.push(`Horizonte: teto ${fmtDuration(time.horizon && time.horizon.ceiling_ms)}; marco final: entrega integrada verificada (${endpoint})`);
  lines.push(`Consumido: ${fmtDuration(time.consumed_ms)} (sem atribuição: ${fmtDuration(time.unknown_ms)}); decorrido desde a ativação: ${fmtDuration(time.elapsed_ms)}`);
  const remaining = time.remaining_ms;
  lines.push(`Saldo: ${!Number.isFinite(remaining) ? 'desconhecido' : remaining > 0 ? fmtDuration(remaining) : `esgotado (estouro de ${fmtDuration(-remaining)})`}`);
  const range = Number.isFinite(time.forecast.low_ms)
    ? ` (restante estimado ${fmtDuration(time.forecast.low_ms)} a ${Number.isFinite(time.forecast.high_ms) ? fmtDuration(time.forecast.high_ms) : 'desconhecido'})` : '';
  lines.push(`Previsão: ${FORECAST_PT[time.forecast.status] || FORECAST_PT.unknown}${range}; base: entregas históricas (historical-delivery), sem aceite integrado atual`);
  if (time.effort) {
    lines.push(`Esforço: intervalos de unidade do controlador (proxy, não é esforço de worker) ${fmtDuration(time.effort.unit_interval_sum_ms)}; esforço observado de workers: ${workerEffortText(time.effort.worker)}`);
  } else {
    lines.push('Esforço: desconhecido');
  }
  if (time.last_warning) {
    lines.push(`Último aviso: ${FORECAST_PT[time.last_warning.classification] || 'desconhecido'} (${time.last_warning.id.slice(0, 12)})`);
  }
  if (time.open_writers > 0) lines.push(`Writers em voo: ${time.open_writers}, terminando pela própria vigilância`);
  if (time.checkpoint) {
    lines.push(`Checkpoint: ${time.checkpoint.decision_pending ? 'decisão pendente' : 'sem decisão pendente'}; estouro ${fmtDuration(time.checkpoint.overshoot_ms)}`);
  }
  if (time.endpoint) lines.push(`Marco final comprovado em ${time.endpoint.at}; consumo congelado nessa prova (${time.endpoint.sha256.slice(0, 12)})`);
  if (time.task) {
    lines.push(`Teto da milestone governa as operações da milestone; task ligada ${time.task.task_id || 'desconhecida'}: ${TASK_STATE_PT[time.task.state] || 'desconhecido'}, `
      + `teto ${fmtDuration(time.task.ceiling_ms)} (governa as operações da task), consumido ${fmtDuration(time.task.consumed_ms)}, saldo ${saldoText(time.task.remaining_ms)}`);
    if (time.chain) lines.push(chainText(time.chain));
  }
  if (time.unknowns.length) lines.push(`Desconhecido: ${time.unknowns.join(', ')}`);
  lines.push(`Diagnóstico: ${time.diagnostic}`);
  return lines;
}

function saldoText(remaining) {
  return !Number.isFinite(remaining) ? 'desconhecido' : remaining > 0 ? fmtDuration(remaining) : `esgotado (estouro de ${fmtDuration(-remaining)})`;
}

function chainText(chain) {
  const forecast = Number.isFinite(chain.forecast_low_ms)
    ? `; previsão ${fmtDuration(chain.forecast_low_ms)} a ${Number.isFinite(chain.forecast_high_ms) ? fmtDuration(chain.forecast_high_ms) : 'desconhecido'}` : '';
  return `Cadeia: teto derivado (soma, não governa nenhuma operação) ${fmtDuration(chain.cap_ms)}; consumido ${fmtDuration(chain.consumed_ms)}${forecast}; `
    + `${chain.completed ? 'concluída (marco final e encerramento da task)' : 'não concluída'}`;
}

// Closed `linked` block of a linked task, pure over the projection.
function linkedLines(linked) {
  if (!linked.task) return [`Ciclo: ${LIFECYCLE_PT[linked.lifecycle] || 'inválido'}; horizonte ilegível (desconhecido)`];
  const lines = [`Ciclo: ${LIFECYCLE_PT[linked.lifecycle] || 'inválido'}; estado da task: ${TASK_STATE_PT[linked.task.state] || 'desconhecido'}`];
  lines.push(`Task: teto ${fmtDuration(linked.task.ceiling_ms)} (governa as operações da task${linked.task.extensions ? `; ${linked.task.extensions} extensão(ões)` : ''}); `
    + `consumido ${fmtDuration(linked.task.consumed_ms)} (sem atribuição: ${fmtDuration(linked.task.unknown_ms)}); saldo ${saldoText(linked.task.remaining_ms)}`);
  if (linked.milestone) {
    lines.push(`Milestone ${linked.milestone_id || 'desconhecida'}: teto ${fmtDuration(linked.milestone.ceiling_ms)} (governa as operações da milestone); `
      + `consumido ${fmtDuration(linked.milestone.consumed_ms)} (${linked.milestone.frozen ? 'congelado no marco final' : 'vivo'}); `
      + `marco final ${linked.milestone.endpoint_proven ? 'comprovado' : 'não comprovado'}`);
  }
  if (linked.chain) lines.push(chainText(linked.chain));
  lines.push(`Decisão pendente: ${linked.decision_pending ? 'sim' : 'não'}`);
  if (linked.unknown) lines.push('Desconhecido: há valores sem fonte (exibidos como desconhecidos)');
  return lines;
}

function renderTree(model, opts) {
  if (model && model.scope !== 'workspace' && Array.isArray(model.works)) {
    const labels = { pending: 'Pendência', acceptances: 'Aceite registrado', lastResult: 'Resultado registrado', handoff: 'Continuidade', nextAction: 'Próxima ação' };
    const validity = { current: 'atual', stale: 'fonte alterada', missing: 'fonte ausente', unreadable: 'fonte ilegível' };
    const reasons = { snapshot: 'evidências dos trabalhos vinculados', 'no-bindings': 'nenhum vínculo pessoal', 'explicit-inspection': 'inspeção solicitada; nenhum vínculo criado' };
    const situation = { completed: 'concluído', pending: 'pendente', unknown: 'situação desconhecida', open: 'em aberto', active: 'ativo', inactive: 'inativo' };
    const lines = [`## Contexto ${model.scope === 'inspection' ? 'solicitado (inspeção)' : 'pessoal'}`, '', `Diagnóstico: ${reasons[model.reason] || model.reason}`];
    for (const work of model.works) {
      lines.push('', `${work.id} — ${situation[work.workStatus]}; processo: ${situation[work.activity] || 'desconhecido'}`);
      if (work.reliability !== 'current') lines.push(`Conferir evidências: ${work.reliability}`);
      if (work.nextAction) lines.push(`Próxima ação: ${work.nextAction.text}`);
      if (work.lastResult) lines.push(`Último resultado comprovado: ${work.lastResult.text} — ${work.lastResult.source}`);
      for (const [field, captures] of Object.entries(work.checkpoint)) for (const capture of captures) {
        if ((field === 'nextAction' && work.nextAction === capture) || (field === 'lastResult' && work.lastResult === capture)) continue;
        lines.push(`- ${labels[field]}: ${capture.text} [${validity[capture.validity]}${capture.resolved ? ', resolvido' : ''}] — ${capture.source} (${capture.capturedAt.slice(0, 10)})`);
      }
      if (work.nextAction && work.nextAction.source) lines.push(`Fonte da próxima ação: ${work.nextAction.source}`);
      if (work.terminalEvidence.source) lines.push(`Fonte atual: ${work.terminalEvidence.source}`);
      if (work.time) {
        lines.push('Tempo da milestone:');
        for (const line of timeLines(work.time)) lines.push(`- ${line}`);
      }
      if (work.linked) {
        lines.push('Horizonte da task ligada:');
        for (const line of linkedLines(work.linked)) lines.push(`- ${line}`);
      }
    }
    return lines.join('\n') + '\n';
  }
  const paint = makePaint(Boolean(opts && opts.color));
  const lines = [];

  if (!model || model.milestone === null) {
    lines.push(paint.header('## Status GSD — workspace (diagnóstico global)'));
    lines.push('');
    lines.push('Nenhum run ativo. Execute /forge-auto <M-id> ou /forge-task <descrição> para começar.');
    if (model && Array.isArray(model.warnings) && model.warnings.length > 0) {
      lines.push('');
      for (const w of model.warnings) lines.push(paint.warn(`⚠ ${w}`));
    }
    return lines.join('\n') + '\n';
  }

  const m = model.milestone;

  lines.push(paint.header('## Status GSD — workspace (diagnóstico global)'));
  lines.push('');
  lines.push(`**Milestone ativo:** ${paint.id(m.id)} — ${m.title}`);
  lines.push(`**Fase:** ${m.phase}`);

  const activeRun = (model.runs && Array.isArray(model.runs.active))
    ? model.runs.active.find((r) => r.id === m.id)
    : null;
  if (activeRun) {
    const staleChip = activeRun.stale ? paint.warn(' ⚠ STALE') : '';
    lines.push(`**Run:** ${activeRun.kind} · heartbeat ${fmtAgo(activeRun.heartbeat_age_ms)}${staleChip}`);
  }

  lines.push(`**Progresso:** ${m.progress.done}/${m.progress.total} slices concluídos`);

  if (model.runs && model.runs.note) {
    lines.push(`**Nota:** ${model.runs.note}`);
  }

  if (m.time) {
    lines.push('');
    lines.push(paint.header('### Tempo da milestone'));
    for (const line of timeLines(m.time)) lines.push(`- ${line}`);
  }

  lines.push('');
  lines.push(paint.header('### Slices'));
  if (Array.isArray(m.slices) && m.slices.length > 0) {
    for (const s of m.slices) {
      const box = s.checked ? paint.done('[x]') : '[ ]';
      const activeSuffix = s.status === 'active' ? paint.active('  ← ativo') : '';
      lines.push(`- ${box} ${paint.id(s.id)}: ${s.title}${activeSuffix}`);
      if (Array.isArray(s.tasks)) {
        for (const t of s.tasks) {
          const tBox = t.checked ? paint.done('[x]') : '[ ]';
          const tActiveSuffix = t.status === 'active' ? paint.active('  ← ativa') : '';
          lines.push(`  - ${tBox} ${paint.id(t.id)}: ${t.title}${tActiveSuffix}`);
        }
      }
    }
  } else {
    lines.push('—');
  }

  lines.push('');
  lines.push(paint.header('### Próxima ação'));
  lines.push(m.next_action || '—');

  if (Array.isArray(model.autonomous_tasks) && model.autonomous_tasks.length > 0) {
    lines.push('');
    lines.push(paint.header('### Tasks autônomas'));
    for (const t of model.autonomous_tasks) {
      let icon = '·';
      if (t.status === 'done') icon = paint.done('✓');
      else if (t.status === 'in_progress') icon = paint.active('▶');
      const statusPt = STATUS_PT[t.status] || t.status;
      lines.push(`${icon} ${paint.id(t.id)}: ${t.description} (${statusPt})`);
      if (t.linked) for (const line of linkedLines(t.linked)) lines.push(`  - ${line}`);
    }
  }

  if (Array.isArray(model.warnings) && model.warnings.length > 0) {
    lines.push('');
    for (const w of model.warnings) lines.push(paint.warn(`⚠ ${w}`));
  }

  return lines.join('\n') + '\n';
}

// ── renderTokensBlock ────────────────────────────────────────────────────────
// Pure string builder over the model produced by forge-tokens.aggregate() (T01).
// No fs access here — the aggregate() read happens in cliMain only. Mirrors
// skills/forge-status/SKILL.md § "Token usage" legacy block format.
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatTokenMeasurement(agg) {
  const sources = agg && agg.token_sources;
  if (!sources || typeof sources !== 'object') return 'não declarada (eventos legados)';

  const labels = {
    estimated: 'estimada (chars/4)',
    reported: 'reportada (provedor/OTel)',
    unknown: 'método não declarado',
  };
  const parts = [];
  for (const kind of ['estimated', 'reported', 'unknown']) {
    const count = sources[kind] && Number.isFinite(sources[kind].count) ? sources[kind].count : 0;
    if (count > 0) parts.push(`${labels[kind]}: ${count}`);
  }
  if (parts.length === 0) return 'sem dados de tokens';
  if (parts.length === 1) return parts[0];
  return `mista — ${parts.join(' · ')}`;
}

function renderTokensBlock(agg, opts) {
  const paint = makePaint(Boolean(opts && opts.color));
  if (!agg) {
    return '';
  }

  // R2 fix: when aggregate() reports a non-attributable/fallback source
  // (per-milestone membership missing/empty), never print cross-milestone
  // numbers under this milestone's label — render an honest note instead.
  if (agg.source === 'unattributable') {
    return `${paint.header(`### Token usage (${agg.milestone || '—'})`)}\n(sem telemetria atribuível a este milestone)\n`;
  }

  if (agg.has_telemetry === false) {
    return '';
  }

  const lines = [];
  lines.push(paint.header(`### Token usage (${agg.milestone || '—'})`));
  lines.push(`- Total input:  ${fmtInt(agg.total_input)} tokens`);
  lines.push(`- Total output: ${fmtInt(agg.total_output)} tokens`);
  lines.push(`- Medição:      ${formatTokenMeasurement(agg)}`);

  const phases = Object.keys(agg.by_phase || {});
  const phaseSummary = phases
    .map((p) => `${p} ${agg.by_phase[p].count}`)
    .join(' · ');
  lines.push(`- Dispatches:   ${agg.dispatch_count} (por fase: ${phaseSummary || '—'})`);

  if (agg.has_token_data === false) {
    lines.push('(sem dados de token registrados)');
  }

  return lines.join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// parseArgs convention copied from scripts/forge-runs.js (~L238) for
// consistency across project CLIs, extended here to also capture the first
// non-flag token as the positional <M-id>.
// Flags that consume the next token as their value. Everything else is boolean.
// Reserve --tokens here so it doesn't accidentally swallow a positional M-id.
// --watch uses the inline '=' form (--watch=<seconds>) instead of VALUE_FLAGS —
// see the '=' split below, checked BEFORE the VALUE_FLAGS/boolean branch.
const VALUE_FLAGS = new Set(['--cwd', '--scope']);

function parseArgs(argv) {
  const args = {};
  let positional = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx !== -1) {
        const key = a.slice(2, eqIdx);
        const val = a.slice(eqIdx + 1);
        args[key] = val;
        continue;
      }
      if (VALUE_FLAGS.has(a)) {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++; }
        else { args[a.slice(2)] = true; } // malformed but tolerated
      } else {
        args[a.slice(2)] = true;
      }
      continue;
    }
    if (positional === null) positional = a;
  }
  args._positional = positional;
  return args;
}

const HELP_TEXT = `forge-status — dashboard de status GSD (somente leitura)

Uso:
  node scripts/forge-status.js [<M-id>] [--cwd <path>] [--help]

Argumentos:
  <M-id>            (opcional) foca um milestone específico pelo id
  --cwd <path>       diretório do projeto (default: diretório atual). Use
                      esta flag como escape hatch ao rodar de dentro de um
                      worktree — aponte --cwd para o workspace original onde
                      o .gsd/ realmente vive.
  --help             mostra esta ajuda e sai
  --json             emite o modelo de status como JSON (best-effort v1) e sai
  --scope workspace  diagnóstico global explícito; padrão: contexto pessoal
  --tokens           anexa um bloco de uso de tokens agregado de events.jsonl
  --color            força cores ANSI mesmo sem TTY
  --no-color         desliga cores. Default: auto — cores só em TTY real,
                      respeitando NO_COLOR; saída piped (shim /forge-status,
                      pipes, testes) permanece sem códigos ANSI
  --watch[=<seg>]    re-renderiza a árvore em loop (append, sem limpar a
                      tela; default 3s; Ctrl+C encerra). Pure-read — seguro
                      num 2º terminal ao lado de /forge-auto. Ignora --json.

Garantia: forge-status é estritamente somente-leitura — nunca escreve em
.gsd/**. Flags desconhecidas são toleradas silenciosamente para compatibilidade
futura.
`;

// ── emitHumanRender ──────────────────────────────────────────────────────────
// Shared render path for the single-shot and --watch CLI branches: writes the
// human tree render, then (if args.tokens) the aggregated token block. Never
// touches fs directly beyond what renderTree/aggregate already do.
function emitHumanRender(model, cwd, args) {
  const renderOpts = { color: Boolean(args._color) };
  process.stdout.write(renderTree(model, renderOpts));

  if (args.tokens && model.scope === 'workspace') {
    const focusedId = (model.runs && model.runs.focused) || (model.milestone && model.milestone.id) || null;
    try {
      if (focusedId) {
        const agg = tokens.aggregate(cwd, { milestoneId: focusedId });
        const block = renderTokensBlock(agg, renderOpts);
        process.stdout.write('\n' + (block || 'Sem dados de telemetria ainda.\n'));
      } else {
        process.stdout.write('\nSem dados de telemetria ainda.\n');
      }
    } catch {
      process.stdout.write('\nSem dados de telemetria ainda.\n');
    }
  }
}

// ── runWatch ─────────────────────────────────────────────────────────────────
// Append/diff-mode refresh loop (LOCKED — see S03-PLAN.md § Design decision):
// NEVER clears the screen. Each frame re-runs collect()+renderTree() (via
// emitHumanRender) and appends the render to stdout, preserving scrollback.
// Pure-read absolute: zero writes to .gsd/**, no lock acquired.
function runWatch(cwd, args) {
  // R1 fix: interval resolution. `--watch` (bare, args.watch === true) or
  // `--watch=` (empty string, args.watch === '') both fall back to the
  // default interval (3s). A clearly non-numeric or non-positive value
  // (e.g. `--watch=abc`, `--watch=0`, `--watch=-1`) is rejected outright
  // with a pt-BR error and exit 2 — we don't silently clamp a value the
  // user typed wrong, only an *absent* value.
  let intervalMs;
  if (args.watch === true || args.watch === '') {
    intervalMs = 3000;
  } else {
    const s = parseFloat(args.watch);
    if (!Number.isFinite(s) || s <= 0) {
      process.stderr.write(`Argumento inválido: --watch=${args.watch} — esperado um número de segundos maior que zero (ex.: --watch=5).\n`);
      process.exit(2);
      return;
    }
    intervalMs = s * 1000;
  }

  // R3 fix: a non-negative integer cap N means EXACTLY N frames — including
  // N=0 (render zero frames, exit immediately, checked BEFORE the first
  // frame() call). Negative or non-integer/NaN values are treated as
  // uncapped (documented here, not just in the check below).
  const maxRaw = parseInt(process.env.FORGE_STATUS_WATCH_MAX, 10);
  const capped = Number.isInteger(maxRaw) && maxRaw >= 0;
  const max = capped ? maxRaw : Infinity; // negative/NaN => uncapped

  if (capped && max === 0) {
    process.exit(0);
    return;
  }

  let count = 0;
  let timer = null;
  let stopped = false;

  function divider(n) {
    const line = `─── refresh #${n + 1} @ ${new Date().toISOString()} ───`;
    return '\n' + makePaint(Boolean(args._color)).dim(line) + '\n';
  }

  function frame() {
    if (stopped) return;
    try {
      const model = collect(cwd, { milestoneId: args._positional || null, scope: args.scope });
      // R4 fix: a milestone that doesn't exist must fail fast, exactly like
      // the single-shot path does, instead of looping forever re-rendering
      // the same not_found state. A milestone that exists but is missing
      // STATE.md (degraded, not not_found) still watches normally.
      if (model.not_found && model.not_found.code === 'not_found') {
        stopped = true;
        if (timer) clearInterval(timer);
        process.stderr.write(`Milestone não encontrado: ${model.not_found.id}\n`);
        process.exit(2);
        return;
      }
      process.stdout.write(divider(count));
      emitHumanRender(model, cwd, args);
    } catch (e) {
      process.stdout.write('\n⚠ refresh falhou (torn read?): ' + (e && e.message ? e.message : e) + '\n');
    }
    count++;
    if (count >= max) {
      stopped = true;
      if (timer) clearInterval(timer);
      process.exit(0);
      return;
    }
  }

  // Race-safety requirement: the SIGINT handler MUST be registered BEFORE the
  // first observable output (frame()). A caller that waits for stdout output
  // as a "child is ready" signal is only correct if the handler installation
  // precedes that output — otherwise a signal delivered right after the first
  // frame can still hit the process before the handler exists, falling back
  // to the POSIX default disposition (terminate with 130 instead of a clean
  // exit 0). See scripts/forge-status.test.js R2.
  process.on('SIGINT', () => {
    stopped = true;
    if (timer) clearInterval(timer);
    process.stdout.write('\n');
    process.exit(0);
  });

  frame();
  if (stopped) return;
  timer = setInterval(frame, intervalMs);
}

// Color mode: --no-color > --color > NO_COLOR env > TTY autodetect.
// Presence-gated (hasOwnProperty) like --watch/--cwd — the S03-R5 '=value'
// coercion quirk applies to every boolean flag equally.
function resolveColorMode(args) {
  if (Object.prototype.hasOwnProperty.call(args, 'no-color')) return false;
  if (Object.prototype.hasOwnProperty.call(args, 'color')) return true;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  args._color = resolveColorMode(args);

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(args, 'cwd') && typeof args.cwd !== 'string') {
    process.stderr.write('Argumento inválido: --cwd requer um valor de caminho (ex.: --cwd /path/to/project).\n');
    process.exit(2);
    return;
  }

  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  if (args.scope !== undefined && !['personal', 'workspace'].includes(args.scope)) {
    process.stderr.write('Invalid --scope: use personal or workspace.\n');
    process.exitCode = 2;
    return;
  }

  let hasGsd = false;
  try {
    hasGsd = fs.existsSync(path.join(cwd, '.gsd'));
  } catch {
    hasGsd = false;
  }
  if (!hasGsd && args.scope === 'workspace') {
    process.stderr.write('Nenhum projeto GSD encontrado neste diretório. Execute /forge-init para começar.\n');
    process.exit(1);
    return;
  }

  const milestoneId = args._positional || null;
  if (milestoneId) {
    if (!ids.isValid(milestoneId) || !['task', 'milestone'].includes(ids.entityKind(milestoneId))) {
      process.stderr.write(`Id inválido: ${milestoneId} — esperado um id de milestone ou task (ex.: M-20260101000000-slug ou TASK-001).\n`);
      process.exit(2);
      return;
    }
  }

  // R1 fix: gate on presence (hasOwnProperty), not truthiness — `--watch=`
  // (empty value) sets args.watch = '' which is falsy under `if (args.watch)`
  // and silently fell through to the single-shot path. Mirrors the --cwd
  // hasOwnProperty pattern above.
  if (Object.prototype.hasOwnProperty.call(args, 'watch')) {
    // --watch ignores --json (human tree render only, per-frame append loop).
    runWatch(cwd, args);
    return;
  }

  try {
    const model = collect(cwd, { milestoneId, scope: args.scope });
    if (args.json) {
      // --json is programmatic consumption: emit the full collect() model
      // as-is (including not_found, if any) and exit 0 — the consumer
      // inspects model.not_found itself, unlike the human render path
      // below which exits 2 on not_found. best-effort v1, no tokens.
      process.stdout.write(JSON.stringify(model, null, 2) + '\n');
      process.exit(model.status === 'error' ? 1 : 0);
      return;
    }
    if (model.not_found && model.not_found.code === 'not_found') {
      process.stderr.write(`Milestone não encontrado: ${model.not_found.id}\n`);
      process.exit(2);
      return;
    }
    emitHumanRender(model, cwd, args);

    process.exit(model.status === 'error' ? 1 : 0);
  } catch (err) {
    process.stderr.write(`forge-status error: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  parseRoadmap,
  parsePlanTasks,
  scanAutonomousTasks,
  resolveFocus,
  collect,
  renderTree,
  timeLines,
  renderTokensBlock,
  formatTokenMeasurement,
  runWatch,
};
