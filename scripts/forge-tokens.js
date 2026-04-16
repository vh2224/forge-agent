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

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { countTokens, truncateAtSectionBoundary };

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

  process.stderr.write('forge-tokens.js self-test: ALL PASS\n');
}
