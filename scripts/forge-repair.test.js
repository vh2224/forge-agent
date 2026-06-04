#!/usr/bin/env node
// forge-repair.test.js — Standalone test suite for forge-repair.js
//
// Usage: node scripts/forge-repair.test.js
// Exit 0 if all tests pass, exit 1 on first failure.
//
// Tests:
//  - classifyRepair: retry, decompose, prune, blocked branches
//  - classifyRepair: critical severity → always blocked (suppression)
//  - classifyRepair: context_overflow failure_shape → always blocked
//  - classifyRepair: disabled > weak priority in retry reason
//  - reinjectDiff: basic planned − delivered
//  - reinjectDiff: prune-exclusion (prunedIds not in dropped)
//  - reinjectDiff: cap > 10 → capped:true, max 10 items
//  - reinjectDiff: degradation with no verification → empty dropped
//  - reinjectDiff: mustHavesStatus fallback (no verification file)

'use strict';

const path = require('path');
const { classifyRepair, reinjectDiff, isLargeTask, readRepairCount, incrementRepairCount } = require('./forge-repair');
const os = require('os');
const fs = require('fs');

// ── Test helpers ──────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (!condition) {
    process.stderr.write(`FAIL: ${label}\n`);
    failCount++;
    process.exit(1);
  }
  process.stdout.write(`pass: ${label}\n`);
  passCount++;
}

