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
  if (!notification || typeof notification !== 'object') return { capability: false };
  const params = notification.params && typeof notification.params === 'object' ? notification.params : {};
  const context = params.context_window || params.contextWindow;
  if (!context || typeof context !== 'object' || !Object.prototype.hasOwnProperty.call(context, 'used_percentage')) return { capability: false };
  return { capability: true, used_percentage: context.used_percentage };
}

function observe(options) {
  const { cwd, session_id: sessionId, notification } = options;
  const files = pathsFor(cwd, sessionId);
  const previous = readJson(files.state) || { compaction_measurement: 'unknown', seen_cycles: [], checkpoints: [] };
  const telemetry = extractFormalTelemetry(notification);
  const params = notification && notification.params && typeof notification.params === 'object' ? notification.params : {};
  const epoch = params.epoch == null ? (previous.epoch || '0') : String(params.epoch);
  const cycleId = params.cycle_id == null ? null : String(params.cycle_id);
  if (notification && notification.method === 'thread/started') {
    previous.compaction_measurement = 'known'; previous.compaction_count = previous.compaction_count || 0;
  }
  if (notification && notification.method === 'thread/compacted' && cycleId && previous.compaction_measurement === 'known'
      && !previous.seen_cycles.includes(cycleId)) {
    previous.seen_cycles.push(cycleId); previous.compaction_count += 1;
  }
  previous.epoch = epoch;
  const snapshot = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', session_id: sessionId,
    epoch, capability: telemetry.capability, used_percentage: telemetry.used_percentage,
    compaction_measurement: previous.compaction_measurement, compaction_count: previous.compaction_count }, options.now);
  try { atomicJson(files.state, previous); atomicJson(files.snapshot, snapshot); } catch { /* MEM008 */ }
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
  if (!snapshot || snapshot.measurement !== 'measured') return 'ctx ?';
  const used = Math.round(snapshot.used_percentage * 100);
  const remaining = Math.round(snapshot.remaining_percentage * 100);
  const compact = snapshot.compaction_measurement === 'known' ? ` compact x${snapshot.compaction_count}` : '';
  return `ctx ${used}% usado/${remaining}% restante${compact}`;
}

module.exports = { sanitizeIdentity, pathsFor, extractFormalTelemetry, observe, checkpointCrossing, render };
