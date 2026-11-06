#!/usr/bin/env node
'use strict';

// Contract tests for forge-tokens.js CLI. Run with:
//   node scripts/forge-tokens.test.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-tokens.js');
const { truncateAtSectionBoundary } = require('./forge-tokens.js');
let passed = 0;
let failed = 0;

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: input === undefined ? '' : input,
  });
}

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
  }
}

process.stdout.write('\n=== forge-tokens.js — contract tests ===\n\n');

test('aggregate orders estimate-milestone before plan-milestone and preserves other phase totals', () => {
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tokens-estimate-'));
  try {
    fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
    const phases = ['execute-task', 'plan-milestone', 'estimate-milestone', 'unknown-phase'];
    const rows = phases.map((phase, i) => ({ event: 'dispatch', unit: `${phase}/M001`, milestone: 'M001',
      dispatch_id: `estimate-${i}`, input_tokens: i + 1, output_tokens: 2, ts: '2026-11-01T00:00:00Z' }));
    fs.writeFileSync(path.join(dir, '.gsd', 'forge', 'events.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
    const aggregate = require('./forge-tokens').aggregate(dir, { milestoneId: 'M001' });
    assert.deepStrictEqual(Object.keys(aggregate.by_phase), ['estimate-milestone', 'plan-milestone', 'execute-task', 'unknown-phase']);
    phases.forEach((phase, i) => assert.deepStrictEqual(aggregate.by_phase[phase], { count: 1, input: i + 1, output: 2 }));
    assert.strictEqual(aggregate.total_input, 10);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--inline emits the raw integer only', () => {
  const res = run(['--inline', 'abcde']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '2\n');
  assert.strictEqual(res.stderr, '');
});

test('--inline preserves multiline, unicode and shell metacharacters as data', () => {
  const text = 'linha 1\ná $(echo nope) "quoted" & | ;';
  const res = run(['--inline', text]);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, `${Math.ceil(text.length / 4)}\n`);
  assert.strictEqual(res.stderr, '');
});

test('--inline accepts an empty string and returns zero', () => {
  const res = run(['--inline', '']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '0\n');
});

test('--inline treats help-looking text as data', () => {
  const res = run(['--inline', '--help']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '2\n');
  assert.strictEqual(res.stderr, '');
});

test('--inline without a value exits 2', () => {
  const res = run(['--inline']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--inline requires exactly one text argument/);
  assert.strictEqual(res.stdout, '');
});

test('--inline cannot be combined with another argument', () => {
  const res = run(['--inline', 'abc', '--mandatory']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /cannot be combined/);
  assert.strictEqual(res.stdout, '');
});

test('--scalar reads arbitrary text from stdin and emits the raw integer', () => {
  const text = 'resultado\ncom unicode á e $(metacaracteres)';
  const res = run(['--scalar'], text);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, `${Math.ceil(text.length / 4)}\n`);
  assert.strictEqual(res.stderr, '');
});

test('--scalar cannot be combined with another flag', () => {
  const res = run(['--scalar', '--mandatory'], 'abc');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /cannot be combined/);
  assert.strictEqual(res.stdout, '');
});

test('unknown arguments fail instead of silently counting empty stdin', () => {
  const res = run(['--unknown']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /unknown argument/);
  assert.strictEqual(res.stdout, '');
});

test('--file without a path exits 2', () => {
  const res = run(['--file']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--file requires a path argument/);
  assert.strictEqual(res.stdout, '');
});

test('stdin mode retains the structured JSON contract', () => {
  const res = run([], 'hello world');
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(JSON.parse(res.stdout), {
    tokens: 3,
    chars: 11,
    method: 'heuristic',
  });
});

// ── truncateAtSectionBoundary(content, budgetChars, opts) — marker + budget ceiling ──

function multiSectionContent(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `## Section ${i}\ncontent for section ${i} with some padding text here\n`;
  }
  return out;
}

test('with opts.source, marker names the source pointer', () => {
  const content = multiSectionContent(20);
  const result = truncateAtSectionBoundary(content, 200, { source: '.gsd/CODING-STANDARDS.md § Lint' });
  assert.match(result, /\[\.\.\.truncated \d+ sections — see \.gsd\/CODING-STANDARDS\.md § Lint\]$/);
});

test('without opts.source, marker is byte-identical to the historical format', () => {
  const content = multiSectionContent(20);
  const result = truncateAtSectionBoundary(content, 200);
  assert.match(result, /\n\n\[\.\.\.truncated \d+ sections\]$/);
  // The exact literal string the self-test and legacy prefix-based callers depend on.
  const droppedMatch = result.match(/\[\.\.\.truncated (\d+) sections\]$/);
  assert.ok(droppedMatch, 'marker must match legacy literal shape');
});

test('result never exceeds budgetChars across a sweep of small budgets, with and without source', () => {
  const content = multiSectionContent(30);
  const budgets = [10, 20, 40, 80];
  const sources = [undefined, '.gsd/CODING-STANDARDS.md § Somewhat Long Section Name'];
  for (const budgetChars of budgets) {
    for (const source of sources) {
      const opts = source !== undefined ? { source } : undefined;
      const result = truncateAtSectionBoundary(content, budgetChars, opts);
      assert.ok(
        result.length <= budgetChars,
        `budget=${budgetChars} source=${source}: result.length=${result.length} exceeds budgetChars`
      );
    }
  }
});

