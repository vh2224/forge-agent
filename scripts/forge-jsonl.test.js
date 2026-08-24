#!/usr/bin/env node
'use strict';

// Contract tests for forge-jsonl.js. Run with:
//   node scripts/forge-jsonl.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJsonl } = require('./forge-jsonl.js');

let passed = 0;
let failed = 0;

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

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jsonl-test-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const rec1 = JSON.stringify({ event: 'dispatch', unit: 'execute-task/T01' });
const rec2 = JSON.stringify({ event: 'dispatch', unit: 'execute-task/T02' });

process.stdout.write('\n=== forge-jsonl.js — contract tests ===\n\n');

// ── The six measured-during-discuss entries (CONTEXT.md table) ─────────────

test('CRLF: both lines parse (2 registros)', () => {
  const file = tmpFile(rec1 + '\r\n' + rec2 + '\r\n');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 2);
});

test('lone CR (no \\n): both lines parse — widened from the tokens.js baseline of 0', () => {
  const file = tmpFile(rec1 + '\r' + rec2 + '\r');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 2);
});

test('leading BOM: both lines parse — fixes the dashboard.js baseline of 1', () => {
  const file = tmpFile('﻿' + rec1 + '\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 2);
  assert.strictEqual(result.lines[0].unit, 'execute-task/T01');
});

test('truncated tail (last line is partial JSON, no trailing newline): 1 parses, 1 malformed', () => {
  const file = tmpFile(rec1 + '\n{"event":"dispatch","unit":"execute-task');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 1);
  assert.strictEqual(result.skipped_malformed, 1);
});

test('blank lines interleaved: parsed lines skip the blanks, counted', () => {
  const file = tmpFile(rec1 + '\n\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 2);
  assert.strictEqual(result.skipped_empty, 1);
});

test('indented / whitespace-padded line still parses', () => {
  const file = tmpFile('  ' + rec1 + '\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 2);
});

// ── maxLines: slices RAW lines, before parsing ──────────────────────────────

test('maxLines:3 over 5 records + 1 blank + 1 malformed (tail) yields 1 entry', () => {
  const records = [];
  for (let i = 0; i < 5; i++) records.push(JSON.stringify({ event: 'dispatch', unit: `execute-task/T0${i}` }));
  const raw = records.join('\n') + '\n\n{"broken';
  const file = tmpFile(raw);
  const result = readJsonl(file, { maxLines: 3 });
  // Raw lines in order: rec0..rec4, '', '{"broken' (7 total). slice(-3) keeps
  // [rec4, '', '{"broken'] — 1 parses (rec4), 1 blank, 1 malformed.
  assert.strictEqual(result.lines.length, 1);
  assert.strictEqual(result.truncated_tail, true);
  // `total` is scoped to the scanned window (post-maxLines slice: 3), not the
  // 7 raw lines in the file — and the additive invariant holds within it.
  assert.strictEqual(result.total, 3);
  assert.strictEqual(
    result.lines.length + result.skipped_empty + result.skipped_malformed,
    result.total
  );
});

test('maxLines larger than the file: no truncation, all valid lines parse', () => {
  const file = tmpFile(rec1 + '\n' + rec2 + '\n');
  const result = readJsonl(file, { maxLines: 50 });
  assert.strictEqual(result.lines.length, 2);
  assert.strictEqual(result.truncated_tail, false);
});

test('maxLines omitted: reads everything (default contract preserved)', () => {
  const records = [];
  for (let i = 0; i < 10; i++) records.push(JSON.stringify({ event: 'dispatch', unit: `execute-task/T${i}` }));
  const file = tmpFile(records.join('\n') + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.lines.length, 10);
  assert.strictEqual(result.truncated_tail, false);
});

// ── Census fields, each proven to bite (a counter that never fires is a dead
// gate) ──────────────────────────────────────────────────────────────────

test('census on a mixed fixture: total, skipped_empty, skipped_malformed all correct', () => {
  // 2 valid + 1 blank + 1 malformed = 4 raw lines.
  const file = tmpFile(rec1 + '\n\n{"broken\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.total, 4);
  assert.strictEqual(result.lines.length, 2);
  assert.strictEqual(result.skipped_empty, 1);
  assert.strictEqual(result.skipped_malformed, 1);
  // Additive invariant: every raw line is accounted for exactly once.
  assert.strictEqual(result.lines.length + result.skipped_empty + result.skipped_malformed, result.total);
});

test('census bites: skipped_empty is 0 with no blank lines (not vacuously non-zero)', () => {
  const file = tmpFile(rec1 + '\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.skipped_empty, 0);
});

test('census bites: skipped_malformed is 0 with no malformed lines', () => {
  const file = tmpFile(rec1 + '\n' + rec2 + '\n');
  const result = readJsonl(file);
  assert.strictEqual(result.skipped_malformed, 0);
});

test('census bites: truncated_tail is false when maxLines is not exceeded', () => {
  const file = tmpFile(rec1 + '\n');
  const result = readJsonl(file, { maxLines: 10 });
  assert.strictEqual(result.truncated_tail, false);
});

// ── Missing / unreadable input never throws ─────────────────────────────────

test('missing file: empty result, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jsonl-test-'));
  const missing = path.join(dir, 'does-not-exist.jsonl');
  const result = readJsonl(missing);
  assert.deepStrictEqual(result, { lines: [], total: 0, skipped_empty: 0, skipped_malformed: 0, truncated_tail: false });
});

test('directory instead of a file: empty result, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jsonl-test-'));
  const result = readJsonl(dir);
  assert.deepStrictEqual(result, { lines: [], total: 0, skipped_empty: 0, skipped_malformed: 0, truncated_tail: false });
});

test('empty file: empty result', () => {
  const file = tmpFile('');
  const result = readJsonl(file);
  assert.deepStrictEqual(result, { lines: [], total: 0, skipped_empty: 0, skipped_malformed: 0, truncated_tail: false });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
