#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const gate = require('./forge-offline-ci.js');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const FAKE = path.join(__dirname, 'fixtures', 'offline-ci', 'fake-runtime-cli.js');

assert.deepStrictEqual(gate.MATRIX.hosts, ['claude', 'codex']);
assert.deepStrictEqual(gate.MATRIX.platforms, ['win32', 'darwin', 'linux']);
assert.deepStrictEqual(gate.MATRIX.suites, [
  'forge-operational-parity.test.js', 'forge-dispatch-policy.test.js', 'forge-dispatch-security.test.js',
  'forge-headless.test.js', 'forge-mcp.test.js', 'forge-installer.test.js', 'forge-update.test.js',
  'forge-update-remote.test.js', 'forge-package.test.js',
  'forge-operations-doc.test.js',
  'forge-release-gate.test.js',
]);

for (const host of gate.MATRIX.hosts) for (const platform of gate.MATRIX.platforms) {
  const plan = gate.buildPlan({ host, platform });
  assert.strictEqual(plan.length, 11);
  assert(plan.every((entry) => entry.executable === process.execPath && Array.isArray(entry.argv) && entry.shell === false && entry.network === false));
}

const combinedPlan = gate.buildPlan({ host: 'both', platform: 'win32' });
assert.strictEqual(combinedPlan.length, 11);
assert(combinedPlan.every((entry) => entry.host === 'both' && entry.platform === 'win32'));
assert.strictEqual(gate.parseArgs(['--host', 'both', '--platform', 'win32']).host, 'both');

const clean = gate.scrubEnvironment({ PATH: 'safe', ANTHROPIC_API_KEY: 'paid', OPENAI_API_KEY: 'paid', GH_TOKEN: 'paid', CUSTOM_SECRET: 'paid', AWS_ACCESS_KEY_ID: 'paid' });
assert.strictEqual(clean.PATH, 'safe');
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'CUSTOM_SECRET', 'AWS_ACCESS_KEY_ID']) assert.strictEqual(clean[key], undefined);
assert.strictEqual(clean.FORGE_CI_OFFLINE, '1');

for (const args of [['--version'], ['--help'], ['--host', 'claude'], ['--host', 'codex']]) {
  const child = spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', shell: false, timeout: 3000 });
  assert.strictEqual(child.status, 0, child.stderr);
  assert(child.stdout.trim());
}

const workflow = fs.readFileSync(WORKFLOW, 'utf8');
assert.match(workflow, /operational-offline:/);
const triggerBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
assert.match(triggerBlock, /pull_request:\s*\r?\n/);
assert.match(triggerBlock, /push:\s*\r?\n\s+branches:\s*\r?\n\s+- master\s*\r?\n/);
assert.strictEqual((triggerBlock.match(/push:/g) || []).length, 1);

const offlineBlock = workflow.slice(workflow.indexOf('  operational-offline:'), workflow.indexOf('\n  test:'));
const offlineCells = [...offlineBlock.matchAll(/- host: (claude|codex|both)\s+os: ([^\s]+)\s+platform: (linux|darwin|win32)/g)]
  .map((match) => ({ host: match[1], os: match[2], platform: match[3] }));
assert.deepStrictEqual(offlineCells, [
  { host: 'claude', os: 'ubuntu-latest', platform: 'linux' },
  { host: 'codex', os: 'ubuntu-latest', platform: 'linux' },
  { host: 'claude', os: 'macos-latest', platform: 'darwin' },
  { host: 'codex', os: 'macos-latest', platform: 'darwin' },
  { host: 'both', os: 'windows-latest', platform: 'win32' },
]);
assert.match(offlineBlock, /forge-offline-ci\.js --host \$\{\{ matrix\.host \}\}/);

const testBlock = workflow.slice(workflow.indexOf('\n  test:'));
const testCells = [...testBlock.matchAll(/- os: ([^\s]+)\s+platform: (linux|darwin|win32)\s+shard-index: (\d+)\s+shard-count: (\d+)\s+label: ([^\r\n]+)/g)]
  .map((match) => ({ os: match[1], platform: match[2], shardIndex: Number(match[3]), shardCount: Number(match[4]), label: match[5] }));
assert.deepStrictEqual(testCells, [
  { os: 'ubuntu-latest', platform: 'linux', shardIndex: 0, shardCount: 1, label: 'ubuntu-latest' },
  { os: 'macos-latest', platform: 'darwin', shardIndex: 0, shardCount: 1, label: 'macos-latest' },
  { os: 'windows-latest', platform: 'win32', shardIndex: 0, shardCount: 2, label: 'windows-latest, shard 1/2' },
  { os: 'windows-latest', platform: 'win32', shardIndex: 1, shardCount: 2, label: 'windows-latest, shard 2/2' },
]);
assert.match(testBlock, /run-tests\.js[^\r\n]+--shard-index \$\{\{ matrix\.shard-index \}\} --shard-count \$\{\{ matrix\.shard-count \}\}/);
// This assertion replaces `assert.match(workflow, /shell:\s*pwsh/)`, which is exactly the
// kind of guard that proves the wrong property: it matched the TEXT of a workflow GitHub
// refused to schedule, so it stayed green across two runs on PR #71 that died at the
// workflow-file level before a single job started. `shell: ${{ ... }}` at step level was
// the invalid construct; the runner defaults already give bash on Linux/macOS and pwsh on
// Windows, so naming the shell bought nothing and cost the whole gate. Guard the defect
// that actually happened, not the string that was present while it happened.
assert(!/shell:\s*\$\{\{/.test(workflow),
  'step-level `shell:` with an expression makes GitHub reject the workflow file outright');
assert.match(workflow, /node scripts\/forge-offline-ci\.js/);
assert(!/(?:claude|codex)\s+(?:exec|--version|--help)/.test(workflow), 'CI must never invoke paid provider CLIs');

let stdout = ''; let stderr = '';
const exit = gate.main(['--host', 'both', '--platform', 'win32', '--plan'], (value) => { stdout += value; }, (value) => { stderr += value; });
assert.strictEqual(exit, 0, stderr);
const described = JSON.parse(stdout);
assert.strictEqual(described.shell, false);
assert.strictEqual(described.network, false);
assert.strictEqual(described.host, 'both');
assert.deepStrictEqual(described.suites, gate.MATRIX.suites);

process.stdout.write('forge-offline-ci tests passed (combined Windows host; sharded CI invariants)\n');
