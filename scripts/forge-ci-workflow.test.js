'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const concurrency = require('./forge-ci-concurrency.js');
const { POLICY, expandJobs, assertJobMapping } = require('./forge-release-checks.js');
const { loadShardProfile, planShards, verifyPartition } = require('./forge-ci-shards.js');
const { discoverTests } = require('./run-tests.js');

const root = path.resolve(__dirname, '..');
const bytes = Object.fromEntries(['ci', 'app', 'release'].map(id => [id, fs.readFileSync(path.join(root, '.github', 'workflows', `${id}.yml`))]));
const texts = Object.fromEntries(Object.entries(bytes).map(([id, value]) => [id, value.toString('utf8')]));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const marker = (kind, index, detail) => console.log(`PASS S04-T06 ${kind}:${index} ${detail}`);

// Reverse only the two authorized changes. The old physical digests pin every
// other byte: triggers, actions, permissions, matrices, SVN, smoke and aliases.
for (const id of ['ci', 'app']) {
  assert(!bytes[id].includes(13) && !texts[id].startsWith('\uFEFF'), `${id} must retain LF without BOM`);
  const block = '# Superseded pull request runs are cancelled; every other event gets a\n'
    + '# unique per-run group, so master validation is never cancelled or queued.\n'
    + `concurrency:\n  group: ${concurrency.SUPPORTED_FORMS.groups[id]}\n`
    + `  cancel-in-progress: ${concurrency.SUPPORTED_FORMS.cancellations.pull_request}\n\n`;
  assert.strictEqual(texts[id].split(block).length, 2);
  assert(texts[id].includes(`permissions:\n  contents: read\n\n${block}jobs:`));
  let original = texts[id].replace(block, '');
  if (id === 'ci') original = original.replace(' --shard-profile scripts/fixtures/ci-shards/shard-profile.json', '');
  assert.strictEqual(hash(original), id === 'ci'
    ? '5c37cf20bab5613832e0a5efad3e5fa7b9494a57ddbd67a680e4510228e5ffdc'
    : 'cb12bc265ca1e21335f2be3b20961cab8bb878aefe1cde6053a9fef1e55c33e5');
  assert.deepStrictEqual(concurrency.readConcurrency(texts[id]), { present: true,
    group: concurrency.SUPPORTED_FORMS.groups[id], 'cancel-in-progress': concurrency.SUPPORTED_FORMS.cancellations.pull_request });
}
assert.strictEqual(hash(bytes.release), 'c19b795426f6d0cec090630f90f1c3aa45d3bc83d573aab92cac332e0f3017a3');
assert.deepStrictEqual(concurrency.readConcurrency(texts.release), { present: true, group: 'release', 'cancel-in-progress': 'false' });
assert.strictEqual(POLICY.workflows.release.blob_oid, '315d89bad9b4ef2965d3a2f3e969fd83005e61d2');
marker('truth', 0, 'exact PR-only workflow forms and unchanged release bytes and pin');

// Issue 218: unsupported YAML structure must not silently disappear.
for (const text of [
  '"jobs":\n  test:\n    concurrency: all',
  "'jobs':\n  test:\n    concurrency: all",
  'jobs:\n  test:\n    "concurrency": all',
  "jobs:\n  test:\n    'concurrency': all",
  '"concurrency": all',
  'jobs: {test: {concurrency: all}}',
  'jobs:\n  test: {concurrency: all}',
  '{jobs: {test: {concurrency: all}}}',
]) assert.throws(() => concurrency.readConcurrency(text), /unsupported/);
assert.deepStrictEqual(concurrency.readConcurrency('# "concurrency": ignored\nname: "concurrency: text"\njobs:\n  test:\n    steps:\n      - run: |\n          concurrency: script text\n          "jobs": script text'), { present: false });

