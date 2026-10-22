'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const checks = require('./forge-release-checks.js');
const publisher = require('./forge-release-publish.js');
const github = require('./forge-release-github.js');
const version = require('./forge-release-version.js');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, '.github/workflows/app.yml'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
let count = 0;
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }

// Deliberately bounded reader for the exact step subset used here. Unknown
// indentation, keys, actions, shell, nested objects or block forms fail closed.
function parseSteps(text) {
  assert(text.length < 100000); const result = {}; let job; let step; let section; let block = false;
  for (const line of text.split('\n')) {
    const jobMatch = /^  (coordinator|publisher):$/.exec(line);
    if (jobMatch) { job = jobMatch[1]; result[job] = []; section = false; step = null; block = false; continue; }
    if (!job) continue;
    if (line === '    steps:') { section = true; continue; }
    if (!section) continue;
    if (block && line.startsWith('          ')) { step.run += line.slice(10) + '\n'; continue; }
    block = false;
    if (!line.trim()) continue;
    let match;
    if ((match = /^      - (name|uses): (.+)$/.exec(line))) {
      step = { [match[1]]: match[2] }; result[job].push(step); continue;
    }
    assert(step, `unexpected YAML: ${line}`);
    if ((match = /^        (id|uses|shell|run): (.+)$/.exec(line))) {
      assert(!Object.hasOwn(step, match[1]));
      if (match[1] === 'run' && match[2] === '|') { step.run = ''; block = true; }
      else { assert(!['>', '&', '*'].includes(match[2][0])); step[match[1]] = match[2]; }
      continue;
    }
    if ((match = /^        (with|env):$/.exec(line))) { step.section = match[1]; step[match[1]] = {}; continue; }
    if ((match = /^          ([A-Za-z0-9_-]+): (.+)$/.exec(line))) {
      assert(step.section && !Object.hasOwn(step[step.section], match[1]));
      step[step.section][match[1]] = match[2]; continue;
    }
    throw new Error(`Unsupported YAML: ${line}`);
  }
  for (const steps of Object.values(result)) for (const step of steps) {
    if (step.uses) assert(['actions/checkout@v4', 'actions/setup-node@v4'].includes(step.uses));
    if (step.shell) assert.strictEqual(step.shell, 'bash');
    delete step.section;
  }
  return result;
}
const jobs = parseSteps(source);
// Reuse the T03 full-schema fake IO fixture without rerunning its test body.
// The bounded prefix contains declarations only; no imported JSON/commands run.
const fixtureFile = path.join(__dirname, 'forge-release-publish.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const marker = '\n(async () => {';
assert.strictEqual(fixtureSource.split(marker).length, 2);
const sandbox = { require: createRequire(fixtureFile), __dirname, process, Buffer, console, URL, module: { exports: {} } };
vm.runInNewContext(fixtureSource.split(marker)[0] + '\nmodule.exports = { fixture, existing, A, B };', sandbox, { timeout: 1000 });
const fixtures = sandbox.module.exports;
async function fixture(run) {
  const f = fixtures.fixture();
  try {
    // Use the actual workflow bytes and final policy, not a toy release source.
    f.policy.workflows.release = clone(checks.POLICY.workflows.release);
    for (const workflow of Object.values(f.policy.workflows)) {
      const bytes = fs.readFileSync(path.join(ROOT, workflow.path));
      assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), workflow.blob_sha256);
      assert.strictEqual(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), workflow.blob_oid);
      f.blobs[workflow.path] = bytes;
    }
    await run(f);
  } finally { f.cleanup(); }
}
function expand(value, env, outputs) {
  if (value === "''") return '';
  return value.replace(/\$\{\{ (.*?) \}\}/g, (_, key) => {
    if (key === 'runner.temp') return env.RUNNER_TEMP;
    if (key === 'github.token') return 'fixture-token';
    const match = /^steps\.([a-z]+)\.outputs\.([a-z_]+)$/.exec(key);
    assert(match && outputs[match[1]] && Object.hasOwn(outputs[match[1]], match[2]), `unknown expression ${key}`);
    return outputs[match[1]][match[2]];
  });
}
function inlineCode(run) {
  const match = /^node <<'NODE'\n([\s\S]+)\nNODE\n$/.exec(run);
  assert(match, 'unsupported shell block'); return match[1];
}
function argv(run, env) {
  assert(/^node scripts\/forge-release-(github|publish|version)\.js /.test(run));
  const parts = run.match(/"[^"\n]*"|[^\s]+/g);
  return parts.slice(1).map(part => part.replace(/^"|"$/g, '').replace(/\$([A-Z_]+)/g, (_, name) => {
    assert(Object.hasOwn(env, name), `missing env ${name}`); return env[name];
  }));
}
async function execute(f, key, mutate = () => {}) {
  const env = { ...f.env, GITHUB_JOB: key }; const outputs = {}; const calls = [];
  for (const step of jobs[key]) {
    const local = { ...env };
    for (const [name, value] of Object.entries(step.env || {})) local[name] = expand(value, env, outputs);
    local.GITHUB_OUTPUT = path.join(f.temp, `output-${key}-${calls.length}`); fs.writeFileSync(local.GITHUB_OUTPUT, '');
    calls.push(step.name || step.uses);
    if (step.uses) {
      if (step.uses === 'actions/checkout@v4') {
        assert.strictEqual(step.with['persist-credentials'], 'false'); assert.strictEqual(step.with['fetch-depth'], '0');
        const ref = expand(step.with.ref, env, outputs);
        assert(ref === 'refs/heads/master' || ref === fixtures.A);
        if (ref !== 'refs/heads/master') f.state.head = ref;
      } else assert.strictEqual(step.with['node-version'], '22');
      continue;
    }
    let run = step.run;
    if (run && run.startsWith('GITHUB_EVENT_PATH="$RUNNER_TEMP/release-event.json" ')) {
      local.GITHUB_EVENT_PATH = path.join(local.RUNNER_TEMP, 'release-event.json');
      run = run.slice('GITHUB_EVENT_PATH="$RUNNER_TEMP/release-event.json" '.length);
    }
    mutate(local, step, f);
    if (run.startsWith("node <<'NODE'")) {
      const fakeRequire = name => {
        if (name === 'child_process') return { execFileSync: (binary, args) => {
          assert.strictEqual(binary, 'git');
          if (args[0] === 'merge-base') { assert.strictEqual(args[2], fixtures.A); return ''; }
          if (args[0] === 'rev-parse') return f.state.head;
          assert.strictEqual(args[0], 'log'); return `${fixtures.A} feat: fixture\n${fixtures.B} fix: regression`;
        } };
        assert(['fs', 'path'].includes(name)); return require(name);
      };
      vm.runInNewContext(inlineCode(run), { require: fakeRequire, process: { env: local } }, { timeout: 1000 });
    } else {
      const args = argv(run, local); const file = args.shift(); f.candidateCalls = (f.candidateCalls || 0) + 1;
      assert.strictEqual(f.state.head, fixtures.A);
      if (file.endsWith('version.js')) {
        assert.deepStrictEqual(args, ['--check', '--github-output', local.GITHUB_OUTPUT]);
        const resolution = f.dependencies.resolveVersion();
        version.checkDeclaredVersion(resolution, f.manifest.product_version);
        version.appendGithubOutput(local.GITHUB_OUTPUT, resolution);
      } else if (file.endsWith('github.js')) {
        assert.deepStrictEqual(args, ['wait', '--sha', fixtures.A]); assert.strictEqual(local.GH_TOKEN, 'fixture-token');
        const candidate = { ...JSON.parse(fs.readFileSync(local.GITHUB_EVENT_PATH)), env: local };
        const gitOptions = { cwd: f.cwd, policy: f.policy, spawnSync: (binary, a, o) => f.dependencies.spawnSync(binary, a, { ...o, env: {} }) };
        const origin = checks.resolveCandidate({ repository: candidate.repository, authenticated_repository: candidate.repository,
          event: candidate, event_name: local.GITHUB_EVENT_NAME, ref: local.GITHUB_REF, github_sha: local.GITHUB_SHA,
          candidate_sha: local.GITHUB_SHA, workflow_ref: local.GITHUB_WORKFLOW_REF, workflow_sha: local.GITHUB_WORKFLOW_SHA,
          trusted_master_sha: fixtures.A }, gitOptions);
        const reader = github.createGitHubReader({ token: local.GH_TOKEN, request: f.dependencies.request, clock: () => 0 });
        const result = await github.waitForChecks({ reader, candidate: origin, sources: checks.assertPolicySources(origin, gitOptions),
          applicability: checks.resolveApplicability(origin, gitOptions), policy: f.policy });
        assert.strictEqual(result.allowed, true);
      } else {
        const result = await publisher.main(args, local, f.dependencies);
        if (args[0] === 'apply') { f.result = result; assert(!['blocked', 'partial-effect'].includes(result.status), JSON.stringify(result)); }
        else { f.prepared = result; assert.strictEqual(local.GH_TOKEN, ''); assert.strictEqual(local.GITHUB_TOKEN, ''); }
      }
    }
    if (step.id) outputs[step.id] = Object.fromEntries(fs.readFileSync(local.GITHUB_OUTPUT, 'utf8').trim().split('\n').filter(Boolean).map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
    }));
  }
  return { outputs, calls };
}

