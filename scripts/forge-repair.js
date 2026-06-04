#!/usr/bin/env node
// forge-repair.js — Deterministic failure→strategy classifier + reinject-diff
//
// Exports:
//   classifyRepair(input) → { strategy, reason }
//   isLargeTask(planContent) → boolean            (large_task frontmatter > heuristic)
//   readRepairCount(planContent) → number          (frontmatter repair_count, default 0)
//   incrementRepairCount(planPath) → number        (atomic on-disk bump; throws on no frontmatter)
//     strategy ∈ "retry" | "decompose" | "prune" | "blocked"
//     input: { failure_shape, severity, worker_explained, signals }
//     signals: { missing_artifacts:int, substantive_false:int, wired_false:int,
//                symbol_missing:int, test_quality:{ disabled:int, weak:int }, is_large_task:bool }
//
//   reinjectDiff({ planContent, verificationContent, prunedIds, mustHavesStatus }) → { dropped, capped, error? }
//     dropped: string[]  — planned items not delivered and not pruned (cap 10)
//     capped:  boolean   — true if more than 10 items were dropped (truncated)
//     error:   string?   — present when parsing failed (NOT equivalent to empty diff)
//
// CLI usage:
//   node scripts/forge-repair.js --classify '<json>'
//     Prints { strategy, reason } to stdout. Exit 0 ok, exit 2 malformed.
//
//   node scripts/forge-repair.js --reinject-diff --plan <path> --verification <path>
//                                 [--pruned id,id,...] [--must-haves-status '<json>']
//     Prints { dropped, capped } to stdout. Exit 0 ok, exit 2 malformed/IO.
//
//   node scripts/forge-repair.js --help
//
// Zero npm dependencies — only Node built-ins (fs, path, os).
// Cross-module: require('./forge-must-haves') for parseMustHaves.

'use strict';

const fs   = require('fs');
const path = require('path');

const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves');

// ── Constants ─────────────────────────────────────────────────────────────────

const REINJECT_CAP = 10;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Parse S##-VERIFICATION.md content and return a list of delivered artifact paths
 * (those with substantive:true, indicated by ✓ in the Substantive column of the table).
 *
 * The format is a markdown table:
 *   | Source | Artifact | Exists | Substantive | Wired | Flags |
 *   | T## | path/to/file | ✓ | ✓ | ✓ | — |
 *
 * Regex uses [ \t] (never \s) to avoid matching across newlines (PITFALL 4).
 *
 * @param {string} content  S##-VERIFICATION.md text
 * @returns {string[]}  Array of artifact paths considered substantively delivered
 */
const SUBSTANTIVE_TRUE = new Set(['✓', '✔', 'y', 'yes', 'true']);

function parseVerification(content) {
  if (!content || !content.trim()) return [];

  const lines = content.split('\n');

  // Header guard (S04 review R3): locate column indexes BY NAME from the header
  // row instead of assuming fixed positions — robust to column insertion/reorder.
  // If a table exists but the expected headers are absent → format drift: return
  // null so the caller can surface an error instead of a silent empty diff.
  let artifactIdx = -1;
  let substantiveIdx = -1;
  let sawTable = false;

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    sawTable = true;
    const cells = line.split('|').map(c => c.trim());
    const ai = cells.findIndex(c => /^artifact$/i.test(c));
    const si = cells.findIndex(c => /^substantive$/i.test(c));
    if (ai !== -1 && si !== -1) { artifactIdx = ai; substantiveIdx = si; break; }
  }

  if (!sawTable) return [];
  if (artifactIdx === -1 || substantiveIdx === -1) return null; // format drift

  const delivered = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length <= Math.max(artifactIdx, substantiveIdx)) continue;

    const artifactPath = cells[artifactIdx];
    const substantive  = cells[substantiveIdx];

    if (!artifactPath || /^artifact$/i.test(artifactPath)) continue;       // header
    if (/^[-: \t]+$/.test(artifactPath)) continue;                         // separator

    if (SUBSTANTIVE_TRUE.has(substantive.toLowerCase()) || substantive === '✓' || substantive === '✔') {
      delivered.push(artifactPath);
    }
  }

  return delivered;
}

/**
 * Collect planned item identifiers from a parseMustHaves result.
 * Returns an array of strings: artifact paths + expected_output paths + truth labels.
 *
 * @param {{ truths:string[], artifacts:object[], key_links:object[], expected_output:string[] }} parsed
 * @returns {string[]}
 */
