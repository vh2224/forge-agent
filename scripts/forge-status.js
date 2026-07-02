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
      slices.push({
        checked: m[1] === 'x',
        id: m[2],
        title: (m[3] || '').trim(),
        risk: m[4] || null,
      });
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

// ── collect ──────────────────────────────────────────────────────────────────
// Assembles the full status model per S01-PLAN.md § Shared contract. Pure-read,
// torn-read tolerant end to end. opts = { milestoneId }.
function collect(cwd, opts) {
  opts = opts || {};
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

      let tasks = [];
      if (activeSlice && activeSlice !== '—' && s.id === activeSlice) {
        try {
          const planPath = path.join(cwd, '.gsd', 'milestones', focusedId, 'slices', s.id, `${s.id}-PLAN.md`);
          if (fs.existsSync(planPath)) {
            const planText = fs.readFileSync(planPath, 'utf8');
            const parsedTasks = parsePlanTasks(planText);
            tasks = parsedTasks.map((t) => {
              let tStatus = 'pending';
              if (t.checked) tStatus = 'done';
              else if (activeTask && activeTask !== '—' && t.id === activeTask) tStatus = 'active';
              return { id: t.id, title: t.title, checked: t.checked, status: tStatus };
            });
          } else {
            warnings.push(`${s.id}-PLAN.md não encontrado — tasks omitidas`);
          }
        } catch {
          warnings.push(`${s.id}-PLAN.md não encontrado — tasks omitidas`);
        }
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
  }

  let autonomousTasks = [];
  try {
    autonomousTasks = scanAutonomousTasks(cwd);
  } catch {
    autonomousTasks = [];
  }

  return {
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

function renderTree(model) {
  const lines = [];

  if (!model || model.milestone === null) {
    lines.push('## Status GSD');
    lines.push('');
    lines.push('Nenhum run ativo. Execute /forge-auto <M-id> ou /forge-task <descrição> para começar.');
    if (model && Array.isArray(model.warnings) && model.warnings.length > 0) {
      lines.push('');
      for (const w of model.warnings) lines.push(`⚠ ${w}`);
    }
    return lines.join('\n') + '\n';
  }

  const m = model.milestone;

  lines.push('## Status GSD');
  lines.push('');
  lines.push(`**Milestone ativo:** ${m.id} — ${m.title}`);
  lines.push(`**Fase:** ${m.phase}`);

  const activeRun = (model.runs && Array.isArray(model.runs.active))
    ? model.runs.active.find((r) => r.id === m.id)
    : null;
  if (activeRun) {
    const staleChip = activeRun.stale ? ' ⚠ STALE' : '';
    lines.push(`**Run:** ${activeRun.kind} · heartbeat ${fmtAgo(activeRun.heartbeat_age_ms)}${staleChip}`);
  }

  lines.push(`**Progresso:** ${m.progress.done}/${m.progress.total} slices concluídos`);

  if (model.runs && model.runs.note) {
    lines.push(`**Nota:** ${model.runs.note}`);
  }

  lines.push('');
  lines.push('### Slices');
  if (Array.isArray(m.slices) && m.slices.length > 0) {
    for (const s of m.slices) {
      const box = s.checked ? 'x' : ' ';
      const activeSuffix = s.status === 'active' ? '  ← ativo' : '';
      lines.push(`- [${box}] ${s.id}: ${s.title}${activeSuffix}`);
      if (s.status === 'active' && Array.isArray(s.tasks)) {
        for (const t of s.tasks) {
          const tBox = t.checked ? 'x' : ' ';
          const tActiveSuffix = t.status === 'active' ? '  ← ativa' : '';
          lines.push(`  - [${tBox}] ${t.id}: ${t.title}${tActiveSuffix}`);
        }
      }
    }
  } else {
    lines.push('—');
  }

  lines.push('');
  lines.push('### Próxima ação');
  lines.push(m.next_action || '—');

  if (Array.isArray(model.autonomous_tasks) && model.autonomous_tasks.length > 0) {
    lines.push('');
    lines.push('### Tasks autônomas');
    for (const t of model.autonomous_tasks) {
      let icon = '·';
      if (t.status === 'done') icon = '✓';
      else if (t.status === 'in_progress') icon = '▶';
      const statusPt = STATUS_PT[t.status] || t.status;
      lines.push(`${icon} ${t.id}: ${t.description} (${statusPt})`);
    }
  }

  if (Array.isArray(model.warnings) && model.warnings.length > 0) {
    lines.push('');
    for (const w of model.warnings) lines.push(`⚠ ${w}`);
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

function renderTokensBlock(agg) {
  if (!agg || agg.has_telemetry === false) {
    return '';
  }

  const lines = [];
  lines.push(`### Token usage (${agg.milestone || '—'})`);
  lines.push(`- Total input:  ${fmtInt(agg.total_input)} tokens`);
  lines.push(`- Total output: ${fmtInt(agg.total_output)} tokens`);

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
// Reserve --tokens and --watch here (S03) so they don't accidentally swallow
// a positional M-id when added later.
const VALUE_FLAGS = new Set(['--cwd']);

function parseArgs(argv) {
  const args = {};
  let positional = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
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
  --tokens           anexa um bloco de uso de tokens agregado de events.jsonl

Garantia: forge-status é estritamente somente-leitura — nunca escreve em
.gsd/**. Flags desconhecidas são toleradas silenciosamente para compatibilidade
futura (--watch chega em próximo slice).
`;

function cliMain() {
  const args = parseArgs(process.argv.slice(2));

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

  let hasGsd = false;
  try {
    hasGsd = fs.existsSync(path.join(cwd, '.gsd'));
  } catch {
    hasGsd = false;
  }
  if (!hasGsd) {
    process.stderr.write('Nenhum projeto GSD encontrado neste diretório. Execute /forge-init para começar.\n');
    process.exit(1);
    return;
  }

  const milestoneId = args._positional || null;
  if (milestoneId) {
    if (!ids.isValid(milestoneId) || ids.entityKind(milestoneId) !== 'milestone') {
      process.stderr.write(`Id inválido: ${milestoneId} — esperado um id de milestone (ex.: M-20260101000000-slug).\n`);
      process.exit(2);
      return;
    }
  }

  try {
    const model = collect(cwd, { milestoneId });
    if (args.json) {
      // --json is programmatic consumption: emit the full collect() model
      // as-is (including not_found, if any) and exit 0 — the consumer
      // inspects model.not_found itself, unlike the human render path
      // below which exits 2 on not_found. best-effort v1, no tokens.
      process.stdout.write(JSON.stringify(model, null, 2) + '\n');
      process.exit(0);
      return;
    }
    if (model.not_found && model.not_found.code === 'not_found') {
      process.stderr.write(`Milestone não encontrado: ${model.not_found.id}\n`);
      process.exit(2);
      return;
    }
    process.stdout.write(renderTree(model));

    if (args.tokens) {
      const focusedId = (model.runs && model.runs.focused) || (model.milestone && model.milestone.id) || null;
      try {
        if (focusedId) {
          const agg = tokens.aggregate(cwd, { milestoneId: focusedId });
          const block = renderTokensBlock(agg);
          process.stdout.write('\n' + (block || 'Sem dados de telemetria ainda.\n'));
        } else {
          process.stdout.write('\nSem dados de telemetria ainda.\n');
        }
      } catch {
        process.stdout.write('\nSem dados de telemetria ainda.\n');
      }
    }

    process.exit(0);
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
  renderTokensBlock,
};
