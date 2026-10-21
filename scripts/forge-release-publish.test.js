'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const publisher = require('./forge-release-publish.js');
const checks = require('./forge-release-checks.js');
const github = require('./forge-release-github.js');
const gate = require('./forge-release-gate.js');
const offline = require('./forge-offline-ci.js');
const packaging = require('./forge-package.js');
const version = require('./forge-release-version.js');
const { VERSION } = require('./forge-version.js');

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
const REPO = { id: 42, full_name: 'example/forge-agent', fork: false };
const BASE = '/repos/example/forge-agent'; const TAG = `v${VERSION}`;
const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write(`PASS ${name}\n`); }

function completeReport(manifest) {
  return { schema_version: gate.SCHEMA_VERSION, ok: true,
    release: { commit: A, product_version: manifest.product_version, package_sha256: manifest.package_sha256 },
    matrix: gate.HOSTS.flatMap(host => gate.PLATFORMS.map(platform => ({ host, platform, ok: true,
      suites: offline.MATRIX.suites.map(file => ({ name: path.basename(file), ok: true, status: 0, signal: null })) }))),
    regeneration: gate.PLATFORMS.map(platform => ({ platform, first_changed: true, second_changed: false, idempotent: true,
      tree_sha256: 'd'.repeat(64), repeat_tree_sha256: 'd'.repeat(64), package_sha256: manifest.package_sha256, repeat_package_sha256: manifest.package_sha256 })),
    security: { ok: true, relative_payload_paths: true, node_argv_only: true, provider_paid_required: false, secrets_forwarded: false },
    tree: { before: [], after: [], clean_before: true, clean_after: true, stable: true },
    real_provider_smoke: { required: false, executed: false, mode: 'manual-opt-in' },
    real_capability_smoke: { required: false, executed: false, mode: 'manual-opt-in' } };
}

