#!/usr/bin/env node
'use strict';

const path = require('path');
const maintenance = require('./forge-maintenance.js');
const installer = require('./forge-installer.js');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { repo: path.resolve(__dirname, '..'), apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') options.runtime = argv[++i] || '';
    else if (arg === '--repo') options.repo = path.resolve(argv[++i] || '');
    else if (arg === '--forge-home') options.forgeHome = path.resolve(argv[++i] || '');
    else if (arg === '--claude-home') options.claudeHome = path.resolve(argv[++i] || '');
    else if (arg === '--codex-home') options.codexHome = path.resolve(argv[++i] || '');
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || '');
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-model-probe') options.noModelProbe = true;
    else if (arg === '--capability-timeout') options.capabilityTimeout = Number(argv[++i] || '');
    else if (arg === '--migrate-legacy') options.migrateLegacy = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (options.runtime) maintenance.selectedRuntimes(options.runtime);
  return options;
}

function update(input = {}, dependencies = {}) {
  const plan = maintenance.planUpdate(input);
  const install = dependencies.install || installer.install;
  // A preview must stay side-effect free: the installer runs only to compute the
  // retire plan, so capability probing (which spawns `claude`/`codex --version`)
  // is suppressed here rather than left to a flag the CLI never sets.
  const preview = !input.apply;
  const installed = install({
    repo: input.repo,
    runtime: plan.runtime,
    update: true,
    forgeHome: input.forgeHome,
    userHome: input.userHome,
    claudeHome: input.claudeHome,
    codexHome: input.codexHome,
    projectRoot: input.projectRoot,
    platform: input.platform,
    env: input.env,
    env: input.env,
    userHome: input.userHome,
    platform: input.platform,
    binaries: input.binaries,
    capabilityTimeout: input.capabilityTimeout,
    noModelProbe: preview ? true : input.noModelProbe,
    skipCapabilityCheck: preview ? true : input.skipCapabilityCheck,
    migrateLegacy: input.migrateLegacy,
    dryRun: preview,
  });
  if (preview) return { ...plan, applied: false, installer: installed, retirements: installed.plan.filter((entry) => entry.op === 'retire' || (entry.op === 'skip' && entry.reason === 'already-retired')) };
  return { ...plan, applied: true, changed: installed.changed, backup: installed.backup, installer: installed };
}

function render(report) {
  const lines = [
    `Forge update ${report.applied ? 'applied' : 'plan'}`,
    `runtime: ${report.runtime}`,
    `installation: ${report.installation_source}`,
    `backup: ${report.backup_required ? 'required-before-write' : 'not-required'}`,
  ];
  if (report.legacy_migration) lines.push(`legacy migration: ${report.legacy_migration.release} (${report.legacy_migration.runtime})`);
  if (report.installer && report.installer.backup) lines.push(`backup created: ${report.installer.backup}`);
  for (const retirement of report.retirements || []) {
    const state = retirement.op === 'skip' ? 'skipped' : 'retire';
    lines.push(`${state}: ${retirement.source} -> ${retirement.destination}`);
  }
  const conflicts = report.installer && report.installer.manifest && report.installer.manifest.adapters
    ? Object.values(report.installer.manifest.adapters).reduce((total, adapter) => total + (Array.isArray(adapter.conflicts) ? adapter.conflicts.length : 0), 0)
    : 0;
  if (conflicts) lines.push(`conflicts preserved: ${conflicts}; use --migrate-legacy to replace unmarked legacy projections`);
  if (report.applied) lines.push(report.changed ? 'managed files updated' : 'no managed-file changes');
  else lines.push('no files written; pass --apply to update');
  return `${lines.join('\n')}\n`;
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      write('Usage: forge-update.js [--runtime claude|codex|both] [--apply|--dry-run] [--repo DIR] [--json] [--no-model-probe] [--capability-timeout MS] [--migrate-legacy]\n');
      return 0;
    }
    const report = update(options);
    write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    errorWrite(`forge-update: ${error.message}\n`);
    return 1;
  }
}

module.exports = { parseArgs, update, render, run };
if (require.main === module) process.exitCode = run();
