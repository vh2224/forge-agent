#!/usr/bin/env node
// forge-merger — Promote per-milestone files to workspace globals under lockfile
//
// Consumed by forge-completer in complete-milestone (and complete-task) step.
// Reads M###-DECISIONS.md, M###-AUTO-MEMORY.md, M###-CHECKER-MEMORY.md, M###-events.jsonl
// (or task-run pending_decisions/pending_memories), then appends/promotes to globals under
// .gsd/.locks/{name}/ via scripts/forge-lock.js.
//
// Library exports:
//   mergeMilestone(cwd, milestoneId, opts) → { merged: {decisions:N, memories:N, ledger:bool, checker:N, events:N}, errors: [] }
//   mergeTask(cwd, taskId, opts) → similar shape (no events/checker for tasks)
//
// CLI:
//   node forge-merger.js --milestone M065 [--cwd <path>] [--dry-run]
//   node forge-merger.js --task task-fix-typo-a3f2 [--cwd <path>]

'use strict';

const fs   = require('fs');
const path = require('path');

const lock = require('./forge-lock.js');
const runs = require('./forge-runs.js');

const AUTO_MEMORY_CAP = 50;
const LOCK_TTL_MS     = 30_000;

// ── Path helpers ────────────────────────────────────────────────────────────
function globalPath(cwd, name)        { return path.join(cwd, '.gsd', name); }
function milestoneDir(cwd, id)        { return path.join(cwd, '.gsd', 'milestones', id); }
function perMilestonePath(cwd, id, n) { return path.join(milestoneDir(cwd, id), `${id}-${n}`); }

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function safeReadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ── DECISIONS.md merger ─────────────────────────────────────────────────────
// Global format: markdown table with header `| ID | Decision | Rationale | Date |`
// followed by body rows. We append all rows from per-milestone file's body to global,
// sorted by Date column (col 4) ascending. Idempotent: rows with matching ID are not duplicated.

function parseDecisionsRows(text) {
  if (!text) return { header: null, rows: [] };
  const lines = text.split('\n');
  const rows = [];
  let header = null;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\|\s*ID\s*\|/.test(line)) {
      header = line;
      // skip separator (next line)
      inTable = true;
      i++;
      continue;
    }
    if (inTable && line.trim().startsWith('|')) {
      rows.push(line);
    } else if (inTable && line.trim() === '') {
      // tolerate blank lines between rows
      continue;
    } else if (inTable && line.trim().startsWith('#')) {
      // new section ends the table
      inTable = false;
    }
  }
  return { header, rows };
}

function extractIdFromRow(row) {
  const cells = row.split('|').map(c => c.trim()).filter(Boolean);
  return cells[0] || null;
}

function mergeDecisions(cwd, sourcePath) {
  const sourceText = safeRead(sourcePath);
  if (!sourceText) return { merged: 0, skipped: 0 };

  const source = parseDecisionsRows(sourceText);
  if (source.rows.length === 0) return { merged: 0, skipped: 0 };

  const target = globalPath(cwd, 'DECISIONS.md');
  const targetText = safeRead(target) || '';
  const targetParsed = parseDecisionsRows(targetText);
  const existingIds = new Set(targetParsed.rows.map(extractIdFromRow).filter(Boolean));

  const newRows = source.rows.filter(r => {
    const id = extractIdFromRow(r);
    return id && !existingIds.has(id);
  });

  if (newRows.length === 0) return { merged: 0, skipped: source.rows.length };

  let out;
  if (!targetText.trim()) {
    // Initialize the global file
    const header = source.header || '| ID | Decision | Rationale | Date |';
    const sep    = '|----|----------|-----------|------|';
    out = ['# Decisions', '', header, sep, ...newRows, ''].join('\n');
  } else {
    // Append to existing
    out = targetText.replace(/\n*$/, '\n') + newRows.join('\n') + '\n';
  }

  fs.writeFileSync(target, out, 'utf8');
  return { merged: newRows.length, skipped: source.rows.length - newRows.length };
}

// ── AUTO-MEMORY.md merger (with cap-50 + decay ordering) ────────────────────
// Format: markdown with `## <Category>` sections containing MEM### entries.
// Each entry: `### MEM### — <description>\n*confidence:0.85 hits:3 last_seen:...*\n<body>`.
// Strategy: parse both files as arrays of {id, category, description, confidence, hits, body},
// merge (dedup by description-similarity if id collides), sort by `confidence * (1 + hits*0.1)` desc, cap 50.

