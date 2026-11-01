#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const panel = require('./forge-vscode-install.js');
const vsix = require('./forge-vscode-package.js');
const installer = require('./forge-installer.js');
const updater = require('./forge-update.js');
const remote = require('./forge-update-remote.js');

const REPO = path.resolve(__dirname, '..');
const VERSION = installer.VERSION;
const ID = 'forge-agent.forge-vscode';
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-install Ω-'));
// The fake code.cmd lives under an ASCII path: cmd.exe batch files are read in
// the OEM code page, so only the staging paths carry Unicode.
const asciiTemp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge vscode ascii-'));
const BUILT = vsix.buildVsix({ repo: REPO, version: VERSION });
let passed = 0;
let skipped = 0;
async function test(name, fn) { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function skip(name, reason) { skipped++; process.stdout.write(`  - SKIP ${name}: ${reason}\n`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
let counter = 0;
function dir(label) { const value = path.join(temp, `${label} ${++counter}`); fs.mkdirSync(value, { recursive: true }); return value; }

// The real layout of the stable product on this host, with a placeholder CLI.
function stableLayout(base, platform = process.platform) {
  if (platform === 'darwin') {
    const bin = path.join(base, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { bin, cli: path.join(bin, 'code') };
  }
  const product = path.join(base, 'VS Code');
  const bin = path.join(product, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'code.cmd'), '@echo off\r\nexit /b 0\r\n');
    fs.writeFileSync(path.join(product, 'Code.exe'), 'placeholder');
    return { bin, cli: path.join(bin, 'code.cmd'), product };
  }
  fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(product, 'code'), 'placeholder', { mode: 0o755 });
  return { bin, cli: path.join(bin, 'code'), product };
}
function withPath(env, entries) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) if (key.toUpperCase() === 'PATH') delete copy[key];
  copy.PATH = entries.join(path.delimiter);
  return copy;
}
function argsOfCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(command))) parts.push(match[1] !== undefined ? match[1] : match[2]);
  return parts.slice(1);
}

