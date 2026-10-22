'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { TextDecoder } = require('util');
const { spawnSync } = require('child_process');
const POLICY = require('./forge-release-policy.js');
const checks = require('./forge-release-checks.js');
const { sha256 } = require('./forge-package.js');
const { scrubEnvironment } = require('./forge-offline-ci.js');

const ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const DEFAULT_LIMITS = Object.freeze({ deadlineMs: 1800000, requestMs: 15000, pollMs: 15000,
  maxPages: 10, maxItems: 1000, maxBytes: 32 * 1024 * 1024, responseBytes: 4 * 1024 * 1024,
  maxRequests: 10000, maxTagDepth: 8 });
const STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);
const MESSAGES = Object.freeze({ 'request-timeout': 'Consulta excedeu o prazo.', 'deadline-exhausted': 'Prazo total esgotado.',
  'transport-error': 'Falha de transporte GitHub.', 'authentication-failed': 'Acesso GitHub recusado.',
  'http-error': 'Resposta GitHub inesperada.', 'rate-limit': 'Limite temporário GitHub.',
  'snapshot-changed': 'Run ou tentativa mudou durante a coleta.',
  'current-attempt-coverage-incomplete': 'Tentativa atual incompleta; faça rerun completo.' });
function fail(code) { const error = new Error(MESSAGES[code] || 'Evidência GitHub inválida ou incompleta.'); error.code = code; throw error; }
function integer(value) { return Number.isSafeInteger(value) && value > 0; }
function segment(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\\\x00-\x20\x7f%?#]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) fail('invalid-segment');
  return encodeURIComponent(value);
}
function repoPath(repository) {
  if (!checks.sameRepository(repository, repository)) fail('repository-identity');
  return `/repos/${repository.full_name.split('/').map(segment).join('/')}`;
}
function safeUrl(value) {
  if (typeof value !== 'string' || /[\\\x00-\x20\x7f]/.test(value) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|%2f)/i.test(value)) fail('unsafe-url');
  let url; try { url = new URL(value, ORIGIN); } catch (_) { fail('unsafe-url'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith('/repos/')) fail('unsafe-url');
  return url;
}

// No redirect following, response buffering is bounded before JSON parsing.
function requestHttps({ url, headers, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET', headers, signal }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length;
        if (bytes > maxBytes) { const error = new Error(); error.code = 'response-limit'; request.destroy(error); }
        else chunks.push(chunk);
      });
      response.on('aborted', () => reject(new Error()));
      response.on('error', reject);
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => { const error = new Error(); error.code = 'request-timeout'; request.destroy(error); });
    request.on('error', reject); request.end();
  });
}

