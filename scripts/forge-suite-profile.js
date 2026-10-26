'use strict';

// Standalone runner contract: no dependencies beyond builtins and suite identity.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SUITE_ID_RE } = require('./forge-ci-shards.js');

const SUITE_PROFILE_SCHEMA = 'forge-suite-profile/v1';
const LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxSuites: 5000, maxFieldLength: 200 });
const HASH_RE = /^[a-f0-9]{64}$/;
const ERROR_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()@+\-]{0,199}$/;
const CPU_MODEL_RE = /^(?!.*[\\/])[\x20-\x7e]{1,100}$/;
const ENV_ALLOWLIST = Object.freeze([
  'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB',
  'GITHUB_WORKFLOW', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_SHA',
  'GITHUB_REPOSITORY', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT', 'ImageOS', 'ImageVersion',
]);
const CI_RULES = Object.freeze([
  ['provider', 'GITHUB_ACTIONS', /^(true|false)$/],
  ['run_id', 'GITHUB_RUN_ID', /^[0-9]{1,30}$/],
  ['run_attempt', 'GITHUB_RUN_ATTEMPT', /^[0-9]{1,10}$/],
  ['job', 'GITHUB_JOB', /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,199}$/],
  ['workflow', 'GITHUB_WORKFLOW', SAFE_RE],
  ['event_name', 'GITHUB_EVENT_NAME', /^[a-z][a-z0-9_]{0,99}$/],
  ['ref', 'GITHUB_REF', /^refs\/[A-Za-z0-9_\-][A-Za-z0-9_.\/-]{0,194}$/],
  ['sha', 'GITHUB_SHA', /^[a-fA-F0-9]{40}$/],
  ['repository', 'GITHUB_REPOSITORY', /^[A-Za-z0-9_\-]{1,99}\/[A-Za-z0-9_.\-]{1,100}$/],
  ['runner_os', 'RUNNER_OS', /^(Linux|Windows|macOS)$/],
  ['runner_arch', 'RUNNER_ARCH', /^(X86|X64|ARM|ARM64)$/],
  ['runner_environment', 'RUNNER_ENVIRONMENT', /^(github-hosted|self-hosted)$/],
  ['image_os', 'ImageOS', /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}$/],
  ['image_version', 'ImageVersion', /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}$/],
]);
const CONDITION_RULES = [
  ['platform', /^[a-z][a-z0-9]{0,19}$/], ['arch', /^[a-z][a-z0-9_]{0,19}$/],
  ['node_version', /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-[A-Za-z0-9.\-]{1,60})?$/],
  ['os_release', /^[A-Za-z0-9][A-Za-z0-9_.+\-]{0,199}$/],
];

