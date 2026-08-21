#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./forge-doctor.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }

function fakeCli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-cap-Ω-'));
  const file = path.join(root, 'fake cli.js');
  fs.writeFileSync(file, "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n'); else if (process.argv.includes('--help')) process.stdout.write('help\\n');");
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('capability check passes selected Claude with a fake CLI and leaves Codex unselected', () => {
  const fake = fakeCli();
  try {
    const result = doctor.checkCapabilities(path.resolve(__dirname, '..'), {
      runtime: 'claude',
      binaries: { claude: { command: process.execPath, args: [fake.file] }, codex: { command: process.execPath, args: [fake.file] } },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.failures.length, 0);
    assert.strictEqual(result.probes.codex.reason_code, 'not-selected');
  } finally { fake.cleanup(); }
});

test('capability check fails required missing host without attempting optional fallback', () => {
  const fake = fakeCli();
  try {
    const result = doctor.checkCapabilities(path.resolve(__dirname, '..'), {
      runtime: 'codex',
      binaries: { codex: path.join(fake.root, 'not-found'), claude: { command: process.execPath, args: [fake.file] } },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.failures.map((entry) => entry.id), ['codex']);
    assert.strictEqual(result.failures[0].reason_code, 'missing');
    assert.strictEqual(result.probes.claude.reason_code, 'not-selected');
  } finally { fake.cleanup(); }
});

test('capability check result and reason ordering are deterministic', () => {
  const fake = fakeCli();
  try {
    const options = { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [fake.file] } } };
    const left = JSON.stringify(doctor.checkCapabilities(path.resolve(__dirname, '..'), options));
    const right = JSON.stringify(doctor.checkCapabilities(path.resolve(__dirname, '..'), options));
    assert.strictEqual(left, right);
  } finally { fake.cleanup(); }
});

test('help advertises the capabilities check and selected runtime', () => {
  const out = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--help'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0);
  assert.match(out.stdout, /capabilities/);
  assert.match(out.stdout, /--runtime/);
});

test('help advertises explicit claim recovery and restore surfaces', () => {
  const out = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--help'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0);
  assert.match(out.stdout, /--recover-claim/);
  assert.match(out.stdout, /--confirm-owner-stopped/);
  assert.match(out.stdout, /--confirm-workspace-quiescent/);
  assert.match(out.stdout, /--restore-claim/);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