const rehearsal = concurrency.rehearse(bytes);
assert.strictEqual(rehearsal.schema, 'forge-ci-concurrency-rehearsal/v1');
assert(rehearsal.passed);
assert.strictEqual(rehearsal.scenarios.length, 28);
assert.strictEqual(rehearsal.group_contexts.length, 18);
assert.strictEqual(new Set(rehearsal.group_contexts.filter(row => row.workflow === 'app' && row.event_name !== 'pull_request').map(row => row.group)).size, 3);
assert(rehearsal.limitations.includes('release-pending-may-be-replaced'));
assert(rehearsal.limitations.includes('old-manual-pr-reruns-newest-head-unverified'));
assert(rehearsal.limitations.includes('hosted-validation-pending'));
assert(rehearsal.assumptions.includes('pending-until-cancellation-ends-is-model-assumption'));
assert(rehearsal.queue_note.includes('queue'));
for (const row of rehearsal.scenarios) {
  assert(Object.values(row.invariants).every(Boolean), `${row.name}/${row.cancel_latency}`);
  assert(row.runs.every(run => ['completed', 'cancelled-in-progress', 'replaced-while-pending'].includes(run.result)));
  if (row.name === 'release-burst') {
    assert.deepStrictEqual(row.runs.map(run => run.result), ['completed', 'replaced-while-pending', 'completed']);
    assert(row.limitations.includes('release-pending-may-be-replaced'));
  }
  // Reconstruct capacity from the observable timeline, including cancelling runs.
  const capacity = new Map();
  for (const event of row.timeline) {
    const slot = capacity.get(event.group) || { active: null, pending: null };
    if (event.action === 'started') {
      assert.strictEqual(slot.active, null);
      if (slot.pending === event.run_id) slot.pending = null;
      slot.active = event.run_id;
    } else if (event.action === 'pending') {
      assert.strictEqual(slot.pending, null);
      slot.pending = event.run_id;
    } else if (event.action === 'replaced-while-pending') {
      assert.strictEqual(slot.pending, event.run_id);
      slot.pending = null;
    } else if (['completed', 'cancelled-in-progress'].includes(event.action)) {
      assert.strictEqual(slot.active, event.run_id);
      slot.active = null;
    }
    capacity.set(event.group, slot);
  }
  assert([...capacity.values()].every(slot => slot.active === null && slot.pending === null));
}
marker('truth', 1, 'fresh-arrival bursts pass all six invariants at latencies 0 1 10 100; release pending replacement disclosed');

const ciForm = concurrency.readConcurrency(texts.ci);
assert(Object.isFrozen(concurrency.SUPPORTED_FORMS));
assert(Object.isFrozen(concurrency.SUPPORTED_FORMS.groups));
assert(Object.isFrozen(concurrency.SUPPORTED_FORMS.cancellations));
assert.deepStrictEqual(concurrency.readConcurrency('name: none\njobs:\n  test:\n'), { present: false });
assert.deepStrictEqual(concurrency.readConcurrency(texts.ci.replace(/\n/g, '\r\n')), ciForm);
for (const [source, code] of [
  [texts.ci.replace('concurrency:\n', 'concurrency:\n  queue: max\n'), 'concurrency-key-unsupported'],
  [texts.ci.replace('concurrency:\n', 'concurrency:\n  unknown: value\n'), 'concurrency-key-unsupported'],
  [texts.ci.replace('jobs:\n', 'jobs:\n  test-added:\n    concurrency: global\n'), 'job-concurrency-unsupported'],
  ['concurrency: literal\njobs:\n', 'concurrency-form-unsupported'],
  [texts.ci.replace(ciForm.group, '${{ github.head_ref }}'), 'expression-unsupported'],
  [texts.ci.replace(ciForm['cancel-in-progress'], 'true'), 'expression-unsupported'],
  [texts.ci.replace(`group: ${ciForm.group}`, `group: "${ciForm.group}"`), 'expression-unsupported'],
  [texts.ci.replace('concurrency:\n', 'concurrency:\n  group: release\n'), 'concurrency-key-unsupported'],
  ['concurrency:\n  group: release\njobs:\n', 'expression-unsupported'],
]) assert.throws(() => concurrency.readConcurrency(source), error => error.code === code, code);
const badGlobal = { workflowId: 'ci', inputs: ['head_ref'], group: () => 'global', cancel: () => true };
const pushEvents = concurrency.REHEARSALS.find(row => row.name === 'master-burst').events;
const cancelled = concurrency.simulate({ models: { ci: badGlobal }, events: pushEvents, cancelLatency: 10 });
assert(!cancelled.passed && !cancelled.invariants['push-never-cancelled'] && !cancelled.invariants['pr-superseded-only']);
assert(!cancelled.invariants['no-pr-controlled-group-input']);
const badRef = { inputs: ['ref'], group: event => event.ref, cancel: () => false };
const replaced = concurrency.simulate({ models: { ci: badRef }, events: pushEvents });
assert(!replaced.passed && !replaced.invariants['push-never-cancelled'] && !replaced.invariants['pr-superseded-only']);
assert(!replaced.invariants['groups-disjoint']);
assert.throws(() => concurrency.simulate({ models: {}, events: [], cancelLatency: -1 }));
marker('truth', 2, 'fail-closed parser negatives and injected global-cancel/ref-group models rejected by invariants');
marker('key_link', 0, 'readConcurrency and rehearse consume real workflow bytes; simulate detects injected bad models');

