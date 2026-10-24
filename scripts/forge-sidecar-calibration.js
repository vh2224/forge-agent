'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const locks = require('./forge-lock');
const POLICY = 'claude-silence-v1';
const MAX_BYTES = 1048576;
const MAX_KEYS = 256;
const PHASES = new Set(['brainstorm', 'discuss', 'research', 'plan', 'execute', 'memory', 'review', 'fix', 'artifacts']);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sample = value => Number.isSafeInteger(value) && value >= 0
  && value <= Math.floor((Number.MAX_SAFE_INTEGER - 15000) / 4);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function identity(input) {
  if (!input || typeof input.model !== 'string' || !/^[A-Za-z0-9._:\[\]-]{1,140}$/.test(input.model)
      || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.effort) || !PHASES.has(input.phase)) {
    throw new Error('calibration-identity-invalid');
  }
  return { transport: 'claude-cli', protocol: 'stream-json-v1', model: input.model,
    effort: input.effort, phase: input.phase, policy: POLICY };
}

function directory(options = {}) {
  return path.join(require('./forge-home').resolveUserHome(options), '.forge-personal', 'sidecar-calibration');
}

function safePath(file) {
  for (let current = path.resolve(file);;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('calibration-unsafe-path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function dimension() {
  return { state: 'uncalibrated', calibrated: false, count: 0, threshold_ms: null, samples: [], evidence: [] };
}

function validDimension(value) {
  if (!exactKeys(value, ['state', 'calibrated', 'count', 'threshold_ms', 'samples', 'evidence'])
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 5
      || !Array.isArray(value.samples) || value.samples.length !== value.count || !value.samples.every(sample)
      || !Array.isArray(value.evidence) || value.evidence.length !== value.count
      || new Set(value.evidence).size !== value.count || !value.evidence.every(id => /^[a-f0-9]{64}$/.test(id))) return false;
  const state = value.count === 5 ? 'calibrated' : value.count ? 'calibrating' : 'uncalibrated';
  return value.state === state && value.calibrated === (state === 'calibrated')
    && value.threshold_ms === (value.calibrated ? Math.max(120000, 4 * Math.max(...value.samples) + 15000) : null);
}

function readStore(dir) {
  safePath(dir);
  const file = path.join(dir, 'calibration.json');
  safePath(file);
  if (!fs.existsSync(file)) return { version: 1, records: {} };
  let fd, bytes;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('calibration-store-invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0, read;
    do {
      read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      count += read;
    } while (read && count < buffer.length);
    const after = fs.fstatSync(fd);
    if (count > MAX_BYTES || count !== before.size || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new Error('calibration-store-invalid');
    }
    safePath(file);
    bytes = buffer.subarray(0, count).toString('utf8');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const data = JSON.parse(bytes);
  if (!exactKeys(data, ['version', 'records']) || data.version !== 1 || !data.records
      || typeof data.records !== 'object' || Array.isArray(data.records)
      || Object.keys(data.records).length > MAX_KEYS) throw new Error('calibration-store-invalid');
  for (const [key, record] of Object.entries(data.records)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !exactKeys(record, ['identity', 'initial', 'gap'])
        || JSON.stringify(record.identity) !== JSON.stringify(identity(record.identity))
        || hash(record.identity) !== key || !validDimension(record.initial) || !validDimension(record.gap)) {
      throw new Error('calibration-store-invalid');
    }
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

// Only adapter acceptance creates this proposal. No home/path is serialized.
function propose(input, snapshot) {
  const id = identity(input);
  return { version: 1, key: hash(id), identity: id, attempt_sha256: hash(crypto.randomUUID()),
    initial_ms: sample(snapshot.initial_sample_ms) ? snapshot.initial_sample_ms : null,
    gap_ms: sample(snapshot.gap_sample_ms) ? snapshot.gap_sample_ms : null, source: 'accepted-claude-stream-v1' };
}

function commit(proposal, binding, options = {}) {
  let lock, temp;
  try {
    if (!exactKeys(proposal, ['version', 'key', 'identity', 'attempt_sha256', 'initial_ms', 'gap_ms', 'source'])
        || proposal.version !== 1 || proposal.source !== 'accepted-claude-stream-v1'
        || proposal.key !== hash(identity(proposal.identity)) || !/^[a-f0-9]{64}$/.test(proposal.attempt_sha256)
        || !binding?.fingerprint || !binding?.receipt) return { committed: false, diagnostic: 'calibration-binding-invalid' };
    if (!sample(proposal.initial_ms) && !sample(proposal.gap_ms)) return { committed: true, noop: 'no-samples' };
    const dir = directory(options);
    safePath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    safePath(dir);
    // Reuse the owner/generation lock protocol in a private personal store.
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true, mode: 0o700 });
    safePath(path.join(dir, '.gsd', '.locks'));
    lock = locks.tryAcquireSync(dir, 'calibration');
    if (!lock) return { committed: false, diagnostic: 'calibration-busy' };
    const data = readStore(dir), old = data.records[proposal.key];
    if (!old && Object.keys(data.records).length >= MAX_KEYS) throw new Error('calibration-store-full');
    const record = old || { identity: identity(proposal.identity), initial: dimension(), gap: dimension() };
    // An attempt counts once even if a replay uses another publication reference.
    const evidence = proposal.attempt_sha256;
    let changed = false;
    for (const [name, value] of [['initial', proposal.initial_ms], ['gap', proposal.gap_ms]]) {
      const d = record[name];
      if (d.calibrated || d.evidence.includes(evidence) || !sample(value)) continue;
      d.samples.push(value);
      d.evidence.push(evidence);
      d.count = d.samples.length;
      d.calibrated = d.count === 5;
      d.state = d.calibrated ? 'calibrated' : 'calibrating';
      d.threshold_ms = d.calibrated ? Math.max(120000, 4 * Math.max(...d.samples) + 15000) : null;
      changed = true;
    }
    if (!changed) return { committed: true, noop: record.initial.calibrated && record.gap.calibrated ? 'frozen' : 'replay' };
    data.records[proposal.key] = record;
    const bytes = JSON.stringify(data);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('calibration-store-full');
    temp = path.join(dir, `calibration.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    if (!locks.assertOwned(lock)) throw new Error('calibration-lock-lost');
    safePath(path.join(dir, 'calibration.json'));
    fs.renameSync(temp, path.join(dir, 'calibration.json'));
    temp = null;
    return { committed: true, key: proposal.key };
  } catch {
    return { committed: false, diagnostic: 'calibration-unavailable' };
  } finally {
    if (temp) try { fs.unlinkSync(temp); } catch { /* best effort */ }
    if (lock) lock.release();
  }
}

function silence(calibration, snapshot) {
  const initial = snapshot.first_remote_ms === null;
  const d = initial ? calibration.initial : calibration.gap;
  if (!d.calibrated || !initial && snapshot.gap_suspended) return null;
  const window = initial ? snapshot.elapsed_ms : snapshot.remote_silence_ms;
  return sample(window) && window > d.threshold_ms ? { dimension: initial ? 'initial' : 'gap', window_ms: window,
    threshold_ms: d.threshold_ms, policy: POLICY, source: 'persisted-calibration', cause: 'indeterminate' } : null;
}

const { observation, progressLine } = require('./forge-sidecar-diagnostic');
// Retain the proposal in its owner receipt/result, retry transient persistence
// failures twice without another inference, and report exhaustion for replay.
async function commitAccepted(proposal, binding, options) {
  let outcome;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Version 2 proposals use their own store; v1 receipts keep the v1 path.
    outcome = proposal?.version === 2
      ? require('./forge-sidecar-calibration-v2').commit(proposal, binding, options)
      : module.exports.commit(proposal, binding, options);
    const safe = { committed: outcome.committed === true, attempts: attempt,
      diagnostic: ['calibration-busy', 'calibration-unavailable', 'calibration-binding-invalid'].includes(outcome.diagnostic)
        ? outcome.diagnostic : null, retry_pending: outcome.committed !== true };
    if (safe.committed || safe.diagnostic === 'calibration-binding-invalid' || attempt === 3) return safe;
    await new Promise(resolve => setTimeout(resolve, attempt * 25));
  }
}

module.exports = { POLICY, identity, directory, read, propose, commit, commitAccepted, observation, progressLine, silence,
  safePath, hash, exactKeys, sample };