function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function plain(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
      && Object.getOwnPropertyDescriptor(value, key).enumerable);
}
function list(value, max = LIMITS.maxSuites) {
  return Array.isArray(value) && value.length <= max && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, i))
      .every(row => row && Object.hasOwn(row, 'value'));
}
function closed(value, fields, errors, label) {
  if (!plain(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    errors.push(`${label}: schema-fechado`); return false;
  }
  return true;
}
function matches(value, re, max = LIMITS.maxFieldLength) {
  return typeof value === 'string' && value.length <= max && re.test(value) && !/[\r\n]/.test(value);
}
function utc(value) {
  return matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function namedError(code, errors) {
  const error = new Error(code); error.code = code;
  if (errors) error.errors = errors;
  return error;
}

function observeCondition(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  const unavailable = {};
  function observed(field, value, re, max) {
    if (value === undefined || value === null || value === '') { unavailable[field] = 'absent'; return null; }
    if (!matches(value, re, max)) { unavailable[field] = 'invalid-format'; return null; }
    return value;
  }
  const condition = {};
  const defaults = { platform: process.platform, arch: process.arch, node_version: process.version,
    os_release: () => os.release() };
  for (const [field, re] of CONDITION_RULES) {
    const option = field === 'node_version' ? 'nodeVersion' : field === 'os_release' ? 'osRelease' : field;
    let value = Object.hasOwn(options, option) ? options[option] : defaults[field];
    try { if (typeof value === 'function') value = value(); } catch { value = null; }
    condition[field] = observed(field, value, re);
  }
  let cpus;
  try { cpus = Object.hasOwn(options, 'cpus') ? options.cpus : os.cpus();
    if (typeof cpus === 'function') cpus = cpus(); } catch { cpus = null; }
  const count = Array.isArray(cpus) && integer(cpus.length, 1, 65536) ? cpus.length : null;
  if (count === null) unavailable['cpus.count'] = cpus == null ? 'absent' : 'invalid-format';
  const model = count === null ? null : cpus[0] && cpus[0].model;
  condition.cpus = { count, model: observed('cpus.model', model, CPU_MODEL_RE, 100) };
  condition.ci = {};
  for (const [field, key, re] of CI_RULES) {
    const value = observed(`ci.${field}`, env[key], re);
    condition.ci[field] = field === 'provider' ? (value === 'true' ? 'github-actions' : null) : value;
    if (field === 'provider' && value === 'false') unavailable['ci.provider'] = 'not-github-actions';
  }
  condition.queue = { state: 'unavailable', reason: 'not-observable-inside-runner' };
  condition.cache = { state: 'unknown', reason: 'runner-does-not-observe-actions-cache' };
  condition.unavailable = unavailable;
  return condition;
}

function validateCondition(value, errors) {
  if (!closed(value, ['platform', 'arch', 'node_version', 'os_release', 'cpus', 'ci', 'queue', 'cache', 'unavailable'], errors, 'condition')) return;
  const nullable = [];
  for (const [field, re] of CONDITION_RULES) {
    nullable.push([field, value[field]]);
    if (value[field] !== null && !matches(value[field], re)) errors.push('condition: formato-invalido');
  }
  if (closed(value.cpus, ['count', 'model'], errors, 'cpus')) {
    nullable.push(['cpus.count', value.cpus.count], ['cpus.model', value.cpus.model]);
    if (value.cpus.count !== null && !integer(value.cpus.count, 1, 65536)) errors.push('cpus: contagem-invalida');
    if (value.cpus.model !== null && !matches(value.cpus.model, CPU_MODEL_RE, 100)) errors.push('cpus: modelo-invalido');
  }
  if (closed(value.ci, CI_RULES.map(row => row[0]), errors, 'ci')) for (const [field, , re] of CI_RULES) {
    nullable.push([`ci.${field}`, value.ci[field]]);
    if (value.ci[field] !== null && !(field === 'provider' ? value.ci[field] === 'github-actions' : matches(value.ci[field], re))) errors.push('ci: formato-invalido');
  }
  for (const [field, state, reason] of [['queue', 'unavailable', 'not-observable-inside-runner'],
    ['cache', 'unknown', 'runner-does-not-observe-actions-cache']]) {
    if (closed(value[field], ['state', 'reason'], errors, field)
      && (value[field].state !== state || value[field].reason !== reason)) errors.push(`${field}: estado-invalido`);
  }
  if (!plain(value.unavailable) || Object.keys(value.unavailable).length > nullable.length) errors.push('unavailable: objeto-invalido');
  else {
    const allowed = new Map(nullable);
    for (const [field, reason] of Object.entries(value.unavailable)) {
      if (!allowed.has(field) || allowed.get(field) !== null || !['absent', 'invalid-format', 'not-github-actions'].includes(reason)
        || (reason === 'not-github-actions' && field !== 'ci.provider')) errors.push('unavailable: motivo-invalido');
    }
    for (const [field, entry] of nullable) if (entry === null && !Object.hasOwn(value.unavailable, field)) errors.push('unavailable: motivo-obrigatorio');
  }
}

function validateSuiteProfile(doc) {
  const errors = [];
  if (!closed(doc, ['schema', 'started_at', 'finished_at', 'elapsed_ms', 'condition', 'selection', 'shard', 'mode', 'suites', 'totals', 'verdict'], errors, 'perfil')) return { ok: false, errors };
  if (doc.schema !== SUITE_PROFILE_SCHEMA) errors.push('schema: versao-invalida');
  if (!utc(doc.started_at) || !utc(doc.finished_at) || Date.parse(doc.started_at) > Date.parse(doc.finished_at)) errors.push('clock: intervalo-invalido');
  if (!integer(doc.elapsed_ms)) errors.push('elapsed_ms: inteiro-obrigatorio');
  validateCondition(doc.condition, errors);
  if (closed(doc.selection, ['discovered', 'selected', 'universe_sha256'], errors, 'selection')) {
    if (!integer(doc.selection.discovered, 0, LIMITS.maxSuites) || !integer(doc.selection.selected, 0, doc.selection.discovered)) errors.push('selection: contagem-invalida');
    if (doc.selection.universe_sha256 !== null && !matches(doc.selection.universe_sha256, HASH_RE)) errors.push('selection: hash-invalido');
  }
  if (doc.shard !== null && closed(doc.shard, ['index', 'count', 'algorithm', 'fallback', 'profile_sha256', 'partition_sha256', 'predicted_ms', 'unprofiled', 'stale'], errors, 'shard')) {
    const s = doc.shard;
    if (!integer(s.count, 1, 64) || !integer(s.index, 0, s.count - 1)) errors.push('shard: indice-invalido');
    if (!['positional-v1', 'weighted-lpt-v1'].includes(s.algorithm)
      || ![null, 'profile-absent', 'platform-missing', 'platform-unavailable'].includes(s.fallback)) errors.push('shard: algoritmo-invalido');
    if ((s.profile_sha256 !== null && !matches(s.profile_sha256, HASH_RE)) || !matches(s.partition_sha256, HASH_RE)) errors.push('shard: hash-invalido');
    if (!integer(s.unprofiled, 0, LIMITS.maxSuites) || !integer(s.stale, 0, LIMITS.maxSuites)
      || (s.predicted_ms !== null && !integer(s.predicted_ms, 0, LIMITS.maxSuites * 86400000))) errors.push('shard: contagem-invalida');
    if (s.algorithm === 'weighted-lpt-v1' && (s.fallback !== null || s.profile_sha256 === null || s.predicted_ms === null)) errors.push('shard: ponderado-incoerente');
    if (s.algorithm === 'positional-v1' && (s.predicted_ms !== null || s.unprofiled !== 0 || s.stale !== 0)) errors.push('shard: posicional-incoerente');
    if (plain(doc.selection) && integer(doc.selection.discovered) && s.unprofiled > doc.selection.discovered) errors.push('shard: universo-incoerente');
  }
  if (closed(doc.mode, ['baseline', 'fail_fast', 'match', 'changed', 'isolation'], errors, 'mode')) {
    if (['baseline', 'fail_fast', 'match', 'changed'].some(field => typeof doc.mode[field] !== 'boolean')
      || !['isolated-home', 'inherited-home'].includes(doc.mode.isolation)) errors.push('mode: valor-invalido');
  }
  const counts = { executed: 0, passed: 0, failed: 0, not_run: 0 };
  if (!list(doc.suites)) errors.push('suites: limite-ou-lista-invalida');
  else {
    if (!plain(doc.selection) || doc.suites.length !== doc.selection.selected) errors.push('suites: selecao-incoerente');
    const ids = new Set();
    doc.suites.forEach((suite, i) => {
      if (!closed(suite, ['id', 'ordinal', 'status', 'elapsed_ms', 'exit_code', 'signal', 'error_code'], errors, 'suite')) return;
      if (!matches(suite.id, SUITE_ID_RE) || ids.has(suite.id)) errors.push('suite: identidade-invalida');
      ids.add(suite.id);
      if (suite.ordinal !== i + 1) errors.push('suite: ordinal-invalido');
      if (!['pass', 'fail', 'not-run'].includes(suite.status)) errors.push('suite: status-invalido');
      else if (suite.status === 'not-run') {
        counts.not_run += 1;
        if (['elapsed_ms', 'exit_code', 'signal', 'error_code'].some(field => suite[field] !== null)) errors.push('suite: not-run-incoerente');
      } else {
        counts.executed += 1; counts[suite.status === 'pass' ? 'passed' : 'failed'] += 1;
        // Windows child statuses can span uint32; preserve the native value.
        if (!integer(suite.elapsed_ms) || (suite.exit_code !== null && !integer(suite.exit_code, 0, 4294967295))
          || (suite.signal !== null && !matches(suite.signal, /^SIG[A-Z0-9]{1,27}$/))
          || (suite.error_code !== null && !matches(suite.error_code, ERROR_RE))) errors.push('suite: execucao-invalida');
        if (suite.status === 'pass' && (suite.exit_code !== 0 || suite.signal !== null || suite.error_code !== null)) errors.push('suite: pass-incoerente');
        if (suite.status === 'fail' && suite.exit_code === 0 && suite.signal === null && suite.error_code === null) errors.push('suite: fail-incoerente');
      }
    });
  }
  if (closed(doc.totals, Object.keys(counts), errors, 'totals') && Object.keys(counts).some(key => doc.totals[key] !== counts[key])) errors.push('totals: contagem-incoerente');
  if (closed(doc.verdict, ['exit_code', 'baseline'], errors, 'verdict')
    && (![0, 1, 2].includes(doc.verdict.exit_code) || ![null, 'match', 'new-failures', 'stale-entries', 'new-and-stale', 'no-suites-executed'].includes(doc.verdict.baseline))) errors.push('verdict: valor-invalido');
  return { ok: errors.length === 0, errors };
}

function buildSuiteProfile(input) {
  if (!plain(input)) throw namedError('suite-profile-invalid');
  if (Array.isArray(input.suites) && input.suites.length > LIMITS.maxSuites) throw namedError('suite-profile-limit');
  const fields = ['started_at', 'finished_at', 'elapsed_ms', 'condition', 'selection', 'shard', 'mode', 'suites', 'totals', 'verdict'];
  if (Object.keys(input).some(key => !fields.includes(key) && key !== 'schema')) throw namedError('suite-profile-invalid');
  const doc = { schema: SUITE_PROFILE_SCHEMA };
  for (const field of fields) doc[field] = input[field];
  if (input.schema !== undefined && input.schema !== SUITE_PROFILE_SCHEMA) throw namedError('suite-profile-invalid');
  const result = validateSuiteProfile(doc);
  if (!result.ok) throw namedError('suite-profile-invalid', result.errors);
  if (Buffer.byteLength(JSON.stringify(doc)) > LIMITS.maxBytes) throw namedError('suite-profile-limit');
  // Copy only validated data; callers cannot mutate the original into the result.
  return JSON.parse(JSON.stringify(doc));
}

function parseSuiteProfile(text) {
  if ((typeof text !== 'string' && !Buffer.isBuffer(text))) throw namedError('suite-profile-invalid');
  if (Buffer.byteLength(text) > LIMITS.maxBytes) throw namedError('suite-profile-limit');
  let doc;
  try { doc = JSON.parse(text.toString()); } catch { throw namedError('suite-profile-invalid'); }
  if (doc && Array.isArray(doc.suites) && doc.suites.length > LIMITS.maxSuites) throw namedError('suite-profile-limit');
  const result = validateSuiteProfile(doc);
  if (!result.ok) throw namedError('suite-profile-invalid', result.errors);
  return doc;
}

function writeSuiteProfile(file, doc, options = {}) {
  let temporary;
  let created = false;
  try {
    const result = validateSuiteProfile(doc);
    if (!result.ok) return { ok: false, code: Array.isArray(doc && doc.suites) && doc.suites.length > LIMITS.maxSuites ? 'suite-profile-limit' : 'suite-profile-invalid' };
    const maxBytes = options.maxBytes === undefined ? LIMITS.maxBytes : options.maxBytes;
    if (!integer(maxBytes, 1, LIMITS.maxBytes)) return { ok: false, code: 'suite-profile-limit' };
    const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    if (bytes.length > maxBytes) return { ok: false, code: 'suite-profile-limit' };
    temporary = path.join(path.dirname(file), `.suite-profile-${crypto.randomBytes(16).toString('hex')}.tmp`);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    temporary = null;
    return { ok: true, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch { return { ok: false, code: 'suite-profile-write-failed' }; }
  finally { if (temporary && created) { try { fs.unlinkSync(temporary); } catch { /* Best effort if the filesystem refuses cleanup. */ } } }
}

module.exports = { SUITE_PROFILE_SCHEMA, LIMITS, ENV_ALLOWLIST, observeCondition,
  buildSuiteProfile, validateSuiteProfile, parseSuiteProfile, writeSuiteProfile };
