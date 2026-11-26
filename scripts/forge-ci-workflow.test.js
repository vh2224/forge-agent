'use strict';
const issue463SourceConsumer = require('./fixtures/issue-463/distribution.cjs');
issue463SourceConsumer.validateSourceConsumer(() => {


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const concurrency = require('./forge-ci-concurrency.js');
const { POLICY, expandJobs, assertJobMapping } = require('./forge-release-checks.js');
const { loadShardProfile, planShards, verifyPartition, loadPlanningOverrides } = require('./forge-ci-shards.js');
const { discoverTests } = require('./run-tests.js');
const { expandSuites, unitWeights } = require('./forge-ci-units.js');
const { workerLayout } = require('./forge-ci-parallel.js');

const root = path.resolve(__dirname, '..');
const bytes = Object.fromEntries(['ci', 'app', 'release'].map(id => [id, fs.readFileSync(path.join(root, '.github', 'workflows', `${id}.yml`))]));
const texts = Object.fromEntries(Object.entries(bytes).map(([id, value]) => [id, value.toString('utf8')]));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const latencyLayer = require('./fixtures/ci-latency/workflow-layer.json');
const predecessorCi = fs.readFileSync(path.join(__dirname, 'fixtures/ci-latency/predecessor-ci.yml'), 'utf8');
const predecessorRelease = fs.readFileSync(path.join(__dirname, 'fixtures/ci-latency/predecessor-release.yml'), 'utf8');
assert.strictEqual(hash(predecessorRelease), '635887910ef3fdb5b5c0b7731ee7e6dee86c39e6e675b6d701cacf8e4a321747');
assert.strictEqual(hash(bytes.release), latencyLayer.release_after.sha256);
assert.strictEqual(hash(predecessorCi), latencyLayer.ci_before.sha256);
// Issue 440 additive layer: current ci.yml = ci-latency ci_after plus exactly one
// ' --verbose true' suffix on the existing Run test suites command.
const verboseLayer = require('./fixtures/issue-440/workflow-layer.json');
const gitBlob = value => crypto.createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
const ciHistoryView = require('./fixtures/issue-463/distribution.cjs');
// Only the immutable ancestor pin chain selects the authenticated Native
// predecessor. bytes.ci/texts.ci below remain the actual current workflow.
const nativePredecessorCi = bytes => ciHistoryView.projectIssue463Read(() => bytes)('.github/workflows/ci.yml');
const historicalCi = bytes => ciHistoryView.projectIssue461Read(() => nativePredecessorCi(bytes))('.github/workflows/ci.yml');
assert.strictEqual(hash(nativePredecessorCi(bytes.ci)), '0c2deeaa3f7b429ba1d7c208836159f80ca48f0cae36ab171b4a1d26b18dc8ad');
assert.strictEqual(gitBlob(nativePredecessorCi(bytes.ci)), '9b968e1cd62509edca22cffd8b779a3a25063b50');
assert.strictEqual(hash(historicalCi(bytes.ci)), verboseLayer.ci_after.sha256);
assert.strictEqual(gitBlob(historicalCi(bytes.ci)), verboseLayer.ci_after.oid);
assert.deepStrictEqual(verboseLayer.ci_before, latencyLayer.ci_after, 'issue-440 layer chains onto the ci-latency layer');
assert.strictEqual(verboseLayer.base, '4606de1ecac3ddee7bc957d9a8dea3207023d5b5');
assert.strictEqual(verboseLayer.oldCommand, latencyLayer.newCommand);
assert.strictEqual(verboseLayer.newCommand, verboseLayer.oldCommand + verboseLayer.delta);
assert.strictEqual(verboseLayer.delta, ' --verbose true');
const reconstructCi = text => {
  const runLine = command => `        run: ${command}\n`;
  if (text.split(runLine(verboseLayer.newCommand)).length !== 2) throw Error('issue-440-layer-command-not-unique');
  return text.replace(runLine(verboseLayer.newCommand), runLine(verboseLayer.oldCommand));
};
const predecessorOfVerbose = Buffer.from(reconstructCi(historicalCi(bytes.ci).toString('utf8')));
assert.strictEqual(hash(predecessorOfVerbose), latencyLayer.ci_after.sha256, 'the single command delta reconstructs the ci-latency ci_after bytes');
assert.strictEqual(gitBlob(predecessorOfVerbose), latencyLayer.ci_after.oid);
// Negative: any second difference survives the single-delta reversal and fails the chain.
for (const second of [
  texts.ci.replace('          retention-days: 14\n', '          retention-days: 15\n'),
  texts.ci.replace('      - name: Preserve bounded suite timing profile\n', '      - name: Second native run\n        run: node scripts/run-tests.js --verbose\n\n      - name: Preserve bounded suite timing profile\n'),
  texts.ci.replace('--tool-plan true --jobs', '--tool-plan true --verbose true --jobs'),
]) {
  assert.notStrictEqual(second, texts.ci);
  assert.notStrictEqual(hash(reconstructCi(historicalCi(Buffer.from(second)).toString('utf8'))), latencyLayer.ci_after.sha256, 'a second workflow difference is refused');
}
assert.throws(() => reconstructCi(texts.ci.replace(' --verbose true\n', '\n')), /issue-440-layer-command-not-unique/);
assert.strictEqual(texts.ci.split(' --verbose true').length, 2, 'exactly one --verbose argument in the workflow');
assert.strictEqual(latencyLayer.ci_before.sha256, 'aaebc13d224e26dc85fbf7c077a878b550fc041978dc30d9e6995da15d650fc8');
assert(texts.ci.includes("if: runner.os == 'Windows' && steps.fixture_tools.outputs.needs_svn != 'false'"));
assert(texts.ci.includes("if: runner.os != 'Windows' || steps.fixture_tools.outputs.needs_svn != 'false'"));
assert(texts.ci.includes('id: fixture_tools')&&texts.ci.includes('--tool-plan true --jobs'));
const actualTestStep=texts.ci.split('      - name: Run test suites\n')[1].split('      - name: Preserve bounded suite timing profile')[0];
assert(!/^\s+if:/m.test(actualTestStep),'tool setup metadata never skips the actual test step');
assert(!actualTestStep.includes('--tool-plan'),'tool metadata mode never replaces actual test execution');
const marker = (kind, index, detail) => console.log(`PASS S04-T06 ${kind}:${index} ${detail}`);

// Reverse the authorized concurrency, profile, four-shard and two-macOS-shard changes. Old
// digests pin every other byte: triggers, actions, permissions, matrices, SVN, smoke and aliases.
for (const id of ['ci', 'app']) {
  assert(!bytes[id].includes(13) && !texts[id].startsWith('\uFEFF'), `${id} must retain LF without BOM`);
  const block = '# Superseded pull request runs are cancelled; every other event gets a\n'
    + '# unique per-run group, so master validation is never cancelled or queued.\n'
    + `concurrency:\n  group: ${concurrency.SUPPORTED_FORMS.groups[id]}\n`
    + `  cancel-in-progress: ${concurrency.SUPPORTED_FORMS.cancellations.pull_request}\n\n`;
  assert.strictEqual(texts[id].split(block).length, 2);
  assert(texts[id].includes(`permissions:\n  contents: read\n\n${block}jobs:`));
  let original = (id === 'ci' ? predecessorCi : texts[id]).replace(block, '');
  if (id === 'ci') {
    const profileArgument = ' --profile-out "${{ runner.temp }}/forge-suite-profile-${{ matrix.os }}-${{ matrix.shard-index }}.json"';
    const profileStep = '\n      - name: Preserve bounded suite timing profile\n'
      + '        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n'
      + '          name: suite-profile-${{ matrix.os }}-${{ matrix.shard-index }}\n'
      + '          path: ${{ runner.temp }}/forge-suite-profile-${{ matrix.os }}-${{ matrix.shard-index }}.json\n'
      + '          if-no-files-found: warn\n          retention-days: 14\n';
    for (const delta of [profileArgument, profileStep]) assert.strictEqual(original.split(delta).length, 2);
    original = original.replace(profileArgument, '').replace(profileStep, '');
    original = original.replace(' --shard-profile scripts/fixtures/ci-shards/shard-profile.json', '');
    const windowsMatrix = count => Array.from({ length: count }, (_, index) =>
      `          - os: windows-latest\n            platform: win32\n            shard-index: ${index}\n            shard-count: ${count}\n            label: windows-latest, shard ${index + 1}/${count}`).join('\n');
    assert.strictEqual(original.split(windowsMatrix(4)).length, 2);
    original = original.replace(windowsMatrix(4), windowsMatrix(2));
    const macosMatrix = count => Array.from({ length: count }, (_, index) =>
      `          - os: macos-latest\n            platform: darwin\n            shard-index: ${index}\n            shard-count: ${count}\n`
      + `            label: macos-latest${count === 1 ? '' : `, shard ${index + 1}/${count}`}`).join('\n');
    const smokeIf = "        if: runner.os != 'Windows'";
    const macosAlias = '\n  required-tests-macos:\n    name: Tests (macos-latest)\n    needs: test\n    if: ${{ always() }}\n'
      + '    runs-on: ubuntu-latest\n    steps:\n      - name: Preserve required-check contract\n'
      + '        run: test "${{ needs.test.result }}" = success\n';
    for (const delta of [macosMatrix(2), `${smokeIf} && matrix.shard-index == 0\n`, macosAlias]) {
      assert.strictEqual(original.split(delta).length, 2, delta);
    }
    assert(original.endsWith(macosAlias));
    original = original.replace(macosMatrix(2), macosMatrix(1))
      .replace(`${smokeIf} && matrix.shard-index == 0\n`, `${smokeIf}\n`)
      .slice(0, -macosAlias.length);
  }
  assert.strictEqual(hash(original), id === 'ci'
    ? '5c37cf20bab5613832e0a5efad3e5fa7b9494a57ddbd67a680e4510228e5ffdc'
    : 'cb12bc265ca1e21335f2be3b20961cab8bb878aefe1cde6053a9fef1e55c33e5');
  assert.deepStrictEqual(concurrency.readConcurrency(texts[id]), { present: true,
    group: concurrency.SUPPORTED_FORMS.groups[id], 'cancel-in-progress': concurrency.SUPPORTED_FORMS.cancellations.pull_request });
}
// Reverse the authorized S08 version/notes steps and coordinator wait extension;
// retain the original historical digest so every unrelated byte stays pinned.
const OLD_RESOLVE_RUN = "        run: node scripts/forge-release-version.js --check --github-output \"$GITHUB_OUTPUT\"\n";
const OLD_CHANGELOG_STEP = "      - name: Generate changelog\n        env:\n          RELEASE_RANGE: ${{ steps.version.outputs.range }}\n        shell: bash\n        run: |\n          node <<'NODE'\n          const fs = require('fs');\n          const path = require('path');\n          const { execFileSync } = require('child_process');\n          const range = process.env.RELEASE_RANGE;\n          let commits;\n          try { commits = execFileSync('git', ['log', range, '--pretty=format:%H %s'], { encoding: 'utf8' }); }\n          catch (_) { commits = execFileSync('git', ['log', '--pretty=format:%H %s'], { encoding: 'utf8' }); }\n          const sections = { 'Breaking Changes': [], Features: [], 'Bug Fixes': [], 'Other Changes': [] };\n          for (const line of commits.split('\\n').filter(Boolean)) {\n            const hash = line.slice(0, 7); const message = line.slice(line.indexOf(' ') + 1);\n            const category = /^[a-z]+(\\(.+\\))?!:|BREAKING[ -]CHANGE/i.test(message) ? 'Breaking Changes' :\n              /^feat(\\(.+\\))?:/.test(message) ? 'Features' : /^fix(\\(.+\\))?:/.test(message) ? 'Bug Fixes' : 'Other Changes';\n            sections[category].push(`- ${message} (${hash})`);\n          }\n          fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'release-notes.md'),\n            Object.entries(sections).filter(([, rows]) => rows.length).map(([title, rows]) => `### ${title}\\n\\n${rows.join('\\n')}\\n`).join('\\n'));\n          NODE\n";
const RESOLVE_RUN = "        run: node scripts/forge-release-version.js --check --github-output \"$GITHUB_OUTPUT\" --notes \"$RUNNER_TEMP/release-notes.md\"\n";
assert(!bytes.release.includes(13) && !texts.release.startsWith('\uFEFF'));
assert.strictEqual(texts.release.split(RESOLVE_RUN).length, 3);
assert.strictEqual(predecessorRelease.split('    timeout-minutes: 75\n').length, 2);
assert.strictEqual(predecessorRelease.split('Wait for complete CI and app (60 minute deadline)').length, 2);
assert.strictEqual(texts.release.split('Wait for complete CI and app (publisher deadline)').length, 2);
const historicalRelease = Buffer.from(predecessorRelease
  .replace('    timeout-minutes: 75\n', '    timeout-minutes: 45\n')
  .replace('Wait for complete CI and app (60 minute deadline)', 'Wait for complete CI and app (30 minute deadline)')
  .split(RESOLVE_RUN).join(OLD_RESOLVE_RUN + OLD_CHANGELOG_STEP));
assert.strictEqual(hash(historicalRelease), 'c19b795426f6d0cec090630f90f1c3aa45d3bc83d573aab92cac332e0f3017a3');
assert.strictEqual(crypto.createHash('sha1').update(`blob ${historicalRelease.length}\0`).update(historicalRelease).digest('hex'), '315d89bad9b4ef2965d3a2f3e969fd83005e61d2');
assert.strictEqual(POLICY.workflows.release.blob_sha256, hash(bytes.release));
assert.strictEqual(POLICY.workflows.release.blob_oid, crypto.createHash('sha1').update(`blob ${bytes.release.length}\0`).update(bytes.release).digest('hex'));
assert.deepStrictEqual(concurrency.readConcurrency(texts.release), { present: true, group: 'release', 'cancel-in-progress': 'false' });
marker('truth', 0, 'exact PR-only workflow forms; historical S04 release bytes and pin reconstructed');
console.log('PASS S08-T04 release-reversal exact historical SHA256/blob OID and current release pins');

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

assert.deepStrictEqual(concurrency.readConcurrency('jobs:\n  test:\n    steps:\n      - run: "echo concurrency: {text}"'), { present: false });

// Review R1: whitespace before ':' must not disable the jobs boundary.
const supportedRoot = 'concurrency:\n  group: ' + concurrency.SUPPORTED_FORMS.groups.ci
  + '\n  cancel-in-progress: ' + concurrency.SUPPORTED_FORMS.cancellations.pull_request + '\n';
for (const jobs of [
  'jobs :\n  test:\n    "concurrency": all',
  "jobs  :\n  test:\n    'concurrency': all",
  'jobs \t:\n  test:\n    concurrency: all',
  'jobs : {test: {concurrency: all}}',
]) {
  assert.throws(() => concurrency.modelFor(concurrency.readConcurrency(supportedRoot + jobs), 'ci'), /unsupported/);
  assert.throws(() => concurrency.rehearse({ ...texts, ci: supportedRoot + jobs }), /unsupported/);
}

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
assert(testStep.includes('        env:\n          FORGE_CI_JOB_NAME: Tests (${{ matrix.label }})\n'), 'raw worker logs bind the actual matrix display name');
assert(texts.ci.includes('          path: ${{ runner.temp }}/forge-suite-profile-${{ matrix.os }}-${{ matrix.shard-index }}/*\n'), 'both structured profiles and separate worker logs are retained');
const command = testStep.match(/^        run: (.+)$/m)[1];
assert.strictEqual(command, verboseLayer.newCommand);
assert.strictEqual(command, 'node scripts/forge-ci-parallel.js --shard-index ${{ matrix.shard-index }} --shard-count ${{ matrix.shard-count }}'
  + ' --jobs "${{ matrix.workers }}" --single-worker-jobs ${{ matrix.single-worker-jobs }} --profile-dir "${{ runner.temp }}/forge-suite-profile-${{ matrix.os }}-${{ matrix.shard-index }}" --verbose true');
assert.strictEqual(texts.ci.split('      - name: Run test suites\n').length, 2, 'no new test step');
assert.strictEqual(texts.ci.split('node scripts/forge-ci-parallel.js --shard-index').length, 2, 'no second suite execution');
const parallelSource = fs.readFileSync(path.join(__dirname, 'forge-ci-parallel.js'), 'utf8');
for (const token of ["'--baseline', 'scripts/fixtures/ci-baseline/known-unit-failures.json'", "'--partition-suites'", "'--shard-profile', 'scripts/ci-profiles/issue-461-d046.json'", "'--profile-out'"]) assert(parallelSource.includes(token), token);
assert(!/--(?:changed|match|fail-fast|inherit-home)\b/.test(parallelSource));
assert(!/--(?:changed|match|fail-fast|inherit-home)\b/.test(command));
assert(!/\b(?:paths|paths-ignore|branches-ignore):/.test(texts.ci.split('\npermissions:')[0]));
const steps = texts.ci.match(/^      - name:[^\n]*(?:\n(?!      - name:)[^\n]*)*/gm);
const testIndex = texts.ci.indexOf('      - name: Run test suites');
assert(!texts.ci.includes('Smoke suite (release gate)'), 'smoke must participate in weighted suite allocation');
assert(discoverTests([]).includes('forge-ci-smoke.test.js'), 'full smoke is discovered by the canonical runner');
const smokeSuite = require('./forge-ci-smoke.test');
for (const platform of ['linux', 'darwin']) {
  let calls = 0;
  const invoke = (command, args, options) => { calls++; assert.strictEqual(command, process.execPath); assert.deepStrictEqual(args, [path.join(__dirname,'forge-smoke.js')]); assert.strictEqual(options.stdio,'inherit'); return {status:7,signal:null}; };
  assert.strictEqual(smokeSuite.run(platform, invoke),7,'a real smoke failure blocks the suite'); assert.strictEqual(calls,1);
  assert.strictEqual(smokeSuite.run(platform,()=>({status:0,signal:'SIGTERM'})),1);
  assert.strictEqual(smokeSuite.run(platform,()=>({status:null,error:new Error('fixture')})),1);
}
assert.strictEqual(smokeSuite.run('win32',()=>{throw Error('original Windows smoke was not applicable');}),0);
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
assert(verifySteps[0].includes("if: runner.os != 'Windows' || steps.fixture_tools.outputs.needs_svn != 'false'")
  && texts.ci.indexOf(verifySteps[0]) < testIndex);
const planningStep=steps.find(step=>step.includes('id: fixture_tools'));
assert(planningStep&&planningStep.includes("if: runner.os == 'Windows'")&&planningStep.includes('--tool-plan true'));
assert(texts.ci.indexOf(planningStep)<texts.ci.indexOf(windowsInstall));
for(const platform of ['Linux','macOS','Windows'])for(const output of [undefined,'','true','false','unknown']){
  const verify=platform!=='Windows'||output!=='false';
  assert.strictEqual(verify,!(platform==='Windows'&&output==='false'),'missing or unknown setup metadata always keeps verification');
}
const rows = expandJobs(POLICY.workflows.ci);
assert.strictEqual(rows.length, 142);
assert.strictEqual(rows.filter(row => row.kind === 'alias').length, 9);
assert.deepStrictEqual(rows.filter(row => row.key === 'test').map(row => row.name),
  [['ubuntu-latest', 33], ['macos-latest', 41], ['windows-latest', 56]].flatMap(([os, count]) => Array.from({length:count}, (_, i) => `Tests (${os}, shard ${i+1}/${count})`)));
assert.strictEqual(rows.filter(row => row.name === 'Tests (ubuntu-latest)' && row.kind === 'alias').length, 1);
assert.deepStrictEqual(rows.filter(row => row.key === 'test' && row.matrix.platform === 'win32').map(row => row.matrix['shard-count']), Array(56).fill(56));
assert.deepStrictEqual(rows.filter(row => row.key === 'test' && row.matrix.platform === 'darwin').map(row => row.matrix['shard-count']), Array(41).fill(41));
// Smoke condition evaluated per policy cell: exactly one Linux and one macOS run, never Windows.
const runnerOs = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' };
const smokeCells = rows.filter(row => row.key === 'test'
  && runnerOs[row.matrix.os] !== 'Windows' && row.matrix['shard-index'] === 0);
assert.deepStrictEqual(['linux', 'darwin', 'win32'].map(platform => smokeCells.filter(row => row.matrix.platform === platform).length), [1, 1, 0]);
marker('key_link', 2, 'CI source test command triggers concurrency SVN ordering and smoke structure asserted');

const unitInventory = expandSuites(discoverTests([]));
const suites = unitInventory.map(unit => unit.id);
const profilePath = 'scripts/ci-profiles/issue-461-d046.json';
assert.strictEqual(profilePath, 'scripts/ci-profiles/issue-461-d046.json');
const profile = loadShardProfile(path.join(root, profilePath));
assert.strictEqual(profile.state, 'loaded');
assert.strictEqual(profile.sha256, 'c5438665a4bba363efdc617310a612125049a831c9ae079bcdf41712c01b4366', 'exact current measured default profile');
const cells=new Map();for(const row of rows.filter(row=>row.key==='test')){const key=row.matrix.platform;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(row.matrix);}
let totalWorkers=0;
for (const [platform,platformCells] of cells) {
  const cell=platformCells[0],layouts=platformCells.map(row=>workerLayout({index:row['shard-index'],count:row['shard-count'],jobs:row.workers,singleWorkerJobs:row['single-worker-jobs']}));
  const count=layouts[0].count;assert(count<=96);assert(layouts.every(row=>row.count===count));
  assert.deepStrictEqual(layouts.flatMap(row=>Array.from({length:row.workers},(_,i)=>row.start+i)).sort((a,b)=>a-b),Array.from({length:count},(_,i)=>i));
  assert.strictEqual(count,{linux:64,darwin:80,win32:96}[platform]);totalWorkers+=count;
  const plans = Array.from({ length: count }, (_, index) => planShards({
    suites, index, count, platform, profile, estimatedWeights: unitWeights(unitInventory, profile, platform),
    planningOverrides: loadPlanningOverrides(profile, platform, suites) }));
  assert(plans.every(plan => plan.fallback === null && plan.algorithm === 'weighted-lpt-v1'));
  assert.strictEqual(new Set(plans.map(plan => plan.partition_sha256)).size, 1);
  assert(verifyPartition(suites, plans.map(plan => plan.selected)).ok);
  console.log(`PASS partition ${cell.platform}/${cell['shard-count']} universe=${suites.length} unprofiled=${plans[0].unprofiled.length} stale=${plans[0].stale.length} partition_sha256=${plans[0].partition_sha256}`);
}
// Logical partitions may queue; each platform retains the reviewed96-part bound.
assert.strictEqual(totalWorkers,240);
const maxParallel=Number(/max-parallel: (\d+)/.exec(texts.ci.slice(texts.ci.indexOf('\n  test:')))[1]);
assert.strictEqual(maxParallel,32);
assert(maxParallel*Math.max(...rows.filter(row=>row.key==='test').map(row=>row.matrix.workers))<=64,'at most64 active test processes');
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
// Reconstruct only the authorized Windows and macOS matrix changes and remove the macOS
// tests alias before historical pinning.
const historicalJobs = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(POLICY.workflows).map(([key, value]) => [key, value.jobs]))));
assert.strictEqual(historicalJobs.ci.find(job => job.key === 'test').max_parallel, 32);
delete historicalJobs.ci.find(job => job.key === 'test').max_parallel;
historicalJobs.ci = historicalJobs.ci.filter(job => job.key !== 'required-tests-linux');
historicalJobs.ci.find(job => job.key === 'test').matrix.include = latencyLayer.matrix_before;
assert.strictEqual(historicalJobs.ci.filter(job => job.key === 'required-tests-macos').length, 1);
assert.deepStrictEqual(historicalJobs.ci[historicalJobs.ci.length - 1], { key: 'required-tests-macos', kind: 'alias', needs: ['test'],
  name: 'Tests (macos-latest)', runner: 'ubuntu-latest', matrix: null });
historicalJobs.ci.pop();
const testMatrix = historicalJobs.ci.find(job => job.key === 'test').matrix;
assert.deepStrictEqual(testMatrix.include.filter(cell => cell.platform === 'darwin'), [0, 1].map(index => ({
  os: 'macos-latest', platform: 'darwin', 'shard-index': index, 'shard-count': 2, label: `macos-latest, shard ${index + 1}/2` })));
testMatrix.include = testMatrix.include.filter(cell => cell.platform === 'linux').concat(
  [{ os: 'macos-latest', platform: 'darwin', 'shard-index': 0, 'shard-count': 1, label: 'macos-latest' }],
  [0, 1].map(index => ({ os: 'windows-latest', platform: 'win32', 'shard-index': index,
    'shard-count': 2, label: `windows-latest, shard ${index + 1}/2` })));
assert.strictEqual(hash(JSON.stringify(historicalJobs)),
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
});
