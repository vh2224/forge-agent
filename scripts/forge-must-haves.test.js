#!/usr/bin/env node
// forge-must-haves.test.js — real test suite for forge-must-haves.js
// Covers the 26-cell inline/block × empty/full × nesting-level matrix
// plus regression and reject axes.
// Run: node scripts/forge-must-haves.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { hasStructuredMustHaves, parseMustHaves, resolveCapability } = require('./forge-must-haves.js');

const SCRIPT = path.join(__dirname, 'forge-must-haves.js');
// Temp dir for CLI --check tests
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-must-haves-test-'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Helper: build a minimal valid plan frontmatter string + body
// frontmatter: string of YAML content between ---
function mkPlan(frontmatter) {
  return `---\n${frontmatter}\n---\n# Task\n`;
}

// A minimal valid must_haves block — used as base for permutations
const BASE_MUST_HAVES = `must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links:
    - from: "a.js"
      to: "b.js"
      via: "require('./b')"
expected_output:
  - scripts/foo.js`;

console.log('\n=== forge-must-haves.js — real test suite ===\n');

// ─────────────────────────────────────────────────────────────
// Axis 1: Primary — form × fill × nesting level (the 2 blind spots)
// ─────────────────────────────────────────────────────────────
console.log('Axis 1: Primary — inline/block × empty/full × nesting level\n');

// Cell 1: truths inline empty
test('Cell 1: truths: [] inline (empty) — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths: []
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, []);
});

// Cell 2: truths inline full
test('Cell 2: truths: [a, b] inline (full) — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths: [first truth, second truth]
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, ['first truth', 'second truth']);
});

// Cell 3: key_links inline empty
test('Cell 3: key_links: [] inline (empty) — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.key_links, []);
});

// Cell 4: artifacts inline empty
test('Cell 4: artifacts: [] inline (empty) — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts, []);
});

// Cell 5: truths block full (regression — was already working)
test('Cell 5: truths block full — PASS (regression)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "first truth"
    - "second truth"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, ['first truth', 'second truth']);
});

// Cell 6: stub_patterns block form under artifact (single artifact)
test('Cell 6: stub_patterns block-form under artifacts[] — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        - "FIXME"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 1, 'expected 1 artifact');
  assertEq(r.artifacts[0].stub_patterns, ['TODO', 'FIXME']);
});

// Cell 7: stub_patterns block form in multiple artifacts
test('Cell 7: stub_patterns block-form in 2 artifacts — was FAIL, now PASS', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "scripts/b.js"
      provides: "b"
      min_lines: 5
      stub_patterns:
        - "FIXME"
        - "NOT_IMPLEMENTED"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 2, 'expected 2 artifacts');
  assertEq(r.artifacts[0].stub_patterns, ['TODO']);
  assertEq(r.artifacts[1].stub_patterns, ['FIXME', 'NOT_IMPLEMENTED']);
});

// Cell 8: stub_patterns inline in artifact (was already working)
test('Cell 8: stub_patterns: [a, b] inline in artifact — PASS (regression)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns: ["TODO", "FIXME"]
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts[0].stub_patterns, ['TODO', 'FIXME']);
});

// Cell 9: stub_patterns inline empty in artifact (was already working)
test('Cell 9: stub_patterns: [] inline in artifact — PASS (regression)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns: []
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts[0].stub_patterns, []);
});

// Cell 10: expected_output inline (top-level, was already working)
test('Cell 10: expected_output: [] inline and [a,b] — PASS (regression)', () => {
  const emptyPlan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r1 = parseMustHaves(emptyPlan);
  assertEq(r1.expected_output, []);

  const fullPlan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: [scripts/foo.js, scripts/bar.js]`);
  const r2 = parseMustHaves(fullPlan);
  assertEq(r2.expected_output, ['scripts/foo.js', 'scripts/bar.js']);
});

// Cell 11: expected_output block (top-level, was already working)
test('Cell 11: expected_output block form — PASS (regression)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output:
  - scripts/foo.js
  - scripts/bar.js`);
  const r = parseMustHaves(plan);
  assertEq(r.expected_output, ['scripts/foo.js', 'scripts/bar.js']);
});

// ─────────────────────────────────────────────────────────────
// Axis 2: Regression — currently-valid plans stay valid
// ─────────────────────────────────────────────────────────────
console.log('\nAxis 2: Regression — currently-valid plans stay valid\n');

// Cell 12: full canonical structured plan
test('Cell 12: full canonical plan (all block) — PASS', () => {
  const plan = mkPlan(`id: T01
description: "test task"
must_haves:
  truths:
    - "it compiles"
    - "tests pass"
  artifacts:
    - path: "scripts/foo.js"
      provides: "main script"
      min_lines: 50
      stub_patterns:
        - "TODO"
        - "FIXME"
    - path: "scripts/foo.test.js"
      provides: "test suite"
      min_lines: 100
  key_links:
    - from: "scripts/foo.test.js"
      to: "scripts/foo.js"
      via: "require('./foo')"
expected_output:
  - scripts/foo.js
  - scripts/foo.test.js`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, ['it compiles', 'tests pass']);
  assert(r.artifacts.length === 2, 'expected 2 artifacts');
  assertEq(r.artifacts[0].stub_patterns, ['TODO', 'FIXME']);
  assert(r.artifacts[1].stub_patterns === undefined, 'second artifact should have no stub_patterns');
  assert(r.key_links.length === 1, 'expected 1 key_link');
  assertEq(r.expected_output, ['scripts/foo.js', 'scripts/foo.test.js']);
});

// Cell 13: legacy plan — hasStructuredMustHaves returns false
test('Cell 13: legacy plan (no must_haves) — hasStructuredMustHaves false', () => {
  const plan = `---\nid: T01\ndescription: "old plan"\n---\n# Task\n`;
  assert(!hasStructuredMustHaves(plan), 'should be legacy');
});

// Cell 13b: legacy plan CLI --check
test('Cell 13b: legacy plan — CLI --check reports legacy:true', () => {
  const planPath = path.join(ROOT, 'legacy.md');
  fs.writeFileSync(planPath, `---\nid: T01\ndescription: "old plan"\n---\n# Task\n`);
  const out = execFileSync('node', [SCRIPT, '--check', planPath], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assertEq(result.legacy, true);
  assertEq(result.valid, true);
});

// Cell 14: stub_patterns absent (optional field)
test('Cell 14: stub_patterns absent in artifact — PASS (undefined)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts[0].stub_patterns === undefined, 'stub_patterns should be undefined');
});

// Cell 15: min_lines as number via inline field
test('Cell 15: min_lines numeric field — PASS', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 42
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts[0].min_lines, 42);
  assert(typeof r.artifacts[0].min_lines === 'number', 'min_lines should be a number');
});

// Cell 16: stub_patterns in block with items containing ":"
test('Cell 16: stub_patterns block with colon-containing items — Pitfall 3', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO:"
        - "throw new Error('not implemented: x')"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts[0].stub_patterns, ["TODO:", "throw new Error('not implemented: x')"]);
});

// ─────────────────────────────────────────────────────────────
// Axis 3: Reject — malformed schemas still throw
// ─────────────────────────────────────────────────────────────
console.log('\nAxis 3: Reject — malformed schemas still throw\n');

function assertThrows(fn, pattern, label) {
  try {
    fn();
    throw new Error(`${label}: expected throw but did not throw`);
  } catch (e) {
    if (e.message.startsWith(label + ': expected throw')) throw e;
    if (pattern && !pattern.test(e.message)) {
      throw new Error(`${label}: threw but message did not match ${pattern}\n     got: ${e.message}`);
    }
  }
}

// Cell 17: must_haves block present but empty
test('Cell 17: must_haves empty block — throws', () => {
  const plan = mkPlan(`must_haves:\nexpected_output: []`);
  assertThrows(() => parseMustHaves(plan), /malformed must_haves schema/, 'Cell 17');
});

// Cell 18: artifact missing path
test('Cell 18: artifact without path — throws', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  assertThrows(() => parseMustHaves(plan), /malformed must_haves schema.*path.*required/, 'Cell 18');
});

// Cell 19: artifact missing min_lines
test('Cell 19: artifact without min_lines — throws', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
  key_links: []
expected_output: []`);
  assertThrows(() => parseMustHaves(plan), /malformed must_haves schema.*min_lines.*required/, 'Cell 19');
});

// Cell 20: key_link missing via
test('Cell 20: key_link without via — throws', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links:
    - from: "a.js"
      to: "b.js"
expected_output: []`);
  assertThrows(() => parseMustHaves(plan), /malformed must_haves schema.*via.*required/, 'Cell 20');
});

// Cell 21: truths contains non-string item
// Note: block form items are always parsed as strings by parseStringArray; this case is harder to
// trigger via text format since all block items become strings. Testing the shape validator
// by checking truths must be array (empty truths: with a nested non-string would need object items).
// Instead, test that truths with numeric-looking items still validates as string.
test('Cell 21: truths items are parsed as strings (not coerced to numbers)', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "123"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, ['123']);
  assert(typeof r.truths[0] === 'string', 'truths item should be a string');
});