function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    process.stderr.write(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`);
    failCount++;
    process.exit(1);
  }
  process.stdout.write(`pass: ${label}\n`);
  passCount++;
}

// ── classifyRepair tests ──────────────────────────────────────────────────────

// 1. critical severity → blocked (S03 suppression), even when decompose signals present
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'critical',
    worker_explained: null,
    signals: {
      missing_artifacts: 5,
      substantive_false: 3,
      wired_false: 2,
      symbol_missing: 4,
      test_quality: { disabled: 2, weak: 1 },
      is_large_task: true,
    },
  });
  assertEqual(result.strategy, 'blocked', 'critical severity → strategy:blocked');
  assert(result.reason.includes('context critical'), 'critical severity → reason mentions context critical');
}

// 2. context_overflow failure_shape → blocked (not a verification-signal failure)
{
  const result = classifyRepair({
    failure_shape: 'context_overflow',
    severity: 'normal',
    worker_explained: null,
    signals: {
      missing_artifacts: 0,
      substantive_false: 0,
      wired_false: 0,
      symbol_missing: 0,
      test_quality: { disabled: 0, weak: 0 },
      is_large_task: false,
    },
  });
  assertEqual(result.strategy, 'blocked', 'context_overflow → strategy:blocked');
  assert(result.reason.includes('Layer 2'), 'context_overflow → reason mentions Layer 2');
}

// 3. worker_explained=impossible → prune
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'normal',
    worker_explained: 'impossible',
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: false },
  });
  assertEqual(result.strategy, 'prune', 'worker_explained=impossible → prune');
}

// 4. worker_explained=contradictory → prune
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'normal',
    worker_explained: 'contradictory',
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: false },
  });
  assertEqual(result.strategy, 'prune', 'worker_explained=contradictory → prune');
}

// 5. critical + impossible → still blocked (critical wins over prune)
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'critical',
    worker_explained: 'impossible',
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: false },
  });
  assertEqual(result.strategy, 'blocked', 'critical wins over worker_explained=impossible');
}

// 6. large task + missing_artifacts >= 2 → decompose
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 2, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: true },
  });
  assertEqual(result.strategy, 'decompose', 'large task + missing_artifacts>=2 → decompose');
}

// 7. large task + substantive_false >= 2 → decompose
{
  const result = classifyRepair({
    failure_shape: 'substantive-check',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 2, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: true },
  });
  assertEqual(result.strategy, 'decompose', 'large task + substantive_false>=2 → decompose');
}

// 8. large task + symbol_missing >= 2 → decompose
{
  const result = classifyRepair({
    failure_shape: 'symbol-check',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 2, test_quality: {}, is_large_task: true },
  });
  assertEqual(result.strategy, 'decompose', 'large task + symbol_missing>=2 → decompose');
}

// 9. NOT large task + missing_artifacts>=2 → falls through to retry if other signals present
{
  const result = classifyRepair({
    failure_shape: 'missing-artifact',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 2, substantive_false: 1, wired_false: 0, symbol_missing: 0, test_quality: {}, is_large_task: false },
  });
  assertEqual(result.strategy, 'retry', 'not large_task + missing_artifacts >= 2 → retry (not decompose)');
}

// 10. wired_false >= 1 → retry
{
  const result = classifyRepair({
    failure_shape: 'wired-check',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 1, symbol_missing: 0, test_quality: {}, is_large_task: false },
  });
  assertEqual(result.strategy, 'retry', 'wired_false>=1 → retry');
}

// 11. test_quality.disabled >= 1 → retry, reason mentions disabled
{
  const result = classifyRepair({
    failure_shape: 'test-quality',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: { disabled: 1, weak: 0 }, is_large_task: false },
  });
  assertEqual(result.strategy, 'retry', 'disabled test → retry');
  assert(result.reason.includes('disabled'), 'disabled test → reason mentions disabled');
}

// 12. disabled > weak priority — disabled present → reason prefers disabled over weak
{
  const result = classifyRepair({
    failure_shape: 'test-quality',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: { disabled: 1, weak: 2 }, is_large_task: false },
  });
  assertEqual(result.strategy, 'retry', 'disabled+weak → retry');
  assert(result.reason.includes('disabled'), 'disabled+weak → disabled takes priority in reason');
}

// 13. no signals → blocked (fallback)
{
  const result = classifyRepair({
    failure_shape: 'unknown',
    severity: 'normal',
    worker_explained: null,
    signals: { missing_artifacts: 0, substantive_false: 0, wired_false: 0, symbol_missing: 0, test_quality: { disabled: 0, weak: 0 }, is_large_task: false },
  });
  assertEqual(result.strategy, 'blocked', 'no signals → blocked fallback');
}

// 14. invalid input → blocked
{
  const result = classifyRepair(null);
  assertEqual(result.strategy, 'blocked', 'null input → blocked');
}

// ── reinjectDiff tests ────────────────────────────────────────────────────────

// Build minimal plan content with structured must_haves
const PLAN_CONTENT = `---
id: T01
slice: S01
milestone: M-test
title: "Test"
must_haves:
  truths:
    - "feature A works"
  artifacts:
    - path: scripts/a.js
      provides: "A"
      min_lines: 10
    - path: scripts/b.js
      provides: "B"
      min_lines: 10
    - path: scripts/c.js
      provides: "C"
      min_lines: 10
  key_links: []
expected_output:
  - scripts/a.js
  - scripts/b.js
  - scripts/c.js
---

# T01
`;

// Build verification content where only a.js and b.js are substantive
const VERIFICATION_CONTENT = `---
id: S01-VERIFICATION
slice: S01
milestone: M-test
generated_at: 2026-01-01T00:00:00Z
duration_ms: 100
verifier_version: "v1.1"
legacy_count: 0
malformed_count: 0
---

# S01: Goal-backward Verification

## Artifact Audit

| Source | Artifact | Exists | Substantive | Wired | Flags |
|--------|----------|--------|-------------|-------|-------|
| T01 | scripts/a.js | ✓ | ✓ | ✓ | — |
| T01 | scripts/b.js | ✓ | ✓ | — | — |
| T01 | scripts/c.js | ✓ | ✗ | — | — |
`;

// 15. basic diff: planned=[a,b,c], delivered=[a,b] → dropped=[c]
{
  const { dropped, capped } = reinjectDiff({
    planContent: PLAN_CONTENT,
    verificationContent: VERIFICATION_CONTENT,
    prunedIds: [],
  });
  assert(dropped.includes('scripts/c.js'), 'basic diff: c.js not delivered → in dropped');
  assert(!dropped.includes('scripts/a.js'), 'basic diff: a.js delivered → not in dropped');
  assert(!dropped.includes('scripts/b.js'), 'basic diff: b.js delivered → not in dropped');
  assertEqual(capped, false, 'basic diff: not capped');
}

// 16. prune-exclusion: c.js pruned → not in dropped
{
  const { dropped } = reinjectDiff({
    planContent: PLAN_CONTENT,
    verificationContent: VERIFICATION_CONTENT,
    prunedIds: ['scripts/c.js'],
  });
  assert(!dropped.includes('scripts/c.js'), 'prune-exclusion: pruned id not in dropped');
}

// 17. cap > 10 → capped:true, at most 10 items
{
  // Build a plan with 12 artifacts
  const buildLargePlan = () => {
    const artifacts = Array.from({ length: 12 }, (_, i) => [
      `    - path: scripts/file${i}.js`,
      `      provides: "file${i}"`,
      `      min_lines: 5`,
    ].join('\n')).join('\n');
    const expectedOutput = Array.from({ length: 12 }, (_, i) => `  - scripts/file${i}.js`).join('\n');
    return `---
id: T99
slice: S99
milestone: M-test
title: "Large"
must_haves:
  truths:
    - "works"
  artifacts:
${artifacts}
  key_links: []
expected_output:
${expectedOutput}
---

# T99
`;
  };

  const { dropped, capped } = reinjectDiff({
    planContent: buildLargePlan(),
    verificationContent: '', // nothing delivered
    prunedIds: [],
    mustHavesStatus: {
      satisfied: [],
      dropped: Array.from({ length: 12 }, (_, i) => `scripts/file${i}.js`),
    },
  });
  // mustHavesStatus fallback is used when verificationContent is empty
  assertEqual(capped, true, 'cap > 10 → capped:true');
  assert(dropped.length <= 10, 'cap > 10 → max 10 items in dropped');
}

// 18. no verification + no mustHavesStatus → {dropped:[], capped:false}
{
  const { dropped, capped } = reinjectDiff({
    planContent: PLAN_CONTENT,
    verificationContent: '',
    prunedIds: [],
  });
  assertEqual(dropped, [], 'no verification → empty dropped');
  assertEqual(capped, false, 'no verification → capped:false');
}

// 19. mustHavesStatus fallback with pruned items excluded
{
  const { dropped } = reinjectDiff({
    planContent: PLAN_CONTENT,
    verificationContent: '',
    prunedIds: ['scripts/c.js'],
    mustHavesStatus: {
      satisfied: ['scripts/a.js'],
      dropped: ['scripts/b.js', 'scripts/c.js'],
    },
  });
  assert(dropped.includes('scripts/b.js'), 'mustHavesStatus fallback: b.js in dropped');
  assert(!dropped.includes('scripts/c.js'), 'mustHavesStatus fallback: pruned c.js excluded');
}

// ── Review fixes (S04: R3, R5, R6, R9) ─────────────────────────────────────────

// R5: malformed must_haves → error field present (parse error ≠ empty diff)
{
  const badPlan = `---\nmust_haves:\n  truths: not-an-array\n---\n# X`;
  const r = reinjectDiff({ planContent: badPlan, verificationContent: VERIFICATION_CONTENT, prunedIds: [] });
  assert(typeof r.error === 'string' && r.error.length > 0, 'R5: parse failure surfaces error field');
  assertEqual(r.dropped.length, 0, 'R5: dropped empty on parse failure');
}

