#!/usr/bin/env node
/** @fileoverview forge-tokens.js — Math.ceil(chars/4) token counter + boundary-aware truncator for Forge context budgets. */
'use strict';

/**
 * Token counting heuristic: Math.ceil(chars / 4)  (M002-CONTEXT D1)
 * Zero npm dependencies — only Node built-ins (fs, path).
 * CommonJS dual-mode: require() for module use, or run directly as CLI.
 * Marker format: [...truncated N sections] (without opts.source) or
 *   [...truncated N sections — see <source>] (with opts.source) — both share the
 *   [...truncated  prefix and sections]/sections — token, so the self-test and
 *   any prefix-based caller keep working unmodified.
 * Mandatory-mode semantics: throw Error instead of truncating when opts.mandatory === true.
 * MEM036 nuance: classification outcomes = data; budget violations = exceptions.
 *   Do NOT "fix" the mandatory throw by swallowing it.
 */

const fs = require('fs');
const path = require('path');
const { readJsonl } = require('./forge-jsonl.js');

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

// (MARKER_LENGTH fixed reserve removed — the marker reserve is now derived from
// the actual marker text emitted by truncationMarker(), never a fixed guess.)

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
 * Build the truncation marker text for a given dropped-section count.
 *
 * With `opts.source` present, the marker names where the dropped content can
 * be reread: `\n\n[...truncated N sections — see <source>]`. Without it, the
 * marker is byte-identical to the historical format:
 * `\n\n[...truncated N sections]`. The prefix `[...truncated ` and the
 * `sections]`/`sections —` token are preserved either way — this is an
 * additive extension, never a substitution, so the self-test and any
 * existing prefix asserts keep passing unmodified.
 *
 * Not exported: the public surface stays countTokens/truncateAtSectionBoundary/aggregate.
 *
 * @param {number} droppedCount
 * @param {{ source?: string }} [opts]
 * @returns {string}
 */
function truncationMarker(droppedCount, opts) {
  if (!opts) opts = {};
  if (opts.source) {
    return `\n\n[...truncated ${droppedCount} sections — see ${opts.source}]`;
  }
  return `\n\n[...truncated ${droppedCount} sections]`;
}

/**
 * True when the budget cannot hold even the shortest (source-less) marker for
 * this dropped count. In that case emitting any marker would slice it into an
 * unterminated fragment.
 *
 * @param {number} budgetChars
 * @param {number} droppedCount
 * @returns {boolean}
 */
function tooSmallForMarker(budgetChars, droppedCount) {
  return truncationMarker(droppedCount, {}).length > budgetChars;
}

/**
 * Terminal degradation of the marker ladder: a single ellipsis, or the empty
 * string when the budget is 0. Mirrors scripts/forge-prompt.js:181.
 *
 * @param {number} budgetChars
 * @returns {string}
 */
function ellipsisFor(budgetChars) {
  return budgetChars <= 0 ? '' : '…';
}

