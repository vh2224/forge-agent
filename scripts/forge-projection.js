#!/usr/bin/env node
// forge-projection — Unified projection engine for Forge Agent fragment stores
//
// Reads .gsd/ledger/*.md, .gsd/decisions/*.md, .gsd/memory/*.md,
// .gsd/checker-memory/*.md fragments and reconstructs the legacy monolith
// content on-read.
//
// Library exports:
//   renderLedger(cwd)    → string  // LEDGER.md content reconstructed from fragments
//   renderDecisions(cwd) → string  // DECISIONS.md content with derived # numbering
//   renderMemory(cwd)    → string  // AUTO-MEMORY.md content with decay computed on-read
//   renderChecker(cwd)   → string  // CHECKER-MEMORY monolith view (on-demand only)
//   isStale(cwd)         → { ledger:bool, decisions:bool, memory:bool }
//   writeAll(cwd)        → { written:[string], skipped:[string] }
//
// CLI:
//   node forge-projection.js --render ledger|decisions|memory|checker [--cwd <dir>]
//   node forge-projection.js --stale [--cwd <dir>]
//   node forge-projection.js --write-all [--cwd <dir>] [--force]
//   node forge-projection.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error
//   2 — unknown/missing arguments

'use strict';

const fs   = require('fs');
const path = require('path');

const ledgerMod    = require('./forge-ledger');
const decisionsMod = require('./forge-decisions');
const memoryMod    = require('./forge-memory');
const checkerMod   = require('./forge-checker-memory');
const storeStateMod = require('./forge-store-state');

// ── Constants ─────────────────────────────────────────────────────────────────

const LEDGER_FILE    = '.gsd/LEDGER.md';
const DECISIONS_FILE = '.gsd/DECISIONS.md';
const MEMORY_FILE    = '.gsd/AUTO-MEMORY.md';

// Decay half-life: 30 days in milliseconds (depth-2 decay per R1)
const DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// Memory cap (legacy AUTO-MEMORY.md behaviour)
const MEMORY_CAP = 50;

