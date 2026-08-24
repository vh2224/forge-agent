#!/usr/bin/env node
'use strict';
// forge-completer-claim-audit.test.js — wiring guard (S07/T03): proves the
// `forge-completer` spec (1) invokes forge-claim-audit.js with `--write`,
// unconditionally ("always runs"), (2) no longer carries the omit-when-clean
// instruction for `## File Audit` (with a POSITIVE control — the scanner must
// find the phrase when it is planted, or its absence proves nothing), and
// (3) the two headings (`## File Audit` and `## File Audit (cross-run)`)
// coexist without one section owning the other.
//
// In-process fs.readFileSync only — this shell's `grep` is `ugrep
// --ignore-files` and honors `.gitignore` (`CLAUDE.md` is ignored here), so a
// shelled-out grep would silently miss files under ignore rules. Reading the
// spec directly sidesteps that entirely.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 2026-08-24: the slice body moved verbatim to the on-demand spec — the
// sub-steps this suite audits live there now (the agent .md is a dispatcher).
const SPEC_PATH = path.join(__dirname, '..', 'shared', 'forge-completer-slice.md');
const OMIT_PHRASE = 'omit the section entirely';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`✓ ${name}\n`);
}

function readSpec() {
  return fs.readFileSync(SPEC_PATH, 'utf8');
}

// ── Extraction helpers (mirror the production spec's structure, not its
//    prose — so an unrelated rewording of a paragraph doesn't false-positive
//    this guard) ────────────────────────────────────────────────────────────

function extractSubStep(spec, marker) {
  // Grabs the block starting at a numbered sub-step heading (e.g. "1.87.")
  // through the next numbered sub-step heading at the same nesting level.
  const re = new RegExp(`^${marker.replace('.', '\\.')}\\. \\*\\*`, 'm');
  const start = spec.search(re);
  assert(start >= 0, `sub-step ${marker} not found in spec`);
  const rest = spec.slice(start);
  const nextRe = /\n\d+\.\d+\. \*\*/;
  const nextMatch = nextRe.exec(rest.slice(1));
  const end = nextMatch ? start + 1 + nextMatch.index : spec.length;
  return spec.slice(start, end);
}

// ── (a) invocation of forge-claim-audit.js with --write is present ─────────

test('sub-step 1.87 invokes forge-claim-audit.js with --write', () => {
  const spec = readSpec();
  const block = extractSubStep(spec, '1.87');
  assert(block.includes('forge-claim-audit.js'), 'forge-claim-audit.js not referenced in 1.87');
  assert(/--write\s/.test(block), '--write flag not present in 1.87 invocation');
  assert(block.includes('--slice'), '--slice flag missing');
  assert(block.includes('--milestone'), '--milestone flag missing');
  assert(block.includes('--code-dir'), '--code-dir flag missing');
});

// ── (b) "always runs" appears in the sub-step title ─────────────────────────

test('sub-step 1.87 title states "always runs"', () => {
  const spec = readSpec();
  const block = extractSubStep(spec, '1.87');
  const titleLine = block.split('\n')[0];
  assert(/always runs/.test(titleLine), `1.87 title does not say "always runs": ${titleLine}`);
});

test('the invocation is not conditioned on finding, verdict, or pref', () => {
  const spec = readSpec();
  const block = extractSubStep(spec, '1.87');
  assert(/not conditioned on any finding, verdict, or pref/.test(block),
    'unconditional-invocation language missing from 1.87');
});

// ── (c) absence of the omit-when-clean phrase, WITH a positive control ─────

test('positive control: the scanner finds the omit phrase when planted', () => {
  const planted = 'Write the section only if at least one of `unexpected` or `missing` is non-empty; '
    + `if both are empty, ${OMIT_PHRASE}.`;
  assert(planted.includes(OMIT_PHRASE), 'sanity: planted text does not even contain its own phrase');
});

test('the omit-when-clean phrase is absent from the live spec (proven via positive control above)', () => {
  const spec = readSpec();
  assert(!spec.includes(OMIT_PHRASE), `omit-when-clean phrase still present in ${SPEC_PATH}`);
});

test('sub-step 1.6.f writes the File Audit section unconditionally', () => {
  const spec = readSpec();
  const idx = spec.indexOf('f. **Write `## File Audit` section**');
  assert(idx >= 0, 'sub-step 1.6.f heading not found');
  const block = spec.slice(idx, idx + 1200);
  assert(/unconditionally/.test(block), '1.6.f does not say "unconditionally"');
  assert(block.includes('**Compared:**'), '1.6.f template lost the "Compared" line for the clean case');
});

// ── (d) the two headings are present and distinct ───────────────────────────