const testStep = texts.ci.match(/^      - name: Run test suites\n([\s\S]*?)(?=^      - name:)/m)[1];
const command = testStep.match(/^        run: (.+)$/m)[1];
assert.strictEqual(command, 'node scripts/run-tests.js --baseline scripts/fixtures/ci-baseline/known-failures.json'
  + ' --shard-profile scripts/fixtures/ci-shards/shard-profile.json --shard-index ${{ matrix.shard-index }} --shard-count ${{ matrix.shard-count }}');
assert(!/--(?:changed|match|fail-fast|inherit-home)\b/.test(command));
assert(!/\b(?:paths|paths-ignore|branches-ignore):/.test(texts.ci.split('\npermissions:')[0]));
const steps = texts.ci.match(/^      - name:[^\n]*(?:\n(?!      - name:)[^\n]*)*/gm);
const testIndex = texts.ci.indexOf('      - name: Run test suites');
const smokeIndex = texts.ci.indexOf('      - name: Smoke suite (release gate)');
assert(testIndex < smokeIndex);
assert(texts.ci.slice(smokeIndex).includes("if: runner.os != 'Windows'"));
for (const [platform, pattern] of [
  ['Linux', /run:\s*sudo apt-get update && sudo apt-get install -y subversion/],
  ['macOS', /run:\s*brew install subversion/],
  ['Windows', /run:\s*\|\s*choco install sliksvn --version=1\.14\.5 --yes --no-progress/],
]) {
  const matches = steps.filter(step => pattern.test(step));
  assert.strictEqual(matches.length, 1);
  assert(matches[0].includes(`if: runner.os == '${platform}'`));
  assert(texts.ci.indexOf(matches[0]) < testIndex);
}
const windowsInstall = steps.find(step => /choco install sliksvn/.test(step));
for (const required of ["Join-Path $env:ProgramFiles 'SlikSvn\\bin'", "foreach ($tool in 'svn.exe', 'svnadmin.exe')",
  'Test-Path -LiteralPath $toolPath -PathType Leaf', "$expectedVersion = '1.14.5'",
  '$actualVersion = & $toolPath --version --quiet', 'if ($LASTEXITCODE -ne 0) { throw',
  "$expectedVersionPattern = '\\A' + [regex]::Escape($expectedVersion) + '(-SlikSvn)?\\z'",
  'if ($actualVersion -isnot [string] -or $actualVersion -cnotmatch $expectedVersionPattern)',
  '$env:PATH = "$svnBin;$env:PATH"', '-FilePath $env:GITHUB_PATH']) assert(windowsInstall.includes(required), required);
assert(windowsInstall.indexOf('-cnotmatch') < windowsInstall.indexOf('$svnBin | Out-File'));
const verifySteps = steps.filter(step => /svn --version --quiet/.test(step) && /svnadmin --version --quiet/.test(step));
assert.strictEqual(verifySteps.length, 1);
assert(!/^\s*if:/m.test(verifySteps[0]) && texts.ci.indexOf(verifySteps[0]) < testIndex);
const rows = expandJobs(POLICY.workflows.ci);
assert.strictEqual(rows.length, 14);
assert.strictEqual(rows.filter(row => row.kind === 'alias').length, 7);
assert.deepStrictEqual(rows.filter(row => row.key === 'test').map(row => row.name), [
  'Tests (ubuntu-latest)', 'Tests (macos-latest)', 'Tests (windows-latest, shard 1/2)', 'Tests (windows-latest, shard 2/2)']);
