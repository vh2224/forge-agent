'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const checks = require('./forge-release-checks.js');
const { sha256 } = require('./forge-package.js');
const offline = require('./forge-offline-ci.js');

const ROOT = path.resolve(__dirname, '..');
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
const REPOSITORY = { id: 42, full_name: 'example/forge-agent', fork: false };
const clone = value => JSON.parse(JSON.stringify(value));
let count = 0;
function test(name, fn) { fn(); count++; process.stdout.write(`PASS ${name}\n`); }
function context() {
  return { event_name: 'push', ref: 'refs/heads/master', repository: REPOSITORY,
    authenticated_repository: REPOSITORY, github_sha: A, candidate_sha: A,
    trusted_master_sha: C, workflow_sha: A,
    workflow_ref: 'example/forge-agent/.github/workflows/release.yml@refs/heads/master',
    event: { repository: REPOSITORY, ref: 'refs/heads/master', deleted: false, before: B, after: A,
      commits: [{ modified: ['app/first.swift'] }, { modified: ['docs/last.md'] }] } };
}
function fakeGit(output = Buffer.alloc(0), overrides = {}) {
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, options });
    assert.strictEqual(binary, 'git'); assert.strictEqual(options.shell, false);
    assert.strictEqual(options.encoding, null); assert.strictEqual(options.maxBuffer, checks.MAX_BYTES);
    assert.strictEqual(options.timeout, checks.TIMEOUT_MS);
    let stdout = output;
    if (args.includes('merge-base')) stdout = Buffer.alloc(0);
    if (args.includes('HEAD')) stdout = Buffer.from(`${A}\n`);
    return { status: 0, stdout, ...overrides };
  };
  return { spawnSync: spawn, cwd: ROOT, calls };
}
function candidate() { return checks.resolveCandidate(context(), fakeGit()); }
function sourceFacts(candidateValue, policy = checks.POLICY) {
  return { verified: true, candidate_sha: candidateValue.candidate_sha,
    policy_sha256: checks.policyDigest(policy), workflows: Object.fromEntries(Object.entries(policy.workflows).map(([key, w]) => [key,
      { path: w.path, filename: w.filename, blob_oid: w.blob_oid, blob_sha256: w.blob_sha256,
        jobs: checks.expandJobs(w) }])) };
}
function facts(appRequired = true) {
  const c = candidate();
  const applicability = checks.resolveApplicability(c, fakeGit(Buffer.from(appRequired ? 'docs/readme.md\0' : '')));
  let jobId = 100;
  const workflows = {};
  for (const [key, id] of [['ci', 1], ['app', 2]]) {
    workflows[key] = { metadata: { id, path: checks.POLICY.workflows[key].path, state: 'active' },
      run: { id: id + 10, workflow_id: id, head_sha: A, head_branch: 'master', event: 'push',
        repository: REPOSITORY, run_attempt: 2, status: 'completed', conclusion: 'success' },
      current_attempt: 2, jobs_complete: true,
      jobs: checks.expandJobs(checks.POLICY.workflows[key]).map(job => ({ id: jobId++, run_id: id + 10,
        head_sha: A, name: job.name, status: 'completed', conclusion: 'success' })) };
  }
  return { candidate: c, applicability, sources: sourceFacts(c), workflows };
}
function blocked(f, code) {
  const result = checks.evaluateChecks(f);
  assert.strictEqual(result.allowed, false);
  if (code) assert(result.reasons.some(reason => reason.code === code), JSON.stringify(result.reasons));
}

test('origin-master-exact-sha-and-workflow', () => {
  const git = fakeGit(); const result = checks.resolveCandidate(context(), git);
  assert.strictEqual(result.candidate_sha, A); assert.strictEqual(result.trusted_master_sha, C);
  assert.deepStrictEqual(git.calls.map(call => call.args.slice(2)), [
    ['merge-base', '--is-ancestor', A, C], ['rev-parse', '--verify', 'HEAD'],
  ]);
  assert.strictEqual(git.calls.length, 2);
});

