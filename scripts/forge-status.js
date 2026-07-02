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
//   3. Exports contract: collect/renderTree land in T02/T03. This file (T01)
//      exports only the tree parsers: parseRoadmap, parsePlanTasks,
//      scanAutonomousTasks.
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
    const sliceRe = /^- \[( |x)\]\s+\*\*(S\d+):\s*(.+?)\*\*(?:.*?`risk:(\w+)`)?/gm;
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

// collect() and renderTree() land in T02/T03 respectively — not implemented here.

module.exports = {
  parseRoadmap,
  parsePlanTasks,
  scanAutonomousTasks,
};
