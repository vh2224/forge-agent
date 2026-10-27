'use strict';

const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const github = require('./forge-release-github.js');
const checks = require('./forge-release-checks.js');
const { sha256 } = require('./forge-package.js');

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
const TOKEN = 'fixture-secret-never-log';
const REPO = { id: 42, full_name: 'example/forge-agent', fork: false };
const BASE = '/repos/example/forge-agent';
const clone = value => JSON.parse(JSON.stringify(value));
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write(`PASS ${name}\n`); }
function fixture(options = {}) {
  const policy = options.policy || checks.POLICY;
  const candidate = { authenticated: true, candidate_sha: A, checkout_head: A, repository: clone(REPO),
    event_name: 'push', ref: 'refs/heads/master', before: B, workflow_sha: A, trusted_master_sha: C,
    workflow_ref: 'example/forge-agent/.github/workflows/release.yml@refs/heads/master' };
  const sources = { verified: true, candidate_sha: A, policy_sha256: checks.policyDigest(policy),
    workflows: Object.fromEntries(Object.entries(policy.workflows).map(([key, value]) => [key, {
      path: value.path, filename: value.filename, blob_oid: value.blob_oid,
      blob_sha256: value.blob_sha256, jobs: checks.expandJobs(value),
    }])) };
  const applicability = { candidate_sha: A, app_required: true, diff: { available: false, complete: false, paths: null } };
  const state = { time: 0, calls: [], sleeps: [], runs: {}, jobs: {}, tags: {}, tagRef: null, release: null };
  for (const [key, workflowId, runId] of [['ci', 11, 101], ['app', 22, 202]]) {
    state.runs[key] = [{ id: runId, workflow_id: workflowId, path: policy.workflows[key].path,
      head_sha: A, head_branch: 'master', event: 'push', repository: clone(REPO), head_repository: clone(REPO),
      run_attempt: 2, status: 'completed', conclusion: 'success', created_at: '2026-10-20T00:00:00Z',
      run_started_at: '2026-10-20T00:01:00Z', updated_at: '2026-10-20T00:02:00Z' }];
    state.jobs[key] = sources.workflows[key].jobs.map((job, index) => ({ id: workflowId * 1000 + index,
      run_id: runId, head_sha: A, name: job.name, status: 'completed', conclusion: 'success' }));
  }
  function page(url, rows, field) {
    const current = Number(url.searchParams.get('page')); const pages = Math.max(1, Math.ceil(rows.length / 100));
    const headers = {};
    if (current < pages) { const next = new URL(url); next.searchParams.set('page', String(current + 1)); headers.link = `<${next.href}>; rel="next"`; }
    return { data: { total_count: rows.length, [field]: clone(rows.slice((current - 1) * 100, current * 100)) }, headers };
  }
  const notFound = () => ({ statusCode: 404, data: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' } });
  async function request(input) {
    state.calls.push(input);
    assert.strictEqual(input.method, 'GET'); assert.strictEqual(new URL(input.url).origin, 'https://api.github.com');
    assert.strictEqual(input.headers.Accept, 'application/vnd.github+json');
    assert.strictEqual(input.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.strictEqual(input.headers.Authorization, `Bearer ${TOKEN}`);
    assert(!input.url.includes(TOKEN)); assert(input.timeoutMs <= 15000); assert(input.maxBytes > 0);
    const url = new URL(input.url); let response; let kind;
    if (url.pathname === BASE) { kind = 'repository'; response = { data: clone(REPO) }; }
    else if (/\/actions\/workflows\/(ci\.yml|app\.yml|11|22)$/.test(url.pathname)) {
      kind = 'metadata'; const key = /\/(ci\.yml|11)$/.test(url.pathname) ? 'ci' : 'app';
      response = { data: { id: key === 'ci' ? 11 : 22, path: policy.workflows[key].path, name: 'Untrusted display name', state: 'active' } };
    } else if (/\/actions\/workflows\/(11|22)\/runs$/.test(url.pathname)) {
      kind = 'runs'; const key = url.pathname.includes('/11/') ? 'ci' : 'app';
      assert.strictEqual(url.searchParams.get('head_sha'), A); assert.strictEqual(url.searchParams.get('event'), 'push');
      assert.strictEqual(url.searchParams.get('branch'), 'master'); assert.strictEqual(url.searchParams.get('status'), null);
      assert.strictEqual(url.searchParams.get('per_page'), '100'); response = page(url, state.runs[key], 'workflow_runs');
    } else if (/\/actions\/runs\/\d+$/.test(url.pathname)) {
      kind = 'run'; const id = Number(url.pathname.split('/').pop());
      const run = Object.values(state.runs).flat().find(value => value.id === id); assert(run); response = { data: clone(run) };
    } else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname)) {
      kind = 'jobs'; const match = /\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(url.pathname);
      const key = state.runs.ci.some(run => run.id === Number(match[1])) ? 'ci' : 'app';
      const run = state.runs[key].find(value => value.id === Number(match[1]));
      assert.strictEqual(Number(match[2]), run.run_attempt); response = page(url, state.jobs[key], 'jobs');
    } else if (url.pathname.startsWith(`${BASE}/git/ref/tags/`)) {
      kind = 'tag-ref'; response = state.tagRef ? { data: clone(state.tagRef) } : notFound();
    } else if (url.pathname.startsWith(`${BASE}/git/tags/`)) {
      kind = 'tag-object'; response = { data: clone(state.tags[url.pathname.split('/').pop()]) };
    } else if (url.pathname.startsWith(`${BASE}/releases/tags/`)) {
      kind = 'release'; response = state.release ? { data: clone(state.release) } : notFound();
    } else throw new Error(`Unexpected fake URL ${url.pathname}`);
    if (options.hook) response = await options.hook({ input, url, kind, response, state }) || response;
    if (response.raw) return response.raw;
    return { statusCode: response.statusCode || 200, headers: { 'content-type': 'application/json; charset=utf-8', ...response.headers }, body: JSON.stringify(response.data) };
  }
  const reader = github.createGitHubReader({ token: TOKEN, request, clock: () => state.time,
    sleep: async ms => { state.sleeps.push(ms); state.time += ms; if (options.onSleep) options.onSleep(state); }, limits: options.limits });
  return { reader, candidate, sources, applicability, policy, state, collect: () => github.collectChecks({ reader, candidate, sources, applicability, policy }) };
}
function code(result, expected) { assert.strictEqual(result.allowed, false); assert(result.reasons.some(reason => reason.code === expected), JSON.stringify(result)); }
function complete(state) {
  for (const runs of Object.values(state.runs)) for (const run of runs) { run.status = 'completed'; run.conclusion = 'success'; }
  for (const jobs of Object.values(state.jobs)) for (const job of jobs) { job.status = 'completed'; job.conclusion = 'success'; }
}
function pending(state) {
  state.runs.ci[0].status = 'in_progress'; state.runs.ci[0].conclusion = null;
  state.jobs.ci[0].status = 'in_progress'; state.jobs.ci[0].conclusion = null;
}
function manyRuns(f, total) {
  const newest = f.state.runs.ci[0];
  f.state.runs.ci = Array.from({ length: total - 1 }, (_, index) => ({ ...clone(newest), id: index + 1000,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
    run_started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 2 + 1)).toISOString() })).concat([newest]);
}