/**
 * Truncate content at markdown section boundaries to fit within a character budget.
 *
 * Algorithm:
 *  1. If content fits, return verbatim.
 *  2. If opts.mandatory === true, throw (never truncate mandatory sections).
 *  3. Strip frontmatter (--- block at top) before splitting (pitfall 2).
 *  4. Split on BOUNDARY_RE; each part retains its leading boundary line.
 *  5. Greedily keep parts from the start while running total + reserve <= budgetChars,
 *     where reserve is the length of the marker actually being emitted (derived from
 *     truncationMarker(), not a fixed guess) — worst case sized for parts.length dropped.
 *     The marker regime is settled before the reserve is spent: the reserve is always
 *     the shortest (source-less) marker, so no whole section is ever dropped to pay for
 *     a pointer that may not be printed. Step 6 upgrades to the source-bearing marker
 *     when it fits at that content length.
 *  6. Append the truncationMarker() text; if the derived reserve does not fit inside
 *     budgetChars, degrade to the source-less (shorter) marker before ever exceeding it.
 *  7. Fallback (zero boundaries or first section > budget): slice mid-content.
 *     This is the ONLY case where we cut mid-content (documented intentionally).
 *     The return value here is also guarded to never exceed budgetChars.
 *
 * @param {string} content
 * @param {number} budgetChars
 * @param {{ mandatory?: boolean, label?: string, source?: string }} [opts]
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
  const fmMatch = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
  if (fmMatch) {
    prefix = fmMatch[1];
    body = content.slice(prefix.length);
  }

  // Step 4: split body into sections
  // Reset lastIndex since BOUNDARY_RE has 'g' flag
  BOUNDARY_RE.lastIndex = 0;
  const parts = body.split(BOUNDARY_RE).filter(p => p.length > 0);

  // Step 5: greedy keep — budget must also accommodate the prefix and the marker.
  // Reserve is derived from the marker actually being emitted, worst-cased on
  // parts.length dropped sections (the highest digit count possible), never a
  // fixed guessed constant.
  //
  // The marker REGIME is settled BEFORE the reserve is spent. Reserving for the
  // source-bearing marker while step 6 may end up emitting the shorter
  // source-less one made a long opts.source cost whole sections that actually
  // fit — and could force the mid-content fallback for nothing. So we select
  // against the shortest (source-less) marker, and step 6 upgrades to the
  // source-bearing marker only when it still fits at that content length.
  // Content wins over the pointer, consistent with the pre-existing degradation
  // order (drop the source pointer before ever slicing retained text).
  const reserve = truncationMarker(parts.length, {}).length;
  const prefixLen = prefix.length;
  let running = prefixLen;
  let kept = 0;

  for (let i = 0; i < parts.length; i++) {
    const tentative = running + parts[i].length + reserve;
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
    // Guard: a budget too small for even the shortest marker must never emit a
    // sliced (unterminated) marker. Mirror forge-prompt.js:181 — degrade to the
    // silent ellipsis instead. The `[...truncated ` prefix contract in
    // shared/forge-dispatch.md only admits complete markers.
    if (tooSmallForMarker(budgetChars, droppedCount)) {
      return ellipsisFor(budgetChars);
    }
    let keptText = prefix + parts.slice(0, kept).join('');
    // Regime upgrade: the selection above reserved for the source-less marker,
    // so take the source pointer only when it fits at this content length.
    let marker = truncationMarker(droppedCount, {});
    if (opts.source) {
      const withSource = truncationMarker(droppedCount, opts);
      if (keptText.length + withSource.length <= budgetChars) {
        marker = withSource;
      }
    }

    // Guard: the source-less marker itself can still overflow in degenerate
    // cases (prefix alone near the budget) — trim keptText rather than exceed.
    if (keptText.length + marker.length > budgetChars) {
      keptText = keptText.slice(0, Math.max(0, budgetChars - marker.length));
    }

    return clampToBudget(keptText + marker, budgetChars);
  }

  // droppedCount === 0 after greedy pass means everything fits — but we already
  // failed the length check above. This can only happen when prefixLen alone
  // already fills the budget (degenerate case). Fall through to fallback.

  // Step 7: Fallback branch — zero boundaries OR first section alone > budget.
  // This is the only place we cut mid-content. Documented intentionally (MEM036).
  // Reserve here mirrors step 5: derived from the marker actually emitted, not
  // a fixed constant.
  let fallbackMarker = truncationMarker(1, opts);
  if (fallbackMarker.length >= budgetChars && opts.source) {
    // Source pointer alone doesn't fit — degrade to the shorter marker.
    fallbackMarker = truncationMarker(1, {});
  }
  // Same guard as step 6: below the shortest marker there is no room for any
  // complete marker, with or without opts.source. Emit the ellipsis, never a
  // sliced `[...tru` fragment.
  if (tooSmallForMarker(budgetChars, 1)) {
    return ellipsisFor(budgetChars);
  }
  const cutAt = Math.max(0, budgetChars - fallbackMarker.length);
  return clampToBudget(content.substring(0, cutAt) + fallbackMarker, budgetChars);
}

/**
 * Final safety net: never return a string longer than budgetChars, regardless
 * of how long an opts.source pointer turned out to be. Guarantees the "never
 * exceed budgetChars" invariant even in degenerate cases (e.g. a source path
 * longer than the whole budget).
 *
 * @param {string} text
 * @param {number} budgetChars
 * @returns {string}
 */
