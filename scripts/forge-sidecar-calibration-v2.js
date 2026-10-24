'use strict';

// claude-silence-v2: calibration that can only tighten the locked liveness defaults,
// always inside [floor, default]. Separate store so the v1 reader never sees v2 records.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const locks = require('./forge-lock');
const v1 = require('./forge-sidecar-calibration');
const { DEFAULTS, CALIBRATION_FLOORS } = require('./forge-sidecar-liveness');
const { hash, exactKeys, sample, safePath } = v1;

const POLICY = 'claude-silence-v2';
const FILE = 'calibration-v2.json';
const MAX_BYTES = 1048576;
const MAX_KEYS = 256;
const MIN_SAMPLES = 5;
const MAX_CENSORED = 32;
const FALLBACK_MIN_SAMPLES = 10;
const FALLBACK_MIN_PHASES = 2;
const SLACK_MS = 15000;
const LIMITS = Object.freeze({
  initial: Object.freeze({ floor: CALIBRATION_FLOORS.startMs, ceiling: DEFAULTS.startMs }),
  gap: Object.freeze({ floor: CALIBRATION_FLOORS.deadMs, ceiling: DEFAULTS.deadMs }),
});
const SHA = /^[a-f0-9]{64}$/;
const ACCEPTED_KEYS = ['version', 'key', 'identity', 'attempt_sha256', 'initial_ms', 'gap_ms', 'source'];
const CENSORED_KEYS = ['version', 'key', 'identity', 'attempt_sha256', 'censored_initial_ms', 'censored_gap_ms', 'source'];

function identity(input) {
  return { ...v1.identity(input), policy: POLICY };
}

function directory(options = {}) {
  return v1.directory(options);
}

function thresholdFor(dimensionName, samples, censoredMax) {
  const limits = LIMITS[dimensionName];
  if (!limits || !Array.isArray(samples) || !samples.every(sample)
      || !(censoredMax === null || sample(censoredMax))) throw new Error('calibration-threshold-invalid');
  const raw = samples.length ? 4 * Math.max(...samples) + SLACK_MS : 0;
  const lower = censoredMax === null ? 0 : censoredMax + SLACK_MS;
  return Math.min(limits.ceiling, Math.max(limits.floor, raw, lower));
}

const censoredEmpty = () => ({ count: 0, max_ms: null, evidence: [] });
function dimension() {
  return { state: 'uncalibrated', calibrated: false, count: 0, threshold_ms: null,
    samples: [], evidence: [], censored: censoredEmpty() };
}

function validCensored(value) {
  return exactKeys(value, ['count', 'max_ms', 'evidence'])
    && Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= MAX_CENSORED
    && Array.isArray(value.evidence) && value.evidence.length === value.count
    && new Set(value.evidence).size === value.count && value.evidence.every(id => SHA.test(id))
    && (value.count === 0 ? value.max_ms === null : sample(value.max_ms));
}

function validDimension(name, value) {
  if (!exactKeys(value, ['state', 'calibrated', 'count', 'threshold_ms', 'samples', 'evidence', 'censored'])
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MIN_SAMPLES
      || !Array.isArray(value.samples) || value.samples.length !== value.count || !value.samples.every(sample)
      || !Array.isArray(value.evidence) || value.evidence.length !== value.count
      || !value.evidence.every(id => SHA.test(id)) || !validCensored(value.censored)
      || new Set([...value.evidence, ...value.censored.evidence]).size !== value.count + value.censored.count) return false;
  const state = value.count === MIN_SAMPLES ? 'calibrated' : value.count ? 'calibrating' : 'uncalibrated';
  return value.state === state && value.calibrated === (state === 'calibrated')
    && value.threshold_ms === (value.calibrated ? thresholdFor(name, value.samples, value.censored.max_ms) : null);
}