(async () => {
  await test('workflow-master-only-permissions-needs-deadlines-and-no-self-wait', () => {
    assert(source.startsWith('name: Release\n\non:\n  push:\n    branches: [master]\n\npermissions: {}\n'));
    assert(!/tags:|workflow_run:|pull_request|download-artifact|continue-on-error|cancel-in-progress: true/.test(source));
    assert(source.includes('group: release\n  cancel-in-progress: false'));
    assert.strictEqual((source.match(/timeout-minutes: 45/g) || []).length, 2);
    assert(source.includes('publisher:\n    name: Release publisher\n    needs: coordinator'));
    assert.strictEqual(checks.POLICY.workflows.release.jobs[0].permissions.contents, 'read');
    assert.strictEqual(checks.POLICY.workflows.release.jobs[1].permissions.contents, 'write');
    assert.strictEqual(jobs.coordinator.filter(step => step.run && step.run.includes('github.js wait')).length, 1);
    assert(!jobs.publisher.some(step => step.run && step.run.includes('github.js wait')));
    for (const [key, steps] of Object.entries(jobs)) {
      checks.assertJobMapping(source, checks.POLICY.workflows.release);
      assert(steps.findIndex(step => step.id === 'origin') < steps.findIndex(step => step.name === 'Exact candidate checkout'));
      const prepare = steps.find(step => step.id === 'prepare');
      assert.strictEqual(prepare.env.GH_TOKEN, "''"); assert.strictEqual(prepare.env.GITHUB_TOKEN, "''");
      assert(prepare.run.startsWith('GITHUB_EVENT_PATH="$RUNNER_TEMP/release-event.json" node '));
      assert.strictEqual(steps.filter(step => step.env && step.env.GH_TOKEN === '${{ github.token }}').length, 1);
      assert(steps.find(step => step.id === 'version').run.includes('--check --github-output'));
      assert(!source.includes('forge-release-gate.js --report'));
      assert(key === 'coordinator' || steps.at(-1).run.includes('apply --state "$RELEASE_STATE" --nonce "$RELEASE_NONCE"'));
    }
    assert.strictEqual(github.DEFAULT_LIMITS.deadlineMs, 1800000);
    assert.strictEqual(publisher.TTL_MS, 600000);
  });
  await test('workflow-origin-rejections-before-candidate-code-both-jobs', async () => {
    for (const key of ['coordinator', 'publisher']) for (const change of [
      e => { e.GITHUB_EVENT_NAME = 'pull_request'; }, e => { e.GITHUB_REF = 'refs/tags/v1.0.0'; },
      e => { e.GITHUB_WORKFLOW_REF += '-foreign'; }, e => { e.GITHUB_WORKFLOW_SHA = fixtures.B; },
      e => { e.GITHUB_SHA = fixtures.B; }, e => { e.GITHUB_REPOSITORY_ID = '43'; },
      e => { e.GITHUB_REPOSITORY = 'foreign/repo'; },
    ]) await fixture(async f => {
      await assert.rejects(execute(f, key, (env, step) => { if (step.id === 'origin') change(env); }));
      assert.strictEqual(f.candidateCalls || 0, 0); assert.strictEqual(f.state.mutations.length, 0);
    });
    for (const key of ['coordinator', 'publisher']) await fixture(async f => {
      f.event.repository.fork = true; fs.writeFileSync(f.eventPath, JSON.stringify(f.event));
      await assert.rejects(execute(f, key)); assert.strictEqual(f.candidateCalls || 0, 0);
    });
  });
  await test('workflow-real-entrypoints-publisher-fresh-receipt-sha-intent-and-replay', () => fixture(async f => {
    await execute(f, 'publisher'); assert.strictEqual(f.result.status, 'published-verified');
    assert.strictEqual(f.result.candidate_sha, fixtures.A); assert.strictEqual(f.state.generates, 1);
    assert.strictEqual(f.state.mutations.length, 2);
    assert(f.state.mutations[0].args.includes(`sha=${fixtures.A}`));
    const receipt = JSON.parse(fs.readFileSync(f.prepared.state));
    assert.strictEqual(receipt.binding.job.identity, '303/2/publisher');
    assert.strictEqual(receipt.expires_at - receipt.created_at, publisher.TTL_MS);
    f.env.GITHUB_EVENT_PATH = path.join(f.temp, 'release-event.json');
    assert.strictEqual((await f.apply(f.prepared)).reason_code, 'receipt-consumed');
    assert.strictEqual(f.state.mutations.length, 2);
  }));
  await test('workflow-coordinator-readonly-get-wait-and-unusable-cross-job-receipt', () => fixture(async f => {
    await execute(f, 'coordinator'); assert.strictEqual(f.state.generates, 1); assert.strictEqual(f.state.mutations.length, 0);
    assert(f.state.calls.length > 0 && f.state.calls.every(call => call.method === 'GET'));
    f.env.GITHUB_EVENT_PATH = path.join(f.temp, 'release-event.json');
    assert.strictEqual((await f.apply(f.prepared)).status, 'blocked'); assert.strictEqual(f.state.mutations.length, 0);
  }));
  await test('workflow-app-all-master-pushes-pr-swift-pty-and-14-ci-cells-preserved', () => {
    assert(app.includes('  push:\n    branches: [master]\n\npermissions:'));
    assert(app.includes("  pull_request:\n    paths:\n      - 'app/**'\n      - '.github/workflows/app.yml'"));
    for (const text of ['  app:', 'name: Swift app and PTY regressions', 'runs-on: macos-26', 'timeout-minutes: 20',
      'actions/cache@v4', 'app/.build', 'swift build --package-path app --product Forge', 'swift run --package-path app ForgeKitTests']) assert(app.includes(text));
    assert.strictEqual(checks.expandJobs(checks.POLICY.workflows.ci).length, 14);
    const ci = fs.readFileSync(path.join(ROOT, checks.POLICY.workflows.ci.path));
    assert.strictEqual(crypto.createHash('sha256').update(ci).digest('hex'), checks.POLICY.workflows.ci.blob_sha256);
    assert(ci.toString().includes('baseline')); assert.strictEqual(checks.POLICY.local.suites.length, 11);
  });
  await test('workflow-final-git-blob-pins-and-real-semantic-mappings', () => fixture(async f => {
    const { outputs } = await execute(f, 'publisher'); assert.strictEqual(outputs.origin.candidate_sha, fixtures.A);
    assert.strictEqual(checks.POLICY.workflows.release.jobs.map(job => job.key).join(','), 'coordinator,publisher');
    // Synthetic index/tree: commit-ready exact bytes; no real checkout/index writes.
    const tempIndex = path.join(f.temp, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex, GIT_OBJECT_DIRECTORY: path.join(f.temp, 'objects') };
    fs.mkdirSync(env.GIT_OBJECT_DIRECTORY);
    for (const workflow of Object.values(checks.POLICY.workflows)) {
      const bytes = f.blobs[workflow.path];
      const hashed = spawnSync('git', ['-C', ROOT, 'hash-object', '-w', '--stdin', '--no-filters'], { input: bytes, env, shell: false, encoding: 'utf8' });
      assert.strictEqual(hashed.status, 0, hashed.stderr); assert.strictEqual(hashed.stdout.trim(), workflow.blob_oid);
      const indexed = spawnSync('git', ['-C', ROOT, 'update-index', '--add', '--cacheinfo', `100644,${workflow.blob_oid},${workflow.path}`], { env, shell: false, encoding: 'utf8' });
      assert.strictEqual(indexed.status, 0, indexed.stderr);
    }
    const tree = spawnSync('git', ['-C', ROOT, 'write-tree'], { env, shell: false, encoding: 'utf8' });
    assert.strictEqual(tree.status, 0, tree.stderr); assert(/^[a-f0-9]{40}$/.test(tree.stdout.trim()));
  }));
  await test('workflow-existing-tag-release-still-traverses-barrier', () => fixture(async f => {
    fixtures.existing(f); await execute(f, 'publisher'); assert.strictEqual(f.result.status, 'already-published-verified');
    assert.strictEqual(f.state.generates, 1); assert.strictEqual(f.state.mutations.length, 0);
    assert(f.state.calls.some(call => call.url.includes('/jobs?')));
  }));
  await test('workflow-full-push-first-app-unknown-and-complete-empty-applicability', async () => {
    for (const diff of [Buffer.from('app/new.swift\0'), Buffer.from('future/unknown\0'), Buffer.alloc(0)]) await fixture(async f => {
      f.state.diff = diff;
      if (!diff.length) f.state.runs.app = [];
      await execute(f, 'publisher'); assert.strictEqual(f.result.status, 'published-verified');
      assert.strictEqual(f.state.calls.some(call => call.url.includes('/workflows/app.yml')), !!diff.length);
    });
  });
  await test('workflow-divergent-tag-release-new-attempt-and-incomplete-pagination-zero-effects', async () => {
    for (const change of [
      f => { fixtures.existing(f); f.state.tag.object.sha = fixtures.B; },
      f => { fixtures.existing(f); f.state.release.draft = true; },
      f => { f.state.runs.ci[0].run_attempt++; f.state.jobs.ci.pop(); },
      f => { f.state.hook = ({ kind, response }) => { if (kind === 'runs') response.data.total_count++; }; },
    ]) await fixture(async f => {
      await assert.rejects(execute(f, 'publisher', (_, step) => { if (step.name === 'Apply current publisher receipt') change(f); }));
      assert.strictEqual(f.state.mutations.length, 0);
    });
  });
  await test('workflow-negative-gates-expired-token-and-tampered-state-zero-effects' , async () => {
    for (const change of [
      f => { f.state.jobs.ci[0].conclusion = 'failure'; }, f => { f.state.runs.app = []; },
      f => { f.state.runAttempt++; }, f => { f.state.jobs.ci.pop(); },
      f => { f.state.time += publisher.TTL_MS; },
      f => { fs.appendFileSync(path.join(path.dirname(f.prepared.state), 'report.json'), 'changed'); },
    ]) await fixture(async f => {
      await assert.rejects(execute(f, 'publisher', (_, step) => { if (step.name === 'Apply current publisher receipt') change(f); }));
      assert.strictEqual(f.state.mutations.length, 0);
    });
    await fixture(async f => {
      await assert.rejects(execute(f, 'publisher', (env, step) => { if (step.id === 'prepare') env.GITHUB_TOKEN = 'forbidden'; }), { code: 'prepare-credentials' });
      assert.strictEqual(f.state.generates, 0); assert.strictEqual(f.state.mutations.length, 0);
    });
  });
  await test('workflow-unknown-yaml-form-fails-closed-and-document-boundaries', () => {
    assert.throws(() => parseSteps(source.replace('        shell: bash', '        shell: pwsh')));
    assert.throws(() => parseSteps(source.replace('        id: origin', '        continue-on-error: true')));
    const doc = fs.readFileSync(path.join(ROOT, 'shared/forge-release-checks.md'), 'utf8');
    for (const phrase of ['job-wide', 'same-UID', 'S04', 'S08', 'S09', 'UAT', 'external', 'pending']) assert(doc.includes(phrase));
  });
  console.log(`${count} workflow tests passed (local real YAML; fake transport/effects; remote/review/UAT pending)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