// R3: verification table with drifted headers → error (not silent empty)
{
  const drifted = `| Origem | Arquivo | Existe | OK |\n| T01 | scripts/a.js | sim | sim |`;
  const r = reinjectDiff({ planContent: PLAN_CONTENT, verificationContent: drifted, prunedIds: [] });
  assert(typeof r.error === 'string' && r.error.includes('format drift'), 'R3: header drift surfaces error');
}

// R3: header-indexed parsing survives a column INSERTED before Substantive
{
  const reordered = [
    '| Source | Artifact | Exists | Notes | Substantive | Wired |',
    '|--------|----------|--------|-------|-------------|-------|',
    '| T01 | scripts/a.js | ✓ | extra | ✓ | ✓ |',
    '| T01 | scripts/b.js | ✓ | extra | ✗ | ✓ |',
  ].join('\n');
  const r = reinjectDiff({ planContent: PLAN_CONTENT, verificationContent: reordered, prunedIds: [] });
  assert(!r.dropped.includes('scripts/a.js'), 'R3: a.js substantive ✓ found via header index');
  assert(r.dropped.includes('scripts/b.js'), 'R3: b.js ✗ → dropped');
}

// R6: isLargeTask — explicit frontmatter wins
{
  assertEqual(isLargeTask('---\nlarge_task: true\n---\n# small plan'), true, 'R6: explicit large_task true');
  assertEqual(isLargeTask('---\nlarge_task: false\n---\n' + '1. a\n'.repeat(20)), false, 'R6: explicit false beats heuristic');
}

// R6: isLargeTask — heuristics (steps > 5; small plan false)
{
  const manySteps = '---\nid: T01\n---\n## Steps\n' + Array.from({length: 7}, (_, i) => `${i + 1}. passo ${i + 1}`).join('\n');
  assertEqual(isLargeTask(manySteps), true, 'R6: >5 numbered steps → large');
  assertEqual(isLargeTask('---\nid: T01\n---\n## Steps\n1. unico passo'), false, 'R6: small plan → not large');
}

// R9: readRepairCount default 0 + incrementRepairCount persists on disk
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-repair-test-'));
  const planPath = path.join(tmp, 'T01-PLAN.md');
  fs.writeFileSync(planPath, '---\nid: T01\n---\n# Plano');

  assertEqual(readRepairCount(fs.readFileSync(planPath, 'utf-8')), 0, 'R9: default repair_count 0');
  assertEqual(incrementRepairCount(planPath), 1, 'R9: first increment → 1');
  assertEqual(incrementRepairCount(planPath), 2, 'R9: second increment → 2');
  assertEqual(readRepairCount(fs.readFileSync(planPath, 'utf-8')), 2, 'R9: persisted on disk');

  let threw = false;
  const noFm = path.join(tmp, 'NOFM.md');
  fs.writeFileSync(noFm, '# sem frontmatter');
  try { incrementRepairCount(noFm); } catch (e) { threw = true; }
  assert(threw, 'R9: missing frontmatter throws (never silent no-op)');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passCount} tests passed, ${failCount} failed.\n`);
if (failCount > 0) process.exit(1);
process.exit(0);