test('origin-rejects-tag-pr-fork-ref-before-candidate-git', () => {
  const mutations = [
    c => { c.event_name = 'pull_request'; c.ref = 'refs/pull/1/merge'; },
    c => { c.ref = c.event.ref = 'refs/tags/v1.0.0'; },
    c => { c.ref = c.event.ref = 'refs/heads/feature'; },
    c => { c.event.repository = { ...REPOSITORY, fork: true }; },
    c => { c.repository = { ...REPOSITORY, id: 9 }; },
    c => { c.event.repository = { ...REPOSITORY, full_name: 'fork/forge-agent' }; },
    c => { delete c.authenticated_repository; }, c => { c.event.deleted = true; },
    c => { c.event.after = B; }, c => { c.github_sha = B; },
    c => { c.candidate_sha = 'aaaaaaa'; }, c => { c.trusted_master_sha = ''; },
    c => { c.workflow_sha = B; },
    c => { c.workflow_ref = 'example/forge-agent/.github/workflows/release.yml@refs/tags/v1.0.0'; },
    c => { c.workflow_ref = 'fork/forge-agent/.github/workflows/release.yml@refs/heads/master'; },
  ];
  for (const mutate of mutations) {
    const c = clone(context()); mutate(c); const git = fakeGit();
    assert.throws(() => checks.resolveCandidate(c, git)); assert.strictEqual(git.calls.length, 0);
  }
});

test('origin-ancestry-checkout-and-existing-tag-separate', () => {
  assert.throws(() => checks.resolveCandidate(context(), fakeGit(Buffer.alloc(0), { status: 1 })), { code: 'git-read-unavailable' });
  const git = fakeGit();
  const original = git.spawnSync;
  git.spawnSync = (binary, argv, options) => {
    const result = original(binary, argv, options);
    return argv.includes('HEAD') ? { ...result, stdout: Buffer.from(B) } : result;
  };
  assert.throws(() => checks.resolveCandidate(context(), git), { code: 'checkout-sha' });
  const c = context(); c.existing_tag = { name: 'v1.0.0', sha: A };
  assert.strictEqual(checks.resolveCandidate(c, fakeGit()).candidate_sha, A);
  c.ref = c.event.ref = 'refs/tags/v1.0.0';
  assert.throws(() => checks.resolveCandidate(c, fakeGit()), { code: 'origin-event' });
});

