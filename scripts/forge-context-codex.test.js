#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractFormalTelemetry, observe, observeSession, checkpointCrossing, consumeBoundary, render, pathsFor } = require('./forge-context-codex');
const { DEFAULT_THRESHOLDS, createContextSnapshot } = require('./forge-context-monitor');

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

  const measured = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', capability: true,
    session_id: 'measured', epoch: 'e1', used_percentage: 62 }, 9000);
  measured.scope = 'sidecar-thread';
  const alertsOff = consumeBoundary({ cwd, snapshot: measured, now: 9000,
    prefs: { enabled: true, alertsEnabled: false, debounceToolUses: 0, thresholds: DEFAULT_THRESHOLDS } });
  assert.strictEqual(alertsOff.indicator, 'ctx 62% usado/38% restante');
  assert.strictEqual(alertsOff.severity, 'none');
  assert.strictEqual(alertsOff.checkpoint, false);

  const appendFailure = checkpointCrossing({ cwd, snapshot: { ...measured, session_id: 'append-fail' },
    thresholds: DEFAULT_THRESHOLDS, now: 9000, io: { appendEvent() { throw new Error('disk full'); } } });
  assert.strictEqual(appendFailure.checkpoint, false, 'event failure must never report checkpoint success');
  assert.strictEqual(checkpointCrossing({ cwd, snapshot: { ...measured, session_id: 'append-fail' },
    thresholds: DEFAULT_THRESHOLDS, now: 9000 }).checkpoint, true, 'failed append remains retryable');

  const partial = { ...measured, session_id: 'partial-fail', epoch: 'e2' };
  const markerFailure = checkpointCrossing({ cwd, snapshot: partial, thresholds: DEFAULT_THRESHOLDS, now: 9000,
    io: { writeState() { throw new Error('marker failed'); } } });
  assert.strictEqual(markerFailure.checkpoint, false, 'marker failure after event must report false');
  assert.strictEqual(checkpointCrossing({ cwd, snapshot: partial, thresholds: DEFAULT_THRESHOLDS, now: 9000 }).checkpoint, true,
    'retry must recover from event-written/marker-missing partial failure');
  const events = fs.readFileSync(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(events.filter(event => event.event_id && event.event_id.includes('partial-fail')).length, 1,
    'partial-failure retry must not duplicate its durable event');

  const boundary = consumeBoundary({ cwd, snapshot: { ...measured, session_id: 'boundary', epoch: 'e3' }, now: 9000,
    prefs: { enabled: true, alertsEnabled: true, debounceToolUses: 0, thresholds: DEFAULT_THRESHOLDS } });
  assert.strictEqual(boundary.severity, 'checkpoint');
  assert.match(boundary.additionalContext, /pr.ximo boundary seguro/);
  assert.strictEqual(boundary.checkpoint, true, 'safe boundary consumer performs durable checkpoint crossing');
  process.stdout.write('forge-context-codex.test.js: ok\n');
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
