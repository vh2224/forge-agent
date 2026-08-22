#!/usr/bin/env node
'use strict';

// Offline wrapper/dispatch inventory tests. Homes are always temporary; no
// real Claude, Codex, network, login or model probe is used.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TEMPLATE_FILES } = require('./forge-prompt.js');
const installer = require('./forge-installer.js');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const INSTALL_PS1 = path.join(ROOT, 'install.ps1');
const TEMPLATE_SRC = path.join(ROOT, 'shared', 'templates', 'dispatch');
const roots = [];
let passed = 0;
let skipped = 0;
function tempRoot(label) { const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-install-${label}-`)); roots.push(root); return root; }
function test(name, fn) { try { fn(); passed++; process.stdout.write(`ok - ${name}\n`); } catch (error) { process.stderr.write(`not ok - ${name}\n${error.stack}\n`); process.exitCode = 1; } }
function skip(name, reason) { skipped++; process.stdout.write(`ok - ${name} # SKIP ${reason}\n`); }
function templateNames(dir) { return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); }
function nativePowerShell() {
  for (const command of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell']) {
    const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

test('template inventory matches forge-prompt dispatch units', () => {
  assert.deepStrictEqual(templateNames(TEMPLATE_SRC), Object.values(TEMPLATE_FILES).sort());
  assert.ok(templateNames(TEMPLATE_SRC).length >= 10);
});

test('both wrappers delegate runtime/update/dry-run to the shared Node core', () => {
  const shell = fs.readFileSync(INSTALL_SH, 'utf8');
  assert.match(shell, /forge-installer\.js/);
  assert.match(shell, /forge-update\.js/);
  assert.match(shell, /"\$\{FORWARDED\[@\]\}"/);
  const powershell = fs.readFileSync(INSTALL_PS1, 'utf8');
  assert.match(powershell, /ValidateSet\('claude', 'codex', 'both'\)/);
  assert.match(powershell, /-DryRun/);
  assert.match(powershell, /forge-installer\.js/);
  assert.match(powershell, /forge-update\.js/);
  assert.match(powershell, /PSBoundParameters\.ContainsKey\('Runtime'\)/);
  assert.match(powershell, /ProjectRoot/);
});

test('core dry-run is deterministic and reports only selected adapter', () => {
  const root = tempRoot('dry-run');
  const options = { repo: ROOT, runtime: 'codex', dryRun: true, forgeHome: path.join(root, 'forge home Ω'), claudeHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex') };
  const left = JSON.stringify(installer.install(options));
  const right = JSON.stringify(installer.install(options));
  // Backup names are intentionally absent on a first dry run; the plan is byte deterministic.
  assert.strictEqual(left, right);
  assert.strictEqual(fs.existsSync(options.forgeHome), false);
  assert(!JSON.parse(left).plan.some((entry) => entry.destination.startsWith(options.claudeHome)));
});

if (process.platform === 'win32') {
  const ps = nativePowerShell();
  if (!ps) skip('PowerShell native dry-run', 'PowerShell unavailable');
  else test('PowerShell native dry-run accepts Codex and Unicode homes', () => {
    const root = tempRoot('ps');
    const env = { ...process.env, USERPROFILE: root, HOME: root };
    const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1, '-Runtime', 'codex', '-DryRun', '-NoModelProbe', '-ForgeHome', path.join(root, 'forge Ω')], { encoding: 'utf8', env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime: codex/);
    assert.strictEqual(fs.existsSync(path.join(root, 'forge Ω')), false);
  });
} else {
  test('POSIX wrapper dry-run accepts Codex and leaves homes absent', () => {
    const root = tempRoot('posix');
    const forgeHome = path.join(root, 'forge home Ω');
    const result = spawnSync('bash', [INSTALL_SH, '--runtime', 'codex', '--dry-run', '--no-model-probe'], { encoding: 'utf8', env: { ...process.env, HOME: root, FORGE_HOME: forgeHome }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /runtime: codex/);
    assert.strictEqual(fs.existsSync(forgeHome), false);
  });
}

for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
process.stdout.write(`\n${passed} passed, ${skipped} skipped\n`);
