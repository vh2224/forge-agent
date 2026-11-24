#!/usr/bin/env node
// forge-must-haves.js — Schema detection predicate + parser helper
//
// Exports:
//   hasStructuredMustHaves(planContent) → boolean
//   parseMustHaves(planContent) → { truths, artifacts, key_links, expected_output, domain, capability }
//   resolveCapability(planContent) → { capability, declared, event }
//   extractFrontmatter(planContent) → string|null   (the only CRLF/BOM normalizer)
//   decodeDeclarationList(frontmatter, key) → { key, status, form, items, error, line, diagnostics, layout }
//   validateTaskDeclarations(planContent, { taskId, requireExplicit: true }) → frozen projection
//
// CLI usage:
//   node scripts/forge-must-haves.js --check <plan.md>
//   Prints JSON { legacy, valid, errors } to stdout, plus { domain, capability } on
//   the valid-structured branch ONLY — an unparseable plan has no trustworthy value
//   for either field, and printing one would be an invented reading (S03 review R20).
//   Exit 0 for legacy or valid-structured; exit 2 for malformed-structured or I/O error.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FRONTMATTER_FILE_SIZE = 1024 * 1024; // 1 MB size cap (prevents catastrophic backtracking)
const CAPABILITY_ENUM = ['readonly', 'workspace', 'networked'];

/**
 * Keys that are top-level frontmatter siblings of `must_haves:` — never children.
 *
 * MEMBERSHIP CRITERION (apply this, do not extend the list by resemblance): a key
 * belongs here when it is (a) authored by the planner as a declaration, (b) read
 * by some component with a regex anchored at column 0, and (c) silently defaulted
 * when absent — so nesting it converts a written declaration into silence rather
 * than into an error. Each member below was verified against its reader:
 *
 *   expected_output  extractTopLevelValue here; complete-slice file audit
 *   writes           forge-code-dir.js parseListField; forge-parallelism.js
 *   depends          forge-parallelism.js parseListField
 *   capability       extractTopLevelValue here + resolveCapability (adapter)
 *   repo             forge-code-dir.js:477 extractTopLevelValue
 *   domain           forge-dispatch-resolve.js:93  /^domain:[ \t]*(.+)$/m
 *   tier             forge-dispatch-resolve.js:91  /^tier:\s*(.+)$/m
 *   effort           forge-dispatch-resolve.js:94  /^effort:\s*(.+)$/m
 *   worker           forge-dispatch-resolve.js:89  /^worker:[ \t]*(\S+)/m
 *   tag              forge-dispatch-resolve.js:92  /^tag:\s*(.+)$/m
 *
 * `capability` and `repo` were the review's R2: a nested `capability: networked`
 * validated clean and ran the task in the `workspace` sandbox with no
 * `capability-unrecognized` event; a nested `repo:` is invisible to exactly the
 * hint that tells the operator to declare `repo:`, so the fix it prescribes is
 * already on the page — an unfalsifiable dead end.
 *
 * Deliberately EXCLUDED: `id`, `slice`, `milestone`. They are identity fields the
 * orchestrator derives from the plan's path rather than planner judgement, and
 * they have no default to fall through to — nesting one fails loudly downstream
 * instead of going quiet, so criterion (c) does not hold.
 *
 * Zero false-positive risk: `must_haves` has exactly three children (truths,
 * artifacts, key_links), whose entries carry only path/provides/min_lines/
 * stub_patterns and from/to/via. No name above collides with any of them.
 */
const NESTED_SIBLING_KEYS = [
  'expected_output', 'writes', 'depends',
  'capability', 'repo', 'domain', 'tier', 'effort', 'worker', 'tag',
  'roots_schema', 'code_roots', 'primary_root_id',
];

/**
 * Strip a YAML inline comment from a scalar value before a closed-set compare.
 * extractTopLevelValue returns the raw remainder of the line, so
 * `capability: networked  # needs npm install` reached the enum as
 * "networked  # needs npm install" and failed it — blocking the task at the gate
 * and, in the adapter, downgrading a genuinely networked task to `workspace`,
 * whose install failure then gets reported as "environment". This repo already
 * paid for this class once, in the `challenger_model:` reader that captured `#`.
 * Applied ONLY on the capability axis: a general strip would corrupt values that
 * legitimately contain `#` (paths, titles). Requires whitespace before the `#`,
 * which is what distinguishes a comment from a `#` inside the value itself.
 *
 * @param {string} value
 * @returns {string}
 */