test('diff-full-push-argv-nul-renames-deletions-multicommit', () => {
  const bytes = Buffer.from('app/first.swift\0docs/last.md\0old/name.md\0new/name.md\0deleted.txt\0space and\nnewline.txt\0');
  const git = fakeGit(bytes); const result = checks.resolveApplicability(candidate(), git);
  assert.strictEqual(result.app_required, true); assert.strictEqual(result.diff.complete, true);
  assert.strictEqual(result.diff.paths.length, 6); assert(result.diff.paths.includes('app/first.swift'));
  assert.strictEqual(result.diff.sha256, sha256(bytes)); assert.strictEqual(result.diff.bytes, bytes.length);
  assert.deepStrictEqual(git.calls[0].args.slice(2), ['diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '--name-only', '--no-renames', '-z', `${B}..${A}`, '--']);
  assert(!git.calls[0].args.some(arg => arg.includes('HEAD^')));
});

test('diff-unavailable-never-empty-and-origin-unknown-blocks', () => {
  for (const before of ['0'.repeat(40), undefined, 'short']) {
    const c = candidate(); c.before = before; const git = fakeGit();
    const result = checks.resolveApplicability(c, git);
    assert.strictEqual(result.app_required, true); assert.strictEqual(result.diff.available, false);
    assert.strictEqual(git.calls.length, 0);
  }
  for (const override of [{ status: 128 }, { error: new Error('ETIMEDOUT') }, { signal: 'SIGTERM' }, { truncated: true },
    { stdout: Buffer.alloc(checks.MAX_BYTES + 1) }, { stdout: '' }]) {
    const result = checks.resolveApplicability(candidate(), fakeGit(Buffer.alloc(0), override));
    assert.strictEqual(result.app_required, true); assert.strictEqual(result.diff.complete, false);
  }
  for (const bytes of [Buffer.from('unterminated'), Buffer.from('\0'), Buffer.from('../escape\0'), Buffer.from([255, 0])]) {
    assert.strictEqual(checks.resolveApplicability(candidate(), fakeGit(bytes)).diff.available, false);
  }
  assert.throws(() => checks.resolveApplicability({}, fakeGit()), { code: 'origin-unverified' });
});

test('app-only-complete-empty-authenticated-diff-is-na', () => {
  const f = facts(false); delete f.workflows.app;
  const result = checks.evaluateChecks(f);
  assert.strictEqual(result.allowed, true); assert.strictEqual(result.app_required, false);
  for (const bytes of ['docs/readme.md\0', 'unknown/future.extension\0', '.github/workflows/ci.yml\0']) {
    assert.strictEqual(checks.resolveApplicability(candidate(), fakeGit(Buffer.from(bytes))).app_required, true);
  }
  for (const mutate of [f => { f.applicability.diff.complete = false; },
    f => { f.applicability.diff.sha256 = 'bogus'; }, f => { f.applicability.diff.paths = ['docs.md']; },
    f => { f.applicability.diff.range = `${A}..${A}`; }, f => { f.applicability.candidate_sha = B; }]) {
    const changed = facts(false); mutate(changed); blocked(changed, 'applicability-unverified');
  }
  const unknown = facts(); unknown.applicability = checks.resolveApplicability(candidate(), fakeGit(Buffer.alloc(0), { status: 128 }));
  assert.strictEqual(checks.evaluateChecks(unknown).allowed, true);
  delete unknown.workflows.app; blocked(unknown, 'workflow-missing');
});

test('policy-matrix-14-ci-one-native-app-and-local-inventory', () => {
  const ci = checks.expandJobs(checks.POLICY.workflows.ci);
  assert.strictEqual(ci.length, 14); assert.strictEqual(ci.filter(job => job.kind === 'native').length, 7);
  assert.strictEqual(ci.filter(job => job.kind === 'alias').length, 7);
  assert.strictEqual(new Set(ci.map(job => job.name)).size, 14);
  assert.deepStrictEqual(ci.filter(job => job.key === 'test').map(job => job.name), [
    'Tests (ubuntu-latest)', 'Tests (macos-latest)', 'Tests (windows-latest, shard 1/2)', 'Tests (windows-latest, shard 2/2)',
  ]);
  assert.deepStrictEqual(ci.filter(job => job.key === 'required-offline-windows').map(job => job.needs), Array(6).fill(['operational-offline']));
  assert.deepStrictEqual(checks.expandJobs(checks.POLICY.workflows.app).map(job => [job.key, job.runner, job.kind]), [['app', 'macos-26', 'native']]);
  assert.deepStrictEqual(checks.POLICY.local.suites, offline.MATRIX.suites);
  assert.strictEqual(checks.POLICY.local.hosts.length * checks.POLICY.local.platforms.length, 6);
  assert.strictEqual(checks.POLICY.local.regeneration_platforms.length, 3);
  for (const key of ['version', 'tree', 'regeneration', 'package', 'security', 'ci_baseline']) assert(checks.POLICY.local[key]);
  assert.strictEqual(checks.POLICY.local.real_provider_smoke, 'manual-opt-in');
  assert.strictEqual(checks.POLICY.local.offline_kind, 'simulation');
  assert(checks.POLICY.local.ci_baseline.includes('stale'));
  assert(Object.isFrozen(checks.POLICY.workflows.ci.jobs));
});

test('policy-synthetic-candidate-bytes-mapping-and-checkout-eol-independent', () => {
  // Explicit synthetic provenance: these fixture bytes are NOT committed Git blobs.
  const policy = clone(checks.POLICY);
  const blobs = {};
  for (const workflow of Object.values(policy.workflows)) {
    const bytes = Buffer.from(fs.readFileSync(path.join(ROOT, workflow.path), 'utf8').replace(/\r\n/g, '\n'));
    workflow.blob_oid = require('crypto').createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    workflow.blob_sha256 = sha256(bytes);
    blobs[workflow.path] = bytes;
  }
  const synthetic = { ...fakeGit(), policy };
  synthetic.spawnSync = (binary, argv, options) => {
    assert.strictEqual(binary, 'git'); assert.strictEqual(options.shell, false);
    const workflow = Object.values(policy.workflows).find(w => argv[argv.length - 1] === `${A}:${w.path}`);
    assert(workflow, 'synthetic candidate path must match fixture');
    return { status: 0, stdout: argv.includes('cat-file') ? blobs[workflow.path] : Buffer.from(workflow.blob_oid) };
  };
  const source = checks.assertPolicySources(candidate(), synthetic);
  assert.strictEqual(source.verified, true);
  assert.strictEqual(source.workflows.ci.jobs.length, 14);
  for (const [key, workflow] of Object.entries(policy.workflows)) {
    const bytes = blobs[workflow.path];
    assert.notStrictEqual(sha256(bytes), sha256(Buffer.from(bytes.toString().replace(/\n/g, '\r\n'))));
    assert.strictEqual(source.workflows[key].blob_sha256, sha256(bytes));
    const altered = { ...synthetic, spawnSync: (...args) => {
      const result = synthetic.spawnSync(...args);
      return args[1].includes('cat-file') ? { ...result, stdout: Buffer.concat([result.stdout, Buffer.from(' ')]) } : result;
    } };
    assert.throws(() => checks.assertPolicySources(candidate(), altered), { code: 'policy-source-drift' });
  }
});

const committedHead = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false });
assert.strictEqual(committedHead.status, 0);
const committedCandidate = { ...candidate(), candidate_sha: committedHead.stdout.trim(),
  checkout_head: committedHead.stdout.trim(), workflow_sha: committedHead.stdout.trim() };
