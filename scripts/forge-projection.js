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

// This module still owns the legacy orphan file and rendered output files.
// Store-backed projection loops use the corresponding store text accessor.
// Keeping those paths explicit prevents future grouped-container regressions.
// Checker memory remains intentionally out of scope for this grouped-store slice.
const fs   = require('fs'); // retained for legacy-orphan and projection writes
const path = require('path');

const ledgerMod    = require('./forge-ledger');
const decisionsMod = require('./forge-decisions');
const memoryMod    = require('./forge-memory');
const checkerMod   = require('./forge-checker-memory');
const storeStateMod = require('./forge-store-state');
const itemsMod     = require('./forge-items');

// ── Constants ─────────────────────────────────────────────────────────────────

const LEDGER_FILE    = '.gsd/LEDGER.md';
const DECISIONS_FILE = '.gsd/DECISIONS.md';
const MEMORY_FILE    = '.gsd/AUTO-MEMORY.md';

// Decay half-life: 30 days in milliseconds (depth-2 decay per R1)
// ── Schema guard seam (M-S01 T04) ────────────────────────────────────────────
// Lazy require, deliberately: forge-schema-guard → forge-migrate →
// forge-projection is a top-level cycle (forge-migrate.js:33). A top-level
// require here would make forge-migrate capture this module's half-built
// exports object, which is later REPLACED by the `module.exports = {...}`
// below — a silent breakage. Resolving inside the call defers it past init.
//
// SINGLE INSERTION POINT PER SIDE:
//   read  → guardReadHere() at the top of renderLedger/renderDecisions/
//           renderMemory/renderChecker/renderItems/isStale/queryMemoryEntries
//   write → assertWriteHere() at the top of writeAll
// Reading `.gsd/SCHEMA-VERSION` or comparing versions anywhere else in this
// file is forbidden — the guard module is the only source of that logic.
// Only an ABSENT guard module is swallowed. A guard that exists but throws
// while initializing — or whose own transitive require fails (the guard pulls
// forge-migrate, which eagerly pulls projection/migrators/store-state/doctor)
// — is a real fault and must propagate rather than silently disabling both the
// read warning and the write refusal.
//
// SCOPE BOUNDARY (deliberate, do not 'complete' it): this narrows the CATCH
// only — it is about LOADING the guard, not about what the guard decides.
// The seam stays FAIL-OPEN on an unexpected runtime error raised inside the
// guard's own check (see the catch in assertWrite, forge-schema-guard.js).
// It is NOT fail-open on a stamp the guard could not READ: that case refuses
// the write, naming the errno. This note used to say the fail-open of
// assertWrite had been reviewed and kept as is — the PR #70 dogfood revised
// that decision: a directory at .gsd/SCHEMA-VERSION disabled the write guard
// silently, so "unreadable" now closes, while "absent" and "present but
// garbage" stay open.
function schemaGuard() {
  try {
    return require('./forge-schema-guard');
  } catch (err) {
    let absent;
    try {
      absent = require('./forge-optional-require').isAbsentModuleError(err, './forge-schema-guard');
    } catch (_) {
      // Classifier itself missing (partial install) → keep the historical
      // fail-open instead of crashing the store.
      absent = true;
    }
    if (absent) return null;
    throw err;
  }
}

// Fail-open read guard: returns { ok, partial, warning } and emits the warning
// to stderr at most once per process per cwd. Never throws, never blocks.
// Note the renderX functions call into forge-ledger/decisions/memory, which
// guard too — the dedupe Set collapses that into one emission.
function guardReadHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return { ok: true, partial: false, warning: null };
  return guard.guardReadAndWarn(cwd || process.cwd());
}

