'use strict';

const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');
const POLICY = require('./forge-release-policy.js');
const { sha256 } = require('./forge-package.js');

const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30000;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function policyDigest(policy = POLICY) { return sha256(Buffer.from(JSON.stringify(policy))); }
function validSha(value) { return typeof value === 'string' && SHA.test(value) && !/^0+$/.test(value); }
function sameRepository(left, right) {
  return !!left && !!right && positiveInteger(left.id) && left.id === right.id &&
    typeof left.full_name === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(left.full_name) && left.full_name === right.full_name;
}

// Every Git read has fixed argv, no shell, bounded output and a timeout.
function gitBytes(args, options = {}) {
  const result = (options.spawnSync || spawnSync)('git', ['-C', options.cwd || process.cwd(), ...args], {
    shell: false, windowsHide: true, encoding: null,
    timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES,
  });
  if (!result || result.error || result.status !== 0 || result.signal || result.truncated === true ||
      !Buffer.isBuffer(result.stdout) || result.stdout.length > MAX_BYTES) {
    fail('git-read-unavailable', 'Leitura Git incompleta ou indisponível.');
  }
  return result.stdout;
}

/** Context is supplied by trusted bootstrap + authenticated repository discovery.
 * It is not an authorization envelope and must never be imported from a report. */
function resolveCandidate(context = {}, options = {}) {
  const event = context.event || {};
  const repository = context.authenticated_repository;
  if (!sameRepository(repository, context.repository) || !sameRepository(repository, event.repository) || event.repository.fork !== false) {
    fail('origin-repository', 'Repositório autenticado/evento divergente ou fork.');
  }
  if (context.event_name !== POLICY.origin_event || context.ref !== POLICY.ref || event.ref !== POLICY.ref || event.deleted !== false) {
    fail('origin-event', 'Release exige push não excluído em refs/heads/master.');
  }
  const candidate = context.candidate_sha;
  if (!validSha(candidate) || context.github_sha !== candidate || event.after !== candidate || !validSha(context.trusted_master_sha)) {
    fail('origin-sha', 'SHA integral do candidato/evento/master não confere.');
  }
  const workflowRef = `${repository.full_name}/${POLICY.release_workflow}@${POLICY.ref}`;
  if (context.workflow_ref !== workflowRef || context.workflow_sha !== candidate) {
    fail('origin-workflow', 'Origem do workflow Release divergente.');
  }
  // No candidate file is executed by these checks. T04 runs trusted bootstrap
  // before loading candidate Node code; importing this module cannot prove that.
  gitBytes(['merge-base', '--is-ancestor', candidate, context.trusted_master_sha], options);
  const head = gitBytes(['rev-parse', '--verify', 'HEAD'], options).toString('utf8').trim();
  if (head !== candidate) fail('checkout-sha', 'HEAD do checkout diverge do candidato.');
  return { authenticated: true, candidate_sha: candidate, checkout_head: head,
    repository: { id: repository.id, full_name: repository.full_name },
    event_name: 'push', ref: POLICY.ref, before: event.before,
    workflow_ref: workflowRef, workflow_sha: candidate, trusted_master_sha: context.trusted_master_sha };
}

function requireCandidate(candidate) {
  if (!candidate || candidate.authenticated !== true || !validSha(candidate.candidate_sha) ||
      candidate.event_name !== 'push' || candidate.ref !== POLICY.ref ||
      candidate.workflow_sha !== candidate.candidate_sha || candidate.checkout_head !== candidate.candidate_sha ||
      !validSha(candidate.trusted_master_sha) ||
      !sameRepository(candidate.repository, candidate.repository) ||
      candidate.workflow_ref !== `${candidate.repository.full_name}/${POLICY.release_workflow}@${POLICY.ref}`) {
    fail('origin-unverified', 'Origem do candidato não autenticada.');
  }
}

