#!/usr/bin/env node
/** @fileoverview forge-tokens.js — Math.ceil(chars/4) token counter + boundary-aware truncator for Forge context budgets. */
'use strict';

/**
 * Token counting heuristic: Math.ceil(chars / 4)  (M002-CONTEXT D1)
 * Zero npm dependencies — only Node built-ins (fs, path).
 * CommonJS dual-mode: require() for module use, or run directly as CLI.
 * Marker format: [...truncated N sections]
 * Mandatory-mode semantics: throw Error instead of truncating when opts.mandatory === true.
 * MEM036 nuance: classification outcomes = data; budget violations = exceptions.
 *   Do NOT "fix" the mandatory throw by swallowing it.
 */

const fs = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

// Canonical dispatch-table phase order (mirrors legacy skills/forge-status/SKILL.md § "Token usage").
const PHASE_ORDER = [
  'plan-milestone',
  'discuss-milestone',
  'research-milestone',
  'plan-slice',
  'discuss-slice',
  'research-slice',
  'execute-task',
  'complete-slice',
  'complete-milestone',
  'memory-extract',
];

// Reserve chars for worst-case marker: "\n\n[...truncated 999 sections]" = 32 chars → use 40 for safety.
const MARKER_LENGTH = 40;

// Boundary detection: split at lines starting with "## ", "### ", or lines that ARE exactly "---" or "***".
// Using lookahead so each part retains its leading boundary line (re-join with parts.join('') is lossless).
// Flags: g (all matches), m (^ anchors to line start).
const BOUNDARY_RE = /^(?=## |### |---$|\*\*\*$)/gm;

// ── Module functions ──────────────────────────────────────────────────────────

/**
 * Count tokens using the chars/4 heuristic.
 * Non-string input is coerced via String(x).
 * null/undefined → 0 tokens (String(null) = "null" but we special-case falsy to '').
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
function countTokens(text) {
  if (text == null) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Truncate content at markdown section boundaries to fit within a character budget.
 *
 * Algorithm:
 *  1. If content fits, return verbatim.
 *  2. If opts.mandatory === true, throw (never truncate mandatory sections).
 *  3. Strip frontmatter (--- block at top) before splitting (pitfall 2).
 *  4. Split on BOUNDARY_RE; each part retains its leading boundary line.
 *  5. Greedily keep parts from the start while running total + MARKER_LENGTH <= budgetChars.
 *  6. Append [...truncated N sections] marker.
 *  7. Fallback (zero boundaries or first section > budget): slice mid-content.
 *     This is the ONLY case where we cut mid-content (documented intentionally).
 *
 * @param {string} content
 * @param {number} budgetChars
 * @param {{ mandatory?: boolean, label?: string }} [opts]
 * @returns {string}
 */
function truncateAtSectionBoundary(content, budgetChars, opts) {
  if (!opts) opts = {};

  // Step 1: fits verbatim
  if (content.length <= budgetChars) {
    return content;
  }

  // Step 2: mandatory throw
  if (opts.mandatory === true) {
    throw new Error(
      `Context budget exceeded for mandatory section ${opts.label != null ? opts.label : '(unknown)'}: ${content.length} chars > ${budgetChars} budget`
    );
  }

  // Step 3: strip frontmatter before splitting
  // Frontmatter is a --- block at the very top of the document.
  let prefix = '';
  let body = content;
  const fmMatch = content.match(/^(---\n[\s\S]*?\n---\n?)/);
  if (fmMatch) {
    prefix = fmMatch[1];
    body = content.slice(prefix.length);
  }

  // Step 4: split body into sections
  // Reset lastIndex since BOUNDARY_RE has 'g' flag
  BOUNDARY_RE.lastIndex = 0;
  const parts = body.split(BOUNDARY_RE).filter(p => p.length > 0);

  // Step 5: greedy keep — budget must also accommodate the prefix and the marker
  const prefixLen = prefix.length;
  let running = prefixLen;
  let kept = 0;

  for (let i = 0; i < parts.length; i++) {
    const tentative = running + parts[i].length + MARKER_LENGTH;
    if (tentative > budgetChars && kept > 0) {
      break;
    }
    running += parts[i].length;
    kept++;
    if (running >= budgetChars) break;
  }

  const droppedCount = parts.length - kept;

  // Step 6: success path — we kept at least some sections and dropped some
  if (droppedCount > 0 && kept > 0) {
    const keptText = prefix + parts.slice(0, kept).join('');
    return keptText + `\n\n[...truncated ${droppedCount} sections]`;
  }

  // droppedCount === 0 after greedy pass means everything fits — but we already
  // failed the length check above. This can only happen when prefixLen alone
  // already fills the budget (degenerate case). Fall through to fallback.

  // Step 7: Fallback branch — zero boundaries OR first section alone > budget.
  // This is the only place we cut mid-content. Documented intentionally (MEM036).
  const cutAt = Math.max(0, budgetChars - MARKER_LENGTH);
  return content.substring(0, cutAt) + `\n\n[...truncated 1 sections]`;
}

/**
 * Read a JSONL file tolerantly: malformed/truncated lines are dropped, missing
 * files or I/O errors yield an empty array. Never throws.
 *
 * @param {string} absPath
 * @returns {object[]}
 */
function readJsonlLines(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      // malformed/truncated line — drop
    }
  }
  return out;
}

