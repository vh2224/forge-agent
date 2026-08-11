#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./forge-installer.js');
const capabilities = require('./forge-capabilities.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installer space-Ω-'));
  const forgeHome = path.join(root, 'Forge Home');
  const claudeHome = path.join(root, 'Claude Home');
  const codexHome = path.join(root, 'Codex Home');
  const projectRoot = path.join(root, 'Project Root');
  const options = { repo: path.resolve(__dirname, '..'), forgeHome, claudeHome, codexHome, projectRoot, userHome: root, skipCapabilityCheck: true };
  return { root, forgeHome, claudeHome, codexHome, projectRoot, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function files(root) { return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort() : []; }

test('rejects an unknown runtime before writing', () => {
  const data = fixture();
  try { assert.throws(() => installer.install({ ...data.options, runtime: 'agy' }), /runtime inválido/); assert.strictEqual(fs.existsSync(data.forgeHome), false); } finally { data.cleanup(); }
});

test('dry-run plans Claude-only without touching Forge, Claude, or Codex homes', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude', dryRun: true });
    assert.strictEqual(report.dry_run, true);
    assert(report.plan.some((entry) => entry.destination === path.join(data.forgeHome, 'scripts')) || report.plan.some((entry) => entry.destination.includes(`${path.sep}scripts`)));
    assert.strictEqual(fs.existsSync(data.forgeHome), false);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
  } finally { data.cleanup(); }
});

test('shared references and cross-platform launchers are installed by the Node core', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'shared', 'forge-review.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'shared', 'forge-dispatch.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'schemas', 'challenge.schema.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.root, '.local', 'bin', 'forge-status.cmd')), true);
    assert(report.plan.some((entry) => entry.destination && entry.destination.endsWith(path.join('shared', 'forge-state.md'))));
  } finally { data.cleanup(); }
});

test('--with-app is planned on macOS, executed through bash, and skipped elsewhere', () => {
  const plan = [];
  const calls = [];
  const repo = path.resolve(__dirname, '..');
  const dry = installer.installApp(repo, plan, { withApp: true, dryRun: true }, 'darwin');
  assert.strictEqual(dry.status, 'planned');
  assert(plan.some((entry) => entry.op === 'app-build'));
  const built = installer.installApp(repo, [], {
    withApp: true,
    spawnSync: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
  }, 'darwin');
  assert.strictEqual(built.status, 'installed');
  assert.deepStrictEqual(calls[0].args.slice(-1), ['--install']);
  assert.strictEqual(calls[0].options.shell, false);
  assert.strictEqual(installer.installApp(repo, [], { withApp: true }, 'linux').reason, 'macos-only');
  assert.strictEqual(installer.installApp(repo, [], { withApp: true }, 'win32').reason, 'macos-only');
});

test('Claude-only writes shared core once and only Claude projection', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(installer.VERSION, '4.8.0');
    assert.strictEqual(fs.readFileSync(path.join(data.forgeHome, 'VERSION'), 'utf8'), '4.8.0\n');
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'scripts', 'forge-home.js')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'forge-capabilities.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'manifest.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(path.join(data.projectRoot, 'CLAUDE.md')), true);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters), ['claude']);
  } finally { data.cleanup(); }
});

test('Codex-only does not read or write Claude home and both keeps one core', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(path.join(data.projectRoot, 'AGENTS.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    const both = installer.install({ ...data.options, runtime: 'both', update: true });
    assert.strictEqual(both.ok, true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    assert.strictEqual(files(data.forgeHome).filter((name) => name === 'scripts').length, 1);
  } finally { data.cleanup(); }
});

test('update backs up managed files and preserves prefs and unmanaged files', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const prefs = path.join(data.forgeHome, 'forge-agent-prefs.jsonc');
    const unmanaged = path.join(data.forgeHome, 'operator-note.txt');
    const managedAgent = path.join(data.claudeHome, 'agents', 'forge-executor.md');
    fs.writeFileSync(prefs, '{"operator":true}\n');
    fs.writeFileSync(unmanaged, 'keep\n');
    fs.writeFileSync(managedAgent, 'old managed agent\n');
    const report = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert(report.backup && fs.existsSync(report.backup));
    assert.strictEqual(fs.readFileSync(prefs, 'utf8'), '{"operator":true}\n');
    assert.strictEqual(fs.readFileSync(unmanaged, 'utf8'), 'keep\n');
    assert(fs.readdirSync(path.join(data.forgeHome, 'backups')).length >= 1);
    assert.strictEqual(fs.readFileSync(path.join(report.backup, 'adapters', 'claude', 'agents', 'forge-executor.md'), 'utf8'), 'old managed agent\n');
  } finally { data.cleanup(); }
});

