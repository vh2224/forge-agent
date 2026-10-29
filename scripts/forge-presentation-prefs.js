#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { DEFAULT_STATUS_LINE, readSettingDeclarations, readSimpleString, diagnoseStatusLine } = require('./forge-codex-statusline');

const MAX_BYTES = 1024 * 1024;
// Public projection contract: only strings (<=4096 UTF-16 units) for scalar
// preferences. Only these closed public spellings are returned literally.
// Other valid strings remain present with a fixed redaction marker. The
// internal status-line parser has no public-vocabulary restriction; this
// inspector projects <=64 items, each <=128 units and in DEFAULT_STATUS_LINE
// or git-branch. Their validity in a live host is separate runtime evidence.
const VOCABULARY = Object.freeze({
  personality: ['none', 'friendly', 'pragmatic'],
  model_verbosity: ['low', 'medium', 'high'],
  outputStyle: ['Default', 'Explanatory', 'Learning'],
});
const SAFE_ITEMS = new Set([...DEFAULT_STATUS_LINE, 'git-branch']);
const LIMIT_SUGGESTION = 'A barra do Codex tem uma seleção explícita sem todos os indicadores de limites. Use /statusline para incluir usage-limit e secondary-usage-limit. Nada foi alterado.';

function publicValue(value, key) {
  if (typeof value !== 'string' || value.length > 4096) return { state: 'invalid' };
  return VOCABULARY[key].includes(value)
    ? { state: 'present', value }
    : { state: 'present', value: '[redigido]', redacted: true };
}

function readSource(home, name) {
  const file = path.join(home, name);
  let expectedReal;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return { state: 'unreadable' };
    // Resolve directory aliases (including Windows short TEMP names) before
    // the stable reader checks identity; never accept a redirected file.
    expectedReal = path.join(fs.realpathSync.native(home), name);
  } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
  const result = readBoundedStableFile(file, MAX_BYTES, { expectedReal });
  if (result.error) return { state: result.error === 'source_too_large' ? 'oversize' : 'unreadable' };
  try { return { state: 'present', text: new TextDecoder('utf-8', { fatal: true }).decode(result.buffer) }; }
  catch (_) { return { state: 'invalid' }; }
}

function codexScalar(text, key) {
  const declaration = readSettingDeclarations(text, '', key);
  if (!declaration || declaration.ambiguous || declaration.values.length > 1) return { state: 'invalid', selection: 'manual-merge' };
  if (!declaration.preserved) return { state: declaration.cannotAdd ? 'invalid' : 'absent' };
  const value = readSimpleString(declaration.values[0]);
  return value === null ? { state: 'invalid' } : publicValue(value, key);
}

function statusLinePreference(text) {
  const diagnosis = diagnoseStatusLine(text);
  if (diagnosis.selection === 'absent') return { state: 'absent', ...diagnosis };
  if (diagnosis.selection === 'manual-merge') return { state: 'invalid', ...diagnosis };
  if (diagnosis.items.length > 64 || diagnosis.items.some(item => item.length > 4096)) {
    return { state: 'invalid', selection: 'explicit', items: [], missing_limit_indicators: [] };
  }
  return { state: 'present', selection: 'explicit', items: diagnosis.items.map(item => item.length <= 128 && SAFE_ITEMS.has(item) ? item : '[redigido]'), missing_limit_indicators: diagnosis.missing_limit_indicators };
}

// Claude's conventional command object is inspected for ownership only. Never
// return commands, arbitrary object fields or errors, and never execute it.
function claudeStatusLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'command'
    || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 8192
    || (value.padding !== undefined && (!Number.isInteger(value.padding) || value.padding < 0 || value.padding > 1024))) return { state: 'invalid' };
  return { state: 'present', owner: value.command.includes('forge-statusline.js') ? 'forge' : 'user' };
}

function inspectPresentationPrefs(options = {}) {
  const homes = resolveForgePaths(options).runtimeHomes;
  // The installer can restrict observation to selected hosts. Nonselected homes
  // are never read, retaining its existing selected-host isolation contract.
  const selected = options.runtimes || ['codex', 'claude'];
  const report = { writes: 0 };
  if (selected.includes('codex')) {
    const source = readSource(homes.codex, 'config.toml');
    const state = source.state;
    report.codex = { source: '<codex-home>/config.toml', state,
      personality: state === 'present' ? codexScalar(source.text, 'personality') : { state },
      model_verbosity: state === 'present' ? codexScalar(source.text, 'model_verbosity') : { state },
      status_line: state === 'present' ? statusLinePreference(source.text) : { state } };
  }
  if (selected.includes('claude')) {
    const source = readSource(homes.claude, 'settings.json');
    let state = source.state, settings;
    if (state === 'present') {
      try {
        settings = JSON.parse(source.text);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) state = 'invalid';
      } catch (_) { state = 'invalid'; }
    }
    report.claude = { source: '<claude-home>/settings.json', state,
      outputStyle: state !== 'present' ? { state } : Object.hasOwn(settings, 'outputStyle') ? publicValue(settings.outputStyle, 'outputStyle') : { state: 'absent' },
      statusLine: state !== 'present' ? { state } : Object.hasOwn(settings, 'statusLine') ? claudeStatusLine(settings.statusLine) : { state: 'absent' } };
  }
  report.suggestions = report.codex && report.codex.status_line.state === 'present'
    && report.codex.status_line.missing_limit_indicators.length
    ? [{ id: 'codex-status-line-limits', applied: false, text: LIMIT_SUGGESTION }] : [];
  return report;
}

function render(report) {
  const lines = ['Preferências de apresentação (somente leitura; nada foi alterado).'];
  for (const host of ['codex', 'claude']) {
    const source = report[host];
    if (!source) continue;
    lines.push(`${source.source}: ${source.state}`);
    for (const key of host === 'codex' ? ['personality', 'model_verbosity', 'status_line'] : ['outputStyle', 'statusLine']) {
      lines.push(`  ${key}: ${JSON.stringify(source[key])}`);
    }
  }
  lines.push(...report.suggestions.map(item => item.text));
  return lines.join('\n') + '\n';
}

function main(argv = process.argv.slice(2), io = process) {
  const usage = 'Uso: forge-presentation-prefs.js [--json] [--codex-home DIR] [--claude-home DIR]\n';
  const options = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (['--codex-home', '--claude-home'].includes(arg) && argv[i + 1] && argv[i + 1].trim() && !argv[i + 1].startsWith('--')) {
      options[arg === '--codex-home' ? 'codexHome' : 'claudeHome'] = argv[++i];
    } else { io.stderr.write(usage); return 2; }
  }
  let report;
  try { report = inspectPresentationPrefs(options); }
  catch { io.stderr.write(usage); return 2; }
  io.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : render(report));
  return 0;
}

module.exports = { inspectPresentationPrefs, render, main };
if (require.main === module) process.exitCode = main();