/**
 * Aggregate dispatch token telemetry for a milestone by joining the
 * per-milestone events file (membership) with the global events file
 * (token counts) on the exact (ts, unit) key.
 *
 * Read-only — never writes. Never throws (falls back to a "none" shape on
 * unexpected errors).
 *
 * @param {string} cwd
 * @param {{ milestoneId?: string }} [opts]
 * @returns {{
 *   milestone: string|null,
 *   total_input: number,
 *   total_output: number,
 *   dispatch_count: number,
 *   by_phase: Object<string,{count:number,input:number,output:number}>,
 *   has_telemetry: boolean,
 *   has_token_data: boolean,
 *   source: 'per-milestone'|'global'|'unattributable'|'none'
 * }}
 */
function aggregate(cwd, opts) {
  if (!opts) opts = {};
  const milestoneId = opts.milestoneId || null;

  const emptyResult = (source) => ({
    milestone: milestoneId,
    total_input: 0,
    total_output: 0,
    dispatch_count: 0,
    by_phase: {},
    has_telemetry: false,
    has_token_data: false,
    source: source,
  });

  try {
    const globalPath = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    const globalLines = readJsonlLines(globalPath);
    const dispatchLines = globalLines.filter((l) => l && l.event === 'dispatch' && typeof l.unit === 'string');

    let source = 'none';
    let selected = [];

    if (milestoneId) {
      const perMsPath = path.join(cwd, '.gsd', 'milestones', milestoneId, `${milestoneId}-events.jsonl`);
      const perMsLines = readJsonlLines(perMsPath);
      const membership = new Set();
      for (const l of perMsLines) {
        if (l && typeof l.unit === 'string' && typeof l.ts === 'string') {
          membership.add(`${l.ts}|${l.unit}`);
        }
      }

      if (membership.size > 0) {
        source = 'per-milestone';
        // R3 (defensive): dedup on (ts,unit) so a literal duplicate dispatch
        // line (same ts AND same unit, e.g. from a duplicate-write bug) is
        // counted at most once. Full fix (a unique dispatch id plumbed
        // through the telemetry pipeline) is deferred to a follow-up milestone.
        const seen = new Set();
        selected = [];
        for (const l of dispatchLines) {
          const key = `${l.ts}|${l.unit}`;
          if (!membership.has(key)) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          selected.push(l);
        }
      } else {
        // R2 fix: attribution REQUIRES per-milestone membership. When the
        // per-milestone events file is missing/empty/corrupt, we must NOT
        // sum the entire global log under this milestoneId — that would
        // silently attribute other milestones' totals to this one.
        // Distinguish: global has dispatches (unattributable) vs. truly empty (none).
        source = dispatchLines.length > 0 ? 'unattributable' : 'none';
        selected = [];
      }
    } else if (dispatchLines.length > 0) {
      source = 'global';
      selected = dispatchLines;
    }

    if (selected.length === 0) {
      return emptyResult(source);
    }

    let totalInput = 0;
    let totalOutput = 0;
    const byPhaseMap = {};

    for (const line of selected) {
      const inputTokens = typeof line.input_tokens === 'number' && !isNaN(line.input_tokens) ? line.input_tokens : 0;
      const outputTokens = typeof line.output_tokens === 'number' && !isNaN(line.output_tokens) ? line.output_tokens : 0;
      totalInput += inputTokens;
      totalOutput += outputTokens;

      const phase = String(line.unit).split('/')[0];
      if (!byPhaseMap[phase]) {
        byPhaseMap[phase] = { count: 0, input: 0, output: 0 };
      }
      byPhaseMap[phase].count += 1;
      byPhaseMap[phase].input += inputTokens;
      byPhaseMap[phase].output += outputTokens;
    }

    // Order by_phase per canonical PHASE_ORDER, then any unknown phases at the end.
    const byPhase = {};
    for (const phase of PHASE_ORDER) {
      if (byPhaseMap[phase]) {
        byPhase[phase] = byPhaseMap[phase];
      }
    }
    for (const phase of Object.keys(byPhaseMap)) {
      if (!byPhase[phase]) {
        byPhase[phase] = byPhaseMap[phase];
      }
    }

    return {
      milestone: milestoneId,
      total_input: totalInput,
      total_output: totalOutput,
      dispatch_count: selected.length,
      by_phase: byPhase,
      has_telemetry: selected.length > 0,
      has_token_data: (totalInput + totalOutput) > 0,
      source: source,
    };
  } catch (e) {
    return emptyResult('none');
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { countTokens, truncateAtSectionBoundary, aggregate };

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage:',
      '  echo "text" | node forge-tokens.js',
      '  node forge-tokens.js --file <path>',
      '  node forge-tokens.js --file <path> --truncate <budgetChars> [--mandatory]',
      '',
      'Flags:',
      '  --file <path>        Read from file instead of stdin',
      '  --truncate <n>       Truncate at section boundary to fit n chars',
      '  --mandatory          When used with --truncate: throw (exit 1) if overflow',
      '  --help               Show this message',
      '',
      'Default output: {"tokens":N,"chars":N,"method":"heuristic"}',
    ].join('\n') + '\n');
    process.exit(0);
  }

  try {
    // Parse flags using indexOf+1 idiom (merge-settings.js style)
    const fileIdx = args.indexOf('--file');
    const truncateIdx = args.indexOf('--truncate');
    const mandatory = args.includes('--mandatory');

    let filePath = null;
    if (fileIdx !== -1 && args[fileIdx + 1] !== undefined) {
      filePath = args[fileIdx + 1];
    }

    let budgetChars = null;
    if (truncateIdx !== -1) {
      const raw = args[truncateIdx + 1];
      if (raw === undefined || isNaN(Number(raw))) {
        process.stderr.write(JSON.stringify({ error: '--truncate requires a numeric argument' }) + '\n');
        process.exit(2);
      }
      budgetChars = Number(raw);
    }

    function run(text) {
      if (budgetChars !== null) {
        try {
          const truncated = truncateAtSectionBoundary(text, budgetChars, {
            mandatory: mandatory,
            label: '<cli>',
          });
          const result = {
            tokens: countTokens(text),
            chars: text.length,
            truncated_chars: truncated.length,
            truncated_tokens: countTokens(truncated),
            method: 'heuristic',
          };
          process.stdout.write(JSON.stringify(result) + '\n');
          process.exit(0);
        } catch (err) {
          process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
          process.exit(1);
        }
      } else {
        const result = {
          tokens: countTokens(text),
          chars: text.length,
          method: 'heuristic',
        };
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
      }
    }

    if (filePath !== null) {
      const text = fs.readFileSync(filePath, 'utf8');
      run(text);
    } else {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => { run(input); });
      if (process.stdin.isTTY) {
        run('');
      }
    }
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  }
}