function readStore(dir) {
  safePath(dir);
  const file = path.join(dir, FILE);
  safePath(file);
  if (!fs.existsSync(file)) return { version: 2, records: {} };
  let fd, bytes;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('calibration-store-invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0, got;
    do {
      got = fs.readSync(fd, buffer, count, buffer.length - count, count);
      count += got;
    } while (got && count < buffer.length);
    const after = fs.fstatSync(fd);
    if (count > MAX_BYTES || count !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new Error('calibration-store-invalid');
    }
    safePath(file);
    bytes = buffer.subarray(0, count).toString('utf8');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const data = JSON.parse(bytes);
  if (!exactKeys(data, ['version', 'records']) || data.version !== 2 || !data.records
      || typeof data.records !== 'object' || Array.isArray(data.records)
      || Object.keys(data.records).length > MAX_KEYS) throw new Error('calibration-store-invalid');
  for (const [key, record] of Object.entries(data.records)) {
    if (!SHA.test(key) || !exactKeys(record, ['identity', 'initial', 'gap'])
        || JSON.stringify(record.identity) !== JSON.stringify(identity(record.identity))
        || hash(record.identity) !== key || !validDimension('initial', record.initial)
        || !validDimension('gap', record.gap)) throw new Error('calibration-store-invalid');
  }
  return data;
}

function read(input, options = {}) {
  const id = identity(input), key = hash(id);
  try {
    const record = readStore(directory(options)).records[key];
    return { key, identity: id, initial: record?.initial || dimension(), gap: record?.gap || dimension(), diagnostic: null };
  } catch {
    return { key, identity: id, initial: dimension(), gap: dimension(), diagnostic: 'calibration-unavailable' };
  }
}

const unresolved = state => ({ state, threshold_ms: null, source: null });

function resolveDimension(name, exact, siblings) {
  if (exact.calibrated) return { state: 'calibrated', threshold_ms: exact.threshold_ms, source: 'persisted-calibration' };
  // Model fallback: distinct uncensored samples across the model's records, from >= 2 phases.
  const seen = new Set(), phases = new Set(), samples = [];
  let censoredMax = null;
  for (const record of siblings) {
    const d = record[name];
    if (d.censored.max_ms !== null && (censoredMax === null || d.censored.max_ms > censoredMax)) censoredMax = d.censored.max_ms;
    d.evidence.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      samples.push(d.samples[index]);
      phases.add(record.identity.phase);
    });
  }
  if (samples.length >= FALLBACK_MIN_SAMPLES && phases.size >= FALLBACK_MIN_PHASES) {
    return { state: 'calibrated', threshold_ms: thresholdFor(name, samples, censoredMax), source: 'model-fallback' };
  }
  return unresolved(exact.state);
}

// Per dimension: exact calibration wins, then the model fallback, otherwise no threshold.
function resolve(input, options = {}) {
  const id = identity(input), key = hash(id);
  try {
    const records = readStore(directory(options)).records;
    const exact = records[key] || { initial: dimension(), gap: dimension() };
    const siblings = Object.values(records).filter(record => record.identity.transport === id.transport
      && record.identity.protocol === id.protocol && record.identity.model === id.model);
    return { key, identity: id, initial: resolveDimension('initial', exact.initial, siblings),
      gap: resolveDimension('gap', exact.gap, siblings), diagnostic: null };
  } catch {
    return { key, identity: id, initial: unresolved('uncalibrated'), gap: unresolved('uncalibrated'),
      diagnostic: 'calibration-unavailable' };
  }
}

// Only adapter acceptance creates this proposal. No home/path is serialized.
function propose(input, snapshot) {
  const id = identity(input);
  return { version: 2, key: hash(id), identity: id, attempt_sha256: hash(crypto.randomUUID()),
    initial_ms: sample(snapshot?.initial_sample_ms) ? snapshot.initial_sample_ms : null,
    gap_ms: sample(snapshot?.gap_sample_ms) ? snapshot.gap_sample_ms : null, source: 'accepted-claude-stream-v2' };
}

