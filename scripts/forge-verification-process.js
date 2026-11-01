'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_OUTPUT = 1024 * 1024;
const script = path.join(__dirname, 'forge-verification-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function createWindowsRunner({ spawnSyncImpl = spawnSync } = {}) {
  let compiled = null;
  const invoke = (mode, input, options, timeout) => spawnSyncImpl(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode],
    { cwd: options.cwd, env: options.env, windowsHide: true, encoding: 'utf8', input,
      timeout, maxBuffer: 4 * 1024 * 1024, stdio: 'pipe' });
  function failed(reason, { joined = false, started = 'unknown', supervisorPid = null, jobName = null } = {}) {
    const error = Object.assign(new Error(`verification process supervision: ${reason}`), { code: 'EVERIFYCLEANUP' });
    return { status: null, stdout: '', stderr: '', error, signal: null, stop: true,
      cleanup: { platform: 'win32', status: joined ? 'joined' : 'unproved', started, reason, supervisor_pid: supervisorPid, job_name: jobName } };
  }
  return function run(command, options = {}) {
    let invocationAttempted = false;
    try {
    if (typeof command !== 'string' || !command || command.includes('\0') || !path.isAbsolute(options.cwd) || options.cwd.includes('\0')
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147453647
      || options.disableAutoRun !== undefined && typeof options.disableAutoRun !== 'boolean') {
      return failed('invalid-supervisor-input', { joined: true, started: false });
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
      } catch { return failed('supervisor-compile-failed', { started: false, supervisorPid: result?.pid || null }); }
      if (result.status !== 0 || packet.schema !== 1 || typeof packet.assembly !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.assembly) || packet.assembly.length > 2 * MAX_OUTPUT
        || crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex') !== sourceHash) {
        return failed('supervisor-compile-failed', { started: false, supervisorPid: result?.pid || null });
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

module.exports = { createWindowsRunner, runWindowsCommand: createWindowsRunner(), MAX_OUTPUT };