// ── renderLedger ──────────────────────────────────────────────────────────────
// Reconstructs LEDGER.md from .gsd/ledger/*.md fragments.
// Fragments are sorted by completed_at ascending (id as tiebreaker) so the last
// block is always the most recently completed milestone. Lexicographic id order
// breaks with mixed legacy/timestamp ids: '-' (0x2D) < '0' (0x30) puts every
// legacy `M###` after every `M-<ts>-<slug>`, so readers that take the file tail
// as "most recent" (forge-dashboard readLedgerTail) surface a stale milestone.
// Fragments without completed_at sort first (treated as oldest).
// Mirrors the legacy LEDGER.md block shape produced by forge-completer.
// Caveat (not a bug): byte-identity of the projection pre/post-consolidation
// holds for LF-normalized fragments (everything the forge writes via
// writeAtomic). A CRLF-tainted loose fragment would have its `\r` bytes
// normalized away the moment it enters a bucket (forge-maintenance D2) — the
// post-consolidation projection then differs only in those whitespace bytes.
// The S04 consolidation gate is where this is actually caught/enforced.
function renderLedger(cwd) {
  const fragments = ledgerMod.listFragments(cwd);
  const lines = ['# Forge Project Ledger', ''];
  lines.push('> Compact record of completed milestones. Append-only. Never deleted.');
  lines.push('');

  if (fragments.length === 0) {
    lines.push('_No completed milestones yet._');
    return lines.join('\n') + '\n';
  }

  // Parse everything up-front — ordering needs completed_at from the frontmatter.
  // f.content is present when the unit came from a closed bucket (S02) — use it
  // directly instead of re-reading f.path (which points at the bucket file, not
  // a standalone fragment). Falls back to reading f.path for loose fragments.
  const parsed = [];
  for (const f of fragments) {
    try {
      const text = (f.content != null) ? f.content : fs.readFileSync(f.path, 'utf8');
      parsed.push({ id: f.id, frag: ledgerMod.parseFragment(text) });
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping ledger fragment ${f.id}: ${e.message}\n`);
    }
  }

  parsed.sort((a, b) => {
    const ca = String(a.frag.completed_at || '');
    const cb = String(b.frag.completed_at || '');
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return a.id.localeCompare(b.id);
  });

  for (const { id, frag } of parsed) {
    // Emit block header
    lines.push(`## ${frag.id || id}`);
    if (frag.title) lines.push(`**${frag.title}**`);
    if (frag.completed_at) lines.push(`Completed: ${frag.completed_at}`);
    lines.push('');

    const hasStructured = (frag.slices && frag.slices.length > 0)
      || (frag.key_files && frag.key_files.length > 0)
      || (frag.key_decisions && frag.key_decisions.length > 0);

    if (frag.slices && frag.slices.length > 0) {
      lines.push(`**Slices:** ${frag.slices.join(', ')}`);
    }
    if (frag.key_files && frag.key_files.length > 0) {
      lines.push('**Key files:**');
      for (const kf of frag.key_files) {
        lines.push(`  - ${kf}`);
      }
    }
    if (frag.key_decisions && frag.key_decisions.length > 0) {
      lines.push('**Key decisions:**');
      for (const kd of frag.key_decisions) {
        lines.push(`  - ${kd}`);
      }
    }

    // Only emit body when no structured fields were parsed — body is derived
    // from the raw block and duplicates structured fields when they are present.
    if (!hasStructured && frag.body) {
      lines.push('');
      lines.push(frag.body);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ── renderDecisions ───────────────────────────────────────────────────────────
// Reconstructs DECISIONS.md from .gsd/decisions/*.md fragments.
// Decision rows are gathered from all fragments, sorted by `when` ASC,
// assigned monotonically increasing # numbers at render time (never persisted).
// Legacy orphan fragment rows are appended directly (lenient handling).
function renderDecisions(cwd) {
  const fragments = decisionsMod.listFragments(cwd);

  // Gather all decision rows from all fragments
  const allDecisions = [];
  const legacyOrphanBodies = [];

  for (const f of fragments) {
    const unitId = f.unitId;
    let frag;
    try {
      // f.content is present for units flattened from a closed bucket (S02) —
      // use it directly instead of re-reading f.path (the bucket file).
      const text = (f.content != null) ? f.content : fs.readFileSync(f.path, 'utf8');
      frag = decisionsMod.parseFragment(text);
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping decisions fragment ${unitId}: ${e.message}\n`);
      continue;
    }

    // legacy-orphan: body contains pre-rendered table rows — append raw
    if (unitId === 'legacy-orphan') {
      if (frag.body) legacyOrphanBodies.push(frag.body);
      continue;
    }

    if (Array.isArray(frag.decisions)) {
      for (const d of frag.decisions) {
        allDecisions.push(d);
      }
    }
  }

  // Sort by when ASC, then by decision text for determinism
  allDecisions.sort((a, b) => {
    const wa = String(a.when || '');
    const wb = String(b.when || '');
    if (wa < wb) return -1;
    if (wa > wb) return 1;
    return String(a.decision || '').localeCompare(String(b.decision || ''));
  });

  // Build legacy markdown table
  const lines = ['# Forge Decisions Log', ''];
  lines.push('> Append-only decision registry. Each row is an architectural or process decision.');
  lines.push('');
  lines.push('| # | When | Scope | Decision | Choice | Rationale | Revisable |');
  lines.push('|---|------|-------|----------|--------|-----------|-----------|');

  let num = 1;

  // Prepend legacy orphan rows (they're already formatted table rows)
  for (const body of legacyOrphanBodies) {
    const rowLines = body.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---'));
    for (const row of rowLines) {
      lines.push(row);
      num++;
    }
  }

  for (const d of allDecisions) {
    const when      = String(d.when || '').replace(/\|/g, '\\|');
    const scope     = String(d.scope || '').replace(/\|/g, '\\|');
    const decision  = String(d.decision || '').replace(/\|/g, '\\|');
    const choice    = String(d.choice || '').replace(/\|/g, '\\|');
    const rationale = String(d.rationale || '').replace(/\|/g, '\\|');
    const revisable = String(d.revisable || '').replace(/\|/g, '\\|');
    lines.push(`| ${num} | ${when} | ${scope} | ${decision} | ${choice} | ${rationale} | ${revisable} |`);
    num++;
  }

  lines.push('');
  return lines.join('\n');
}

// ── parseOrphanMemory ─────────────────────────────────────────────────────────
// Parses the legacy-orphan.md block format written by writeOrphanBucket.
// Each entry is a `## [<mem_id>] <category>` header followed by `- key: value` lines.
// Returns an array of factMap-compatible entries:
//   { fact: { mem_id, category, text, source_unit }, hits, confidence, lastAccessTs, pruned, promoted }
function parseOrphanMemory(text) {
  const entries = [];
  // Split on ## [ headers; each part after the first (preamble) is one entry
  const blocks = text.split(/\n(?=## \[)/);
  for (const block of blocks) {
    const headerMatch = block.match(/^## \[([^\]]+)\]\s*(.*)/);
    if (!headerMatch) continue;
    const mem_id   = headerMatch[1].trim();
    const category = headerMatch[2].trim() || 'unknown';

    const get = (key) => {
      const m = block.match(new RegExp(`^- ${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    const confidence   = parseFloat(get('confidence')) || 0.5;
    const hits         = parseInt(get('hits'), 10) || 0;
    const text_        = get('text') || '';
    const source       = get('source') || null;
    const lastAccessTs = get('updated') || null;

    entries.push({
      fact: { mem_id, category, text: text_, source_unit: source },
      hits,
      confidence,
      lastAccessTs,
      pruned: false,
      promoted: false,
      promotedAt: null,
    });
  }
  return entries;
}

// ── decayConfidence ───────────────────────────────────────────────────────────
// Applies exponential depth-2 decay to a base confidence.
// decay = base * 0.5^(age_ms / HALF_LIFE) where age_ms = now - last_access_ts.
// Returns number in [0, 1].
function decayConfidence(baseConfidence, lastAccessTs, nowMs) {
  if (!lastAccessTs) return baseConfidence;
  const ts = typeof lastAccessTs === 'number' ? lastAccessTs : Date.parse(lastAccessTs);
  if (isNaN(ts)) return baseConfidence;
  const ageMs = Math.max(0, nowMs - ts);
  const factor = Math.pow(0.5, ageMs / DECAY_HALF_LIFE_MS);
  return Math.min(1, Math.max(0, baseConfidence * factor));
}

// ── renderMemory ──────────────────────────────────────────────────────────────
// Reconstructs AUTO-MEMORY.md from .gsd/memory/*.md fragments.
// For each fragment, folds stats[] events (hit, prune, promote, confirm, supersede)
// on top of seed facts to compute derived hits + confidence (with decay).
// Emits <!-- gsd-auto-memory ... --> blocks ranked by (confidence * hits) DESC.
// Caps at MEMORY_CAP entries.
function renderMemory(cwd) {
  const fragments = memoryMod.listFragments(cwd);
  const nowMs = Date.now();

  // Accumulate all facts + their stat events keyed by mem_id
  const factMap = new Map(); // mem_id → { fact, hits, confidence, lastAccessTs, pruned, promoted }

  for (const { unitId, path: fpath } of fragments) {
    // legacy-orphan: block format (not YAML-frontmatter fragment) — special-case before parseFragment
    if (unitId === 'legacy-orphan') {
      try {
        const orphanText = fs.readFileSync(fpath, 'utf8');
        const orphanEntries = parseOrphanMemory(orphanText);
        for (const entry of orphanEntries) {
          const mid = String(entry.fact.mem_id || '');
          if (!mid) continue;
          // Valid fragments win — orphans are fallback; skip if already in factMap
          if (factMap.has(mid)) continue;
          factMap.set(mid, entry);
        }
      } catch (e) {
        process.stderr.write(`[forge-projection] warn: skipping legacy-orphan memory: ${e.message}\n`);
      }
      continue;
    }

    let frag;
    try {
      const text = fs.readFileSync(fpath, 'utf8');
      frag = memoryMod.parseFragment(text);
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping memory fragment ${unitId}: ${e.message}\n`);
      continue;
    }

    // Register facts
    for (const fact of (frag.facts || [])) {
      const mid = String(fact.mem_id || '');
      if (!mid) continue;
      if (!factMap.has(mid)) {
        factMap.set(mid, {
          fact,
          hits: 0,
          confidence: parseFloat(fact.confidence) || 0.5,
          lastAccessTs: fact.created_at || null,
          pruned: false,
          promoted: false,
          promotedAt: null,
        });
      }
    }

    // Fold stat events (sorted by ts — already sorted in fragment)
    for (const evt of (frag.stats || [])) {
      const mid = String(evt.mem_id || '');
      if (!mid || !factMap.has(mid)) continue;
      const entry = factMap.get(mid);

      switch (evt.kind) {
        case 'seed': {
          // Seed establishes the baseline confidence/hits from a migrated memory.
          // Must overwrite (not increment) — it is the starting point, not an accrual.
          if (entry._mutated) {
            process.stderr.write(`[forge-projection] warn: non-first seed event for ${mid} — applying last-seed-wins\n`);
          }
          entry.hits = (typeof evt.hits === 'number' ? evt.hits : parseInt(evt.hits, 10)) || 0;
          entry.confidence = parseFloat(evt.confidence) || entry.confidence;
          entry.lastAccessTs = evt.ts || entry.lastAccessTs;
          entry._seenSeed = true;
          break;
        }
        case 'hit':
        case 'confirm':
          entry._mutated = true;
          entry.hits += 1;
          entry.lastAccessTs = evt.ts || entry.lastAccessTs;
          // Each hit nudges confidence up slightly (cap 0.99)
          entry.confidence = Math.min(0.99, entry.confidence + 0.02);
          break;
        case 'prune':
          entry._mutated = true;
          entry.pruned = true;
          break;
        case 'promote':
          entry._mutated = true;
          entry.promoted = true;
          entry.promotedAt = evt.ts || null;
          entry.confidence = Math.min(0.99, entry.confidence + 0.05);
          break;
        case 'supersede':
          // Superseded facts are treated as pruned
          entry._mutated = true;
          entry.pruned = true;
          break;
        case 'decay':
          entry._mutated = true;
          // Explicit decay events reduce confidence
          if (evt.new_confidence !== undefined) {
            entry.confidence = parseFloat(evt.new_confidence) || entry.confidence;
          }
          break;
        default:
          break;
      }
    }
  }

  // Apply time-based decay and filter pruned
  const active = [];
  for (const [, entry] of factMap) {
    if (entry.pruned) continue;
    const decayed = decayConfidence(entry.confidence, entry.lastAccessTs, nowMs);
    active.push({ ...entry, confidence: decayed });
  }

  // Sort by (confidence * hits) DESC, then mem_id for stability
  active.sort((a, b) => {
    const scoreA = a.confidence * Math.max(1, a.hits);
    const scoreB = b.confidence * Math.max(1, b.hits);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return String(a.fact.mem_id || '').localeCompare(String(b.fact.mem_id || ''));
  });

  // Cap at MEMORY_CAP
  const capped = active.slice(0, MEMORY_CAP);

  // Emit legacy AUTO-MEMORY.md format
  const lines = ['# Forge Auto-Memory', ''];
  lines.push('> Emergent memory extracted from completed units. Max 50 entries, ranked by confidence × hits.');
  lines.push('> Decay: half-life 30 days. Computed on-read — not persisted in fragments.');
  lines.push('');

  if (capped.length === 0) {
    lines.push('_No memory entries yet._');
    return lines.join('\n') + '\n';
  }

  for (const entry of capped) {
    const f = entry.fact;
    const conf = entry.confidence.toFixed(2);
    const hits = entry.hits;
    const cat  = f.category || 'unknown';
    const mid  = f.mem_id || '';
    const promoted = entry.promoted ? `, promoted:${entry.promotedAt || 'yes'}` : '';

    lines.push(`<!-- gsd-auto-memory mem_id:${mid} category:${cat} confidence:${conf} hits:${hits}${promoted} -->`);
    lines.push(`- **[${mid}]** *(${cat})* ${f.text || ''}`);
    if (f.source_unit) {
      lines.push(`  *(source: ${f.source_unit})*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── renderChecker ─────────────────────────────────────────────────────────────
// Reconstructs the CHECKER-MEMORY monolith view from .gsd/checker-memory/*.md fragments.
// On-demand only (D9) — never called by writeAll, never persisted as a file.
// Emits two sections so dispatch directives that extract by section name keep working:
//   ## Verification Patterns  — events where kind === 'verify'
//   ## Plan Quality Patterns  — events where kind === 'plan'
function renderChecker(cwd) {
  const fragments = checkerMod.listFragments(cwd);
  const lines = ['# Forge Checker Memory', ''];
  lines.push('> Aggregated checker events from completed milestones. On-demand projection — not persisted.');
  lines.push('');

  // Accumulate all events from all fragments
  const allEvents = [];
  for (const { milestoneId, path: fpath } of fragments) {
    let frag;
    try {
      const text = require('fs').readFileSync(fpath, 'utf8');
      frag = checkerMod.parseFragment(text);
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping checker fragment ${milestoneId}: ${e.message}\n`);
      continue;
    }
    if (Array.isArray(frag.events)) {
      for (const evt of frag.events) {
        allEvents.push(evt);
      }
    }
  }

  // Derive stats
  const stats = checkerMod.projectStats(allEvents);
  const verifyRows = stats.filter(r => r.kind === 'verify');
  const planRows   = stats.filter(r => r.kind === 'plan');

  // ## Verification Patterns
  lines.push('## Verification Patterns');
  lines.push('');
  if (verifyRows.length === 0) {
    lines.push('_No checker events yet._');
  } else {
    for (const r of verifyRows) {
      lines.push(`- **${r.dimension}** (severity:${r.severity}) — count:${r.count}, last_seen:${r.last_seen}`);
    }
  }
  lines.push('');

  // ## Plan Quality Patterns
  lines.push('## Plan Quality Patterns');
  lines.push('');
  if (planRows.length === 0) {
    lines.push('_No checker events yet._');
  } else {
    for (const r of planRows) {
      lines.push(`- **${r.dimension}** (severity:${r.severity}) — count:${r.count}, last_seen:${r.last_seen}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── maxMtime ──────────────────────────────────────────────────────────────────
// Recursively finds the maximum mtime (ms) of all .md files in a directory.
// Returns 0 if directory does not exist or is empty. Already covers bucket
// files transparently — `_rollup-*.md` buckets live in the same store dir and
// end in `.md`, so no separate bucket-mtime scan is needed here (S02).
function maxMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const sub = maxMtime(full);
        if (sub > max) max = sub;
      } else if (entry.endsWith('.md')) {
        if (stat.mtimeMs > max) max = stat.mtimeMs;
      }
    }
  } catch (_) {
    // ignore permission errors
  }
  return max;
}

// ── projectionMtime ───────────────────────────────────────────────────────────
// Returns mtime (ms) of a projection file, or 0 if not found.
function projectionMtime(cwd, filename) {
  const fpath = path.join(cwd, filename);
  try {
    return fs.statSync(fpath).mtimeMs;
  } catch (_) {
    return 0;
  }
}

// ── isStale ───────────────────────────────────────────────────────────────────
// Compares fragment mtimes vs projection file mtimes.
// Returns { ledger:bool, decisions:bool, memory:bool }
// true = projection is older than fragments (stale), false = up to date.
function isStale(cwd) {
  const ledgerFragDir    = path.join(cwd, '.gsd', 'ledger');
  const decisionsFragDir = path.join(cwd, '.gsd', 'decisions');
  const memoryFragDir    = path.join(cwd, '.gsd', 'memory');

  const ledgerFragMtime    = maxMtime(ledgerFragDir);
  const decisionsFragMtime = maxMtime(decisionsFragDir);
  const memoryFragMtime    = maxMtime(memoryFragDir);

  const ledgerProjMtime    = projectionMtime(cwd, LEDGER_FILE);
  const decisionsProjMtime = projectionMtime(cwd, DECISIONS_FILE);
  const memoryProjMtime    = projectionMtime(cwd, MEMORY_FILE);

  return {
    ledger:    ledgerFragMtime    > ledgerProjMtime,
    decisions: decisionsFragMtime > decisionsProjMtime,
    memory:    memoryFragMtime    > memoryProjMtime,
  };
}

// ── writeAll ──────────────────────────────────────────────────────────────────
// Renders all three projections and writes to .gsd/{LEDGER,DECISIONS,AUTO-MEMORY}.md.
// Byte-compares before writing — no-op when content is identical (idempotent).
//
// Data-loss guard: when a store is 'unmigrated' (fragment store empty but the
// monolith still has real entries), rendering produces an empty skeleton that
// would overwrite the real content. Such targets are BLOCKED — never written —
// unless opts.force is set. This prevents the silent history loss seen on
// non-migrated working copies (e.g. SVN trunks where the monolith is the source
// of truth and was never decomposed into fragments).
//
// Returns { written:[string], skipped:[string], blocked:[{file, reason}] }
function writeAll(cwd, opts) {
  const { force = false } = opts || {};
  const written = [];
  const skipped = [];
  const blocked = [];

  const state = storeStateMod.storeState(cwd);

  const targets = [
    { file: LEDGER_FILE,    store: 'ledger',    render: () => renderLedger(cwd) },
    { file: DECISIONS_FILE, store: 'decisions', render: () => renderDecisions(cwd) },
    { file: MEMORY_FILE,    store: 'memory',    render: () => renderMemory(cwd) },
  ];

  for (const { file, store, render } of targets) {
    // Guard: refuse to overwrite a populated monolith from an empty store.
    const st = state[store];
    if (!force && st && st.state === 'unmigrated') {
      blocked.push({
        file,
        reason: `fragment store empty but ${file} has ${st.monolithEntries} entr${st.monolithEntries === 1 ? 'y' : 'ies'} — run forge-migrate.js first, or use --force to overwrite`,
      });
      continue;
    }

    const fpath = path.join(cwd, file);
    const content = render();

    // Ensure parent dir exists
    const dir = path.dirname(fpath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Byte-compare
    if (fs.existsSync(fpath)) {
      const existing = fs.readFileSync(fpath, 'utf8');
      if (existing === content) {
        skipped.push(file);
        continue;
      }
    }

    fs.writeFileSync(fpath, content, 'utf8');
    written.push(file);
  }

  return { written, skipped, blocked };
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  renderLedger,
  renderDecisions,
  renderMemory,
  renderChecker,
  isStale,
  writeAll,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-projection.js <command> [options]

Commands:
  --render ledger|decisions|memory|checker [--cwd <dir>]
                          Print reconstructed monolith content to stdout
  --stale [--cwd <dir>]   Print JSON {ledger:bool, decisions:bool, memory:bool}
                          and exit 0 (true = stale)
  --write-all [--cwd <dir>] [--force]
                          Render all three projections to .gsd/*.md (idempotent).
                          Refuses to overwrite a populated monolith from an empty
                          fragment store unless --force is given (exit 1 if blocked).
  --help, -h              Show this help

Options:
  --cwd <dir>   Working directory (default: process.cwd())

Exit codes:
  0  Success
  1  Runtime error
  2  Unknown or missing arguments`);
}

function cliMain(argv) {
  // Parse --cwd
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === '--render') {
    const name = argv[1];
    if (!name || !['ledger', 'decisions', 'memory', 'checker'].includes(name)) {
      process.stderr.write('--render requires: ledger | decisions | memory | checker\n');
      process.exit(2);
    }
    let content;
    try {
      if (name === 'ledger')    content = renderLedger(cwd);
      if (name === 'decisions') content = renderDecisions(cwd);
      if (name === 'memory')    content = renderMemory(cwd);
      if (name === 'checker')   content = renderChecker(cwd);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    process.stdout.write(content);
    process.exit(0);
  }

  if (cmd === '--stale') {
    let result;
    try {
      result = isStale(cwd);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--write-all') {
    const force = argv.includes('--force');
    let result;
    try {
      result = writeAll(cwd, { force });
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    if (result.blocked && result.blocked.length > 0) {
      for (const b of result.blocked) {
        process.stderr.write(`[forge-projection] BLOCKED ${b.file}: ${b.reason}\n`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
}

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