function createGitHubReader(options = {}) {
  const token = options.token;
  if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n\x00]/.test(token)) fail('authentication-failed');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const key of Object.keys(limits)) if (!Object.hasOwn(DEFAULT_LIMITS, key) || !integer(limits[key]) || limits[key] > DEFAULT_LIMITS[key]) fail('invalid-limits');
  const clock = options.clock || (() => performance.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const request = options.request || requestHttps;
  const sessions = new WeakSet();
  const startSession = () => {
    const started = clock(); if (!Number.isFinite(started)) fail('invalid-clock');
    const session = { started, observed: started, deadline: started + limits.deadlineMs, bytes: 0, requests: 0, pages: 0 };
    sessions.add(session); return session;
  };
  const remaining = session => {
    if (!sessions.has(session)) fail('invalid-session');
    const now = clock(); if (!Number.isFinite(now) || now < session.observed) fail('invalid-clock');
    session.observed = now; if (now >= session.deadline) fail('deadline-exhausted');
    return session.deadline - now;
  };
  const pause = async (session, milliseconds) => {
    const left = remaining(session);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds >= left) fail('deadline-exhausted');
    await sleep(milliseconds); remaining(session);
  };
  async function get(value, session, { allow404 = false } = {}) {
    const url = safeUrl(value).href;
    if (url.includes(token) || url.includes(encodeURIComponent(token))) fail('unsafe-url');
    let retries = 0;
    while (true) {
      const timeoutMs = Math.min(limits.requestMs, remaining(session));
      if (session.bytes >= limits.maxBytes) fail('response-limit');
      if (++session.requests > limits.maxRequests) fail('request-limit');
      const controller = new AbortController(); let timer; let response;
      try {
        response = await Promise.race([
          Promise.resolve().then(() => request({ url, method: 'GET', headers: { Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION, Authorization: `Bearer ${token}`, 'User-Agent': 'forge-release-reader' },
          timeoutMs, maxBytes: Math.min(limits.responseBytes, limits.maxBytes - session.bytes), signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error(); error.code = 'request-timeout'; reject(error); controller.abort(); }, timeoutMs); }),
        ]);
      } catch (error) {
        fail(error && ['request-timeout', 'response-limit'].includes(error.code) ? error.code : 'transport-error');
      } finally { clearTimeout(timer); }
      remaining(session);
      if (!response || !Number.isInteger(response.statusCode) || !response.headers || !['string', 'object'].includes(typeof response.body) ||
          !(typeof response.body === 'string' || Buffer.isBuffer(response.body))) fail('response-schema');
      const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
      session.bytes += bytes.length;
      if (bytes.length > limits.responseBytes || session.bytes > limits.maxBytes) fail('response-limit');
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      if (response.statusCode >= 300 && response.statusCode < 400) fail('redirect-refused');
      if (response.statusCode === 401 || response.statusCode === 403) fail('authentication-failed');
      if (response.statusCode === 429 || (response.statusCode >= 500 && response.statusCode <= 599)) {
        const retry = headers['retry-after'];
        if (retry !== undefined && (typeof retry !== 'string' || !/^\d{1,6}$/.test(retry))) fail('retry-after-invalid');
        const delay = retry === undefined ? Math.min(limits.pollMs * (2 ** Math.min(retries++, 4)), 60000) : Math.max(1, Number(retry) * 1000);
        await pause(session, delay); continue;
      }
      let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { fail('response-json'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('response-schema');
      const type = headers['content-type'];
      if (typeof type !== 'string' || !/^application\/(?:vnd\.github\+)?json(?:;|$)/i.test(type)) fail('response-content-type');
      if (response.statusCode === 404 && allow404) {
        if (data.message !== 'Not Found' || typeof data.documentation_url !== 'string' ||
            !/^https:\/\/docs\.github\.com\/rest(?:\/|$)/.test(data.documentation_url) || (data.status !== undefined && data.status !== '404')) fail('absence-unverified');
        return { absent: true, data: null, headers };
      }
      if (response.statusCode !== 200) fail('http-error');
      return { data, headers, absent: false };
    }
  }
  async function authenticate(repository, session) {
    const { data } = await get(repoPath(repository), session);
    if (!checks.sameRepository(data, repository) || data.fork !== false) fail('repository-identity');
    return { id: data.id, full_name: data.full_name, fork: false };
  }
  return Object.freeze({ get, authenticate, startSession, remaining, pause, limits: Object.freeze(limits) });
}

function paginationLinks(header, current, totalPages) {
  const expected = Number(current.searchParams.get('page'));
  if (header === undefined) { if (expected < totalPages) fail('pagination-missing'); return; }
  if (typeof header !== 'string' || header.length > 4096) fail('pagination-link');
  const relations = new Set();
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!match || relations.has(match[2])) fail('pagination-link');
    relations.add(match[2]);
    const link = safeUrl(match[1]); const page = link.searchParams.get('page');
    if (!/^[1-9]\d*$/.test(page || '') || Number(page) > totalPages) fail('pagination-link');
    const normalized = new URL(current); normalized.searchParams.set('page', page);
    if (normalized.href !== link.href || (match[2] === 'next' && Number(page) !== expected + 1) ||
        (match[2] === 'prev' && Number(page) !== expected - 1) ||
        (match[2] === 'first' && Number(page) !== 1) || (match[2] === 'last' && Number(page) !== totalPages)) fail('pagination-link');
  }
  if (relations.has('next') !== (expected < totalPages)) fail('pagination-missing');
}

