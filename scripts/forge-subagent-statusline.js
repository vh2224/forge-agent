#!/usr/bin/env node
'use strict';

// A cheap per-refresh formatter. Settings and terminal probing dependencies are
// loaded only by explicit actions; importing this module reads no user files.
const { AGENT_ROLES } = require('./forge-agent-view');
const { plainText } = require('./forge-sidecar-identity');
const { isSafeModelId } = require('./forge-sidecar-diagnostic');

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 64;
const MAX_OUTPUT_BYTES = 128 * 1024;
const VERSION_OUTPUT_BYTES = 4096;
const MIN_VERSION = '2.1.293';
const STATUSES = Object.freeze({ running: 'em execução', completed: 'concluído', failed: 'falhou', killed: 'interrompido' });
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function formatRows(input, { now } = {}) {
  if (!object(input) || !Array.isArray(input.tasks)) return [];
  const limit = Number.isSafeInteger(input.columns) && input.columns > 0 ? Math.min(input.columns, 240) : 240;
  const rows = [];
  for (const task of input.tasks) {
    if (rows.length >= MAX_ROWS) break;
    if (!object(task) || typeof task.id !== 'string' || !task.id || task.id.length > 128
        || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(task.id)
        || !Object.hasOwn(AGENT_ROLES, task.agentType)) continue;
    const role = AGENT_ROLES[task.agentType].label;
    const status = Object.hasOwn(STATUSES, task.status) ? STATUSES[task.status] : 'desconhecido';
    const parts = [role, 'executor nativo Claude', status];
    // Do not render arbitrary technical fields. Optional prose is sanitized by
    // the shared text boundary and omitted if it carries a path, tool or ID.
    const label = plainText(task.label || task.description, { missing: '', limit: 80 });
    if (label && !/[\\/:]|\b(?:Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|TaskOutput|spawn_agent)\b/i.test(label)
        && !label.includes(task.id)) parts.push(label);
    if (isSafeModelId(task.model) && !task.model.includes(task.id)) parts.push(`modelo resolvido ${task.model}`);
    if (EFFORTS.includes(task.effort) || Number.isSafeInteger(task.effort)) parts.push(`esforço configurado ${task.effort}`);
    const start = typeof task.startTime === 'number' ? task.startTime : typeof task.startTime === 'string' ? Date.parse(task.startTime) : NaN;
    if (Number.isFinite(now) && Number.isFinite(start) && start >= 0 && now >= start) {
      const seconds = Math.floor((now - start) / 1000);
      parts.push(`tempo ${Math.floor(seconds / 60)}m ${seconds % 60}s`);
    }
    rows.push({ id: task.id, content: plainText(parts.join(' · '), { missing: role, limit }) });
  }
  return rows;
}

function commandFor(options = {}) {
  const path = require('path');
  const { resolveForgeHome, resolveUserHome } = require('./forge-home');
  const home = path.resolve(resolveForgeHome(options));
  const conventional = path.resolve(path.join(resolveUserHome(options), '.forge-agent'));
  if (home === conventional) return 'node ~/.forge-agent/scripts/forge-subagent-statusline.js';
  return `node "${path.join(home, 'scripts', 'forge-subagent-statusline.js').split(path.sep).join('/')}"`;
}

function isManagedCommand(command, options = {}) {
  if (typeof command !== 'string') return false;
  return command === 'node ~/.forge-agent/scripts/forge-subagent-statusline.js' || command === commandFor(options);
}

function versionStatus(version) {
  const { compareHostVersion } = require('./forge-host-baseline');
  const comparison = compareHostVersion(MIN_VERSION, version);
  return { version: comparison.observed_version, relation: comparison.relation,
    reason_code: ['same', 'newer'].includes(comparison.relation) ? 'supported'
      : comparison.relation === 'older' ? 'version-unsupported' : 'version-unknown' };
}

function observeClaudeVersion(options = {}) {
  const { resolveExecutable, invoke } = require('./forge-capabilities');
  const source = 'terminal-cli --version';
  const unknown = { version: null, relation: 'unknown', reason_code: 'version-unknown', source };
  const executable = resolveExecutable('claude', { env: options.env });
  if (!executable) return unknown;
  const timeout = Number.isSafeInteger(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 5000) : 3000;
  // invoke owns shell:false, timeout and spawnSync's bounded default buffer.
  // Independently bound accepted version output; no raw CLI text is retained.
  const result = invoke(executable, ['--version'], { env: options.env, cwd: options.cwd, timeout });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || result.status !== 0 || Buffer.byteLength(output) > VERSION_OUTPUT_BYTES) return unknown;
  const first = output.match(/(?:^|[^0-9A-Za-z.])([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.+-])/);
  return first ? { ...versionStatus(first[1]), source } : unknown;
}

