'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { buildShardProfile, validateShardProfile, parseShardPlanLine, planShards,
  PLATFORMS, SUITE_ID_RE, compareCodeUnits } = require('./forge-ci-shards.js');
const { parseSuiteProfile, SUITE_PROFILE_SCHEMA } = require('./forge-suite-profile.js');
const { expandJobs, POLICY } = require('./forge-release-checks.js');
const { readBoundedStableFile } = require('./forge-autonomy-sources.js');
const { discoverTests } = require('./run-tests.js');

const LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, inputs: 64, line: 64 * 1024,
  jobs: 1000, steps: 200 });
const STRATUM_FIELDS = ['source_kind', 'platform', 'job_key', 'runner_image',
  'runner_image_version', 'node_version', 'event', 'cache', 'shard_count', 'algorithm', 'universe_size'];
const WAIT_LABEL = 'Espera que inclui fila, dependências e provisionamento; aliases esperam needs.';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeText(value, max = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? value : null;
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}
function policyRows(policy = POLICY) { return Object.values(policy.workflows).flatMap(expandJobs); }
function jobIdentity(name, policy = POLICY) {
  const matches = policyRows(policy).filter(row => row.name === name);
  const row = matches.length === 1 ? matches[0] : null;
  return { semantic_key: row ? row.key : null, kind: row ? row.kind : null,
    platform: row && PLATFORMS.includes(row.matrix.platform) ? row.matrix.platform : null,
    reason: row ? null : 'name-not-in-current-policy' };
}