// Cell 22: stub_patterns as scalar string (after patch, block with no items → []; explicit scalar test)
test('Cell 22: stub_patterns as plain string scalar — throws', () => {
  // Inline scalar value that is not an array
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns: "not-an-array"
  key_links: []
expected_output: []`);
  assertThrows(() => parseMustHaves(plan), /malformed must_haves schema.*stub_patterns.*must be an array/, 'Cell 22');
});

// ─────────────────────────────────────────────────────────────
// Axis 4: Edge — patch robustness
// ─────────────────────────────────────────────────────────────
console.log('\nAxis 4: Edge — patch robustness\n');

// Cell 23: blank line between stub_patterns items
// NOTE: extractSubBlock stops at blank lines (pre-existing constraint, not in patch scope).
// The pending block-sequence state correctly does NOT close on blank lines WITHIN the block,
// but a blank line inside a must_haves sub-block terminates extractSubBlock early.
// This test verifies the expected (currently constrained) behavior: blank line breaks the block.
// The parseObjectArray-level fix (pending state does not close) is exercised in Cell 24 instead,
// where the comment line is within the already-extracted block without a blank line separator.
test('Cell 23: blank line inside must_haves sub-block terminates extractSubBlock (known constraint)', () => {
  // Blank line between artifacts would terminate the must_haves block extraction at extractSubBlock.
  // Verify the parser handles this gracefully (may produce incomplete artifacts, not crash).
  // Within a single artifact's stub_patterns (no blank line before it), items are collected correctly.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        - "FIXME"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  // When no blank line in between, all items are collected
  assertEq(r.artifacts[0].stub_patterns, ['TODO', 'FIXME']);
});

// Cell 24: comment line inside stub_patterns block
test('Cell 24: comment line inside stub_patterns block — ignored, block not closed', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        # this is a comment
        - "FIXME"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.artifacts[0].stub_patterns, ['TODO', 'FIXME']);
});

// Cell 25: stub_patterns block immediately followed by next artifact's - path:
test('Cell 25: stub_patterns block closes when next artifact starts', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "scripts/b.js"
      provides: "b"
      min_lines: 5
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 2, 'expected 2 artifacts');
  assertEq(r.artifacts[0].stub_patterns, ['TODO']);
  assert(r.artifacts[1].stub_patterns === undefined || Array.isArray(r.artifacts[1].stub_patterns),
    'second artifact stub_patterns should be undefined or array');
  assert(r.artifacts[1].path === 'scripts/b.js', 'second artifact path wrong');
});

// Cell 26: Standard 2-space indented must_haves children (the canonical form all real plans use).
// Pitfall 1 note: parseMustHaves dedents by exactly 2 spaces, so only 2-space indented
// must_haves children land at col 0 and are parseable. 4-space indented children are out of scope
// for this patch (they fail in extractSubBlock before reaching the patched functions).
// This cell verifies the patched functions work correctly with the standard 2-space indentation.
test('Cell 26: 2-space indented must_haves children (standard — inline probe + block-sequence)', () => {
  const plan = mkPlan(`must_haves:
  truths: []
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assertEq(r.truths, []);
  assert(r.artifacts.length === 1, 'expected 1 artifact');
  assertEq(r.artifacts[0].stub_patterns, ['TODO']);
});

// ─────────────────────────────────────────────────────────────
// Axis 5: Reviewer regression — pending-guard ordering (HIGH) + indent (MEDIUM)
// ─────────────────────────────────────────────────────────────
console.log('\nAxis 5: Reviewer regression — pending-guard ordering + indent\n');

// Cell 27 (HIGH): stub_patterns item with colon — must NOT be parsed as new artifact
// Before fix: "- TODO: fix this" inside stub_patterns was consumed by itemMatch first,
// creating a spurious second artifact and silently corrupting the parsed schema.
test('Cell 27 (HIGH): stub_patterns block item "TODO: fix this" (colon in value) → 1 artifact, not 2', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO: fix this"
        - "FIXME: later"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 1, `expected 1 artifact, got ${r.artifacts.length}`);
  assertEq(r.artifacts[0].stub_patterns, ['TODO: fix this', 'FIXME: later']);
  assertEq(r.artifacts[0].path, 'scripts/foo.js');
});

// Cell 28 (HIGH): colon item is the ONLY stub_patterns entry
test('Cell 28 (HIGH): single colon-containing stub_patterns item → 1 artifact', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "works"
  artifacts:
    - path: "src/auth.js"
      provides: "auth"
      min_lines: 20
      stub_patterns:
        - "throw new Error('not implemented: login')"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 1, `expected 1 artifact, got ${r.artifacts.length}`);
  assertEq(r.artifacts[0].stub_patterns, ["throw new Error('not implemented: login')"]);
});

// Cell 29 (MEDIUM): seq-dash line at same/lesser indent than pending field closes pending
// deterministically and the line is re-evaluated as a new artifact.
// Setup: first artifact has stub_patterns (pending), then a new artifact starts at equal indent.
test('Cell 29 (MEDIUM): stub_patterns followed by next artifact at equal indent closes pending cleanly', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "works"
  artifacts:
    - path: "src/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "src/b.js"
      provides: "b"
      min_lines: 5
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 2, `expected 2 artifacts, got ${r.artifacts.length}`);
  assertEq(r.artifacts[0].stub_patterns, ['TODO']);
  assertEq(r.artifacts[1].path, 'src/b.js');
  assert(r.artifacts[1].stub_patterns === undefined, 'second artifact should have no stub_patterns');
});

// Cell 30 (MEDIUM): seq-dash line at lesser indent followed by more items — those items
// must NOT be collected into the already-closed pending field.
test('Cell 30 (MEDIUM): items after pending-close not incorrectly collected into prior field', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "works"
  artifacts:
    - path: "src/a.js"
      provides: "a"
      min_lines: 5
      stub_patterns:
        - "TODO"
    - path: "src/b.js"
      provides: "b"
      min_lines: 8
      stub_patterns:
        - "FIXME"
  key_links: []
expected_output: []`);
  const r = parseMustHaves(plan);
  assert(r.artifacts.length === 2, `expected 2 artifacts, got ${r.artifacts.length}`);
  assertEq(r.artifacts[0].stub_patterns, ['TODO']);
  assertEq(r.artifacts[1].stub_patterns, ['FIXME']);
});

// ─────────────────────────────────────────────────────────────
// CLI --check spot checks (Agent's Discretion)
// ─────────────────────────────────────────────────────────────
console.log('\nCLI --check spot checks\n');

test('CLI: key_links: [] inline → valid:true', () => {
  const planPath = path.join(ROOT, 'cli-inline-keylinks.md');
  fs.writeFileSync(planPath, mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
  key_links: []
expected_output: []`));
  const out = execFileSync('node', [SCRIPT, '--check', planPath], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assertEq(result.valid, true);
  assertEq(result.legacy, false);
});

test('CLI: block-form stub_patterns → valid:true', () => {
  const planPath = path.join(ROOT, 'cli-block-stub.md');
  fs.writeFileSync(planPath, mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "scripts/foo.js"
      provides: "does stuff"
      min_lines: 10
      stub_patterns:
        - "TODO"
        - "FIXME"
  key_links: []
expected_output: []`));
  const out = execFileSync('node', [SCRIPT, '--check', planPath], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assertEq(result.valid, true);
  assertEq(result.legacy, false);
});

test('CLI: malformed plan (missing path) → valid:false, exit 2', () => {
  const planPath = path.join(ROOT, 'cli-malformed.md');
  fs.writeFileSync(planPath, mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - provides: "oops no path"
      min_lines: 10
  key_links: []
expected_output: []`));
  try {
    execFileSync('node', [SCRIPT, '--check', planPath], { encoding: 'utf8' });
    throw new Error('expected exit 2 but exited 0');
  } catch (e) {
    if (e.message === 'expected exit 2 but exited 0') throw e;
    const out = (e.stdout || '').toString();
    const result = JSON.parse(out);
    assertEq(result.valid, false);
    assertEq(result.legacy, false);
    assert(result.errors.length > 0, 'expected errors array');
  }
});

// ─────────────────────────────────────────────────────────────
// Nested top-level keys (regression — real dogfood plans)
//
// Measured defect: 2 of 3 sidecar-generated plans in a single real run indented
// `expected_output`/`writes`/`depends` under `must_haves:`. forge-code-dir.js saw
// `paths_considered: 0` and refused the sidecar; this validator stamped all three
// `valid: true`. The fixtures below are those three plans, copied byte-for-byte.
//
// This axis must bite in BOTH directions: the flat plan stays valid, the nested
// ones fail. A guard that only rejects is as blind as one that only accepts.
// ─────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures', 'nested-keys');

function checkFixture(name) {
  const p = path.join(FIXTURES, name);
  try {
    return { exit: 0, result: JSON.parse(execFileSync('node', [SCRIPT, '--check', p], { encoding: 'utf8' })) };
  } catch (e) {
    if (e.stdout === undefined) throw e;
    return { exit: e.status, result: JSON.parse(e.stdout.toString()) };
  }
}

test('nested-keys: real S01 plan (keys at column 0) stays valid — exit 0', () => {
  const { exit, result } = checkFixture('s01-top-level-PLAN.md');
  assertEq(exit, 0, 'flat plan must still exit 0');
  assertEq(result.valid, true);
  assertEq(result.legacy, false);
});

test('nested-keys: real S01 plan still yields its expected_output paths', () => {
  // Guards the "only rejects" failure mode at the parse level, not just the exit code:
  // a flat plan must keep producing the paths downstream consumers read.
  const parsed = parseMustHaves(fs.readFileSync(path.join(FIXTURES, 's01-top-level-PLAN.md'), 'utf8'));
  assert(parsed.expected_output.length > 0, 'flat plan lost its expected_output');
});

