#!/usr/bin/env node
// forge-runs.test.js — regression suite for the runs registry, focused on the
// isStale helper (S04-Obj4 review-fix) and cleanupStale's use of it.
//
// Run: node scripts/forge-runs.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const runs = require('./forge-runs.js');

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

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runs-test-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

// ── isStale ───────────────────────────────────────────────────────────────────
test('isStale: just under the threshold is NOT stale', () => {
  const now = 1000000;
  const threshold = 100;
  const rec = { last_heartbeat: now - threshold + 1 };
  assert(runs.isStale(rec, threshold, now) === false, 'just under threshold must not be stale');
});

test('isStale: exactly at the threshold is NOT stale (strict >)', () => {
  const now = 1000000;
  const threshold = 100;
  const rec = { last_heartbeat: now - threshold };
  assert(runs.isStale(rec, threshold, now) === false, 'exactly at threshold must not be stale (strict > comparison)');
});

test('isStale: just over the threshold IS stale', () => {
  const now = 1000000;
  const threshold = 100;
  const rec = { last_heartbeat: now - threshold - 1 };
  assert(runs.isStale(rec, threshold, now) === true, 'just over threshold must be stale');
});

test('isStale: missing last_heartbeat falls back to worker_started', () => {
  const now = 1000000;
  const threshold = 100;
  const rec = { worker_started: now - threshold - 1 };
  assert(runs.isStale(rec, threshold, now) === true, 'must fall back to worker_started when last_heartbeat absent');
});

test('isStale: missing last_heartbeat and worker_started falls back to started_at', () => {
  const now = 1000000;
  const threshold = 100;
  const rec = { started_at: now - threshold - 1 };
  assert(runs.isStale(rec, threshold, now) === true, 'must fall back to started_at when the others are absent');
});

test('isStale: no timestamps at all -> treated as maximally stale', () => {
  const now = 1000000;
  const threshold = 100;
  assert(runs.isStale({}, threshold, now) === true, 'a record with zero liveness signal must be stale');
  assert(runs.isStale(null, threshold, now) === true, 'a null record must be stale');
});

test('isStale: defaults threshold to STALE_THRESHOLD_MS when omitted', () => {
  const now = Date.now();
  const rec = { last_heartbeat: now - runs.STALE_THRESHOLD_MS - 1 };
  assert(runs.isStale(rec, undefined, now) === true, 'default threshold must be STALE_THRESHOLD_MS');
});

test('isStale: defaults now to Date.now() when omitted (wall-clock smoke check)', () => {
  const rec = { last_heartbeat: Date.now() };
  assert(runs.isStale(rec, 1000) === false, 'a just-created record must not be stale under a real clock');
});

// ── cleanupStale regression (must still use the shared isStale definition) ──
test('cleanupStale: removes only records whose last_heartbeat exceeds the threshold', () => {
  const cwd = mkTmp();
  try {
    const now = Date.now();
    runs.add(cwd, { id: 'M-fresh', kind: 'milestone', session_id: 's1', last_heartbeat: now });
    runs.add(cwd, { id: 'M-stale', kind: 'milestone', session_id: 's2', last_heartbeat: now - 60 * 60 * 1000 });
    const removed = runs.cleanupStale(cwd, 30 * 60 * 1000);
    assert(removed.length === 1 && removed[0] === 'M-stale', `expected only M-stale removed, got ${JSON.stringify(removed)}`);
    assert(runs.get(cwd, 'M-fresh') !== null, 'fresh record must survive cleanup');
    assert(runs.get(cwd, 'M-stale') === null, 'stale record must be removed');
  } finally {
    rmrf(cwd);
  }
});

test('cleanupStale: default threshold is STALE_THRESHOLD_MS', () => {
  const cwd = mkTmp();
  try {
    const now = Date.now();
    runs.add(cwd, { id: 'M-borderline', kind: 'milestone', session_id: 's3', last_heartbeat: now - runs.STALE_THRESHOLD_MS - 1000 });
    const removed = runs.cleanupStale(cwd);
    assert(removed.includes('M-borderline'), 'default threshold must match STALE_THRESHOLD_MS');
  } finally {
    rmrf(cwd);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
