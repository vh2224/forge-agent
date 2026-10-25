'use strict';

// A standalone data contract: the runner must not pull in other Forge modules.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHARD_PROFILE_SCHEMA = 'forge-shard-profile/v1';
const ALGORITHMS = Object.freeze({ positional: 'positional-v1', weighted: 'weighted-lpt-v1' });
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const LIMITS = Object.freeze({
  maxProfileBytes: 1024 * 1024, maxSuites: 5000, maxShards: 64,
  maxWeightMs: 86400000, maxSources: 64,
});
const SUITE_ID_RE = /^(?=.{1,200}$)[^\\/:*?"'<>|\x00-\x1f\x7f-\x9f]*\.test\.js$/u;
const HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_FIELDS = ['kind', 'name', 'sha256', 'bytes', 'platform', 'job_name',
  'runner_image', 'runner_image_version', 'node_version', 'observed_from',
  'observed_to', 'suites_declared', 'suites_observed', 'suites_failed', 'unavailable'];
const PLATFORM_FIELDS = ['status', 'reason', 'default_weight_ms', 'observations', 'weights_ms', 'excluded'];

function compareCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function plain(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
      && Object.getOwnPropertyDescriptor(value, key).enumerable);
}
function list(value) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
      .every(descriptor => descriptor && Object.hasOwn(descriptor, 'value'));
}
function text(value, max = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function namedError(code, errors) {
  const error = new Error(code);
  error.code = code;
  if (errors) error.errors = errors;
  return error;
}
function closed(value, fields, errors, field, annotations = false) {
  if (!plain(value)) { errors.push(`${field}: objeto-simples-obrigatorio`); return false; }
  if (fields.some(key => !Object.hasOwn(value, key))) errors.push(`${field}: campo-obrigatorio`);
  if (Object.keys(value).some(key => !fields.includes(key)
    && !(annotations && key.startsWith('_') && typeof value[key] === 'string'))) {
    errors.push(`${field}: campo-desconhecido`);
  }
  return true;
}
function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

/** Closed, non-executing schema. Diagnostics identify fields, never input text. */
function validateShardProfile(doc) {
  const errors = [];
  if (!closed(doc, ['schema', 'algorithm', 'sources', 'platforms'], errors, 'perfil', true)) {
    return { ok: false, errors };
  }
  if (doc.schema !== SHARD_PROFILE_SCHEMA) errors.push('schema: versao-invalida');
  if (doc.algorithm !== ALGORITHMS.weighted) errors.push('algorithm: valor-invalido');
  if (!Array.isArray(doc.sources) || doc.sources.length < 1 || doc.sources.length > LIMITS.maxSources || !list(doc.sources)) {
    errors.push('sources: limite-invalido');
  } else {
    doc.sources.forEach(source => {
      if (!closed(source, SOURCE_FIELDS, errors, 'source')) return;
      if (!['run-tests-log', 'suite-profile'].includes(source.kind)) errors.push('source.kind: valor-invalido');
      if (!text(source.name, 120) || /[\\/:*?"'<>|]/.test(source.name)
        || path.basename(source.name) !== source.name || ['.', '..'].includes(source.name)) {
        errors.push('source.name: nome-invalido');
      }
      if (typeof source.sha256 !== 'string' || !HASH_RE.test(source.sha256)) errors.push('source.sha256: hash-invalido');
      if (!integer(source.bytes, 0)) errors.push('source.bytes: inteiro-invalido');
      const reasons = source.unavailable;
      if (!plain(reasons) || Object.keys(reasons).some(key => !SOURCE_FIELDS.includes(key)
        || key === 'unavailable' || source[key] !== null || !text(reasons[key]))) {
        errors.push('source.unavailable: motivos-invalidos');
      }
      for (const field of SOURCE_FIELDS.slice(4, -1)) {
        const value = source[field];
        if (value === null) {
          if (!plain(reasons) || !Object.hasOwn(reasons, field) || !text(reasons[field])) {
            errors.push(`source.${field}: motivo-obrigatorio`);
          }
          continue;
        }
        let valid;
        if (field === 'platform') valid = PLATFORMS.includes(value);
        else if (field === 'node_version') valid = typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value);
        else if (field.startsWith('observed_')) valid = utc(value);
        else if (field.startsWith('suites_')) valid = integer(value, 0, LIMITS.maxSuites);
        else valid = text(value);
        if (!valid) errors.push(`source.${field}: valor-invalido`);
      }
      if (utc(source.observed_from) && utc(source.observed_to)
        && Date.parse(source.observed_from) > Date.parse(source.observed_to)) errors.push('source: janela-invalida');
      if (integer(source.suites_observed, 0) && integer(source.suites_failed, 0)
        && source.suites_failed > source.suites_observed) errors.push('source: contagens-invalidas');
    });
  }
  if (!plain(doc.platforms) || Object.keys(doc.platforms).some(key => !PLATFORMS.includes(key))) {
    errors.push('platforms: chaves-invalidas');
  } else {
    for (const platform of Object.keys(doc.platforms)) {
      const row = doc.platforms[platform];
      if (!closed(row, PLATFORM_FIELDS, errors, 'platform')) continue;
      if (!['observed', 'unavailable'].includes(row.status)) errors.push('platform.status: valor-invalido');
      if (!integer(row.observations, 0)) errors.push('platform.observations: inteiro-invalido');
      const weights = row.weights_ms;
      const validWeights = plain(weights);
      const ids = validWeights ? Object.keys(weights) : [];
      if (!validWeights || ids.length > LIMITS.maxSuites) errors.push('weights_ms: limite-ou-objeto-invalido');
      for (const id of ids) {
        if (!SUITE_ID_RE.test(id)) errors.push('weights_ms: suite-invalida');
        if (!integer(weights[id], 1, LIMITS.maxWeightMs)) errors.push('weights_ms: peso-invalido');
      }
      if (row.status === 'observed' && (row.reason !== null || ids.length === 0
        || !integer(row.default_weight_ms, 1, LIMITS.maxWeightMs))) errors.push('platform: observed-invalido');
      if (row.status === 'unavailable' && (!text(row.reason) || ids.length !== 0
        || row.default_weight_ms !== null)) errors.push('platform: unavailable-invalido');
      if (!Array.isArray(row.excluded) || row.excluded.length > LIMITS.maxSuites || !list(row.excluded)) errors.push('excluded: limite-invalido');
      else {
        const seen = new Set(ids);
        for (const entry of row.excluded) {
          if (!closed(entry, ['suite', 'reason'], errors, 'excluded')) continue;
          if (typeof entry.suite !== 'string' || !SUITE_ID_RE.test(entry.suite)
            || seen.has(entry.suite)) errors.push('excluded: suite-invalida-ou-repetida');
          seen.add(entry.suite);
          if (!['no-passing-observation', 'ambiguous-observation'].includes(entry.reason)) errors.push('excluded.reason: valor-invalido');
        }
        if (seen.size > LIMITS.maxSuites) errors.push('platform: limite-de-suites');
      }
    }
  }
  // Only serialize validated plain objects, so accessors/prototypes cannot execute.
  if (!errors.length && Buffer.byteLength(JSON.stringify(doc)) > LIMITS.maxProfileBytes) errors.push('perfil: limite-de-bytes');
  return errors.length ? { ok: false, errors } : { ok: true, profile: doc };
}

function loadShardProfile(file, io = fs) {
  let stat;
  try { stat = io.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw namedError('shard-profile-unreadable');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw namedError('shard-profile-unreadable');
  if (stat.size > LIMITS.maxProfileBytes) throw namedError('shard-profile-too-large');
  let bytes;
  try { bytes = io.readFileSync(file); }
  catch { throw namedError('shard-profile-unreadable'); }
  if (bytes.length > LIMITS.maxProfileBytes) throw namedError('shard-profile-too-large');
  // Buffer round-trip detects malformed UTF-8 without importing another builtin.
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw namedError('shard-profile-invalid', ['perfil: utf8-invalido']);
  let doc;
  try { doc = JSON.parse(decoded); }
  catch { throw namedError('shard-profile-invalid', ['perfil: json-invalido']); }
  const result = validateShardProfile(doc);
  if (!result.ok) throw namedError('shard-profile-invalid', result.errors);
  return { state: 'loaded', doc, sha256: hash(bytes) };
}

function universeFingerprint(suites) {
  return hash(JSON.stringify([...suites].sort(compareCodeUnits)));
}
function partitionFingerprint({ algorithm, count, shards }) {
  return hash(JSON.stringify({ algorithm, count, shards: shards.map(row => [...row].sort(compareCodeUnits)) }));
}
function verifyPartition(universe, shards) {
  const expected = new Set(universe);
  const counts = new Map();
  for (const shard of shards) for (const suite of shard) counts.set(suite, (counts.get(suite) || 0) + 1);
  const missing = [...expected].filter(id => !counts.has(id)).sort(compareCodeUnits);
  const duplicated = [...counts.keys()].filter(id => counts.get(id) > 1).sort(compareCodeUnits);
  const unknown = [...counts.keys()].filter(id => !expected.has(id)).sort(compareCodeUnits);
  return { ok: !missing.length && !duplicated.length && !unknown.length, missing, duplicated, unknown };
}

function planShards({ suites, index, count, platform, profile = null }) {
  if (!Array.isArray(suites) || suites.length > LIMITS.maxSuites || !list(suites) || suites.some(id => typeof id !== 'string')
    || new Set(suites).size !== suites.length || !integer(count, 1, LIMITS.maxShards)
    || !integer(index, 0, count - 1)) throw namedError('shard-input-invalid');
  let algorithm = ALGORITHMS.positional;
  let fallback = null;
  let profileSha = null;
  let row = null;
  if (profile !== null) {
    if (!plain(profile)) throw namedError('shard-input-invalid');
    if (profile.state === 'absent') fallback = 'profile-absent';
    else if (profile.state === 'loaded') {
      const valid = validateShardProfile(profile.doc);
      if (!valid.ok) throw namedError('shard-profile-invalid', valid.errors);
      if (typeof profile.sha256 !== 'string' || !HASH_RE.test(profile.sha256)) throw namedError('shard-input-invalid');
      profileSha = profile.sha256;
      row = Object.hasOwn(profile.doc.platforms, platform) ? profile.doc.platforms[platform] : null;
      if (!row) fallback = 'platform-missing';
      else if (row.status === 'unavailable') fallback = 'platform-unavailable';
      else algorithm = ALGORITHMS.weighted;
    } else throw namedError('shard-input-invalid');
  }
  const shards = Array.from({ length: count }, () => []);
  const predicted = algorithm === ALGORITHMS.weighted ? Array(count).fill(0) : null;
  let unprofiled = [];
  let stale = [];
  if (algorithm === ALGORITHMS.weighted) {
    const universe = new Set(suites);
    const weight = id => Object.hasOwn(row.weights_ms, id) ? row.weights_ms[id] : row.default_weight_ms;
    unprofiled = suites.filter(id => !Object.hasOwn(row.weights_ms, id)).sort(compareCodeUnits);
    stale = Object.keys(row.weights_ms).filter(id => !universe.has(id)).sort(compareCodeUnits);
    const assignment = new Map();
    const ordered = [...suites].sort((a, b) => weight(b) - weight(a) || compareCodeUnits(a, b));
    for (const suite of ordered) {
      let target = 0;
      for (let i = 1; i < count; i += 1) if (predicted[i] < predicted[target]) target = i;
      assignment.set(suite, target);
      predicted[target] += weight(suite);
    }
    // Keep the runner's canonical execution order, independently of LPT order.
    for (const suite of suites) shards[assignment.get(suite)].push(suite);
  } else suites.forEach((suite, position) => shards[position % count].push(suite));
  if (!verifyPartition(suites, shards).ok) throw namedError('shard-partition-invalid');
  return {
    algorithm, fallback, index, count, shards, selected: shards[index], universe_size: suites.length,
    universe_sha256: universeFingerprint(suites), profile_sha256: profileSha,
    partition_sha256: partitionFingerprint({ algorithm, count, shards }),
    predicted_ms: predicted, unprofiled, stale,
  };
}

function formatShardPlanLine(plan) {
  const line = `Shard plan: shard=${plan.index + 1}/${plan.count} algorithm=${plan.algorithm}`
    + ` fallback=${plan.fallback || 'none'} selected=${plan.selected.length} universe=${plan.universe_size}`
    + ` unprofiled=${plan.unprofiled.length} stale=${plan.stale.length}`
    + ` predicted_ms=${plan.predicted_ms === null ? 'none' : plan.predicted_ms[plan.index]}`
    + ` universe_sha256=${plan.universe_sha256} profile_sha256=${plan.profile_sha256 || 'none'}`
    + ` partition_sha256=${plan.partition_sha256}`;
  if (line.length >= 400 || !parseShardPlanLine(line)) throw namedError('shard-input-invalid');
  return line;
}

function parseShardPlanLine(line) {
  if (typeof line !== 'string' || line.length >= 400) return null;
  const n = '(0|[1-9][0-9]*)';
  const hex = '([a-f0-9]{64})';
  const match = new RegExp(`^Shard plan: shard=${n}/${n} algorithm=(positional-v1|weighted-lpt-v1)`
    + ` fallback=(none|profile-absent|platform-missing|platform-unavailable) selected=${n} universe=${n}`
    + ` unprofiled=${n} stale=${n} predicted_ms=(none|0|[1-9][0-9]*)`
    + ` universe_sha256=${hex} profile_sha256=(none|[a-f0-9]{64}) partition_sha256=${hex}$`).exec(line);
  if (!match || match[0] !== line) return null;
  const [, shard, count, algorithm, fallback, selected, universe, unprofiled, stale, predicted, universeSha, profileSha, partitionSha] = match;
  const values = [shard, count, selected, universe, unprofiled, stale].map(Number);
  if (values.some(value => !integer(value, 0)) || !integer(+count, 1, LIMITS.maxShards)
    || !integer(+shard, 1, +count) || +selected > +universe || +universe > LIMITS.maxSuites
    || +unprofiled > +universe || +stale > LIMITS.maxSuites
    || (predicted !== 'none' && !integer(+predicted, 0, LIMITS.maxSuites * LIMITS.maxWeightMs))) return null;
  if (algorithm === ALGORITHMS.weighted && (fallback !== 'none' || predicted === 'none' || profileSha === 'none')) return null;
  if (algorithm === ALGORITHMS.positional && (predicted !== 'none' || +unprofiled !== 0 || +stale !== 0)) return null;
  return {
    index: +shard - 1, count: +count, algorithm, fallback: fallback === 'none' ? null : fallback,
    selected: +selected, universe_size: +universe, unprofiled: +unprofiled, stale: +stale,
    predicted_ms: predicted === 'none' ? null : +predicted,
    universe_sha256: universeSha, profile_sha256: profileSha === 'none' ? null : profileSha,
    partition_sha256: partitionSha,
  };
}

function lowerMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function buildShardProfile({ observations, sources }) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > LIMITS.maxSources
    || !Array.isArray(observations) || observations.length > LIMITS.maxSuites * LIMITS.maxSources * PLATFORMS.length) {
    throw namedError('shard-profile-limit');
  }
  if (!list(observations) || !list(sources)) throw namedError('shard-profile-invalid', ['observations: lista-invalida']);
  const groups = new Map(PLATFORMS.map(platform => [platform, new Map()]));
  for (const observation of observations) {
    const errors = [];
    if (!closed(observation, ['platform', 'suite', 'elapsed_ms', 'status', 'source_index'], errors, 'observation')
      || errors.length) throw namedError('shard-profile-invalid', ['observations: valor-invalido']);
    if (observation.status === 'pass' && Number.isFinite(observation.elapsed_ms)
      && observation.elapsed_ms > LIMITS.maxWeightMs) throw namedError('shard-profile-limit');
    if (!PLATFORMS.includes(observation.platform) || typeof observation.suite !== 'string'
      || !SUITE_ID_RE.test(observation.suite) || !['pass', 'fail', 'not-run', 'ambiguous'].includes(observation.status)
      || !integer(observation.source_index, 0, sources.length - 1)
      || (observation.status === 'pass' && !integer(observation.elapsed_ms, 0, LIMITS.maxWeightMs))) {
      throw namedError('shard-profile-invalid', ['observations: valor-invalido']);
    }
    const group = groups.get(observation.platform);
    if (!group.has(observation.suite)) group.set(observation.suite, []);
    group.get(observation.suite).push(observation);
    if (group.size > LIMITS.maxSuites) throw namedError('shard-profile-limit');
  }
  const platforms = {};
  for (const platform of PLATFORMS) {
    const group = groups.get(platform);
    const weights = {};
    const excluded = [];
    let passingCount = 0;
    for (const suite of [...group.keys()].sort(compareCodeUnits)) {
      const entries = group.get(suite);
      const passing = entries.filter(entry => entry.status === 'pass').map(entry => entry.elapsed_ms);
      passingCount += passing.length;
      if (passing.length) weights[suite] = Math.max(1, lowerMedian(passing));
      else excluded.push({ suite, reason: entries.every(entry => entry.status === 'ambiguous')
        ? 'ambiguous-observation' : 'no-passing-observation' });
    }
    const observed = Object.keys(weights).length > 0;
    platforms[platform] = {
      status: observed ? 'observed' : 'unavailable', reason: observed ? null : 'no-observations',
      default_weight_ms: observed ? lowerMedian(Object.values(weights)) : null,
      observations: passingCount, weights_ms: weights, excluded,
    };
  }
  const doc = { schema: SHARD_PROFILE_SCHEMA, algorithm: ALGORITHMS.weighted, sources, platforms };
  const result = validateShardProfile(doc);
  if (!result.ok) throw namedError(result.errors.some(error => /limite/.test(error))
    ? 'shard-profile-limit' : 'shard-profile-invalid', result.errors);
  return doc;
}

module.exports = {
  SHARD_PROFILE_SCHEMA, ALGORITHMS, PLATFORMS, LIMITS, SUITE_ID_RE, compareCodeUnits,
  validateShardProfile, loadShardProfile, planShards, verifyPartition,
  universeFingerprint, partitionFingerprint, formatShardPlanLine, parseShardPlanLine, buildShardProfile,
};