(async () => {
  await test('github-complete-exact-sha-current-attempt-public-apis-and-get-only', async () => {
    const f = fixture(); const result = await f.collect(); assert(result.allowed, JSON.stringify(result));
    assert.strictEqual(result.evaluation.checks.length, 17); assert.strictEqual(result.snapshot.api_version, github.API_VERSION);
    assert.strictEqual(result.snapshot.policy_sha256, checks.policyDigest()); assert(/^[a-f0-9]{64}$/.test(result.snapshot.sources_sha256));
    assert.strictEqual(result.snapshot.workflows.ci.semantic_jobs[0].key, 'operational-offline');
    assert(!Object.hasOwn(result.facts.workflows.ci.jobs[0], 'run_attempt')); assert(!Object.hasOwn(result.facts.workflows.ci.jobs[0], 'job_key'));
    assert(f.state.calls.every(call => call.method === 'GET')); assert(!JSON.stringify(result).includes(TOKEN));
  });
  await test('github-workflow-filename-numeric-id-full-path-state-and-unique-id', async () => {
    const f = fixture(); assert((await github.collectChecks({ ...f, workflowIds: { ci: 11, app: 22 } })).allowed);
    assert(f.state.calls.some(call => new URL(call.url).pathname.endsWith('/workflows/11')));
    const badLookup = await github.collectChecks({ ...f, workflowIds: { ci: '.github/workflows/ci.yml' } }); code(badLookup, 'workflow-lookup');
    for (const mutate of [data => { data.path = '.github/workflows/impostor.yml'; }, data => { data.state = 'disabled_manually'; }, data => { data.id = '11'; }, data => { data.id = 99; }]) {
      const bad = fixture({ hook: ({ kind, response }) => { if (kind === 'metadata') mutate(response.data); } });
      code(await github.collectChecks({ ...bad, workflowIds: { ci: 11 } }), 'workflow-identity');
    }
    const duplicate = fixture({ hook: ({ kind, response }) => { if (kind === 'metadata') response.data.id = 11; } });
    code(await duplicate.collect(), 'workflow-identity');
  });
  await test('github-git-policy-source-drift-blocks-before-http', async () => {
    const f = fixture(); f.sources.workflows.ci.blob_sha256 = '0'.repeat(64); code(await f.collect(), 'policy-unverified'); assert.strictEqual(f.state.calls.length, 0);
    const other = fixture(); other.sources.workflows.ci.jobs[0].key = 'alias'; code(await other.collect(), 'policy-unverified');
  });
  await test('github-run-repository-fork-event-branch-sha-path-and-id-bound', async () => {
    const mutations = [run => { run.repository.id = 7; }, run => { run.head_repository.full_name = 'fork/forge-agent'; },
      run => { delete run.head_repository; }, run => { run.head_repository.fork = true; }, run => { run.event = 'pull_request'; },
      run => { run.head_branch = 'other'; }, run => { run.head_sha = B; }, run => { run.workflow_id = 33; },
      run => { run.path = '.github/workflows/fake.yml'; }, run => { delete run.run_attempt; }, run => { delete run.status; }];
    for (const mutate of mutations) { const f = fixture(); mutate(f.state.runs.ci[0]); assert(!(await f.collect()).allowed); }
  });
  await test('github-jobs-real-schema-semantic-names-optional-fields-and-duplicates', async () => {
    for (const mutate of [job => { delete job.run_id; }, job => { job.run_id = 9; }, job => { job.head_sha = B; },
      job => { job.name = 'alias'; }, job => { delete job.id; }, job => { delete job.conclusion; },
      job => { job.run_attempt = 1; }, job => { job.workflow_id = 44; }, job => { job.started_at = 'bad'; },
      job => { job.run_url = 'https://api.github.com/repos/fork/repo/actions/runs/101'; },
      job => { job.url = 'https://evil.example'; }, job => { job.check_run_url = 'https://evil.example/check-runs/1'; },
      job => { job.html_url = 'https://github.com/other/repo/actions/runs/101/job/1'; }]) {
      const f = fixture(); mutate(f.state.jobs.ci[0]); assert(!(await f.collect()).allowed);
    }
    const duplicate = fixture(); duplicate.state.jobs.ci[1].id = duplicate.state.jobs.ci[0].id; code(await duplicate.collect(), 'pagination-duplicate-id');
    const name = fixture(); name.state.jobs.ci[1].name = name.state.jobs.ci[0].name; code(await name.collect(), 'job-duplicate');
    const cross = fixture(); cross.state.jobs.app[0].id = cross.state.jobs.ci[0].id; code(await cross.collect(), 'job-duplicate');
  });
  await test('github-pagination-runs-and-jobs-pages-two-three-complete', async () => {
    // Synthetic reviewed policy isolates pagination beyond the real 14 CI jobs.
    const policy = clone(checks.POLICY); policy.workflows.ci.jobs = Array.from({ length: 201 }, (_, i) => ({ key: `job-${i}`, name: `Job ${i}`, runner: 'ubuntu-latest', kind: 'native', needs: [], matrix: null }));
    const f = fixture({ policy }); manyRuns(f, 201); const result = await f.collect(); assert(result.allowed, JSON.stringify(result));
    assert.deepStrictEqual(result.snapshot.workflows.ci.collection.runs, { pages: 3, total_count: 201, collected: 201, complete: true });
    assert.strictEqual(result.snapshot.workflows.ci.collection.jobs.pages, 3);
    assert(f.state.calls.some(call => call.url.includes('/jobs?per_page=100&page=3')));
    assert(!f.state.calls.some(call => call.url.includes('status=success')));
  });
  await test('github-pagination-truncation-missing-pages-changing-count-duplicates-and-bounds', async () => {
    for (const defect of ['short', 'count', 'duplicate', 'missing-link', 'cycle', 'foreign', 'foreign-prev']) {
      const f = fixture({ hook: ({ kind, url, response }) => {
        if (kind !== 'runs' || !url.pathname.includes('/11/')) return;
        const page = Number(url.searchParams.get('page'));
        if (defect === 'short' && page === 2) response.data.workflow_runs.pop();
        if (defect === 'count' && page === 2) response.data.total_count++;
        if (defect === 'duplicate' && page === 2) response.data.workflow_runs[0].id = 1000;
        if (defect === 'missing-link' && page === 1) delete response.headers.link;
        if (defect === 'cycle' && page === 1) response.headers.link = `<${url.href}>; rel="next"`;
        if (defect === 'foreign' && page === 1) response.headers.link = '<https://evil.example/next>; rel="next"';
        if (defect === 'foreign-prev' && page === 2) response.headers.link += ', <https://evil.example/prev>; rel="prev"';
      } });
      manyRuns(f, 201); assert(!(await f.collect()).allowed, defect);
    }
    const cap = fixture(); manyRuns(cap, 1000); code(await cap.collect(), 'pagination-limit');
    const bound = fixture({ limits: { maxPages: 1 } }); manyRuns(bound, 101); code(await bound.collect(), 'pagination-limit');
    const item = fixture({ limits: { maxItems: 1 } }); code(await item.collect(), 'pagination-limit');
  });
  await test('github-late-page-failure-never-authorizes', async () => {
    const f = fixture({ hook: ({ kind, url, response }) => {
      if (kind === 'runs' && url.searchParams.get('page') === '3') { response.statusCode = 401; response.data = { message: TOKEN }; }
    } }); manyRuns(f, 201); const result = await f.collect(); code(result, 'authentication-failed'); assert(!JSON.stringify(result).includes(TOKEN));
  });
  await test('github-latest-rerun-old-run-governs-and-overlap-is-ambiguous', async () => {
    const f = fixture(); const old = clone(f.state.runs.ci[0]); old.id = 303; old.created_at = '2026-10-19T00:00:00Z';
    old.run_started_at = '2026-10-20T01:00:00Z'; old.updated_at = '2026-10-20T01:01:00Z'; old.run_attempt = 3;
    f.state.runs.ci.push(old); f.state.jobs.ci.forEach(job => { job.run_id = 303; });
    const result = await f.collect(); assert(result.allowed, JSON.stringify(result)); assert.strictEqual(result.snapshot.workflows.ci.run.id, 303);
    old.run_started_at = '2026-10-20T00:01:30Z'; code(await f.collect(), 'run-order-ambiguous');
    old.run_started_at = f.state.runs.ci[0].run_started_at; code(await f.collect(), 'run-order-ambiguous');
  });
  await test('github-partial-current-attempt-does-not-inherit-old-green', async () => {
    const f = fixture(); f.state.runs.ci[0].run_attempt = 3; f.state.jobs.ci = f.state.jobs.ci.slice(0, 1);
    code(await f.collect(), 'current-attempt-coverage-incomplete');
    assert(f.state.calls.some(call => call.url.includes('/runs/101/attempts/3/jobs')));
    assert(!f.state.calls.some(call => call.url.includes('/attempts/2/jobs')));
  });
  await test('github-reread-run-attempt-and-entire-index-detect-races', async () => {
    for (const race of ['attempt', 'new-run', 'missing-appears', 'other-workflow-latency']) {
      let sawJobs = false; const f = fixture({ hook: ({ kind, response, state, url }) => {
        if (kind === 'jobs') sawJobs = true;
        if (kind === 'run' && sawJobs && race === 'attempt') response.data.run_attempt++;
        if (kind === 'runs' && sawJobs && race === 'new-run' && url.pathname.includes('/11/')) {
          const newer = clone(state.runs.ci[0]); newer.id = 909; response.data.total_count++; response.data.workflow_runs.push(newer);
        }
        if (kind === 'runs' && race === 'missing-appears' && url.pathname.includes('/11/')) {
          if (!sawJobs) response.data = { total_count: 0, workflow_runs: [] };
        }
        if (kind === 'jobs' && race === 'other-workflow-latency' && url.pathname.includes('/202/')) state.runs.ci[0].run_attempt++;
      } }); code(await f.collect(), 'snapshot-changed');
    }
  });
  await test('github-wait-pending-and-missing-with-one-monotonic-budget', async () => {
    const f = fixture({ onSleep: state => complete(state) }); pending(f.state);
    const result = await github.waitForChecks(f); assert(result.allowed, JSON.stringify(result)); assert.deepStrictEqual(f.state.sleeps, [15000]);
    assert.strictEqual(result.snapshot.collection.elapsed_ms, 15000);
    let first = true; const missing = fixture({ hook: ({ kind, response }) => { if (first && kind === 'runs') response.data = { total_count: 0, workflow_runs: [] }; }, onSleep: () => { first = false; } });
    assert((await github.waitForChecks(missing)).allowed);
    const exhausted = fixture({ limits: { deadlineMs: 30000 } }); pending(exhausted.state);
    code(await github.waitForChecks(exhausted), 'deadline-exhausted'); assert.deepStrictEqual(exhausted.state.sleeps, [15000]);
  });
  await test('github-wait-allows-observed-long-CI-but-retains-one-hour-and-IO-ceilings', async () => {
    const slow=fixture({onSleep:state=>{if(state.time>=35*60*1000)complete(state);}});
    pending(slow.state);
    const result=await github.waitForChecks(slow);
    assert(result.allowed,JSON.stringify(result));
    assert(result.snapshot.collection.elapsed_ms>=35*60*1000);
    assert(slow.state.sleeps.length>120,'actual repeated polling beyond old deadline');
    const stuck=fixture();pending(stuck.state);
    code(await github.waitForChecks(stuck),'deadline-exhausted');
    assert(stuck.state.time<github.DEFAULT_LIMITS.deadlineMs);
    const bounded=fixture({limits:{maxBytes:100}});pending(bounded.state);
    code(await github.waitForChecks(bounded),'response-limit');
  });
  await test('github-terminal-failure-skipped-neutral-and-invalid-states-do-not-poll', async () => {
    for (const conclusion of ['failure', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required']) {
      const f = fixture(); f.state.jobs.ci[0].conclusion = conclusion; code(await github.waitForChecks(f), 'job-not-success'); assert.strictEqual(f.state.sleeps.length, 0);
    }
    const f = fixture(); f.state.jobs.ci[0].status = 'unknown'; code(await f.collect(), 'execution-state');
  });
  await test('github-429-5xx-retry-after-shares-deadline-and-byte-budget', async () => {
    let attempts = 0; const f = fixture({ hook: ({ kind }) => { if (kind === 'repository' && attempts++ < 2) return { statusCode: attempts === 1 ? 429 : 503, headers: { 'retry-after': '1' }, data: { message: TOKEN } }; } });
    assert((await f.collect()).allowed); assert.deepStrictEqual(f.state.sleeps, [1000, 1000]);
    const noRenew = fixture({ limits: { deadlineMs: 3000 }, hook: () => ({ statusCode: 429, headers: { 'retry-after': '2' }, data: {} }) });
    code(await noRenew.collect(), 'deadline-exhausted'); assert.deepStrictEqual(noRenew.state.sleeps, [2000]);
    const invalid = fixture({ hook: () => ({ statusCode: 503, headers: { 'retry-after': TOKEN }, data: {} }) }); code(await invalid.collect(), 'retry-after-invalid');
  });
  await test('github-timeout-transport-auth-json-bytes-redirects-sanitized', async () => {
    const cases = [
      ['request-timeout', { limits: { requestMs: 5 }, hook: async () => new Promise(() => {}) }],
      ['transport-error', { hook: () => { throw new Error(TOKEN); } }],
      ['authentication-failed', { hook: () => ({ statusCode: 403, data: { message: TOKEN } }) }],
      ['redirect-refused', { hook: () => ({ statusCode: 302, headers: { location: `https://evil.example/${TOKEN}` }, data: {} }) }],
      ['response-json', { hook: () => ({ raw: { statusCode: 200, headers: {}, body: TOKEN } }) }],
      ['response-content-type', { hook: ({ response }) => ({ ...response, headers: { 'content-type': 'text/html' } }) }],
      ['response-limit', { limits: { responseBytes: 5 } }],
      ['response-limit', { limits: { maxBytes: 100 } }],
      ['request-limit', { limits: { maxRequests: 1 } }],
    ];
    for (const [expected, options] of cases) {
      const f = fixture(options); const result = await f.collect(); code(result, expected); assert(!JSON.stringify(result).includes(TOKEN));
    }
    const f = fixture(); for (const url of ['https://evil.example/repos/x', '/repos/a/../x', '/repos/%2e%2e/x', '/repos/a\\x', 'https://user@api.github.com/repos/x']) {
      await assert.rejects(() => f.reader.get(url, f.reader.startSession()));
    }
    assert.strictEqual(f.state.calls.length, 0);
    await assert.rejects(() => f.reader.get(`/repos/example/${TOKEN}`, f.reader.startSession()));
  });
  await test('github-lightweight-annotated-tags-release-identity-and-no-commitish-proof', async () => {
    const f = fixture(); f.state.tagRef = { ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: A } };
    f.state.release = { id: 77, tag_name: 'v1.2.3', draft: false, prerelease: false, target_commitish: 'master', url: `https://api.github.com${BASE}/releases/77` };
    let result = await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }); assert(result.ok); assert.strictEqual(result.tag.peeled_commit, A); assert(!Object.hasOwn(result.release, 'target_commitish'));
    f.state.tagRef.object = { type: 'tag', sha: B }; f.state.tags[B] = { sha: B, object: { type: 'tag', sha: C } }; f.state.tags[C] = { sha: C, object: { type: 'commit', sha: A } };
    result = await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }); assert(result.ok); assert.strictEqual(result.tag.tag_oid, B); assert.strictEqual(result.tag.peeled_commit, A);
    f.state.tags[C].object.sha = B; code(await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }), 'tag-object');
    f.state.tags[C].object = { type: 'tree', sha: A }; code(await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }), 'tag-object');
    f.state.tags[C].object = { type: 'commit', sha: A }; f.state.release.tag_name = 'other'; code(await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }), 'release-identity');
    const bounded = fixture({ limits: { maxTagDepth: 1 } }); bounded.state.tagRef = clone(f.state.tagRef); bounded.state.tags = clone(f.state.tags); code(await github.inspectTagRelease({ ...bounded, tag: 'v1.2.3' }), 'tag-depth');
  });
  await test('github-absence-only-authenticated-valid-404-and-master-route', async () => {
    const f = fixture(); const result = await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }); assert(result.ok); assert.strictEqual(result.tag.state, 'absent'); assert.strictEqual(result.release.state, 'absent');
    for (const mode of ['repo-denied', 'invalid-404', 'network', 'release-without-tag']) {
      const bad = fixture({ hook: ({ kind }) => {
        if (mode === 'repo-denied' && kind === 'repository') return { statusCode: 404, data: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
        if (mode === 'invalid-404' && kind === 'tag-ref') return { statusCode: 404, data: { message: TOKEN } };
        if (mode === 'network' && kind === 'tag-ref') throw new Error(TOKEN);
      } });
      if (mode === 'release-without-tag') bad.state.release = { id: 77, tag_name: 'v1.2.3', draft: false, prerelease: false, url: `https://api.github.com${BASE}/releases/77` };
      const unknown = await github.inspectTagRelease({ ...bad, tag: 'v1.2.3' }); assert(!unknown.ok); assert.strictEqual(unknown.tag.state, 'unknown'); assert(!JSON.stringify(unknown).includes(TOKEN));
    }
    f.candidate.ref = 'refs/tags/v1.2.3'; const calls = f.state.calls.length; code(await github.inspectTagRelease({ ...f, tag: 'v1.2.3' }), 'origin-unverified'); assert.strictEqual(f.state.calls.length, calls);
  });
  await test('github-encoded-tag-segments-and-invalid-inputs-never-send', async () => {
    const f = fixture(); assert((await github.inspectTagRelease({ ...f, tag: 'releases/v1.2.3' })).ok);
    assert(f.state.calls.some(call => call.url.endsWith('/git/ref/tags/releases%2Fv1.2.3')));
    for (const tag of ['../x', 'a/../x', 'a//x', 'x.lock', 'x?token', 'x%2fy']) {
      const before = f.state.calls.length; code(await github.inspectTagRelease({ ...f, tag }), 'invalid-tag'); assert.strictEqual(f.state.calls.length, before);
    }
    assert.throws(() => github.createGitHubReader({ token: '' })); assert.throws(() => github.createGitHubReader({ token: TOKEN, limits: { deadlineMs: github.DEFAULT_LIMITS.deadlineMs + 1 } }));
  });
  await test('github-cli-get-only-no-report-generation-and-no-token-argv', async () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-release-github.js'), 'wait', '--token', 'forbidden'], { encoding: 'utf8', env: {} });
    assert.strictEqual(result.status, 1); assert(result.stderr.includes('cli-arguments')); assert(!result.stderr.includes('forbidden'));
    const source = fs.readFileSync(path.join(__dirname, 'forge-release-github.js'), 'utf8');
    assert(!source.includes("require('./forge-release-gate")); assert(!source.includes('buildReport')); assert(!source.includes("method: 'POST'"));
    assert(source.includes('checks.evaluateChecks')); assert(source.includes("require('./forge-release-policy.js')"));
    assert.strictEqual(github.DEFAULT_LIMITS.deadlineMs, 3600000); assert.strictEqual(github.DEFAULT_LIMITS.requestMs, 15000); assert.strictEqual(github.DEFAULT_LIMITS.pollMs, 15000);
    assert.strictEqual(sha256(Buffer.from(source)).length, 64);
  });
  process.stdout.write(`${count} GitHub collector contract groups passed (fake transport/clock, no network or mutations).\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
