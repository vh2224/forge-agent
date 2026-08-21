#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractFormalTelemetry, observe, checkpointCrossing, render, pathsFor } = require('./forge-context-codex');
const { DEFAULT_THRESHOLDS } = require('./forge-context-monitor');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-codex-'));
try {
  assert.deepStrictEqual(extractFormalTelemetry({ method: 'turn/completed', params: {} }), { capability: false });
  assert.deepStrictEqual(extractFormalTelemetry({ params: { context_window: { used_percentage: 0 } } }), { capability: true, used_percentage: 0 });

  let snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'turn/completed', params: {} }, now: 1000 });
  assert.strictEqual(snapshot.measurement, 'unknown');
  assert.strictEqual(snapshot.compaction_measurement, 'unknown');
  assert.strictEqual(render(snapshot), 'ctx ?');

  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'thread/started', params: { epoch: 1, context_window: { used_percentage: 0 } } }, now: 2000 });
  assert.strictEqual(snapshot.measurement, 'measured');
  assert.strictEqual(snapshot.used_percentage, 0);
  assert.strictEqual(snapshot.compaction_count, 0);
  assert.match(render(snapshot), /compact x0/);

  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'thread/compacted', params: { epoch: 1, cycle_id: 'c1' } }, now: 3000 });
  assert.strictEqual(snapshot.compaction_count, 1);
  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'thread/compacted', params: { epoch: 1, cycle_id: 'c1' } }, now: 4000 });
  assert.strictEqual(snapshot.compaction_count, 1, 'replay must be idempotent');
  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'thread/compacted', params: { epoch: 1, cycle_id: 'c2' } }, now: 5000 });
  assert.strictEqual(snapshot.compaction_count, 2);
  assert(fs.existsSync(pathsFor(cwd, 'thread/../one').state), 'sanitized durable state must exist');

  const measured = observe({ cwd, session_id: 'thread/../one', notification: { method: 'turn/completed', params: { epoch: 1, context_window: { used_percentage: 62 } } }, now: 6000 });
  assert.strictEqual(checkpointCrossing({ cwd, snapshot: measured, thresholds: DEFAULT_THRESHOLDS, now: 6000 }).checkpoint, true);
  assert.strictEqual(checkpointCrossing({ cwd, snapshot: measured, thresholds: DEFAULT_THRESHOLDS, now: 6000 }).checkpoint, false);
  const nextEpoch = { ...measured, epoch: '2', timestamp: 7000 };
  assert.strictEqual(checkpointCrossing({ cwd, snapshot: nextEpoch, thresholds: DEFAULT_THRESHOLDS, now: 7000 }).checkpoint, true);

  const other = observe({ cwd, session_id: 'other', notification: { method: 'thread/started', params: { epoch: 1 } }, now: 8000 });
  assert.strictEqual(other.compaction_count, 0, 'threads must be isolated');
  process.stdout.write('forge-context-codex.test.js: ok\n');
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
