#!/usr/bin/env node
// forge-must-haves.js — Schema detection predicate + parser helper
//
// Exports:
//   hasStructuredMustHaves(planContent) → boolean
//   parseMustHaves(planContent) → { truths, artifacts, key_links, expected_output }
//
// CLI usage:
//   node scripts/forge-must-haves.js --check <plan.md>
//   Prints JSON { legacy, valid, errors } to stdout.
//   Exit 0 for legacy or valid-structured; exit 2 for malformed-structured or I/O error.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FRONTMATTER_FILE_SIZE = 1024 * 1024; // 1 MB size cap (prevents catastrophic backtracking)

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Extract the raw YAML frontmatter block (between first pair of ---).
 * Adapted from scripts/forge-verify.js lines 422-430.
 * Returns the frontmatter string (without delimiters) or null.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/**
 * Extract the indented sub-block that belongs to a top-level YAML key.
 * Only captures lines that are strictly indented relative to the key (column 0).
 *
 * @param {string} yaml   Full frontmatter text
 * @param {string} key    Key name at column 0
 * @returns {string|null} Indented block lines (with leading whitespace preserved) or null
 */
function extractSubBlock(yaml, key) {
  const lines = yaml.split('\n');
  let capturing = false;
  const collected = [];

  for (const line of lines) {
    if (!capturing) {
      if (line === `${key}:` || line.startsWith(`${key}: `)) {
        capturing = true;
      }
      continue;
    }
    // Capture lines that start with whitespace (indented children)
    if (/^[ \t]/.test(line)) {
      collected.push(line);
    } else {
      // Non-indented line means we've left the block
      break;
    }
  }

  return collected.length > 0 ? collected.join('\n') : null;
}

/**
 * Extract a simple scalar or inline array value from a top-level key.
 *
 * @param {string} yaml
 * @param {string} key
 * @returns {*}
 */