/** No raw log lines or captured child output are retained. */
function parseRunTestsLog(text, { name = 'input.log' } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.bytes) fail('ci-profile-input-limit');
  const result = { kind: 'run-tests-log', name: path.basename(name), job_name: null,
    platform: null, semantic_key: null, runner_image: null, runner_image_version: null,
    node_version: null, observed_from: null, observed_to: null, suites_declared: null,
    suites_observed: 0, suites_failed: 0, suites: [], failures: [], summary: null,
    shard: null, baseline: null, head_sha: null, cache: 'unknown', toolcache: 'unknown',
    ambiguous: false, anomalies: [], unavailable: {} };
  let group = null;
  let declarations = 0;
  const seen = new Set();
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (Buffer.byteLength(raw) > LIMITS.line) { result.anomalies.push('line-too-long'); continue; }
    let line = raw;
    const prefix = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z) (.*)$/.exec(line);
    let observedAt = null;
    if (prefix) {
      observedAt = timestamp(prefix[1]); line = prefix[2];
      if (observedAt) {
        if (result.observed_from === null || Date.parse(observedAt) < Date.parse(result.observed_from)) result.observed_from = observedAt;
        if (result.observed_to === null || Date.parse(observedAt) > Date.parse(result.observed_to)) result.observed_to = observedAt;
      }
    }
    line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\[[0-9;]*m/g, '');
    if (line.startsWith('##[group]')) { group = line.slice(9); continue; }
    if (line === '##[endgroup]') { group = null; continue; }
    let match;
    if ((match = /^Running (\d{1,4}) test suites? sequentially\.\.\.$/.exec(line))) {
      declarations += 1; result.suites_declared = +match[1];
    } else if ((match = /^(PASS|FAIL) (.{1,200}) \((\d{1,8})\.(\d{2})s\)$/.exec(line)) && SUITE_ID_RE.test(match[2])) {
      if (seen.has(match[2])) result.anomalies.push('duplicate-suite');
      seen.add(match[2]);
      result.suites.push({ suite: match[2], status: match[1] === 'PASS' ? 'pass' : 'fail',
        elapsed_ms: +match[3] * 1000 + +match[4] * 10, observed_at: observedAt });
    } else if (line.startsWith('Shard plan:')) {
      const shard = parseShardPlanLine(line);
      if (!shard || result.shard !== null) result.anomalies.push('invalid-or-repeated-shard-plan');
      else result.shard = shard;
    } else if ((match = /^All (\d{1,4}) suites passed in (\d+)\.(\d{2})s\.$/.exec(line))) {
      if (result.summary) result.anomalies.push('repeated-summary');
      result.summary = { executed: +match[1], failed: 0, elapsed_ms: +match[2] * 1000 + +match[3] * 10 };
    } else if ((match = /^(\d{1,4}) of (\d{1,4}) executed suites? failed in (\d+)\.(\d{2})s:$/.exec(line))) {
      if (result.summary) result.anomalies.push('repeated-summary');
      result.summary = { executed: +match[2], failed: +match[1], elapsed_ms: +match[3] * 1000 + +match[4] * 10 };
    } else if ((match = /^\s{2}- (.{1,200}) \((?:exit (\d+|unknown)|signal (SIG[A-Z0-9]+))\)$/.exec(line)) && SUITE_ID_RE.test(match[1])) {
      result.failures.push({ suite: match[1], exit_code: match[2] && match[2] !== 'unknown' ? +match[2] : null, signal: match[3] || null });
    } else if ((match = /^Complete job name: (.{1,160})$/.exec(line))) result.job_name = safeText(match[1], 160);
    else if (group === 'Runner Image' && (match = /^Image: ([A-Za-z0-9_.-]{1,100})$/.exec(line))) result.runner_image = match[1];
    else if (group === 'Runner Image' && (match = /^Version: ([A-Za-z0-9_.-]{1,100})$/.exec(line))) result.runner_image_version = match[1];
    else if ((match = /^node: (v\d+\.\d+\.\d+)$/.exec(line))) result.node_version = match[1];
    else if (/^Found in cache @ .+$/.test(line)) result.toolcache = 'hit';
    else if (/^(?:Attempting to download |Downloading node |Acquiring v\d).+$/.test(line)) result.toolcache = 'miss';
    else if (/^Cache restored (?:successfully|from key: .+).*$/.test(line) || /^Cache hit for: .+$/.test(line)) result.cache = 'hit';
    else if (/^Cache not found for input keys: .+$/.test(line)) result.cache = 'miss';
    else if ((match = /^HEAD is now at ([a-f0-9]{7,40})(?: .*)?$/.exec(line))) result.head_sha = match[1];
    else if (/^Baseline match on (?:win32|linux|darwin): .+$/.test(line)) result.baseline = 'match';
    else if (/^Baseline check FAILED/.test(line)) result.baseline = 'failed';
  }
  result.suites_observed = result.suites.length;
  result.suites_failed = result.suites.filter(row => row.status === 'fail').length;
  if (declarations !== 1) result.anomalies.push('missing-or-repeated-declaration');
  if (result.suites_declared !== result.suites_observed) result.anomalies.push('declared-count-mismatch');
  if (result.summary && (result.summary.executed !== result.suites_observed || result.summary.failed !== result.suites_failed)) result.anomalies.push('summary-count-mismatch');
  result.ambiguous = result.anomalies.length > 0;
  if (result.ambiguous) result.suites.forEach(row => { row.status = 'ambiguous'; });
  const identity = jobIdentity(result.job_name);
  result.platform = identity.platform; result.semantic_key = identity.semantic_key;
  for (const field of ['job_name', 'platform', 'runner_image', 'runner_image_version', 'node_version', 'observed_from', 'observed_to']) {
    if (result[field] === null) result.unavailable[field] = field === 'platform'
      ? (identity.reason || 'platform-not-in-policy-cell') : 'not-observed-in-log';
  }
  if (result.cache === 'unknown') result.unavailable.cache = 'no-actions-cache-output';
  result.unavailable.queue = 'not-observable-inside-runner';
  return result;
}