for (const fixture of ['s02-nested-PLAN.md', 's03-nested-PLAN.md']) {
  test(`nested-keys: real ${fixture.slice(0, 3).toUpperCase()} plan (keys indented) → valid:false, exit 2`, () => {
    const { exit, result } = checkFixture(fixture);
    assertEq(exit, 2, 'nested plan must exit 2');
    assertEq(result.valid, false);
    assertEq(result.legacy, false);
    assert(/nested-top-level-key/.test(result.errors[0]), `error must be named: ${result.errors[0]}`);
  });

  test(`nested-keys: ${fixture} error names every offending key and where it belongs`, () => {
    const { result } = checkFixture(fixture);
    const err = result.errors[0];
    for (const k of ['expected_output', 'writes', 'depends']) {
      assert(err.includes(k), `error must name \`${k}\`: ${err}`);
    }
    assert(/column 0/.test(err), `error must state the fix: ${err}`);
    assert(/frontmatter line \d/.test(err), `error must locate the offence: ${err}`);
  });
}

test('nested-keys: each forbidden key trips the guard on its own', () => {
  for (const key of ['expected_output', 'writes', 'depends']) {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
  ${key}: []`);
    let threw = null;
    try { parseMustHaves(plan); } catch (e) { threw = e.message; }
    assert(threw !== null, `nested \`${key}\` was accepted`);
    assert(threw.includes('nested-top-level-key') && threw.includes(key), `wrong error for ${key}: ${threw}`);
  }
});

test('nested-keys: guard does not fire on schema fields inside sequence items', () => {
  // `from`/`to`/`via`/`path` live legitimately under must_haves. A guard that
  // matched any indented key would reject every well-formed plan in the repo.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts:
    - path: "src/a.ts"
      provides: "thing"
      min_lines: 5
  key_links:
    - from: "src/a.ts"
      to: "src/b.ts"
      via: "import"
expected_output:
  - src/a.ts
writes:
  - src/a.ts
depends: []`);
  const parsed = parseMustHaves(plan);
  assertEq(parsed.expected_output.length, 1);
  assertEq(parsed.artifacts.length, 1);
});

// ── Review objections R1/R2/R3 — conceded, fixed, guarded ────────────────────

test('R1: blank line inside must_haves does not end the scan (nested writes still caught)', () => {
  // A blank line does not terminate a YAML mapping. The original boundary treated
  // it as the end, so one blank line hid a nested `writes:` from both the guard
  // and the parser and the plan validated clean.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []

  writes:
    - "src/a.ts"
expected_output: []`);
  let threw = null;
  try { parseMustHaves(plan); } catch (e) { threw = e.message; }
  assert(threw !== null, 'nested `writes:` behind a blank line was accepted');
  assert(threw.includes('nested-top-level-key') && threw.includes('writes'), `wrong error: ${threw}`);
});

test('R1: a comment line inside must_haves does not end the scan either', () => {
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
# a comment at column 0
  depends: []
expected_output: []`);
  let threw = null;
  try { parseMustHaves(plan); } catch (e) { threw = e.message; }
  assert(threw !== null, 'nested `depends:` behind a comment line was accepted');
  assert(threw.includes('nested-top-level-key'), `wrong error: ${threw}`);
});

test('R1 (accept side): a blank line inside a LEGITIMATE must_haves keeps its content', () => {
  // The boundary fix must not only reject more — it must read more. Under the old
  // rule everything after the blank line was dropped, so `key_links` went missing
  // and this well-formed plan failed for the wrong reason.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"

  artifacts:
    - path: "src/a.ts"
      provides: "thing"
      min_lines: 5

  key_links:
    - from: "src/a.ts"
      to: "src/b.ts"
      via: "import"
expected_output:
  - src/a.ts`);
  const parsed = parseMustHaves(plan);
  assertEq(parsed.truths.length, 1, 'truths lost');
  assertEq(parsed.artifacts.length, 1, 'artifacts lost across the blank line');
  assertEq(parsed.key_links.length, 1, 'key_links lost across the blank line');
  assertEq(parsed.expected_output.length, 1, 'expected_output lost');
});

test('R1: a non-blank column-0 line still ends the block', () => {
  // The boundary was loosened for blanks/comments only. A real top-level key must
  // still terminate must_haves, or every sibling below it would be scanned as nested.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output:
  - src/a.ts
writes:
  - src/a.ts
depends: []
capability: networked
repo: api`);
  const parsed = parseMustHaves(plan);
  assertEq(parsed.expected_output.length, 1);
  assertEq(parsed.capability, 'networked');
});

test('R2: every key in NESTED_SIBLING_KEYS trips the guard when nested', () => {
  const keys = ['expected_output', 'writes', 'depends', 'capability', 'repo',
                'domain', 'tier', 'effort', 'worker', 'tag'];
  for (const key of keys) {
    const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
  ${key}: somevalue`);
    let threw = null;
    try { parseMustHaves(plan); } catch (e) { threw = e.message; }
    assert(threw !== null, `nested \`${key}\` was accepted`);
    assert(threw.includes('nested-top-level-key') && threw.includes(key), `wrong error for ${key}: ${threw}`);
  }
});