function fixture(options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-publish-test-')));
  const cwd = path.join(root, 'checkout'); const temp = path.join(root, 'temp');
  fs.mkdirSync(cwd); fs.mkdirSync(temp);
  const event = { repository: clone(REPO), ref: 'refs/heads/master', deleted: false, before: B, after: A };
  const eventPath = path.join(temp, 'event.json'); fs.writeFileSync(eventPath, JSON.stringify(event));
  const notes = path.join(temp, 'input-notes.md'); fs.writeFileSync(notes, 'Pinned release notes\n');
  const env = { RUNNER_TEMP: temp, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY_ID: '42', GITHUB_REPOSITORY: REPO.full_name,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: event.ref, GITHUB_SHA: A, GITHUB_WORKFLOW_SHA: A,
    GITHUB_WORKFLOW_REF: `${REPO.full_name}/.github/workflows/release.yml@refs/heads/master`,
    GITHUB_RUN_ID: '303', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'publisher' };
  const policy = clone(checks.POLICY);
  const releaseSource = 'name: Release\non:\n  push:\n    branches: [master]\njobs:\n  coordinator:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  publisher:\n    needs: coordinator\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n';
  policy.workflows.release.jobs = [
    { key: 'coordinator', kind: 'coordinator', runner: 'ubuntu-latest', needs: [], matrix: null },
    { key: 'publisher', kind: 'publisher', runner: 'ubuntu-latest', needs: ['coordinator'], matrix: null },
  ];
  const blobs = {};
  for (const [key, workflow] of Object.entries(policy.workflows)) {
    const content = key === 'release' ? Buffer.from(releaseSource) : fs.readFileSync(path.join(ROOT, workflow.path));
    // Use physical fixture bytes, including checkout EOL, in its explicit policy.
    workflow.blob_sha256 = packaging.sha256(content); blobs[workflow.path] = content;
  }
  const bytes = Buffer.from('fixture package payload');
  const files = [{ component: 'core', path: 'VERSION', bytes: bytes.length, sha256: packaging.sha256(bytes) }];
  const manifest = { schema_version: packaging.SCHEMA_VERSION, product_version: VERSION, package_format: 'forge-directory-v1',
    files, package_sha256: packaging.packageChecksum(files) };
  const state = { time: 1000000, monotonic: 0, head: A, tree: C, dirty: '', diff: Buffer.from('README.md\0'),
    generates: 0, builds: 0, mutations: [], calls: [], gitCalls: [], tag: null, release: null, runAttempt: 2,
    versionCalls: 0, skip: false, runs: {}, jobs: {}, hook: null, effectHook: null, reportHook: null, packageHook: null };
  for (const [key, workflowId, runId] of [['ci', 11, 101], ['app', 22, 202]]) {
    state.runs[key] = [{ id: runId, workflow_id: workflowId, path: policy.workflows[key].path,
      head_sha: A, head_branch: 'master', event: 'push', repository: clone(REPO), head_repository: clone(REPO),
      run_attempt: 2, status: 'completed', conclusion: 'success', created_at: '2026-10-20T00:00:00Z',
      run_started_at: '2026-10-20T00:01:00Z', updated_at: '2026-10-20T00:02:00Z' }];
    state.jobs[key] = checks.expandJobs(policy.workflows[key]).map((job, index) => ({ id: workflowId * 1000 + index,
      run_id: runId, head_sha: A, name: job.name, status: 'completed', conclusion: 'success' }));
  }
  const notFound = () => ({ statusCode: 404, data: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' } });
  async function request(input) {
    state.calls.push(input); assert.strictEqual(input.method, 'GET');
    assert.strictEqual(new URL(input.url).origin, 'https://api.github.com');
    const url = new URL(input.url); let response; let kind;
    if (url.pathname === BASE) { kind = 'repository'; response = { data: clone(REPO) }; }
    else if (/\/actions\/workflows\/(ci\.yml|app\.yml)$/.test(url.pathname)) {
      kind = 'metadata'; const key = url.pathname.endsWith('/ci.yml') ? 'ci' : 'app';
      response = { data: { id: key === 'ci' ? 11 : 22, path: policy.workflows[key].path, state: 'active' } };
    } else if (/\/actions\/workflows\/(11|22)\/runs$/.test(url.pathname)) {
      kind = 'runs'; const key = url.pathname.includes('/11/') ? 'ci' : 'app';
      response = { data: { total_count: state.runs[key].length, workflow_runs: clone(state.runs[key]) } };
    } else if (url.pathname === `${BASE}/actions/runs/303`) {
      kind = 'publisher-run'; response = { data: { id: 303, run_attempt: state.runAttempt, head_sha: A,
        repository: clone(REPO), head_repository: clone(REPO), path: policy.release_workflow,
        event: 'push', head_branch: 'master', status: 'in_progress', conclusion: null } };
    } else if (/\/actions\/runs\/(101|202)$/.test(url.pathname)) {
      kind = 'run'; const key = url.pathname.endsWith('/101') ? 'ci' : 'app'; response = { data: clone(state.runs[key][0]) };
    } else if (/\/actions\/runs\/(101|202)\/attempts\/\d+\/jobs$/.test(url.pathname)) {
      kind = 'jobs'; const key = url.pathname.includes('/101/') ? 'ci' : 'app';
      response = { data: { total_count: state.jobs[key].length, jobs: clone(state.jobs[key]) } };
    } else if (url.pathname.startsWith(`${BASE}/git/ref/tags/`)) {
      kind = 'tag'; response = state.tag ? { data: clone(state.tag) } : notFound();
    } else if (url.pathname.startsWith(`${BASE}/releases/tags/`)) {
      kind = 'release'; response = state.release ? { data: clone(state.release) } : notFound();
    } else throw new Error(`Unplanned fake URL: ${url.pathname}`);
    if (state.hook) response = await state.hook({ kind, response, url, input }) || response;
    return { statusCode: response.statusCode || 200, headers: { 'content-type': 'application/json', ...response.headers }, body: JSON.stringify(response.data) };
  }
  function spawn(binary, args, spawnOptions) {
    assert.strictEqual(spawnOptions.shell, false);
    if (binary === 'git') {
      state.gitCalls.push(args); assert(!Object.keys(spawnOptions.env).some(key => /TOKEN|SECRET|PASSWORD/i.test(key)));
      const command = args.slice(2); let stdout;
      if (command[0] === 'merge-base') stdout = '';
      else if (command[0] === 'status') stdout = state.dirty;
      else if (command[0] === 'diff') stdout = state.diff;
      else if (command[0] === 'cat-file') stdout = blobs[command[2].slice(41)];
      else if (command[0] === 'rev-parse') {
        const spec = command[2];
        if (spec === 'HEAD') stdout = state.head;
        else if (spec === 'HEAD^{tree}') stdout = state.tree;
        else if (spec === 'refs/remotes/origin/master') stdout = A;
        else stdout = Object.values(policy.workflows).find(workflow => spec === `${A}:${workflow.path}`).blob_oid;
      } else throw new Error(`Unexpected git ${command}`);
      return { status: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0) };
    }
    assert.strictEqual(binary, 'gh'); state.mutations.push({ binary, args, options: spawnOptions });
    assert.strictEqual(spawnOptions.env.GH_TOKEN, 'fixture-token');
    assert.strictEqual(spawnOptions.env.GH_HOST, 'github.com');
    if (state.effectHook) { const result = state.effectHook(args); if (result) return result; }
    if (args[0] === 'api') state.tag = { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: A } };
    else state.release = { id: 404, url: `https://api.github.com${BASE}/releases/404`, tag_name: TAG, draft: false, prerelease: false };
    return { status: 0, stdout: '', stderr: '' };
  }
  const dependencies = { cwd, policy, now: () => state.time, clock: () => state.monotonic,
    spawnSync: spawn, request,
    resolveVersion: () => { state.versionCalls++; return version.resolveFromFacts(state.skip ? { latestTag: TAG, commits: ['docs: notes'] } : { headTags: [TAG] }); },
    buildReport: async input => {
      state.generates++; assert.strictEqual(input.allowDirty, false); assert.strictEqual(input.env.FORGE_CI_OFFLINE, '1');
      assert(!Object.keys(input.env).some(key => /TOKEN|SECRET|PASSWORD/i.test(key)));
      const report = completeReport(manifest); if (state.reportHook) await state.reportHook(report); return report;
    },
    buildPackage: () => { state.builds++; const built = { manifest: clone(manifest), sources: new Map([['core/VERSION', { bytes }]]) };
      if (state.packageHook) state.packageHook(built); return built; },
  };
  const prepareOptions = { cwd, env, sha: A, notes };
  const prepare = () => publisher.preparePublication(prepareOptions, dependencies);
  const apply = prepared => publisher.publishRelease({ cwd, env: { ...env, GH_TOKEN: 'fixture-token' }, state: prepared.state, nonce: prepared.nonce }, dependencies);
  return { root, cwd, temp, env, event, eventPath, notes, policy, blobs, manifest, state, dependencies, prepareOptions, prepare, apply,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function withFixture(run) { const f = fixture(); try { await run(f); } finally { f.cleanup(); } }
function blocked(result, f, expected) {
  assert.strictEqual(result.status, 'blocked', JSON.stringify(result)); assert.strictEqual(result.effects_attempted, 0);
  assert.strictEqual(f.state.mutations.length, 0); if (expected) assert.strictEqual(result.reason_code, expected);
}
function alterReceipt(prepared, mutate) {
  const receipt = JSON.parse(fs.readFileSync(prepared.state, 'utf8')); mutate(receipt);
  fs.writeFileSync(prepared.state, JSON.stringify(receipt));
}
function existing(f) {
  f.state.tag = { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: A } };
  f.state.release = { id: 404, tag_name: TAG, url: `https://api.github.com${BASE}/releases/404`, draft: false, prerelease: false };
}

(async () => {
  await test('publish-fresh-prepare-token-free-report-and-apply-never-generates', () => withFixture(async f => {
    const p = await f.prepare(); assert.strictEqual(p.status, 'prepared');
    const receipt = JSON.parse(fs.readFileSync(p.state));
    assert.strictEqual(receipt.binding.job.identity, '303/2/publisher'); assert.strictEqual(receipt.binding.job.role, 'publisher');
    assert.deepStrictEqual(receipt.binding.repository, { id: 42, full_name: REPO.full_name });
    assert.strictEqual(receipt.binding.root, f.cwd); assert.strictEqual(receipt.binding.workflow_sha, A);
    assert.strictEqual(receipt.binding.workflow_ref, f.env.GITHUB_WORKFLOW_REF);
    assert.strictEqual(receipt.expires_at - receipt.created_at, publisher.TTL_MS);
    for (const field of ['report_sha256', 'notes_sha256', 'package_manifest_sha256']) assert(/^[a-f0-9]{64}$/.test(receipt[field]));
    const result = await f.apply(p); assert.strictEqual(result.status, 'published-verified', JSON.stringify(result));
    assert.strictEqual(f.state.generates, 1); assert.strictEqual(f.state.builds, 1); assert.strictEqual(f.state.versionCalls, 1);
    assert.strictEqual(f.state.mutations.length, 2); assert(f.state.calls.filter(call => call.url.includes('/actions/workflows/ci.yml')).length >= 3);
    assert(f.state.calls.every(call => call.method === 'GET'));
  }));
  await test('publish-rejects-imported-old-report-and-credentials-before-generation', async () => {
    await withFixture(async f => {
      const oldReport = completeReport(f.manifest); const oldPath = path.join(f.temp, 'old-valid-report.json');
      fs.writeFileSync(oldPath, JSON.stringify(oldReport));
      publisher.validateReport(oldReport, { candidate_sha: A }, f.manifest);
      for (const extra of [{ report: oldReport }, { reportPath: oldPath }]) {
        await assert.rejects(publisher.preparePublication({ ...f.prepareOptions, ...extra }, f.dependencies), { code: 'unsupported-input' });
      }
      assert.strictEqual(f.state.generates, 0); assert.strictEqual(f.state.mutations.length, 0);
    });
    for (const extra of [{ report: {} }, { reportPath: 'old.json' }, { receipt: {} }, { context: {} }, { allowDirty: true }]) await withFixture(async f => {
      await assert.rejects(publisher.preparePublication({ ...f.prepareOptions, ...extra }, f.dependencies), { code: 'unsupported-input' });
      assert.strictEqual(f.state.generates, 0); assert.strictEqual(f.state.mutations.length, 0);
    });
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PRIVATE_COOKIE']) await withFixture(async f => {
      f.env[key] = 'fixture-secret'; await assert.rejects(f.prepare(), { code: 'prepare-credentials' });
      assert.strictEqual(f.state.generates, 0); assert.strictEqual(f.state.calls.length, 0);
    });
  });
  await test('publish-complete-local-schema-no-vacuous-coverage-types-security-package-tree', async () => {
    const mutations = [r => { r.ok = 'true'; }, r => { r.schema_version = 2; }, r => { r.matrix = []; },
      r => { r.matrix.pop(); }, r => { r.matrix[1] = clone(r.matrix[0]); }, r => { r.matrix[0].suites = []; },
      r => { r.matrix[0].suites.pop(); }, r => { r.matrix[0].suites[1] = clone(r.matrix[0].suites[0]); },
      r => { r.matrix[0].suites[0].status = '0'; }, r => { delete r.matrix[0].suites[0].signal; },
      r => { r.matrix[0].ok = false; }, r => { r.regeneration = []; }, r => { r.regeneration.pop(); },
      r => { r.regeneration[1] = clone(r.regeneration[0]); }, r => { r.regeneration[0].idempotent = 'true'; },
      r => { r.regeneration[0].repeat_tree_sha256 = 'e'.repeat(64); }, r => { r.regeneration[0].repeat_package_sha256 = 'e'.repeat(64); },
      r => { delete r.regeneration[0].first_changed; }, r => { delete r.security.secrets_forwarded; },
      r => { r.security.node_argv_only = 1; }, r => { r.security.provider_paid_required = true; },
      r => { r.release.commit = B; }, r => { r.release.product_version = '0.0.0'; }, r => { r.release.package_sha256 = 'e'.repeat(64); },
      r => { delete r.tree.before; }, r => { r.tree.before.push('dirty'); }, r => { r.tree.stable = 'true'; },
      r => { delete r.real_provider_smoke; }, r => { r.real_capability_smoke.required = true; }];
    for (const mutate of mutations) await withFixture(async f => {
      f.state.reportHook = mutate; await assert.rejects(f.prepare()); assert.strictEqual(f.state.mutations.length, 0);
    });
  });
  await test('publish-source-policy-applicability-origin-and-prepare-head-tree-version', async () => {
    for (const mutate of [f => { f.env.GITHUB_REF = 'refs/tags/v1.0.0'; }, f => { f.env.GITHUB_WORKFLOW_SHA = B; },
      f => { f.state.head = B; }, f => { f.state.dirty = ' M README.md'; },
      f => { f.blobs['.github/workflows/ci.yml'] = Buffer.from('changed'); },
      f => { f.policy.workflows.release.jobs.push(clone(f.policy.workflows.release.jobs[1])); },
      f => { f.dependencies.resolveVersion = () => ({ skip: false, new_tag: 'v0.0.1' }); },
      f => { f.state.reportHook = () => { f.state.head = B; }; },
      f => { f.state.reportHook = () => { f.state.tree = B; }; }]) await withFixture(async f => {
      mutate(f); await assert.rejects(f.prepare()); assert.strictEqual(f.state.mutations.length, 0);
    });
    await withFixture(async f => { f.state.diff = Buffer.alloc(0); f.state.runs.app = []; const p = await f.prepare();
      assert.strictEqual((await f.apply(p)).status, 'published-verified'); assert(!f.state.calls.some(call => call.url.includes('/workflows/app.yml'))); });
  });
  await test('publish-receipt-binds-nonce-repo-workflow-run-attempt-job-root-and-time', async () => {
    const changes = [f => { f.env.GITHUB_REPOSITORY_ID = '43'; }, f => { f.env.GITHUB_REPOSITORY = 'other/repo'; },
      f => { f.env.GITHUB_WORKFLOW_REF = 'other/workflow'; }, f => { f.env.GITHUB_WORKFLOW_SHA = B; },
      f => { f.env.GITHUB_RUN_ID = '304'; }, f => { f.env.GITHUB_RUN_ATTEMPT = '3'; },
      f => { f.env.GITHUB_JOB = 'coordinator'; }, f => { f.env.GITHUB_SHA = B; },
      f => { f.state.time += publisher.TTL_MS; }, f => { f.state.time--; }, f => { f.state.time = NaN; }];
    for (const mutate of changes) await withFixture(async f => { const p = await f.prepare(); mutate(f); blocked(await f.apply(p), f); });
    await withFixture(async f => { const p = await f.prepare(); p.nonce = '0'.repeat(64); blocked(await f.apply(p), f, 'receipt-nonce'); });
    await withFixture(async f => { f.env.GITHUB_JOB = 'coordinator'; const p = await f.prepare(); blocked(await f.apply(p), f, 'publisher-required'); });
    for (const mutate of [r => { r.binding.root += '-other'; }, r => { r.created_at--; }, r => { r.expires_at++; },
      r => { r.generation_started_at = r.created_at + 1; }, r => { r.binding.policy_sha256 = '0'.repeat(64); }]) await withFixture(async f => {
      const p = await f.prepare(); alterReceipt(p, mutate); blocked(await f.apply(p), f);
    });
  });
  await test('publish-bounded-real-containment-links-escaped-copied-state-and-package-paths', async () => {
    await withFixture(async f => {
      const p = await f.prepare(); const source = path.dirname(p.state); const copied = path.join(f.temp, 'forge-release-copied');
      fs.cpSync(source, copied, { recursive: true }); p.state = path.join(copied, 'receipt.json'); blocked(await f.apply(p), f, 'state-location');
    });
    await withFixture(async f => {
      const p = await f.prepare(); const alias = path.join(f.temp, 'forge-release-alias');
      fs.symlinkSync(path.dirname(p.state), alias, process.platform === 'win32' ? 'junction' : 'dir');
      p.state = path.join(alias, 'receipt.json'); const result = await f.apply(p); blocked(result, f);
      assert(['path-link', 'path-redirected'].includes(result.reason_code));
    });
    await withFixture(async f => {
      const p = await f.prepare(); const payload = path.join(path.dirname(p.state), 'package', 'payload', 'core');
      const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'VERSION'), 'external');
      fs.rmSync(payload, { recursive: true }); fs.symlinkSync(external, payload, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await f.apply(p); blocked(result, f); assert(['path-link', 'path-redirected'].includes(result.reason_code));
    });
    await withFixture(async f => { f.prepareOptions.notes = path.join(f.cwd, 'notes.md'); fs.writeFileSync(f.prepareOptions.notes, 'x');
      await assert.rejects(f.prepare(), { code: 'path-escape' }); assert.strictEqual(f.state.generates, 0); });
    await withFixture(async f => { const p = await f.prepare(); fs.writeFileSync(path.join(path.dirname(p.state), 'report.json'), Buffer.alloc(4 * 1024 * 1024 + 1));
      blocked(await f.apply(p), f, 'state-read'); });
    for (const invalid of ['../outside', '/absolute', 'a\\b', 'C:/outside', 'a/../../b']) await withFixture(async f => {
      f.state.packageHook = built => { built.manifest.files[0].path = invalid; };
      await assert.rejects(f.prepare(), { code: 'package-entry' }); assert.strictEqual(f.state.mutations.length, 0);
    });
  });
  await test('publish-tampered-report-notes-package-policy-and-clean-head-block-before-effects', async () => {
    for (const file of ['report.json', 'notes.md', 'package/manifest.json', 'package/payload/core/VERSION', 'package/CHECKSUMS.sha256']) await withFixture(async f => {
      const p = await f.prepare(); fs.appendFileSync(path.join(path.dirname(p.state), file), 'changed'); blocked(await f.apply(p), f);
    });
    for (const mutate of [f => { f.state.head = B; }, f => { f.state.tree = B; }, f => { f.state.dirty = '?? untracked'; },
      f => { f.blobs['.github/workflows/app.yml'] = Buffer.from('foreign'); }, f => { f.policy.branch = 'other'; }]) await withFixture(async f => {
      const p = await f.prepare(); mutate(f); blocked(await f.apply(p), f);
    });
  });
  await test('publish-exclusive-consumption-concurrent-second-apply-and-fresh-retry', () => withFixture(async f => {
    const p = await f.prepare(); const results = await Promise.all([f.apply(p), f.apply(p)]);
    assert(results.some(result => result.status === 'published-verified'));
    assert(results.some(result => result.reason_code === 'receipt-consumed'));
    assert.strictEqual(f.state.mutations.length, 2);
    const second = await f.apply(p); assert.strictEqual(second.reason_code, 'receipt-consumed'); assert.strictEqual(f.state.mutations.length, 2);
    const fresh = await f.prepare(); assert.notStrictEqual(fresh.nonce, p.nonce); assert.notStrictEqual(fresh.state, p.state);
    assert.strictEqual((await f.apply(fresh)).status, 'already-published-verified'); assert.strictEqual(f.state.mutations.length, 2);
    fresh.nonce = p.nonce; assert.strictEqual((await f.apply(fresh)).reason_code, 'receipt-nonce');
  }));
  await test('publish-remote-status-missing-app-pagination-attempt-and-identities-zero-effects', async () => {
    for (const conclusion of ['skipped', 'neutral', 'failure', 'cancelled', 'timed_out']) await withFixture(async f => {
      const p = await f.prepare(); f.state.jobs.ci[0].conclusion = conclusion; blocked(await f.apply(p), f, 'job-not-success');
    });
    for (const mutate of [f => { f.state.runs.app = []; }, f => { f.state.jobs.ci.pop(); },
      f => { f.state.jobs.ci[0].status = 'in_progress'; f.state.jobs.ci[0].conclusion = null; },
      f => { f.state.jobs.ci[1].id = f.state.jobs.ci[0].id; }, f => { f.state.jobs.ci[0].head_sha = B; },
      f => { f.state.runs.ci[0].head_sha = B; }, f => { f.state.runAttempt = 3; },
      f => { f.state.hook = ({ kind, response }) => { if (kind === 'runs') response.data.total_count++; }; },
      f => { f.state.hook = ({ kind, response }) => { if (kind === 'metadata') response.data.path = 'wrong'; }; },
      f => { let read = 0; f.state.hook = ({ kind, response }) => { if (kind === 'run' && ++read > 2) response.data.run_attempt++; }; },
      f => { f.state.hook = ({ kind, response }) => { if (kind === 'repository') response.data.id++; }; }]) await withFixture(async f => {
      const p = await f.prepare(); mutate(f); blocked(await f.apply(p), f);
      assert(fs.existsSync(path.join(path.dirname(p.state), 'consumed.json')));
      assert(fs.readdirSync(path.dirname(p.state)).some(name => name.startsWith('failure-')));
    });
  });
  await test('publish-allowlisted-argv-full-sha-and-explicit-readback-stable-intent', () => withFixture(async f => {
    const p = await f.prepare(); const result = await f.apply(p); assert.strictEqual(result.status, 'published-verified');
    assert.deepStrictEqual(f.state.mutations[0].args, ['api', '--method', 'POST', 'repos/example/forge-agent/git/refs', '-f', `ref=refs/tags/${TAG}`, '-f', `sha=${A}`]);
    assert.deepStrictEqual(f.state.mutations[1].args, ['release', 'create', TAG, '--repo', REPO.full_name, '--verify-tag', '--target', A,
      '--title', TAG, '--notes-file', path.join(path.dirname(p.state), 'notes.md')]);
    assert(f.state.mutations.every(item => !item.args.some(arg => ['--force', 'DELETE', 'PATCH'].includes(arg))));
    assert.strictEqual(f.state.versionCalls, 1); assert.strictEqual(fs.readFileSync(path.join(path.dirname(p.state), 'notes.md'), 'utf8'), 'Pinned release notes\n');
  }));
  await test('publish-existing-release-full-barrier-claim-and-tag-repository-identity', async () => {
    await withFixture(async f => { existing(f); const p = await f.prepare(); assert.strictEqual((await f.apply(p)).status, 'already-published-verified');
      assert.strictEqual(f.state.mutations.length, 0); assert(f.state.calls.some(call => call.url.includes('/jobs?')));
      assert.strictEqual((await f.apply(p)).reason_code, 'receipt-consumed'); });
    for (const mutate of [f => { f.state.tag.object.sha = B; }, f => { f.state.release.tag_name = 'v0.0.0'; },
      f => { f.state.release.url = 'https://api.github.com/repos/other/repo/releases/404'; },
      f => { f.state.release.draft = true; }, f => { f.state.jobs.ci[0].conclusion = 'failure'; }]) await withFixture(async f => {
      existing(f); const p = await f.prepare(); mutate(f); blocked(await f.apply(p), f);
    });
    await withFixture(async f => { existing(f); f.state.release = null; const p = await f.prepare(); assert.strictEqual((await f.apply(p)).status, 'published-verified');
      assert.strictEqual(f.state.mutations.length, 1); assert.strictEqual(f.state.mutations[0].args[0], 'release'); });
  });
  await test('publish-no-bump-is-no-publication-and-never-published-verified', () => withFixture(async f => {
    f.state.skip = true; delete f.prepareOptions.notes;
    const p = await f.prepare(); assert.strictEqual((await f.apply(p)).status, 'no-publication'); assert.strictEqual(f.state.mutations.length, 0);
  }));
  await test('publish-tag-conflict-exact-readback-and-divergent-ref-never-moved', async () => {
    for (const sha of [A, B]) await withFixture(async f => {
      const p = await f.prepare(); f.state.effectHook = args => { if (args[0] === 'api') {
        f.state.tag = { ref: `refs/tags/${TAG}`, object: { type: 'commit', sha } }; return { status: 1, stderr: 'conflict' }; } };
      const result = await f.apply(p); assert.strictEqual(result.status, sha === A ? 'published-verified' : 'partial-effect');
      assert.strictEqual(f.state.mutations.length, sha === A ? 2 : 1);
      if (sha === B) assert.strictEqual(result.reason_code, 'tag-diverged');
    });
  });
  await test('publish-revalidates-before-second-effect-ttl-head-receipt-notes-gates-attempt', async () => {
    const changes = [f => { f.state.head = B; }, f => { f.state.tree = B; }, f => { f.state.time += publisher.TTL_MS; },
      f => { f.state.jobs.ci[0].conclusion = 'failure'; }, f => { f.state.runAttempt++; },
      (f, p) => { fs.appendFileSync(path.join(path.dirname(p.state), 'notes.md'), 'changed'); },
      (f, p) => { alterReceipt(p, r => { r.intent.tag = 'v0.0.0'; }); },
      (f, p) => { fs.appendFileSync(path.join(path.dirname(p.state), 'package/payload/core/VERSION'), 'changed'); }];
    for (const mutate of changes) await withFixture(async f => {
      const p = await f.prepare(); f.state.effectHook = args => { if (args[0] === 'api') mutate(f, p); };
      const result = await f.apply(p); assert.strictEqual(result.status, 'partial-effect'); assert.strictEqual(f.state.mutations.length, 1);
      assert.strictEqual(f.state.generates, 1); assert.strictEqual(f.state.builds, 1);
    });
  });
  await test('publish-rechecks-local-ttl-and-current-publisher-after-network-before-first-effect', async () => {
    for (const change of ['ttl', 'head', 'attempt']) await withFixture(async f => {
      const p = await f.prepare(); f.state.hook = ({ kind }) => { if (kind === 'release') {
        if (change === 'ttl') f.state.time += publisher.TTL_MS; else if (change === 'head') f.state.head = B; else f.state.runAttempt++;
      } }; blocked(await f.apply(p), f);
    });
  });
  await test('publish-partial-effect-retains-consumption-and-sanitized-diagnostic-no-rollback', () => withFixture(async f => {
    const p = await f.prepare(); f.state.effectHook = args => args[0] === 'release' ? { status: 1, stderr: 'fixture-token should not escape' } : null;
    const result = await f.apply(p); assert.strictEqual(result.status, 'partial-effect'); assert.strictEqual(result.reason_code, 'release-readback');
    assert.strictEqual(f.state.mutations.length, 2); assert.strictEqual(f.state.tag.object.sha, A);
    assert(!JSON.stringify(result).includes('fixture-token')); assert.strictEqual((await f.apply(p)).reason_code, 'receipt-consumed');
  }));
  await test('publish-cli-production-main-fake-subprocess-prepare-apply-and-output', () => withFixture(async f => {
    f.env.GITHUB_OUTPUT = path.join(f.temp, 'outputs'); fs.writeFileSync(f.env.GITHUB_OUTPUT, '');
    const p = await publisher.main(['prepare', '--sha', A, '--notes', f.notes, '--github-output', f.env.GITHUB_OUTPUT], f.env, f.dependencies);
    const outputs = fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'); assert(outputs.includes(`state=${p.state}\nnonce=${p.nonce}`));
    const result = await publisher.main(['apply', '--state', p.state, '--nonce', p.nonce], { ...f.env, GH_TOKEN: 'fixture-token' }, f.dependencies);
    assert.strictEqual(result.status, 'published-verified');
    await assert.rejects(publisher.main(['prepare', '--report', p.state], f.env, f.dependencies), { code: 'cli-arguments' });
    const child = spawnSync(process.execPath, [path.join(__dirname, 'forge-release-publish.js'), 'apply', '--report', 'old.json'],
      { shell: false, encoding: 'utf8', env: offline.scrubEnvironment(process.env) });
    assert.strictEqual(child.status, 1); assert(child.stderr.includes('cli-arguments'));
  }));
  await test('publish-package-build-checksum-verify-real-algorithm-compatible', () => withFixture(async f => {
    // One actual package render ensures wrapper validation accepts the product's
    // real inventory. Other tests isolate expensive generation with fake seams.
    const built = packaging.build({ repo: ROOT, platform: 'linux' });
    assert.strictEqual(packaging.packageChecksum(built.manifest.files), built.manifest.package_sha256);
    f.dependencies.buildPackage = () => { f.state.builds++; return built; };
    f.dependencies.buildReport = input => {
      assert.strictEqual(input.env.FORGE_CI_OFFLINE, '1'); f.state.generates++;
      const report = completeReport(built.manifest);
      return gate.buildReport({ ...input, repo: ROOT }, {
        status: () => [], commit: A,
        runOffline: cell => ({ ...cell, ok: true, results: offline.MATRIX.suites.map(file =>
          ({ suite: path.basename(file), ok: true, status: 0, signal: null })) }),
        regeneration: (_repo, platform) => report.regeneration.find(row => row.platform === platform),
        securityAudit: () => report.security,
      });
    };
    const p = await f.prepare(); const result = await f.apply(p); assert.strictEqual(result.status, 'published-verified', JSON.stringify(result));
    assert.strictEqual(f.state.builds, 1); assert.strictEqual(f.state.generates, 1);
  }));
  await test('publish-readonly-wait-is-separate-from-token-free-prepare', () => withFixture(async f => {
    // Exercise waitForChecks through the production reader; prepare itself has
    // no HTTP calls. The same source/applicability APIs are used by apply.
    const gitOptions = { cwd: f.cwd, policy: f.policy, spawnSync: (binary, args, options) =>
      f.dependencies.spawnSync(binary, args, { ...options, env: offline.scrubEnvironment(f.env) }) };
    const candidate = checks.resolveCandidate({ repository: REPO, authenticated_repository: REPO, event: f.event,
      candidate_sha: A, github_sha: A, event_name: 'push', ref: f.event.ref,
      workflow_ref: f.env.GITHUB_WORKFLOW_REF, workflow_sha: A, trusted_master_sha: A }, gitOptions);
    const sources = checks.assertPolicySources(candidate, gitOptions);
    const applicability = checks.resolveApplicability(candidate, gitOptions);
    const reader = github.createGitHubReader({ token: 'fixture-token', request: f.dependencies.request, clock: () => 0 });
    const waited = await github.waitForChecks({ reader, candidate, sources, applicability, policy: f.policy });
    assert.strictEqual(waited.allowed, true); const requests = f.state.calls.length;
    await f.prepare(); assert.strictEqual(f.state.calls.length, requests); assert.strictEqual(f.state.mutations.length, 0);
  }));
  process.stdout.write(`${count} release publication tests passed (fake transport/effects; no remote publication)\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