function resolveApplicability(candidate, options = {}) {
  requireCandidate(candidate);
  const range = `${candidate.before}..${candidate.candidate_sha}`;
  const unavailable = reason => ({ candidate_sha: candidate.candidate_sha, app_required: true,
    reason, diff: { source: 'git-diff-before-after', range, available: false, complete: false, paths: null } });
  if (!validSha(candidate.before)) return unavailable('diff-before-unavailable');
  let bytes;
  try { bytes = gitBytes(['diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '--name-only', '--no-renames', '-z', range, '--'], options); }
  catch (_) { return unavailable('diff-interval-unavailable'); }
  // An unterminated, malformed or partial path list cannot prove an empty diff.
  if (bytes.length && bytes[bytes.length - 1] !== 0) return unavailable('diff-truncated');
  let paths;
  try { paths = bytes.length ? new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\0') : []; }
  catch (_) { return unavailable('diff-path-unknown'); }
  if (paths.some(p => !p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..'))) return unavailable('diff-path-unknown');
  return { candidate_sha: candidate.candidate_sha, app_required: paths.length !== 0,
    reason: paths.length ? 'nonempty-push' : 'complete-empty-push',
    diff: { source: 'git-diff-before-after', range, available: true, complete: true,
      bytes: bytes.length, sha256: sha256(bytes), paths } };
}

// Only matrix-variable substitution and reviewed include/cartesian forms are
// supported. No generic Actions/YAML expression evaluator is trusted here.
function expandJobs(workflow) {
  const names = new Set();
  const rows = [];
  for (const job of workflow.jobs) {
    let cells = [{}];
    if (job.matrix) {
      if (Object.keys(job.matrix).length === 1 && Array.isArray(job.matrix.include)) cells = job.matrix.include;
      else {
        for (const [key, values] of Object.entries(job.matrix)) {
          if (!Array.isArray(values) || !values.length || key === 'include' || key === 'exclude') fail('policy-matrix', 'Matriz não suportada.');
          cells = cells.flatMap(cell => values.map(value => ({ ...cell, [key]: value })));
        }
      }
    }
    if (!cells.length) fail('policy-matrix', 'Matriz vazia.');
    for (const cell of cells) {
      const render = template => String(template).replace(/\$\{\{\s*matrix\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_, key) => {
        if (!Object.hasOwn(cell, key)) fail('policy-expression', 'Variável de matriz não resolvida.');
        return String(cell[key]);
      });
      const name = render(job.name || job.key); const runner = render(job.runner);
      if (name.includes('${{') || runner.includes('${{')) fail('policy-expression', 'Expressão não suportada.');
      if (names.has(name)) fail('policy-name-ambiguous', 'Nome renderizado ambíguo.');
      names.add(name);
      rows.push({ key: job.key, name, runner, kind: job.kind, needs: job.needs, matrix: { ...cell } });
    }
  }
  return rows;
}

function assertJobMapping(source, workflow) {
  const sections = source.split(/^jobs:[ \t]*\r?$/m);
  if (sections.length !== 2) fail('policy-job-source', 'Seção jobs não suportada.');
  const blocks = [...sections[1].matchAll(/^  ([A-Za-z0-9_-]+):[ \t]*\r?\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\s\S]))/gm)];
  if (JSON.stringify(blocks.map(block => block[1])) !== JSON.stringify(workflow.jobs.map(job => job.key))) fail('policy-job-source', 'Job keys divergentes.');
  const scalar = value => {
    if (!value || /^[\[\]{}&*!|>'"#]/.test(value) || value.includes(' #') || value.includes(': ')) fail('policy-yaml-unsupported', 'Scalar YAML não suportado.');
    return /^\d+$/.test(value) ? Number(value) : value;
  };
  for (let index = 0; index < blocks.length; index++) {
    const job = workflow.jobs[index];
    const header = blocks[index][2].split(/^    steps:[ \t]*\r?$/m)[0];
    const observed = { name: undefined, runner: undefined, needs: [], matrix: null };
    const fields = new Set();
    let axis; let cell; let inPermissions = false;
    for (const raw of header.split(/\r?\n/)) {
      if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
      let match;
      if ((match = /^    (name|runs-on|needs): (.+)$/.exec(raw))) {
        if (fields.has(match[1])) fail('policy-yaml-unsupported', 'Campo de job repetido.');
        fields.add(match[1]); inPermissions = false;
        const value = scalar(match[2]);
        if (match[1] === 'name') observed.name = value;
        else if (match[1] === 'runs-on') observed.runner = value;
        else observed.needs = [value];
      } else if (/^    permissions:$/.test(raw)) {
        if (fields.has('permissions')) fail('policy-yaml-unsupported', 'Permissões repetidas.');
        fields.add('permissions'); inPermissions = true; observed.permissions = {};
      } else if (inPermissions && (match = /^      (contents|actions): (read|write)$/.exec(raw))) {
        if (Object.hasOwn(observed.permissions, match[1]) || (match[1] === 'actions' && match[2] !== 'read')) fail('policy-yaml-unsupported', 'Permissão repetida ou não suportada.');
        observed.permissions[match[1]] = match[2];
      } else if (/^    (if: .+|timeout-minutes: \d+|strategy:)$/.test(raw) || (!inPermissions && /^      (fail-fast: (true|false)|matrix:)$/.test(raw))) {
        inPermissions = false;
        // These fixed header forms do not change matrix expansion. Their exact
        // semantics/bytes (including if) remain covered by the full-blob pin.
      } else if ((match = /^        ([A-Za-z0-9_-]+):$/.exec(raw))) {
        if (!observed.matrix) observed.matrix = {};
        axis = match[1];
        if (Object.hasOwn(observed.matrix, axis)) fail('policy-yaml-unsupported', 'Eixo repetido.');
        observed.matrix[axis] = [];
      } else if ((match = /^          - (.+)$/.exec(raw)) && axis) {
        if (axis === 'include') {
          const pair = /^([A-Za-z0-9_-]+): (.+)$/.exec(match[1]);
          if (!pair) fail('policy-yaml-unsupported', 'Include inválido.');
          cell = { [pair[1]]: scalar(pair[2]) }; observed.matrix.include.push(cell);
        } else observed.matrix[axis].push(scalar(match[1]));
      } else if ((match = /^            ([A-Za-z0-9_-]+): (.+)$/.exec(raw)) && axis === 'include' && cell) {
        if (Object.hasOwn(cell, match[1])) fail('policy-yaml-unsupported', 'Coordenada repetida.');
        cell[match[1]] = scalar(match[2]);
      } else fail('policy-yaml-unsupported', `Header YAML não suportado: ${job.key}`);
    }
    if (observed.permissions) {
      if (!Object.hasOwn(observed.permissions, 'contents') || !Object.hasOwn(observed.permissions, 'actions')) fail('policy-yaml-unsupported', 'Permissões de contents/actions incompletas.');
      observed.permissions = { contents: observed.permissions.contents, actions: observed.permissions.actions };
    }
    const expected = { name: job.name, runner: job.runner, needs: job.needs, matrix: job.matrix };
    if (job.permissions) expected.permissions = { contents: job.permissions.contents, actions: job.permissions.actions };
    if (JSON.stringify(observed) !== JSON.stringify(expected)) fail('policy-job-mapping', `Mapeamento divergente: ${job.key}`);
  }
}

function assertPolicySources(candidate, options = {}) {
  requireCandidate(candidate);
  const policy = options.policy || POLICY;
  const workflows = {};
  for (const [key, workflow] of Object.entries(policy.workflows)) {
    const spec = `${candidate.candidate_sha}:${workflow.path}`;
    const oid = gitBytes(['rev-parse', '--verify', spec], options).toString('utf8').trim();
    const bytes = gitBytes(['cat-file', 'blob', spec], options);
    if (oid !== workflow.blob_oid || sha256(bytes) !== workflow.blob_sha256) fail('policy-source-drift', `Git blob divergente: ${workflow.path}`);
    // Full-byte pins bind all job names, needs, runners, matrices and expressions,
    // including unsupported syntax. New syntax stays blocked until policy review.
    assertJobMapping(bytes.toString('utf8'), workflow);
    workflows[key] = { path: workflow.path, filename: workflow.filename, blob_oid: oid,
      blob_sha256: sha256(bytes), bytes: bytes.length, jobs: expandJobs(workflow) };
  }
  return { verified: true, candidate_sha: candidate.candidate_sha, policy_sha256: policyDigest(policy), workflows };
}

function evaluateChecks(facts = {}, policy = POLICY) {
  const reasons = []; const checks = [];
  const block = (code, detail) => reasons.push({ code, detail });
  try { requireCandidate(facts.candidate); } catch (error) { block(error.code, error.message); }
  const candidate = facts.candidate || {};
  const sources = facts.sources;
  if (!sources || sources.verified !== true || sources.candidate_sha !== candidate.candidate_sha || sources.policy_sha256 !== policyDigest(policy)) block('policy-unverified', 'Fontes/política não comprovadas.');
  for (const [key, expected] of Object.entries(policy.workflows)) {
    const source = sources && sources.workflows && sources.workflows[key];
    if (!source || source.path !== expected.path || source.filename !== expected.filename || source.blob_oid !== expected.blob_oid || source.blob_sha256 !== expected.blob_sha256 ||
        JSON.stringify(source.jobs) !== JSON.stringify(expandJobs(expected))) block('policy-source-drift', key);
  }
  const applicability = facts.applicability;
  // Recompute the only allowed N/A proof instead of trusting app_required:false.
  const diff = applicability && applicability.diff;
  const empty = diff && diff.source === 'git-diff-before-after' && diff.available === true && diff.complete === true &&
    Array.isArray(diff.paths) && diff.paths.length === 0 && diff.bytes === 0 && diff.sha256 === sha256(Buffer.alloc(0)) &&
    validSha(candidate.before) && diff.range === `${candidate.before}..${candidate.candidate_sha}`;
  if (!applicability || applicability.candidate_sha !== candidate.candidate_sha || typeof applicability.app_required !== 'boolean' ||
      (!applicability.app_required && !empty) || (applicability.app_required && empty)) block('applicability-unverified', 'Aplicabilidade incompleta ou contraditória.');
  const required = ['ci', ...(applicability && applicability.app_required === false && empty ? [] : ['app'])];
  const executionIds = new Set();
  for (const key of required) {
    const workflow = facts.workflows && facts.workflows[key];
    const expected = policy.workflows[key];
    if (!workflow) { block('workflow-missing', key); continue; }
    const metadata = workflow.metadata || {}; const run = workflow.run || {};
    if (!positiveInteger(metadata.id) || metadata.path !== expected.path || metadata.state !== 'active' ||
        run.workflow_id !== metadata.id || !positiveInteger(run.id) || run.head_sha !== candidate.candidate_sha ||
        run.head_branch !== policy.branch || run.event !== 'push' || !sameRepository(run.repository, candidate.repository) ||
        (run.head_repository !== undefined && !sameRepository(run.head_repository, candidate.repository))) block('workflow-identity', key);
    if (!positiveInteger(run.run_attempt) || workflow.current_attempt !== run.run_attempt || workflow.jobs_complete !== true) block('attempt-incomplete', key);
    if (run.status !== 'completed' || run.conclusion !== 'success') block('workflow-not-success', key);
    const expectedJobs = expandJobs(expected); const byName = new Map(expectedJobs.map(job => [job.name, job]));
    const seen = new Set();
    if (!Array.isArray(workflow.jobs)) { block('jobs-missing', key); continue; }
    for (const job of workflow.jobs) {
      if (!job || typeof job !== 'object') { block('job-identity', key); continue; }
      const semantic = byName.get(job.name);
      if (!semantic) { block('job-unexpected', key); continue; }
      if (seen.has(job.name) || executionIds.has(job.id)) block('job-duplicate', `${key}/${job.name}`);
      seen.add(job.name); executionIds.add(job.id);
      if (!positiveInteger(job.id) || job.run_id !== run.id || job.head_sha !== candidate.candidate_sha) block('job-identity', `${key}/${job.name}`);
      if (job.status !== 'completed' || job.conclusion !== 'success') block('job-not-success', `${key}/${job.name}`);
      checks.push({ workflow: key, workflow_id: metadata.id, run_id: run.id, attempt: run.run_attempt,
        job_key: semantic.key, name: job.name, execution_id: job.id, kind: semantic.kind,
        status: job.status, conclusion: job.conclusion });
    }
    for (const job of expectedJobs) if (!seen.has(job.name)) block('job-missing', `${key}/${job.name}`);
  }
  return { allowed: reasons.length === 0, candidate_sha: candidate.candidate_sha,
    policy_sha256: policyDigest(policy), app_required: required.includes('app'), reasons, checks };
}

module.exports = { POLICY, MAX_BYTES, TIMEOUT_MS, assertPolicySources, evaluateChecks, expandJobs,
  assertJobMapping, gitBytes, policyDigest, requireCandidate, resolveApplicability, resolveCandidate, sameRepository, validSha };

if (require.main === module) {
  process.stderr.write('forge-release-checks: biblioteca somente leitura; forneça fatos pelas APIs exportadas.\n');
  process.exitCode = 1;
}
