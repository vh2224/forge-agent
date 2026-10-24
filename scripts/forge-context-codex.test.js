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
  // persist:false x persist:true equivalence (S07/T06 truth 5): same thread, same notifications, same clock.
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-codex-persist-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-codex-memory-'));
  try {
    const threadId = 'equiv-thread';
    const cycle = (method, id) => ({ method, params: { item: { id, type: 'contextCompaction' } } });
    const notifications = [
      cycle('item/started', 'c1'),
      cycle('item/completed', 'c1'),
      cycle('item/completed', 'c1'), // replay
      { method: 'turn/completed', params: {} },
    ];
    const run = (dir, extra) => observeSession({ cwd: dir, threadStartResult: { thread: { id: threadId } },
      notifications, now: 7000, ...extra });
    const persisted = run(cwdA, {});
    const inMemory = run(cwdB, { persist: false });
    // The snapshot carries no cwd-derived field, so no normalization is needed.
    assert.deepStrictEqual(inMemory, persisted, 'persist:false must yield the same snapshot as persist:true');
    assert.strictEqual(inMemory.compaction_count, 1, 'replayed compaction counts once');

    const filesA = pathsFor(cwdA, threadId);
    assert(fs.existsSync(filesA.snapshot), 'persist:true must write the snapshot file');
    assert(fs.existsSync(filesA.state), 'persist:true must write the state file');
    const filesB = pathsFor(cwdB, threadId);
    assert.strictEqual(fs.existsSync(path.dirname(filesB.snapshot)), false, 'persist:false must not create the context dir');
    assert.strictEqual(fs.existsSync(path.join(cwdB, '.gsd')), false, 'persist:false must not create .gsd');
    assert.deepStrictEqual(fs.readdirSync(cwdB), [], 'persist:false must leave the cwd empty');

    // Direct observe() with persist:false and a caller-owned shared state.
    const state = { compaction_measurement: 'unknown', seen_cycles: [], checkpoints: [] };
    const direct = notification => observe({ cwd: cwdB, session_id: threadId, notification, baseline: notification === undefined,
      now: 7000, persist: false, state });
    assert.strictEqual(direct(undefined).compaction_count, 0, 'baseline starts at zero');
    assert.strictEqual(direct(cycle('item/started', 'c1')).compaction_count, 1);
    assert.strictEqual(state.compaction_count, 1, 'count accumulates in the shared state object');
    assert.strictEqual(direct(cycle('item/completed', 'c1')).compaction_count, 1, 'replay is idempotent in memory');
    assert.deepStrictEqual(state.seen_cycles, ['c1']);
    assert.deepStrictEqual(fs.readdirSync(cwdB), [], 'direct persist:false observe must not write');
  } finally {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  }
  process.stdout.write('forge-context-codex.test.js: ok\n');
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
