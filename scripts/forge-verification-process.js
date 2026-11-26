'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_OUTPUT = 1024 * 1024;
const script = path.join(__dirname, 'forge-verification-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// POSIX-style leading literal assignments are data for the requested child,
// never cmd syntax. This narrow scanner differs from the POSIX rewrite
// tokenizer deliberately: quoted Windows paths retain their backslashes.
// Chained commands are refused because one shell-wide env overlay would leak
// the assignment to later commands, unlike a POSIX per-command prefix.
function leadingEnvironment(command, environment) {
  const refuse = () => { throw Object.assign(new Error('verification-env-prefix-unprovable'), { code: 'EVERIFYENV' }); };
  let at = 0;
  const assignments = [];
  while (true) {
    while (command[at] === ' ' || command[at] === '\t') at++;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command.slice(at));
    if (!match) break;
    at += match[0].length;
    let value = '', quote = null;
    while (at < command.length) {
      const char = command[at];
      if (!quote && (char === ' ' || char === '\t')) break;
      if (/[\x00-\x1f$`%!^]/.test(char) || !quote && /[&|;<>]/.test(char)) refuse();
      if (char === '"' || char === "'") {
        if (quote === char) quote = null;
        else if (!quote) quote = char;
        else value += char;
      } else value += char;
      at++;
    }
    if (quote) refuse();
    assignments.push([match[1], value]);
  }
  if (!assignments.length) return { command, env: environment };
  const remaining = command.slice(at);
  // cmd expands these before recognizing operators, even inside double
  // quotes. A literal scan cannot prove that %CHAIN% or !CHAIN! stays one
  // command, so the prefix grammar must refuse expansion in the remainder.
  if (!remaining || /[\r\n\0%!]/.test(remaining)) refuse();
  const tokenized = require('./forge-command-rewrite').tokenizeCommand(remaining);
  if (tokenized.ok && tokenized.segments.length !== 1) refuse();
  let quote = false;
  for (const char of remaining) {
    if (char === '"') quote = !quote;
    else if (!quote && /[&|;^()]/.test(char)) refuse();
  }
  if (quote) refuse();
  const env = Object.assign(Object.create(null), environment || process.env);
  for (const [key, value] of assignments) {
    for (const present of Object.keys(env)) if (present.toLowerCase() === key.toLowerCase()) delete env[present];
    env[key] = value;
  }
  return { command: remaining, env };
}

function createWindowsRunner({ spawnSyncImpl = spawnSync } = {}) {
  let compiled = null;
  const invoke = (mode, input, options, timeout) => spawnSyncImpl(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode],
    { cwd: options.cwd, env: options.env, windowsHide: true, encoding: 'utf8', input,
      timeout, maxBuffer: 4 * 1024 * 1024, stdio: 'pipe' });
  function compileDiagnostic(result, parseState, exception) {
    const output = value => {
      if (typeof value !== 'string' && !Buffer.isBuffer(value)) return { bytes: null, sha256: null };
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
      return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    };
    const code = (result?.error || exception)?.code;
    return { stage: 'Compile', parse_state: parseState,
      status: Number.isSafeInteger(result?.status) && result.status >= -2147483648 && result.status <= 2147483647 ? result.status : null,
      signal: result?.signal == null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(result.signal) ? result.signal : 'other',
      error_code: code == null ? null : ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSYS'].includes(code) ? code : 'other',
      stdout: output(result?.stdout), stderr: output(result?.stderr) };
  }
  function failed(reason, { joined = false, started = 'unknown', supervisorPid = null, jobName = null, compile = null } = {}) {
    const error = Object.assign(new Error(`verification process supervision: ${reason}`), { code: 'EVERIFYCLEANUP' });
    return { status: null, stdout: '', stderr: '', error, signal: null, stop: true,
      cleanup: { platform: 'win32', status: joined ? 'joined' : 'unproved', started, reason, supervisor_pid: supervisorPid, job_name: jobName,
        ...(compile ? { supervisor_diagnostic: compile } : {}) } };
  }
  return function run(command, options = {}) {
    let invocationAttempted = false;
    try {
    if (typeof command !== 'string' || !command || command.includes('\0') || !path.isAbsolute(options.cwd) || options.cwd.includes('\0')
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147453647
      || options.disableAutoRun !== undefined && typeof options.disableAutoRun !== 'boolean') {
      return failed('invalid-supervisor-input', { joined: true, started: false });
    }
    try {
      const literal = leadingEnvironment(command, options.env);
      command = literal.command;
      if (literal.env !== options.env) options = { ...options, env: literal.env };
    } catch (error) {
      return { ...failed('verification-env-prefix-unprovable', { joined: true, started: false }), error };
    }
    let sourceHash;
    try { sourceHash = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'); }
    catch { return failed('supervisor-source-unreadable', { joined: true, started: false }); }
    if (!compiled || compiled.sourceHash !== sourceHash) {
      // Compilation cannot launch the requested command. Only in-process bytes
      // are cached; no persistent executable or user configuration is written.
      let result, packet;
      try {
        result = invoke('Compile', '', options, 15000);
        packet = JSON.parse(result.stdout || '');
      } catch (error) { return failed('supervisor-compile-failed', { started: false, supervisorPid: result?.pid || null,
        compile: compileDiagnostic(result, result ? 'invalid-json' : 'unavailable', error) }); }
      if (result.status !== 0 || packet.schema !== 1 || typeof packet.assembly !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.assembly) || packet.assembly.length > 2 * MAX_OUTPUT
        || crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') !== sourceHash) {
        return failed('supervisor-compile-failed', { started: false, supervisorPid: result?.pid || null,
          compile: compileDiagnostic(result, 'parsed') });
      }
      compiled = { sourceHash, assembly: packet.assembly };
    }
    const nonce = crypto.randomUUID(), jobName = `Local\\ForgeVerification-${nonce}`;
    let result, packet;
    try {
      invocationAttempted = true;
      result = invoke('Run', JSON.stringify({ nonce, jobName, assembly: compiled.assembly,
        command, cwd: options.cwd, timeout: options.timeoutMs, maxOutput: MAX_OUTPUT,
        ...(options.disableAutoRun === true ? { disableAutoRun: true } : {}) }), options, options.timeoutMs + 30000);
      packet = JSON.parse(result.stdout || '');
    } catch { return failed('supervisor-result-unavailable', { supervisorPid: result?.pid || null, jobName }); }
    const row = packet.outcome;
    if (result.status !== 0 || result.error || packet.schema !== 1 || packet.nonce !== nonce || !row
      || typeof row.started !== 'boolean' || typeof row.joined !== 'boolean' || typeof row.timedOut !== 'boolean'
      || typeof row.overflow !== 'boolean' || !Number.isInteger(row.status) || !Number.isInteger(row.active)
      || typeof row.stdout !== 'string' || typeof row.stderr !== 'string'
      || [row.stdout, row.stderr].some(text => text.length > Math.ceil(MAX_OUTPUT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))) {
      return failed('supervisor-result-invalid', { supervisorPid: result.pid || null, jobName });
    }
    if (!row.joined || row.active !== 0) return failed('job-join-unproved', { started: row.started, supervisorPid: result.pid || null, jobName });
    if (options.disableAutoRun === true && row.autoRunDisabled !== true) return failed('autorun-disable-unproved', { joined: true, started: row.started, supervisorPid: result.pid || null, jobName });
    const cleanup = { platform: 'win32', status: 'joined', started: row.started, reason: row.reason,
      supervisor_pid: result.pid || null, root_pid: row.pid || null, job_name: jobName, active_processes: 0,
      ...(options.disableAutoRun === true ? { autorun_disabled: true } : {}) };
    const outcome = { status: row.status, signal: null, stdout: Buffer.from(row.stdout, 'base64').toString('utf8'),
      stderr: Buffer.from(row.stderr, 'base64').toString('utf8'), cleanup, stop: row.timedOut || row.overflow || row.reason !== 'joined' };
    if (row.timedOut) outcome.error = Object.assign(new Error('verification command timeout after joined termination'), { code: 'ETIMEDOUT' });
    else if (row.overflow) outcome.error = Object.assign(new Error('verification command output limit after joined termination'), { code: 'ENOBUFS' });
    else if (row.reason !== 'joined') outcome.error = Object.assign(new Error('verification command supervisor refused'), { code: 'EVERIFYJOB' });
    return outcome;
    } catch {
      return failed('supervisor-internal-error', { joined: !invocationAttempted, started: invocationAttempted ? 'unknown' : false });
    }
  };
}

module.exports = { createWindowsRunner, runWindowsCommand: createWindowsRunner(), leadingEnvironment, MAX_OUTPUT };