function planSetup(settings, options = {}) {
  const result = reason_code => ({ action: 'none', reason_code, changed: false });
  if (!object(settings)) return result('settings-invalid');
  if (Number.isSafeInteger(options.bytes) && options.bytes > MAX_BYTES) return result('settings-oversize');
  const current = settings.subagentStatusLine;
  const owned = object(current) && isManagedCommand(current.command, options);
  if (options.remove && !owned) return result('absent-noop');
  const version = versionStatus(options.claudeVersion);
  if (version.reason_code !== 'supported') return result(version.reason_code);
  if (settings.disableAllHooks === true || settings.allowManagedHooksOnly === true) return result('gated');
  if (!options.remove && Object.hasOwn(settings, 'subagentStatusLine') && !owned) return result('operator-owned');
  const command = options.command || commandFor(options);
  const candidate = { ...settings };
  if (options.remove) delete candidate.subagentStatusLine;
  else candidate.subagentStatusLine = { type: 'command', command };
  const { isDeepStrictEqual } = require('util');
  if (isDeepStrictEqual(settings, candidate)) return result('current-noop');
  return { action: options.remove ? 'remove' : 'write', reason_code: options.remove ? 'removed' : 'added', changed: true, settings: candidate };
}

function changeSettings(file, options) {
  const fs = options.fs || require('fs');
  const path = require('path');
  const { randomUUID } = require('crypto');
  const { isDeepStrictEqual } = require('util');
  const { readBoundedStableFile } = require('./forge-autonomy-sources');
  const base = { availability: 'conditional', rendering: 'unknown', reserialized: false,
    external_gates: { workspace_trust: 'unknown', managed_policy: 'unknown', project_settings: 'unknown' } };
  const done = (reason_code, extras = {}) => ({ ...base, reason_code, changed: false,
    ...(['settings-changed', 'settings-conflict', 'settings-raced'].includes(reason_code)
      ? { message: 'Edição concorrente observada; reconciliação manual dos settings e arquivos retidos necessária.' } : {}), ...extras });
  const target = path.resolve(file);
  let real;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return done('settings-invalid');
    real = (fs.realpathSync.native || fs.realpathSync)(target);
  } catch { return done('settings-invalid'); }
  const read = () => readBoundedStableFile(target, MAX_BYTES, { io: fs, expectedReal: real });
  const initial = read();
  if (initial.error) return done(initial.error === 'source_too_large' ? 'settings-oversize' : 'settings-invalid');
  let settings;
  try { settings = JSON.parse(initial.buffer.toString('utf8')); } catch { return done('settings-invalid'); }
  const version = options.observe ? observeClaudeVersion(options).version : options.claudeVersion;
  const command = commandFor(options);
  const plan = planSetup(settings, { ...options, claudeVersion: version, command, remove: options.remove, bytes: initial.buffer.length });
  if (!plan.changed) return done(plan.reason_code);
  const candidate = Buffer.from(JSON.stringify(plan.settings, null, 2) + '\n');
  if (candidate.length > MAX_BYTES) return done('settings-oversize');
  const parsed = JSON.parse(candidate.toString('utf8'));
  const outside = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'subagentStatusLine'));
  if (!isDeepStrictEqual(outside(settings), outside(parsed))
      || (options.remove ? Object.hasOwn(parsed, 'subagentStatusLine') : !isDeepStrictEqual(parsed.subagentStatusLine, { type: 'command', command }))) return done('settings-invalid');
  const backup = `${target}.forge-subagents-${randomUUID()}.bak`;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.forge-subagents-${randomUUID()}.tmp`);
  const retired = `${target}.forge-subagents-${randomUUID()}.retired.bak`;
  let temporaryCreated = false;
  let retiredReserved = false;
  let retiredMoved = false;
  const retained = { backup, semantic_equal: true };
  // Both placement and restoration must refuse an occupied live pathname.
  const placeExclusive = source => {
    try { fs.linkSync(source, target); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
      fs.copyFileSync(source, target, require('fs').constants.COPYFILE_EXCL);
    }
  };
  const restore = reason => {
    try { placeExclusive(retired); }
    catch (error) { return done(error.code === 'EEXIST' ? 'settings-conflict' : 'settings-write-failed', retained); }
    return done(reason, retained);
  };
  const readRetired = () => readBoundedStableFile(retired, MAX_BYTES, { io: fs, expectedReal: retired });
  try {
    fs.writeFileSync(backup, initial.buffer, { flag: 'wx', mode: initial.stat.mode & 0o777 });
    const descriptor = fs.openSync(temporary, 'wx', initial.stat.mode & 0o777);
    temporaryCreated = true;
    try { fs.writeFileSync(descriptor, candidate); } finally { fs.closeSync(descriptor); }
    const current = read();
    if (current.error || !current.buffer.equals(initial.buffer)) return done('settings-changed', retained);
    // Reserve our own random name exclusively before renaming onto it. The
    // live target is never a rename destination and can never be overwritten.
    const reservation = fs.openSync(retired, 'wx', initial.stat.mode & 0o777);
    retiredReserved = true;
    fs.closeSync(reservation);
    fs.renameSync(target, retired);
    retiredMoved = true;
    retained.retired = retired;
    const moved = readRetired();
    if (moved.error || !moved.buffer.equals(initial.buffer)) return restore('settings-conflict');
    try { placeExclusive(temporary); }
    catch (error) {
      if (error.code === 'EEXIST') return done('settings-conflict', retained);
      return restore('settings-write-failed');
    }
    fs.unlinkSync(temporary); temporaryCreated = false;
    const confirmed = readRetired();
    if (confirmed.error || !confirmed.buffer.equals(initial.buffer)) return done('settings-conflict', { ...retained, reserialized: true });
    const final = read();
    if (final.error || !final.buffer.equals(candidate)) return done('settings-raced', { ...retained, reserialized: true });
    return done(plan.reason_code, { ...retained, changed: true, reserialized: true });
  } catch {
    return done('settings-write-failed', retained);
  } finally {
    if (temporaryCreated) { try { fs.unlinkSync(temporary); } catch { /* Only our exclusive temporary may be cleaned up. */ } }
    if (retiredReserved && !retiredMoved) { try { fs.unlinkSync(retired); } catch { /* Only our empty reservation may be removed. */ } }
    // Keep the actual retired inode, also on success: original open descriptors
    // may still write after our last observation or after this function returns.
  }
}

function setup(file, options = {}) { return changeSettings(file, { ...options, remove: false }); }
function remove(file, options = {}) { return changeSettings(file, { ...options, remove: true }); }

module.exports = { formatRows, planSetup, setup, remove, commandFor, isManagedCommand, observeClaudeVersion };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length) {
    try {
      let mode, file, claudeVersion, observe = false;
      for (let i = 0; i < args.length; i++) {
        if (['--setup', '--remove'].includes(args[i]) && !mode) { mode = args[i]; file = args[++i]; if (!file || file.startsWith('--')) throw new Error('arguments'); }
        else if (args[i] === '--claude-version' && !claudeVersion) { claudeVersion = args[++i]; if (!claudeVersion) throw new Error('arguments'); }
        else if (args[i] === '--observe' && !observe) observe = true;
        else throw new Error('arguments');
      }
      const result = mode ? (mode === '--setup' ? setup : remove)(file, { claudeVersion, observe }) : observe ? observeClaudeVersion() : null;
      if (!result) throw new Error('arguments');
      process.stdout.write(JSON.stringify({ ...result, message: result.message || 'Disponibilidade condicional; renderização no host não validada.' }) + '\n');
    } catch { process.stdout.write(JSON.stringify({ reason_code: 'arguments-invalid', message: 'Argumentos inválidos.' }) + '\n'); }
  } else {
    let size = 0, oversize = false;
    const chunks = [];
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) { oversize = true; chunks.length = 0; }
      else if (!oversize) chunks.push(chunk);
    });
    process.stdin.on('error', () => { chunks.length = 0; oversize = true; });
    process.stdin.on('end', () => {
      if (oversize) return;
      try {
        const rows = formatRows(JSON.parse(Buffer.concat(chunks).toString('utf8')), { now: Date.now() });
        let written = 0;
        for (const row of rows) {
          const encoded = JSON.stringify(row) + '\n';
          written += Buffer.byteLength(encoded);
          if (written > MAX_OUTPUT_BYTES) break;
          process.stdout.write(encoded);
        }
      } catch { /* A malformed refresh leaves the host's default rows intact. */ }
    });
  }
}