// Write refusal: throws when the on-disk schema major is AHEAD of this
// tooling's. cliMain's catch turns that into stderr + exit 1.
function assertWriteHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return;
  guard.assertWriteOrThrow(cwd || process.cwd());
}

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
function renderLedger(cwd) {
  // Markdown output: warning on stderr only, NOT a line in the rendered text —
  // /forge-explain pipes this straight into a prompt, so injecting a marker
  // would change the data itself.
  guardReadHere(cwd);
  const fragments = ledgerMod.listFragments(cwd);
  const lines = ['# Forge Project Ledger', ''];
  lines.push('> Compact record of completed milestones. Append-only. Never deleted.');
  lines.push('');

  if (fragments.length === 0) {
    lines.push('_No completed milestones yet._');
    return lines.join('\n') + '\n';
  }

  // Parse everything up-front — ordering needs completed_at from the frontmatter
  const parsed = [];
  for (const entry of fragments) {
    const { id } = entry;
    try {
      const text = ledgerMod.readFragmentText(cwd, entry);
      parsed.push({ id, frag: ledgerMod.parseFragment(text) });
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping ledger fragment ${id}: ${e.message}\n`);
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
    lines.push(...renderLedgerBlock(frag, id));
  }

  return lines.join('\n');
}

// ── renderLedgerBlock ─────────────────────────────────────────────────────────
// The shape of ONE ledger entry as it appears in LEDGER.md, extracted from
// renderLedger so the D4 line cap in forge-ledger.js measures the very same
// bytes the reader sees. A second copy of this shape would let the cap drift
// away from the thing it claims to measure, so this function is the only place
// the block shape exists.
//
// Returns the block lines INCLUDING the trailing separation ('', '---', '') —
// renderLedger relies on them. The cap is about the entry's own content, not
// the punctuation between entries, so callers measuring size subtract
// LEDGER_BLOCK_SEPARATOR_LINES (see forge-ledger.js).
const LEDGER_BLOCK_SEPARATOR_LINES = 3;

function renderLedgerBlock(frag, id) {
  const lines = [];

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

  return lines;
}

// ── renderDecisions ───────────────────────────────────────────────────────────
// Reconstructs DECISIONS.md from .gsd/decisions/*.md fragments.
// Decision rows are gathered from all fragments, sorted by `when` ASC,
// assigned monotonically increasing # numbers at render time (never persisted).
// Legacy orphan fragment rows are appended directly (lenient handling).
function renderDecisions(cwd) {
  guardReadHere(cwd); // stderr only — markdown stdout stays byte-identical
  const fragments = decisionsMod.listFragments(cwd);

  // Gather all decision rows from all fragments
  const allDecisions = [];
  const legacyOrphanBodies = [];

  for (const entry of fragments) {
    const { unitId } = entry;
    let frag;
    try {
      const text = decisionsMod.readFragmentText(cwd, entry);
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

function finiteNumber(value, fallback) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function memoryIdentity(unitId, memId) {
  return `${unitId}\x00${memId}`;
}

// ── renderMemory ──────────────────────────────────────────────────────────────
// Fold every fragment into structured entries with decay computed on-read.
function projectMemoryEntries(cwd, opts) {
  const fragments = memoryMod.listFragments(cwd);
  const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  // mem_id is fragment-local: independent extractors commonly start at MEM001.
  // Key runtime state by (unitId, mem_id) so facts and stats cannot bleed
  // across fragments while the stored/display ID remains backward compatible.
  const factMap = new Map();
  const validRawIds = new Set();
  const pendingOrphans = [];

  for (const entry of fragments) {
    const { unitId, milestoneId, storageKey, path: fpath } = entry;
    // legacy-orphan: block format (not YAML-frontmatter fragment) — special-case before parseFragment
    if (unitId === 'legacy-orphan') {
      try {
        const orphanText = fs.readFileSync(fpath, 'utf8');
        const orphanEntries = parseOrphanMemory(orphanText);
        for (const entry of orphanEntries) {
          const mid = String(entry.fact.mem_id || '');
          if (!mid) continue;
          pendingOrphans.push({ entry, mid, unitId });
        }
      } catch (e) {
        process.stderr.write(`[forge-projection] warn: skipping legacy-orphan memory: ${e.message}\n`);
      }
      continue;
    }

    let frag;
    try {
      const text = memoryMod.readFragmentText(cwd, entry);
      frag = memoryMod.parseFragment(text);
    } catch (e) {
      process.stderr.write(`[forge-projection] warn: skipping memory fragment ${unitId}: ${e.message}\n`);
      continue;
    }

    const localKeys = new Map();
    const fragmentNamespace = milestoneId ? `${milestoneId}/${unitId}` : unitId;

    // Register facts. First-write-wins remains unchanged inside one fragment;
    // only cross-fragment collisions are separated.
    for (const fact of (frag.facts || [])) {
      const mid = String(fact.mem_id || '');
      if (!mid) continue;
      const identity = memoryIdentity(fragmentNamespace, mid);
      localKeys.set(mid, identity);
      validRawIds.add(mid);
      if (!factMap.has(identity)) {
        factMap.set(identity, {
          identity: `${fragmentNamespace}/${mid}`,
          unitId,
          milestoneId: milestoneId || null,
          storageKey,
          fact,
          hits: 0,
          confidence: finiteNumber(fact.confidence_base, finiteNumber(fact.confidence, 0.5)),
          lastAccessTs: fact.created_at || null,
          pruned: false,
          promoted: false,
          promotedAt: null,
        });
      }
    }

    // Fold stat events (sorted by ts — already sorted in fragment)
    for (const evt of (frag.stats || [])) {
      // The documented supersede event uses old_id/new_id, not mem_id.
      const mid = String(evt.kind === 'supersede'
        ? (evt.old_id || evt.mem_id || '')
        : (evt.mem_id || ''));
      const identity = localKeys.get(mid);
      if (!identity || !factMap.has(identity)) continue;
      const entry = factMap.get(identity);

      switch (evt.kind) {
        case 'seed': {
          // Seed establishes the baseline confidence/hits from a migrated memory.
          // Must overwrite (not increment) — it is the starting point, not an accrual.
          if (entry._mutated) {
            process.stderr.write(`[forge-projection] warn: non-first seed event for ${mid} — applying last-seed-wins\n`);
          }
          entry.hits = (typeof evt.hits === 'number' ? evt.hits : parseInt(evt.hits, 10)) || 0;
          entry.confidence = finiteNumber(
            evt.confidence_base,
            finiteNumber(evt.confidence, entry.confidence)
          );
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
            entry.confidence = finiteNumber(evt.new_confidence, entry.confidence);
          }
          break;
        default:
          break;
      }
    }
  }

  // Process the fallback bucket last so valid fragments win regardless of the
  // platform's localeCompare ordering for uppercase vs lowercase filenames.
  for (const { entry, mid, unitId } of pendingOrphans) {
    if (validRawIds.has(mid)) continue;
    const identity = memoryIdentity(unitId, mid);
    factMap.set(identity, {
      ...entry,
      identity: `${unitId}/${mid}`,
      unitId,
    });
  }

  // Apply time-based decay and filter pruned
  const active = [];
  for (const [, entry] of factMap) {
    if (entry.pruned) continue;
    const decayed = decayConfidence(entry.confidence, entry.lastAccessTs, nowMs);
    active.push({ ...entry, confidence: decayed });
  }

  // Sort by (confidence * hits) DESC, then collision-safe identity for stability.
  active.sort((a, b) => {
    const scoreA = a.confidence * Math.max(1, a.hits);
    const scoreB = b.confidence * Math.max(1, b.hits);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.identity.localeCompare(b.identity);
  });

  return active;
}

// Deterministic, model-free selector used by `forge-memory.js --query`.
// It replaces list+one-read-per-fragment orchestration and applies the context
// budget before any memory text enters a worker prompt.
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'are', 'was',
  'uma', 'para', 'com', 'dos', 'das', 'que', 'por', 'como', 'sem', 'sobre',
]);

function queryTerms(text) {
  const words = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z0-9_][a-z0-9_.-]{2,}/g) || [];
  return new Set(words.filter(word => !QUERY_STOPWORDS.has(word)));
}

const MAX_QUERY_BYTES = 512 * 1024;
const MAX_QUERY_TOKENS = 16000;

function boundedQueryInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min}`);
  }
  return Math.min(max, parsed);
}