async function listPages(reader, endpoint, field, session, filteredRuns = false) {
  const rows = []; const ids = new Set(); const digests = new Set(); let total; let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const url = safeUrl(endpoint); url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
    const { data, headers } = await reader.get(url.href, session); session.pages++;
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data[field])) fail('pagination-schema');
    if (total === undefined) {
      total = data.total_count; pages = Math.max(1, Math.ceil(total / 100));
      if (total > reader.limits.maxItems || pages > reader.limits.maxPages || (filteredRuns && total >= 1000)) fail('pagination-limit');
    } else if (data.total_count !== total) fail('pagination-count-changed');
    if (data[field].length !== Math.min(100, total - rows.length)) fail('pagination-incomplete');
    paginationLinks(headers.link, url, pages);
    const digest = sha256(Buffer.from(JSON.stringify(data[field])));
    if (digests.has(digest)) fail('pagination-repeated'); digests.add(digest);
    for (const row of data[field]) {
      if (!row || !integer(row.id) || ids.has(row.id)) fail('pagination-duplicate-id');
      ids.add(row.id); rows.push(row);
    }
  }
  return { rows, evidence: { pages, total_count: total, collected: rows.length, complete: true } };
}

function state(row) {
  if (!STATUSES.has(row.status) || (row.status === 'completed' ? !CONCLUSIONS.has(row.conclusion) : row.conclusion !== null)) fail('execution-state');
}
function timestamp(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
function validateRun(run, metadata, candidate) {
  if (!integer(run.id) || run.workflow_id !== metadata.id || run.path !== metadata.path || run.head_sha !== candidate.candidate_sha ||
      run.event !== 'push' || run.head_branch !== POLICY.branch || !integer(run.run_attempt) ||
      !checks.sameRepository(run.repository, candidate.repository) || run.repository.fork !== false || !checks.sameRepository(run.head_repository, candidate.repository) ||
      run.head_repository.fork !== false || !timestamp(run.created_at) || !timestamp(run.updated_at) ||
      (run.run_started_at !== null && !timestamp(run.run_started_at))) fail('run-identity');
  state(run);
  const start = Date.parse(run.run_started_at || run.created_at); const end = Date.parse(run.updated_at);
  if (start < Date.parse(run.created_at) || end < start) fail('run-timestamps');
}
function selectRun(runs) {
  if (!runs.length) return null;
  const start = run => Date.parse(run.run_started_at || run.created_at);
  const sorted = [...runs].sort((a, b) => start(b) - start(a)); const winner = sorted[0];
  for (const other of sorted.slice(1)) {
    if (start(other) === start(winner) || other.status !== 'completed' || Date.parse(other.updated_at) > start(winner)) fail('run-order-ambiguous');
  }
  return winner;
}
function runSignature(run) {
  const repo = value => [value.id, value.full_name, value.fork];
  return JSON.stringify([run.id, run.workflow_id, run.path, run.head_sha, run.head_branch, run.event,
    repo(run.repository), repo(run.head_repository), run.run_attempt, run.status, run.conclusion, run.created_at, run.updated_at, run.run_started_at]);
}
function runFact(run) {
  const repository = value => ({ id: value.id, full_name: value.full_name, fork: value.fork });
  return Object.fromEntries(['id', 'workflow_id', 'path', 'head_sha', 'head_branch', 'event', 'run_attempt', 'status',
    'conclusion', 'created_at', 'updated_at', 'run_started_at'].map(key => [key, run[key]]).concat([
    ['repository', repository(run.repository)], ['head_repository', repository(run.head_repository)],
  ]));
}
function validateJob(job, run, source) {
  if (!integer(job.id) || job.run_id !== run.id || job.head_sha !== run.head_sha || typeof job.name !== 'string' ||
      !source.jobs.some(expected => expected.name === job.name)) fail('job-identity');
  state(job);
  if ((job.run_attempt !== undefined && job.run_attempt !== run.run_attempt) ||
      (job.workflow_id !== undefined && job.workflow_id !== run.workflow_id) ||
      (job.started_at !== undefined && job.started_at !== null && !timestamp(job.started_at)) ||
      (job.completed_at !== undefined && job.completed_at !== null && !timestamp(job.completed_at))) fail('job-optional-identity');
  const base = repoPath(run.repository);
  if ((job.url !== undefined && job.url !== `${ORIGIN}${base}/actions/jobs/${job.id}`) ||
      (job.run_url !== undefined && job.run_url !== `${ORIGIN}${base}/actions/runs/${run.id}`) ||
      (job.html_url !== undefined && job.html_url !== `https://github.com/${run.repository.full_name}/actions/runs/${run.id}/job/${job.id}`) ||
      (job.check_run_url !== undefined && (typeof job.check_run_url !== 'string' ||
        !job.check_run_url.startsWith(`${ORIGIN}${base}/check-runs/`) || !/^\d+$/.test(job.check_run_url.slice(`${ORIGIN}${base}/check-runs/`.length))))) fail('job-optional-identity');
}
function diagnostic(error) {
  // Never copy response bodies, transport messages, URLs, headers or token values.
  const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(error.code) ? error.code : 'collector-error';
  return { allowed: false, retryable: code === 'snapshot-changed', reasons: [{ code, detail: MESSAGES[code] || 'Evidência GitHub inválida ou incompleta.' }] };
}

async function collectChecks(options = {}) {
  try {
    const { reader, candidate, sources, applicability } = options; const policy = options.policy || POLICY;
    checks.requireCandidate(candidate);
    const initial = checks.evaluateChecks({ candidate, sources, applicability, workflows: {} }, policy);
    if (initial.reasons.some(reason => reason.code !== 'workflow-missing')) fail('policy-unverified');
    const session = options.session || reader.startSession();
    await reader.authenticate(candidate.repository, session);
    const base = repoPath(candidate.repository); const workflows = {}; const remoteIds = new Set(); const jobIds = new Set();
    const required = ['ci', ...(initial.app_required ? ['app'] : [])]; const indices = [];
    for (const key of required) {
      const expected = policy.workflows[key]; const lookup = options.workflowIds && options.workflowIds[key] !== undefined ? options.workflowIds[key] : expected.filename;
      if (!(integer(lookup) || lookup === expected.filename)) fail('workflow-lookup');
      const { data: metadata } = await reader.get(`${base}/actions/workflows/${segment(String(lookup))}`, session);
      if (!integer(metadata.id) || (integer(lookup) && metadata.id !== lookup) || metadata.path !== expected.path ||
          metadata.state !== 'active' || remoteIds.has(metadata.id)) fail('workflow-identity');
      remoteIds.add(metadata.id);
      const endpoint = `${base}/actions/workflows/${metadata.id}/runs?head_sha=${candidate.candidate_sha}&event=push&branch=${policy.branch}`;
      const listed = await listPages(reader, endpoint, 'workflow_runs', session, true);
      for (const run of listed.rows) validateRun(run, metadata, candidate);
      listed.rows = listed.rows.map(runFact);
      const run = selectRun(listed.rows);
      indices.push({ key, metadata, endpoint, listed, run });
      if (!run) continue;
      const current = (await reader.get(`${base}/actions/runs/${run.id}`, session)).data;
      validateRun(current, metadata, candidate); if (runSignature(current) !== runSignature(run)) fail('snapshot-changed');
      const jobs = await listPages(reader, `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', session);
      const names = new Set();
      for (const job of jobs.rows) {
        validateJob(job, run, sources.workflows[key]);
        if (names.has(job.name) || jobIds.has(job.id)) fail('job-duplicate');
        names.add(job.name); jobIds.add(job.id);
      }
      if (run.status === 'completed' && jobs.rows.length !== sources.workflows[key].jobs.length) fail('current-attempt-coverage-incomplete');
      workflows[key] = { metadata: { id: metadata.id, path: metadata.path, state: metadata.state }, run,
        current_attempt: run.run_attempt, jobs_complete: true,
        jobs: jobs.rows.map(job => ({ id: job.id, run_id: job.run_id, head_sha: job.head_sha,
          name: job.name, status: job.status, conclusion: job.conclusion })),
        collection: { runs: listed.evidence, jobs: jobs.evidence },
        semantic_jobs: jobs.rows.map(job => ({ id: job.id, name: job.name,
          key: sources.workflows[key].jobs.find(expectedJob => expectedJob.name === job.name).key })) };
    }
    // Re-read every selected run and every full index after all jobs, not merely
    // before the next workflow. Another workflow's latency cannot hide a rerun.
    for (const index of indices) {
      if (index.run) {
        const current = (await reader.get(`${base}/actions/runs/${index.run.id}`, session)).data;
        validateRun(current, index.metadata, candidate);
        if (runSignature(current) !== runSignature(index.run)) fail('snapshot-changed');
      }
      const latest = await listPages(reader, index.endpoint, 'workflow_runs', session, true);
      for (const run of latest.rows) validateRun(run, index.metadata, candidate);
      const before = index.listed.rows.map(runSignature).sort(); const after = latest.rows.map(runFact).map(runSignature).sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('snapshot-changed');
    }
    reader.remaining(session);
    const facts = { candidate, sources, applicability, workflows }; const evaluation = checks.evaluateChecks(facts, policy);
    const terminal = Object.values(workflows).some(workflow => (workflow.run.status === 'completed' && workflow.run.conclusion !== 'success') ||
      workflow.jobs.some(job => job.status === 'completed' && job.conclusion !== 'success'));
    const pending = required.some(key => !workflows[key] || workflows[key].run.status !== 'completed' ||
      workflows[key].jobs.some(job => job.status !== 'completed'));
    return { allowed: evaluation.allowed, retryable: !evaluation.allowed && pending && !terminal,
      reasons: evaluation.reasons, evaluation, facts,
      snapshot: { schema_version: 1, api_version: API_VERSION, candidate_sha: candidate.candidate_sha,
        policy_sha256: checks.policyDigest(policy), sources_sha256: sha256(Buffer.from(JSON.stringify(sources))),
        workflows, complete: true, collection: { bytes: session.bytes, pages: session.pages, requests: session.requests,
          elapsed_ms: session.observed - session.started, deadline_ms: session.deadline - session.started } } };
  } catch (error) { return diagnostic(error); }
}

async function waitForChecks(options = {}) {
  const reader = options.reader; let last;
  try {
    const session = options.session || reader.startSession();
    while (true) {
      last = await collectChecks({ ...options, session });
      if (last.allowed || !last.retryable) return last;
      await reader.pause(session, reader.limits.pollMs);
    }
  } catch (error) { return { ...diagnostic(error), last_reasons: last ? last.reasons : [] }; }
}

async function inspectTagRelease(options = {}) {
  try {
    const { reader, candidate, tag } = options; checks.requireCandidate(candidate);
    if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(tag) || tag.includes('..') || tag.includes('//') ||
        tag.endsWith('.') || tag.endsWith('/') || tag.split('/').some(part => part.endsWith('.lock'))) fail('invalid-tag');
    const session = options.session || reader.startSession(); await reader.authenticate(candidate.repository, session);
    const base = repoPath(candidate.repository);
    const reference = await reader.get(`${base}/git/ref/tags/${segment(tag)}`, session, { allow404: true });
    let observed = { state: 'absent', tag_oid: null, peeled_commit: null };
    if (!reference.absent) {
      if (reference.data.ref !== `refs/tags/${tag}`) fail('tag-identity');
      let object = reference.data.object; const seen = new Set(); const tagOid = object && object.sha;
      for (let depth = 0; ; depth++) {
        if (!object || !checks.validSha(object.sha) || !['tag', 'commit'].includes(object.type) || seen.has(object.sha)) fail('tag-object');
        seen.add(object.sha);
        if (object.type === 'commit') { observed = { state: 'present', tag_oid: tagOid, peeled_commit: object.sha }; break; }
        if (depth >= reader.limits.maxTagDepth) fail('tag-depth');
        const { data } = await reader.get(`${base}/git/tags/${object.sha}`, session);
        if (data.sha !== object.sha) fail('tag-identity'); object = data.object;
      }
    }
    const release = await reader.get(`${base}/releases/tags/${segment(tag)}`, session, { allow404: true });
    let releaseFact = { state: 'absent' };
    if (!release.absent) {
      const data = release.data;
      if (!integer(data.id) || data.tag_name !== tag || typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean' ||
          typeof data.url !== 'string' || data.url !== `${ORIGIN}${base}/releases/${data.id}` || observed.state !== 'present') fail('release-identity');
      releaseFact = { state: 'present', id: data.id, tag_name: data.tag_name, draft: data.draft, prerelease: data.prerelease };
    }
    reader.remaining(session);
    return { ok: true, repository: candidate.repository, candidate_sha: candidate.candidate_sha, tag: observed, release: releaseFact };
  } catch (error) { return { ...diagnostic(error), ok: false, tag: { state: 'unknown' }, release: { state: 'unknown' } }; }
}

// This helper cannot authenticate its own candidate-controlled code. The fixed
// master workflow must bootstrap event/workflow identity before loading Node.
async function main(argv, environment = process.env) {
  if (argv.length !== 3 || argv[0] !== 'wait' || argv[1] !== '--sha' || !checks.validSha(argv[2])) fail('cli-arguments');
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  const reader = createGitHubReader({ token }); const name = environment.GITHUB_REPOSITORY;
  const id = Number(environment.GITHUB_REPOSITORY_ID);
  const repository = { id, full_name: name, fork: false }; const session = reader.startSession();
  const authenticated = await reader.authenticate(repository, session);
  const file = environment.GITHUB_EVENT_PATH;
  if (typeof file !== 'string') fail('event-unavailable');
  const { readBoundedStableFile } = require('./forge-autonomy-sources.js');
  const real = fs.realpathSync(file);
  if (fs.lstatSync(file).isSymbolicLink() || path.resolve(real).toLowerCase() !== path.resolve(file).toLowerCase()) fail('event-unavailable');
  const read = readBoundedStableFile(real, 4 * 1024 * 1024);
  if (read.error) fail('event-unavailable');
  const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer));
  // Check origin before even reading the master ref. resolveCandidate repeats
  // these checks and then performs the bounded Git ancestry/HEAD checks.
  if (environment.GITHUB_EVENT_NAME !== 'push' || environment.GITHUB_REF !== POLICY.ref || event.ref !== POLICY.ref || event.deleted !== false ||
      event.after !== argv[2] || environment.GITHUB_SHA !== argv[2] || !checks.sameRepository(event.repository, authenticated) || event.repository.fork !== false ||
      environment.GITHUB_WORKFLOW_SHA !== argv[2] || environment.GITHUB_WORKFLOW_REF !== `${name}/${POLICY.release_workflow}@${POLICY.ref}`) fail('origin-unverified');
  const gitOptions = { spawnSync: (binary, args, options) => spawnSync(binary, args, { ...options, env: scrubEnvironment(environment) }) };
  const candidate = checks.resolveCandidate({ repository, authenticated_repository: authenticated, event,
    candidate_sha: argv[2], github_sha: environment.GITHUB_SHA, event_name: environment.GITHUB_EVENT_NAME,
    ref: environment.GITHUB_REF, workflow_ref: environment.GITHUB_WORKFLOW_REF, workflow_sha: environment.GITHUB_WORKFLOW_SHA,
    trusted_master_sha: checks.gitBytes(['rev-parse', '--verify', 'refs/remotes/origin/master'], gitOptions).toString('utf8').trim() }, gitOptions);
  const sources = checks.assertPolicySources(candidate, gitOptions); const applicability = checks.resolveApplicability(candidate, gitOptions);
  return waitForChecks({ reader, candidate, sources, applicability, session });
}

module.exports = { API_VERSION, DEFAULT_LIMITS, createGitHubReader, collectChecks, waitForChecks, inspectTagRelease, main };
if (require.main === module) {
  main(process.argv.slice(2)).then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.allowed) process.exitCode = 1; })
    .catch(error => { process.stderr.write(`${JSON.stringify(diagnostic(error))}\n`); process.exitCode = 1; });
}