test('legacy Claude preference migrates without removing source', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const legacy = path.join(data.claudeHome, 'forge-agent-prefs.jsonc');
    fs.writeFileSync(legacy, '{"legacy":true}\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{"legacy":true}\n');
    assert.strictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc'), 'utf8'), '{"legacy":true}\n');
  } finally { data.cleanup(); }
});

test('legacy Claude projections are reported first and migrated only with explicit opt-in', () => {
  const data = fixture();
  try {
    fs.mkdirSync(path.join(data.claudeHome, 'agents'), { recursive: true });
    const legacyAgent = path.join(data.claudeHome, 'agents', 'forge-executor.md');
    fs.writeFileSync(legacyAgent, '---\nname: forge-executor\nlegacy: true\n---\n');
    const preserved = installer.install({ ...data.options, runtime: 'claude', update: true });
    const preservedManifest = preserved.manifest.adapters.claude;
    assert(preserved.backup && fs.existsSync(preserved.backup));
    assert(preservedManifest.conflicts.some((item) => item.destination === legacyAgent));
    assert.match(fs.readFileSync(legacyAgent, 'utf8'), /legacy: true/);
    const migrated = installer.install({ ...data.options, runtime: 'claude', update: true, migrateLegacy: true });
    assert.strictEqual(migrated.manifest.adapters.claude.conflicts.length, 0);
    assert.match(fs.readFileSync(legacyAgent, 'utf8'), /^<!-- forge-source:agents/m);
    assert(migrated.backup && fs.existsSync(migrated.backup));
  } finally { data.cleanup(); }
});

test('switching from Claude-only to both fills the missing Codex projection', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), false);
    const report = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(report.already_installed, undefined);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters).sort(), ['claude', 'codex']);
  } finally { data.cleanup(); }
});

test('user-owned project projection is reported as a conflict and never marked complete', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.projectRoot, { recursive: true });
    fs.writeFileSync(path.join(data.projectRoot, 'AGENTS.md'), '# operator-owned\n');
    const first = installer.install({ ...data.options, runtime: 'codex' });
    assert(first.manifest.adapters.codex.conflicts.length > 0);
    const second = installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(second.already_installed, undefined);
    assert.match(fs.readFileSync(path.join(data.projectRoot, 'AGENTS.md'), 'utf8'), /operator-owned/);
  } finally { data.cleanup(); }
});

test('sentinels prove the non-selected home remains byte-identical', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.codexHome, { recursive: true });
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const codexSentinel = path.join(data.codexHome, 'operator-sentinel.txt');
    const claudeSentinel = path.join(data.claudeHome, 'operator-sentinel.txt');
    fs.writeFileSync(codexSentinel, 'codex untouched\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(codexSentinel, 'utf8'), 'codex untouched\r\n');
    fs.writeFileSync(claudeSentinel, 'claude untouched\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(claudeSentinel, 'utf8'), 'claude untouched\r\n');
  } finally { data.cleanup(); }
});

test('repeating a selected install is byte-idempotent', () => {
  const data = fixture();
  try {
    const first = installer.install({ ...data.options, runtime: 'both' });
    const snapshot = {};
    for (const file of [path.join(data.forgeHome, 'VERSION'), path.join(data.forgeHome, 'manifest.json'), path.join(data.claudeHome, 'agents', 'forge-executor.md'), path.join(data.codexHome, 'agents', 'forge-executor.toml')]) snapshot[file] = fs.readFileSync(file);
    const second = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(second.already_installed, true);
    for (const [file, bytes] of Object.entries(snapshot)) assert.deepStrictEqual(fs.readFileSync(file), bytes);
    assert.strictEqual(first.runtime, second.runtime);
  } finally { data.cleanup(); }
});

