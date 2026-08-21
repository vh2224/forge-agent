#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createContextSnapshot, usableSnapshot } = require('./forge-context-monitor');

function sanitizeIdentity(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function pathsFor(cwd, sessionId) {
  const id = sanitizeIdentity(sessionId);
  const dir = path.join(cwd, '.gsd', 'forge', 'context', 'codex');
  return { snapshot: path.join(dir, `${id}.json`), state: path.join(dir, `${id}.state.json`) };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function extractFormalTelemetry(notification) {
  // The pinned app-server schema exposes no context-window usage field. Stay unknown
  // until a formal capability is pinned and covered by a real protocol fixture.
  return { capability: false };
}

function observe(options) {
  const { cwd, session_id: sessionId, notification } = options;
  const files = pathsFor(cwd, sessionId);
  const previous = readJson(files.state) || { compaction_measurement: 'unknown', seen_cycles: [], checkpoints: [] };
  const telemetry = extractFormalTelemetry(notification);
  const params = notification && notification.params && typeof notification.params === 'object' ? notification.params : {};
  const item = params.item && typeof params.item === 'object' ? params.item : null;
  if (options.baseline === true) {
    previous.compaction_measurement = 'known'; previous.compaction_count = previous.compaction_count || 0;
  }
  if (notification && (notification.method === 'item/started' || notification.method === 'item/completed')
      && item && item.type === 'contextCompaction' && typeof item.id === 'string'
      && previous.compaction_measurement === 'known' && !previous.seen_cycles.includes(item.id)) {
    previous.seen_cycles.push(item.id); previous.compaction_count += 1;
  }
  previous.epoch = String(previous.compaction_count || 0);
  const snapshot = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', session_id: sessionId,
    epoch: previous.epoch, capability: telemetry.capability, used_percentage: telemetry.used_percentage,
    compaction_measurement: previous.compaction_measurement, compaction_count: previous.compaction_count }, options.now);
  snapshot.scope = 'sidecar-thread';
  snapshot.epoch_source = 'forge-local-compaction-count';
  try { atomicJson(files.state, previous); atomicJson(files.snapshot, snapshot); } catch { /* MEM008 */ }
  return snapshot;
}

function observeSession(options) {
  const thread = options.threadStartResult && options.threadStartResult.thread;
  if (!thread || typeof thread.id !== 'string' || !thread.id) return null;
  let snapshot = observe({ cwd: options.cwd, session_id: thread.id, baseline: true, now: options.now });
  for (const notification of options.notifications || []) {
    snapshot = observe({ cwd: options.cwd, session_id: thread.id, notification, now: options.now });
  }
  return snapshot;
}

function checkpointCrossing(options) {
  const { cwd, snapshot, thresholds, now } = options;
  if (!usableSnapshot(snapshot, now) || snapshot.remaining_percentage > thresholds.checkpoint) return { checkpoint: false };
  const files = pathsFor(cwd, snapshot.session_id);
  const state = readJson(files.state) || { checkpoints: [] };
  state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
  const key = String(snapshot.epoch);
  if (state.checkpoints.includes(key)) return { checkpoint: false };
  state.checkpoints.push(key);
  try {
    atomicJson(files.state, state);
    const event = { ts: new Date(now || Date.now()).toISOString(), event: 'context-checkpoint', host_runtime: 'codex', session_id: snapshot.session_id, epoch: key };
    fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
    fs.appendFileSync(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), `${JSON.stringify(event)}\n`);
  } catch { /* MEM008 */ }
  return { checkpoint: true };
}

function render(snapshot) {
  const compact = snapshot && snapshot.compaction_measurement === 'known' ? ` compact x${snapshot.compaction_count}` : '';
  if (!snapshot || snapshot.measurement !== 'measured') return `ctx ?${compact}`;
  const used = Math.round(snapshot.used_percentage * 100);
  const remaining = Math.round(snapshot.remaining_percentage * 100);
  return `ctx ${used}% usado/${remaining}% restante${compact}`;
}

module.exports = { sanitizeIdentity, pathsFor, extractFormalTelemetry, observe, observeSession, checkpointCrossing, render };
