#!/usr/bin/env node
// forge-symbol-check.js — Drift guard rung-0: symbol resolver (plan vs code)
//
// Exports:
//   parseSymbolsFromPlan(planContent) → string[]
//     Heuristic rung-0: extracts symbol names from ## Must-Haves / ## Steps / key_links.via
//     sections using regex patterns that match function/export/constant names.
//     This is BEST-EFFORT — designed to avoid false negatives, not guarantee complete coverage.
//
//   resolveSymbol(symbol, cwd) → { state, ...fields }
//     Non-binary resolver:
//       VERIFIED   → { state: 'VERIFIED', location: '<file>:<line>', exported: <bool> }
//       MISSING    → { state: 'MISSING' }
//       AMBIGUOUS  → { state: 'AMBIGUOUS', candidates: ['<file>:<line>', ...] }
//       UNCHECKABLE→ { state: 'UNCHECKABLE', reason: '<string>' }
//     Uses ripgrep (rg), falls back to grep. If neither available → UNCHECKABLE.
//
//   checkSymbols(planContent, cwd) → {
//     symbols: [{ symbol, state, ...fields }],
//     coverage: { unchecked: [{ symbol, reason }], greenfield: [string] }
//   }
//     Orchestrates: parse → greenfield exclusion → resolve remaining.
//     coverage block is ALWAYS present (UNCHECKABLE is always logged).
//
// CLI usage:
//   node scripts/forge-symbol-check.js --check <plan.md>
//   Prints JSON { symbols, counts, coverage } to stdout.
//   --cwd <dir>: source-search root (default: process.cwd(); gates pass CODE_DIR).
//   Exit codes:
//     0 — check ran successfully (even with MISSING/AMBIGUOUS — advisory posture)
//     2 — I/O error or invalid usage
//   Exit code is ADVISORY: callers (gates) decide what to do with MISSING/AMBIGUOUS.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  hasStructuredMustHaves,
  parseMustHaves,
} = require('./forge-must-haves');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB cap