function collectPlanned(parsed) {
  const items = [];

  // Artifact paths
  for (const a of parsed.artifacts || []) {
    if (a.path) items.push(a.path);
  }

  // expected_output paths (deduplicate against artifacts)
  const artifactPaths = new Set(items);
  for (const p of parsed.expected_output || []) {
    if (!artifactPaths.has(p)) items.push(p);
  }

  return items;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deterministic failure-shape → strategy classifier.
 *
 * Precedence (evaluated in order, first match wins):
 *   1. severity === 'critical' → blocked (S03 context-monitor suppression — BLOCKER 1)
 *   2. worker_explained === 'impossible' | 'contradictory' → prune
 *   3. is_large_task && (missing_artifacts>=2 || substantive_false>=2 || symbol_missing>=2) → decompose
 *   4. wired_false>=1 || test_quality.weak>=1 || substantive_false>=1 || test_quality.disabled>=1 → retry
 *   5. else → blocked (unrecognised fallback)
 *
 * NEVER decomposes or prunes for context_overflow — that belongs to Layer 2.
 * If failure_shape === 'context_overflow' → blocked (not a verification-signal failure).
 *
 * @param {{ failure_shape:string, severity:string, worker_explained:string, signals:object }} input
 * @returns {{ strategy:string, reason:string }}
 */
function classifyRepair(input) {
  if (!input || typeof input !== 'object') {
    return { strategy: 'blocked', reason: 'invalid input — expected object with failure_shape/severity/signals' };
  }

  const {
    failure_shape,
    severity,
    worker_explained,
    signals = {},
  } = input;

  const {
    missing_artifacts = 0,
    substantive_false = 0,
    wired_false       = 0,
    symbol_missing    = 0,
    test_quality      = {},
    is_large_task     = false,
  } = signals;

  const disabled = (test_quality.disabled || 0);
  const weak     = (test_quality.weak || 0);

  // 1. Context-critical suppression (S03 BLOCKER 1) — highest precedence
  if (severity === 'critical') {
    return {
      strategy: 'blocked',
      reason:   'context critical — checkpoint, no aggressive repair',
    };
  }

  // Guard: context_overflow is a Camada 2 concern, not a verification signal
  if (failure_shape === 'context_overflow') {
    return {
      strategy: 'blocked',
      reason:   'context_overflow belongs to Layer 2 (Failure Taxonomy) — not a verification-signal failure',
    };
  }

  // 2. Explicit impossibility / contradiction declared by worker
  if (worker_explained === 'impossible' || worker_explained === 'contradictory') {
    return {
      strategy: 'prune',
      reason:   `worker explicitly stated requirement is ${worker_explained} — remove from scope`,
    };
  }

  // 3. Decompose — task too large for one context window
  if (is_large_task && (missing_artifacts >= 2 || substantive_false >= 2 || symbol_missing >= 2)) {
    const trigger = missing_artifacts >= 2
      ? `missing_artifacts=${missing_artifacts}`
      : substantive_false >= 2
        ? `substantive_false=${substantive_false}`
        : `symbol_missing=${symbol_missing}`;
    return {
      strategy: 'decompose',
      reason:   `large task with multiple unmet must_haves (${trigger}) — split into sub-tasks`,
    };
  }

  // 4. Retry — isolated quality or wiring issue
  if (disabled >= 1 || weak >= 1 || wired_false >= 1 || substantive_false >= 1) {
    let reason;
    if (disabled >= 1) {
      reason = `disabled test(s) detected (disabled=${disabled}) — re-attempt with must_haves re-injected`;
    } else if (weak >= 1) {
      reason = `weak assertion(s) detected (weak=${weak}) — re-attempt with must_haves re-injected`;
    } else if (substantive_false >= 1) {
      reason = `artifact not substantive (substantive_false=${substantive_false}) — re-attempt`;
    } else {
      reason = `wired check failed (wired_false=${wired_false}) — re-attempt with import-chain fix`;
    }
    return { strategy: 'retry', reason };
  }

  // 5. Fallback — shape not recognised
  return {
    strategy: 'blocked',
    reason:   'failure shape not recognised by repair classifier — fall through to blocked→human',
  };
}

/**
 * Compute the diff between planned must_have items and actually-delivered items,
 * excluding items that have been formally pruned.
 *
 * Planned items are derived from must_haves.artifacts[].path + expected_output[]
 * in the T##-PLAN.md (via parseMustHaves). Delivered items come from S##-VERIFICATION.md
 * rows where substantive === true. prunedIds are excluded from the diff (already removed
 * from scope and registered in S##-CONTEXT § Decisions).
 *
 * Graceful degradation: if verificationContent is absent/empty, falls back to
 * mustHavesStatus.dropped if provided, or returns {dropped:[], capped:false}.
 *
 * @param {{ planContent:string, verificationContent:string, prunedIds:string[],
 *            mustHavesStatus?: { satisfied:string[], dropped:string[] } }} opts
 * @returns {{ dropped:string[], capped:boolean }}
 */
function reinjectDiff({ planContent, verificationContent, prunedIds = [], mustHavesStatus }) {
  // Resolve planned items
  let planned = [];
  let parseError = null;
  if (planContent && hasStructuredMustHaves(planContent)) {
    try {
      const parsed = parseMustHaves(planContent);
      planned = collectPlanned(parsed);
    } catch (e) {
      // S04 review R5: a parse failure must be DISTINGUISHABLE from a clean
      // empty diff downstream — never silently equivalent to "nothing dropped".
      parseError = `parseMustHaves failed: ${e.message}`;
      planned = [];
    }
  }

  // Resolve delivered items
  let delivered = [];
  const hasVerification = verificationContent && verificationContent.trim().length > 0;

  if (hasVerification) {
    delivered = parseVerification(verificationContent);
    if (delivered === null) {
      // Header guard tripped (R3): VERIFICATION table format drifted.
      return { dropped: [], capped: false, error: 'verification table format drift — expected Artifact/Substantive headers' };
    }
  } else if (mustHavesStatus && Array.isArray(mustHavesStatus.dropped)) {
    // Degradation: use the worker-reported must_haves_status.dropped directly
    const pruned = new Set(prunedIds);
    const dropped = mustHavesStatus.dropped.filter(id => !pruned.has(id));
    const capped  = dropped.length > REINJECT_CAP;
    return { dropped: capped ? dropped.slice(0, REINJECT_CAP) : dropped, capped };
  } else {
    // No verification data at all — do not invent drops
    return { dropped: [], capped: false };
  }

  // Compute diff: planned − delivered − pruned
  const deliveredSet = new Set(delivered);
  const prunedSet    = new Set(prunedIds);

  let dropped = planned.filter(p => !deliveredSet.has(p) && !prunedSet.has(p));

  const capped = dropped.length > REINJECT_CAP;
  if (capped) dropped = dropped.slice(0, REINJECT_CAP);

  const result = { dropped, capped };
  if (parseError) result.error = parseError;
  return result;
}

/**
 * isLargeTask — deterministic derivation of the `is_large_task` classify signal
 * (S04 review R6: without a specified derivation, DECOMPOSE was unreachable).
 *
 * Precedence:
 *   1. Frontmatter `large_task: true|false` (explicit planner signal) wins.
 *   2. Heuristic: >5 numbered steps, OR >=3 must_haves artifacts, OR plan >250 lines.
 *
 * @param {string} planContent  Full T##-PLAN.md content
 * @returns {boolean}
 */
function isLargeTask(planContent) {
  if (!planContent) return false;

  const fm = planContent.match(/^---[\s\S]*?---/);
  if (fm) {
    const explicit = fm[0].match(/^large_task:[ \t]*(true|false)/m);
    if (explicit) return explicit[1] === 'true';
  }

  const lines = planContent.split('\n');
  if (lines.length > 250) return true;

  // Numbered steps under any heading (e.g. "1. Do X")
  const steps = lines.filter(l => /^[ \t]*\d+\.[ \t]+\S/.test(l)).length;
  if (steps > 5) return true;

  if (hasStructuredMustHaves(planContent)) {
    try {
      const parsed = parseMustHaves(planContent);
      if ((parsed.artifacts || []).length >= 3) return true;
    } catch (_) { /* malformed — fall through to false */ }
  }

  return false;
}

/**
 * readRepairCount — read `repair_count` from T##-PLAN.md frontmatter (default 0).
 *
 * @param {string} planContent
 * @returns {number}
 */
function readRepairCount(planContent) {
  const fm = (planContent || '').match(/^---[\s\S]*?---/);
  if (!fm) return 0;
  const m = fm[0].match(/^repair_count:[ \t]*(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * incrementRepairCount — atomically bump `repair_count` in the plan's frontmatter
 * on disk (S04 review R9: the budget cap is the only guard against infinite repair
 * loops — it cannot depend on improvised YAML edits by the orchestrator).
 *
 * Inserts `repair_count: 1` if the key is absent; increments in place otherwise.
 * Throws on missing/malformed frontmatter (caller surfaces — never silent no-op).
 *
 * @param {string} planPath  Absolute path to T##-PLAN.md
 * @returns {number}  The new repair_count value
 */
function incrementRepairCount(planPath) {
  const content = fs.readFileSync(planPath, 'utf-8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`no frontmatter in ${planPath} — cannot persist repair_count`);

  const current = readRepairCount(content);
  const next = current + 1;

  let updated;
  if (/^repair_count:[ \t]*\d+/m.test(fm[1])) {
    updated = content.replace(/^(repair_count:[ \t]*)\d+/m, `$1${next}`);
  } else {
    updated = content.replace(/^---\n/, `---\nrepair_count: ${next}\n`);
  }

  fs.writeFileSync(planPath, updated);
  return next;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { classifyRepair, reinjectDiff, isLargeTask, readRepairCount, incrementRepairCount };

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    process.stdout.write([
      'Usage:',
      '  node scripts/forge-repair.js --classify \'<json>\'',
      '    Prints { strategy, reason } to stdout.',
      '',
      '  node scripts/forge-repair.js --reinject-diff \\',
      '    --plan <path> --verification <path>',
      '    [--pruned id,id,...] [--must-haves-status \'<json>\']',
      '    Prints { dropped, capped } to stdout.',
      '',
      '  node scripts/forge-repair.js --help',
    ].join('\n') + '\n');
    process.exit(0);
  }

  if (args[0] === '--classify') {
    let raw = args[1];
    if (!raw) {
      process.stderr.write('Error: --classify requires a JSON argument\n');
      process.exit(2);
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`Error: malformed JSON for --classify: ${e.message}\n`);
      process.exit(2);
    }
    const result = classifyRepair(input);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  if (args[0] === '--reinject-diff') {
    let planPath         = null;
    let verificationPath = null;
    let prunedIds        = [];
    let mustHavesStatus  = undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--plan' && args[i + 1]) {
        planPath = args[++i];
      } else if (args[i] === '--verification' && args[i + 1]) {
        verificationPath = args[++i];
      } else if (args[i] === '--pruned' && args[i + 1]) {
        prunedIds = args[++i].split(',').map(s => s.trim()).filter(Boolean);
      } else if (args[i] === '--must-haves-status' && args[i + 1]) {
        try {
          mustHavesStatus = JSON.parse(args[++i]);
        } catch (e) {
          process.stderr.write(`Error: malformed JSON for --must-haves-status: ${e.message}\n`);
          process.exit(2);
        }
      }
    }

    if (!planPath) {
      process.stderr.write('Error: --reinject-diff requires --plan <path>\n');
      process.exit(2);
    }

    let planContent = '';
    let verificationContent = '';

    try {
      planContent = fs.readFileSync(path.resolve(planPath), 'utf-8');
    } catch (e) {
      process.stderr.write(`Error reading plan: ${e.message}\n`);
      process.exit(2);
    }

    if (verificationPath) {
      try {
        verificationContent = fs.readFileSync(path.resolve(verificationPath), 'utf-8');
      } catch (_) {
        // File missing is graceful degradation — not an error
        verificationContent = '';
      }
    }

    const result = reinjectDiff({ planContent, verificationContent, prunedIds, mustHavesStatus });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.error) {
      // R5: parse/format errors are observable — exit 2 so gates can distinguish
      // "clean empty diff" (exit 0) from "diff unavailable" (exit 2).
      process.stderr.write(`Error: ${result.error}\n`);
      process.exit(2);
    }
    process.exit(0);
  }

  if (args[0] === '--increment-budget' || args[0] === '--read-budget' || args[0] === '--is-large-task') {
    const planPath = args[1];
    if (!planPath) {
      process.stderr.write(`Error: ${args[0]} requires a plan path argument\n`);
      process.exit(2);
    }
    try {
      if (args[0] === '--increment-budget') {
        const repair_count = incrementRepairCount(path.resolve(planPath));
        process.stdout.write(JSON.stringify({ repair_count }) + '\n');
      } else {
        const content = fs.readFileSync(path.resolve(planPath), 'utf-8');
        if (args[0] === '--read-budget') {
          process.stdout.write(JSON.stringify({ repair_count: readRepairCount(content) }) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ is_large_task: isLargeTask(content) }) + '\n');
        }
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(2);
    }
  }

  process.stderr.write('Error: unknown command. Use --help for usage.\n');
  process.exit(2);
}