function extractTopLevelValue(yaml, key) {
  // Use [ \t]* (space/tab only) — NOT \s — to avoid matching across newlines
  const re = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm');
  const m = yaml.match(re);
  if (!m) return undefined;
  const val = m[1].trim();
  if (val.startsWith('[')) {
    const inner = val.replace(/^\[|\]$/g, '');
    if (!inner.trim()) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (val === '') {
    // Multi-line — caller uses extractSubBlock
    return null; // sentinel: "has key but no inline value"
  }
  return val.replace(/^["']|["']$/g, '');
}

/**
 * Parse a multi-line YAML array of strings from an indented block.
 * Each item is a "  - value" line.
 *
 * @param {string} block  Indented block text
 * @returns {string[]}
 */
function parseStringArray(block) {
  return block
    .split('\n')
    .filter(l => /^\s+-\s+/.test(l))
    .map(l => l.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
}

/**
 * Parse a multi-line YAML array of objects from an indented block.
 * Handles items starting with "  - key: val" and continued fields "    key2: val2".
 * Field values may be inline arrays "[a, b]".
 *
 * @param {string} block  Indented block text
 * @returns {object[]}
 */
function parseObjectArray(block) {
  const lines = block.split('\n');
  const items = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // New item: "  - key: value" (2+ spaces + dash)
    const itemMatch = line.match(/^(\s+)-\s+(\w[\w_-]*):\s*(.*)/);
    if (itemMatch) {
      if (current) items.push(current);
      current = {};
      current[itemMatch[2]] = parseFieldValue(itemMatch[3].trim());
      continue;
    }

    // Continuation field: "    key: value" (4+ spaces, no dash)
    const fieldMatch = line.match(/^(\s{4,})(\w[\w_-]*):\s*(.*)/);
    if (fieldMatch && current) {
      current[fieldMatch[2]] = parseFieldValue(fieldMatch[3].trim());
    }
  }

  if (current) items.push(current);
  return items;
}

/**
 * Parse a single YAML field value: inline array, number, or string.
 *
 * @param {string} val
 * @returns {string|number|string[]}
 */
function parseFieldValue(val) {
  if (val.startsWith('[')) {
    const inner = val.replace(/^\[|\]$/g, '');
    if (!inner.trim()) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const n = Number(val);
  if (!isNaN(n) && val !== '') return n;
  return val.replace(/^["']|["']$/g, '');
}

/**
 * Parse a named key's sub-block as an array (strings or objects).
 * Determines array type by checking if first item line has "key: val" shape (object) or plain value (string).
 *
 * @param {string} yaml    Full frontmatter text
 * @param {string} key     Key name at column 0
 * @returns {string[]|object[]|undefined}
 */
function parseArrayKey(yaml, key) {
  const block = extractSubBlock(yaml, key);
  if (!block) return undefined;

  // Detect array type from first item line
  const firstItem = block.split('\n').find(l => /^\s+-\s+/.test(l));
  if (!firstItem) return [];

  const isObject = /^\s+-\s+\w[\w_-]*:/.test(firstItem);
  return isObject ? parseObjectArray(block) : parseStringArray(block);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect whether a T##-PLAN.md has a structured `must_haves:` block at YAML root.
 * This is a presence check only — does NOT validate shape.
 *
 * @param {string} content  Full plan file content
 * @returns {boolean}
 */
function hasStructuredMustHaves(content) {
  const fm = extractFrontmatter(content);
  if (!fm) return false;
  // must_haves: at column 0 (either followed by newline or space)
  return /^must_haves:\s*(\n|$)/m.test(fm);
}

/**
 * Parse the `must_haves:` block and `expected_output:` array from a structured plan.
 * Callers MUST check `hasStructuredMustHaves` first; throws if called on legacy plans.
 *
 * Returns:
 * {
 *   truths: string[],
 *   artifacts: Array<{ path: string, provides: string, min_lines: number, stub_patterns?: string[] }>,
 *   key_links: Array<{ from: string, to: string, via: string }>,
 *   expected_output: string[]
 * }
 *
 * Throws Error("malformed must_haves schema: <field> — <reason>") on invalid shape.
 * Throws Error("plan is legacy — use hasStructuredMustHaves to pre-check") for legacy plans.
 *
 * @param {string} content  Full plan file content
 * @returns {{ truths: string[], artifacts: object[], key_links: object[], expected_output: string[] }}
 */
function parseMustHaves(content) {
  if (!hasStructuredMustHaves(content)) {
    throw new Error('plan is legacy — use hasStructuredMustHaves to pre-check');
  }

  const fm = extractFrontmatter(content);

  // Extract the must_haves sub-block to operate on its nested keys
  const mustHavesBlock = extractSubBlock(fm, 'must_haves');
  if (!mustHavesBlock) {
    throw new Error('malformed must_haves schema: must_haves — block is empty');
  }

  // Dedent the must_haves sub-block by 2 spaces to treat as "top-level" for parseArrayKey
  const dedented = mustHavesBlock.replace(/^ {2}/gm, '');

  // Validate truths
  const truths = parseArrayKey(dedented, 'truths');
  if (!Array.isArray(truths)) {
    throw new Error('malformed must_haves schema: truths — must be an array of strings');
  }
  for (const t of truths) {
    if (typeof t !== 'string') {
      throw new Error('malformed must_haves schema: truths[] — each item must be a string');
    }
  }

  // Validate artifacts
  const artifacts = parseArrayKey(dedented, 'artifacts');
  if (!Array.isArray(artifacts)) {
    throw new Error('malformed must_haves schema: artifacts — must be an array of objects');
  }
  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];
    if (typeof a !== 'object' || a === null) {
      throw new Error(`malformed must_haves schema: artifacts[${i}] — must be an object`);
    }
    if (!a.path || typeof a.path !== 'string') {
      throw new Error(`malformed must_haves schema: artifacts[${i}].path — required string field missing`);
    }
    if (!a.provides || typeof a.provides !== 'string') {
      throw new Error(`malformed must_haves schema: artifacts[${i}].provides — required string field missing`);
    }
    if (a.min_lines === undefined || typeof a.min_lines !== 'number') {
      throw new Error(`malformed must_haves schema: artifacts[${i}].min_lines — required number field missing`);
    }
    if (a.stub_patterns !== undefined && !Array.isArray(a.stub_patterns)) {
      throw new Error(`malformed must_haves schema: artifacts[${i}].stub_patterns — must be an array if present`);
    }
  }

  // Validate key_links
  const keyLinks = parseArrayKey(dedented, 'key_links');
  if (!Array.isArray(keyLinks)) {
    throw new Error('malformed must_haves schema: key_links — must be an array of objects');
  }
  for (let i = 0; i < keyLinks.length; i++) {
    const kl = keyLinks[i];
    if (typeof kl !== 'object' || kl === null) {
      throw new Error(`malformed must_haves schema: key_links[${i}] — must be an object`);
    }
    if (!kl.from || typeof kl.from !== 'string') {
      throw new Error(`malformed must_haves schema: key_links[${i}].from — required field missing`);
    }
    if (!kl.to || typeof kl.to !== 'string') {
      throw new Error(`malformed must_haves schema: key_links[${i}].to — required field missing`);
    }
    if (!kl.via || typeof kl.via !== 'string') {
      throw new Error(`malformed must_haves schema: key_links[${i}].via — required field missing`);
    }
  }

  // Validate expected_output (top-level key, sibling to must_haves)
  const expectedOutputInline = extractTopLevelValue(fm, 'expected_output');
  let expectedOutput;
  if (expectedOutputInline === undefined) {
    expectedOutput = [];
  } else if (Array.isArray(expectedOutputInline)) {
    expectedOutput = expectedOutputInline;
  } else if (expectedOutputInline === null) {
    // Multi-line array
    const arr = parseArrayKey(fm, 'expected_output');
    expectedOutput = arr !== undefined ? arr : [];
  } else {
    expectedOutput = [String(expectedOutputInline)];
  }

  if (!Array.isArray(expectedOutput)) {
    throw new Error('malformed must_haves schema: expected_output — must be an array of strings');
  }
  for (const p of expectedOutput) {
    if (typeof p !== 'string') {
      throw new Error('malformed must_haves schema: expected_output[] — each item must be a string');
    }
  }

  return {
    truths,
    artifacts,
    key_links: keyLinks,
    expected_output: expectedOutput,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { hasStructuredMustHaves, parseMustHaves };

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let checkPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1] !== undefined) {
      checkPath = args[++i];
    }
  }

  if (!checkPath) {
    process.stderr.write(JSON.stringify({ error: 'Usage: forge-must-haves.js --check <plan.md>' }) + '\n');
    process.exit(2);
  }

  try {
    const absPath = path.resolve(checkPath);
    const content = fs.readFileSync(absPath, 'utf-8');

    if (Buffer.byteLength(content, 'utf-8') > MAX_FRONTMATTER_FILE_SIZE) {
      process.stderr.write(JSON.stringify({ error: `file exceeds 1 MB size cap: ${absPath}` }) + '\n');
      process.exit(2);
    }

    const isStructured = hasStructuredMustHaves(content);

    if (!isStructured) {
      // Legacy plan — valid by definition
      process.stdout.write(JSON.stringify({ legacy: true, valid: true, errors: [] }) + '\n');
      process.exit(0);
    }

    // Structured — try to parse
    try {
      parseMustHaves(content);
      process.stdout.write(JSON.stringify({ legacy: false, valid: true, errors: [] }) + '\n');
      process.exit(0);
    } catch (parseErr) {
      process.stdout.write(JSON.stringify({ legacy: false, valid: false, errors: [parseErr.message] }) + '\n');
      process.exit(2);
    }
  } catch (ioErr) {
    process.stderr.write(JSON.stringify({ error: ioErr.message }) + '\n');
    process.exit(2);
  }
}