// Definition-match patterns: lines that actually define a symbol (not just use it).
// These patterns are used to filter grep/rg matches down to definition sites.
// MEM004: use [ \t] not \s; use flag m for multiline matching.
const DEFINITION_PATTERNS = [
  // function declaration: "function symbolName"
  /^[^\S\r\n]*(?:async[ \t]+)?function[ \t]+__SYMBOL__[ \t]*\(/,
  // const/let/var assignment: "const symbolName =" or "const symbolName="
  /^[^\S\r\n]*(?:const|let|var)[ \t]+__SYMBOL__[ \t]*=/,
  // class declaration: "class symbolName"
  /^[^\S\r\n]*(?:export[ \t]+)?class[ \t]+__SYMBOL__[ \t]*(?:\{|extends)/,
  // object/exports key: "symbolName:" or "symbolName :"
  /^[^\S\r\n]*__SYMBOL__[ \t]*:[ \t]*/,
  // ES6 named export function: "export function symbolName"
  /^[^\S\r\n]*export[ \t]+(?:async[ \t]+)?function[ \t]+__SYMBOL__[ \t]*\(/,
  // ES6 named export const: "export const symbolName"
  /^[^\S\r\n]*export[ \t]+(?:const|let|var)[ \t]+__SYMBOL__[ \t]*=/,
];

// Export-detection patterns: lines that export a symbol
const EXPORT_PATTERNS = [
  /\bexport\b/,
  /\bmodule\.exports\b/,
  /\bexports\b\./,
];

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Check if a tool is available via spawnSync --version probe.
 *
 * @param {string} tool
 * @returns {boolean}
 */
function isToolAvailable(tool) {
  try {
    const result = spawnSync(tool, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Run ripgrep to find all lines matching a word-boundary pattern for the symbol.
 * Returns array of { file, line, text } or null on error.
 *
 * @param {string} symbol
 * @param {string} cwd
 * @returns {Array<{file:string,line:number,text:string}>|null}
 */
function runRipgrep(symbol, cwd) {
  try {
    const result = spawnSync(
      'rg',
      [
        '--json',
        '-n',
        '--no-heading',
        '-e',
        `\\b${symbol}\\b`,
        cwd,
      ],
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.error) return null;

    const lines = (result.stdout || '').split('\n').filter(Boolean);
    const matches = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match' && obj.data) {
          const file = obj.data.path && obj.data.path.text ? obj.data.path.text : '';
          const lineNum = obj.data.line_number || 0;
          const text = obj.data.lines && obj.data.lines.text ? obj.data.lines.text : '';
          if (file) {
            matches.push({ file, line: lineNum, text: text.trim() });
          }
        }
      } catch (_) {
        // skip malformed JSON lines
      }
    }
    return matches;
  } catch (_) {
    return null;
  }
}

/**
 * Run grep to find all lines matching a word-boundary pattern for the symbol.
 * Returns array of { file, line, text } or null on error.
 *
 * @param {string} symbol
 * @param {string} cwd
 * @returns {Array<{file:string,line:number,text:string}>|null}
 */
function runGrep(symbol, cwd) {
  try {
    const result = spawnSync(
      'grep',
      [
        '-rn',
        '--include=*.js',
        '--include=*.ts',
        '--include=*.mjs',
        '--include=*.cjs',
        '--',
        `\\b${symbol}\\b`,
        cwd,
      ],
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.error) return null;

    const lines = (result.stdout || '').split('\n').filter(Boolean);
    const matches = [];
    for (const rawLine of lines) {
      // Format: file:lineNum:text
      const m = rawLine.match(/^(.+?):(\d+):(.*)/);
      if (m) {
        matches.push({
          file: m[1],
          line: parseInt(m[2], 10),
          text: m[3].trim(),
        });
      }
    }
    return matches;
  } catch (_) {
    return null;
  }
}

/**
 * Determine if a line is a definition site for the given symbol.
 * Uses DEFINITION_PATTERNS with the symbol substituted.
 *
 * @param {string} text  Line text
 * @param {string} symbol
 * @returns {boolean}
 */
function isDefinitionLine(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const pattern of DEFINITION_PATTERNS) {
    const src = pattern.source.replace(/__SYMBOL__/g, escaped);
    const re = new RegExp(src, 'm');
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Determine if a line appears to export the symbol.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isExportLine(text) {
  for (const pattern of EXPORT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Build the greenfield exclusion set from a structured plan.
 * Includes:
 *  - basenames (without extension) of each artifacts[].path
 *  - basenames of each expected_output entry
 *  - identifiers that appear in artifacts[].provides or artifacts[].truths
 *
 * For legacy plans (no must_haves), returns an empty Set.
 *
 * @param {string} planContent
 * @returns {Set<string>}
 */
function buildGreenfieldSet(planContent) {
  if (!hasStructuredMustHaves(planContent)) {
    return new Set();
  }
  let parsed;
  try {
    parsed = parseMustHaves(planContent);
  } catch (_) {
    return new Set();
  }

  const set = new Set();

  // basenames of artifact paths (without extension)
  for (const artifact of (parsed.artifacts || [])) {
    if (artifact.path) {
      const base = path.basename(artifact.path, path.extname(artifact.path));
      set.add(base);
      // Also add the full basename including extension
      set.add(path.basename(artifact.path));
    }
  }

  // basenames of expected_output entries
  for (const out of (parsed.expected_output || [])) {
    const base = path.basename(out, path.extname(out));
    set.add(base);
    set.add(path.basename(out));
  }

  // Extract identifiers from provides/truths text
  const texts = [];
  for (const artifact of (parsed.artifacts || [])) {
    if (artifact.provides) texts.push(artifact.provides);
  }
  for (const truth of (parsed.truths || [])) {
    texts.push(truth);
  }

  const identRe = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
  for (const text of texts) {
    let m;
    identRe.lastIndex = 0;
    while ((m = identRe.exec(text)) !== null) {
      // Only add camelCase or snake_case identifiers (not plain words)
      const id = m[1];
      if (/[A-Z_]/.test(id) || /[a-z][A-Z]/.test(id) || id.includes('_')) {
        set.add(id);
      }
    }
  }

  return set;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse symbols cited in a plan's ## Must-Haves and ## Steps sections.
 * Heuristic rung-0: regex-based extraction of function/export/constant names.
 * Patterns matched:
 *   - "exports: funcA, funcB, funcC"
 *   - "export of `funcName`"
 *   - "import of `funcName`"
 *   - "function `funcName`"
 *   - "via import of `name`"
 *   - "via require(...) → name1/name2" or "via require('x') for name1, name2"
 *   - backtick-wrapped identifiers in Must-Haves/Steps context
 *
 * This is BEST-EFFORT. It may miss some symbols and may include non-symbol names.
 * Use [ \t] not \s (MEM004 — avoid crossing newlines).
 *
 * @param {string} planContent  Full plan file content
 * @returns {string[]}  Deduplicated array of symbol names
 */
function parseSymbolsFromPlan(planContent) {
  const symbols = new Set();

  // Extract relevant sections: ## Must-Haves, ## Steps, ## Context, ## Goal
  // Split on section boundaries (lines starting with ##), then collect targeted sections
  const sectionHeadingRe = /^##[ \t]+(?:Must-Haves|Steps|Context|Goal)/;
  const parts = planContent.split(/\n(?=##[ \t])/);
  let sectionContent = '';
  for (const part of parts) {
    if (sectionHeadingRe.test(part)) {
      sectionContent += '\n' + part;
    }
  }

  // Also extract from key_links.via fields in frontmatter
  const viaRe = /via:[ \t]+"?([^"\n]+)"?/gm;
  let viaMatch;
  while ((viaMatch = viaRe.exec(planContent)) !== null) {
    sectionContent += '\n' + viaMatch[1];
  }

  // Also extract from provides: fields in frontmatter
  const providesRe = /provides:[ \t]+"?([^"\n]+)"?/gm;
  let providesMatch;
  while ((providesMatch = providesRe.exec(planContent)) !== null) {
    sectionContent += '\n' + providesMatch[1];
  }

  // Pattern 1: "exports: funcA, funcB" or "exports funcA, funcB"
  const exportsListRe = /\bexports?[: \t]+([A-Za-z_$][A-Za-z0-9_$, \t/]+)/gm;
  let m;
  while ((m = exportsListRe.exec(sectionContent)) !== null) {
    const names = m[1].split(/[,/ \t]+/).map(s => s.trim()).filter(s => /^[A-Za-z_$][A-Za-z0-9_$]+$/.test(s));
    for (const n of names) symbols.add(n);
  }

  // Pattern 2: backtick-wrapped identifiers followed by context words
  // e.g. `funcName`, `checkSymbols`, `parseMustHaves`
  const backtickRe = /`([A-Za-z_$][A-Za-z0-9_$]+)`/gm;
  while ((m = backtickRe.exec(sectionContent)) !== null) {
    const name = m[1];
    // Skip very short names (likely not functions), common keywords
    if (name.length >= 3 && !['the', 'for', 'and', 'not', 'use', 'run', 'get', 'set', 'let', 'var', 'new'].includes(name)) {
      symbols.add(name);
    }
  }

  // Pattern 3: "require('./module') for name" or "→ name1/name2"
  const requireForRe = /require\([^)]+\)(?:[ \t]+for[ \t]+|[ \t]*→[ \t]*)([A-Za-z_$][A-Za-z0-9_$,/ \t]+)/gm;
  while ((m = requireForRe.exec(sectionContent)) !== null) {
    const names = m[1].split(/[,/ \t]+/).map(s => s.trim()).filter(s => /^[A-Za-z_$][A-Za-z0-9_$]+$/.test(s));
    for (const n of names) symbols.add(n);
  }

  // Pattern 4: "import of `name`" or "export of `name`" or "function `name`"
  const importExportRe = /(?:import|export|function)[ \t]+(?:of[ \t]+)?`([A-Za-z_$][A-Za-z0-9_$]+)`/gm;
  while ((m = importExportRe.exec(sectionContent)) !== null) {
    symbols.add(m[1]);
  }

  return [...symbols];
}

/**
 * Resolve a single symbol against the codebase at cwd.
 * Non-binary result:
 *   VERIFIED   → { state: 'VERIFIED', location: '<file>:<line>', exported: boolean }
 *   MISSING    → { state: 'MISSING' }
 *   AMBIGUOUS  → { state: 'AMBIGUOUS', candidates: ['<file>:<line>', ...] }
 *   UNCHECKABLE→ { state: 'UNCHECKABLE', reason: string }
 *
 * Always wrapped in try/catch — never throws to caller.
 *
 * @param {string} symbol
 * @param {string} cwd  Directory to search in
 * @returns {{ state: string, [key: string]: * }}
 */
function resolveSymbol(symbol, cwd) {
  try {
    // Guard: dynamic symbol detection (interpolation / template literals in symbol name itself)
    if (symbol.includes('${') || symbol.includes('`')) {
      return { state: 'UNCHECKABLE', reason: 'dynamic-symbol' };
    }

    // Check tool availability
    const hasRg = isToolAvailable('rg');
    const hasGrep = isToolAvailable('grep');

    if (!hasRg && !hasGrep) {
      return { state: 'UNCHECKABLE', reason: 'no-ripgrep-or-grep' };
    }

    // Run search
    let matches = null;
    if (hasRg) {
      matches = runRipgrep(symbol, cwd);
    }
    if (matches === null && hasGrep) {
      matches = runGrep(symbol, cwd);
    }
    if (matches === null) {
      return { state: 'UNCHECKABLE', reason: 'search-tool-error' };
    }

    // Filter to definition lines only
    const definitions = matches.filter(m => isDefinitionLine(m.text, symbol));

    if (definitions.length === 0) {
      return { state: 'MISSING' };
    }

    if (definitions.length === 1) {
      const def = definitions[0];
      const exported = isExportLine(def.text);
      return {
        state: 'VERIFIED',
        location: `${def.file}:${def.line}`,
        exported,
      };
    }

    // 2+ definitions — AMBIGUOUS
    // Deduplicate by file:line
    const seen = new Set();
    const candidates = [];
    for (const def of definitions) {
      const key = `${def.file}:${def.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(key);
      }
    }

    if (candidates.length === 1) {
      // All dupes pointed to same location — treat as VERIFIED
      const def = definitions[0];
      const exported = isExportLine(def.text);
      return {
        state: 'VERIFIED',
        location: `${def.file}:${def.line}`,
        exported,
      };
    }

    return { state: 'AMBIGUOUS', candidates };
  } catch (err) {
    return { state: 'UNCHECKABLE', reason: `error: ${err.message}` };
  }
}

/**
 * Orchestrates symbol checking for a plan.
 * Steps:
 *   1. Parse symbols from plan content (heuristic)
 *   2. Build greenfield exclusion set
 *   3. Resolve each non-greenfield symbol
 *   4. Return full result with mandatory coverage block
 *
 * @param {string} planContent  Full plan file content
 * @param {string} cwd  Directory to search symbols in
 * @returns {{
 *   symbols: Array<{symbol: string, state: string, [key: string]: *}>,
 *   coverage: {
 *     unchecked: Array<{symbol: string, reason: string}>,
 *     greenfield: string[]
 *   }
 * }}
 */
function checkSymbols(planContent, cwd) {
  const rawSymbols = parseSymbolsFromPlan(planContent);
  const greenfieldSet = buildGreenfieldSet(planContent);

  const greenfield = [];
  const toCheck = [];

  for (const symbol of rawSymbols) {
    if (greenfieldSet.has(symbol)) {
      greenfield.push(symbol);
    } else {
      toCheck.push(symbol);
    }
  }

  const symbols = [];
  const unchecked = [];

  for (const symbol of toCheck) {
    const result = resolveSymbol(symbol, cwd);
    symbols.push({ symbol, ...result });
    if (result.state === 'UNCHECKABLE') {
      unchecked.push({ symbol, reason: result.reason });
    }
  }

  // counts: explicit numeric contract for shell/gate consumers (S02 review R1).
  // ALWAYS derived by filtering symbols[] — never maintained separately.
  const counts = {
    verified: symbols.filter((s) => s.state === 'VERIFIED').length,
    missing: symbols.filter((s) => s.state === 'MISSING').length,
    ambiguous: symbols.filter((s) => s.state === 'AMBIGUOUS').length,
    uncheckable: unchecked.length,
    greenfield: greenfield.length,
  };

  return {
    symbols,
    counts,
    coverage: {
      unchecked,
      greenfield,
    },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { checkSymbols, parseSymbolsFromPlan, resolveSymbol };

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let checkPath = null;
  let cwdArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1] !== undefined) {
      checkPath = args[++i];
    } else if (args[i] === '--cwd' && args[i + 1] !== undefined) {
      cwdArg = args[++i];
    }
  }

  if (!checkPath) {
    process.stderr.write(JSON.stringify({ error: 'Usage: forge-symbol-check.js --check <plan.md>' }) + '\n');
    process.exit(2);
  }

  try {
    const absPath = path.resolve(checkPath);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (ioErr) {
      process.stderr.write(JSON.stringify({ error: ioErr.message }) + '\n');
      process.exit(2);
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      process.stderr.write(JSON.stringify({ error: `file exceeds 1 MB size cap: ${absPath}` }) + '\n');
      process.exit(2);
    }

    // Search root: --cwd (gates pass the resolved CODE_DIR in worktree isolation;
    // S02 review R6 — dirname(plan) is a .gsd dir with zero source code).
    const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd();
    const result = checkSymbols(content, cwd);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(2);
  }
}
