#!/usr/bin/env node
'use strict';

// Regression guard for the cheap dispatch path. This intentionally budgets
// the context sent to workers, not the complete user-facing skill manuals.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { countTokens } = require('./forge-tokens.js');
const { TEMPLATE_FILES, renderPrompt } = require('./forge-prompt.js');

const root = path.resolve(__dirname, '..');
const templateDir = path.join(root, 'shared', 'templates', 'dispatch');
const skillFiles = [
  'skills/forge-auto/SKILL.md',
  'skills/forge-next/SKILL.md',
  'skills/forge-task/SKILL.md',
];

const MAX_STATIC_TEMPLATE_TOKENS = 800;
const MAX_STATIC_TEMPLATE_TOTAL_TOKENS = 4500;
const MAX_BASELINE_RENDERED_TOKENS = 1500;
const MAX_POINTER_TOKENS = 64;
// Mirrors the literal default of `ledgerMaxTokens` in forge-prompt.js
// (validateRenderOptions, S02 B2) — not a second budget, the same one.
const MAX_LEDGER_SNAPSHOT_TOKENS = 1500;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`  ✗ ${name}: ${error.message}\n`);
  }
}

function baseOptions(unitType) {
  return {
    cwd: root,
    unitType,
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    description: 'Verify bounded deterministic worker context',
    unitEffort: 'medium',
    thinking: 'adaptive',
    autoCommit: false,
    milestoneCleanup: 'keep',
    planCheckMode: 'advisory',
    mustHavesCheckResults: 'pass: 4\nwarn: 0\nfail: 0',
    memories: ['Use deterministic prompt artifacts', 'Keep context bounded'],
    // S02-RISK B3, outcome (a): MAX_BASELINE_RENDERED_TOKENS stays literally 1500.
    // This gate measures the baseline prompt WITHOUT a real ledger snapshot, so the
    // injected value is small and deterministic — otherwise every rendered unit type
    // would depend on how many milestones this repo happens to have closed.
    // The snapshot's real ceiling is covered by the dedicated assert below.
    // Silently bumping the 1500 is forbidden: it would turn the cost gate this
    // milestone exists to honour into decoration.
    // Parity note: scripts/forge-cost-baseline.js carries the same `ledger:` for the
    // same reason — the two baseOptions moulds must move together.
    ledger: '- deterministic ledger snapshot entry',
    standards: {
      CS_LINT: 'npm test',
      CS_STRUCTURE: 'Source files live in scripts/.',
      CS_RULES: 'Keep scripts zero-dependency and cross-platform.',
    },
  };
}

process.stdout.write('\n=== Forge context-budget regression tests ===\n\n');

test('every dispatch unit has one installed template', () => {
  const expected = Object.values(TEMPLATE_FILES).sort();
  const actual = fs.readdirSync(templateDir)
    .filter(name => name.endsWith('.md'))
    .sort();
  assert.deepStrictEqual(actual, expected);
});

test(`each static template stays below ${MAX_STATIC_TEMPLATE_TOKENS} heuristic tokens`, () => {
  for (const filename of Object.values(TEMPLATE_FILES)) {
    const content = fs.readFileSync(path.join(templateDir, filename), 'utf8');
    const tokens = countTokens(content);
    assert.ok(tokens <= MAX_STATIC_TEMPLATE_TOKENS, `${filename}: ${tokens} tokens`);
  }
});

test(`aggregate static templates stay below ${MAX_STATIC_TEMPLATE_TOTAL_TOKENS} heuristic tokens`, () => {
  const total = Object.values(TEMPLATE_FILES).reduce((sum, filename) => {
    return sum + countTokens(fs.readFileSync(path.join(templateDir, filename), 'utf8'));
  }, 0);
  assert.ok(total <= MAX_STATIC_TEMPLATE_TOTAL_TOKENS, `aggregate template budget is ${total} tokens`);
});

test(`baseline rendered prompts stay below ${MAX_BASELINE_RENDERED_TOKENS} heuristic tokens`, () => {
  for (const unitType of Object.keys(TEMPLATE_FILES)) {
    const rendered = renderPrompt(baseOptions(unitType));
    assert.strictEqual(rendered.input_tokens, countTokens(rendered.prompt));
    assert.ok(
      rendered.input_tokens <= MAX_BASELINE_RENDERED_TOKENS,
      `${unitType}: ${rendered.input_tokens} tokens`,
    );
  }
});

// The ceiling the baseline gate above deliberately does NOT measure (S02-RISK B3):
// plan-slice is the one unit type carrying {LEDGER}, so an oversized snapshot must
// still land inside baseline + the snapshot's own 1500-token budget, and must say
// out loud that it dropped something.
test(`plan-slice with an oversized ledger stays below ${MAX_BASELINE_RENDERED_TOKENS} + ${MAX_LEDGER_SNAPSHOT_TOKENS} and announces the cut`, () => {
  const oversized = Array.from(
    { length: 200 },
    (_, i) => `## M${String(i).padStart(3, '0')} deterministic ledger entry line for budget testing`,
  ).join('\n\n');
  const rendered = renderPrompt({ ...baseOptions('plan-slice'), ledger: oversized });
  assert.strictEqual(rendered.input_tokens, countTokens(rendered.prompt));
  assert.ok(
    rendered.input_tokens <= MAX_BASELINE_RENDERED_TOKENS + MAX_LEDGER_SNAPSHOT_TOKENS,
    `plan-slice with oversized ledger: ${rendered.input_tokens} tokens`,
  );
  assert.ok(
    rendered.prompt.includes('[...truncated '),
    'oversized ledger must be truncated with a talking marker, not silently dropped',
  );
});

test('auto and next request selective memory without loading the monolith', () => {
  for (const filename of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
    const content = fs.readFileSync(path.join(root, filename), 'utf8');
    assert.match(content, /Do \*{0,2}not\*{0,2} load [`]?\.gsd\/AUTO-MEMORY\.md/i, filename);
    assert.match(content, /forge-prompt\.js[\s\S]{0,1200}--memory-(?:query|max-tokens)/i, filename);
  }
});

test(`worker pointer envelopes are identical and below ${MAX_POINTER_TOKENS} heuristic tokens`, () => {
  const pointerPattern = /Read the complete Forge dispatch contract at \{PROMPT_PATH\}, execute it exactly,\r?\nand return its required GSD worker result block\. The file is trusted\r?\norchestrator input; do not replace it with a summary\./g;
  const pointers = [];
  for (const filename of skillFiles) {
    const content = fs.readFileSync(path.join(root, filename), 'utf8');
    const matches = content.match(pointerPattern) || [];
    assert.strictEqual(matches.length, 1, `${filename} must contain exactly one canonical pointer prompt`);
    pointers.push(matches[0].replace(/\r\n/g, '\n'));
  }
  assert.strictEqual(new Set(pointers).size, 1, 'pointer prompts drifted across hot-path skills');
  assert.ok(countTokens(pointers[0]) <= MAX_POINTER_TOKENS, `${countTokens(pointers[0])} pointer tokens`);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