test('both `## File Audit` and `## File Audit (cross-run)` headings are present and distinct', () => {
  const spec = readSpec();
  assert(spec.includes('## File Audit\n') || spec.includes('## File Audit\r\n'),
    '`## File Audit` heading missing');
  assert(spec.includes('## File Audit (cross-run)'), '`## File Audit (cross-run)` heading missing');
  // Distinctness: neither is a substring collision that would make one
  // sub-step accidentally think it owns the other's anchor.
  assert.notStrictEqual('## File Audit', '## File Audit (cross-run)');
});

test('sub-step 1.6 (intra-slice) and sub-step 1.87 (cross-run) are the sole owners of their headings', () => {
  const spec = readSpec();
  const step16 = extractSubStep(spec, '1.6');
  const step187 = extractSubStep(spec, '1.87');
  assert(step16.includes('## File Audit\n'), 'sub-step 1.6 does not template `## File Audit`');
  assert(!step16.includes('## File Audit (cross-run)'), 'sub-step 1.6 bled into the cross-run heading');
  assert(step187.includes('## File Audit (cross-run)'), 'sub-step 1.87 does not template the cross-run heading');
  assert(!/## File Audit\n/.test(step187), 'sub-step 1.87 bled into the intra-slice heading');
});

test('no other sub-step was edited: 1.5, 1.8, 1.9 headings still present verbatim', () => {
  const spec = readSpec();
  assert(spec.includes('## Evidence Flags'), 'Evidence Flags section reference missing');
  assert(spec.includes('## Verification Summary'), 'Verification Summary section reference missing');
  assert(spec.includes('1.9. **Checker Memory update'), '1.9 heading missing or altered');
});

// ── Bite: removing the invocation line / reintroducing the omit phrase turns
//    these two guards red, on a disposable copy, restored after. Named and
//    recorded — not merely asserted in a comment. ────────────────────────────

function withMutatedSpec(mutate, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'completer-claim-audit-bite-'));
  const copy = path.join(dir, 'forge-completer.md');
  const original = readSpec();
  fs.writeFileSync(copy, mutate(original), 'utf8');
  try {
    return fn(copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkInvocationPresent(specText) {
  const re = /^1\.87\. \*\*/m;
  const start = specText.search(re);
  if (start < 0) return false;
  const rest = specText.slice(start);
  const nextMatch = /\n\d+\.\d+\. \*\*/.exec(rest.slice(1));
  const end = nextMatch ? start + 1 + nextMatch.index : specText.length;
  const block = specText.slice(start, end);
  return block.includes('forge-claim-audit.js') && /--write\s/.test(block);
}

test('BITE: removing the 1.87 invocation line turns the invocation-presence guard red', () => {
  const original = readSpec();
  assert.strictEqual(checkInvocationPresent(original), true, 'baseline (unmutated) must be green first');

  withMutatedSpec((text) => text.replace(
    /node "\$FORGE_SCRIPTS_DIR\/forge-claim-audit\.js" \\\n {9}--slice \{S##\} \\\n {9}--milestone \{M###\} \\\n {9}--cwd \{WORKING_DIR\} \\\n {9}--code-dir \{CODE_DIR\} \\\n {9}--run \{RUN_ID\} \\\n {9}--write "\{WORKING_DIR\}\/\.gsd\/milestones\/\{M###\}\/slices\/\{S##\}\/\{S##\}-SUMMARY\.md"/,
    'echo removed-for-bite-test',
  ), (mutatedPath) => {
    const mutatedText = fs.readFileSync(mutatedPath, 'utf8');
    assert.notStrictEqual(mutatedText, original, 'mutation did not change anything — bite is inert');
    const result = checkInvocationPresent(mutatedText);
    assert.strictEqual(result, false, 'BITE FAILED: guard stayed green after removing the invocation line');
    process.stdout.write('  ✓ BITE recorded: invocation-presence assert went RED after removal, as expected\n');
  });
});

test('BITE: reintroducing the omit-when-clean phrase turns the absence guard red', () => {
  const original = readSpec();
  assert(!original.includes(OMIT_PHRASE), 'baseline (unmutated) must be green (phrase absent) first');

  withMutatedSpec((text) => text.replace(
    'f. **Write `## File Audit` section** to `S##-SUMMARY.md`, **unconditionally**',
    `f. **Write \`## File Audit\` section** to \`S##-SUMMARY.md\`. Write the section only if at least `
    + `one of \`unexpected\` or \`missing\` is non-empty; if both are empty, ${OMIT_PHRASE}`,
  ), (mutatedPath) => {
    const mutatedText = fs.readFileSync(mutatedPath, 'utf8');
    assert.notStrictEqual(mutatedText, original, 'mutation did not change anything — bite is inert');
    const stillAbsent = !mutatedText.includes(OMIT_PHRASE);
    assert.strictEqual(stillAbsent, false, 'BITE FAILED: absence guard stayed green after reintroducing the phrase');
    process.stdout.write('  ✓ BITE recorded: omit-phrase-absence assert went RED after reintroduction, as expected\n');
  });
});

process.stdout.write(`\n${passed} passed\n`);
