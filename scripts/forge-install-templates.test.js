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
function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
function treeContains(root, pattern) {
  return allFiles(root).some((file) => {
    try { return pattern.test(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
  });
}
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

test('temporary Claude and Codex installs carry delivery helper, contract and operational consumers', () => {
  const root = tempRoot('delivery-projections');
  const options = {
    repo: ROOT, runtime: 'both', noModelProbe: true, skipCapabilityCheck: true,
    forgeHome: path.join(root, 'forge'), claudeHome: path.join(root, 'claude'),
    codexHome: path.join(root, 'codex'), projectRoot: path.join(root, 'project'),
    userHome: root, env: { ...process.env, HOME: root, USERPROFILE: root },
  };
  fs.mkdirSync(options.projectRoot, { recursive: true });
  const result = installer.install(options);
  assert.strictEqual(result.ok, true);
  assert(fs.existsSync(path.join(options.forgeHome, 'scripts', 'forge-delivery.js')));
  assert(fs.existsSync(path.join(options.forgeHome, 'shared', 'forge-delivery.md')));
  const contract = fs.readFileSync(path.join(options.forgeHome, 'shared', 'forge-delivery.md'), 'utf8');
  assert.match(contract, /três|verificado/);
  for (const [host, home] of [['Claude', options.claudeHome], ['Codex', options.codexHome]]) {
    assert(treeContains(home, /forge-delivery\.js[\s\S]*DELIVERY\.json/), `${host} projection lacks operational delivery invocation`);
    assert(treeContains(home, /expected_children|every expected (?:task|slice) DELIVERY/), `${host} projection lacks complete child delivery aggregation`);
    assert(treeContains(home, /After review handling[\s\S]*DELIVERY-INPUT/), `${host} projection lacks post-review rematerialization`);
  }
});

test('delivery references cover native, sidecar and headless task/slice/milestone sources', () => {
  const taskSkill = fs.readFileSync(path.join(ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  assert.match(taskSkill, /orchestrator, as artifact owner[\s\S]*forge-delivery\.js/);
  assert.match(taskSkill, /## Entrega por critério/);
  assert.doesNotMatch(taskSkill, /## Must-Haves Verified\s*\n\s*- \[x\] item 1/);
  assert.match(taskSkill, /After review handling[\s\S]*re-run the two `forge-delivery\.js` materializations/);
  const executor = fs.readFileSync(path.join(ROOT, 'agents', 'forge-executor.md'), 'utf8');
  assert.match(executor, /Capture delivery sources contemporaneously/);
  assert.match(executor, /Materialize delivery/);
  for (const file of ['shared/forge-completer-slice.md', 'shared/forge-completer-milestone.md']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /complete sibling[\s\S]*DELIVERY\.json/i);
    assert.match(source, /forge-delivery\.js/);
  }
  for (const file of ['execute-task.md', 'complete-slice.md', 'complete-milestone.md']) {
    const source = fs.readFileSync(path.join(TEMPLATE_SRC, file), 'utf8');
    assert.match(source, /forge-delivery\.js/);
    assert.match(source, /--owner-root/);
    assert.match(source, /--code-dir/);
  }
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
