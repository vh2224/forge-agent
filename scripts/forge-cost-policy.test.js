#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseNumstat,
  collectDiff,
  decideReview,
  decideMemory,
  failOpenOnDiffError,
  planReviewShards,
  CHALLENGER_MAX_DIFF_LINES,
} = require('./forge-cost-policy.js');

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

const file = (name, added = 10, deleted = 0) => ({ file: name, added, deleted, binary: false });

test('parseNumstat handles text and binary rows', () => {
  assert.deepStrictEqual(parseNumstat('12\t3\tsrc/a.js\n-\t-\tassets/a.png\n'), [
    { file: 'src/a.js', added: 12, deleted: 3, binary: false },
    { file: 'assets/a.png', added: 0, deleted: 0, binary: true },
  ]);
});

test('collectDiff includes untracked files without shell evaluation', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cost-policy-'));
  try {
    assert.strictEqual(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    assert.strictEqual(spawnSync('git', [
      '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'init',
    ], { cwd }).status, 0);
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'export const value = 1;\n');
    const result = collectDiff(cwd, 'HEAD');
    assert.strictEqual(result.ok, true);
    assert(result.entries.some((entry) => entry.file === 'src/new.js' && entry.added > 0));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('collectDiff counts untracked files when the workspace root is a symlink', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cost-policy-link-'));
  const linked = `${cwd}-link`;
  try {
    assert.strictEqual(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    assert.strictEqual(spawnSync('git', [
      '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'init',
    ], { cwd }).status, 0);
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'export const linked = true;\n');
    try {
      fs.symlinkSync(fs.realpathSync.native(cwd), linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      // Some locked-down Windows environments cannot create directory links.
      process.stdout.write(`  - workspace symlink test skipped: ${error.code || error.message}\n`);
      return;
    }
    const result = collectDiff(linked, 'HEAD');
    assert.strictEqual(result.ok, true);
    assert(result.entries.some((entry) => entry.file === 'src/new.js' && entry.added > 0));
    assert(!String(result.warning || '').includes('untracked-realpath-escaped:src/new.js'));
  } finally {
    fs.rmSync(linked, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('collectDiff rejects option-like bases and caps large untracked reads', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cost-policy-large-'));
  try {
    assert.strictEqual(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    assert.strictEqual(spawnSync('git', [
      '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid',
      'commit', '--allow-empty', '-q', '-m', 'init',
    ], { cwd }).status, 0);
    const large = path.join(cwd, 'large.bin');
    const fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, (8 * 1024 * 1024) + 1);
    fs.closeSync(fd);
    const result = collectDiff(cwd, '--output=/tmp/unsafe');
    assert.strictEqual(result.base, 'HEAD');
    assert(result.entries.some((entry) => entry.file === 'large.bin' && entry.binary));
    assert.match(result.warning, /untracked-scan-capped/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('disabled review always skips', () => {
  const result = decideReview({ review: { mode: 'disabled' }, entries: [file('src/a.js')] });
  assert.strictEqual(result.decision, 'skip');
  assert.strictEqual(result.reason, 'review-disabled');
});

test('adaptive docs-only diff skips all model calls', () => {
  const result = decideReview({ review: {}, entries: [file('docs/guide.md', 200)] });
  assert.strictEqual(result.decision, 'skip');
  assert.strictEqual(result.estimated_calls, 0);
  assert.strictEqual(result.docs_only, true);
});

test('adaptive ordinary code uses one-pass flags', () => {
  const result = decideReview({ review: { rounds: 2 }, entries: [file('src/a.js', 60, 10)] });
  assert.strictEqual(result.decision, 'flags');
  assert.strictEqual(result.estimated_calls, 1);
  assert.strictEqual(result.saved_calls_vs_dialectic, 3);
});

test('adaptive high-risk code reserves the dialectic', () => {
  const result = decideReview({ review: { rounds: 1 }, entries: [file('src/a.js')], risk: 'high' });
  assert.strictEqual(result.decision, 'dialectic');
  assert(result.risk_signals.includes('risk:high'));
  assert.strictEqual(result.estimated_calls, 3);
});

test('risk signals take precedence over the docs-only cost shortcut', () => {
  const result = decideReview({ review: {}, entries: [file('docs/security.md')] });
  assert.strictEqual(result.docs_only, true);
  assert.strictEqual(result.decision, 'dialectic');
  assert(result.risk_signals.includes('sensitive-path'));
});

test('binary or deliberately unscanned changes reserve the dialectic', () => {
  const result = decideReview({
    review: {},
    entries: [{ file: 'assets/archive.dat', added: 0, deleted: 0, binary: true }],
  });
  assert.strictEqual(result.decision, 'dialectic');
  assert(result.risk_signals.includes('binary-or-unscanned-change'));
});

test('adaptive sensitive paths reserve the dialectic', () => {
  const result = decideReview({ review: {}, entries: [file('src/auth/session.js')] });
  assert.strictEqual(result.decision, 'dialectic');
  assert(result.sensitive_files.includes('src/auth/session.js'));
});

test('configured flags caps adaptive escalation at one pass', () => {
  const result = decideReview({
    review: { style: 'flags' },
    entries: [file('src/security/keys.js', 900)],
    risk: 'high',
    securityPresent: true,
  });
  assert.strictEqual(result.decision, 'flags');
  assert.strictEqual(result.reason, 'configured-flags');
});

test('always trigger preserves legacy configured style', () => {
  const result = decideReview({ review: { trigger: 'always', style: 'dialectic' }, entries: [file('README.md')] });
  assert.strictEqual(result.decision, 'dialectic');
  assert.strictEqual(result.reason, 'configured-always');
});

test('diff probe failure fails open instead of suppressing review', () => {
  const empty = decideReview({ review: {}, entries: [] });
  const adaptive = failOpenOnDiffError(empty, {}, false);
  assert.strictEqual(adaptive.decision, 'flags');
  assert.strictEqual(adaptive.reason, 'diff-unavailable-fail-open');

  const always = failOpenOnDiffError(
    decideReview({ review: { trigger: 'always', style: 'dialectic' }, entries: [] }),
    { trigger: 'always', style: 'dialectic', rounds: 2 },
    false,
  );
  assert.strictEqual(always.decision, 'dialectic');
  assert.strictEqual(always.estimated_calls, 4);
});

test('adaptive memory skips planning artifacts already persisted on disk', () => {
  const result = decideMemory({ memory: {}, unitType: 'plan-slice', result: 'status: done' });
  assert.strictEqual(result.decision, 'skip');
  assert.match(result.reason, /artifact-owned/);
});

test('adaptive memory extracts execute-task durable signals', () => {
  const result = decideMemory({ memory: {}, unitType: 'execute-task', result: 'key decision: reuse the shared parser pattern' });
  assert.strictEqual(result.decision, 'extract');
  assert.strictEqual(result.reason, 'adaptive-durable-signal');
});

test('boundary summaries always receive adaptive memory extraction', () => {
  const result = decideMemory({ memory: {}, unitType: 'complete-slice', result: '' });
  assert.strictEqual(result.decision, 'extract');
});

test('memory always/disabled knobs are authoritative', () => {
  assert.strictEqual(decideMemory({ memory: { extraction: 'always' }, unitType: 'plan-slice' }).decision, 'extract');
  assert.strictEqual(decideMemory({ memory: { extraction: 'disabled' }, unitType: 'complete-milestone' }).decision, 'skip');
});

// A challenger handed a whole large diff dies on context and returns no verdict,
// which downstream is indistinguishable from "found nothing". Sharding by file
// bounds each read.
const many = (n, lines) => Array.from({ length: n }, (_, i) => file(`src/f${i}.ts`, lines, 0));

test('a small diff is not split — one challenger, today\'s behavior', () => {
  const shards = planReviewShards(many(5, 100));
  assert.strictEqual(shards.length, 1);
  assert.strictEqual(shards[0].files.length, 5);
});

test('an empty diff yields no shards at all', () => {
  assert.deepStrictEqual(planReviewShards([]), []);
});

test('a large diff splits and every file lands in exactly one shard', () => {
  const shards = planReviewShards(many(20, 400));
  assert.ok(shards.length > 1 && shards.length <= 6, `shard count ${shards.length}`);
  const placed = shards.flatMap((s) => s.files);
  assert.strictEqual(placed.length, 20, 'no file dropped or duplicated');
  assert.strictEqual(new Set(placed).size, 20);
  assert.ok(shards.every((s) => s.files.length > 0), 'no empty dispatch');
});

test('the shard cap holds even on a huge diff', () => {
  assert.ok(planReviewShards(many(500, 900)).length <= 6);
});

test('splitting is deterministic, so a resumed review re-derives it', () => {
  assert.deepStrictEqual(planReviewShards(many(20, 400)), planReviewShards(many(20, 400)));
});

test('one oversized file stays whole — never half a function', () => {
  const shards = planReviewShards([file('src/huge.ts', 50000, 0)]);
  assert.strictEqual(shards.length, 1);
  assert.deepStrictEqual(shards[0].files, ['src/huge.ts']);
});

// #485: the shard cap can pack more lines into one shard than the external
// challenger accepts; such a shard is refused before any provider call, so the
// policy must say so instead of handing the caller a dispatch that cannot succeed.
test('a shard above the challenger diff limit is marked oversized', () => {
  const single = planReviewShards([file('src/huge.ts', 50000, 0)]);
  assert.strictEqual(single[0].oversized, true);
  assert.strictEqual(single[0].max_lines, CHALLENGER_MAX_DIFF_LINES);
  const packed = planReviewShards(many(500, 900));
  assert.ok(packed.some((s) => s.lines > CHALLENGER_MAX_DIFF_LINES), 'fixture must exceed the limit');
  for (const shard of packed) {
    assert.strictEqual(shard.oversized === true, shard.lines > CHALLENGER_MAX_DIFF_LINES, `shard ${shard.lines}`);
  }
});

test('shards within the challenger limit carry no oversized marker', () => {
  for (const shard of planReviewShards(many(20, 400))) {
    assert.ok(!('oversized' in shard) && !('max_lines' in shard));
  }
});

test('the oversized limit matches the challenger adapter refusal', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-xllm.js'), 'utf8');
  const m = src.match(/const MAX_DIFF_LINES = (\d+);/);
  assert.ok(m, 'forge-xllm.js MAX_DIFF_LINES not found');
  assert.strictEqual(Number(m[1]), CHALLENGER_MAX_DIFF_LINES);
});

test('a binary file is charged a line so it cannot look free', () => {
  const shards = planReviewShards([{ file: 'a.png', added: 0, deleted: 0, binary: true }]);
  assert.strictEqual(shards[0].lines, 1);
});

test('decideReview carries the shards, and skip computes none', () => {
  const run = decideReview({ review: { trigger: 'always' }, entries: many(20, 400) });
  assert.ok(run.shards.length > 1);
  const skipped = decideReview({ review: { mode: 'disabled' }, entries: [file('src/a.js')] });
  assert.strictEqual(skipped.decision, 'skip');
  assert.deepStrictEqual(skipped.shards, []);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
