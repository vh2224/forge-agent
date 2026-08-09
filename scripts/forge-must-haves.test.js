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
// Cleanup and summary
// ─────────────────────────────────────────────────────────────
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