function parseMemories(text) {
  if (!text) return { header: '', entries: [] };
  const lines = text.split('\n');
  const headerLines = [];
  const entries = [];
  let headerDone = false;
  let i = 0;

  // Header = leading lines before first `## ` section
  while (i < lines.length && !lines[i].startsWith('## ')) {
    headerLines.push(lines[i]);
    i++;
  }
  headerDone = true;

  let currentCategory = null;
  let current = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const catMatch = line.match(/^##\s+(.+?)\s*$/);
    if (catMatch) {
      if (current) entries.push(current);
      current = null;
      currentCategory = catMatch[1].trim();
      continue;
    }
    const idMatch = line.match(/^###\s+(MEM[\w\-]*)\s+(?:—|--)\s+(.+?)\s*$/);
    if (idMatch) {
      if (current) entries.push(current);
      current = {
        id: idMatch[1],
        category: currentCategory || 'Uncategorized',
        description: idMatch[2],
        confidence: 0.7,
        hits: 0,
        last_seen: null,
        body: [],
      };
      continue;
    }
    if (current) {
      // Try to parse the metadata line: *confidence:X hits:Y last_seen:Z*
      const meta = line.match(/\*?\s*confidence:\s*([\d.]+)\s+hits:\s*(\d+)(?:\s+last_seen:\s*([\w./\\-]+))?\s*\*?/);
      if (meta && current.body.length === 0) {
        current.confidence = parseFloat(meta[1]);
        current.hits       = parseInt(meta[2], 10);
        current.last_seen  = meta[3] ? meta[3].trim() : null;
        continue;
      }
      current.body.push(line);
    } else {
      headerLines.push(line);
    }
  }
  if (current) entries.push(current);

  return { header: headerLines.join('\n').replace(/\n+$/, ''), entries };
}

function memoryScore(e) {
  return e.confidence * (1 + e.hits * 0.1);
}

function serializeMemories(entries, header) {
  // Group by category preserving original order
  const byCategory = {};
  const categoryOrder = [];
  for (const e of entries) {
    if (!byCategory[e.category]) {
      byCategory[e.category] = [];
      categoryOrder.push(e.category);
    }
    byCategory[e.category].push(e);
  }

  const out = [];
  if (header && header.trim()) out.push(header.trim(), '');
  for (const cat of categoryOrder) {
    out.push(`## ${cat}`);
    out.push('');
    for (const e of byCategory[cat]) {
      out.push(`### ${e.id} — ${e.description}`);
      const lastSeen = e.last_seen ? ` last_seen:${e.last_seen}` : '';
      out.push(`*confidence:${e.confidence.toFixed(2)} hits:${e.hits}${lastSeen}*`);
      const body = e.body.join('\n').trim();
      if (body) {
        out.push('');
        out.push(body);
      }
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

function mergeAutoMemory(cwd, sourcePath) {
  const sourceText = safeRead(sourcePath);
  if (!sourceText) return { merged: 0, dropped: 0 };

  const source = parseMemories(sourceText);
  if (source.entries.length === 0) return { merged: 0, dropped: 0 };

  const target = globalPath(cwd, 'AUTO-MEMORY.md');
  const targetText = safeRead(target) || '';
  const targetParsed = parseMemories(targetText);

  // Dedup by ID (per-milestone entries should use M###-prefixed IDs to avoid collision,
  // but if they don't, fall back to: same description = same memory)
  const targetById = new Map(targetParsed.entries.map(e => [e.id, e]));
  const targetByDesc = new Map(targetParsed.entries.map(e => [e.description.toLowerCase(), e]));

  let merged = 0;
  for (const src of source.entries) {
    const existing = targetById.get(src.id) || targetByDesc.get(src.description.toLowerCase());
    if (existing) {
      // Confirm: bump hits, keep higher confidence
      existing.hits += Math.max(src.hits, 1);
      existing.confidence = Math.min(0.95, Math.max(existing.confidence, src.confidence));
      if (src.last_seen) existing.last_seen = src.last_seen;
    } else {
      targetParsed.entries.push(src);
      merged++;
    }
  }

  // Apply cap-50 with decay ordering (confidence × (1 + hits × 0.1) desc)
  targetParsed.entries.sort((a, b) => memoryScore(b) - memoryScore(a));
  const before = targetParsed.entries.length;
  if (targetParsed.entries.length > AUTO_MEMORY_CAP) {
    targetParsed.entries = targetParsed.entries.slice(0, AUTO_MEMORY_CAP);
  }
  const dropped = before - targetParsed.entries.length;

  // Default header for fresh files
  const header = targetParsed.header || `<!-- gsd-auto-memory | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: ${AUTO_MEMORY_CAP} active -->`;

  fs.writeFileSync(target, serializeMemories(targetParsed.entries, header), 'utf8');
  return { merged, dropped };
}

// ── LEDGER.md merger ─────────────────────────────────────────────────────────
// Append a single milestone-summary block to the global LEDGER.md.
// Block format: `## M### — <name>\n<one-line summary>\nKey decisions: ...\nFiles touched: ...`
// We expect the per-milestone source to be ready-to-append (the completer writes it).

function mergeLedger(cwd, sourcePath) {
  const sourceText = safeRead(sourcePath);
  if (!sourceText || !sourceText.trim()) return { merged: false };

  const target = globalPath(cwd, 'LEDGER.md');
  const targetText = safeRead(target) || '# Ledger\n\n_Compact summary of completed milestones — append-only, survives milestone_cleanup._\n\n';

  // Idempotency: don't double-add if the source's first header already appears in target
  const firstHeaderMatch = sourceText.match(/^##\s+(.+)$/m);
  if (firstHeaderMatch && targetText.includes(firstHeaderMatch[0])) {
    return { merged: false, reason: 'already present' };
  }

  const out = targetText.replace(/\n*$/, '\n\n') + sourceText.trim() + '\n';
  fs.writeFileSync(target, out, 'utf8');
  return { merged: true };
}

// ── CHECKER-MEMORY.md merger ────────────────────────────────────────────────
// Format: two tables (Plan Quality Patterns, Verification Patterns) with
// columns Dimension/Pattern | Severity | Count | Last Seen | ...
// Merge by (table, key) → accumulate Count, take latest Last Seen.

function parseCheckerTables(text) {
  if (!text) return { plan: [], verify: [] };
  const tables = { plan: [], verify: [] };
  let currentTable = null;
  for (const line of text.split('\n')) {
    if (/^##\s+Plan Quality Patterns/.test(line)) { currentTable = 'plan'; continue; }
    if (/^##\s+Verification Patterns/.test(line))  { currentTable = 'verify'; continue; }
    if (!currentTable) continue;
    if (/^\|\s*Dimension|^\|\s*Pattern/.test(line)) continue;  // header
    if (/^\|-+/.test(line)) continue;  // separator
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
      if (cells.length >= 3) tables[currentTable].push(cells);
    }
  }
  return tables;
}

function mergeCheckerMemory(cwd, sourcePath) {
  const sourceText = safeRead(sourcePath);
  if (!sourceText) return { merged: 0 };

  const source = parseCheckerTables(sourceText);
  const target = globalPath(cwd, 'CHECKER-MEMORY.md');
  const targetText = safeRead(target);
  const targetTables = parseCheckerTables(targetText);

  let merged = 0;
  for (const tableName of ['plan', 'verify']) {
    for (const srcRow of source[tableName]) {
      const key = srcRow[0];  // dimension or pattern name
      const existing = targetTables[tableName].find(r => r[0] === key);
      if (existing) {
        // Plan table: [Dimension, Severity, Count, Last Seen, Specific Pattern]
        // Verify table: [Pattern, Count, Last Seen, Advice]
        const countIdx = tableName === 'plan' ? 2 : 1;
        const lastSeenIdx = tableName === 'plan' ? 3 : 2;
        const curCount = parseInt(existing[countIdx], 10) || 0;
        const addCount = parseInt(srcRow[countIdx], 10) || 1;
        existing[countIdx]   = String(curCount + addCount);
        existing[lastSeenIdx] = srcRow[lastSeenIdx];
        merged++;
      } else {
        targetTables[tableName].push(srcRow);
        merged++;
      }
    }
  }

  // Serialize
  const out = [
    '# Checker Memory',
    '',
    '_Auto-generated quality feedback. Updated on complete-milestone via forge-merger._',
    '',
  ];

  if (targetTables.plan.length > 0) {
    out.push('## Plan Quality Patterns');
    out.push('');
    out.push('| Dimension | Severity | Count | Last Seen | Specific Pattern Observed |');
    out.push('|-----------|----------|-------|-----------|---------------------------|');
    for (const r of targetTables.plan) out.push('| ' + r.join(' | ') + ' |');
    out.push('');
  }
  if (targetTables.verify.length > 0) {
    out.push('## Verification Patterns');
    out.push('');
    out.push('| Pattern | Count | Last Seen | Advice |');
    out.push('|---------|-------|-----------|--------|');
    for (const r of targetTables.verify) out.push('| ' + r.join(' | ') + ' |');
    out.push('');
  }

  fs.writeFileSync(target, out.join('\n'), 'utf8');
  return { merged };
}

// ── events.jsonl merger ─────────────────────────────────────────────────────
// Append all lines from per-milestone events file to global, in order.
// No dedup needed (events are timestamps + facts).

function mergeEvents(cwd, sourcePath) {
  const sourceText = safeRead(sourcePath);
  if (!sourceText) return { merged: 0 };

  const lines = sourceText.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { merged: 0 };

  const target = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  fs.appendFileSync(target, lines.join('\n') + '\n', 'utf8');
  return { merged: lines.length };
}

// ── Top-level: mergeMilestone ───────────────────────────────────────────────
async function mergeMilestone(cwd, milestoneId, opts) {
  opts = opts || {};
  const result = { merged: { decisions: 0, memories: 0, ledger: false, checker: 0, events: 0 }, errors: [] };

  const sources = {
    decisions: perMilestonePath(cwd, milestoneId, 'DECISIONS.md'),
    memories:  perMilestonePath(cwd, milestoneId, 'AUTO-MEMORY.md'),
    ledger:    perMilestonePath(cwd, milestoneId, 'LEDGER-ENTRY.md'),
    checker:   perMilestonePath(cwd, milestoneId, 'CHECKER-MEMORY.md'),
    events:    perMilestonePath(cwd, milestoneId, 'events.jsonl'),
  };

  const tasks = [
    { name: 'DECISIONS.md',      run: () => mergeDecisions(cwd, sources.decisions),     resultKey: 'decisions', getCount: r => r.merged },
    { name: 'AUTO-MEMORY.md',    run: () => mergeAutoMemory(cwd, sources.memories),     resultKey: 'memories',  getCount: r => r.merged },
    { name: 'LEDGER.md',         run: () => mergeLedger(cwd, sources.ledger),           resultKey: 'ledger',    getCount: r => !!r.merged },
    { name: 'CHECKER-MEMORY.md', run: () => mergeCheckerMemory(cwd, sources.checker),   resultKey: 'checker',   getCount: r => r.merged },
    { name: 'events.jsonl',      run: () => mergeEvents(cwd, sources.events),           resultKey: 'events',    getCount: r => r.merged },
  ];

  for (const t of tasks) {
    if (opts.dryRun) {
      result.merged[t.resultKey] = '(dry-run)';
      continue;
    }
    let held = null;
    try {
      held = await lock.acquire(cwd, t.name, {
        ttlMs: LOCK_TTL_MS,
        retries: 30,
        backoffMin: 100,
        backoffMax: 500,
        holderRunId: opts.holderRunId || `merger:${milestoneId}:${process.pid}`,
      });
      const r = t.run();
      result.merged[t.resultKey] = t.getCount(r);
    } catch (e) {
      result.errors.push({ file: t.name, error: e.message });
    } finally {
      if (held) held.release();
    }
  }

  return result;
}

// ── Top-level: mergeTask (kind=task lifecycle) ──────────────────────────────
async function mergeTask(cwd, taskId, opts) {
  opts = opts || {};
  const result = { merged: { decisions: 0, memories: 0, ledger: false }, errors: [] };

  const runRecord = runs.get(cwd, taskId);
  if (!runRecord) {
    result.errors.push({ file: 'runs/' + taskId + '.json', error: 'not found' });
    return result;
  }

  // Tasks store pending_decisions / pending_memories inline in the run record
  const pendingDecisions = runRecord.pending_decisions || [];
  const pendingMemories  = runRecord.pending_memories  || [];

  // Wrap into per-milestone-like content for reuse of mergeDecisions / mergeAutoMemory
  if (pendingDecisions.length > 0) {
    let held = null;
    try {
      held = await lock.acquire(cwd, 'DECISIONS.md', { ttlMs: LOCK_TTL_MS, holderRunId: `merger:${taskId}:${process.pid}` });
      const target = globalPath(cwd, 'DECISIONS.md');
      const targetText = safeRead(target) || '# Decisions\n\n| ID | Decision | Rationale | Date |\n|----|----------|-----------|------|\n';
      const rows = pendingDecisions.map(d =>
        `| ${d.id} | ${d.decision} | ${d.rationale || ''} | ${d.ts.slice(0, 10)} |`
      );
      const out = targetText.replace(/\n*$/, '\n') + rows.join('\n') + '\n';
      fs.writeFileSync(target, out, 'utf8');
      result.merged.decisions = rows.length;
    } catch (e) { result.errors.push({ file: 'DECISIONS.md', error: e.message }); }
    finally { if (held) held.release(); }
  }

  if (pendingMemories.length > 0) {
    let held = null;
    try {
      held = await lock.acquire(cwd, 'AUTO-MEMORY.md', { ttlMs: LOCK_TTL_MS, holderRunId: `merger:${taskId}:${process.pid}` });
      // Serialize pendingMemories into a temp string, then reuse mergeAutoMemory
      const synthesized = pendingMemories.map((m, i) => {
        const id = m.name.startsWith('MEM') ? m.name : `MEM-${taskId}-${i + 1}`;
        return `## ${m.category}\n\n### ${id} — ${m.description}\n*confidence:${(m.confidence || 0.85).toFixed(2)} hits:0*\n\n${m.body || ''}`;
      }).join('\n\n');
      const tmpPath = path.join(cwd, '.gsd', `.tmp-task-mem-${taskId}.md`);
      fs.writeFileSync(tmpPath, synthesized, 'utf8');
      try {
        const r = mergeAutoMemory(cwd, tmpPath);
        result.merged.memories = r.merged;
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } catch (e) { result.errors.push({ file: 'AUTO-MEMORY.md', error: e.message }); }
    finally { if (held) held.release(); }
  }

  return result;
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

  if (args.help || (!args.milestone && !args.task)) {
    process.stdout.write(`forge-merger — promote per-milestone files to globals

Flags:
  --milestone <M###>   merge per-milestone files for given milestone
  --task <id>          merge pending decisions/memories from runs/{id}.json
  --dry-run            list what would be merged, do not write
  --cwd <path>         override working directory
  --holder <id>        tag lock holder for debugging

Reads:
  .gsd/milestones/M###/M###-DECISIONS.md
  .gsd/milestones/M###/M###-AUTO-MEMORY.md
  .gsd/milestones/M###/M###-LEDGER-ENTRY.md
  .gsd/milestones/M###/M###-CHECKER-MEMORY.md
  .gsd/milestones/M###/M###-events.jsonl

Writes (under .gsd/.locks/{name}/):
  .gsd/DECISIONS.md (append)
  .gsd/AUTO-MEMORY.md (promote + cap-50)
  .gsd/LEDGER.md (append entry)
  .gsd/CHECKER-MEMORY.md (merge tables)
  .gsd/forge/events.jsonl (append)
`);
    return;
  }

  try {
    let r;
    if (args.milestone) {
      r = await mergeMilestone(cwd, args.milestone, {
        dryRun: !!args['dry-run'],
        holderRunId: args.holder,
      });
    } else {
      r = await mergeTask(cwd, args.task, {
        dryRun: !!args['dry-run'],
        holderRunId: args.holder,
      });
    }
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    if (r.errors && r.errors.length > 0) process.exit(1);
  } catch (e) {
    process.stderr.write(`forge-merger error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  mergeMilestone, mergeTask,
  mergeDecisions, mergeAutoMemory, mergeLedger, mergeCheckerMemory, mergeEvents,
};