test('R2: nested capability no longer resolves to a silent workspace sandbox', () => {
  // The consequence that made this more than a formatting nit: a genuinely
  // networked task validated clean, ran in `workspace`, and emitted no
  // capability-unrecognized event.
  const plan = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
  capability: networked
expected_output: []`);
  let threw = null;
  try { parseMustHaves(plan); } catch (e) { threw = e.message; }
  assert(threw !== null && threw.includes('capability'), `nested capability accepted: ${threw}`);
});

test('R3: `capability: null` with an inline comment agrees across both routes', () => {
  // The null check ran before the comment strip and was not repeated after, so the
  // gate threw while the adapter resolved cleanly.
  const plan = mkPlan(`capability: null # legacy plan
must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output: []`);
  const parsed = parseMustHaves(plan);            // must not throw
  assertEq(parsed.capability, null, 'gate route');
  const resolved = resolveCapability(plan);
  assertEq(resolved.capability, 'workspace', 'adapter route capability');
  assertEq(resolved.declared, null, 'adapter route declared');
  assertEq(resolved.event, null, 'adapter must not emit capability-unrecognized');
});

test('R3: a real bad capability still throws (the fix did not swallow the enum)', () => {
  const plan = mkPlan(`capability: bogus # nope
must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output: []`);
  let threw = null;
  try { parseMustHaves(plan); } catch (e) { threw = e.message; }
  assert(threw !== null && /must be one of/.test(threw), `bogus capability accepted: ${threw}`);
});

test('nested-keys: a legacy plan is untouched by the guard', () => {
  // Legacy plans never reach parseMustHaves — the CLI short-circuits before it.
  // Asserted at the CLI, which is where the executor's step 1a reads the verdict.
  const planPath = path.join(ROOT, 'legacy-nested.md');
  fs.writeFileSync(planPath, `---
id: T01
---

## Must-Haves
- expected_output: whatever, free text
`);
  const out = execFileSync('node', [SCRIPT, '--check', planPath], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assertEq(result.legacy, true);
  assertEq(result.valid, true);
});

// ─────────────────────────────────────────────────────────────
// CRLF / CR-only normalization (T-20260811190103)
//
// extractFrontmatter normalizes /\r\n?/g → \n at the single funnel every
// export reads through (hasStructuredMustHaves, parseMustHaves,
// resolveCapability). Bite proven in BOTH directions (valid stays valid,
// nested still rejects) across LF/CRLF/CR-only, all synthesized here in
// tmpdir — never inherited from this checkout's on-disk line endings.
// ─────────────────────────────────────────────────────────────

function toCRLF(s) { return s.replace(/\n/g, '\r\n'); }
function toCROnly(s) { return s.replace(/\n/g, '\r'); }

function writeAndCheck(name, content) {
  const p = path.join(ROOT, name);
  fs.writeFileSync(p, content);
  try {
    return { exit: 0, result: JSON.parse(execFileSync('node', [SCRIPT, '--check', p], { encoding: 'utf8' })) };
  } catch (e) {
    if (e.stdout === undefined) throw e;
    return { exit: e.status, result: JSON.parse(e.stdout.toString()) };
  }
}

const CRLF_VALID_LF = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output: []`);

const CRLF_NESTED_LF = mkPlan(`must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
  expected_output: []`);

const BOM = '\uFEFF';
for (const [label, toEol] of [['CRLF', toCRLF], ['CR-only', toCROnly], ['BOM+LF', s => BOM + s], ['BOM+CRLF', s => BOM + toCRLF(s)]]) {
  test(`${label}: valid plan → hasStructuredMustHaves true + CLI exit 0, legacy:false, valid:true`, () => {
    const content = toEol(CRLF_VALID_LF);
    assertEq(hasStructuredMustHaves(content), true, `hasStructuredMustHaves must see must_haves: under ${label}`);
    const { exit, result } = writeAndCheck(`${label}-valid.md`, content);
    assertEq(exit, 0);
    assertEq(result.legacy, false);
    assertEq(result.valid, true);
  });

  test(`${label}: plan with nested top-level key → CLI exit 2, error names the offending key`, () => {
    const content = toEol(CRLF_NESTED_LF);
    const { exit, result } = writeAndCheck(`${label}-nested.md`, content);
    assertEq(exit, 2, 'nested plan must exit 2');
    assertEq(result.valid, false);
    assert(/nested-top-level-key/.test(result.errors[0]), `error must be named: ${result.errors[0]}`);
    assert(result.errors[0].includes('expected_output'), `error must name the offending key: ${result.errors[0]}`);
  });
}

test('CRLF vs LF vs CR-only: identical verdict AND identical reported line numbers for the same nested plan', () => {
  const forms = { LF: CRLF_NESTED_LF, CRLF: toCRLF(CRLF_NESTED_LF), CR: toCROnly(CRLF_NESTED_LF) };
  const results = {};
  for (const [label, content] of Object.entries(forms)) {
    let threw = null;
    try { parseMustHaves(content); } catch (e) { threw = e.message; }
    assert(threw !== null, `${label}: nested key was accepted`);
    results[label] = threw;
  }
  assertEq(results.LF, results.CRLF, 'CRLF error text must match LF exactly, including line numbers');
  assertEq(results.LF, results.CR, 'CR-only error text must match LF exactly, including line numbers');
});

test('resolveCapability: CRLF plan agrees with LF, and agrees with hasStructuredMustHaves across forms', () => {
  const lf = mkPlan(`capability: networked
must_haves:
  truths:
    - "it works"
  artifacts: []
  key_links: []
expected_output: []`);
  const crlf = toCRLF(lf);
  const cr = toCROnly(lf);

  const capLf = resolveCapability(lf);
  const capCrlf = resolveCapability(crlf);
  const capCr = resolveCapability(cr);

  assertEq(capLf.capability, 'networked');
  assertEq(capLf.declared, 'networked');
  assertEq(capCrlf, capLf, 'resolveCapability must agree between LF and CRLF');
  assertEq(capCr, capLf, 'resolveCapability must agree between LF and CR-only');

  // Concordance assert: resolveCapability and hasStructuredMustHaves must agree
  // on "is this plan readable as structured" across all three forms — this is
  // the invariant that breaks if a parallel reader bypasses extractFrontmatter.
  for (const [label, content] of Object.entries({ LF: lf, CRLF: crlf, CR: cr })) {
    const structured = hasStructuredMustHaves(content);
    const cap = resolveCapability(content);
    assertEq(structured, true, `${label}: hasStructuredMustHaves must be true`);
    assert(cap.declared === 'networked', `${label}: resolveCapability must see the declared capability (concordance with hasStructuredMustHaves)`);
  }
});

// ─────────────────────────────────────────────────────────────
// issue 343 U0a / U0a-r1 — one structural depends/writes decoder, fixed consumer
// projections and strict declarations
//
// scripts/fixtures/parallelism/reader-cases.json names each case once with its one
// structural decoding and the fixed projection of every consumer: ordinary
// (parseExecutionFields), temporal (controller time DAG), schedule (forge-parallelism)
// and strict (validateTaskDeclarations). Each consumer must produce exactly its row.
// ─────────────────────────────────────────────────────────────
const READER_CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'parallelism', 'reader-cases.json'), 'utf8'));
function readerCasePlan(c) {
  return ['---', ...c.frontmatter, '---', `# ${c.task}`, ''].join(c.eol === 'crlf' ? '\r\n' : '\n');
}
// The prerequisite task IDs of a reader case, from its expected structural decoding.
function readerCasePrerequisites(c) {
  const decoded = c.decoded.depends;
  return decoded.status === 'valid' ? decoded.items.filter(item => typeof item === 'string') : [];
}
// Reader cases as real owner plans: one slice per case holding the case task and its
// prerequisites (`depends: []` plans), so the controller time DAG runs its own
// readTaskPlan, dependsOf and taskDag. The time DAG applies only to a milestone with
// a decided time contract; only that selection source is stubbed (a decided
// contract without task bindings) and restored before `visit` runs.
function withReaderOwner(cases, prerequisitesOf, visit) {
  const controller = require('./forge-unit-controller.js'), timeSelection = require('./forge-milestone-time-selection.js');
  const owner = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-u0a-readers-')));
  const milestone = 'M001', sliceOf = index => `S${String(index + 1).padStart(2, '0')}`;
  const ownerFile = (relative, content) => {
    const file = path.join(owner, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  try {
    const base = `.gsd/milestones/${milestone}`;
    ownerFile(`${base}/${milestone}-ROADMAP.md`, `# ${milestone}: Reader cases\n\n## Slices\n\n`
      + cases.map((c, index) => `- [ ] **${sliceOf(index)}: ${c.name}** \`depends:[]\`\n`).join(''));
    const planFiles = cases.map((c, index) => {
      const slice = `${base}/slices/${sliceOf(index)}`, ids = [...prerequisitesOf(c), c.task];
      ownerFile(`${slice}/${sliceOf(index)}-PLAN.md`, `# ${sliceOf(index)}\n\n## Tasks\n${ids.map(id => `- [ ] **${id}: Reader case task**`).join('\n')}\n`);
      for (const id of prerequisitesOf(c)) ownerFile(`${slice}/tasks/${id}/${id}-PLAN.md`, `---\ndepends: []\nwrites: [docs/${id}.md]\n---\n# ${id}\n`);
      return ownerFile(`${slice}/tasks/${c.task}/${c.task}-PLAN.md`, readerCasePlan(c));
    });
    const saved = { read: timeSelection.readSelectionState, bind: timeSelection.taskBindingContext };
    let inventory;
    try {
      timeSelection.readSelectionState = () => ({ status: 'decided', contract: { fixture: 'issue343-U0a' } });
      timeSelection.taskBindingContext = () => ({ status: 'absent' });
      inventory = controller.discoverInventory(owner, milestone, { active_slice: sliceOf(0) });
    } finally {
      timeSelection.readSelectionState = saved.read;
      timeSelection.taskBindingContext = saved.bind;
    }
    if (inventory.task_dag !== true) throw new Error('the controller time DAG did not run');
    return visit({ planFiles, dagOf: index => inventory.slices.find(slice => slice.id === sliceOf(index)).task_dag });
  } finally {
    fs.rmSync(owner, { recursive: true, force: true });
  }
}

test('issue343 U0a-1 one reader: every reader case is decoded once and must-haves, parallelism and the controller time DAG apply their fixed projections', () => {
  const strict = require('assert');
  const must = require('./forge-must-haves.js'), parallel = require('./forge-parallelism.js'), codeDir = require('./forge-code-dir.js');
  strict(READER_CASES.schema_version === 2 && READER_CASES.cases.length >= 25, 'the reader-case projection matrix is present');
  withReaderOwner(READER_CASES.cases, readerCasePrerequisites, ({ planFiles, dagOf }) => {
    READER_CASES.cases.forEach((c, index) => {
      const content = readerCasePlan(c), fm = must.extractFrontmatter(content), want = c.projections;
      const raw = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]; // the frontmatter as the CLI used to slice it
      // The one structural decoding: status, form, items, error and named diagnostics.
      for (const key of ['depends', 'writes']) {
        const decoded = must.decodeDeclarationList(fm, key), expected = c.decoded[key];
        strict.deepStrictEqual([decoded.status, decoded.form, decoded.items, decoded.error, decoded.diagnostics],
          [expected.status, expected.form || null, expected.items === undefined ? null : expected.items, expected.error || null, expected.diagnostics],
          `${c.name} ${key}: structural decoder`);
      }
      // Ordinary execution arrays: parseExecutionFields.
      let fields;
      try { fields = must.parseExecutionFields(content); } catch (error) { fields = { thrown: error.message }; }
      if (want.ordinary.throws) strict.strictEqual(fields.thrown, want.ordinary.throws, `${c.name}: ordinary projection throws`);
      else {
        strict.strictEqual(fields.thrown, undefined, `${c.name}: ordinary projection`);
        for (const key of ['depends', 'writes']) {
          if (want.ordinary[key] === '<absent>') strict.strictEqual(Object.prototype.hasOwnProperty.call(fields, key), false, `${c.name} ${key}: ordinary keeps absent absent`);
          else strict.deepStrictEqual(fields[key], want.ordinary[key], `${c.name} ${key}: ordinary projection`);
        }
      }
      // The scheduling reader (values plus named diagnostics) and the list reader.
      strict.deepStrictEqual(parallel.parseTaskFrontmatter(planFiles[index]), want.schedule, `${c.name}: schedule projection`);
      for (const key of ['depends', 'writes']) {
        const expected = c.decoded[key], label = `${c.name} ${key}: parseListField`;
        if (expected.status === 'valid') strict.deepStrictEqual(parallel.parseListField(raw, key), expected.items, label);
        else if (expected.status === 'absent') strict.strictEqual(parallel.parseListField(raw, key), null, label);
        else {
          strict.throws(() => parallel.parseListField(raw, key),
            error => error.code === `plan-declaration-${key}-invalid` && error.detail === expected.diagnostics[0], label);
        }
      }
      // The controller time DAG reads depends only, through its temporal projection.
      const dag = dagOf(index);
      if (want.temporal.depends === null) {
        strict.deepStrictEqual([dag.status, dag.reasons], ['unknown', [`dependency-malformed:${c.task}`]], `${c.name}: temporal projection`);
      } else {
        strict.deepStrictEqual([dag.status, dag.reasons], ['valid', []], `${c.name}: time DAG`);
        strict.deepStrictEqual(dag.tasks.find(row => row.id === c.task).depends, want.temporal.depends, `${c.name}: temporal projection`);
      }
      // Public365 changed this reader. Check its current fixed projection and
      // keep every recorded52a base column historical, never rewritten as current.
      strict(want.code_dir && typeof want.code_dir === 'object', c.name + ': current CODE_DIR projection is explicit');
      if (want.code_dir.throws) strict.throws(() => codeDir.parseDeclaredPaths(content),
        error => error && error.message === want.code_dir.throws, c.name + ': CODE_DIR exact named refusal');
      else strict.deepStrictEqual(codeDir.parseDeclaredPaths(content), want.code_dir, c.name + ': current public365 CODE_DIR projection');
    });
  });
  console.log(`      ${READER_CASES.cases.length} reader cases: one structural decoding; ordinary, schedule, list and temporal projections each match their row`);
});

test('issue343 U0a-2 strict declarations: missing, scalar, duplicate or protected depends/writes are refused by name and never become []', () => {
  const strict = require('assert'), must = require('./forge-must-haves.js');
  const options = taskId => ({ taskId, requireExplicit: true });
  const plan = (lines, eol = '\n') => ['---', ...lines, '---', '# T07', ''].join(eol);
  const refuse = (content, code, label, taskId = 'T07') => {
    let projection;
    strict.throws(() => { projection = must.validateTaskDeclarations(content, options(taskId)); }, error => {
      strict.strictEqual(error.code, code, label);
      strict(error.message.startsWith(`${code}: `), `${label}: ${error.message}`);
      strict(Array.isArray(error.errors) && error.errors[0].code === code, `${label}: errors`);
      return true;
    }, label);
    strict.strictEqual(projection, undefined, `${label}: a refusal supplies no projection and no []`);
  };
  // Every reader case keeps exactly one strict verdict.
  for (const c of READER_CASES.cases) {
    if (c.projections.strict === 'valid') strict.strictEqual(must.validateTaskDeclarations(readerCasePlan(c), options(c.task)).task_id, c.task, c.name);
    else refuse(readerCasePlan(c), c.projections.strict, c.name, c.task);
  }
  // The projection: frozen declarations; the frontmatter id never names the task.
  const valid = must.validateTaskDeclarations(plan(['id: T-anything', 'depends: [T01, T03.1]', 'writes:', '  - src/a.js # main',
    '  - "primary::docs/b #1.md"', '  - root_id: primary', '    path: src/c.js']), options('T07'));
  strict.deepStrictEqual(Object.keys(valid), ['task_id', 'depends', 'writes', 'roots_schema', 'primary_root_id', 'declared_roots', 'declaration_sha256']);
  strict.deepStrictEqual([valid.task_id, valid.depends, valid.writes, valid.roots_schema, valid.primary_root_id, valid.declared_roots],
    ['T07', ['T01', 'T03.1'], ['src/a.js', 'primary::docs/b #1.md', { root_id: 'primary', path: 'src/c.js' }], null, null, null]);
  strict.match(valid.declaration_sha256, /^[a-f0-9]{64}$/);
  strict(Object.isFrozen(valid) && Object.isFrozen(valid.depends) && Object.isFrozen(valid.writes) && Object.isFrozen(valid.writes[2]), 'frozen projection');
  // The digest covers the declarations only: EOL, comments, quoting, prose and other keys never count.
  const same = must.validateTaskDeclarations(plan(['tier: standard', 'depends:', '  - T01', '  - T03.1 # decimal sub-task', 'writes:', '  # product files only',
    "  - 'src/a.js'", '  - "primary::docs/b #1.md"   # quoted hash', '  - root_id: primary', '    path: "src/c.js"'], '\r\n'), options('T07'));
  strict.strictEqual(same.declaration_sha256, valid.declaration_sha256, 'declaration digest is stable');
  const changed = must.validateTaskDeclarations(plan(['depends: [T01, T03.1]', 'writes: [src/a.js, "primary::docs/b #1.md", src/d.js]']), options('T07'));
  strict.notStrictEqual(changed.declaration_sha256, valid.declaration_sha256, 'a changed write changes the digest');
  // An explicit `writes: []` stays valid for scheduling; the shared plan() fixture (id T-roots) stays valid.
  strict.deepStrictEqual(must.validateTaskDeclarations(plan(['depends: []', 'writes: []']), options('T07')).writes, []);
  const contract = { primary_root_id: 'alpha', code_roots: [{ id: 'alpha', path: 'C:/fixture/a/same', vcs: 'git' }, { id: 'beta', path: 'C:/fixture/b/same', vcs: 'git' }] };
  const shared = must.validateTaskDeclarations(require('./forge-code-roots.test').plan(contract), options('T01'));
  strict.deepStrictEqual([shared.depends, shared.writes, shared.roots_schema, shared.primary_root_id, shared.declared_roots],
    [[], ['alpha::same.txt', 'beta::same.txt'], '2', 'alpha', [{ id: 'alpha', path: 'C:/fixture/a/same', vcs: 'git' }, { id: 'beta', path: 'C:/fixture/b/same', vcs: 'git' }]]);
  // Missing, scalar, empty-value, duplicate and malformed declarations are refused by name.
  refuse(plan(['writes: [src/a.js]']), 'plan-declaration-depends-missing', 'missing depends');
  refuse(plan(['depends: []']), 'plan-declaration-writes-missing', 'missing writes');
  refuse('# Plan without frontmatter\n', 'plan-declaration-depends-missing', 'no frontmatter');
  refuse(plan(['depends: T01', 'writes: [src/a.js]']), 'plan-declaration-depends-invalid', 'scalar depends');
  refuse(plan(['depends: []', 'writes: src/a.js']), 'plan-declaration-writes-invalid', 'scalar writes');
  refuse(plan(['depends:', 'writes: [src/a.js]']), 'plan-declaration-depends-invalid', 'empty depends value is YAML null');
  refuse(plan(['depends: []', 'writes:']), 'plan-declaration-writes-invalid', 'empty writes value is YAML null');
  refuse(plan(['depends: [T01]', 'writes: [src/a.js]', 'depends: []']), 'plan-declaration-depends-invalid', 'duplicate depends');
  refuse(plan(['depends: []', 'writes: [src/a.js]', 'writes: [src/b.js]']), 'plan-declaration-writes-invalid', 'duplicate writes');
  refuse(plan(['depends: [T01, T01]', 'writes: [src/a.js]']), 'plan-declaration-depends-invalid', 'repeated prerequisite');
  refuse(plan(['depends: [S01]', 'writes: [src/a.js]']), 'plan-declaration-depends-invalid', 'non-task prerequisite');
  // Schedule admission (U0a-r1): a structurally valid list with a blank gap is refused by name.
  refuse(plan(['depends:', '  - T01', '', '  - T03.1', 'writes: [src/a.js]']), 'plan-declaration-depends-blank-gap', 'interior blank line in depends');
  refuse(plan(['depends: []', 'writes:', '', '  - src/a.js']), 'plan-declaration-writes-blank-gap', 'leading blank line in writes');
  refuse(plan(['depends: []', 'writes: ["bad root::src/a.js"]']), 'plan-declaration-writes-invalid', 'malformed root qualifier');
  refuse(plan(['depends: []', 'writes:', '  - root_id: primary', '    path: src/a.js', '    vcs: git']), 'plan-declaration-writes-invalid', 'object beyond root_id/path');
  for (const value of ['/abs/x.js', 'C:/x.js', '../x.js', 'src/../../x.js']) {
    refuse(plan(['depends: []', 'writes:', `  - "${value}"`]), 'plan-declaration-writes-invalid', `non-relative write ${value}`);
  }
  // Protected product paths keep the #348 policy, in every declaration form.
  for (const value of ['.gsd/STATE.md', 'docs/.GSD/x.md', '.git/config', 'primary::.svn/entries', '.']) {
    refuse(plan(['depends: []', 'writes:', `  - "${value}"`]), 'plan-declaration-path-protected', `protected write ${value}`);
  }
  refuse(plan(['depends: []', 'writes:', '  - root_id: primary', '    path: .gsd/x.md']), 'plan-declaration-path-protected', 'protected object write');
  for (const taskId of ['T-roots', 'S01', '', null]) refuse(plan(['depends: []', 'writes: [src/a.js]']), 'plan-declaration-task-id-invalid', `task id ${taskId}`, taskId);
  // There is no bypass option.
  for (const bad of [undefined, { taskId: 'T07' }, { taskId: 'T07', requireExplicit: false }, { taskId: 'T07', requireExplicit: 'true' }]) {
    strict.throws(() => must.validateTaskDeclarations(plan(['depends: []', 'writes: [src/a.js]']), bad), TypeError);
  }
  // Historical readers are unchanged: the structured parser still admits a scalar depends.
  strict.doesNotThrow(() => parseMustHaves(mkPlan(`depends: T01\nwrites: [scripts/foo.js]\n${BASE_MUST_HAVES}`)));
  refuse(mkPlan(`depends: T01\nwrites: [scripts/foo.js]\n${BASE_MUST_HAVES}`), 'plan-declaration-depends-invalid', 'historical plan refused only by the new gate');
});

// A genuine decided time contract built through the canonical owner APIs — the chain of
// forge-unit-controller.test.js decidedRoot/conformantRoadmap: enrollment, the committed
// estimate, materialized options, two answered rounds, the attested decision, a conformant
// ROADMAP and its allocation. No selection source is stubbed. The helpers write owner plans,
// read the controller time DAG, run real begins and record genuine canonical completions
// (the committed begin/complete pair plus the verified historical delivery of the public builder).
function decidedTimeRoot() {
  const controller = require('./forge-unit-controller.js'), state = require('./forge-state.js'), lease = require('./forge-unit-lease.js');
  const timeSelection = require('./forge-milestone-time-selection.js'), milestoneTime = require('./forge-milestone-time.js');
  const pendingQuestions = require('./forge-pending-questions.js'), builder = require('./forge-delivery.js');
  const { digest } = require('./forge-code-roots.js');
  const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
  const TM = PROPOSALS.milestone, TNOW = Date.parse('2026-11-02T12:00:00.000Z');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-u0a-r1-lifecycle-'));
  const write = (relative, content) => {
    const file = path.join(cwd, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
  const at = (offset = 0) => ({ prefsReader, now: () => TNOW + offset });
  const expect = (condition, message) => { if (!condition) throw new Error(`decided time fixture: ${message}`); };
  try {
    for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(`.gsd/milestones/${TM}/${TM}-${k}.md`, `# ${k}\nEscopo sintético\n`);
    fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
    state.write(cwd, { milestone: TM, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
    expect(timeSelection.enroll(cwd, TM, { source: 'owner', now: TNOW - 3600000 }).status === 'enrolled', 'enrollment');
    const estimateKey = timeSelection.estimateBeginKey(TM, timeSelection.readSelectionState(cwd, TM).key_suffix), estimate = `estimate-milestone/${TM}`;
    const estimated = controller.begin(cwd, { milestone: TM, unit: estimate, host_runtime: 'codex', owner_token: 'estimate-owner', idempotency_key: estimateKey }, at(-1800000));
    controller.complete(cwd, { milestone: TM, unit: estimate, host_runtime: 'codex', owner_token: 'estimate-owner', generation: estimated.generation,
      idempotency_key: `${estimateKey}:complete`, result: { status: 'succeeded' } }, at(-1700000));
    write(`.gsd/milestones/${TM}/${TM}-OPTIONS.json`, JSON.stringify(PROPOSALS.base, null, 2));
    expect(timeSelection.prepareBoundary(cwd, TM, { now: TNOW - 600000 }).status === 'materialized', 'options materialized');
    for (const label of ['Escolher posição', 'Escopo completo (curta) (Recomendado)']) {
      const opened = timeSelection.nextRound({ cwd, milestone: TM });
      expect(opened.status === 'open', `round open: ${JSON.stringify(opened)}`);
      expect(timeSelection.answerRound({ cwd, milestone: TM, round: opened.question_id, response: label, source: 'user-text' }).status === 'answered', 'round answered');
    }
    const liveAdapter = { getDecisionHandle(request) {
      const read = pendingQuestions.continuation({ cwd, identity: request.question.identity_sha256 });
      const row = read.ok ? read.questions.find(q => q.id === request.question.id) : null;
      const record = { reference: 'fixture-' + request.question.id, status: 'resolved', answer: row && row.answer, source: 'user-text',
        resolved_at: new Date(TNOW - 1000).toISOString(), question: { ...request.question } };
      return milestoneTime.createDecisionAuthority(() => record).issue(record.reference, { milestone: request.milestone, kind: request.kind,
        request_sha256: digest(request.request), expires_at: TNOW + 60000 }, () => TNOW);
    } };
    const decided = timeSelection.decide({ cwd, milestone: TM, liveAdapter, now: TNOW, prefsReader });
    expect(decided.status === 'decided', `decision: ${JSON.stringify(decided)}`);
    const skeleton = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(timeSelection.promptBlock(cwd, TM))[1]);
    const allocation = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
      { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 1200000, nodes: ['N3'] },
      { id: 's4', kind: 'slice', slice: 'S04', ms: 1200000, nodes: ['N4'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
      { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
    write(`.gsd/milestones/${TM}/${TM}-ROADMAP.md`, `# ${TM}: Fixture — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato** \`risk:low\` \`depends:[]\`\n`
      + '- [ ] **S02: Seleção** `risk:low` `depends:[S01]`\n- [ ] **S03: Resumo** `risk:low` `depends:[]`\n- [ ] **S04: Relatório** `risk:low` `depends:[S02]`\n\n'
      + `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify({ ...skeleton, allocation }, null, 2)}\n\`\`\`\n`);
    expect(timeSelection.prepareBoundary(cwd, TM, { now: TNOW + 1000 }).status === 'allocated', 'allocation');
  } catch (error) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
  // Every slice task realizes its allocated node (S01 = N1) through the three binding scalars.
  const bindingLines = (node = 'N1') => {
    const selected = timeSelection.readSelectionState(cwd, TM);
    return `time_options_sha256: ${selected.options_sha256}\ntime_position_id: ${selected.position_id}\ntime_node: ${node}\n`;
  };
  const begin = (unit, key, slice, offset = 0) => controller.begin(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner',
    idempotency_key: key, state_patch: { active_slice: slice }, slice }, at(offset));
  const transactions = () => (fs.existsSync(controller.transactionDir(cwd)) ? fs.readdirSync(controller.transactionDir(cwd)).length : 0);
  return {
    bindingLines,
    begin,
    slicePlan: (slice, ids) => write(`.gsd/milestones/${TM}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n\n## Tasks\n${ids.map(id => `- [ ] **${id}: Trabalho**`).join('\n')}\n`),
    taskPlan: (slice, id, text) => write(`.gsd/milestones/${TM}/slices/${slice}/tasks/${id}/${id}-PLAN.md`, text),
    dag: slice => controller.discoverInventory(cwd, TM, state.read(cwd, TM), at()).slices.find(item => item.id === slice).task_dag,
    select: (offset = 0) => controller.select(cwd, { milestone: TM }, at(offset)),
    // A refused execute begin: exactly `code`, with no transaction, record or lease written.
    refused(unit, key, slice, code, offset = 0) {
      const before = transactions();
      let caught = null;
      try { begin(unit, key, slice, offset); } catch (error) { caught = error; }
      if (!caught || caught.code !== code) throw new Error(`${unit}/${key}: expected ${code}, got ${caught ? `${caught.code}: ${caught.message}` : 'an admitted begin'}`);
      if (controller.lookupRecord(cwd, 'transaction', key) !== null || transactions() !== before || lease.observe(cwd, unit).lease !== null) {
        throw new Error(`${unit}/${key}: the refused begin wrote a transaction, record or lease`);
      }
      return caught;
    },
    // Genuine canonical completion of one task: real begin and complete, then the verified delivery.
    complete(slice, task, offset) {
      const key = `dag-${slice}-${task}`, unit = `execute-task/${task}`;
      const begun = begin(unit, key, slice, offset);
      controller.complete(cwd, { milestone: TM, unit, host_runtime: 'codex', owner_token: 'explicit-owner', generation: begun.generation,
        idempotency_key: `${key}-finish-${task}`, result: { status: 'succeeded' } }, at(offset + 500));
      const unitRef = { type: 'task', id: task, slice, milestone: TM }, unitKey = builder.unitKey(unitRef);
      const base = `.gsd/milestones/${TM}/slices/${slice}/tasks/${task}`, rel = name => `${base}/${task}-${name}`, source = `src/${task}.js`;
      const planText = `---\nid: ${task}\ndepends: []\n${bindingLines()}writes:\n  - "${source}"\nmust_haves:\n  truths:\n    - "${task} comportamento observável"\n`
        + `    - "${task} segundo comportamento"\n  artifacts:\n    - path: "${source}"\n      provides: "${task} source"\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - "${source}"\n---\n# ${task}\n`;
      write(rel('PLAN.md'), planText);
      const context = { schema_version: 1, unit: unitRef, plan_fingerprint: builder.sha256(planText), code_dir: cwd, revision: 'abc123',
        workspace: [{ path: source, hash: 'b'.repeat(40) }], environment: 'node-test', captured_at: new Date(TNOW).toISOString() };
      const checks = [{ command: 'node check.js one', exitCode: 0 }, { command: 'node check.js two', exitCode: 0 }];
      write(rel('VERIFY-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'verification', result: { passed: true, checks } }));
      write(rel('ARTIFACT-ENVELOPE.json'), JSON.stringify({ ...context, kind: 'artifact', result: { passed: true, rows: [{ path: source, exists: true }] } }));
      const input = { schema_version: 1, unit: unitRef, plan: rel('PLAN.md'), plan_fingerprint: builder.sha256(planText), bindings: [
        { criterion_id: `${unitKey}:truth:0`, coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 0 } },
        { criterion_id: `${unitKey}:truth:1`, coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 1 } },
        { criterion_id: `${unitKey}:artifact:0`, coverage: 'structural', source: { kind: 'artifact', path: rel('ARTIFACT-ENVELOPE.json'), row_index: 0, property: 'exists' } }] };
      write(rel('DELIVERY-INPUT.json'), JSON.stringify(input));
      const built = builder.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd });
      expect(built.criteria.length === 3 && built.criteria.every(item => item.status === 'verificado'), `delivery of ${task}: ${JSON.stringify(built.diagnostics)}`);
      write(rel('DELIVERY.json'), JSON.stringify(built));
    },
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
}

test('issue343 U0a-r1-1 one structural decoder and fixed ordinary versus temporal consumer projections preserve blanks, bare-empty and malformed contracts', () => {
  const strict = require('assert'), must = require('./forge-must-haves.js'), parallel = require('./forge-parallelism.js');
  const plan = (lines, eol = '\n') => ['---', ...lines, '---', '# T07', ''].join(eol);
  const record = (lines, key) => must.decodeDeclarationList(must.extractFrontmatter(plan(lines)), key);
  const noLayout = { item_lines: [], comment_lines: [], inline_comment_lines: [], leading_blank_lines: [], interior_blank_lines: [] };
  // 1. The structural record: values, presence, layout lines and named diagnostics, identical under LF and CRLF.
  const layoutLines = ['depends: # predecessors', '', '  - T01 # first', '  # a comment line', '', "  - 'T02'", 'writes: [src/a.js] # one file'];
  for (const eol of ['\n', '\r\n']) {
    const fm = must.extractFrontmatter(plan(layoutLines, eol)), depends = must.decodeDeclarationList(fm, 'depends');
    strict.deepStrictEqual(depends, { key: 'depends', status: 'valid', form: 'block', items: ['T01', 'T02'], error: null, line: 1,
      diagnostics: ['declaration-leading-blank', 'declaration-interior-blank'],
      layout: { key_line: 1, item_lines: [3, 6], comment_lines: [4], inline_comment_lines: [1, 3], leading_blank_lines: [2], interior_blank_lines: [5] } },
    `depends record ${JSON.stringify(eol)}`);
    strict.deepStrictEqual(must.decodeDeclarationList(fm, 'writes'), { key: 'writes', status: 'valid', form: 'flow', items: ['src/a.js'], error: null, line: 7,
      diagnostics: [], layout: { ...noLayout, key_line: 7, item_lines: [7], inline_comment_lines: [7] } }, `writes record ${JSON.stringify(eol)}`);
    strict(Object.isFrozen(depends) && Object.isFrozen(depends.items) && Object.isFrozen(depends.diagnostics) && Object.isFrozen(depends.layout)
      && Object.isFrozen(depends.layout.item_lines), 'the record is deep-frozen');
  }
  // YAML null (bare or comment-only), absence and every malformed shape are recorded, never as a list.
  strict.deepStrictEqual(record(['depends:', 'writes: []'], 'depends'), { key: 'depends', status: 'empty', form: null, items: null, error: null, line: 1,
    diagnostics: ['declaration-empty-value'], layout: { ...noLayout, key_line: 1 } });
  strict.deepStrictEqual(record(['depends: # nothing yet', '  # - T01 commented out', 'writes: []'], 'depends'), { key: 'depends', status: 'empty', form: null,
    items: null, error: null, line: 1, diagnostics: ['declaration-empty-value'], layout: { ...noLayout, key_line: 1, inline_comment_lines: [1] } });
  strict.deepStrictEqual(record(['writes: []'], 'depends'), { key: 'depends', status: 'absent', form: null, items: null, error: null, line: null, diagnostics: [], layout: null });
  for (const [lines, error, line] of [[['depends: T01'], 'declaration-scalar', 1], [['depends: [T01]', 'depends: []'], 'execution-plan-duplicate-key', 2],
    [['depends:', '  - T01', '  T02'], 'declaration-block-malformed', 3], [['depends:', '- T01'], 'declaration-block-malformed', 2],
    [['depends: [T01]', '  - T02'], 'declaration-continuation', 2], [['depends: [T01,,T02]'], 'declaration-flow-malformed', 1],
    [['depends:', '  - ""'], 'declaration-item-malformed', 2]]) {
    strict.deepStrictEqual(record(lines, 'depends'), { key: 'depends', status: 'invalid', form: null, items: null, error, line, diagnostics: [error], layout: null },
      `${error}: ${lines.join(' | ')}`);
  }
  // 2. The fixed projections of the same bytes.
  const blank = ['depends:', '  - T01', '', '  - T02', 'writes:', '', '  - src/a.js', '', '  - src/b.js'];
  const blankPlan = plan(blank), emptyPlan = plan(['depends:', 'writes:']);
  // Ordinary execution arrays: complete lists pass with every item; YAML null stays present and is never an array.
  const ordinary = must.parseExecutionFields(blankPlan), nullish = must.parseExecutionFields(emptyPlan);
  strict.deepStrictEqual([ordinary.depends, ordinary.writes], [['T01', 'T02'], ['src/a.js', 'src/b.js']], 'ordinary: complete YAML lists with blank lines');
  strict.deepStrictEqual([Object.prototype.hasOwnProperty.call(nullish, 'depends'), nullish.depends, Object.prototype.hasOwnProperty.call(nullish, 'writes'), nullish.writes],
    [true, null, true, null], 'ordinary: bare-empty is present and never an array');
  // Schedule admission: named refusals from the decoded layout; the scheduling reader keeps the values and names each gap.
  strict.throws(() => must.validateTaskDeclarations(blankPlan, { taskId: 'T07', requireExplicit: true }), error => {
    strict.deepStrictEqual([error.code, error.detail, error.errors], ['plan-declaration-depends-blank-gap', 'declaration-interior-blank (frontmatter line 3)', [
      { code: 'plan-declaration-depends-blank-gap', detail: 'declaration-interior-blank (frontmatter line 3)' },
      { code: 'plan-declaration-writes-blank-gap', detail: 'declaration-leading-blank (frontmatter line 6)' }]]);
    return true;
  });
  strict.throws(() => must.validateTaskDeclarations(emptyPlan, { taskId: 'T07', requireExplicit: true }),
    error => error.code === 'plan-declaration-depends-invalid' && /^declaration-empty-value/.test(error.detail));
  const scheduleFile = path.join(ROOT, 'u0a-r1-1-T07-PLAN.md');
  fs.writeFileSync(scheduleFile, blankPlan);
  strict.deepStrictEqual(parallel.parseTaskFrontmatter(scheduleFile), { depends: ['T01', 'T02'], writes: ['src/a.js', 'src/b.js'],
    diagnostics: ['depends:declaration-interior-blank', 'writes:declaration-leading-blank', 'writes:declaration-interior-blank'] }, 'scheduling reader: blank gaps');
  fs.writeFileSync(scheduleFile, emptyPlan);
  strict.deepStrictEqual(parallel.parseTaskFrontmatter(scheduleFile), { depends: null, writes: null,
    diagnostics: ['depends:declaration-empty-value', 'writes:declaration-empty-value'] }, 'scheduling reader: YAML null is never []');
  // Temporal: the controller time DAG of the same bytes (its own readTaskPlan, dependsOf and taskDag).
  const temporal = [
    { name: 'blank-gap', frontmatter: blank, prerequisites: ['T01', 'T02'], ordinary: ['T01', 'T02'], temporal: ['unknown', ['dependency-malformed:T07']] },
    { name: 'leading-blank-crlf', eol: 'crlf', frontmatter: ['depends:', '', '  - T01', 'writes: [src/a.js]'], prerequisites: ['T01'], ordinary: ['T01'],
      temporal: ['unknown', ['dependency-malformed:T07']] },
    { name: 'bare-empty', frontmatter: ['depends:', 'writes: [src/a.js]'], prerequisites: [], ordinary: null, temporal: ['valid', []] },
    { name: 'key-line-comment-empty', frontmatter: ['depends: # none yet', 'writes: [src/a.js]'], prerequisites: [], ordinary: null, temporal: ['valid', []] },
    { name: 'comments', frontmatter: ['depends: # predecessors', '  - T01 # first', '  # a comment line', "  - 'T02'", 'writes: [src/a.js]'], prerequisites: ['T01', 'T02'],
      ordinary: ['T01', 'T02'], temporal: ['valid', ['T01', 'T02']] },
    { name: 'scalar', frontmatter: ['depends: T01', 'writes: [src/a.js]'], prerequisites: ['T01'], ordinary: null, temporal: ['unknown', ['dependency-malformed:T07']] },
    { name: 'flow-continuation', frontmatter: ['depends: [T01]', '  - T02', 'writes: [src/a.js]'], prerequisites: ['T01', 'T02'], ordinary: null,
      temporal: ['unknown', ['dependency-malformed:T07']] },
  ].map(c => ({ task: 'T07', eol: 'lf', ...c }));
  withReaderOwner(temporal, c => c.prerequisites, ({ dagOf }) => temporal.forEach((c, index) => {
    const dag = dagOf(index), read = dag.status === 'valid' ? dag.tasks.find(row => row.id === c.task).depends : dag.reasons;
    strict.deepStrictEqual([must.parseExecutionFields(readerCasePlan(c)).depends, [dag.status, read]], [c.ordinary, c.temporal], `${c.name}: ordinary versus temporal`);
  }));
  // 3. No public option selects a relaxed profile: extra arguments and imported JSON change nothing.
  const fm = must.extractFrontmatter(blankPlan);
  strict.strictEqual(must.decodeDeclarationList.length, 2, 'the decoder takes no options');
  strict.deepStrictEqual(must.decodeDeclarationList(fm, 'depends', { profile: 'ordinary', relaxed: true }), must.decodeDeclarationList(fm, 'depends'));
  strict.deepStrictEqual(must.parseExecutionFields(emptyPlan, { profile: 'temporal' }), must.parseExecutionFields(emptyPlan));
  for (const extra of [{ profile: 'ordinary' }, { relaxed: true }, { allowBlankGaps: true, legacy: true }, JSON.parse('{"profile":"relaxed","approved":true}')]) {
    strict.throws(() => must.validateTaskDeclarations(blankPlan, { taskId: 'T07', requireExplicit: true, ...extra }),
      error => error.code === 'plan-declaration-depends-blank-gap', `option ${JSON.stringify(extra)} relaxes nothing`);
  }
  strict.deepStrictEqual([parallel.parseTaskFrontmatter.length, parallel.parseListField.length], [1, 2], 'the scheduling readers take no options');
  for (const name of [...Object.keys(must), ...Object.keys(parallel)]) strict(!/profile|relax|projection|lenient/i.test(name), `no exported projection selector: ${name}`);
  // Explicit scheduling `writes: []` stays valid; YAML null never stands in for it.
  strict.deepStrictEqual(must.validateTaskDeclarations(plan(['depends: []', 'writes: []']), { taskId: 'T07', requireExplicit: true }).writes, []);
  console.log('      one structural record; ordinary, temporal and schedule projections keep blanks, bare-empty and malformed contracts; no option relaxes them');
});

test('issue343 U0a-r1-2 quote-aware inline and whole-line comments retain T02 and T03 through real lifecycle admission until every predecessor completes', () => {
  const strict = require('assert'), must = require('./forge-must-haves.js'), parallel = require('./forge-parallelism.js');
  const life = decidedTimeRoot();
  try {
    // S01 lists T04 first; T04 waits on T02 and T03, and all three realize the allocated node N1.
    life.slicePlan('S01', ['T04', 'T02', 'T03']);
    for (const id of ['T02', 'T03']) life.taskPlan('S01', id, `---\nid: ${id}\ndepends: []\n${life.bindingLines()}---\n# ${id}\n`);
    const layouts = [
      ['whole-line and inline comments', ['depends:', '  # T02 delivers the shared reader first', '  - T02 # first predecessor',
        '# a column-zero comment between the predecessors', '  - "T03" # quoted, then a comment'], '\n'],
      ['flow list with a trailing comment', ["depends: [T02, 'T03'] # both predecessors, then T04"], '\n'],
      ['key-line comment and a commented-out entry, CRLF', ['depends: # predecessors below', "  - 'T02'", '  # - T01 is not a predecessor', '  - T03 # last'], '\r\n'],
    ];
    const writeT04 = ([, lines, eol]) => life.taskPlan('S01', 'T04',
      ['---', 'id: T04', ...lines, 'writes: [docs/T04.md]', ...life.bindingLines().trimEnd().split('\n'), '---', '# T04', ''].join(eol));
    const expectPending = (pending, stage) => layouts.forEach((layout, index) => {
      const file = writeT04(layout), text = fs.readFileSync(file, 'utf8'), label = `${layout[0]} (${stage})`;
      // Both comment-aware projections and strict admission keep both predecessors.
      strict.deepStrictEqual(must.parseExecutionFields(text).depends, ['T02', 'T03'], `${label}: ordinary projection`);
      strict.deepStrictEqual(parallel.parseTaskFrontmatter(file), { depends: ['T02', 'T03'], writes: ['docs/T04.md'], diagnostics: [] }, `${label}: scheduling reader`);
      strict.deepStrictEqual(must.validateTaskDeclarations(text, { taskId: 'T04', requireExplicit: true }).depends, ['T02', 'T03'], `${label}: strict admission`);
      const dag = life.dag('S01');
      strict.deepStrictEqual([dag.status, dag.tasks.find(row => row.id === 'T04').depends], ['valid', ['T02', 'T03']], `${label}: temporal projection`);
      // The real guard refuses the execute begin while a predecessor lacks canonical proof, with zero writes.
      const refusal = life.refused('execute-task/T04', `T04-${stage}-${index}`, 'S01', 'time-task-dependency-pending');
      strict.deepStrictEqual(refusal.details.task_dag.pending, pending, `${label}: pending predecessors`);
    });
    expectPending(['T02', 'T03'], 'none-complete');
    strict.strictEqual(life.select().unit.key, 'execute-task/T02', 'next passes over T04 to a ready predecessor');
    life.complete('S01', 'T02', 3000);
    expectPending(['T03'], 'T02-complete');
    life.complete('S01', 'T03', 4000);
    // Both predecessors now carry their committed completion and verified delivery: T04 is admitted.
    for (const layout of layouts) {
      writeT04(layout);
      const dag = life.dag('S01');
      strict.deepStrictEqual(dag.tasks.map(row => [row.id, row.depends, row.completion]),
        [['T04', ['T02', 'T03'], 'unproven'], ['T02', [], 'proven'], ['T03', [], 'proven']], `${layout[0]}: proven predecessors`);
    }
    strict.strictEqual(life.select(6000).unit.key, 'execute-task/T04', 'next admits T04 once both predecessors are proven');
    strict.strictEqual(life.begin('execute-task/T04', 'T04-admitted', 'S01', 6000).ok, true, 'execute begin after every predecessor completed');
    console.log('      three comment layouts keep T02 and T03 through ordinary, schedule, strict and temporal readers; T04 begins only after both complete');
  } finally {
    life.cleanup();
  }
});

test('issue343 U0a-r1-4 original temporal leading and interior blank-gap negatives remain intact while ordinary complete YAML blank lists pass', () => {
  const strict = require('assert'), must = require('./forge-must-haves.js'), parallel = require('./forge-parallelism.js');
  // The exact pre-campaign negatives of forge-unit-controller.test.js (S02 guard R57), still asserted there unchanged.
  const negatives = [['blank inside block', 'depends:\n  - T10\n\n  - T11\n', ['T10', 'T11'], 'depends:declaration-interior-blank'],
    ['leading blank before block', 'depends:\n\n  - T10\n', ['T10'], 'depends:declaration-leading-blank']];
  const suite = fs.readFileSync(path.join(__dirname, 'forge-unit-controller.test.js'), 'utf8');
  for (const [label, text] of negatives) {
    strict(suite.includes(`['${label}', '${text.replace(/\n/g, '\\n')}']`), `${label}: the original controller negative is unchanged`);
  }
  strict(suite.includes("[false, 'time-task-dependency-unknown'], `next ${label}`"), 'the original negatives still assert the unknown refusal');
  const life = decidedTimeRoot();
  try {
    life.slicePlan('S01', ['T08', 'T10', 'T11']);
    for (const id of ['T10', 'T11']) life.taskPlan('S01', id, `---\nid: ${id}\ndepends: []\n${life.bindingLines()}---\n# ${id}\n`);
    for (const [label, text, items, diagnostic] of negatives) {
      const file = life.taskPlan('S01', 'T08', `---\nid: T08\n${text}${life.bindingLines()}---\n# T08\n`), content = fs.readFileSync(file, 'utf8');
      // Temporal: refused before admission with the named malformed reason (T10 and T11 are real tasks here).
      const dag = life.dag('S01');
      strict.deepStrictEqual([dag.status, dag.reasons], ['unknown', ['dependency-malformed:T08']], `${label}: temporal projection`);
      const next = life.select();
      strict.deepStrictEqual([next.ok, next.reason], [false, 'time-task-dependency-unknown'], `${label}: next`);
      life.refused('execute-task/T08', `T08-${label.replace(/ /g, '-')}`, 'S01', 'time-task-dependency-unknown');
      // Ordinary: the same complete YAML list is an array with every item; schedule admission names the gap.
      strict.deepStrictEqual(must.parseExecutionFields(content).depends, items, `${label}: ordinary projection`);
      const table = parallel.parseTaskFrontmatter(file);
      strict.deepStrictEqual([table.depends, table.diagnostics], [items, [diagnostic]], `${label}: scheduling reader`);
      strict.throws(() => must.validateTaskDeclarations(content, { taskId: 'T08', requireExplicit: true }),
        error => error.code === 'plan-declaration-depends-blank-gap', `${label}: strict admission`);
    }
    // Control: the same predecessors without a gap pass the temporal projection and still wait for proof.
    life.taskPlan('S01', 'T08', `---\nid: T08\ndepends:\n  - T10\n  - T11\n${life.bindingLines()}---\n# T08\n`);
    strict.deepStrictEqual(life.dag('S01').tasks.find(row => row.id === 'T08').depends, ['T10', 'T11'], 'control: no gap');
    life.refused('execute-task/T08', 'T08-control-pending', 'S01', 'time-task-dependency-pending');
  } finally {
    life.cleanup();
  }
  // Ordinary execution-array admission through a real gate: forge-code-roots validatePlan over two
  // measured Git roots accepts a writes list with a leading blank, an interior blank and a comment line.
  const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots'), f = lab.fixture();
  try {
    const original = lab.plan(f.contract);
    const gapped = original.replace("writes:\n  - 'alpha::same.txt'\n  - 'beta::same.txt'\n",
      "writes:\n\n  - 'alpha::same.txt'\n\n  # the second root\n  - 'beta::same.txt'\n");
    strict.notStrictEqual(gapped, original, 'the writes list gained blank and comment lines');
    strict.deepStrictEqual(roots.validatePlan(gapped, f.contract).writes, [{ root_id: 'alpha', path: 'same.txt' }, { root_id: 'beta', path: 'same.txt' }],
      'ordinary execution-array admission');
    strict.throws(() => must.validateTaskDeclarations(gapped, { taskId: 'T01', requireExplicit: true }), error => error.code === 'plan-declaration-writes-blank-gap');
  } finally {
    f.cleanup();
  }
  console.log('      the R57 blank-gap negatives keep refusing through the real temporal guard; ordinary admission accepts complete blank lists');
});

// ─────────────────────────────────────────────────────────────
// Cleanup and summary
// ─────────────────────────────────────────────────────────────
test('root-qualified artifacts and execution fields preserve all criteria', () => {
  const strict = require('assert'), lab = require('./forge-code-roots.test'), f = lab.fixture();
  const text = lab.plan(f.contract), parsed = require('./forge-must-haves').parseExecutionFields(text);
  strict.deepStrictEqual(parsed.expected_output, ['alpha::same.txt', 'beta::same.txt']);
  strict.strictEqual(parseMustHaves(text).artifacts[1].path, 'beta::same.txt');
  strict.throws(() => require('./forge-code-roots').validatePlan(text.replace('  artifacts:', 'artifacts:'), f.contract));
  f.cleanup();
});
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
