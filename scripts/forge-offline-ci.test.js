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
assert.strictEqual((workflow.match(/host:\s*(?:claude|codex)/g) || []).length, 6);
assert.strictEqual((workflow.match(/platform:\s*win32/g) || []).length, 2);
assert.strictEqual((workflow.match(/platform:\s*darwin/g) || []).length, 2);
assert.strictEqual((workflow.match(/platform:\s*linux/g) || []).length, 2);
assert.match(workflow, /windows-latest/);
assert.match(workflow, /platform:\s*win32/);
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
const exit = gate.main(['--host', 'codex', '--platform', 'win32', '--plan'], (value) => { stdout += value; }, (value) => { stderr += value; });
assert.strictEqual(exit, 0, stderr);
const described = JSON.parse(stdout);
assert.strictEqual(described.shell, false);
assert.strictEqual(described.network, false);
assert.deepStrictEqual(described.suites, gate.MATRIX.suites);

process.stdout.write('forge-offline-ci tests passed (2 hosts × 3 platforms; Node/argv only)\n');