function clampToBudget(text, budgetChars) {
  if (text.length <= budgetChars) return text;
  return text.slice(0, budgetChars);
}

/**
 * Classify the provenance of a token count without treating an arbitrary
 * string as provider billing data.  Existing Forge events use the local
 * chars/4 heuristic; future adapters or an OTel bridge can opt into the
 * reported bucket with an explicit provider-*, otel-* or exact-* method.
 *
 * @param {*} value
 * @returns {'estimated'|'reported'|'unknown'}
 */
function tokenMethodKind(value) {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const method = value.trim().toLowerCase();
  if (method.startsWith('heuristic-')) return 'estimated';
  if (method.startsWith('provider-') || method.startsWith('otel-') || method.startsWith('exact-')) return 'reported';
  return 'unknown';
}

function emptyTokenSources() {
  return {
    estimated: { count: 0, input: 0, output: 0 },
    reported: { count: 0, input: 0, output: 0 },
    unknown: { count: 0, input: 0, output: 0 },
  };
}

function tokenDataQuality(sources) {
  const estimated = sources.estimated.count > 0;
  const reported = sources.reported.count > 0;
  const unknown = sources.unknown.count > 0;
  if (!estimated && !reported && !unknown) return 'none';
  if (reported && !estimated && !unknown) return 'reported';
  if (estimated && !reported && !unknown) return 'estimated';
  if (unknown && !estimated && !reported) return 'unknown';
  return 'mixed';
}

