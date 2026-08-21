#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pack = require('./forge-package.js');
const installer = require('./forge-installer.js');
const updater = require('./forge-update.js');

const REPO = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-package-test Ω-'));
let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else fs.copyFileSync(from, to);
  }
}

try {
  test('one deterministic manifest covers core and both adapters on every platform', () => {
    const manifests = ['win32', 'darwin', 'linux'].map((platform) => pack.build({ repo: REPO, platform }).manifest);
    assert.deepStrictEqual(manifests[0], manifests[1]);
    assert.deepStrictEqual(manifests[1], manifests[2]);
    const manifest = manifests[0];
    assert.strictEqual(manifest.product_version, installer.VERSION);
    assert.strictEqual(manifest.schema_version, '1.0.0');
    assert.strictEqual(manifest.product_version, installer.VERSION);
    assert(/^[a-f0-9]{64}$/.test(manifest.package_sha256));
    for (const component of pack.COMPONENTS) {
      assert(manifest.components[component].files > 0, `${component} is not empty`);
      assert(/^[a-f0-9]{64}$/.test(manifest.components[component].sha256));
    }
    assert(manifest.files.some((entry) => entry.component === 'adapter-claude' && entry.path === 'project/CLAUDE.md'));
    assert(manifest.files.some((entry) => entry.component === 'adapter-codex' && entry.path === 'project/AGENTS.md'));
  });

  test('materialized package verifies and detects byte drift', () => {
    const output = path.join(root, 'release package Ω');
    const created = pack.create(output, { repo: REPO });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(pack.verify(output).ok, true);
    const victim = path.join(output, 'payload', 'core', 'VERSION');
    fs.appendFileSync(victim, 'tampered');
    const drift = pack.verify(output);
    assert.strictEqual(drift.ok, false);
    assert(drift.errors.includes('checksum:core/VERSION'));
  });

  test('Claude 3.1.4 upgrade preserves prefs, project .gsd, hook and templates byte-for-byte', () => {
    const fixture = path.join(__dirname, 'fixtures', 'installer', 'claude-3.1.4');
    const caseRoot = path.join(root, 'legacy upgrade');
    const forgeHome = path.join(caseRoot, 'forge');
    const claudeHome = path.join(caseRoot, 'claude');
    const codexHome = path.join(caseRoot, 'codex-must-stay-absent');
    const projectRoot = path.join(caseRoot, 'project');
    copyTree(fixture, claudeHome);
    fs.mkdirSync(path.join(projectRoot, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.gsd', 'STATE.md'), 'state\r\nΩ\r\n');
    const watched = [
      path.join(claudeHome, 'forge-agent-prefs.jsonc'),
      path.join(claudeHome, 'forge-agent-prefs.md'),
      path.join(claudeHome, 'hooks', 'user-hook.js'),
      path.join(claudeHome, 'templates', 'dispatch', 'execute-task.md'),
      path.join(projectRoot, '.gsd', 'STATE.md'),
    ];
    const before = new Map(watched.map((file) => [file, fs.readFileSync(file)]));
    const report = updater.update({ repo: REPO, runtime: 'claude', apply: true, skipCapabilityCheck: true, userHome: caseRoot, forgeHome, claudeHome, codexHome, projectRoot });
    assert.strictEqual(report.runtime, 'claude');
    assert.strictEqual(report.legacy_migration.release, '3.1.4-compatible');
    for (const [file, bytes] of before) assert.deepStrictEqual(fs.readFileSync(file), bytes, file);
    assert.deepStrictEqual(fs.readFileSync(path.join(forgeHome, 'forge-agent-prefs.jsonc')), before.get(path.join(claudeHome, 'forge-agent-prefs.jsonc')));
    assert.strictEqual(fs.existsSync(codexHome), false);
    const second = updater.update({ repo: REPO, runtime: 'claude', apply: true, skipCapabilityCheck: true, userHome: caseRoot, forgeHome, claudeHome, codexHome, projectRoot });
    assert(second.backup && fs.existsSync(second.backup), 'installed update must back up managed bytes');
  });

  test('selective Codex update does not read, create, or mutate Claude home', () => {
    const caseRoot = path.join(root, 'codex selective');
    const forgeHome = path.join(caseRoot, 'forge');
    const claudeHome = path.join(caseRoot, 'claude operator home');
    const codexHome = path.join(caseRoot, 'codex');
    const projectRoot = path.join(caseRoot, 'project');
    fs.mkdirSync(claudeHome, { recursive: true });
    const sentinel = path.join(claudeHome, 'operator-sentinel.txt');
    fs.writeFileSync(sentinel, 'do not touch\r\nΩ\r\n');
    const bytes = fs.readFileSync(sentinel);
    installer.install({ repo: REPO, runtime: 'codex', skipCapabilityCheck: true, userHome: caseRoot, forgeHome, claudeHome, codexHome, projectRoot });
    updater.update({ repo: REPO, runtime: 'codex', apply: true, skipCapabilityCheck: true, userHome: caseRoot, forgeHome, claudeHome, codexHome, projectRoot });
    assert.deepStrictEqual(fs.readFileSync(sentinel), bytes);
    const manifest = JSON.parse(fs.readFileSync(path.join(forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters), ['codex']);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }

process.stdout.write(`\n${passed} passed, 0 failed\n`);
