#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractFormalTelemetry, observe, observeSession, checkpointCrossing, render, pathsFor } = require('./forge-context-codex');
const { DEFAULT_THRESHOLDS } = require('./forge-context-monitor');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-codex-'));
try {
  assert.deepStrictEqual(extractFormalTelemetry({ method: 'turn/completed', params: {} }), { capability: false });
  assert.deepStrictEqual(extractFormalTelemetry({ params: { context_window: { used_percentage: 0 } } }), { capability: false }, 'unpinned synthetic usage must be rejected');

  let snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'turn/completed', params: {} }, now: 1000 });
  assert.strictEqual(snapshot.measurement, 'unknown');
  assert.strictEqual(snapshot.compaction_measurement, 'unknown');
  assert.strictEqual(render(snapshot), 'ctx ?');

  snapshot = observeSession({ cwd, threadStartResult: { thread: { id: 'thread/../one' } }, notifications: [], now: 2000 });
  assert.strictEqual(snapshot.measurement, 'unknown');
  assert.strictEqual(snapshot.compaction_count, 0);
  assert.strictEqual(snapshot.scope, 'sidecar-thread');
  assert.match(render(snapshot), /compact x0/);

  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'item/started', params: { item: { id: 'c1', type: 'contextCompaction' } } }, now: 3000 });
  assert.strictEqual(snapshot.compaction_count, 1);
  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'item/completed', params: { item: { id: 'c1', type: 'contextCompaction' } } }, now: 4000 });
  assert.strictEqual(snapshot.compaction_count, 1, 'replay must be idempotent');
  snapshot = observe({ cwd, session_id: 'thread/../one', notification: { method: 'item/completed', params: { item: { id: 'c2', type: 'contextCompaction' } } }, now: 5000 });
  assert.strictEqual(snapshot.compaction_count, 2);
  assert(fs.existsSync(pathsFor(cwd, 'thread/../one').state), 'sanitized durable state must exist');

  assert.strictEqual(checkpointCrossing({ cwd, snapshot, thresholds: DEFAULT_THRESHOLDS, now: 6000 }).checkpoint, false, 'unknown usage never checkpoints');

  const other = observeSession({ cwd, threadStartResult: { thread: { id: 'other' } }, notifications: [], now: 8000 });
  assert.strictEqual(other.compaction_count, 0, 'threads must be isolated');
  assert.strictEqual(observeSession({ cwd, threadStartResult: {}, notifications: [] }), null, 'failed/missing thread start cannot establish baseline');
  process.stdout.write('forge-context-codex.test.js: ok\n');
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