test('update dry-run keeps a deterministic non-colliding backup plan', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const left = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    const right = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    assert.strictEqual(JSON.stringify(left.plan), JSON.stringify(right.plan));
    assert.match(left.backup || '', /dry-run/);
  } finally { data.cleanup(); }
});

test('update retires legacy Claude scripts only on apply and leaves a tombstone', () => {
  const data = fixture();
  try {
    const legacy = path.join(data.root, '.claude', 'scripts');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old.js'), 'legacy\n');
    const dry = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    assert(dry.plan.some((entry) => entry.op === 'retire' && entry.source === legacy));
    assert.strictEqual(fs.existsSync(path.join(legacy, 'old.js')), true);
    const applied = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert.strictEqual(fs.existsSync(path.join(legacy, 'README.md')), true);
    assert(applied.plan.some((entry) => entry.op === 'retire'));
    const second = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert(second.plan.some((entry) => entry.op === 'skip' && entry.reason === 'already-retired'));
  } finally { data.cleanup(); }
});

test('Claude 3.1.4 fixture preserves JSONC, Markdown, hooks and project .gsd on update', () => {
  const data = fixture();
  try {
    fs.mkdirSync(path.join(data.claudeHome, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(data.claudeHome, 'legacy', '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(data.claudeHome, 'forge-agent-prefs.jsonc'), '{\r\n  "legacy": true, // preserved\r\n}\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md'), '# Legacy prefs\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js'), 'module.exports = true;\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md'), 'project state\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    const before = {
      prefs: fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')),
      md: fs.readFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md')),
      hook: fs.readFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js')),
      state: fs.readFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md')),
    };
    installer.install({ ...data.options, runtime: 'claude', update: true });
    assert.deepStrictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')), before.prefs);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md')), before.md);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js')), before.hook);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md')), before.state);
  } finally { data.cleanup(); }
});

test('capability diagnostics remain selected-host local and offline', () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installer-cli-Ω-'));
  const fake = path.join(fakeRoot, 'fake.js');
  fs.writeFileSync(fake, "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n'); else if (process.argv.includes('--help')) process.stdout.write('ok\\n');");
  try {
    const report = capabilities.detect(path.resolve(__dirname, '..'), { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [fake] }, claude: path.join(fakeRoot, 'absent') } });
    assert.strictEqual(report.probes.codex.status, 'available');
    assert.strictEqual(report.probes.claude.reason_code, 'not-selected');
  } finally { fs.rmSync(fakeRoot, { recursive: true, force: true }); }
});

test('selected runtime capability failure is fail-closed before writes', () => {
  const data = fixture();
  try {
    assert.throws(() => installer.install({ ...data.options, skipCapabilityCheck: false, runtime: 'codex', binaries: { codex: path.join(data.root, 'missing-codex') } }), /capability obrigatória/);
    assert.strictEqual(fs.existsSync(data.forgeHome), false);
  } finally { data.cleanup(); }
});

test('--no-model-probe bypasses the local capability gate explicitly', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, skipCapabilityCheck: false, runtime: 'claude', noModelProbe: true, binaries: { claude: path.join(data.root, 'missing-claude') } });
    assert.strictEqual(report.capabilities, null);
    assert.strictEqual(report.ok, true);
  } finally { data.cleanup(); }
});

test('Claude 3.1.4 fixture is versioned with prefs, Markdown, hooks, templates and .gsd', () => {
  const fixtureRoot = path.join(__dirname, 'fixtures', 'installer', 'claude-3.1.4');
  for (const relative of ['forge-agent-prefs.jsonc', 'forge-agent-prefs.md', 'hooks/user-hook.js', 'templates/dispatch/execute-task.md', '.gsd/STATE.md']) {
    assert.strictEqual(fs.existsSync(path.join(fixtureRoot, relative)), true, `missing fixture ${relative}`);
  }
  assert.match(fs.readFileSync(path.join(fixtureRoot, 'forge-agent-prefs.jsonc'), 'utf8'), /fixture_version/);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);