const committedMatches = Object.values(checks.POLICY.workflows).every(workflow => {
  const oid = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${committedCandidate.candidate_sha}:${workflow.path}`], { encoding: 'utf8', shell: false });
  const blob = spawnSync('git', ['-C', ROOT, 'cat-file', 'blob', `${committedCandidate.candidate_sha}:${workflow.path}`], { shell: false });
  assert.strictEqual(oid.status, 0); assert.strictEqual(blob.status, 0);
  return oid.stdout.trim() === workflow.blob_oid && sha256(blob.stdout) === workflow.blob_sha256;
});
test(committedMatches ? 'policy-committed-head-source-matches' : 'policy-pending-source-drift-rejected-at-committed-head', () => {
  if (committedMatches) {
    const source = checks.assertPolicySources(committedCandidate, { cwd: ROOT });
    assert.strictEqual(source.verified, true);
    assert.strictEqual(source.workflows.ci.jobs.length, 14);
  } else {
    assert.throws(() => checks.assertPolicySources(committedCandidate, { cwd: ROOT }), { code: 'policy-source-drift' });
  }
});

test('policy-new-job-source-name-matrix-and-unsupported-syntax-block', () => {
  const policy = checks.POLICY.workflows.app;
  const source = 'jobs:\n  app:\n    name: Swift app and PTY regressions\n    runs-on: macos-26\n    steps:\n      - run: true\n';
  checks.assertJobMapping(source, policy);
  for (const changed of [source.replace('macos-26', 'ubuntu-latest'), source.replace('Swift app and PTY regressions', 'alias'),
    `${source}  new-job:\n    runs-on: ubuntu-latest\n    steps:\n`, source.replace('    steps:', '    strategy: { matrix: unknown }\n    steps:')]) {
    assert.throws(() => checks.assertJobMapping(changed, policy));
  }
  const duplicate = clone(checks.POLICY.workflows.app); duplicate.jobs.push(clone(duplicate.jobs[0]));
  assert.throws(() => checks.expandJobs(duplicate), { code: 'policy-name-ambiguous' });
  const unsupported = clone(checks.POLICY.workflows.app); unsupported.jobs[0].name = '${{ github.event.anything }}';
  assert.throws(() => checks.expandJobs(unsupported), { code: 'policy-expression' });
});

test('policy-bounded-coordinator-publisher-permissions-and-needs', () => {
  const workflow = { jobs: [
    { key: 'coordinator', runner: 'ubuntu-latest', needs: [], matrix: null, permissions: { contents: 'read', actions: 'read' } },
    { key: 'publisher', runner: 'ubuntu-latest', needs: ['coordinator'], matrix: null, permissions: { contents: 'write', actions: 'read' } },
  ] };
  const source = 'jobs:\n  coordinator:\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n    permissions:\n      contents: read\n      actions: read\n    steps:\n      - run: true\n\n  publisher:\n    needs: coordinator\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n    permissions:\n      actions: read\n      contents: write\n    steps:\n      - run: true\n';
  checks.assertJobMapping(source, workflow);
  for (const changed of [source.replace('      contents: write', '      contents: read'),
    source.replace('      contents: write', '      contents: write\n      contents: write'),
    source.replace('      actions: read', '      actions: write'),
    source.replace('      contents: write', '      issues: write'),
    source.replace('      actions: read\n', ''),
    source.replace('    permissions:', '    permissions: write-all'),
    source.replace('    permissions:', '    permissions:\n      contents: read\n    permissions:'),
    source.replace('    needs: coordinator', '    needs: [coordinator]')]) {
    assert.throws(() => checks.assertJobMapping(changed, workflow));
  }
});

test('checks-complete-current-attempt-source-key-name-execution-id', () => {
  const f = facts(); const result = checks.evaluateChecks(f);
  assert.strictEqual(result.allowed, true); assert.strictEqual(result.checks.length, 15);
  const job = result.checks.find(item => item.name === 'Tests (windows-latest, shard 1/2)');
  assert.strictEqual(job.job_key, 'test'); assert.strictEqual(job.kind, 'native');
  assert.strictEqual(job.execution_id, f.workflows.ci.jobs.find(item => item.name === job.name).id);
  assert.strictEqual(job.attempt, 2); assert.strictEqual(job.run_id, 11);
  assert(!('run_attempt' in f.workflows.ci.jobs[0])); assert(!('job_key' in f.workflows.ci.jobs[0]));
  const again = checks.evaluateChecks(f); assert.deepStrictEqual(again, result);
});

test('checks-every-nonsuccess-pending-unknown-blocks-run-and-job', () => {
  const states = ['skipped', 'neutral', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale', null, undefined, 'unknown'];
  for (const conclusion of states) {
    const f = facts(); f.workflows.ci.jobs[0].conclusion = conclusion; blocked(f, 'job-not-success');
    const run = facts(); run.workflows.ci.run.conclusion = conclusion; blocked(run, 'workflow-not-success');
  }
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', undefined, 'unknown']) {
    const f = facts(); f.workflows.ci.jobs[0].status = status; blocked(f, 'job-not-success');
    const run = facts(); run.workflows.ci.run.status = status; blocked(run, 'workflow-not-success');
  }
});

test('checks-missing-native-alias-only-duplicate-new-job-block', () => {
  const aliases = facts(); aliases.workflows.ci.jobs = aliases.workflows.ci.jobs.filter(job =>
    checks.expandJobs(checks.POLICY.workflows.ci).find(row => row.name === job.name).kind === 'alias');
  blocked(aliases, 'job-missing');
  const duplicate = facts(); duplicate.workflows.ci.jobs.push(clone(duplicate.workflows.ci.jobs[0])); blocked(duplicate, 'job-duplicate');
  const duplicateId = facts(); duplicateId.workflows.ci.jobs[1].id = duplicateId.workflows.ci.jobs[0].id; blocked(duplicateId, 'job-duplicate');
  const extra = facts(); extra.workflows.ci.jobs.push({ ...extra.workflows.ci.jobs[0], id: 9999, name: 'New required gate' }); blocked(extra, 'job-unexpected');
  const absent = facts(); delete absent.workflows.ci; blocked(absent, 'workflow-missing');
  const incomplete = facts(); incomplete.workflows.ci.jobs_complete = false; blocked(incomplete, 'attempt-incomplete');
  const old = facts(); old.workflows.ci.current_attempt = 3; blocked(old, 'attempt-incomplete');
});

test('checks-foreign-repository-workflow-sha-run-id-and-source-block', () => {
  const mutations = [
    [f => { f.workflows.ci.run.repository = { ...REPOSITORY, id: 43 }; }, 'workflow-identity'],
    [f => { f.workflows.ci.run.head_repository = { ...REPOSITORY, id: 43 }; }, 'workflow-identity'],
    [f => { f.workflows.ci.metadata.path = '.github/workflows/evil.yml'; }, 'workflow-identity'],
    [f => { f.workflows.ci.metadata.state = 'disabled_manually'; }, 'workflow-identity'],
    [f => { f.workflows.ci.run.workflow_id = 99; }, 'workflow-identity'],
    [f => { f.workflows.ci.run.head_sha = B; }, 'workflow-identity'],
    [f => { f.workflows.ci.run.event = 'pull_request'; }, 'workflow-identity'],
    [f => { f.workflows.ci.run.head_branch = 'feature'; }, 'workflow-identity'],
    [f => { f.workflows.ci.jobs[0].head_sha = B; }, 'job-identity'],
    [f => { f.workflows.ci.jobs[0].run_id = 999; }, 'job-identity'],
    [f => { f.workflows.ci.jobs[0].id = 'operational-offline'; }, 'job-identity'],
    [f => { f.sources.workflows.ci.blob_sha256 = '0'.repeat(64); }, 'policy-source-drift'],
    [f => { f.sources.workflows.ci.jobs[0].kind = 'alias'; }, 'policy-source-drift'],
    [f => { f.sources.policy_sha256 = '0'.repeat(64); }, 'policy-unverified'],
    [f => { delete f.sources; }, 'policy-unverified'],
    [f => { f.candidate.authenticated = false; }, 'origin-unverified'],
  ];
  for (const [mutate, code] of mutations) { const f = facts(); mutate(f); blocked(f, code); }
});

test('documentation-public-api-and-directed-contract-links', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'shared/forge-release-checks.md'), 'utf8');
  for (const name of ['resolveCandidate', 'resolveApplicability', 'assertPolicySources', 'evaluateChecks']) {
    assert.strictEqual(typeof checks[name], 'function'); assert(doc.includes(name));
  }
  assert.strictEqual(checks.POLICY, require('./forge-release-policy.js'));
  for (const key of ['ci', 'app', 'release']) assert(doc.includes(checks.POLICY.workflows[key].path));
});

process.stdout.write(`${count} release policy/check contract tests passed (offline, no transport or publication effects).\n`);
