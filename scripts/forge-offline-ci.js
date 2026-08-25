#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const ROOT = path.resolve(SCRIPTS, '..');
const MATRIX_FILE = path.join(SCRIPTS, 'fixtures', 'offline-ci', 'matrix.json');
const MATRIX = Object.freeze(JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8')));

function parseArgs(argv = process.argv.slice(2)) {
  const options = { host: null, platform: process.platform, plan: false, verbose: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--host') options.host = argv[++index] || '';
    else if (arg === '--platform') options.platform = argv[++index] || '';
    else if (arg === '--plan') options.plan = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.host && ![...MATRIX.hosts, 'both'].includes(options.host)) throw new Error(`invalid host: ${options.host}`);
  if (!MATRIX.platforms.includes(options.platform)) throw new Error(`invalid platform: ${options.platform}`);
  return options;
}

function scrubEnvironment(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|PRIVATE|COOKIE|AUTH|ACCESS[_-]?KEY)/i.test(key)) continue;
    env[key] = value;
  }
  env.FORGE_CI_OFFLINE = '1';
  env.FORGE_KEYCHAIN_DISABLED = '1';
  env.FORGE_TEST = '1';
  return env;
}

function buildPlan(options = {}) {
  const host = options.host || 'both';
  return MATRIX.suites.map((suite) => ({
    host,
    platform: options.platform || process.platform,
    executable: process.execPath,
    argv: [path.join(SCRIPTS, suite)],
    shell: false,
    network: false,
  }));
}

function run(options = {}, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const plan = buildPlan(options);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-offline-ci Ω-'));
  const results = [];
  try {
    for (const entry of plan) {
      const suite = path.basename(entry.argv[0]);
      const home = path.join(tempRoot, suite.replace(/\.test\.js$/, ''));
      fs.mkdirSync(home, { recursive: true });
      const env = {
        ...scrubEnvironment(options.env || process.env),
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        FORGE_CI_HOST: options.host || 'both',
        FORGE_CI_PLATFORM: options.platform || process.platform,
      };
      for (const directory of [env.XDG_CONFIG_HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
      const child = spawn(entry.executable, entry.argv, { cwd: ROOT, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
      const ok = child.status === 0 && !child.error;
      results.push({ suite, ok, status: child.status, signal: child.signal || null, stdout: child.stdout || '', stderr: child.stderr || '', error: child.error || null });
      if (!ok) break;
    }
  } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  return { ok: results.length === plan.length && results.every((item) => item.ok), host: options.host || 'both', platform: options.platform || process.platform, results, plan };
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { errorOutput(`forge-offline-ci: ${error.message}\n`); return 2; }
  if (options.help) { output('Usage: node scripts/forge-offline-ci.js [--host claude|codex|both] [--platform win32|darwin|linux] [--plan] [--verbose]\n'); return 0; }
  const plan = buildPlan(options);
  if (options.plan) {
    output(`${JSON.stringify({ schema_version: MATRIX.schema_version, host: options.host || 'both', platform: options.platform, suites: plan.map((entry) => path.basename(entry.argv[0])), executable: process.execPath, shell: false, network: false })}\n`);
    return 0;
  }
  const report = run(options);
  for (const result of report.results) {
    output(`${result.ok ? 'PASS' : 'FAIL'} ${result.suite}\n`);
    if (options.verbose || !result.ok) {
      if (result.stdout) output(result.stdout);
      if (result.stderr) errorOutput(result.stderr);
      if (result.error) errorOutput(`${result.error.message}\n`);
    }
  }
  output(`offline gate: ${report.results.filter((item) => item.ok).length}/${plan.length} suites (${report.host}/${report.platform})\n`);
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { MATRIX, MATRIX_FILE, buildPlan, main, parseArgs, run, scrubEnvironment };