function normalizeClock(row, fields, pairs) {
  const result = { unavailable: {}, anomalies: [] };
  let previous = null;
  for (const field of fields) {
    result[field] = timestamp(row[field]);
    if (result[field] === null) {
      result.unavailable[field] = row[field] == null ? 'timestamp-absent' : 'timestamp-invalid';
      result.anomalies.push(`${field}:${result.unavailable[field]}`);
    } else if (previous !== null && Date.parse(result[field]) < previous) {
      result[field] = null;
      result.unavailable[field] = 'timestamps-out-of-order';
      result.anomalies.push(`${field}:timestamps-out-of-order`);
    } else {
      previous = Date.parse(result[field]);
    }
  }
  for (const [target, from, to] of pairs) {
    result[target] = null;
    if (result[from] === null || result[to] === null) result.unavailable[target] =
      [from, to].some(field => result.unavailable[field] === 'timestamps-out-of-order')
        ? 'timestamps-out-of-order' : 'timestamp-unavailable';
    else if (Date.parse(result[to]) < Date.parse(result[from])) {
      result.unavailable[target] = 'timestamps-out-of-order'; result.anomalies.push(`${target}:timestamps-out-of-order`);
    } else result[target] = Date.parse(result[to]) - Date.parse(result[from]);
  }
  return result;
}
function pageRows(doc, field, max) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc[field]) || doc[field].length > max
    || integer(doc.total_count) === null || doc[field].some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('ci-profile-page-invalid');
  return doc[field];
}
function normalizeJobs(doc, { policy = POLICY } = {}) {
  return pageRows(doc, 'jobs', LIMITS.jobs).map(row => {
    if (row.steps !== undefined && (!Array.isArray(row.steps) || row.steps.length > LIMITS.steps
      || row.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step)))) fail('ci-profile-steps-limit');
    const name = safeText(row.name);
    const identity = jobIdentity(name, policy);
    const clock = normalizeClock(row, ['created_at', 'started_at', 'completed_at'], [
      ['created_to_started_ms', 'created_at', 'started_at'], ['started_to_completed_ms', 'started_at', 'completed_at']]);
    if (identity.reason) clock.unavailable.semantic_key = identity.reason;
    if (!identity.platform) clock.unavailable.platform = identity.reason || 'platform-not-in-policy-cell';
    return { run_id: integer(row.run_id), run_attempt: integer(row.run_attempt), job_id: integer(row.id),
      name, semantic_key: identity.semantic_key, kind: identity.kind, platform: identity.platform,
      status: safeText(row.status), conclusion: safeText(row.conclusion), ...clock,
      created_to_started_label: WAIT_LABEL,
      steps: (row.steps || []).map(step => {
        const timing = normalizeClock(step, ['started_at', 'completed_at'], [['elapsed_ms', 'started_at', 'completed_at']]);
        return { number: integer(step.number), name: safeText(step.name), conclusion: safeText(step.conclusion),
          elapsed_ms: timing.elapsed_ms, unavailable: timing.unavailable, anomalies: timing.anomalies };
      }), runner: { name: safeText(row.runner_name), group: safeText(row.runner_group_name),
        labels: Array.isArray(row.labels) ? row.labels.slice(0, 100).map(value => safeText(value)).filter(Boolean) : [] } };
  });
}
function normalizeRuns(doc) {
  return pageRows(doc, 'workflow_runs', LIMITS.jobs).map(row => ({ id: integer(row.id), run_attempt: integer(row.run_attempt),
    event: safeText(row.event), status: safeText(row.status), conclusion: safeText(row.conclusion),
    head_sha: typeof row.head_sha === 'string' && /^[a-f0-9]{40}$/.test(row.head_sha) ? row.head_sha : null,
    head_branch: safeText(row.head_branch), path: safeText(row.path),
    ...normalizeClock(row, ['created_at', 'run_started_at', 'updated_at'], [
      ['created_to_run_started_ms', 'created_at', 'run_started_at'], ['updated_minus_created_ms', 'created_at', 'updated_at']]),
    created_to_run_started_label: WAIT_LABEL,
    updated_minus_created_label: 'Aproximado: updated_at menos created_at; não é duração exata de execução.' }));
}