function queryText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('query must be a string');
  if (value.includes('\0')) throw new Error('query must not contain NUL bytes');
  if (Buffer.byteLength(value, 'utf8') > MAX_QUERY_BYTES) {
    throw new Error(`query exceeds ${MAX_QUERY_BYTES} bytes`);
  }
  return value;
}

function inlineLabel(value, fallback) {
  const normalized = String(value || fallback).replace(/[\x00-\x1f\x7f\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 160) || fallback;
}

function queryMemoryEntries(cwd, opts) {
  opts = opts || {};
  // Module boundary: forge-memory.queryRelevant (← forge-prompt.js:306) and the
  // `--query`/`--select` CLI both land here. Object envelope → additive fields.
  const schema = guardReadHere(cwd);
  const unitType = String(opts.unitType || 'other').toLowerCase();
  const terms = queryTerms(queryText(opts.query));
  const limit = boundedQueryInteger(opts.limit, 8, 1, 50, 'limit');
  const maxTokens = boundedQueryInteger(opts.maxTokens, 2000, 2, MAX_QUERY_TOKENS, 'maxTokens');
  const maxChars = maxTokens * 4;

  const execution = unitType === 'execute-task' || unitType === 'execute-loose-task' || unitType === 'review-fix';
  const planning = /^(?:plan|research|discuss)-/.test(unitType);
  const preferred = execution
    ? new Map([['gotcha', 3], ['convention', 2], ['architecture', 1], ['pattern', 1]])
    : planning
      ? new Map([['architecture', 3], ['pattern', 3], ['convention', 1], ['gotcha', 1]])
      : new Map();

  const ranked = [];
  for (const entry of projectMemoryEntries(cwd, opts)) {
    const factTerms = queryTerms(`${entry.fact.text || ''} ${entry.fact.source_unit || ''}`);
    const matched = [...terms].filter(term => factTerms.has(term)).sort();
    const minimumOverlap = terms.size === 0 ? 0 : execution ? Math.min(2, terms.size) : planning ? 1 : 0;
    if (matched.length < minimumOverlap) continue;

    const category = String(entry.fact.category || 'unknown').toLowerCase();
    const quality = entry.confidence * Math.max(1, entry.hits);
    const score = (matched.length * 100) + ((preferred.get(category) || 0) * 10) + quality;
    ranked.push({ ...entry, matched, score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.identity.localeCompare(b.identity);
  });

  const selected = [];
  const lines = [];
  let chars = 0;
  let truncated = ranked.length > limit;

  for (const entry of ranked.slice(0, limit)) {
    const category = inlineLabel(entry.fact.category, 'unknown');
    const identity = inlineLabel(entry.identity, 'memory');
    const prefix = `- [${identity}] (${category}) `;
    const fullText = String(entry.fact.text || '').replace(/\s+/g, ' ').trim();
    let line = prefix + fullText;
    const separatorChars = lines.length === 0 ? 0 : 1;
    const remaining = maxChars - chars - separatorChars;
    if (remaining <= prefix.length) {
      truncated = true;
      break;
    }

    let selectedText = fullText;
    if (line.length > remaining) {
      selectedText = fullText.slice(0, Math.max(0, remaining - prefix.length - 1)).trimEnd() + '…';
      line = prefix + selectedText;
      truncated = true;
    }

    lines.push(line);
    chars += separatorChars + line.length;
    selected.push({
      identity: entry.identity,
      unit_id: entry.unitId,
      milestone_id: entry.milestoneId || null,
      mem_id: entry.fact.mem_id,
      category,
      text: selectedText,
      source_unit: entry.fact.source_unit || null,
      confidence: Number(entry.confidence.toFixed(4)),
      hits: entry.hits,
      score: Number(entry.score.toFixed(4)),
      matched_terms: entry.matched,
    });
    if (line.length >= remaining) break;
  }

  const markdown = lines.length ? lines.join('\n') : '(none)';
  const result = {
    entries: selected,
    markdown,
    estimated_tokens: Math.ceil(markdown.length / 4),
    truncated,
    considered: ranked.length,
  };
  // Additive, partial-only. `markdown` itself is untouched: it is injected into
  // prompts verbatim, so the marker must not travel inside the data.
  if (schema.partial) {
    result.schema_partial = true;
    result.schema_warning = schema.warning;
  }
  return result;
}

// ── renderMemory ─────────────────────────────────────────────────────────────────
// Reconstructs AUTO-MEMORY.md from the structured, collision-safe projection.
function renderMemory(cwd) {
  guardReadHere(cwd); // stderr only — markdown stdout stays byte-identical
  const active = projectMemoryEntries(cwd);

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
  guardReadHere(cwd); // stderr only — markdown stdout stays byte-identical
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

// ── renderItems ───────────────────────────────────────────────────────────────
// Reconstructs the ITEMS.md monolith view from .gsd/items/*.md fragments.
// On-demand only — never called by writeAll, never persisted as a file.
// Sections in canonical status order (STATUSES); empty statuses are omitted.
const ITEM_STATUS_ORDER = ['inbox', 'triaged', 'doing', 'done', 'dropped'];

function renderItems(cwd) {
  guardReadHere(cwd); // stderr only — markdown stdout stays byte-identical
  const items = itemsMod.listItems(cwd);
  const lines = ['# Forge Items', ''];
  lines.push('> Backlog items grouped by status. On-demand projection — not persisted.');
  lines.push('');

  if (items.length === 0) {
    lines.push('_No items yet._');
    return lines.join('\n') + '\n';
  }

  for (const status of ITEM_STATUS_ORDER) {
    const inStatus = items.filter(it => it.status === status);
    if (inStatus.length === 0) continue;

    lines.push(`## ${status}`);
    lines.push('');
    for (const it of inStatus) {
      const promoted = it.promoted_to ? ` → promoted_to ${it.promoted_to}` : '';
      lines.push(`- ${it.id} — ${it.title}${promoted}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── maxMtime ──────────────────────────────────────────────────────────────────
// Recursively finds the maximum mtime (ms) of all .md files in a directory.
// Returns 0 if directory does not exist or is empty.
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
  const schema = guardReadHere(cwd);
  const ledgerFragDir    = path.join(cwd, '.gsd', 'ledger');
  const decisionsFragDir = path.join(cwd, '.gsd', 'decisions');
  const memoryFragDir    = path.join(cwd, '.gsd', 'memory');

  const ledgerFragMtime    = maxMtime(ledgerFragDir);
  const decisionsFragMtime = maxMtime(decisionsFragDir);
  const memoryFragMtime    = maxMtime(memoryFragDir);

  const ledgerProjMtime    = projectionMtime(cwd, LEDGER_FILE);
  const decisionsProjMtime = projectionMtime(cwd, DECISIONS_FILE);
  const memoryProjMtime    = projectionMtime(cwd, MEMORY_FILE);

  const result = {
    ledger:    ledgerFragMtime    > ledgerProjMtime,
    decisions: decisionsFragMtime > decisionsProjMtime,
    memory:    memoryFragMtime    > memoryProjMtime,
  };

  // Object ENVELOPE → additive partial marking. Keys appear ONLY when the
  // on-disk schema major is ahead; the fail-open path returns byte-identical
  // JSON to before this guard existed, and existing consumers that read
  // .ledger/.decisions/.memory ignore unknown keys.
  if (schema.partial) {
    result.schema_partial = true;
    result.schema_warning = schema.warning;
  }
  return result;
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
  // Refuse before rendering anything — no file is touched, and `--force` does
  // NOT override this: force exists to overwrite a populated monolith from an
  // empty store, a different hazard from writing under stale tooling.
  // Consequence: the `--write-all` envelope never carries schema_partial —
  // when the schema is ahead the command exits 1 instead of returning a body.
  assertWriteHere(cwd);
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
  renderLedgerBlock,
  LEDGER_BLOCK_SEPARATOR_LINES,
  renderDecisions,
  projectMemoryEntries,
  queryMemoryEntries,
  renderMemory,
  renderChecker,
  renderItems,
  isStale,
  writeAll,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-projection.js <command> [options]

Commands:
  --render ledger|decisions|memory|checker|items [--cwd <dir>]
                          Print reconstructed monolith content to stdout
                          (items is on-demand only — never written by --write-all)
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
    if (!name || !['ledger', 'decisions', 'memory', 'checker', 'items'].includes(name)) {
      process.stderr.write('--render requires: ledger | decisions | memory | checker | items\n');
      process.exit(2);
    }
    let content;
    try {
      if (name === 'ledger')    content = renderLedger(cwd);
      if (name === 'decisions') content = renderDecisions(cwd);
      if (name === 'memory')    content = renderMemory(cwd);
      if (name === 'checker')   content = renderChecker(cwd);
      if (name === 'items')     content = renderItems(cwd);
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
