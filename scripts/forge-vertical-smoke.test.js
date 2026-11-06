#!/usr/bin/env node
'use strict';

// Offline vertical smoke.  The host and platform axes are data inputs; no
// paid CLI, shell, Bash, WSL or POSIX utility is needed to exercise them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const compare = require('./forge-semantic-compare');

const ADAPTER = path.join(__dirname, 'forge-vertical-adapter.js');
const MILESTONE = 'M001';
const PLATFORMS = ['win32', 'darwin', 'linux'];
const HOSTS = ['claude', 'codex'];
const INVENTORY = {
  roadmap_exists: true, context_exists: true, research_exists: true,
  active_slice: 'S01', slices: [{ id: 'S01', checked: false, plan_exists: true,
    research_exists: true, summary_exists: false, tasks: [{ id: 'T01', checked: false }] }],
};

function workspace(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge vertical ${label} Ω `));
}

function worker(host, operation, payload, platform) {
  const result = spawnSync(process.execPath, [ADAPTER, '--host', host, '--operation', operation,
    '--json', JSON.stringify(payload)], { encoding: 'utf8', env: { ...process.env, FORGE_TEST_PLATFORM: platform } });
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.strictEqual(result.status, 0, result.stderr || `worker failed: ${host}/${operation}`);
  return JSON.parse(result.stdout);
}

function runPair(platform, from, to) {
  const cwd = workspace(`${platform}-${from}-${to}`);
  const base = { cwd, milestone: MILESTONE, project: 'offline-smoke' };
  const initialized = worker(from, 'init', base, platform);
  assert.strictEqual(initialized.result.outcome, 'completed');
  const statusFrom = worker(from, 'status', base, platform);
  const statusTo = worker(to, 'status', base, platform);
  assert(compare.compare(statusFrom.result, statusTo.result).equal, `${platform} status diverged`);

  const idempotencyKey = `smoke-${platform}`;
  const paused = worker(from, 'next', { ...base, inventory: INVENTORY, needs_input: true,
    idempotency_key: idempotencyKey }, platform);
  assert.strictEqual(paused.result.outcome, 'needs_input', JSON.stringify({ outcome: paused.result.outcome, reason_code: paused.result.reason_code, layer: paused.result.diagnostic?.layer ?? null, stage: paused.result.diagnostic?.stage ?? null }));
  assert(paused.result.boundary && paused.result.boundary.unit, 'needs_input boundary missing');

  const ready = worker(to, 'handoff', { ...base, boundary: paused.result.boundary,
    previous_host_runtime: from }, platform);
  assert.strictEqual(ready.result.outcome, 'completed');
  assert.strictEqual(ready.result.reason_code, 'handoff-ready');

  const resumed = worker(to, 'next', { ...base, boundary: paused.result.boundary,
    response: { choice: 'continue' }, idempotency_key: idempotencyKey }, platform);
  assert.strictEqual(resumed.result.outcome, 'completed');
  assert.strictEqual(resumed.result.reason_code, 'handoff-ready');

  const invalid = spawnSync(process.execPath, [ADAPTER, '--host', to, '--operation', 'next',
    '--json', JSON.stringify({ ...base, response: { value: 'bad' } })], { encoding: 'utf8', env: process.env });
  assert.strictEqual(invalid.status, 0, 'invalid response must be a normalized blocked result');
  const invalidResult = JSON.parse(invalid.stdout);
  assert.strictEqual(invalidResult.result.outcome, 'blocked');
  assert.strictEqual(invalidResult.result.reason_code, 'needs-input-boundary');

  fs.rmSync(cwd, { recursive: true, force: true });
  return { platform, from, to, status: statusFrom.result, resumed: resumed.result };
}

function main() {
  const observations = [];
  for (const platform of PLATFORMS) {
    observations.push(runPair(platform, 'claude', 'codex'));
    observations.push(runPair(platform, 'codex', 'claude'));
  }
  for (const item of observations) {
    const mirror = observations.find((candidate) => candidate.platform === item.platform &&
      candidate.from !== item.from);
    assert(mirror, 'missing reverse-host observation');
    // Boundary checksums/refs include the local transaction identity.  The
    // comparator remains strict about them; smoke compares the logical result
    // projection that is consumed by the opposite adapter.
    const semantic = compare.compare({ ...item.resumed, boundary: null }, { ...mirror.resumed, boundary: null });
    assert(semantic.equal,
      `${item.platform} ${item.from}->${item.to} semantic result diverged: ${JSON.stringify(semantic.differences)}`);
  }
  console.log(`forge-vertical-smoke passed (${observations.length} scenarios; ${HOSTS.join('/')}; ${PLATFORMS.join('/')})`);
}

try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