function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '');
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Extract the raw YAML frontmatter block (between first pair of ---).
 * Adapted from scripts/forge-verify.js lines 422-430.
 * Returns the frontmatter string (without delimiters) or null.
 *
 * Normalizes CRLF/CR to LF here, and only here: this is the single funnel
 * every public export (`hasStructuredMustHaves`, `parseMustHaves`,
 * `resolveCapability`) reads through — none of them touch raw `content`.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractFrontmatter(content) {
  const m = String(content)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/**
 * Collect the lines belonging to a top-level YAML key's sub-block.
 *
 * THE SINGLE DEFINITION OF THE BLOCK BOUNDARY. Both `extractSubBlock` (what the
 * parser reads) and `findNestedSiblingKeys` (what the guard scans) go through
 * here, so they cannot disagree about where `must_haves:` ends. They previously
 * only *shared the rule by copy*, and the copy was wrong in both places at once.
 *
 * Boundary rule — a blank line does NOT terminate a YAML mapping, and neither
 * does a comment line. Only a non-blank line at column 0 does. Treating a blank
 * line as the end (the original rule) let a nested `writes:` hide behind one
 * blank line: the guard stopped scanning, the parser stopped reading, and the
 * plan validated clean. Review objection R1, reproduced before this fix.
 *
 * @param {string} yaml   Full frontmatter text
 * @param {string} key    Key name at column 0
 * @returns {Array<{ text: string, index: number }>} block lines with their 0-based
 *          index into `yaml`, trailing blanks dropped
 */
function collectSubBlockLines(yaml, key) {
  const lines = yaml.split('\n');
  const collected = [];
  let capturing = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!capturing) {
      if (line === `${key}:` || line.startsWith(`${key}: `)) capturing = true;
      continue;
    }
    // Interior: blank lines and comment lines are structurally transparent in YAML.
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      collected.push({ text: line, index: i });
      continue;
    }
    // Indented children.
    if (/^[ \t]/.test(line)) {
      collected.push({ text: line, index: i });
      continue;
    }
    // A non-blank, non-comment line at column 0 ends the block.
    break;
  }

  // Trailing blanks/comments swept in by the interior rule are not block content.
  while (collected.length > 0) {
    const last = collected[collected.length - 1].text;
    if (last.trim() === '' || last.trimStart().startsWith('#')) collected.pop();
    else break;
  }

  return collected;
}

/**
 * Extract the indented sub-block that belongs to a top-level YAML key.
 *
 * @param {string} yaml   Full frontmatter text
 * @param {string} key    Key name at column 0
 * @returns {string|null} Block lines (with leading whitespace preserved) or null
 */
function extractSubBlock(yaml, key) {
  const collected = collectSubBlockLines(yaml, key);
  return collected.length > 0 ? collected.map(l => l.text).join('\n') : null;
}

/**
 * Find top-level sibling keys that have been mis-indented INSIDE the `must_haves:`
 * block.
 *
 * Why this is a hard error and not a tolerated variant: every reader of these keys
 * is anchored at column 0. `extractTopLevelValue` uses `^key:` with the `m` flag,
 * so an indented `expected_output:` is invisible to it and silently parses as the
 * empty array; `forge-code-dir.js parseDeclaredPaths` reads `writes:` the same way
 * and reports `paths_considered: 0`. Nothing downstream can tell "the plan declared
 * nothing" apart from "the plan declared paths nobody could read" — measured on a
 * real dogfood run where 2 of 3 sidecar-generated plans nested these keys, resolved
 * as `undeclared`, and were silently refused the sidecar engine while this very
 * validator stamped all three `valid: true`.
 *
 * Scans only the `must_haves:` sub-block, and delimits that block by the SAME rule
 * as extractSubBlock (indented lines until the first non-indented one) so the guard
 * and the parser can never disagree about where the block ends.
 *
 * @param {string} yaml  Full frontmatter text
 * @returns {Array<{ key: string, line: number }>} offenders, in document order
 */