test('an absurdly long opts.source never blows the budget', () => {
  const content = multiSectionContent(10);
  const absurdSource = 'x'.repeat(5000);
  const result = truncateAtSectionBoundary(content, 100, { source: absurdSource });
  assert.ok(result.length <= 100, `result.length=${result.length} exceeds budget 100`);
});

test('opts.mandatory still throws with the same message, before any marker calculation', () => {
  assert.throws(
    () => truncateAtSectionBoundary('x'.repeat(1000), 100, { mandatory: true, label: 'test-label' }),
    /Context budget exceeded for mandatory section test-label/
  );
});

test('opts.mandatory throws even when opts.source is also present', () => {
  assert.throws(
    () => truncateAtSectionBoundary('x'.repeat(1000), 100, { mandatory: true, label: 'test-label', source: 'foo.md' }),
    /Context budget exceeded for mandatory section test-label/
  );
});

test('content that fits returns verbatim, unaffected by opts.source', () => {
  const content = 'short content that fits easily';
  const result = truncateAtSectionBoundary(content, 1000, { source: 'irrelevant.md' });
  assert.strictEqual(result, content);
});

test('fallback mid-content branch (zero boundaries) also respects opts.source and the budget ceiling', () => {
  const content = 'a'.repeat(500); // no "## " boundaries at all -> fallback branch
  const result = truncateAtSectionBoundary(content, 60, { source: 'fallback-source.md' });
  assert.ok(result.length <= 60, `result.length=${result.length} exceeds budget 60`);
  assert.match(result, /\[\.\.\.truncated 1 sections/);
});

// R3 (review-fix S01): a budget smaller than the shortest marker must degrade to
// the silent ellipsis. Slicing the marker produced `[...tru` — an unterminated
// fragment that violates the `[...truncated ` prefix contract in
// shared/forge-dispatch.md § Truncation markers.
test('tiny budgets never emit a partial truncation marker (with and without opts.source)', () => {
  const withBoundaries = '## A\n' + 'a'.repeat(200) + '\n## B\n' + 'b'.repeat(200);
  const noBoundaries = 'a'.repeat(500);
  for (const content of [withBoundaries, noBoundaries]) {
    for (const opts of [{}, { source: 'some/long/source/path.md' }]) {
      for (let budget = 0; budget <= 28; budget++) {
        const result = truncateAtSectionBoundary(content, budget, opts);
        assert.ok(result.length <= budget, `budget=${budget} exceeded: got ${result.length}`);
        const idx = result.indexOf('[...tru');
        if (idx !== -1) {
          assert.ok(
            /\[\.\.\.truncated \d+ sections( — see [^\]]*)?\]/.test(result),
            `budget=${budget} source=${!!opts.source} emitted an unterminated marker: ${JSON.stringify(result)}`
          );
        } else {
          assert.ok(
            result === '' || result === '…',
            `budget=${budget} should degrade to '' or '…', got ${JSON.stringify(result)}`
          );
        }
      }
    }
  }
});

test('budget 0 yields the empty string, budget 1 yields the ellipsis', () => {
  const content = 'a'.repeat(500);
  assert.strictEqual(truncateAtSectionBoundary(content, 0, {}), '');
  assert.strictEqual(truncateAtSectionBoundary(content, 1, { source: 'x.md' }), '…');
});


// R2 (review-triage): the greedy section pass must reserve for the marker regime
// that is actually emitted. Reserving for a long source-bearing marker cost whole
// sections that fit — and could force the mid-content fallback for nothing.
test('a long opts.source no longer costs whole sections', () => {
  const SECTION_LEN = 50;
  const N = 10;
  let content = '';
  for (let i = 0; i < N; i++) {
    const head = '## S' + i + '\n';
    content += head + 'x'.repeat(SECTION_LEN - head.length - 1) + '\n';
  }
  const BUDGET = 400;
  const longSource = '.gsd/milestones/M-20260101000000-a-rather-long-milestone-id/slices/S01/' + 'p'.repeat(130) + '.md';
  assert.ok(longSource.length > 150);

  const countSections = (t) => (t.match(/^## S/gm) || []).length;

  const withSource = truncateAtSectionBoundary(content, BUDGET, { source: longSource });
  const noSource = truncateAtSectionBoundary(content, BUDGET, {});

  // Invariant: never exceed the budget.
  assert.ok(withSource.length <= BUDGET, `exceeded budget: ${withSource.length}`);

  // The emitted marker regime is the source-less one here, so the retained
  // section count must match the no-source call exactly.
  assert.strictEqual(countSections(withSource), countSections(noSource));

  // Strictly better than reserving for the source-bearing marker (old behaviour).
  const oldReserve = ('\n\n[...truncated ' + N + ' sections — see ' + longSource + ']').length;
  let running = 0;
  let oldKept = 0;
  for (let i = 0; i < N; i++) {
    if (running + SECTION_LEN + oldReserve > BUDGET && oldKept > 0) break;
    running += SECTION_LEN;
    oldKept++;
    if (running >= BUDGET) break;
  }
  assert.ok(countSections(withSource) > oldKept,
    `expected more than ${oldKept} retained sections, got ${countSections(withSource)}`);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