assert.deepStrictEqual(rows.filter(row => row.key === 'test' && row.matrix.platform === 'win32').map(row => row.matrix['shard-count']), [2, 2]);
marker('key_link', 2, 'CI source test command triggers concurrency SVN ordering and smoke structure asserted');

const suites = discoverTests([]);
const profilePath = command.match(/--shard-profile (\S+)/)[1];
assert.strictEqual(profilePath, 'scripts/fixtures/ci-shards/shard-profile.json');
const profile = loadShardProfile(path.join(root, profilePath));
assert.strictEqual(profile.state, 'loaded');
const cells = new Map(rows.filter(row => row.key === 'test').map(row => [`${row.matrix.platform}/${row.matrix['shard-count']}`, row.matrix]));
for (const cell of cells.values()) {
  const plans = Array.from({ length: cell['shard-count'] }, (_, index) => planShards({
    suites, index, count: cell['shard-count'], platform: cell.platform, profile }));
  assert(plans.every(plan => plan.fallback === null && plan.algorithm === 'weighted-lpt-v1'));
  assert.strictEqual(new Set(plans.map(plan => plan.partition_sha256)).size, 1);
  assert(verifyPartition(suites, plans.map(plan => plan.selected)).ok);
  console.log(`PASS partition ${cell.platform}/${cell['shard-count']} universe=${suites.length} unprofiled=${plans[0].unprofiled.length} stale=${plans[0].stale.length} partition_sha256=${plans[0].partition_sha256}`);
}
marker('truth', 3, 'baseline and versioned profile wired; full matrix coverage disjoint with equal fingerprints and fallback null; CI structure preserved');
marker('key_link', 1, 'loadShardProfile planShards and verifyPartition exercise every real matrix platform/count/index');
marker('key_link', 5, 'Run test suites invokes run-tests with baseline profile and final shard-index/count flags');
marker('key_link', 6, 'CI profile checkout path loaded and real-universe partition verified without fallback');

for (const id of ['ci', 'app', 'release']) {
  const workflow = POLICY.workflows[id];
  assert.strictEqual(workflow.blob_sha256, hash(bytes[id]));
  assert.strictEqual(workflow.blob_oid, crypto.createHash('sha1').update(Buffer.concat([
    Buffer.from(`blob ${bytes[id].length}\0`), bytes[id]])).digest('hex'));
  assertJobMapping(texts[id], workflow);
  if (id !== 'release') marker('key_link', id === 'ci' ? 3 : 4, `${id} final LF sha256 and Git blob SHA1 pins match unchanged job mapping`);
}
assert.strictEqual(hash(JSON.stringify(Object.fromEntries(Object.entries(POLICY.workflows).map(([key, value]) => [key, value.jobs])))),
  'b495392f2ed224612a17c5ad5a091043c0d7c8994ab845a3ecc22524eb5c4c16');
const documentation = fs.readFileSync(path.join(root, 'shared', 'forge-release-checks.md'), 'utf8');
for (const term of ['job-wide', 'same-UID', 'S04', 'S08', 'S09', 'UAT', 'external', 'pending',
  'release-pending-may-be-replaced', 'manual reruns', 'hosted validation', '--shard-profile']) assert(documentation.includes(term), term);
const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-ci-concurrency.js'), '--rehearse', '--json', '--root', root], { encoding: 'utf8' });
assert.strictEqual(cli.status, 0, cli.stderr);
assert.deepStrictEqual(JSON.parse(cli.stdout), rehearsal);
const invalidCli = spawnSync(process.execPath, [path.join(__dirname, 'forge-ci-concurrency.js'), '--rehearse', '--unknown'], { encoding: 'utf8' });
assert.strictEqual(invalidCli.status, 2);
assert(invalidCli.stderr.includes('cli-argument-invalid'));
marker('truth', 4, 'CI app pins and semantic mappings preserved; smoke section 76 structure and S04 contract checked; remote validation pending');
console.log('forge-ci-workflow: all assertions passed (local model and structural checks; no hosted workflow execution)');