function findNestedSiblingKeys(yaml) {
  const found = [];

  // Same boundary as the parser, by construction rather than by resemblance.
  for (const { text, index } of collectSubBlockLines(yaml, 'must_haves')) {
    // A mapping key at any depth: whitespace, then a bare key, then a colon.
    // The leading `[A-Za-z_]` class excludes sequence items (`- from: "x"`), so
    // schema fields nested in artifacts/key_links entries are never candidates.
    const m = text.match(/^[ \t]+([A-Za-z_][\w-]*):(?:[ \t].*)?$/);
    if (m && NESTED_SIBLING_KEYS.includes(m[1])) found.push({ key: m[1], line: index + 1 });
  }

  return found;
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
  // pending block-sequence state: tracks a field whose value is an indented block array
  let pending = null; // { fieldName: string, fieldIndent: number } | null

  for (const line of lines) {
    if (!line.trim()) continue; // skip blank lines — do NOT close pending state

    // Skip comment lines — do NOT close pending state (Pitfall 4)
    if (line.trimStart().startsWith('#')) continue;

    // If pending block-sequence is active, check for sequence items BEFORE the new-item check.
    // (HIGH fix: itemMatch ran first, so "- TODO: fix" inside stub_patterns was mis-parsed as a
    // new artifact. The pending field must claim any deeper-indented seq-dash line first.)
    if (pending) {
      const seqMatch = line.match(/^(\s+)-\s+(.*)/);
      if (seqMatch) {
        const itemIndent = seqMatch[1].length;
        if (itemIndent > pending.fieldIndent) {
          // Collect this item into the pending array field
          const raw = seqMatch[2].trim().replace(/^["']|["']$/g, '');
          if (!Array.isArray(current[pending.fieldName])) {
            current[pending.fieldName] = [];
          }
          current[pending.fieldName].push(raw);
          continue;
        }
        // MEDIUM fix: seq-dash found but not deeper than pending field — close pending
        // deterministically and fall through to re-evaluate as a new item/field below.
        pending = null;
        // (no continue — let the line fall through to itemMatch/fieldMatch below)
      }
    }

    // New item: "  - key: value" (2+ spaces + dash)
    const itemMatch = line.match(/^(\s+)-\s+(\w[\w_-]*):\s*(.*)/);
    if (itemMatch) {
      // Close any pending block-sequence state
      pending = null;
      if (current) items.push(current);
      current = {};
      current[itemMatch[2]] = parseFieldValue(itemMatch[3].trim());
      continue;
    }

    // Continuation field: "    key: value" (4+ spaces, no dash)
    const fieldMatch = line.match(/^(\s{4,})(\w[\w_-]*):\s*(.*)/);
    if (fieldMatch && current) {
      const fieldIndent = fieldMatch[1].length;
      const fieldValue = fieldMatch[3].trim();

      if (fieldValue === '') {
        // Empty value — enter pending block-sequence state
        pending = { fieldName: fieldMatch[2], fieldIndent };
        // Initialize to empty array (will be populated by subsequent sequence lines)
        current[fieldMatch[2]] = [];
      } else {
        // Non-empty value — close pending state and assign normally
        pending = null;
        current[fieldMatch[2]] = parseFieldValue(fieldValue);
      }
      continue;
    }

    // Any other line that doesn't match closes pending state
    if (pending) pending = null;
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
  // Patch #1: probe for inline array BEFORE falling through to extractSubBlock.
  // extractTopLevelValue returns [] or [a,b] for inline arrays, null for empty-value (block form),
  // undefined for absent key, or a scalar string for non-array inline values.
  // Short-circuit only when the probe returns an actual Array — covers `key: []` and `key: [a, b]`
  // at any nesting depth (Pitfall 6: must come before extractSubBlock, not after).
  const inlineProbe = extractTopLevelValue(yaml, key);
  if (Array.isArray(inlineProbe)) return inlineProbe;

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

// Product declarations share the execution root policy. This lexical check does
// not resolve a physical root, alter declarations or inspect truths/via/prose.
// Load lazily: forge-code-roots imports this parser, while --check exports the
// parser before invoking it. Both module load orders retain complete exports.
function assertProductPlanPaths(frontmatter, parsed) {
  const entries = [];
  const writes = parseArrayKey(frontmatter, 'writes');
  if (Array.isArray(writes)) writes.forEach((value, index) => entries.push(['writes[' + index + ']', value]));
  parsed.expected_output.forEach((value, index) => entries.push(['expected_output[' + index + ']', value]));
  parsed.artifacts.forEach((value, index) => entries.push(['artifacts[' + index + '].path', value.path]));
  parsed.key_links.forEach((value, index) => {
    entries.push(['key_links[' + index + '].from', value.from], ['key_links[' + index + '].to', value.to]);
  });
  const { assertRelative } = require('./forge-code-roots');
  for (const [field, value] of entries) {
    const relative = value && typeof value === 'object' && !Array.isArray(value) ? value.path
      : typeof value === 'string' && value.includes('::') ? value.slice(value.indexOf('::') + 2) : value;
    try { assertRelative(relative); }
    catch (cause) {
      const code = cause.code || 'root-path-invalid';
      const guidance = code === 'root-path-protected'
        ? '; product deliverables belong outside .gsd/.git/.svn (use docs/ for documents)' : '';
      throw Object.assign(new Error('malformed must_haves schema: ' + field + ' - ' + code + guidance), { code });
    }
  }
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
 *   expected_output: string[],
 *   domain: string|null,
 *   capability: string|null
 * }
 *
 * Throws Error("malformed must_haves schema: <field> — <reason>") on invalid shape.
 * Throws Error("plan is legacy — use hasStructuredMustHaves to pre-check") for legacy plans.
 *
 * @param {string} content  Full plan file content
 * @returns {{ truths: string[], artifacts: object[], key_links: object[], expected_output: string[], domain: string|null, capability: string|null }}
 */
// Structural decoding only: this result is not product-path admission. The
// normalizer uses it only after validating the physical execution contract.
function parseMustHavesStructure(content) {
  if (!hasStructuredMustHaves(content)) {
    throw new Error('plan is legacy — use hasStructuredMustHaves to pre-check');
  }

  const fm = extractFrontmatter(content);

  // Extract the must_haves sub-block to operate on its nested keys
  const mustHavesBlock = extractSubBlock(fm, 'must_haves');
  if (!mustHavesBlock) {
    throw new Error('malformed must_haves schema: must_haves — block is empty');
  }

  // Structural guard — runs BEFORE any field validation, because a plan whose
  // top-level keys are unreachable is not "a plan with an empty expected_output",
  // it is a plan nobody downstream can read. Reported with the offending key names
  // and their frontmatter line numbers so the fix (a 2-space dedent to column 0) is
  // stated, not guessed.
  const nested = findNestedSiblingKeys(fm);
  if (nested.length > 0) {
    const keys = nested.map(n => `\`${n.key}\``).join(', ');
    const at = nested.map(n => n.line).join(', ');
    throw new Error(
      `malformed must_haves schema: nested-top-level-key — ${keys} ` +
      `${nested.length === 1 ? 'is' : 'are'} nested inside \`must_haves:\` ` +
      `(frontmatter line ${at}); ${nested.length === 1 ? 'it is a' : 'they are'} ` +
      `top-level key${nested.length === 1 ? '' : 's'} and must sit at column 0, ` +
      `as sibling${nested.length === 1 ? '' : 's'} of \`must_haves:\``
    );
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

  // Validate domain (top-level key, sibling to must_haves) — optional, additive.
  // Absent or empty-after-trim → null (tolerant — resolved to a default downstream, not here).
  // Non-string value (array/object/number) → malformed schema error.
  const domainRaw = extractTopLevelValue(fm, 'domain');
  let domain;
  if (domainRaw === undefined || domainRaw === null) {
    domain = null;
  } else if (typeof domainRaw === 'string') {
    // Inline-comment strip, applied here AND in forge-dispatch-resolve.js's
    // reader of the same key, from this one helper. Neither reader stripped, so
    // the two agreed — on the wrong value: `domain: payments  # cross-repo`
    // routed to the domain literally named "payments  # cross-repo", which no
    // routing cell matches, so the unit fell to `default` with no error. Fixing
    // one reader alone would have replaced a shared wrong answer with a
    // divergence, which is worse; they move together or not at all.
    const trimmed = stripInlineComment(domainRaw).trim();
    domain = trimmed === '' ? null : trimmed;
  } else {
    throw new Error('malformed must_haves schema: domain — must be a string when present');
  }

  // Capability is deliberately strict at the enforcing gate: the set is closed so
  // planners and downstream adapters share one explicit contract. Legacy plans remain
  // valid when the field is absent, empty, or the YAML null scalar.
  const capabilityRaw = extractTopLevelValue(fm, 'capability');
  let capability;
  if (capabilityRaw === undefined || capabilityRaw === null) {
    capability = null;
  } else if (typeof capabilityRaw === 'string') {
    // The `null` scalar must be recognised AFTER the comment strip, not before it.
    // Testing the raw value first meant `capability: null # legacy plan` reached the
    // enum as `null # legacy plan` and threw at this gate, while resolveCapability
    // below strips first and resolved it cleanly — the two routes disagreeing about
    // what was declared, which is the exact invariant the strip exists to protect.
    // Review objection R3, reproduced before this fix.
    const trimmed = stripInlineComment(capabilityRaw).trim();
    if (trimmed === '' || trimmed === 'null') {
      capability = null;
    } else if (CAPABILITY_ENUM.includes(trimmed)) {
      capability = trimmed;
    } else {
      throw new Error(`malformed must_haves schema: capability — must be one of ${CAPABILITY_ENUM.join('|')} (got "${trimmed}")`);
    }
  } else {
    throw new Error('malformed must_haves schema: capability — must be a string when present');
  }

  const parsed = {
    truths,
    artifacts,
    key_links: keyLinks,
    expected_output: expectedOutput,
    domain,
    capability,
  };
  return parsed;
}

// The ordinary API and --check remain strict. No option can bypass admission.
function parseMustHaves(content) {
  const parsed = parseMustHavesStructure(content);
  assertProductPlanPaths(extractFrontmatter(content), parsed);
  return parsed;
}

/**
 * Resolve the capability for the sidecar adapter without making the adapter a
 * second enforcing gate. This is intentionally tolerant: the parser rejects
 * malformed declarations, while this route downgrades them and emits an event.
 * B1 established both postures deliberately; a silent default would be an
 * inert capability path (the TASK-021 failure mode).
 *
 * @param {string} planText Full plan content, possibly legacy or malformed
 * @returns {{ capability: string, declared: string|Array|null, event: string|null }}
 */
function resolveCapability(planText) {
  try {
    if (typeof planText !== 'string') {
      return { capability: 'workspace', declared: null, event: 'capability-unrecognized' };
    }
    const fm = extractFrontmatter(planText);
    if (!fm) {
      // A plan with NO frontmatter is a legacy plan, not an unrecognized capability.
      // Emitting the event here fired it on every legacy plan and diluted the one
      // signal it exists to carry — a declaration that was written and not
      // understood (S03 review R17). The resolved capability is unchanged.
      return { capability: 'workspace', declared: null, event: null };
    }
    const raw = extractTopLevelValue(fm, 'capability');
    if (raw === undefined || raw === null || raw === 'null' || (typeof raw === 'string' && raw.trim() === '')) {
      return { capability: 'workspace', declared: null, event: null };
    }
    if (typeof raw === 'string') {
      // Same inline-comment strip as the gate: the two routes must agree on what
      // was declared, or a commented declaration is valid at the gate and
      // "unrecognized" at the adapter.
      const declared = stripInlineComment(raw).trim();
      if (declared === '' || declared === 'null') {
        return { capability: 'workspace', declared: null, event: null };
      }
      if (CAPABILITY_ENUM.includes(declared)) {
        return { capability: declared, declared, event: null };
      }
      return { capability: 'workspace', declared, event: 'capability-unrecognized' };
    }
    return { capability: 'workspace', declared: raw, event: 'capability-unrecognized' };
  } catch (_) {
    return { capability: 'workspace', declared: null, event: 'capability-unrecognized' };
  }
}

// ── Execution declarations: one structural depends/writes decoder (issue 343 U0a, U0a-r1) ──

// decodeDeclarationList is the one structural decoder of the top-level `depends`
// and `writes` declarations. It records what the YAML says — values, presence,
// layout and named diagnostics — and decides nothing else. Every consumer applies
// its own projection, fixed in code at its historical caller and never selected
// by an option, a profile string or imported JSON:
//   ordinary  parseExecutionFields (below): a complete list is an array, blank
//             lines included; YAML null and a malformed declaration stay present
//             but are never an array.
//   temporal  forge-unit-controller dependsOf (time DAG): absent and YAML null are
//             a root; a blank gap or a malformed declaration is refused.
//   schedule  forge-parallelism parseTaskFrontmatter and validateTaskDeclarations
//             (below): a declaration enters a schedule only as a list whose layout
//             the temporal guard also admits.
// The input is LF frontmatter (extractFrontmatter, still the only CRLF/BOM
// normalizer of plan text). Supported YAML: a flow list on the key line
// (`key: [a, "b"]`) and an indented block of `- item` lines. Items are quoted
// (taken verbatim between the quotes, as before) or plain; `root::path` stays a
// string and `- root_id: x` / `path: y` is one object entry. A ` #` tail and whole
// `#` lines are comments; a `#` inside quotes or without whitespace before it is
// text. Blank lines are YAML-transparent inside a block: the list stays valid and
// the decoder names them (declaration-leading-blank before the first entry,
// declaration-interior-blank after it). A key followed only by blank or comment
// lines is YAML null: status `empty` (declaration-empty-value), never a list.
// Anything else — a scalar, text after a flow list, a mixed or unindented block,
// an empty item, a nested collection or a repeated key — is `invalid` with a
// named error.
const DECLARATION_FIELD = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const DECLARATION_TAIL = /^(?:[ \t]*|[ \t]+#.*)$/;
const DECLARATION_TRANSPARENT = /^[ \t]*(?:#.*)?$/;
const DECLARATION_GAPS = Object.freeze(['declaration-leading-blank', 'declaration-interior-blank']);

// Frontmatter line numbers (1-based) of one declaration, by role.
function declarationLayout(keyLine) {
  return { key_line: keyLine, item_lines: [], comment_lines: [], inline_comment_lines: [], leading_blank_lines: [], interior_blank_lines: [] };
}

// The frozen decoder result. `diagnostics` names every finding: the error of an
// invalid declaration, declaration-empty-value for YAML null and the blank gaps of
// a valid block; a valid list without blank lines and an absent key have none.
function declarationResult(key, status, extra = {}) {
  const valid = status === 'valid', layout = valid || status === 'empty' ? extra.layout : null;
  const gaps = valid ? [layout.leading_blank_lines.length ? DECLARATION_GAPS[0] : null,
    layout.interior_blank_lines.length ? DECLARATION_GAPS[1] : null].filter(Boolean) : [];
  const diagnostics = status === 'invalid' ? [extra.error] : status === 'empty' ? ['declaration-empty-value'] : gaps;
  return deepFreeze({
    key,
    status,
    form: valid ? extra.form : null,
    items: valid ? extra.items.map(item => (typeof item === 'string' ? item : { ...item })) : null,
    error: status === 'invalid' ? extra.error : null,
    line: extra.line || null,
    diagnostics,
    layout: layout ? { ...layout } : null,
  });
}

// One item scalar: { value, comment } or null (an unterminated quote, text after
// the closing quote, an empty value or a nested collection/sequence).
function declarationScalar(text) {
  const value = String(text).replace(/^[ \t]+/, '');
  if (value[0] === '"' || value[0] === "'") {
    for (let end = value.indexOf(value[0], 1); end > 0; end = value.indexOf(value[0], end + 1)) {
      const tail = value.slice(end + 1);
      if (DECLARATION_TAIL.test(tail)) return end > 1 ? { value: value.slice(1, end), comment: tail.includes('#') } : null;
    }
    return null;
  }
  const comment = value.search(/[ \t]#/);
  const plain = (comment < 0 ? value : value.slice(0, comment)).replace(/[ \t]+$/, '');
  if (!plain || plain[0] === '#' || /^(?:[[{]|-(?:[ \t]|$))/.test(plain)) return null;
  return { value: plain, comment: comment >= 0 };
}

// A flow list `[a, "b, c", 'd']` on the key line: { items, comment } or null.
function declarationFlow(text) {
  const items = [];
  let element = '', quote = null, closed = -1;
  const scalar = () => {
    const trimmed = element.trim();
    if (trimmed[0] === '"' || trimmed[0] === "'") return trimmed.length > 2 && trimmed[trimmed.length - 1] === trimmed[0] ? trimmed.slice(1, -1) : null;
    return trimmed || null;
  };
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      element += char;
      if (char === quote && quote === "'" && text[index + 1] === "'") element += text[++index];
      else if (char === quote) quote = null;
      continue;
    }
    if ((char === '"' || char === "'") && !element.trim()) { quote = char; element += char; continue; }
    if (char === ',' || char === ']') {
      const value = scalar();
      if (value === null && !(char === ']' && !element.trim())) return null;
      if (value !== null) items.push(value);
      element = '';
      if (char === ']') { closed = index; break; }
      continue;
    }
    if (char === '[' || char === '{' || char === '}' || (char === '#' && /[ \t]/.test(text[index - 1]))) return null;
    element += char;
  }
  if (closed < 0 || quote) return null;
  const tail = text.slice(closed + 1);
  return DECLARATION_TAIL.test(tail) ? { items, comment: tail.includes('#') } : null;
}

// The indented block below the key line: string items and object entries aligned
// under their first key. Comment and blank lines are recorded in `layout`, never
// read as items. Returns { items } or the invalid result of `fail`.
function declarationBlock(region, layout, fail) {
  const items = [];
  let indent = null, object = null;
  for (const { text, line } of region) {
    if (!text.trim()) { (items.length ? layout.interior_blank_lines : layout.leading_blank_lines).push(line); continue; }
    if (/^[ \t]*#/.test(text)) { layout.comment_lines.push(line); continue; }
    const entry = text.match(/^([ \t]+)-(?:([ \t]+)(.*))?$/);
    if (entry) {
      if (indent === null) indent = entry[1];
      if (entry[1] !== indent) return fail('declaration-block-malformed', line);
      object = null;
      const body = entry[3] === undefined ? '' : entry[3], field = body.match(DECLARATION_FIELD);
      const read = field ? (field[2] === undefined ? null : declarationScalar(field[2])) : declarationScalar(body);
      if (read === null) return fail('declaration-item-malformed', line);
      layout.item_lines.push(line);
      if (read.comment) layout.inline_comment_lines.push(line);
      if (field) {
        object = { fields: { [field[1]]: read.value }, column: entry[1].length + 1 + entry[2].length };
        items.push(object.fields);
      } else items.push(read.value);
      continue;
    }
    const field = object && text.match(/^([ \t]+)([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/);
    if (!field || field[1].length !== object.column || Object.prototype.hasOwnProperty.call(object.fields, field[2])) {
      return fail('declaration-block-malformed', line);
    }
    const read = field[3] === undefined ? null : declarationScalar(field[3]);
    if (read === null) return fail('declaration-item-malformed', line);
    if (read.comment) layout.inline_comment_lines.push(line);
    object.fields[field[2]] = read.value;
  }
  return { items };
}

/**
 * Decode one top-level declaration list (`depends`, `writes`) of LF frontmatter.
 * Structural only: it takes no options, and every consumer projects the result
 * in its own code.
 *
 * @param {string} frontmatter  extractFrontmatter() output
 * @param {string} key
 * @returns {{ key: string, status: 'absent'|'empty'|'valid'|'invalid', form: 'flow'|'block'|null,
 *   items: Array<string|object>|null, error: string|null, line: number|null, diagnostics: string[],
 *   layout: { key_line, item_lines, comment_lines, inline_comment_lines, leading_blank_lines,
 *   interior_blank_lines }|null }} deep-frozen; `line` is the key line (the offending line when invalid)
 */
function decodeDeclarationList(frontmatter, key) {
  const lines = String(frontmatter).split('\n');
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp('^' + escaped + '[ \\t]*:');
  const at = [];
  lines.forEach((line, index) => { if (head.test(line)) at.push(index); });
  if (!at.length) return declarationResult(key, 'absent');
  if (at.length > 1) return declarationResult(key, 'invalid', { error: 'execution-plan-duplicate-key', line: at[1] + 1 });
  const start = at[0], rest = lines[start].replace(head, ''), layout = declarationLayout(start + 1);
  const fail = (error, line) => declarationResult(key, 'invalid', { error, line: line || start + 1 });
  // The declaration runs to the first column-0 line that is neither blank nor a
  // comment; trailing blank/comment lines belong to nobody.
  let end = start + 1;
  while (end < lines.length && (/^[ \t]/.test(lines[end]) || DECLARATION_TRANSPARENT.test(lines[end]))) end++;
  let last = end;
  while (last > start + 1 && DECLARATION_TRANSPARENT.test(lines[last - 1])) last--;
  const region = lines.slice(start + 1, last).map((text, offset) => ({ text, line: start + 2 + offset }));
  // A column-0 `- item` right after the declaration is an unindented list: refuse
  // it rather than read the key as empty.
  if (end < lines.length && /^-(?:[ \t]|$)/.test(lines[end])) return fail('declaration-block-malformed', end + 1);
  const value = rest.trim();
  if (value && !/^[ \t]+#/.test(rest)) {
    if (value[0] !== '[') return fail('declaration-scalar');
    const flow = declarationFlow(value);
    if (!flow) return fail('declaration-flow-malformed');
    if (region.length) return fail('declaration-continuation', region[0].line);
    for (let index = 0; index < flow.items.length; index++) layout.item_lines.push(start + 1);
    if (flow.comment) layout.inline_comment_lines.push(start + 1);
    return declarationResult(key, 'valid', { form: 'flow', items: flow.items, line: start + 1, layout });
  }
  if (value) layout.inline_comment_lines.push(start + 1); // `key: # comment`
  if (!region.length) return declarationResult(key, 'empty', { line: start + 1, layout });
  // Published #365 legacy producers emit an indented empty flow collection.
  // Keep blank/comment layout so the temporal consumer retains its stricter gap policy.
  const significant = region.filter(row => !DECLARATION_TRANSPARENT.test(row.text));
  if (significant.length === 1 && /^[ \t]+\[\](?:[ \t]*|[ \t]+#.*)$/.test(significant[0].text)) {
    for (const row of region) {
      if (!row.text.trim()) layout.leading_blank_lines.push(row.line);
      else if (/^[ \t]*#/.test(row.text)) layout.comment_lines.push(row.line);
    }
    if (significant[0].text.includes('#')) layout.inline_comment_lines.push(significant[0].line);
    return declarationResult(key, 'valid', { form: 'block', items: [], line: start + 1, layout });
  }
  const block = declarationBlock(region, layout, fail);
  if (block.status === 'invalid') return block;
  return declarationResult(key, 'valid', { form: 'block', items: block.items, line: start + 1, layout });
}

const TASK_ID = /^T\d+(?:\.\d+)?$/;
const ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function declarationError(code, detail, extra) {
  return Object.assign(new Error(`${code}: ${detail}`), { code, detail }, extra);
}

// A write declaration as written: `path`, `root::path` or exactly { root_id, path }.
function declaredWrite(item) {
  if (typeof item === 'string') {
    const at = item.indexOf('::');
    if (at < 0) return { root_id: null, path: item };
    return ROOT_ID.test(item.slice(0, at)) ? { root_id: item.slice(0, at), path: item.slice(at + 2) } : null;
  }
  if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'path,root_id') return null;
  return typeof item.root_id === 'string' && ROOT_ID.test(item.root_id) && typeof item.path === 'string'
    ? { root_id: item.root_id, path: item.path } : null;
}

function declarationScalarValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = stripInlineComment(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Strict admission of a new task's explicit `depends`/`writes` (issue 343 U0a).
 * The identity comes from the canonical list and the plan path (`taskId`), never
 * from the frontmatter `id:`. Throws a named error (`code`, `detail`, `errors`):
 * plan-declaration-depends-missing|writes-missing|depends-invalid|writes-invalid|
 * depends-blank-gap|writes-blank-gap|task-id-invalid|path-protected. It never
 * supplies an empty list for an absent, empty (YAML null) or malformed declaration
 * and has no bypass, profile or relaxed option: `options` carries only the
 * identity and the explicit requirement, and any other field changes nothing.
 * Its fixed schedule-admission projection (U0a-r1) reads the shared decoder's
 * layout: a structurally valid list with a leading or interior blank line stays
 * readable by parseExecutionFields, but it never enters a new task schedule,
 * because the temporal guard (forge-unit-controller dependsOf) refuses that
 * layout. Historical readers (parseMustHaves, --check, parseExecutionFields) are
 * unchanged by it.
 *
 * @returns {{ task_id, depends, writes, roots_schema, primary_root_id, declared_roots, declaration_sha256 }} frozen
 */
function validateTaskDeclarations(content, options) {
  if (!options || options.requireExplicit !== true) {
    throw new TypeError('validateTaskDeclarations requires { taskId, requireExplicit: true }');
  }
  return taskDeclarations(content, options.taskId, false);
}
// Historical observation only: preserve each known declaration independently.
// This cannot admit a new task: validateTaskDeclarations remains strictly explicit.
// Genuine missing fields are null; a wholly unknown historical declaration stays null.
function readHistoricalTaskDeclarations(content, taskId) {
  return taskDeclarations(content, taskId, true);
}
function taskDeclarations(content, taskId, historical) {
  const errors = [];
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) errors.push(['plan-declaration-task-id-invalid', String(taskId)]);
  const fm = typeof content === 'string' ? extractFrontmatter(content) : null;
  const decoded = {};
  for (const key of ['depends', 'writes']) {
    const read = fm === null ? declarationResult(key, 'absent') : decodeDeclarationList(fm, key);
    decoded[key] = read;
    if (read.status === 'absent') {
      if (!historical) errors.push([`plan-declaration-${key}-missing`, fm === null ? 'frontmatter-missing' : 'key-absent']);
    }
    else if (read.status === 'invalid') errors.push([`plan-declaration-${key}-invalid`, `${read.error} (frontmatter line ${read.line})`]);
    else if (read.status === 'empty') errors.push([`plan-declaration-${key}-invalid`, `declaration-empty-value (frontmatter line ${read.line}; declare [] explicitly)`]);
    else if (read.diagnostics.length) {
      const gap = [...read.layout.leading_blank_lines, ...read.layout.interior_blank_lines][0];
      errors.push([`plan-declaration-${key}-blank-gap`, `${read.diagnostics[0]} (frontmatter line ${gap})`]);
    }
  }
  const usable = key => decoded[key].status === 'valid' && decoded[key].diagnostics.length === 0;
  if (usable('depends')) {
    const seen = new Set();
    for (const [index, item] of decoded.depends.items.entries()) {
      if (typeof item !== 'string' || !TASK_ID.test(item)) { errors.push(['plan-declaration-depends-invalid', `depends[${index}] task-id-invalid`]); break; }
      if (seen.has(item)) { errors.push(['plan-declaration-depends-invalid', `depends[${index}] duplicate ${item}`]); break; }
      seen.add(item);
    }
  }
  const writes = [];
  if (usable('writes')) {
    // The existing product-path policy (#348), loaded lazily as in parseMustHaves.
    const { assertRelative } = require('./forge-code-roots');
    for (const [index, item] of decoded.writes.items.entries()) {
      const entry = declaredWrite(item);
      if (!entry) { errors.push(['plan-declaration-writes-invalid', `writes[${index}] entry-invalid`]); continue; }
      try { assertRelative(entry.path); }
      catch (cause) {
        const code = cause.code || 'root-path-invalid';
        errors.push([code === 'root-path-protected' ? 'plan-declaration-path-protected' : 'plan-declaration-writes-invalid', `writes[${index}] ${code}`]);
        continue;
      }
      writes.push(typeof item === 'string' ? item : { root_id: entry.root_id, path: entry.path });
    }
  }
  if (errors.length) {
    const [code, detail] = errors[0];
    throw declarationError(code, detail, { task_id: typeof taskId === 'string' ? taskId : null,
      errors: errors.map(([name, why]) => ({ code: name, detail: why })) });
  }
  if (historical && decoded.depends.status === 'absent' && decoded.writes.status === 'absent') return null;
  const roots = parseArrayKey(fm, 'code_roots');
  const declarations = {
    depends: decoded.depends.status === 'absent' ? null : [...decoded.depends.items],
    writes: decoded.writes.status === 'absent' ? null : writes,
    roots_schema: declarationScalarValue(extractTopLevelValue(fm, 'roots_schema')),
    primary_root_id: declarationScalarValue(extractTopLevelValue(fm, 'primary_root_id')),
    declared_roots: Array.isArray(roots) ? roots.map(root => ({
      id: root && root.id !== undefined ? String(root.id) : null,
      path: root && root.path !== undefined ? String(root.path) : null,
      vcs: root && root.vcs !== undefined ? String(root.vcs) : null,
    })) : null,
  };
  // Digest of the declarations only: prose, checkboxes, comments and EOL never count.
  const declarationSha256 = crypto.createHash('sha256')
    .update(JSON.stringify({ schema: 'forge-task-declarations-v1', ...declarations }), 'utf8').digest('hex');
  return deepFreeze({ task_id: taskId, ...declarations, declaration_sha256: declarationSha256 });
}

// ── Exports ───────────────────────────────────────────────────────────────────

// stripInlineComment is exported so the OTHER reader of the same frontmatter
// keys (forge-dispatch-resolve.js) shares this rule instead of copying it.
// Execution declarations use the same frontmatter parser as must_haves. Missing
// keys remain missing: a consumer must not turn an unread declaration into [].
// depends/writes come from decodeDeclarationList through this reader's fixed
// ordinary projection (issue 343 U0a-r1): a complete YAML list is an array, its
// blank and comment lines included; YAML null (`key:` with no list) and a
// malformed declaration stay present but are null, never an array.
// Structural observation of one requested declaration. Legacy readers keep
// their fixed projection without validating unrelated execution fields. This
// does not admit a writer: full parseExecutionFields/validatePlan remain strict.
function parseExecutionDeclaration(content, key) {
  if (typeof key !== 'string' || !/^[A-Za-z][\w-]*$/.test(key)) throw new Error('execution-plan-declaration-key-invalid');
  const fm = extractFrontmatter(content);
  if (!fm) throw new Error('execution-plan-frontmatter-required');
  return decodeDeclarationList(fm, key);
}

function parseExecutionFields(content) {
  const fm = extractFrontmatter(content);
  if (!fm) throw new Error('execution-plan-frontmatter-required');
  const keys = [...fm.matchAll(/^([A-Za-z][\w-]*):/gm)].map(m => m[1]);
  if (new Set(keys).size !== keys.length) throw new Error('execution-plan-duplicate-key');
  const result = {};
  for (const key of ['depends', 'writes']) {
    const read = decodeDeclarationList(fm, key);
    if (read.error === 'execution-plan-duplicate-key' || read.error === 'declaration-flow-malformed') throw new Error(read.error);
    if (read.status === 'valid') result[key] = read.items.map(item => (typeof item === 'string' ? item : { ...item }));
    else if (read.status !== 'absent') result[key] = null;
  }
  for (const key of ['expected_output', 'code_roots']) {
    if (!keys.includes(key)) continue;
    const read = decodeDeclarationList(fm, key);
    if (read.status === 'invalid') throw new Error(read.error);
    result[key] = read.status === 'valid' ? read.items.map(item => typeof item === 'string' ? item : { ...item }) : undefined;
  }
  for (const key of ['roots_schema', 'primary_root_id']) result[key] = extractTopLevelValue(fm, key);
  return result;
}

module.exports = { hasStructuredMustHaves, parseMustHaves, parseMustHavesStructure, parseExecutionFields, parseExecutionDeclaration, resolveCapability, stripInlineComment,
  extractFrontmatter, decodeDeclarationList, validateTaskDeclarations, readHistoricalTaskDeclarations };

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
      const parsed = parseMustHaves(content);
      process.stdout.write(JSON.stringify({ legacy: false, valid: true, errors: [], domain: parsed.domain, capability: parsed.capability }) + '\n');
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