// ── Self-test block ───────────────────────────────────────────────────────────
if (process.env.FORGE_TOKENS_SELFTEST) {
  // ASSERT: countTokens('hello world') === 3  (11 chars / 4 = 2.75 → ceil = 3)
  const t1 = countTokens('hello world');
  if (t1 !== 3) throw new Error(`SELFTEST FAIL: countTokens('hello world') expected 3, got ${t1}`);

  // ASSERT: countTokens('') === 0
  const t2 = countTokens('');
  if (t2 !== 0) throw new Error(`SELFTEST FAIL: countTokens('') expected 0, got ${t2}`);

  // ASSERT: countTokens('a'.repeat(40000)) === 10000
  const t3 = countTokens('a'.repeat(40000));
  if (t3 !== 10000) throw new Error(`SELFTEST FAIL: countTokens('a'.repeat(40000)) expected 10000, got ${t3}`);

  // ASSERT: truncateAtSectionBoundary on multi-section content returns marker
  const t4 = truncateAtSectionBoundary('## A\ncontent\n## B\nmore', 10);
  if (!t4.includes('[...truncated') || !t4.includes('sections]')) {
    throw new Error(`SELFTEST FAIL: expected truncation marker in: ${t4}`);
  }

  // ASSERT: truncateAtSectionBoundary('short', 100) returns 'short'
  const t5 = truncateAtSectionBoundary('short', 100);
  if (t5 !== 'short') throw new Error(`SELFTEST FAIL: expected 'short', got: ${t5}`);

  // ASSERT: mandatory mode throws with correct message
  let threw = false;
  try {
    truncateAtSectionBoundary('x'.repeat(1000), 100, { mandatory: true, label: 'test' });
  } catch (e) {
    if (!/Context budget exceeded for mandatory section test/.test(e.message)) {
      throw new Error(`SELFTEST FAIL: wrong error message: ${e.message}`);
    }
    threw = true;
  }
  if (!threw) throw new Error('SELFTEST FAIL: mandatory mode did not throw');

  // ASSERT: aggregate() joins per-milestone membership with global token telemetry
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tokens-selftest-'));
  try {
    const milestoneId = 'M-selftest';
    const msDir = path.join(tmpDir, '.gsd', 'milestones', milestoneId);
    const forgeDir = path.join(tmpDir, '.gsd', 'forge');
    fs.mkdirSync(msDir, { recursive: true });
    fs.mkdirSync(forgeDir, { recursive: true });

    const ts1 = '2026-07-02T19:55:51Z';
    const ts2 = '2026-07-02T19:56:10Z';

    const perMsLines = [
      { ts: ts1, unit: 'execute-task/T01', milestone: milestoneId, status: 'done' },
      { ts: ts2, unit: 'execute-task/T02', milestone: milestoneId, status: 'done' },
    ];
    fs.writeFileSync(
      path.join(msDir, `${milestoneId}-events.jsonl`),
      perMsLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );

    const globalLines = [
      { ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 100, output_tokens: 50 },
      { ts: ts2, event: 'dispatch', unit: 'execute-task/T02', input_tokens: 0, output_tokens: 0 },
    ];
    fs.writeFileSync(
      path.join(forgeDir, 'events.jsonl'),
      globalLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );

    const agg = aggregate(tmpDir, { milestoneId });
    if (agg.dispatch_count !== 2) throw new Error(`SELFTEST FAIL: aggregate dispatch_count expected 2, got ${agg.dispatch_count}`);
    if (agg.total_input !== 100) throw new Error(`SELFTEST FAIL: aggregate total_input expected 100, got ${agg.total_input}`);
    if (agg.has_token_data !== true) throw new Error('SELFTEST FAIL: aggregate has_token_data expected true');
    if (agg.has_telemetry !== true) throw new Error('SELFTEST FAIL: aggregate has_telemetry expected true');
    if (agg.source !== 'per-milestone') throw new Error(`SELFTEST FAIL: aggregate source expected 'per-milestone', got ${agg.source}`);

    // ASSERT: all-zero tokens still yields has_telemetry:true, has_token_data:false
    const globalZeroLines = [
      { ts: ts1, event: 'dispatch', unit: 'execute-task/T01', input_tokens: 0, output_tokens: 0 },
      { ts: ts2, event: 'dispatch', unit: 'execute-task/T02', input_tokens: 0, output_tokens: 0 },
    ];
    fs.writeFileSync(
      path.join(forgeDir, 'events.jsonl'),
      globalZeroLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );
    const aggZero = aggregate(tmpDir, { milestoneId });
    if (aggZero.has_telemetry !== true) throw new Error('SELFTEST FAIL: aggregate zero-token has_telemetry expected true');
    if (aggZero.has_token_data !== false) throw new Error('SELFTEST FAIL: aggregate zero-token has_token_data expected false');
    if (aggZero.dispatch_count !== 2) throw new Error(`SELFTEST FAIL: aggregate zero-token dispatch_count expected 2, got ${aggZero.dispatch_count}`);

    // ASSERT: no files at all -> has_telemetry:false
    const emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tokens-selftest-empty-'));
    try {
      const aggNone = aggregate(emptyTmpDir, { milestoneId: 'M-nonexistent' });
      if (aggNone.has_telemetry !== false) throw new Error('SELFTEST FAIL: aggregate none has_telemetry expected false');
      if (aggNone.source !== 'none') throw new Error(`SELFTEST FAIL: aggregate none source expected 'none', got ${aggNone.source}`);
    } finally {
      fs.rmSync(emptyTmpDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.stderr.write('forge-tokens.js self-test: ALL PASS\n');
}