/** Convert validated structured profiles or parsed logs to the shared shard contract. */
function observationsFrom(input, { source_index = 0, local = false } = {}) {
  const doc = input.schema === SUITE_PROFILE_SCHEMA ? parseSuiteProfile(JSON.stringify(input)) : input;
  if (local || (doc.schema === SUITE_PROFILE_SCHEMA && doc.condition.ci.provider !== 'github-actions')) return [];
  const platform = doc.schema === SUITE_PROFILE_SCHEMA ? doc.condition.platform : doc.platform;
  if (!PLATFORMS.includes(platform)) return [];
  return doc.suites.map(row => ({ platform, suite: row.id || row.suite, elapsed_ms: row.elapsed_ms,
    status: row.status, source_index }));
}

// Reject links in every component, not only the final leaf. Stable reading then
// binds the descriptor and path to the independently resolved physical file.
function explicitPath(file, output = false) {
  if (typeof file !== 'string' || !file || file.includes('\0')) fail('ci-profile-path-invalid');
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (output && index === parts.length - 1 && error.code === 'ENOENT') return absolute;
      fail('ci-profile-input-unreadable');
    }
    if (stat.isSymbolicLink()) fail('ci-profile-link-refused');
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('ci-profile-not-file');
  }
  return absolute;
}
function readInput(file) {
  const absolute = explicitPath(file);
  const read = readBoundedStableFile(absolute, LIMITS.bytes, {
    expectedReal: (fs.realpathSync.native || fs.realpathSync)(absolute),
  });
  if (read.error) fail(`ci-profile-${read.error}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer); } catch { fail('ci-profile-utf8-invalid'); }
  return { absolute, text, name: path.basename(absolute), sha256: sha256(read.buffer), bytes: read.buffer.length };
}
function sourceFrom(read, { local_platform = null } = {}) {
  const text = read.text.replace(/^\uFEFF/, '');
  let candidate = null;
  if (text.trimStart().startsWith('{')) { try { candidate = JSON.parse(text); } catch { /* A log can start with a JSON line. */ } }
  const structured = candidate && candidate.schema === SUITE_PROFILE_SCHEMA;
  const parsed = structured ? parseSuiteProfile(text) : parseRunTestsLog(text, { name: read.name });
  const ci = structured ? parsed.condition.ci : null;
  const local = local_platform !== null || (structured && ci.provider !== 'github-actions') || (!structured && parsed.job_name === null);
  const identity = structured ? { kind: 'suite-profile', name: read.name, sha256: read.sha256, bytes: read.bytes,
    platform: parsed.condition.platform, job_name: ci.job, runner_image: ci.image_os,
    runner_image_version: ci.image_version, node_version: parsed.condition.node_version,
    observed_from: parsed.started_at, observed_to: parsed.finished_at,
    suites_declared: parsed.selection.selected, suites_observed: parsed.totals.executed, suites_failed: parsed.totals.failed,
    unavailable: {} } : { kind: parsed.kind, name: read.name, sha256: read.sha256, bytes: read.bytes,
    ...Object.fromEntries(['platform', 'job_name', 'runner_image', 'runner_image_version', 'node_version',
      'observed_from', 'observed_to', 'suites_declared', 'suites_observed', 'suites_failed'].map(field => [field, parsed[field]])), unavailable: {} };
  if (local_platform !== null) identity.platform = local_platform;
  for (const [field, value] of Object.entries(identity)) if (value === null) identity.unavailable[field] = 'not-observed-in-source';
  return { identity, parsed, local, source_kind: local ? 'local' : structured ? 'suite-profile' : 'ci-log',
    event: structured ? ci.event_name : null, cache: structured ? 'unknown' : parsed.cache };
}
function profileFromSources(sources) {
  if (!sources.length || sources.length > LIMITS.inputs || sources.some(source => source.local || !PLATFORMS.includes(source.identity.platform))) fail('ci-profile-platform-required');
  const profile = buildShardProfile({ sources: sources.map(source => source.identity), observations: sources.flatMap((source, source_index) => observationsFrom(source.parsed, { source_index })) });
  if (!validateShardProfile(profile).ok) fail('ci-profile-schema-invalid');
  return profile;
}

function stratumKey(source) {
  const p = source.parsed; const structured = p.schema === SUITE_PROFILE_SCHEMA;
  const shard = p.shard;
  return { source_kind: source.source_kind, platform: source.identity.platform,
    job_key: structured ? p.condition.ci.job : p.semantic_key, runner_image: source.identity.runner_image,
    runner_image_version: source.identity.runner_image_version, node_version: source.identity.node_version,
    event: source.event, cache: source.cache, shard_count: shard ? shard.count : null,
    algorithm: shard ? shard.algorithm : null, universe_size: structured ? p.selection.discovered : shard ? shard.universe_size : null };
}
function compareStrata(before, after) {
  const differences = STRATUM_FIELDS.filter(field => field !== 'algorithm' && before.key[field] !== after.key[field]);
  // Unknown conditions cannot establish equivalence, even when both are null.
  const unknown = STRATUM_FIELDS.filter(field => field !== 'algorithm' && (before.key[field] === null
    || before.key[field] === 'unknown' || after.key[field] === null || after.key[field] === 'unknown'));
  if (differences.length || unknown.length) return { status: 'not-comparable', reasons: [...differences.map(field => `${field}:different`), ...unknown.map(field => `${field}:unavailable`)] };
  return { status: 'comparable', before_algorithm: before.key.algorithm, after_algorithm: after.key.algorithm,
    before_count: before.suites.length, after_count: after.suites.length,
    suite_delta_seconds: (after.total_suite_ms - before.total_suite_ms) / 1000 };
}
function buildProfileReport({ sources = [], jobs = [], runs = [], api_sources = [], shard_profile = null, partitions = [] } = {}) {
  const strata = [];
  sources.forEach((source, source_index) => {
    const key = stratumKey(source);
    let stratum = strata.find(row => JSON.stringify(row.key) === JSON.stringify(key));
    if (!stratum) { stratum = { key, source_indices: [], suites: [], total_suite_ms: 0, job_durations: [], unavailable: {} }; strata.push(stratum); }
    stratum.source_indices.push(source_index);
    for (const row of source.parsed.suites) {
      stratum.suites.push({ source_index, suite: row.id || row.suite, status: row.status, elapsed_ms: row.elapsed_ms,
        observed_at: row.observed_at || null });
      stratum.total_suite_ms += row.elapsed_ms || 0;
    }
    // Display names do not establish run/attempt/job identity. Keep API facts
    // in report.jobs, never attribute them to source conditions without proof.
    for (const field of STRATUM_FIELDS) if (key[field] === null || key[field] === 'unknown') stratum.unavailable[field] = 'not-observed-in-source';
    stratum.unavailable.job = 'source-job-identity-unverified';
    stratum.unavailable.queue = 'not-observable-inside-runner';
  });
  const predictions = [];
  const suites = partitions.length ? discoverTests([]) : [];
  for (const { platform, count } of partitions) {
    const positional = planShards({ suites, index: 0, count, platform });
    const weighted = planShards({ suites, index: 0, count, platform, profile: shard_profile || { state: 'absent' } });
    const weights = shard_profile && shard_profile.doc.platforms[platform];
    const positionalMs = weights && weights.status === 'observed' ? positional.shards.map(shard => shard.reduce((total, suite) => total
      + (Object.hasOwn(weights.weights_ms, suite) ? weights.weights_ms[suite] : weights.default_weight_ms), 0)) : null;
    predictions.push({ status: 'estimated', label: 'Estimativa sobre pesos históricos PASS; não é medição hospedada nem ganho comprovado.',
      platform, count, universe_size: suites.length, profile_sha256: weighted.profile_sha256,
      positional: { algorithm: positional.algorithm, suite_counts: positional.shards.map(row => row.length), predicted_ms: positionalMs },
      weighted: { algorithm: weighted.algorithm, fallback: weighted.fallback, suite_counts: weighted.shards.map(row => row.length),
        predicted_ms: weighted.predicted_ms, unprofiled: weighted.unprofiled, stale: weighted.stale } });
  }
  const comparisons = [];
  for (let i = 0; i < strata.length; i += 1) for (let j = i + 1; j < strata.length; j += 1) comparisons.push({ before: i, after: j, ...compareStrata(strata[i], strata[j]) });
  return { schema: 'forge-ci-profile-report/v1', sources: sources.map(source => source.identity), api_sources, strata, jobs, runs,
    predictions, comparisons, unavailable: { billing: 'no-billing-evidence', after: 'no-comparable-hosted-after-run',
      log_queue: 'not-observable-inside-runner', cache: 'hit-or-miss-only-with-actions-cache-output' },
    anomalies: [
      ...sources.flatMap((source, source_index) => (source.parsed.anomalies || []).map(reason => ({ source_index, reason }))),
      ...jobs.flatMap((job, job_index) => job.anomalies.map(reason => ({ job_index, reason }))),
      ...runs.flatMap((run, run_index) => run.anomalies.map(reason => ({ run_index, reason }))),
    ] };
}
function renderProfileReport(report) {
  const cell = value => value === null ? 'indisponível' : String(value).replace(/[|<>\r\n]/g, ' ');
  const lines = ['# Perfil de CI', '', 'Durações observadas, derivadas e estimadas são fatos separados.', '',
    'Espera: ' + WAIT_LABEL, '', '## Fontes', ''];
  report.sources.forEach((source, index) => lines.push(`- ${index}: ${cell(source.name)}; sha256 ${source.sha256}; ${source.bytes} bytes; job ${cell(source.job_name)}; imagem ${cell(source.runner_image)} ${cell(source.runner_image_version)}; Node ${cell(source.node_version)}.`));
  report.api_sources.forEach(source => lines.push(`- ${source.kind}: ${cell(source.name)}; sha256 ${source.sha256}; ${source.bytes} bytes.`));
  report.strata.forEach((stratum, index) => {
    lines.push('', `## Estrato ${index}`, '', ...STRATUM_FIELDS.map(field => `- ${field}: ${cell(stratum.key[field])}`),
      `- Total: ${stratum.suites.length} observações; ${stratum.total_suite_ms} ms.`, '', '| Suíte | Estado | ms |', '|---|---|---|');
    [...stratum.suites].sort((a, b) => (b.elapsed_ms || 0) - (a.elapsed_ms || 0) || compareCodeUnits(a.suite, b.suite)).slice(0, 25)
      .forEach(suite => lines.push(`| ${cell(suite.suite)} | ${suite.status} | ${cell(suite.elapsed_ms)} |`));
    for (const [field, reason] of Object.entries(stratum.unavailable)) lines.push(`- ${field}: indisponível (${reason}).`);
  });
  lines.push('', '## Jobs e runs', '');
  report.jobs.forEach(job => {
    lines.push(`- ${cell(job.name)}: espera ${cell(job.created_to_started_ms)} ms; execução ${cell(job.started_to_completed_ms)} ms.`);
    job.steps.forEach(step => lines.push(`  - ${cell(step.name)}: ${cell(step.elapsed_ms)} ms.`));
    Object.entries(job.unavailable).forEach(([field, reason]) => lines.push(`  - ${field}: indisponível (${reason}).`));
  });
  report.runs.forEach(run => {
    lines.push(`- Run ${run.id}: espera ${cell(run.created_to_run_started_ms)} ms; intervalo aproximado ${cell(run.updated_minus_created_ms)} ms.`);
    Object.entries(run.unavailable).forEach(([field, reason]) => lines.push(`  - ${field}: indisponível (${reason}).`));
  });
  lines.push('', '## Previsões estimadas', '');
  report.predictions.forEach(row => lines.push(`- ${row.platform}/${row.count}: estimated; posicional ${JSON.stringify(row.positional.predicted_ms)} ms; ponderada ${JSON.stringify(row.weighted.predicted_ms)} ms; unprofiled ${row.weighted.unprofiled.length}; stale ${row.weighted.stale.length}; perfil ${cell(row.profile_sha256)}. ${row.label}`));
  lines.push('', '## Comparações', '');
  report.comparisons.forEach(row => lines.push(`- ${row.before} → ${row.after}: ${row.status}; ${row.reasons ? row.reasons.join(', ') : `delta ${row.suite_delta_seconds} s; contagens ${row.before_count}/${row.after_count}`}.`));
  lines.push('', '## Indisponíveis e anomalias', '');
  Object.entries(report.unavailable).forEach(([field, reason]) => lines.push(`- ${field}: ${reason}.`));
  report.anomalies.forEach(row => lines.push(`- ${anomalyLabel(row)}: ${row.reason}.`));
  return `${lines.join('\n')}\n`;
}
function anomalyLabel(row) {
  if (row.source_index !== undefined) return `Fonte ${row.source_index}`;
  if (row.job_index !== undefined) return `Job ${row.job_index}`;
  return `Run ${row.run_index}`;
}