// A terminated stream only proves the silence lasted at least window_ms (lower bound).
function proposeCensored(input, observed) {
  const id = identity(input), valid = sample(observed?.window_ms);
  return { version: 2, key: hash(id), identity: id, attempt_sha256: hash(crypto.randomUUID()),
    censored_initial_ms: valid && observed.dimension === 'initial' ? observed.window_ms : null,
    censored_gap_ms: valid && observed.dimension === 'gap' ? observed.window_ms : null,
    source: 'terminated-claude-stream-v2' };
}

function validProposal(proposal, binding) {
  const accepted = proposal?.source === 'accepted-claude-stream-v2';
  const censored = proposal?.source === 'terminated-claude-stream-v2';
  return (accepted || censored) && exactKeys(proposal, accepted ? ACCEPTED_KEYS : CENSORED_KEYS)
    && proposal.version === 2 && proposal.key === hash(identity(proposal.identity))
    && SHA.test(proposal.attempt_sha256) && !!binding?.fingerprint && !!binding?.receipt;
}

function merge(record, proposal) {
  const accepted = proposal.source === 'accepted-claude-stream-v2';
  const evidence = proposal.attempt_sha256;
  const values = accepted ? { initial: proposal.initial_ms, gap: proposal.gap_ms }
    : { initial: proposal.censored_initial_ms, gap: proposal.censored_gap_ms };
  const outcome = { changed: false, replay: false, full: false, frozen: false, any: false };
  for (const name of ['initial', 'gap']) {
    const value = values[name], d = record[name];
    if (!sample(value)) continue;
    outcome.any = true;
    if (d.evidence.includes(evidence) || d.censored.evidence.includes(evidence)) { outcome.replay = true; continue; }
    if (accepted) {
      if (d.calibrated) { outcome.frozen = true; continue; }
      d.samples.push(value);
      d.evidence.push(evidence);
      d.count = d.samples.length;
      d.calibrated = d.count === MIN_SAMPLES;
      d.state = d.calibrated ? 'calibrated' : 'calibrating';
    } else {
      if (d.censored.count >= MAX_CENSORED) { outcome.full = true; continue; }
      d.censored.count += 1;
      d.censored.evidence.push(evidence);
      d.censored.max_ms = d.censored.max_ms === null ? value : Math.max(d.censored.max_ms, value);
    }
    d.threshold_ms = d.calibrated ? thresholdFor(name, d.samples, d.censored.max_ms) : null;
    outcome.changed = true;
  }
  return outcome;
}

function commit(proposal, binding, options = {}) {
  let lock, temp;
  try {
    if (!validProposal(proposal, binding)) return { committed: false, diagnostic: 'calibration-binding-invalid' };
    const dir = directory(options);
    safePath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    safePath(dir);
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true, mode: 0o700 });
    safePath(path.join(dir, '.gsd', '.locks'));
    lock = locks.tryAcquireSync(dir, 'calibration');
    if (!lock) return { committed: false, diagnostic: 'calibration-busy' };
    const data = readStore(dir), old = data.records[proposal.key];
    if (!old && Object.keys(data.records).length >= MAX_KEYS) throw new Error('calibration-store-full');
    const record = old || { identity: identity(proposal.identity), initial: dimension(), gap: dimension() };
    const result = merge(record, proposal);
    if (!result.any) return { committed: true, noop: 'no-samples' };
    if (!result.changed) {
      return { committed: true, noop: result.replay ? 'replay' : result.full ? 'censored-full' : 'frozen' };
    }
    data.records[proposal.key] = record;
    const bytes = JSON.stringify(data);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('calibration-store-full');
    temp = path.join(dir, `calibration-v2.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    if (!locks.assertOwned(lock)) throw new Error('calibration-lock-lost');
    safePath(path.join(dir, FILE));
    fs.renameSync(temp, path.join(dir, FILE));
    temp = null;
    return { committed: true, key: proposal.key };
  } catch {
    return { committed: false, diagnostic: 'calibration-unavailable' };
  } finally {
    if (temp) try { fs.unlinkSync(temp); } catch { /* best effort */ }
    if (lock) lock.release();
  }
}

module.exports = { POLICY, FILE, LIMITS, identity, directory, thresholdFor, read, resolve, propose, proposeCensored, commit };