// One simulated stable CLI answering both the POSIX spawn and the Windows Job
// runner. `respond` can override any answer to inject a failure.
function simulator(options = {}) {
  const base = dir('sim');
  const layout = stableLayout(base);
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), '{\n  "editor.fontSize": 14\n}\n');
  fs.writeFileSync(path.join(profile, 'extensions.json'), '[{"identifier":{"id":"ms-python.python"}}]\n');
  const state = {
    cliVersion: options.cliVersion || '1.144.0',
    installed: new Map(Object.entries(options.installed || { 'ms-python.python': '2024.1.0', 'esbenp.prettier-vscode': '10.4.0' })),
    calls: [], options: [], respond: options.respond || null,
  };
  function handle(args) {
    state.calls.push(args.slice());
    const custom = state.respond && state.respond(args, state);
    if (custom) return custom;
    if (args[0] === '--version') return { status: 0, stdout: `${state.cliVersion}\n0123456789abcdef\nx64\n`, stderr: 'ruído stderr' };
    if (args[0] === '--list-extensions') {
      return { status: 0, stdout: `ruído antes\n${[...state.installed].map(([id, version]) => `${id}@${version}`).join('\n')}\nruído depois\n`, stderr: '' };
    }
    if (args[0] === '--install-extension') {
      const entries = vsix.extractEntries(fs.readFileSync(args[1]));
      const pkg = JSON.parse(entries.find(entry => entry.name === 'extension/package.json').bytes.toString('utf8'));
      state.installed.set(`${pkg.publisher}.${pkg.name}`, pkg.version);
      return { status: 0, stdout: 'Extension installed\n', stderr: '' };
    }
    return { status: 9, stdout: '', stderr: 'unexpected' };
  }
  const env = withPath({ ...process.env, VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock', VSCODE_EXTENSIONS: '/elsewhere' }, [layout.bin]);
  delete env.VSCODE_PORTABLE;
  return {
    state, layout, profile, env, staging: dir('staging Ω'),
    spawnSync(file, args, spawnOptions) { state.options.push({ file, args, spawnOptions }); return handle(args); },
    windowsRunner(command, runOptions) {
      state.options.push({ command, runOptions });
      return { ...handle(argsOfCommand(command)), signal: null, cleanup: { platform: 'win32', status: 'joined', active_processes: 0, autorun_disabled: runOptions.disableAutoRun === true } };
    },
    profileDigest() { return ['settings.json', 'extensions.json'].map(name => sha256(fs.readFileSync(path.join(profile, name)))).join(':'); },
  };
}
function homes(label) {
  const base = dir(label);
  const result = { userHome: base, forgeHome: path.join(base, 'forge home Ω'), claudeHome: path.join(base, 'claude Ω'),
    codexHome: path.join(base, 'codex Ω'), projectRoot: path.join(base, 'project Ω') };
  fs.mkdirSync(result.projectRoot, { recursive: true });
  return result;
}
function install(home, sim, extra = {}) {
  return installer.install({ repo: REPO, runtime: 'claude', skipCapabilityCheck: true, noModelProbe: true, ...home, env: sim.env,
    vscodeSpawnSync: sim.spawnSync, vscodeWindowsRunner: sim.windowsRunner, vscodeStagingRoot: sim.staging, ...extra });
}
function update(home, sim, extra = {}) {
  return updater.update({ repo: REPO, runtime: 'claude', skipCapabilityCheck: true, noModelProbe: true, ...home, ...extra }, {
    install: options => installer.install({ ...options, env: sim.env, vscodeSpawnSync: sim.spawnSync, vscodeWindowsRunner: sim.windowsRunner, vscodeStagingRoot: sim.staging }),
  });
}
function apply(home, sim, extra = {}) {
  return panel.applyPanel({ repo: REPO, forgeHome: home.forgeHome, version: VERSION, plan: [], env: sim.env, platform: process.platform,
    spawnSync: sim.spawnSync, windowsRunner: sim.windowsRunner, stagingRoot: sim.staging, ...extra });
}
function readFileOrNull(file) { try { return fs.readFileSync(file); } catch (_) { return null; } }
function writeState(home, value) {
  fs.mkdirSync(home.forgeHome, { recursive: true });
  fs.writeFileSync(panel.statePath(home.forgeHome), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
function stateValue(optedIn, installed = null) {
  return { schema_version: 1, vscode_panel: { opted_in: optedIn, target: panel.TARGET, since_version: VERSION, installed } };
}
function assertReportShape(report) {
  assert.deepStrictEqual(Object.keys(report).sort(), [...panel.REPORT_KEYS].sort());
  assert(panel.STATUSES.includes(report.status));
  assert.strictEqual(report.verified, report.status === 'installed' || report.status === 'unchanged');
  assert.strictEqual(report.target, 'vscode-stable-default-profile');
  assert.strictEqual(report.extension, ID);
}
function forbiddenFlags(calls) {
  return calls.flat().filter(arg => /^--(?:profile|user-data-dir|extensions-dir)\b/.test(arg));
}
function coreDigest(home) {
  const files = installer.walk(path.join(home.forgeHome, 'scripts')).map(file => path.relative(home.forgeHome, file)).sort();
  return sha256(files.map(file => `${file}:${sha256(fs.readFileSync(path.join(home.forgeHome, file)))}`).join('\n'));
}
function nativePowerShell() {
  for (const command of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 30000 });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

(async () => {
  const PANEL_HELP = 'Usage: forge-update.js [...] [--with-vscode-panel|--without-vscode-panel]\n       forge-update.js --source local --repo DIR\n';
  const MODERN_HELP = 'Usage: forge-update.js [...]\n       forge-update.js --source local --repo DIR\n';
  const LEGACY_HELP = 'Usage: forge-update.js [--runtime claude|codex|both] [--apply|--dry-run] [--repo DIR] [--json]\n';
  const SOURCE = { path: path.join(temp, 'remote source'), remote: remote.DEFAULT_REMOTE, channel: 'stable', ref: 'refs/tags/v5.0.0', tag: 'v5.0.0',
    sha: 'a'.repeat(40), declared_version: '5.0.0', version_matches_ref: true };

  // ── MH-05 flags ─────────────────────────────────────────────────────────
  await test('both entry points parse the opt-in/opt-out flags and refuse the pair before any write', () => {
    assert.strictEqual(installer.parseArgs(['--with-vscode-panel']).vscodePanel, 'opt-in');
    assert.strictEqual(installer.parseArgs(['--without-vscode-panel']).vscodePanel, 'opt-out');
    assert.strictEqual(installer.parseArgs([]).vscodePanel, undefined);
    assert.strictEqual(updater.parseArgs(['--with-vscode-panel']).vscodePanel, 'opt-in');
    assert.strictEqual(updater.parseArgs(['--without-vscode-panel']).vscodePanel, 'opt-out');
    for (const parse of [installer.parseArgs, updater.parseArgs]) {
      assert.throws(() => parse(['--with-vscode-panel', '--without-vscode-panel']), /opções conflitantes: --with-vscode-panel e --without-vscode-panel/);
    }
    const home = homes('conflict');
    const errors = [];
    assert.strictEqual(installer.run(['--with-vscode-panel', '--without-vscode-panel', '--forge-home', home.forgeHome], () => {}, text => errors.push(text)), 2);
    assert.strictEqual(updater.run(['--source', 'local', '--repo', REPO, '--apply', '--forge-home', home.forgeHome, '--without-vscode-panel', '--with-vscode-panel'], () => {}, text => errors.push(text)), 1);
    assert(errors.every(text => /opções conflitantes/.test(text)) && errors.length === 2);
    assert.strictEqual(fs.existsSync(home.forgeHome), false);
    const usage = [];
    installer.run(['--help'], text => usage.push(text));
    updater.run(['--help'], text => usage.push(text));
    for (const text of usage) assert.match(text, /\[--with-vscode-panel\|--without-vscode-panel\]/);
    assert.match(usage[1], /--source local/);
    assert.throws(() => installer.install({ repo: REPO, ...home, vscodePanel: 'all-profiles' }), /vscodePanel inválido/);
    assert.strictEqual(fs.existsSync(home.forgeHome), false);
  });

  // ── MH-05 control and MH-12 baseline ─────────────────────────────────────
  const control = homes('control');
  const controlSim = simulator({ respond: () => { throw new Error('the VS Code CLI must not be called without opt-in'); } });
  let controlReport;
  await test('without flag or state: not-requested, zero CLI calls, no components.json and no panel plan entry', () => {
    controlReport = install(control, controlSim);
    assert.strictEqual(controlReport.ok, true);
    assertReportShape(controlReport.vscode_panel);
    assert.strictEqual(controlReport.vscode_panel.status, 'not-requested');
    assert.strictEqual(controlReport.vscode_panel.verified, false);
    assert.strictEqual(controlSim.state.calls.length, 0);
    assert.strictEqual(fs.existsSync(panel.statePath(control.forgeHome)), false);
    assert(!controlReport.plan.some(entry => entry.op === 'vscode-panel-install' || String(entry.destination).endsWith(panel.STATE_FILE)));
    assert.match(installer.render(controlReport), /Painel VS Code: not-requested \(use --with-vscode-panel para aderir\)/);
    const updated = update(control, controlSim, { apply: true });
    assert.deepStrictEqual(updated.components.core, { status: 'applied', changed: updated.installer.changed });
    assert.strictEqual(updated.components.vscode_panel.status, 'not-requested');
    assert.strictEqual(controlSim.state.calls.length, 0);
    assert.strictEqual(fs.existsSync(panel.statePath(control.forgeHome)), false);
    assert.match(updater.render(updated), /Painel VS Code: not-requested/);
  });

  // ── MH-06 state ─────────────────────────────────────────────────────────
  await test('state file: closed schema, bounded read, invalid states never touch the panel', () => {
    const home = homes('state');
    const sim = simulator();
    assert.deepStrictEqual(panel.readState(home.forgeHome), { ok: true, state: null, reason: null });
    writeState(home, stateValue(true, { version: '1.2.3', vsix_sha256: 'b'.repeat(64) }));
    assert.strictEqual(panel.readState(home.forgeHome).ok, true);
    const invalid = [
      ['{not json', 'malformed'],
      [{ ...stateValue(true), extra: 1 }, 'malformed'],
      [{ ...stateValue(true), vscode_panel: { ...stateValue(true).vscode_panel, target: 'all-profiles' } }, 'malformed'],
      [{ ...stateValue(true), vscode_panel: { ...stateValue(true).vscode_panel, opted_in: 'yes' } }, 'malformed'],
      [{ ...stateValue(true), vscode_panel: { ...stateValue(true).vscode_panel, home: home.userHome } }, 'malformed'],
      [{ ...stateValue(true), schema_version: 2 }, 'malformed'],
      [stateValue(true, { version: '1.2.3', vsix_sha256: 'short' }), 'malformed'],
      [`${JSON.stringify(stateValue(true))}${' '.repeat(panel.STATE_LIMIT)}`, 'unreadable'],
    ];
    for (const [value, reason] of invalid) {
      writeState(home, value);
      const bytes = fs.readFileSync(panel.statePath(home.forgeHome));
      assert.strictEqual(panel.readState(home.forgeHome).reason, reason);
      const report = apply(home, sim);
      assertReportShape(report);
      assert.deepStrictEqual([report.status, report.reason, report.opted_in], ['state-invalid', reason, null]);
      assert.deepStrictEqual(fs.readFileSync(panel.statePath(home.forgeHome)), bytes);
    }
    fs.rmSync(panel.statePath(home.forgeHome));
    fs.mkdirSync(panel.statePath(home.forgeHome));
    assert.strictEqual(panel.readState(home.forgeHome).reason, 'unreadable');
    fs.rmSync(panel.statePath(home.forgeHome), { recursive: true });
    const target = path.join(home.userHome, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(stateValue(true)));
    let linked = true;
    try { fs.symlinkSync(target, panel.statePath(home.forgeHome), 'file'); } catch (error) { linked = false; skip('state link refusal', `symlink not permitted (${error.code})`); }
    if (linked) {
      assert.strictEqual(panel.readState(home.forgeHome).reason, 'link');
      assert.strictEqual(apply(home, sim).status, 'state-invalid');
      // An explicit flag replaces the link entry itself, never its target.
      const replaced = apply(home, sim, { request: 'opt-in' });
      assert.strictEqual(replaced.status, 'installed');
      assert.strictEqual(fs.lstatSync(panel.statePath(home.forgeHome)).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(target, 'utf8'), JSON.stringify(stateValue(true)));
    }
    assert.strictEqual(sim.state.calls.filter(args => args[0] === '--install-extension').length, linked ? 1 : 0);
  });

  await test('explicit opt-in replaces an invalid state; the written state holds no path, user, host or time', () => {
    const home = homes('replace');
    const sim = simulator();
    writeState(home, '{broken');
    const report = apply(home, sim, { request: 'opt-in' });
    assert.strictEqual(report.status, 'installed');
    const text = fs.readFileSync(panel.statePath(home.forgeHome), 'utf8');
    const value = JSON.parse(text);
    assert.deepStrictEqual(value, stateValue(true, { version: VERSION, vsix_sha256: BUILT.sha256 }));
    for (const needle of [home.userHome, temp, os.homedir(), os.hostname(), os.userInfo().username, REPO]) {
      assert.strictEqual(text.includes(needle), false, `state contains ${needle}`);
    }
    assert(!/\d{4}-\d{2}-\d{2}T/.test(text));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(panel.statePath(home.forgeHome)).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(home.forgeHome).filter(name => name.includes('.tmp-')), []);
  });

  await test('--without-vscode-panel records opted_in false, never uninstalls and names the manual removal', () => {
    const home = homes('opt out');
    const sim = simulator({ installed: { 'forge-agent.forge-vscode': VERSION } });
    writeState(home, stateValue(true, { version: VERSION, vsix_sha256: BUILT.sha256 }));
    const report = apply(home, sim, { request: 'opt-out' });
    assertReportShape(report);
    assert.deepStrictEqual([report.status, report.reason, report.opted_in, report.verified], ['opted-out', 'flag', false, false]);
    assert.match(report.detail, /code --uninstall-extension forge-agent\.forge-vscode/);
    assert.strictEqual(sim.state.calls.length, 0);
    assert.strictEqual(sim.state.installed.get(ID), VERSION);
    assert.strictEqual(panel.readState(home.forgeHome).state.vscode_panel.opted_in, false);
    const later = apply(home, sim);
    assert.deepStrictEqual([later.status, later.reason], ['opted-out', 'state']);
    assert.match(panel.renderPanelLines(later).join('\n'), /opted-out — atualizações do painel desativadas; remoção manual: code --uninstall-extension forge-agent\.forge-vscode/);
    assert.strictEqual(sim.state.calls.length, 0);
  });

  // ── MH-07 dry-run ───────────────────────────────────────────────────────
  await test('dry-run plans with the in-memory VSIX identity and writes nothing', () => {
    const fresh = homes('dry fresh');
    const sim = simulator();
    const report = install(fresh, sim, { dryRun: true, vscodePanel: 'opt-in' });
    assertReportShape(report.vscode_panel);
    assert.deepStrictEqual([report.vscode_panel.status, report.vscode_panel.version, report.vscode_panel.vsix_sha256, report.vscode_panel.dry_run],
      ['planned', VERSION, BUILT.sha256, true]);
    assert.strictEqual(sim.state.calls.length, 0);
    assert.strictEqual(fs.existsSync(fresh.forgeHome), false, 'dry-run created the Forge home');
    assert.deepStrictEqual(fs.readdirSync(sim.staging), []);
    assert.match(installer.render(report), new RegExp(`Painel VS Code: planned — instalaria ${ID.replace('.', '\\.')}@${VERSION.replace(/\./g, '\\.')} \\(sha256 ${BUILT.sha256.slice(0, 12)}\\); nada executado`));
    const existing = homes('dry existing');
    install(existing, simulator());
    writeState(existing, stateValue(true, { version: '0.0.1', vsix_sha256: 'c'.repeat(64) }));
    const before = fs.readFileSync(panel.statePath(existing.forgeHome));
    for (const extra of [{}, { vscodePanel: 'opt-in' }, { vscodePanel: 'opt-out' }]) {
      const preview = update(existing, sim, extra);
      assert.strictEqual(preview.applied, false);
      assert.strictEqual(preview.components.core.status, 'planned');
      assert.strictEqual(preview.components.vscode_panel.status, extra.vscodePanel === 'opt-out' ? 'opted-out' : 'planned');
      assert.deepStrictEqual(fs.readFileSync(panel.statePath(existing.forgeHome)), before);
      assert.strictEqual(fs.existsSync(path.join(existing.forgeHome, 'backups')), false, 'dry-run created a backup');
    }
    assert.strictEqual(sim.state.calls.length, 0);
    assert.deepStrictEqual(fs.readdirSync(sim.staging), []);
  });

  // ── MH-08 detection ─────────────────────────────────────────────────────
  await test('classifyCli accepts only the stable layout per platform and diagnoses every variant', () => {
    const files = new Set(['C:\\Programs\\Microsoft VS Code\\Code.exe', 'C:\\Programs\\cursor\\Cursor.exe', 'C:\\Programs\\VSCodium\\VSCodium.exe',
      'C:\\Programs\\Windsurf\\Windsurf.exe', 'C:\\Portable VS Code\\Code.exe', '/usr/share/code/code', '/opt/portable/code',
      '/snap/code/170/usr/share/code/code', '/usr/share/codium/codium']);
    const dirs = new Set(['C:\\Portable VS Code\\data', '/opt/portable/data', '/Users/u/Portable/code-portable-data']);
    const classify = (platform, file, env = {}) => {
      const result = panel.classifyCli(file, { platform, env, isFile: item => files.has(item), isDirectory: item => dirs.has(item) });
      return result.ok ? result.layout : `${result.status}:${result.reason}`;
    };
    const table = [
      ['win32', 'C:\\Programs\\Microsoft VS Code\\bin\\code.cmd', 'win32-stable'],
      ['win32', 'C:\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd', 'incompatible:variant-not-stable'],
      ['win32', 'C:\\Programs\\cursor\\resources\\app\\bin\\code.cmd', 'incompatible:variant-not-stable'],
      ['win32', 'C:\\Programs\\VSCodium\\bin\\code.cmd', 'incompatible:variant-not-stable'],
      ['win32', 'C:\\Programs\\Windsurf\\bin\\code.cmd', 'incompatible:variant-not-stable'],
      ['win32', 'C:\\Users\\u\\.vscode-server\\bin\\abc\\bin\\remote-cli\\code.cmd', 'incompatible:remote-cli'],
      ['win32', '\\\\wsl$\\Ubuntu\\usr\\share\\code\\bin\\code', 'incompatible:remote-cli'],
      ['win32', 'C:\\Portable VS Code\\bin\\code.cmd', 'incompatible:portable-mode'],
      ['darwin', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'darwin-stable'],
      ['darwin', '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code', 'incompatible:variant-not-stable'],
      ['darwin', '/Applications/Cursor.app/Contents/Resources/app/bin/code', 'incompatible:variant-not-stable'],
      ['darwin', '/Applications/VSCodium.app/Contents/Resources/app/bin/codium', 'incompatible:variant-not-stable'],
      ['darwin', '/Users/u/Portable/Visual Studio Code.app/Contents/Resources/app/bin/code', 'incompatible:portable-mode'],
      ['linux', '/usr/share/code/bin/code', 'linux-stable'],
      ['linux', '/usr/share/code-insiders/bin/code-insiders', 'incompatible:variant-not-stable'],
      ['linux', '/usr/share/codium/bin/codium', 'incompatible:variant-not-stable'],
      ['linux', '/home/u/.vscode-server/bin/abc/bin/remote-cli/code', 'incompatible:remote-cli'],
      ['linux', '/mnt/c/Users/u/AppData/Local/Programs/Microsoft VS Code/bin/code', 'incompatible:remote-cli'],
      ['linux', '/snap/code/170/usr/share/code/bin/code', 'incompatible:variant-not-stable'],
      ['linux', '/usr/bin/snap', 'incompatible:variant-not-stable'],
      ['linux', '/opt/portable/bin/code', 'incompatible:portable-mode'],
    ];
    for (const [platform, file, expected] of table) assert.strictEqual(classify(platform, file), expected, `${platform} ${file}`);
    assert.strictEqual(classify('win32', 'C:\\Programs\\Microsoft VS Code\\bin\\code.cmd', { VSCODE_PORTABLE: 'D:\\data' }), 'incompatible:portable-mode');
    assert.strictEqual(classify('linux', '/usr/share/code/bin/code', { VSCODE_PORTABLE: '/data' }), 'incompatible:portable-mode');
    assert.strictEqual(classify('linux', '/usr/share/code/bin/code', { VSCODE_PORTABLE: ' ' }), 'linux-stable');
  });

  await test('missing, unparsable, below-minimum, variant and portable CLIs never reach --install-extension', () => {
    const home = homes('detect');
    const missing = simulator();
    missing.env = withPath(missing.env, [dir('empty bin')]);
    const absent = apply(home, missing, { request: 'opt-in' });
    assert.deepStrictEqual([absent.status, absent.reason, absent.verified], ['cli-missing', 'not-on-path', false]);
    assert.strictEqual(missing.state.calls.length, 0);
    const garbled = simulator({ respond: args => (args[0] === '--version' ? { status: 0, stdout: 'Cursor 0.42.3\n', stderr: '' } : null) });
    const unparsable = apply(home, garbled);
    assert.deepStrictEqual([unparsable.status, unparsable.reason], ['incompatible', 'version-unparsable']);
    assert.deepStrictEqual(garbled.state.calls, [['--version']]);
    const old = simulator({ cliVersion: '1.89.9' });
    const minimum = apply(home, old);
    assert.deepStrictEqual([minimum.status, minimum.reason, minimum.cli_version], ['incompatible', 'engine-minimum', '1.89.9']);
    assert.deepStrictEqual(old.state.calls, [['--version']]);
    const portable = simulator();
    portable.env = { ...portable.env, VSCODE_PORTABLE: path.join(temp, 'portable data') };
    assert.deepStrictEqual([apply(home, portable).status, apply(home, portable).reason], ['incompatible', 'portable-mode']);
    const portableDir = simulator();
    const app = path.resolve(portableDir.layout.bin, '..', '..', '..', '..');
    fs.mkdirSync(process.platform === 'darwin' ? path.join(path.dirname(app), 'code-portable-data') : path.join(portableDir.layout.product, 'data'), { recursive: true });
    assert.deepStrictEqual([apply(home, portableDir).status, apply(home, portableDir).reason], ['incompatible', 'portable-mode']);
    const insiders = simulator();
    const variant = dir('insiders');
    const insidersBin = path.join(variant, 'Code Insiders', 'bin');
    fs.mkdirSync(insidersBin, { recursive: true });
    const insidersCli = path.join(insidersBin, process.platform === 'win32' ? 'code.cmd' : 'code');
    fs.writeFileSync(insidersCli, 'placeholder', { mode: 0o755 });
    insiders.env = withPath(insiders.env, [insidersBin]);
    assert.deepStrictEqual([apply(home, insiders).status, apply(home, insiders).reason], ['incompatible', 'variant-not-stable']);
    for (const sim of [portable, portableDir, insiders]) assert.strictEqual(sim.state.calls.length, 0, 'portable/variant layouts are refused before any CLI call');
  });

  // ── MH-09 invocation ────────────────────────────────────────────────────
  await test('only three frozen argument forms; hostile values are refused without spawning', () => {
    const sim = simulator();
    const cli = sim.layout.cli;
    for (const args of [['--profile', 'x'], ['--install-extension', 'relative.vsix', '--force'], ['--install-extension', path.join(temp, 'a.vsix')],
      ['--list-extensions'], ['--version', '--user-data-dir', temp], ['--extensions-dir', temp]]) {
      assert.strictEqual(panel.runCli(cli, args, { spawnSync: sim.spawnSync, windowsRunner: sim.windowsRunner, env: sim.env }).reason, 'unsafe-argument');
    }
    for (const bad of ['&', '%', '"', '!', '^', '|', '<', '>', '\r', '\n', '\0', '\x01', '\x1f']) {
      for (const platform of ['win32', 'linux']) {
        const root = platform === 'win32' ? 'C:\\VS Code' : '/opt/VS Code';
        const sep = platform === 'win32' ? '\\' : '/';
        assert.strictEqual(panel.runCli(`${root}${bad}${sep}bin${sep}code`, ['--version'], { platform, spawnSync: sim.spawnSync, windowsRunner: sim.windowsRunner }).reason, 'unsafe-argument');
        assert.strictEqual(panel.runCli(`${root}${sep}bin${sep}code`, ['--install-extension', `${root}${sep}st${bad}age${sep}x.vsix`, '--force'],
          { platform, spawnSync: sim.spawnSync, windowsRunner: sim.windowsRunner }).reason, 'unsafe-argument', JSON.stringify(bad));
      }
    }
    assert.strictEqual(sim.state.calls.length, 0);
  });

  await test('win32 uses one verbatim cmd line through the owned Job runner; POSIX spawns argv with shell false', () => {
    const seen = [];
    const env = { Path: 'C:\\x', VSCODE_IPC_HOOK_CLI: '\\\\.\\pipe\\vscode', vscode_extensions: 'D:\\other', VSCODE_PORTABLE: 'D:\\p', KEEP: 'yes' };
    const runner = (command, options) => { seen.push({ command, options }); return { status: 0, stdout: '1.144.0\n', stderr: '', cleanup: { status: 'joined', active_processes: 0, autorun_disabled: options.disableAutoRun === true } }; };
    const cli = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd';
    const file = 'C:\\Users\\Temp Ω\\forge-vscode-panel-abc\\forge-vscode-1.2.3.vsix';
    assert.strictEqual(panel.runCli(cli, ['--install-extension', file, '--force'], { platform: 'win32', windowsRunner: runner, env, timeout: panel.TIMEOUTS.install }).ok, true);
    assert.strictEqual(seen[0].command, `"${cli}" --install-extension "${file}" --force`);
    assert.strictEqual(seen[0].options.cwd, 'C:\\Program Files\\Microsoft VS Code\\bin');
    assert.strictEqual(seen[0].options.timeoutMs, 180000);
    assert.strictEqual(seen[0].options.disableAutoRun, true);
    assert.deepStrictEqual(seen[0].options.env, { Path: 'C:\\x', KEEP: 'yes' });
    assert.strictEqual(env.VSCODE_IPC_HOOK_CLI, '\\\\.\\pipe\\vscode', 'the operator environment is never modified');
    panel.runCli(cli, ['--version'], { platform: 'win32', windowsRunner: runner, env });
    panel.runCli(cli, ['--list-extensions', '--show-versions'], { platform: 'win32', windowsRunner: runner, env, timeout: panel.TIMEOUTS.list });
    assert.deepStrictEqual(seen.slice(1).map(item => [item.command, item.options.timeoutMs]),
      [[`"${cli}" --version`, 30000], [`"${cli}" --list-extensions --show-versions`, 30000]]);
    assert(seen.every(item => item.options.disableAutoRun === true));
    const posix = [];
    const spawn = (command, args, options) => { posix.push({ command, args, options }); return { status: 0, stdout: '', stderr: '' }; };
    panel.runCli('/usr/share/code/bin/code', ['--version'], { platform: 'linux', spawnSync: spawn, env: { PATH: '/bin', VSCODE_IPC_HOOK_CLI: '/s', VSCODE_EXTENSIONS: '/e' } });
    assert.strictEqual(posix[0].command, '/usr/share/code/bin/code');
    assert.deepStrictEqual(posix[0].args, ['--version']);
    const { options } = posix[0];
    assert.deepStrictEqual([options.shell, options.windowsHide, options.stdio, options.maxBuffer, options.timeout], [false, true, 'pipe', 1024 * 1024, 30000]);
    assert.deepStrictEqual(options.env, { PATH: '/bin' });
    const source = fs.readFileSync(path.join(__dirname, 'forge-vscode-install.js'), 'utf8');
    assert.strictEqual(/shell:\s*true/.test(source), false);
    assert.strictEqual(/process\.stdout\.write\(/.test(source.replace(/process\.stdout\.write\.bind\(process\.stdout\)/g, '')), false, 'CLI output never reaches stdout');
  });

  await test('Windows Job cleanup that is not proved stops the sequence as cli-failed cleanup-unverified', () => {
    const home = homes('cleanup');
    const unproved = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'EVERIFYCLEANUP' }), cleanup: { platform: 'win32', status: 'unproved' } };
    for (const failAt of ['--version', '--list-extensions', '--install-extension']) {
      const commands = [];
      const installed = new Map();
      const runner = command => {
        commands.push(command);
        const args = argsOfCommand(command);
        if (args[0] === failAt) return unproved;
        if (args[0] === '--version') return { status: 0, stdout: '1.144.0\n', stderr: '', cleanup: { status: 'joined', active_processes: 0, autorun_disabled: true } };
        if (args[0] === '--list-extensions') return { status: 0, stdout: [...installed].map(([id, v]) => `${id}@${v}`).join('\n'), stderr: '', cleanup: { status: 'joined', active_processes: 0, autorun_disabled: true } };
        installed.set(ID, VERSION);
        return { status: 0, stdout: '', stderr: '', cleanup: { status: 'joined', active_processes: 0, autorun_disabled: true } };
      };
      const report = panel.applyPanel({ repo: REPO, forgeHome: home.forgeHome, version: VERSION, request: 'opt-in', plan: [], platform: 'win32', env: { Path: 'C:\\VS Code\\bin' },
        resolve: () => 'C:\\VS Code\\bin\\code.cmd', realpath: file => file, isFile: file => file === 'C:\\VS Code\\Code.exe', isDirectory: () => false,
        windowsRunner: runner, stagingRoot: dir('cleanup staging') });
      assertReportShape(report);
      assert.deepStrictEqual([report.status, report.reason, report.verified], ['cli-failed', 'cleanup-unverified', false], failAt);
      const order = ['--version', '--list-extensions', '--install-extension'];
      assert.strictEqual(commands.length, order.indexOf(failAt) + 1, `${failAt}: no further CLI step after unproved cleanup`);
    }
  });

  // ── MH-10 verified bytes ────────────────────────────────────────────────
  await test('joined Windows runner without AutoRun proof never advances or verifies the panel', () => {
    const home = homes('autorun proof');
    const commands = [];
    const report = panel.applyPanel({ repo: REPO, forgeHome: home.forgeHome, version: VERSION, request: 'opt-in', plan: [], platform: 'win32', env: { Path: 'C:\\VS Code\\bin' },
      resolve: () => 'C:\\VS Code\\bin\\code.cmd', realpath: file => file, isFile: file => file === 'C:\\VS Code\\Code.exe', isDirectory: () => false,
      windowsRunner(command, options) { commands.push(command); assert.strictEqual(options.disableAutoRun, true); return { status: 0, stdout: '1.144.0\n', stderr: '', cleanup: { status: 'joined', active_processes: 0 } }; },
      stagingRoot: dir('autorun staging') });
    assert.deepStrictEqual([report.status, report.reason, report.verified], ['cli-failed', 'autorun-unverified', false]);
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].includes('--version'), true);
  });

  await test('staged bytes are re-read and verified; a tampered stage never reaches the CLI', () => {
    const home = homes('staged');
    const sim = simulator();
    let staged = null;
    const report = apply(home, sim, { request: 'opt-in', onStaged(file) {
      staged = file;
      assert.strictEqual(path.basename(file), BUILT.file_name);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.throws(() => fs.writeFileSync(file, 'again', { flag: 'wx' }), /EEXIST/);
      fs.appendFileSync(file, 'x');
    } });
    assert.deepStrictEqual([report.status, report.reason, report.verified], ['package-invalid', 'staged-mismatch', false]);
    assert(!sim.state.calls.some(args => args[0] === '--install-extension'));
    assert(staged && !fs.existsSync(path.dirname(staged)), 'staging directory removed');
    assert.deepStrictEqual(fs.readdirSync(sim.staging), []);
    const bad = dir('bad & staging');
    const percent = dir('bad %TEMP% staging');
    for (const root of [bad, percent]) {
      const refusedSim = simulator();
      const refused = apply(home, refusedSim, { request: 'opt-in', stagingRoot: root });
      assert.deepStrictEqual([refused.status, refused.reason], ['cli-failed', 'unsafe-argument']);
      assert.strictEqual(refusedSim.state.calls.length, 0, 'hostile staging root refused before any spawn');
      assert.deepStrictEqual(fs.readdirSync(root), []);
    }
  });

  await test('install outcome requires the exact listed version; every failure is closed and unverified', () => {
    const cases = [
      ['not-listed', args => (args[0] === '--install-extension' ? { status: 0, stdout: '', stderr: '' } : null), 'verify-failed'],
      ['version-mismatch', (args, state) => { if (args[0] === '--install-extension') { state.installed.set(ID, '0.1.0'); return { status: 0, stdout: '', stderr: '' }; } return null; }, 'verify-failed'],
      ['list-failed', (args, state) => (args[0] === '--list-extensions' && state.calls.filter(a => a[0] === '--list-extensions').length === 2 ? { status: 1, stdout: '', stderr: 'boom' } : null), 'verify-failed'],
      ['exit-nonzero', args => (args[0] === '--install-extension' ? { status: 1, stdout: '', stderr: `Falhou\u001b[31m ${'x'.repeat(400)}` } : null), 'cli-failed'],
      ['timeout', args => (args[0] === '--install-extension' ? { status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) } : null), 'cli-failed'],
      ['spawn-error', args => (args[0] === '--install-extension' ? { status: null, error: Object.assign(new Error('e'), { code: 'ENOENT' }) } : null), 'cli-failed'],
      ['output-limit', args => (args[0] === '--install-extension' ? { status: null, error: Object.assign(new Error('b'), { code: 'ENOBUFS' }) } : null), 'cli-failed'],
    ];
    for (const [reason, respond, status] of cases) {
      const home = homes(reason);
      const sim = simulator({ respond: (args, state) => {
        const result = respond(args, state);
        return result && process.platform === 'win32' ? { ...result, cleanup: { status: 'joined', active_processes: 0 } } : result;
      } });
      const report = apply(home, sim, { request: 'opt-in' });
      assertReportShape(report);
      assert.deepStrictEqual([report.status, report.reason, report.verified], [status, reason, false]);
      assert.deepStrictEqual(fs.readdirSync(sim.staging), [], `${reason}: staging removed`);
      assert.strictEqual(panel.readState(home.forgeHome).state.vscode_panel.installed, null, `${reason}: nothing recorded as installed`);
      if (reason === 'exit-nonzero') {
        assert(Array.from(report.detail).length <= 240 && !/\u001b/.test(report.detail));
        assert.match(panel.renderPanelLines(report).join('\n'), /^⚠ Painel VS Code NÃO verificado: cli-failed \(exit-nonzero\) — núcleo aplicado; detalhe: Falhou/);
      }
    }
  });

  // ── MH-11 idempotence ───────────────────────────────────────────────────
  await test('installed, then unchanged with two calls, then reinstalls on version, digest or removal drift', () => {
    const home = homes('idempotent');
    const sim = simulator();
    const profileBefore = sim.profileDigest();
    const others = [...sim.state.installed].filter(([id]) => id !== ID);
    const first = apply(home, sim, { request: 'opt-in' });
    assertReportShape(first);
    assert.deepStrictEqual([first.status, first.verified, first.version, first.vsix_sha256, first.cli_version], ['installed', true, VERSION, BUILT.sha256, '1.144.0']);
    assert.deepStrictEqual(panel.readState(home.forgeHome).state.vscode_panel.installed, { version: VERSION, vsix_sha256: BUILT.sha256 });
    assert.deepStrictEqual(sim.state.calls.map(args => args[0]), ['--version', '--list-extensions', '--install-extension', '--list-extensions']);
    assert.strictEqual(sim.state.calls[2][2], '--force');
    assert.deepStrictEqual(forbiddenFlags(sim.state.calls), []);
    const bytes = fs.readFileSync(panel.statePath(home.forgeHome));
    sim.state.calls.length = 0;
    for (const request of [undefined, 'opt-in']) {
      const again = apply(home, sim, { request });
      assert.deepStrictEqual([again.status, again.verified], ['unchanged', true]);
      assert.deepStrictEqual(sim.state.calls, [['--version'], ['--list-extensions', '--show-versions']]);
      assert.deepStrictEqual(fs.readFileSync(panel.statePath(home.forgeHome)), bytes);
      sim.state.calls.length = 0;
    }
    assert.match(panel.renderPanelLines(apply(home, sim)).join('\n'), new RegExp(`Painel VS Code: unchanged — ${ID.replace('.', '\\.')}@`));
    sim.state.calls.length = 0;
    const bumped = apply(home, sim, { version: '99.0.0' });
    assert.deepStrictEqual([bumped.status, bumped.version], ['installed', '99.0.0']);
    assert(sim.state.calls.some(args => args[0] === '--install-extension' && args[2] === '--force'));
    assert.strictEqual(sim.state.installed.get(ID), '99.0.0');
    apply(home, sim);
    const drift = panel.readState(home.forgeHome).state;
    drift.vscode_panel.installed.vsix_sha256 = 'd'.repeat(64);
    writeState(home, drift);
    sim.state.calls.length = 0;
    assert.strictEqual(apply(home, sim).status, 'installed', 'same version with a different recorded digest reinstalls');
    assert(sim.state.calls.some(args => args[0] === '--install-extension'));
    sim.state.installed.delete(ID);
    sim.state.calls.length = 0;
    assert.strictEqual(apply(home, sim).status, 'installed', 'an opted-in extension missing from the list is reinstalled');
    assert.deepStrictEqual([...sim.state.installed].filter(([id]) => id !== ID), others, 'other extensions untouched');
    assert.strictEqual(sim.profileDigest(), profileBefore, 'settings and extensions.json untouched');
    assert.match(panel.renderPanelLines(first).join('\n'), /no perfil padrão do VS Code estável \(recarregue a janela\)/);
  });

  // ── MH-12 separation ────────────────────────────────────────────────────
  await test('no panel failure throws, changes ok/exit or the core bytes compared with a control run', () => {
    const failures = [
      ['cli-missing', sim => { sim.env = withPath(sim.env, [dir('nothing')]); }, {}],
      ['incompatible', sim => { sim.state.cliVersion = '1.0.0'; }, {}],
      ['cli-failed', sim => { sim.state.respond = args => (args[0] === '--install-extension' ? { status: 2, stdout: '', stderr: 'no', cleanup: { status: 'joined', active_processes: 0 } } : null); }, {}],
      ['verify-failed', sim => { sim.state.respond = args => (args[0] === '--install-extension' ? { status: 0, stdout: '', stderr: '', cleanup: { status: 'joined', active_processes: 0 } } : null); }, {}],
      ['package-invalid', () => {}, { vscodeOnStaged: file => fs.appendFileSync(file, 'x') }],
      ['state-invalid', () => {}, { state: '{broken' }],
    ];
    const controlCore = coreDigest(control);
    const controlVersion = fs.readFileSync(path.join(control.forgeHome, 'VERSION'));
    for (const [status, mutate, extra] of failures) {
      const home = homes(`separation ${status}`);
      const sim = simulator();
      mutate(sim);
      if (extra.state) writeState(home, extra.state);
      let report;
      assert.doesNotThrow(() => { report = install(home, sim, { vscodePanel: extra.state ? undefined : 'opt-in', vscodeOnStaged: extra.vscodeOnStaged }); });
      assert.strictEqual(report.ok, true, status);
      assertReportShape(report.vscode_panel);
      assert.strictEqual(report.vscode_panel.status, status);
      assert.strictEqual(report.vscode_panel.verified, false);
      assert.strictEqual(coreDigest(home), controlCore, `${status}: core bytes`);
      assert.deepStrictEqual(fs.readFileSync(path.join(home.forgeHome, 'VERSION')), controlVersion);
      assert.match(installer.render(report), new RegExp(`⚠ Painel VS Code NÃO verificado: ${status} \\([a-z-]+\\) — núcleo aplicado`));
      // Control: the same paths installed again without the panel.
      const written = { version: fs.readFileSync(path.join(home.forgeHome, 'VERSION')), manifest: fs.readFileSync(path.join(home.forgeHome, 'manifest.json')) };
      fs.rmSync(home.userHome, { recursive: true, force: true });
      fs.mkdirSync(home.projectRoot, { recursive: true });
      const plain = install(home, simulator());
      assert.strictEqual(plain.vscode_panel.status, 'not-requested');
      assert.deepStrictEqual(fs.readFileSync(path.join(home.forgeHome, 'VERSION')), written.version, `${status}: VERSION bytes`);
      assert.deepStrictEqual(fs.readFileSync(path.join(home.forgeHome, 'manifest.json')), written.manifest, `${status}: manifest.json bytes`);
    }
    // run() is the exit-code boundary; its CLI lookup uses this process PATH.
    const exitHome = homes('exit cli-missing');
    const out = [];
    const savedPath = process.env.PATH;
    let exitCode;
    try {
      process.env.PATH = dir('no code here');
      exitCode = installer.run(['--runtime', 'claude', '--no-model-probe', '--with-vscode-panel', '--forge-home', exitHome.forgeHome, '--claude-home', exitHome.claudeHome,
        '--codex-home', exitHome.codexHome, '--project-root', exitHome.projectRoot, '--repo', REPO], text => out.push(text), () => {});
    } finally { process.env.PATH = savedPath; }
    assert.strictEqual(exitCode, 0, 'the core exit code is preserved');
    assert.match(out.join(''), /⚠ Painel VS Code NÃO verificado: cli-missing \(not-on-path\) — núcleo aplicado/);
    assert.deepStrictEqual([...panel.STATUSES].sort(), ['cli-failed', 'cli-missing', 'deferred', 'incompatible', 'installed', 'not-requested', 'opted-out',
      'package-invalid', 'planned', 'source-unsupported', 'state-invalid', 'unchanged', 'verify-failed']);
    let internal;
    // A defect inside the panel step (here a plan without push) is still reported, never thrown.
    assert.doesNotThrow(() => { internal = panel.applyPanel({ repo: REPO, forgeHome: path.join(temp, 'internal'), version: VERSION, request: 'opt-in', plan: {} }); });
    assertReportShape(internal);
    assert.deepStrictEqual([internal.status, internal.reason, internal.verified], ['verify-failed', 'internal-error', false]);
  });

  await test('update() reports components.core and components.vscode_panel separately and renders the warning', () => {
    const home = homes('update report');
    const sim = simulator();
    sim.env = withPath(sim.env, [dir('no cli')]);
    install(home, simulator());
    const report = update(home, sim, { apply: true, vscodePanel: 'opt-in' });
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.components.core, { status: 'applied', changed: true });
    assert.strictEqual(report.components.vscode_panel.status, 'cli-missing');
    assert.match(updater.render(report), /⚠ Painel VS Code NÃO verificado: cli-missing \(not-on-path\) — núcleo aplicado; detalhe: -/);
    assert.strictEqual(report.installer.changed, true, 'the recorded opt-in is a write');
  });

  // ── MH-13 installer contracts ───────────────────────────────────────────
  await test('already_installed shortcut: unchanged without flag, deferred with recorded opt-in, bypassed by an explicit flag', () => {
    const home = homes('shortcut');
    const sim = simulator();
    install(home, sim);
    const plain = install(home, sim);
    assert.strictEqual(plain.already_installed, true);
    assert.strictEqual(plain.vscode_panel.status, 'not-requested');
    writeState(home, stateValue(true));
    const deferred = install(home, sim);
    assert.strictEqual(deferred.already_installed, true);
    assert.deepStrictEqual([deferred.vscode_panel.status, deferred.vscode_panel.reason], ['deferred', 'already-installed']);
    assert.match(installer.render(deferred), /Painel VS Code: deferred \(already-installed\) — use --update ou --with-vscode-panel/);
    assert.strictEqual(sim.state.calls.length, 0);
    const explicit = install(home, sim, { vscodePanel: 'opt-in' });
    assert.strictEqual(explicit.already_installed, undefined);
    assert.strictEqual(explicit.vscode_panel.status, 'installed');
    assert.strictEqual(explicit.changed, true);
    assert(explicit.plan.some(entry => entry.op === 'vscode-panel-install'));
  });

  await test('update backup keeps a byte-identical components.json before any write; dry-run creates none', () => {
    const home = homes('backup');
    const sim = simulator();
    install(home, sim);
    writeState(home, '{"operator": "broken state"}');
    const before = fs.readFileSync(panel.statePath(home.forgeHome));
    const preview = update(home, sim, { vscodePanel: 'opt-in' });
    // The preview names the planned backup but must not create it.
    assert(preview.installer.plan.some(entry => entry.op === 'copy' && entry.destination.endsWith(path.join(panel.STATE_FILE, panel.STATE_FILE))));
    assert.strictEqual(fs.existsSync(path.join(home.forgeHome, 'backups')), false);
    assert.deepStrictEqual(fs.readFileSync(panel.statePath(home.forgeHome)), before);
    const report = update(home, sim, { apply: true, vscodePanel: 'opt-in' });
    assert(report.backup, 'update created a backup');
    const copy = path.join(report.backup, panel.STATE_FILE, panel.STATE_FILE);
    assert.deepStrictEqual(fs.readFileSync(copy), before);
    assert.strictEqual(report.components.vscode_panel.status, 'installed');
    assert.strictEqual(panel.readState(home.forgeHome).ok, true);
    const order = report.installer.plan.map(entry => entry.destination);
    assert(order.indexOf(copy) < order.lastIndexOf(panel.statePath(home.forgeHome)), 'backup precedes the state write');
  });

  await test('optional state backup EACCES preserves state and core success; required core backup still fails', () => {
    const home = homes('optional backup failure'), sim = simulator();
    install(home, sim);
    writeState(home, stateValue(true, { version: '0.1.0', vsix_sha256: 'a'.repeat(64) }));
    const file = panel.statePath(home.forgeHome), originalState = fs.readFileSync(file);
    fs.writeFileSync(path.join(home.forgeHome, 'VERSION'), '0.0.1\n');
    const originalCopy = fs.copyFileSync;
    let refused = 0, report;
    try {
      fs.copyFileSync = function (source, destination, ...args) {
        if (path.resolve(String(source)) === path.resolve(file)) {
          refused++; throw Object.assign(new Error('fixture optional-state backup refused'), { code: 'EACCES' });
        }
        return originalCopy.call(fs, source, destination, ...args);
      };
      report = update(home, sim, { apply: true });
    } finally { fs.copyFileSync = originalCopy; }
    assert.strictEqual(refused, 1);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.applied, true);
    assert.strictEqual(report.components.core.status, 'applied');
    assert.deepStrictEqual([report.components.vscode_panel.status, report.components.vscode_panel.reason, report.components.vscode_panel.verified], ['state-invalid', 'backup-failed', false]);
    assert.strictEqual(report.components.vscode_panel.opted_in, true);
    assert.deepStrictEqual(fs.readFileSync(file), originalState);
    assert.strictEqual(fs.readFileSync(path.join(home.forgeHome, 'VERSION'), 'utf8').trim(), VERSION);
    assert.strictEqual(sim.state.calls.length, 0, 'no panel CLI after optional backup failure');
    assert(!report.installer.plan.some(entry => entry.op === 'copy' && entry.source === file), 'failed optional copy is not reported as applied');
    assertReportShape(report.components.vscode_panel);

    const required = homes('required backup failure'), requiredSim = simulator();
    install(required, requiredSim);
    fs.writeFileSync(path.join(required.forgeHome, 'VERSION'), '0.0.1\n');
    const requiredSource = path.resolve(required.forgeHome, 'scripts', 'forge-update.js');
    try {
      fs.copyFileSync = function (source, destination, ...args) {
        if (path.resolve(String(source)) === requiredSource) throw Object.assign(new Error('fixture required-core backup refused'), { code: 'EACCES' });
        return originalCopy.call(fs, source, destination, ...args);
      };
      assert.throws(() => update(required, requiredSim, { apply: true }), error => error.code === 'EACCES');
    } finally { fs.copyFileSync = originalCopy; }
    assert.strictEqual(fs.readFileSync(path.join(required.forgeHome, 'VERSION'), 'utf8').trim(), '0.0.1');
    assert.strictEqual(requiredSim.state.calls.length, 0);
  });

  // ── MH-14 transport ─────────────────────────────────────────────────────
  await test('remote bootstrap forwards panel flags only to a checkout that lists them, with one --help probe', () => {
    const runner = (calls, help, child) => (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('--help')) return { status: 0, stdout: help, stderr: '' };
      if (args[0].endsWith('forge-installer.js')) return { status: 0, stdout: 'compat ok\n', stderr: '' };
      return { status: 0, stdout: JSON.stringify(child || { ok: true, applied: true }), stderr: '' };
    };
    const home = homes('remote');
    const input = { apply: true, runtime: 'claude', forgeHome: home.forgeHome };
    let calls = [];
    const modern = remote.runBootstrappedUpdate(SOURCE, { ...input, vscodePanel: 'opt-in' }, { runner: runner(calls, MODERN_HELP) });
    assert.strictEqual(calls.length, 2);
    assert(!calls[1].args.includes('--with-vscode-panel'));
    assert.deepStrictEqual([modern.components.vscode_panel.status, modern.components.vscode_panel.reason, modern.components.vscode_panel.verified],
      ['source-unsupported', 'remote-without-panel', false]);
    assertReportShape(modern.components.vscode_panel);
    calls = [];
    const childPanel = { ok: true, applied: true, components: { core: { status: 'applied', changed: true }, vscode_panel: panel.panelReport('installed', null, { requested: 'opt-in', opted_in: true, version: VERSION }) } };
    const supported = remote.runBootstrappedUpdate(SOURCE, { ...input, vscodePanel: 'opt-in' }, { runner: runner(calls, PANEL_HELP, childPanel) });
    assert.strictEqual(calls.length, 2);
    assert(calls[1].args.includes('--with-vscode-panel') && !calls[1].args.includes('--without-vscode-panel'));
    assert.strictEqual(supported.components.vscode_panel.status, 'installed');
    calls = [];
    remote.runBootstrappedUpdate(SOURCE, { ...input, vscodePanel: 'opt-out' }, { runner: runner(calls, PANEL_HELP, childPanel) });
    assert(calls[1].args.includes('--without-vscode-panel') && !calls[1].args.includes('--with-vscode-panel'));
    // A recorded opt-in travels by state, not by flag.
    writeState(home, stateValue(true));
    calls = [];
    const byState = remote.runBootstrappedUpdate(SOURCE, input, { runner: runner(calls, PANEL_HELP, childPanel) });
    assert(!calls[1].args.some(arg => /vscode-panel/.test(arg)));
    assert.strictEqual(byState.components.vscode_panel.status, 'installed');
    calls = [];
    const silent = remote.runBootstrappedUpdate(SOURCE, input, { runner: runner(calls, PANEL_HELP) });
    assert.deepStrictEqual([silent.components.vscode_panel.status, silent.components.vscode_panel.opted_in], ['source-unsupported', true]);
    calls = [];
    const planUpdate = () => ({ ok: true, runtime: 'claude', forge_home: home.forgeHome });
    const compat = remote.runBootstrappedUpdate(SOURCE, { ...input, apply: false, vscodePanel: 'opt-in' }, { runner: runner(calls, LEGACY_HELP), planUpdate });
    assert.strictEqual(calls.length, 2);
    assert(calls[1].args[0].endsWith('forge-installer.js') && !calls[1].args.some(arg => /vscode-panel/.test(arg)));
    assert.deepStrictEqual([compat.components.vscode_panel.status, compat.components.vscode_panel.reason], ['source-unsupported', 'compat-bootstrap']);
    for (const vscodePanel of ['opt-in', 'opt-out']) {
      assert(!remote.compatInstallerArgs(SOURCE, { vscodePanel }, 'claude').some(arg => /vscode-panel/.test(arg)));
      assert(!remote.bootstrapArgs(SOURCE, { vscodePanel }).some(arg => /vscode-panel/.test(arg)));
    }
    fs.rmSync(panel.statePath(home.forgeHome));
    calls = [];
    const none = remote.runBootstrappedUpdate(SOURCE, input, { runner: runner(calls, MODERN_HELP) });
    assert.strictEqual(none.components, undefined, 'no request and no opt-in adds nothing');
    const local = [];
    const argv = ['--source', 'local', '--repo', REPO, '--apply', '--with-vscode-panel'];
    updater.bootstrapLocal({ source: 'local' }, { repo: REPO, argv, runner: (command, args) => { local.push(args); return { status: 0, stdout: '{}' }; } });
    assert.deepStrictEqual(local[0], [path.join(REPO, 'scripts', 'forge-update.js'), ...argv]);
  });

  // ── MH-15 real e2e with a noisy CLI ─────────────────────────────────────
  function noisyCli() {
    const base = path.join(asciiTemp, `noisy cli ${++counter}`);
    const layout = stableLayout(base);
    const record = path.join(base, 'calls.jsonl');
    const state = path.join(base, 'installed.txt');
    fs.writeFileSync(path.join(layout.bin, 'fake-cli.js'), [
      "'use strict';",
      "const fs = require('fs');",
      `const vsix = require(${JSON.stringify(path.join(__dirname, 'forge-vscode-package.js'))});`,
      'const args = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');`,
      "process.stderr.write('ruido stderr node\\n');",
      `const state = ${JSON.stringify(state)};`,
      "if (args[0] === '--version') process.stdout.write('1.144.0\\n0123456789abcdef\\nx64\\n');",
      "else if (args[0] === '--list-extensions') process.stdout.write('ms-python.python@2024.1.0\\n' + (fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : ''));",
      "else if (args[0] === '--install-extension') {",
      "  const entries = vsix.extractEntries(fs.readFileSync(args[1]));",
      "  const pkg = JSON.parse(entries.find(entry => entry.name === 'extension/package.json').bytes.toString('utf8'));",
      "  fs.writeFileSync(state, pkg.publisher + '.' + pkg.name + '@' + pkg.version + '\\n');",
      "  process.stdout.write('Extension installed successfully\\n');",
      '} else process.exit(3);',
      '',
    ].join('\n'));
    if (process.platform === 'win32') {
      fs.writeFileSync(layout.cli, ['@echo off', `"${process.execPath}" "%~dp0fake-cli.js" %*`, 'set FORGE_FAKE_EXIT=%ERRORLEVEL%',
        'echo ruido stdout da CLI falsa', 'echo ruido stderr da CLI falsa 1>&2', 'exit /b %FORGE_FAKE_EXIT%', ''].join('\r\n'));
    } else {
      fs.writeFileSync(layout.cli, ['#!/bin/sh', `"${process.execPath}" "$(dirname "$0")/fake-cli.js" "$@"`, 'status=$?',
        'echo "ruido stdout da CLI falsa"', 'echo "ruido stderr da CLI falsa" >&2', 'exit $status', ''].join('\n'), { mode: 0o755 });
    }
    return { layout, record, state };
  }

  await test('real forge-update --json with a noisy fake stable CLI: exit 0, one clean JSON, installed and verified', () => {
    const cli = noisyCli();
    const home = homes('e2e');
    // Existing Job-runner limitation: TEMP containing U+03A9 (Omega) failed
    // in this fixture; the owner independently measured it as unproved cleanup
    // while ASCII-space and U+00E1 passed (issue323). Keep TEMP ASCII here;
    // Unicode staging is proved below through stagingRoot.
    const staging = process.platform === 'win32' ? path.join(asciiTemp, 'e2e staging space') : dir('e2e staging Ω');
    fs.mkdirSync(staging, { recursive: true });
    const env = withPath({ ...process.env, HOME: home.userHome, USERPROFILE: home.userHome, TEMP: staging, TMP: staging, TMPDIR: staging,
      SHELL: '/bin/sh', FORGE_LOGIN_TIMEOUT: '1' }, [cli.layout.bin, ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)]);
    for (const key of ['FORGE_HOME', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_EXTENSIONS', 'VSCODE_PORTABLE', 'FORGE_UPDATE_REMOTE_PROVENANCE']) delete env[key];
    const args = [path.join(__dirname, 'forge-update.js'), '--source', 'local', '--repo', REPO, '--apply', '--json', '--with-vscode-panel', '--runtime', 'claude',
      '--no-model-probe', '--forge-home', home.forgeHome, '--claude-home', home.claudeHome, '--codex-home', home.codexHome, '--project-root', home.projectRoot];
    const result = spawnSync(process.execPath, args, { cwd: home.projectRoot, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(/ruido/.test(result.stdout), false, 'CLI noise reached stdout');
    const report = JSON.parse(result.stdout);
    assert.deepStrictEqual([report.components.vscode_panel.status, report.components.vscode_panel.verified, report.components.vscode_panel.version],
      ['installed', true, VERSION], JSON.stringify(report.components.vscode_panel));
    assert.strictEqual(report.components.core.status, 'applied');
    const calls = fs.readFileSync(cli.record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(calls.map(call => call[0]), ['--version', '--list-extensions', '--install-extension', '--list-extensions']);
    assert.deepStrictEqual(calls[1], ['--list-extensions', '--show-versions']);
    assert.strictEqual(calls[2].length, 3);
    assert.strictEqual(calls[2][2], '--force');
    assert(calls[2][1].startsWith(fs.realpathSync.native(staging)) || calls[2][1].startsWith(staging), 'staged under the configured temporary root');
    assert(/ /.test(calls[2][1]) && (process.platform === 'win32' || /Ω/.test(calls[2][1])));
    assert.deepStrictEqual(forbiddenFlags(calls), []);
    assert.strictEqual(fs.readFileSync(cli.state, 'utf8'), `${ID}@${VERSION}\n`);
    assert.deepStrictEqual(fs.readdirSync(staging).filter(name => name.startsWith('forge-vscode-panel-')), []);
    assert.deepStrictEqual(panel.readState(home.forgeHome).state.vscode_panel.installed, { version: VERSION, vsix_sha256: BUILT.sha256 });
  });

  await test('real CLI process: Unicode staging installs, a repeat is unchanged, & and % roots are refused before spawning', () => {
    const cli = noisyCli();
    const home = homes('real api');
    const env = withPath(process.env, [cli.layout.bin, ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)]);
    for (const key of ['VSCODE_IPC_HOOK_CLI', 'VSCODE_EXTENSIONS', 'VSCODE_PORTABLE']) delete env[key];
    const stagingRoot = dir('real staging Ω');
    const run = extra => panel.applyPanel({ repo: REPO, forgeHome: home.forgeHome, version: VERSION, plan: [], env, platform: process.platform, stagingRoot, ...extra });
    const first = run({ request: 'opt-in' });
    assert.deepStrictEqual([first.status, first.verified], ['installed', true], JSON.stringify(first));
    const calls = fs.readFileSync(cli.record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(calls[2][1].startsWith(stagingRoot) && /Ω/.test(calls[2][1]) && / /.test(calls[2][1]));
    const second = run({});
    assert.deepStrictEqual([second.status, second.verified], ['unchanged', true]);
    assert.strictEqual(fs.readFileSync(cli.record, 'utf8').trim().split('\n').length, 6, 'unchanged costs exactly --version and --list-extensions');
    assert.deepStrictEqual(fs.readdirSync(stagingRoot), []);
    for (const hostile of [dir('real & staging'), dir('real %PATH% staging')]) {
      const before = fs.readFileSync(cli.record, 'utf8');
      const refused = run({ request: 'opt-in', version: '99.0.0', stagingRoot: hostile });
      assert.deepStrictEqual([refused.status, refused.reason], ['cli-failed', 'unsafe-argument']);
      assert.strictEqual(fs.readFileSync(cli.record, 'utf8'), before, 'no CLI process was started');
    }
  });

  if (process.platform === 'win32') {
    await test('real Windows owned Job: a hung code.cmd times out joined and its descendant stops', () => {
      const base = path.join(asciiTemp, 'hung cli');
      const layout = stableLayout(base);
      const beat = path.join(base, 'heartbeat.txt');
      fs.writeFileSync(path.join(layout.bin, 'hang.cjs'), `const cp=require('child_process'),fs=require('fs');
if(process.argv[2]==='writer'){setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'tick\\n'),20);}
else{cp.spawn(process.execPath,[__filename,'writer'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);}
`);
      fs.writeFileSync(layout.cli, `@echo off\r\n"${process.execPath}" "%~dp0hang.cjs" %*\r\n`);
      const result = panel.runCli(layout.cli, ['--version'], { platform: 'win32', env: process.env, timeout: 1500 });
      assert.strictEqual(result.reason, 'timeout', JSON.stringify(result));
      assert(fs.existsSync(beat), 'the owned descendant actually ran');
      const bytes = fs.readFileSync(beat);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      assert.deepStrictEqual(fs.readFileSync(beat), bytes, 'descendant stopped before the joined return');
    });
  } else skip('real Windows owned Job timeout fixture', `platform ${process.platform}; POSIX uses spawnSync with shell false and claims no Job guarantee`);

  // ── install.ps1 ─────────────────────────────────────────────────────────
  const ps = nativePowerShell();
  if (!ps) skip('install.ps1 -WithVscodePanel dry-run', 'PowerShell unavailable');
  else await test('install.ps1 forwards -WithVscodePanel and refuses -WithVscodePanel with -WithoutVscodePanel', () => {
    const home = homes('powershell');
    const script = path.join(REPO, 'install.ps1');
    const env = { ...process.env, USERPROFILE: home.userHome, HOME: home.userHome };
    delete env.FORGE_HOME;
    const base = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Runtime', 'claude', '-DryRun', '-NoModelProbe',
      '-ForgeHome', home.forgeHome, '-ClaudeHome', home.claudeHome, '-ProjectRoot', home.projectRoot];
    const planned = spawnSync(ps, [...base, '-WithVscodePanel'], { encoding: 'utf8', env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    assert.strictEqual(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(planned.stdout, /Painel VS Code: planned/);
    assert.strictEqual(fs.existsSync(home.forgeHome), false);
    const conflict = spawnSync(ps, [...base, '-WithVscodePanel', '-WithoutVscodePanel'], { encoding: 'utf8', env, timeout: 120000 });
    assert.strictEqual(conflict.status, 2);
    assert.match(conflict.stderr, /opções conflitantes/);
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /\[switch\]\$WithVscodePanel/);
    assert.match(source, /\[switch\]\$WithoutVscodePanel/);
  });
  await test('install.sh keeps forwarding every argument unchanged', () => {
    const shell = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
    assert.match(shell, /FORWARDED\+=\("\$arg"\)/);
    assert.match(shell, /forge-installer\.js" --repo "\$\{REPO_DIR\}" \$\{FORWARDED\[@\]\+"\$\{FORWARDED\[@\]\}"\}/);
    assert.strictEqual(/vscode-panel/i.test(shell), false);
  });

  // ── MH-16 installed core read by the extracted VSIX ─────────────────────
  await test('the extracted VSIX locates the installed core and its real Worker reads another project', async () => {
    const home = homes('mounted');
    install(home, simulator());
    const extensions = dir('vscode extensions Ω');
    const extensionRoot = path.join(extensions, `${ID}-${VERSION}`);
    for (const entry of vsix.extractEntries(BUILT.bytes).filter(item => item.name.startsWith('extension/'))) {
      const file = path.join(extensionRoot, ...entry.name.slice('extension/'.length).split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.bytes);
    }
    const forgeHome = fs.realpathSync.native(home.forgeHome);
    const clean = dir('clean home');
    const project = dir('other project');
    fs.mkdirSync(path.join(project, '.gsd'), { recursive: true });
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, FORGE_HOME: process.env.FORGE_HOME };
    try {
      process.env.HOME = clean; process.env.USERPROFILE = clean; process.env.FORGE_HOME = forgeHome;
      const reader = require(path.join(extensionRoot, 'forge-panel-reader.js'));
      const located = reader.locateCore({ extensionRoot, env: { FORGE_HOME: forgeHome, HOME: clean, USERPROFILE: clean } });
      assert.deepStrictEqual({ ...located }, { status: 'ok', corePath: path.join(forgeHome, 'scripts', 'forge-panel-source.js'), origin: 'installation' });
      assert(!located.corePath.startsWith(REPO));
      const instance = reader.createReader({ locate: () => located, minIntervalMs: 0,
        coreOptions: { userHome: clean, env: { HOME: clean, USERPROFILE: clean, FORGE_HOME: forgeHome } } });
      const dto = await instance.read([project], { trigger: 'manual' });
      instance.dispose();
      assert.strictEqual(dto.schema_version, 1);
      assert.strictEqual(dto.state.reason, 'no-bindings', JSON.stringify(dto.state));
      assert.strictEqual(JSON.stringify(dto).includes(REPO), false);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
})().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}).finally(() => {
  for (const root of [temp, asciiTemp]) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* best effort */ } }
  if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed, ${skipped} skipped\n`);
});