function outputPath(file, inputs) {
  const absolute = explicitPath(file, true);
  const existing = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
  for (const input of inputs) {
    if (absolute === input.absolute) fail('ci-profile-output-is-input');
    const stat = fs.statSync(input.absolute);
    if (existing && existing.ino === stat.ino && existing.dev === stat.dev) fail('ci-profile-output-is-input');
  }
  return absolute;
}
// Probe the destination directory itself: Windows can enable case sensitivity
// per directory, and other platforms may use case-insensitive volumes.
function caseInsensitiveDirectory(directory) {
  const name = '.ci-profile-case-Aa-' + crypto.randomBytes(16).toString('hex');
  const probe = path.join(directory, name);
  const alternate = path.join(directory, name.toUpperCase());
  const fd = fs.openSync(probe, 'wx', 0o600);
  try {
    const own = fs.fstatSync(fd);
    try {
      const other = fs.statSync(alternate);
      return own.dev === other.dev && own.ino === other.ino;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  } finally { fs.closeSync(fd); fs.unlinkSync(probe); }
}
function validateOutputIdentities(outputs) {
  const rows = outputs.map(file => ({ file, parent: fs.realpathSync(path.dirname(file)),
    name: path.basename(file), stat: fs.existsSync(file) ? fs.statSync(file) : null }));
  const semantics = new Map();
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i], b = rows[j];
    if (a.file === b.file || (a.stat && b.stat && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino)) fail('ci-profile-output-collision');
    const ap = fs.statSync(a.parent), bp = fs.statSync(b.parent);
    if (ap.dev !== bp.dev || ap.ino !== bp.ino || a.name.toLowerCase() !== b.name.toLowerCase()) continue;
    if (!semantics.has(a.parent)) semantics.set(a.parent, caseInsensitiveDirectory(a.parent));
    if (semantics.get(a.parent)) fail('ci-profile-output-collision');
  }
}
function writeOutput(file, text, inputs) {
  const absolute = outputPath(file, inputs);
  const temporary = path.join(path.dirname(absolute), `.ci-profile-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600); created = true;
    try { fs.writeFileSync(descriptor, text, 'utf8'); } finally { fs.closeSync(descriptor); }
    outputPath(absolute, inputs);
    fs.renameSync(temporary, absolute); created = false;
  } finally { if (created) fs.unlinkSync(temporary); }
}
function parseArgs(args) {
  const command = args[0];
  if (!['build-shard-profile', 'report'].includes(command)) fail('ci-profile-usage');
  const options = { command, input: [], 'local-log': [], jobs: [], runs: [], partition: [] };
  const repeated = ['input', 'local-log', 'jobs', 'runs', 'partition'];
  const allowed = command === 'build-shard-profile' ? ['input', 'out'] : [...repeated, 'shard-profile', 'json', 'markdown'];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index].slice(2), value = args[index + 1];
    if (!args[index].startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--')) fail('ci-profile-usage');
    if (repeated.includes(key)) options[key].push(value);
    else { if (options[key] !== undefined) fail('ci-profile-usage'); options[key] = value; }
  }
  if (command === 'build-shard-profile' && (!options.input.length || !options.out)) fail('ci-profile-usage');
  return options;
}
function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    const descriptors = options.input.map(file => ({ file, type: 'source' }));
    for (const value of options['local-log']) {
      const match = /^(win32|linux|darwin)=(.+)$/.exec(value);
      if (!match) fail('ci-profile-usage');
      descriptors.push({ file: match[2], type: 'source', local_platform: match[1] });
    }
    for (const type of ['jobs', 'runs']) options[type].forEach(file => descriptors.push({ file, type }));
    if (options['shard-profile']) descriptors.push({ file: options['shard-profile'], type: 'shard-profile' });
    if (descriptors.length > LIMITS.inputs) fail('ci-profile-input-limit');
    const reads = descriptors.map(descriptor => ({ ...descriptor, read: readInput(descriptor.file) }));
    const inputs = reads.map(row => row.read);
    const outputs = ['out', 'json', 'markdown'].filter(key => options[key]).map(key => outputPath(options[key], inputs));
    validateOutputIdentities(outputs);
    const sources = reads.filter(row => row.type === 'source').map(row => sourceFrom(row.read, { local_platform: row.local_platform || null }));
    if (options.command === 'build-shard-profile') {
      const profile = profileFromSources(sources);
      const text = `${JSON.stringify(profile, null, 2)}\n`;
      writeOutput(options.out, text, inputs);
      process.stdout.write(`Perfil de shards gerado: ${profile.sources.length} fontes; sha256 ${sha256(text)}.\n`);
    } else {
      const jobs = [], runs = []; let shardProfile = null;
      for (const row of reads) {
        if (row.type === 'jobs') jobs.push(...normalizeJobs(JSON.parse(row.read.text)));
        if (row.type === 'runs') runs.push(...normalizeRuns(JSON.parse(row.read.text)));
        if (row.type === 'shard-profile') {
          const doc = JSON.parse(row.read.text);
          if (!validateShardProfile(doc).ok) fail('ci-profile-schema-invalid');
          shardProfile = { state: 'loaded', doc, sha256: row.read.sha256 };
        }
      }
      const partitions = options.partition.map(value => {
        const match = /^(win32|linux|darwin):([1-9]\d?)$/.exec(value);
        if (!match || +match[2] > 64) fail('ci-profile-usage');
        return { platform: match[1], count: +match[2] };
      });
      const apiSources = reads.filter(row => ['jobs', 'runs'].includes(row.type)).map(row => ({
        kind: row.type, name: row.read.name, sha256: row.read.sha256, bytes: row.read.bytes }));
      const report = buildProfileReport({ sources, jobs, runs, api_sources: apiSources, shard_profile: shardProfile, partitions });
      if (options.json) writeOutput(options.json, `${JSON.stringify(report, null, 2)}\n`, inputs);
      if (options.markdown) writeOutput(options.markdown, renderProfileReport(report), inputs);
      process.stdout.write(`Perfil de CI: ${sources.length} fontes, ${report.strata.length} estratos, ${jobs.length} jobs, ${runs.length} runs, ${report.predictions.length} previsões estimadas; anomalias: ${report.anomalies.map(row => `${anomalyLabel(row)}:${row.reason}`).join(', ') || 'nenhuma'}.\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`forge-ci-profile: ${error.code && /^ci-profile-[a-z0-9_-]+$/.test(error.code) ? error.code : 'ci-profile-input-or-output-invalid'}.\n`);
    return 2;
  }
}

module.exports = { LIMITS, STRATUM_FIELDS, parseRunTestsLog, normalizeJobs, normalizeRuns,
  observationsFrom, buildProfileReport, renderProfileReport, compareStrata, readInput, sourceFrom,
  profileFromSources, main };

if (require.main === module) process.exitCode = main();
