#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');
const checks = require('./forge-release-checks.js');
const github = require('./forge-release-github.js');
const gate = require('./forge-release-gate.js');
const version = require('./forge-release-version.js');
const offline = require('./forge-offline-ci.js');
const packaging = require('./forge-package.js');
const { readBoundedStableFile } = require('./forge-autonomy-sources.js');

const TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{64}$/;
const SECRET = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|PRIVATE|COOKIE|AUTH|ACCESS[_-]?KEY)/i;
function fail(code) { const error = new Error('Barreira de publicação recusada.'); error.code = code; throw error; }
function requireTrue(condition, code) { if (!condition) fail(code); }
function digest(value) { return packaging.sha256(Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function inside(base, target) { const rel = path.relative(base, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }

// Check every ancestor before opening anything. Windows junctions are reported
// as links by lstat; realpath equality also rejects redirected path components.
function physical(file) {
  requireTrue(typeof file === 'string' && path.isAbsolute(file) && !/[\r\n\0]/.test(file), 'path-invalid');
  const absolute = path.resolve(file); let cursor = absolute;
  for (;;) {
    const stat = fs.lstatSync(cursor);
    requireTrue(!stat.isSymbolicLink(), 'path-link');
    requireTrue(samePath(fs.realpathSync(cursor), cursor), 'path-redirected');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  // Native canonicalization expands Windows 8.3 names; bounded stable reads use
  // this same native identity (an 8.3 spelling is not a symbolic redirect).
  return fs.realpathSync.native(absolute);
}
function readFile(file, root, limit = MAX_BYTES) {
  const base = physical(root); const target = physical(file);
  requireTrue(inside(base, target), 'path-escape');
  const read = readBoundedStableFile(target, limit, { expectedReal: target });
  requireTrue(!read.error, 'state-read');
  physical(root); physical(file);
  return read.buffer;
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (_) { fail('state-json'); }
}
function writeExclusive(file, bytes) { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
function exactSet(rows, expected, key, code) {
  requireTrue(Array.isArray(rows) && rows.length === expected.length && expected.length > 0, code);
  const keys = rows.map(row => { requireTrue(row && typeof row === 'object' && !Array.isArray(row), code); return key(row); });
  requireTrue(new Set(keys).size === expected.length && keys.every(value => expected.includes(value)), code);
}

function validateReport(report, candidate, manifest) {
  requireTrue(report && report.schema_version === gate.SCHEMA_VERSION && report.ok === true, 'report-schema');
  requireTrue(report.release && report.release.commit === candidate.candidate_sha &&
    typeof report.release.product_version === 'string' && report.release.product_version === manifest.product_version &&
    DIGEST.test(report.release.package_sha256) && report.release.package_sha256 === manifest.package_sha256, 'report-package');
  const cells = gate.HOSTS.flatMap(host => gate.PLATFORMS.map(platform => `${host}/${platform}`));
  exactSet(report.matrix, cells, row => `${row.host}/${row.platform}`, 'report-matrix');
  const suites = offline.MATRIX.suites.map(file => path.basename(file));
  for (const cell of report.matrix) {
    requireTrue(cell.ok === true, 'report-cell');
    exactSet(cell.suites, suites, row => row.name, 'report-suites');
    requireTrue(cell.suites.every(row => row.ok === true && row.status === 0 && row.signal === null), 'report-suite-state');
  }
  exactSet(report.regeneration, [...gate.PLATFORMS], row => row.platform, 'report-regeneration');
  for (const row of report.regeneration) requireTrue(row.first_changed === true && row.second_changed === false &&
    row.idempotent === true && DIGEST.test(row.tree_sha256) && row.tree_sha256 === row.repeat_tree_sha256 &&
    DIGEST.test(row.package_sha256) && row.package_sha256 === row.repeat_package_sha256, 'report-regeneration-state');
  requireTrue(report.regeneration.find(row => row.platform === 'linux').package_sha256 === manifest.package_sha256, 'report-package');
  const security = report.security;
  requireTrue(security && security.ok === true && security.relative_payload_paths === true && security.node_argv_only === true &&
    security.provider_paid_required === false && security.secrets_forwarded === false, 'report-security');
  const tree = report.tree;
  requireTrue(tree && Array.isArray(tree.before) && Array.isArray(tree.after) && tree.before.length === 0 && tree.after.length === 0 &&
    tree.clean_before === true && tree.clean_after === true && tree.stable === true, 'report-tree');
  for (const key of ['real_provider_smoke', 'real_capability_smoke']) {
    const smoke = report[key];
    requireTrue(smoke && typeof smoke.required === 'boolean' && typeof smoke.executed === 'boolean' && smoke.mode === 'manual-opt-in' &&
      (!smoke.required || (smoke.executed === true && smoke.ok === true)) && (!smoke.executed || smoke.ok === true), 'report-smoke');
  }
  return report;
}

function runtime(options, dependencies) {
  const env = options.env || process.env; const cwd = physical(options.cwd || process.cwd());
  const runnerTemp = physical(env.RUNNER_TEMP);
  requireTrue(!inside(cwd, runnerTemp), 'state-inside-checkout');
  const policy = dependencies.policy || checks.POLICY;
  const gitOptions = { cwd, policy, spawnSync: (binary, args, spawnOptions) =>
    (dependencies.spawnSync || spawnSync)(binary, args, { ...spawnOptions, env: offline.scrubEnvironment(env) }) };
  return { env, cwd, runnerTemp, policy, gitOptions, now: dependencies.now || Date.now };
}
function context(runtimeState, sha) {
  const { env, runnerTemp, gitOptions } = runtimeState;
  const event = json(readFile(env.GITHUB_EVENT_PATH, runnerTemp));
  const repository = { id: Number(env.GITHUB_REPOSITORY_ID), full_name: env.GITHUB_REPOSITORY, fork: false };
  // Identity comes from the trusted master bootstrap's live environment/event,
  // never an imported report/context JSON. Apply additionally authenticates it.
  return checks.resolveCandidate({ repository, authenticated_repository: repository, event,
    candidate_sha: sha, github_sha: env.GITHUB_SHA, event_name: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    workflow_ref: env.GITHUB_WORKFLOW_REF, workflow_sha: env.GITHUB_WORKFLOW_SHA,
    trusted_master_sha: checks.gitBytes(['rev-parse', '--verify', 'refs/remotes/origin/master'], gitOptions).toString('utf8').trim() }, gitOptions);
}
function localFacts(runtimeState, sha) {
  const candidate = context(runtimeState, sha);
  const sources = checks.assertPolicySources(candidate, runtimeState.gitOptions);
  const status = checks.gitBytes(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], runtimeState.gitOptions);
  requireTrue(status.length === 0, 'checkout-dirty');
  const tree = checks.gitBytes(['rev-parse', '--verify', 'HEAD^{tree}'], runtimeState.gitOptions).toString('utf8').trim();
  requireTrue(checks.validSha(tree), 'checkout-tree');
  const run = Number(runtimeState.env.GITHUB_RUN_ID); const attempt = Number(runtimeState.env.GITHUB_RUN_ATTEMPT);
  const key = runtimeState.env.GITHUB_JOB; const jobs = sources.workflows.release.jobs;
  const selected = jobs.filter(job => job.key === key);
  requireTrue(positive(run) && positive(attempt) && selected.length === 1 &&
    ['publisher', 'coordinator'].includes(selected[0].kind) && Object.keys(selected[0].matrix).length === 0 &&
    jobs.filter(job => job.name === selected[0].name).length === 1, 'job-identity');
  return { candidate, sources, tree, job: { run_id: run, run_attempt: attempt, key, role: selected[0].kind,
    name: selected[0].name, identity: `${run}/${attempt}/${key}` } };
}
function boundFacts(facts, runtimeState) {
  return { repository: facts.candidate.repository, workflow_ref: facts.candidate.workflow_ref,
    workflow_sha: facts.candidate.workflow_sha, candidate_sha: facts.candidate.candidate_sha,
    root: runtimeState.cwd, runner_temp: runtimeState.runnerTemp, job: facts.job, tree: facts.tree,
    policy_sha256: facts.sources.policy_sha256, sources_sha256: digest(facts.sources) };
}

function validateManifest(manifest) {
  requireTrue(manifest && manifest.schema_version === packaging.SCHEMA_VERSION && manifest.package_format === 'forge-directory-v1' &&
    typeof manifest.product_version === 'string' && version.parseTag(`v${manifest.product_version}`) &&
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 20000, 'package-schema');
  let total = 0; const names = new Set();
  for (const entry of manifest.files) {
    requireTrue(entry && packaging.COMPONENTS.includes(entry.component) && typeof entry.path === 'string' &&
      entry.path.length < 512 && entry.path.split('/').every(part => /^[A-Za-z0-9_ .@Ω+-]+$/.test(part) && part !== '.' && part !== '..') &&
      !entry.path.includes('\\') && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_BYTES && DIGEST.test(entry.sha256), 'package-entry');
    const name = `${entry.component}/${entry.path}`;
    requireTrue(!names.has(name.toLowerCase()), 'package-duplicate'); names.add(name.toLowerCase()); total += entry.bytes;
  }
  requireTrue(total <= MAX_PACKAGE_BYTES && DIGEST.test(manifest.package_sha256) &&
    packaging.packageChecksum(manifest.files) === manifest.package_sha256, 'package-checksum');
}
function materializePackage(directory, built) {
  validateManifest(built.manifest); fs.mkdirSync(directory);
  for (const entry of built.manifest.files) {
    const key = `${entry.component}/${entry.path}`; const source = built.sources.get(key);
    requireTrue(source && Buffer.isBuffer(source.bytes) && source.bytes.length === entry.bytes && digest(source.bytes) === entry.sha256, 'package-source');
    const file = path.join(directory, 'payload', ...key.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true }); physical(path.dirname(file)); writeExclusive(file, source.bytes);
  }
  writeExclusive(path.join(directory, 'manifest.json'), `${JSON.stringify(built.manifest)}\n`);
  writeExclusive(path.join(directory, 'CHECKSUMS.sha256'), built.manifest.files.map(entry => `${entry.sha256}  payload/${entry.component}/${entry.path}`).join('\n') + '\n');
}
function inspectPackage(directory, expectedDigest) {
  const bytes = readFile(path.join(directory, 'manifest.json'), directory);
  if (expectedDigest) requireTrue(digest(bytes) === expectedDigest, 'package-manifest-changed');
  const manifest = json(bytes); validateManifest(manifest);
  readFile(path.join(directory, 'CHECKSUMS.sha256'), directory);
  for (const entry of manifest.files) {
    const payload = readFile(path.join(directory, 'payload', entry.component, ...entry.path.split('/')), directory, entry.bytes);
    requireTrue(payload.length === entry.bytes && digest(payload) === entry.sha256, 'package-payload-changed');
  }
  // verify does not generate anything. Every input has already passed bounded
  // stable reads/containment; same-UID malicious races remain out of scope.
  const verified = packaging.verify(directory);
  requireTrue(verified.ok && equal(verified.manifest, manifest), 'package-verification');
  return { manifest, sha256: digest(bytes) };
}

function rejectImported(options, allowed) {
  requireTrue(options && Object.keys(options).every(key => allowed.includes(key)), 'unsupported-input');
}
async function preparePublication(options = {}, dependencies = {}) {
  rejectImported(options, ['cwd', 'env', 'sha', 'notes']);
  const env = options.env || process.env;
  requireTrue(!Object.entries(env).some(([key, value]) => SECRET.test(key) && value), 'prepare-credentials');
  const rt = runtime(options, dependencies); const started = rt.now();
  requireTrue(Number.isSafeInteger(started) && started > 0, 'clock-invalid');
  const facts = localFacts(rt, options.sha); const binding = boundFacts(facts, rt);
  const resolution = (dependencies.resolveVersion || version.resolveVersion)(rt.cwd);
  requireTrue(resolution && typeof resolution.skip === 'boolean', 'version-invalid');
  if (!resolution.skip) requireTrue(version.parseTag(resolution.new_tag) && /^v\d+\.\d+\.\d+$/.test(resolution.new_tag), 'version-invalid');
  const notes = options.notes ? readFile(path.resolve(options.notes), rt.runnerTemp) : Buffer.alloc(0);
  requireTrue(resolution.skip || options.notes, 'notes-required');
  const nonce = crypto.randomBytes(32).toString('hex');
  const directory = fs.mkdtempSync(path.join(rt.runnerTemp, 'forge-release-'));
  physical(directory); requireTrue(!inside(rt.cwd, directory), 'state-inside-checkout');
  writeExclusive(path.join(directory, 'notes.md'), notes);
  const report = await (dependencies.buildReport || gate.buildReport)({ repo: rt.cwd, env: offline.scrubEnvironment(env), allowDirty: false }, { spawnSync: rt.gitOptions.spawnSync });
  const built = (dependencies.buildPackage || packaging.build)({ repo: rt.cwd, platform: 'linux' });
  validateManifest(built.manifest);
  if (resolution.new_tag) version.checkDeclaredVersion(resolution, built.manifest.product_version);
  validateReport(report, facts.candidate, built.manifest);
  requireTrue(equal(boundFacts(localFacts(rt, options.sha), rt), binding), 'prepare-checkout-changed');
  materializePackage(path.join(directory, 'package'), built);
  const packaged = inspectPackage(path.join(directory, 'package'));
  gate.writeReport(path.join(directory, 'report.json'), report, rt.cwd);
  const reportBytes = readFile(path.join(directory, 'report.json'), directory);
  const completed = rt.now();
  requireTrue(Number.isSafeInteger(completed) && completed >= started, 'clock-invalid');
  const receipt = { schema_version: 1, nonce, state_directory: directory, binding, generation_started_at: started, generation_completed_at: completed,
    created_at: completed, expires_at: completed + TTL_MS, report_sha256: digest(reportBytes), notes_sha256: digest(notes),
    package_manifest_sha256: packaged.sha256,
    intent: { skip: resolution.skip, tag: resolution.new_tag || null, product_version: built.manifest.product_version } };
  const state = path.join(directory, 'receipt.json'); writeExclusive(state, `${JSON.stringify(receipt)}\n`);
  return { status: 'prepared', state, nonce, intent: receipt.intent, expires_at: receipt.expires_at };
}

function loadState(rt, options, previous) {
  requireTrue(typeof options.nonce === 'string' && NONCE.test(options.nonce), 'nonce-invalid');
  const state = physical(options.state); const directory = path.dirname(state);
  requireTrue(path.basename(state) === 'receipt.json' && /^forge-release-[A-Za-z0-9]+$/.test(path.basename(directory)) &&
    samePath(path.dirname(directory), rt.runnerTemp) && !inside(rt.cwd, directory), 'state-location');
  const bytes = readFile(state, rt.runnerTemp); const receipt = json(bytes);
  if (previous) requireTrue(digest(bytes) === previous.receiptDigest, 'receipt-changed');
  const now = rt.now();
  requireTrue(receipt && receipt.schema_version === 1 && receipt.nonce === options.nonce && NONCE.test(receipt.nonce), 'receipt-nonce');
  requireTrue(receipt.state_directory === directory, 'state-location');
  requireTrue([now, receipt.generation_started_at, receipt.generation_completed_at, receipt.created_at, receipt.expires_at].every(Number.isSafeInteger) &&
    receipt.generation_started_at > 0 && receipt.generation_completed_at >= receipt.generation_started_at &&
    receipt.created_at === receipt.generation_completed_at && receipt.expires_at === receipt.created_at + TTL_MS &&
    now >= receipt.created_at && now < receipt.expires_at && (!previous || now >= previous.observedAt), 'receipt-expired');
  requireTrue(receipt.binding && receipt.binding.job && receipt.binding.job.role === 'publisher', 'publisher-required');
  const facts = localFacts(rt, rt.env.GITHUB_SHA);
  requireTrue(equal(boundFacts(facts, rt), receipt.binding), 'receipt-context');
  const reportBytes = readFile(path.join(directory, 'report.json'), directory);
  const notes = readFile(path.join(directory, 'notes.md'), directory);
  requireTrue(DIGEST.test(receipt.report_sha256) && digest(reportBytes) === receipt.report_sha256, 'report-changed');
  requireTrue(DIGEST.test(receipt.notes_sha256) && digest(notes) === receipt.notes_sha256, 'notes-changed');
  requireTrue(DIGEST.test(receipt.package_manifest_sha256), 'package-manifest-changed');
  const packaged = inspectPackage(path.join(directory, 'package'), receipt.package_manifest_sha256);
  validateReport(json(reportBytes), facts.candidate, packaged.manifest);
  const intent = receipt.intent;
  requireTrue(intent && typeof intent.skip === 'boolean' && intent.product_version === packaged.manifest.product_version &&
    (intent.skip || (typeof intent.tag === 'string' && /^v\d+\.\d+\.\d+$/.test(intent.tag))), 'receipt-intent');
  if (intent.tag) version.checkDeclaredVersion({ new_tag: intent.tag, skip: intent.skip }, intent.product_version);
  return { receipt, receiptDigest: digest(bytes), facts, directory, observedAt: now };
}
async function currentRun(reader, session, loaded, rt) {
  const { candidate } = loaded.facts; const job = loaded.facts.job;
  await reader.authenticate(candidate.repository, session);
  const run = (await reader.get(`/repos/${candidate.repository.full_name}/actions/runs/${job.run_id}`, session)).data;
  requireTrue(run && run.id === job.run_id && run.run_attempt === job.run_attempt && run.head_sha === candidate.candidate_sha &&
    checks.sameRepository(run.repository, candidate.repository) && run.repository.fork === false &&
    checks.sameRepository(run.head_repository, candidate.repository) && run.head_repository.fork === false &&
    run.path === rt.policy.release_workflow && run.event === 'push' && run.head_branch === 'master' &&
    run.status === 'in_progress' && run.conclusion === null, 'publisher-run-changed');
}
async function barrier(rt, options, reader, session, previous) {
  let loaded = loadState(rt, options, previous);
  await currentRun(reader, session, loaded, rt);
  const applicability = checks.resolveApplicability(loaded.facts.candidate, rt.gitOptions);
  const remote = await github.collectChecks({ reader, session, policy: rt.policy, ...loaded.facts, applicability });
  requireTrue(remote.allowed === true, remote.reasons && remote.reasons[0] ? remote.reasons[0].code : 'remote-gates');
  let inspection = null;
  if (!loaded.receipt.intent.skip) {
    inspection = await github.inspectTagRelease({ reader, session, candidate: loaded.facts.candidate, tag: loaded.receipt.intent.tag });
    requireTrue(inspection.ok && checks.sameRepository(inspection.repository, loaded.facts.candidate.repository) &&
      inspection.candidate_sha === loaded.facts.candidate.candidate_sha, 'remote-identity');
    requireTrue(inspection.tag.state === 'absent' || inspection.tag.peeled_commit === loaded.facts.candidate.candidate_sha, 'tag-diverged');
    requireTrue(inspection.release.state === 'absent' || (inspection.tag.state === 'present' &&
      inspection.release.tag_name === loaded.receipt.intent.tag && inspection.release.draft === false && inspection.release.prerelease === false), 'release-diverged');
  }
  await currentRun(reader, session, loaded, rt);
  // Network collection takes time: never carry a pre-network local/TTL check
  // straight into an effect. Every barrier ends with a fresh local read.
  loaded = loadState(rt, options, loaded); reader.remaining(session);
  return { ...loaded, inspection };
}
function effect(kind, loaded, rt, dependencies) {
  const repo = loaded.facts.candidate.repository.full_name; const sha = loaded.facts.candidate.candidate_sha;
  const tag = loaded.receipt.intent.tag;
  const args = kind === 'tag' ? ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`] :
    ['release', 'create', tag, '--repo', repo, '--verify-tag', '--target', sha, '--title', tag, '--notes-file', path.join(loaded.directory, 'notes.md')];
  const token = rt.env.GH_TOKEN || rt.env.GITHUB_TOKEN;
  requireTrue(typeof token === 'string' && token.length > 0 && !/[\r\n\0]/.test(token), 'apply-token');
  return (dependencies.spawnSync || spawnSync)('gh', args, { cwd: rt.cwd, shell: false, windowsHide: true, encoding: 'utf8',
    timeout: 15000, maxBuffer: MAX_BYTES, env: { ...offline.scrubEnvironment(rt.env), GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } });
}
async function publishRelease(options = {}, dependencies = {}) {
  let loaded; let rt; let attempts = 0;
  try {
    rejectImported(options, ['cwd', 'env', 'state', 'nonce']); rt = runtime(options, dependencies);
    loaded = loadState(rt, options);
    // Exclusive consumption also precedes no-publication/already-published.
    const claim = path.join(loaded.directory, 'consumed.json');
    try { writeExclusive(claim, `${JSON.stringify({ nonce: options.nonce, claimed_at: rt.now(), job: loaded.facts.job })}\n`); }
    catch (_) { fail('receipt-consumed'); }
    const reader = github.createGitHubReader({ token: rt.env.GH_TOKEN || rt.env.GITHUB_TOKEN,
      request: dependencies.request, clock: dependencies.clock, limits: dependencies.limits });
    const session = reader.startSession();
    loaded = await barrier(rt, options, reader, session, loaded);
    if (loaded.receipt.intent.skip) return { status: 'no-publication', effects_attempted: 0 };
    if (loaded.inspection.release.state === 'present') return { status: 'already-published-verified', effects_attempted: 0 };
    if (loaded.inspection.tag.state === 'absent') {
      attempts++; effect('tag', loaded, rt, dependencies);
      // An HTTP conflict or timeout is never assumed successful. Exact readback
      // can establish a concurrent same-SHA ref; divergence is never repaired.
      loaded = await barrier(rt, options, reader, session, loaded);
      requireTrue(loaded.inspection.tag.state === 'present', 'tag-readback');
      if (loaded.inspection.release.state === 'present') return { status: 'already-published-verified', effects_attempted: attempts };
    }
    attempts++; const result = effect('release', loaded, rt, dependencies);
    loaded = await barrier(rt, options, reader, session, loaded);
    requireTrue(result && !result.error && !result.signal && result.status === 0 &&
      loaded.inspection.tag.state === 'present' && loaded.inspection.release.state === 'present', 'release-readback');
    return { status: 'published-verified', effects_attempted: attempts, candidate_sha: loaded.facts.candidate.candidate_sha, tag: loaded.receipt.intent.tag };
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(error.code) ? error.code : 'publication-error';
    const result = { status: attempts ? 'partial-effect' : 'blocked', reason_code: code, effects_attempted: attempts };
    if (loaded && rt) {
      try { physical(loaded.directory); writeExclusive(path.join(loaded.directory, `failure-${crypto.randomBytes(8).toString('hex')}.json`), `${JSON.stringify(result)}\n`); }
      catch (_) { /* Never overwrite state or hide the original diagnostic. */ }
    }
    return result;
  }
}

async function main(argv = process.argv.slice(2), environment = process.env, dependencies = {}) {
  const [mode, ...args] = argv; requireTrue(['prepare', 'apply'].includes(mode), 'cli-arguments');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]; const allowed = mode === 'prepare' ? ['--sha', '--notes', '--github-output'] : ['--state', '--nonce'];
    requireTrue(allowed.includes(name) && !Object.hasOwn(values, name) && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'cli-arguments');
    values[name] = args[i + 1];
  }
  const common = { env: environment, cwd: dependencies.cwd || process.cwd() };
  const result = mode === 'prepare' ? await preparePublication({ ...common, sha: values['--sha'], notes: values['--notes'] }, dependencies) :
    await publishRelease({ ...common, state: values['--state'], nonce: values['--nonce'] }, dependencies);
  if (values['--github-output']) {
    const file = physical(values['--github-output']);
    requireTrue(file === physical(environment.GITHUB_OUTPUT) && inside(physical(environment.RUNNER_TEMP), file), 'output-path');
    fs.appendFileSync(file, `state=${result.state}\nnonce=${result.nonce}\nskip=${result.intent.skip}\n`);
  }
  return result;
}

// The receipt is continuity evidence in a trusted runner, not a signature or a
// sandbox against same-UID code. Separate HTTP reads/writes are not transactional
// against external tag writers. Never move/delete a ref to imitate rollback.
module.exports = { TTL_MS, validateReport, preparePublication, publishRelease, main };
if (require.main === module) main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (['blocked', 'partial-effect'].includes(result.status)) process.exitCode = 1;
}).catch(error => { process.stderr.write(`${JSON.stringify({ status: 'blocked', reason_code: error.code || 'publication-error' })}\n`); process.exitCode = 1; });