/**
 * Aggregate dispatch token telemetry for a milestone.
 *
 * Modern dispatch events carry their own `milestone` discriminator, which is
 * the canonical attribution source. Older events did not, so they retain the
 * conservative per-milestone membership fallback on the exact (ts, unit) key.
 * The fallback intentionally prefers under-attribution to assigning another
 * milestone's usage to the requested one.
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
 *   token_sources: Object<'estimated'|'reported'|'unknown',{count:number,input:number,output:number}>,
 *   token_data_quality: 'none'|'estimated'|'reported'|'unknown'|'mixed',
 *   has_telemetry: boolean,
 *   has_token_data: boolean,
 *   source: 'global-milestone'|'per-milestone'|'global'|'unattributable'|'none'
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
    token_sources: emptyTokenSources(),
    token_data_quality: 'none',
    has_telemetry: false,
    has_token_data: false,
    source: source,
  });

  try {
    const globalPath = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    const globalLines = readJsonl(globalPath).lines;
    const dispatchLines = globalLines.filter((l) => l && l.event === 'dispatch' && typeof l.unit === 'string');

    let source = 'none';
    let selected = [];

    if (milestoneId) {
      // Canonical path: modern dispatch events are self-attributing. This also
      // keeps telemetry available after the per-milestone log is archived.
      const canonical = dispatchLines.filter((l) => l.milestone === milestoneId);

      // Compatibility path: only events with NO milestone discriminator may
      // participate in the legacy join. A line explicitly attributed to a
      // different milestone must never be pulled in through unit/timestamp
      // coincidence.
      const perMsPath = path.join(cwd, '.gsd', 'milestones', milestoneId, `${milestoneId}-events.jsonl`);
      const perMsLines = readJsonl(perMsPath).lines;
      const membership = new Set();
      for (const l of perMsLines) {
        if (l && typeof l.unit === 'string' && typeof l.ts === 'string') {
          membership.add(`${l.ts}|${l.unit}`);
        }
      }

      const legacySelected = [];
      if (membership.size > 0) {
        for (const l of dispatchLines) {
          if (l.milestone !== undefined && l.milestone !== null) continue;
          const key = `${l.ts}|${l.unit}`;
          if (!membership.has(key)) continue;
          legacySelected.push(l);
        }
      }

      if (canonical.length > 0) {
        source = 'global-milestone';
        // A milestone may span an upgrade. Include any safely attributable
        // legacy rows alongside its canonical rows.
        selected = canonical.concat(legacySelected);
      } else if (legacySelected.length > 0) {
        source = 'per-milestone';
        selected = legacySelected;
      } else {
        // No canonical row and no safe legacy match: never sum the whole
        // global log under this milestone. Distinguish unattributable data
        // from a truly empty log.
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

    // Prefer the stable dispatch id when present. Legacy, unattributed rows
    // have no id, so retain the old exact (ts,unit) defensive dedupe for those
    // rows only. A canonical row without an id cannot be safely identified as
    // a duplicate; count it rather than risk hiding a legitimate retry.
    const deduped = [];
    const seenDispatchIds = new Set();
    const seenLegacyKeys = new Set();
    for (const line of selected) {
      const dispatchId = typeof line.dispatch_id === 'string' ? line.dispatch_id.trim() : '';
      if (dispatchId) {
        if (seenDispatchIds.has(dispatchId)) continue;
        seenDispatchIds.add(dispatchId);
      } else if (line.milestone === undefined || line.milestone === null) {
        const legacyKey = `${line.ts}|${line.unit}`;
        if (seenLegacyKeys.has(legacyKey)) continue;
        seenLegacyKeys.add(legacyKey);
      }
      deduped.push(line);
    }
    selected = deduped;

    let totalInput = 0;
    let totalOutput = 0;
    const byPhaseMap = {};
    const tokenSources = emptyTokenSources();

    for (const line of selected) {
      const inputTokens = typeof line.input_tokens === 'number' && !isNaN(line.input_tokens) ? line.input_tokens : 0;
      const outputTokens = typeof line.output_tokens === 'number' && !isNaN(line.output_tokens) ? line.output_tokens : 0;
      totalInput += inputTokens;
      totalOutput += outputTokens;

      const source = tokenSources[tokenMethodKind(line.token_method)];
      source.count += 1;
      source.input += inputTokens;
      source.output += outputTokens;

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
      token_sources: tokenSources,
      token_data_quality: tokenDataQuality(tokenSources),
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

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write([
      'Usage:',
      '  echo "text" | node forge-tokens.js',
      '  echo "text" | node forge-tokens.js --scalar',
      '  node forge-tokens.js --inline <text>',
      '  node forge-tokens.js --file <path>',
      '  node forge-tokens.js --file <path> --truncate <budgetChars> [--mandatory]',
      '',
      'Flags:',
      '  --scalar             Read stdin and print the raw integer only',
      '  --inline <text>      Count inline text and print the raw integer only',
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
    // `--inline` is a deliberately small scalar-output compatibility mode for
    // the Forge skill call sites. It is exclusive so malformed invocations do
    // not silently fall through to an empty stdin count.
    const inlineIdx = args.indexOf('--inline');
    if (inlineIdx !== -1) {
      if (args.length !== 2 || inlineIdx !== 0 || args[1] === undefined) {
        process.stderr.write(JSON.stringify({ error: '--inline requires exactly one text argument and cannot be combined with other flags' }) + '\n');
        process.exit(2);
      }
      process.stdout.write(String(countTokens(args[1])) + '\n');
      process.exit(0);
    }

    // Prefer this mode at orchestration call sites: large agent results remain
    // on stdin instead of crossing argv/command-line limits (notably Windows).
    if (args.includes('--scalar')) {
      if (args.length !== 1 || args[0] !== '--scalar') {
        process.stderr.write(JSON.stringify({ error: '--scalar cannot be combined with other flags' }) + '\n');
        process.exit(2);
      }
      if (process.stdin.isTTY) {
        process.stdout.write('0\n');
        process.exit(0);
      }
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => {
        process.stdout.write(String(countTokens(input)) + '\n');
      });
      return;
    }

    // Parse flags using indexOf+1 idiom (merge-settings.js style)
    const fileIdx = args.indexOf('--file');
    const truncateIdx = args.indexOf('--truncate');
    const mandatory = args.includes('--mandatory');

    const allowedFlags = new Set(['--file', '--truncate', '--mandatory']);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!allowedFlags.has(arg)) {
        process.stderr.write(JSON.stringify({ error: `unknown argument: ${arg}` }) + '\n');
        process.exit(2);
      }
      if (arg === '--file' || arg === '--truncate') i++;
    }

    let filePath = null;
    if (fileIdx !== -1) {
      if (args[fileIdx + 1] === undefined) {
        process.stderr.write(JSON.stringify({ error: '--file requires a path argument' }) + '\n');
        process.exit(2);
      }
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
