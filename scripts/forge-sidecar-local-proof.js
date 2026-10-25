'use strict';

// Local proof-of-life provider for a sidecar child process (S02/T02).
//
// Answers "is the child alive and doing something?" with three distinct
// outcomes, so the liveness module can tell "the platform cannot measure"
// apart from "measured and idle" and from "the child is gone":
//
//   capability  'available' | 'unavailable'   — could we measure activity?
//   proof       'positive' | 'negative' | 'none'
//
// The provider is read-only and engine-neutral: it never follows symlinks,
// never reads file contents (metadata only), runs `ps` with a fixed argv and
// no shell, and never creates timers — the caller schedules sample() and the
// watchdog tick only reads the cache through current().

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');

const fsp = fs.promises;

const LIMITS = Object.freeze({
  MIN_CPU_DELTA_MS: 50,
  MAX_DEPTH: 8,
  MAX_ENTRIES: 20000,
  MAX_PROCESSES: 4096,
  PS_TIMEOUT_MS: 2000,
  DEFAULT_INTERVAL_MS: 15000,
});

const DEFAULT_IGNORE_DIRS = Object.freeze(['.git']);

// /proc/<pid>/stat reports utime/stime in clock ticks. CLK_TCK is 100 on
// every mainstream Linux build; reading it would need a spawn (`getconf`), so
// the conversion is a documented approximation.
const ASSUMED_CLK_TCK = 100;
const PROC_READ_BATCH = 64;

const isValidPid = pid => Number.isInteger(pid) && pid > 0;

async function settle(run) {
  try { return await run(); } catch { return null; }
}

// ---------------------------------------------------------------- PID reader

async function pidAlive(pid) {
  if (!isValidPid(pid)) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    return null;
  }
}

// ---------------------------------------------------------------- CPU readers

// Sums cpu_ms of `pid` and every descendant. rows: [{ pid, ppid, cpu_ms }].
// Returns null when the root pid is absent from the snapshot.
function sumProcessTree(rows, pid) {
  const children = new Map();
  let root = null;
  for (const row of rows) {
    if (row.pid === pid) root = row;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  if (!root) return null;
  let total = 0;
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    total += row.cpu_ms;
    for (const child of children.get(row.pid) || []) stack.push(child);
  }
  return total;
}

// The comm field sits between parentheses and may contain spaces or ')';
// parsing starts after the LAST ')'. After it: state(3) ppid(4) ... utime(14) stime(15).
function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number.parseInt(text.slice(0, text.indexOf('(')), 10);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!isValidPid(pid) || !Number.isInteger(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pid, ppid, cpu_ms: ((utime + stime) * 1000) / ASSUMED_CLK_TCK };
}

async function linuxCpuTreeMs(pid, options = {}) {
  if (!isValidPid(pid)) return null;
  const procRoot = options.procRoot || '/proc';
  const names = (await fsp.readdir(procRoot)).filter(name => /^\d+$/.test(name));
  // The root pid is always read, even when the process table exceeds the cap.
  const selected = [String(pid), ...names.filter(name => name !== String(pid))].slice(0, LIMITS.MAX_PROCESSES);
  const rows = [];
  for (let index = 0; index < selected.length; index += PROC_READ_BATCH) {
    const batch = selected.slice(index, index + PROC_READ_BATCH);
    const texts = await Promise.all(batch.map(name =>
      settle(() => fsp.readFile(path.join(procRoot, name, 'stat'), 'utf8'))));
    for (const text of texts) {
      const row = parseProcStat(text);
      if (row) rows.push(row);
    }
  }
  return sumProcessTree(rows, pid);
}

// ps `time` column: [[dd-]hh:]mm:ss[.cc]
function parsePsTime(value) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return Math.round((((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000);
}

function parsePsOutput(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (rows.length >= LIMITS.MAX_PROCESSES) break;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const cpu_ms = parsePsTime(parts[2]);
    if (isValidPid(pid) && Number.isInteger(ppid) && cpu_ms !== null) rows.push({ pid, ppid, cpu_ms });
  }
  return rows;
}

function darwinCpuTreeMs(pid, options = {}) {
  if (!isValidPid(pid)) return Promise.resolve(null);
  const run = options.execFile || execFile;
  return new Promise(resolve => {
    try {
      run('ps', ['-A', '-o', 'pid=,ppid=,time='],
        { timeout: LIMITS.PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          resolve(sumProcessTree(parsePsOutput(stdout), pid));
        });
    } catch { resolve(null); }
  });
}

// win32: no CPU measurement (WMI/PowerShell deferred) and no spawn.
async function cpuTreeMs(pid, platform = process.platform) {
  if (platform === 'linux') return linuxCpuTreeMs(pid);
  if (platform === 'darwin') return darwinCpuTreeMs(pid);
  return null;
}

// ---------------------------------------------------------------- fs reader

function pathNormalizer(platform) {
  const insensitive = platform === 'win32';
  return value => {
    const normalized = path.resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return insensitive ? normalized.toLowerCase() : normalized;
  };
}

// Metadata fingerprint of the writable roots: (count, bytes, max mtime).
// Directories count as entries but contribute neither bytes nor mtime, so a
// file created inside an ignored subtree cannot leak through its parent's mtime.
async function fsFingerprint(roots, ignore = {}, platform = process.platform, limits = LIMITS) {
  const normalize = pathNormalizer(platform);
  const dirNames = new Set(Array.isArray(ignore.dirNames) ? ignore.dirNames : DEFAULT_IGNORE_DIRS);
  const prefixes = (Array.isArray(ignore.prefixes) ? ignore.prefixes : [])
    .filter(prefix => typeof prefix === 'string' && prefix).map(normalize);
  const validRoots = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !root) continue;
    const stat = await settle(() => fsp.lstat(root));
    if (stat && stat.isDirectory()) validRoots.push(path.resolve(root));
  }
  if (!validRoots.length) return null;
  const forgeDirs = validRoots.map(root => normalize(path.join(root, '.gsd', 'forge')));
  const ignored = normalized =>
    forgeDirs.some(dir => normalized === dir || normalized.startsWith(`${dir}/`))
    || prefixes.some(prefix => normalized.startsWith(prefix));

  const result = { count: 0, bytes: 0, mtime_max: 0, truncated: false };
  const stack = validRoots.map(dir => ({ dir, depth: 0 }));
  const STAT_BATCH = 32;
  // The entry budget stops everything; depth truncation only skips that subtree.
  let budgetExhausted = false;
  while (stack.length && !budgetExhausted) {
    const { dir, depth } = stack.pop();
    const handle = await settle(() => fsp.opendir(dir));
    if (!handle) continue;
    try {
      let pending = [];
      const flush = async () => {
        const stats = await Promise.all(pending.map(full => settle(() => fsp.lstat(full))));
        for (let index = 0; index < pending.length; index++) {
          const stat = stats[index];
          if (!stat) continue; // vanished between readdir and lstat
          result.count++;
          if (stat.isDirectory()) {
            if (depth + 1 < limits.MAX_DEPTH) stack.push({ dir: pending[index], depth: depth + 1 });
            else result.truncated = true;
            continue;
          }
          result.bytes += stat.size;
          if (stat.mtimeMs > result.mtime_max) result.mtime_max = stat.mtimeMs;
        }
        pending = [];
      };
      for (;;) {
        const entry = await settle(() => handle.read());
        if (!entry) break;
        if (entry.isDirectory() && dirNames.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (ignored(normalize(full))) continue;
        if (result.count + pending.length >= limits.MAX_ENTRIES) {
          // A candidate exists beyond the budget: settle in-flight stats, never schedule it.
          await flush();
          if (result.count >= limits.MAX_ENTRIES) { result.truncated = true; budgetExhausted = true; break; }
        }
        pending.push(full);
        if (pending.length >= Math.min(STAT_BATCH, limits.MAX_ENTRIES - result.count)) await flush();
      }
      if (!budgetExhausted) await flush();
    } finally {
      await settle(() => handle.close());
    }
  }
  return result;
}

const sameFingerprint = (a, b) => a.count === b.count && a.bytes === b.bytes && a.mtime_max === b.mtime_max;

const DEFAULT_READERS = Object.freeze({ pidAlive, cpuTreeMs, fsFingerprint });

// ---------------------------------------------------------------- provider

function deriveState(pidState, cpu, fsState) {
  if (pidState === false) return { capability: 'available', proof: 'negative' };
  if (pidState !== true) return { capability: 'unavailable', proof: 'none' };
  const capability = cpu.available ? 'available' : 'unavailable';
  const active = (cpu.available && cpu.delta_ms >= LIMITS.MIN_CPU_DELTA_MS) || fsState.changed;
  return { capability, proof: active ? 'positive' : 'none' };
}

function createLocalProof(options = {}) {
  const {
    pid,
    roots = [],
    ignore = {},
    platform = process.platform,
    clock = () => performance.now(),
    readers = {},
    onWrite,
  } = options;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs : LIMITS.DEFAULT_INTERVAL_MS;
  const io = { ...DEFAULT_READERS, ...readers };
  const rootList = Array.isArray(roots) ? roots.slice() : [];

  let stopped = false;
  let inflight = null;
  let last = null;
  let previousCpuMs = null;
  let previousFingerprint = null;

  async function measureCpu() {
    const value = await settle(() => io.cpuTreeMs(pid, platform));
    if (!Number.isFinite(value) || value < 0) {
      previousCpuMs = null; // a gap never lets an older baseline inflate the next delta
      return { available: false, delta_ms: 0 };
    }
    const delta = previousCpuMs === null ? 0 : Math.max(0, value - previousCpuMs);
    previousCpuMs = value;
    return { available: true, delta_ms: delta };
  }

  async function measureFs() {
    if (!rootList.length) return { available: false, changed: false, truncated: false };
    const print = await settle(() => io.fsFingerprint(rootList, ignore, platform));
    if (!print || !Number.isFinite(print.count)) return { available: false, changed: false, truncated: false };
    const changed = previousFingerprint !== null && !sameFingerprint(previousFingerprint, print);
    previousFingerprint = { count: print.count, bytes: print.bytes, mtime_max: print.mtime_max };
    return { available: true, changed, truncated: print.truncated === true };
  }

  async function takeSample() {
    const pidState = await settle(() => io.pidAlive(pid));
    let cpu = { available: false, delta_ms: 0 };
    let fsState = { available: false, changed: false, truncated: false };
    if (pidState !== false) {
      cpu = await measureCpu();
      fsState = await measureFs();
    }
    if (stopped) return current();
    last = { ...deriveState(pidState, cpu, fsState), pid_alive: pidState === true || pidState === false ? pidState : null,
      cpu, fs: fsState, sampled_at_ms: clock() };
    if (fsState.changed && typeof onWrite === 'function') {
      try { onWrite(); } catch { /* best-effort: a consumer error never breaks sampling */ }
    }
    return current();
  }

  function sample() {
    // A dead child is final: later samples do no I/O. A stopped provider neither.
    if (stopped || (last && last.proof === 'negative')) return Promise.resolve(current());
    if (!inflight) inflight = takeSample().finally(() => { inflight = null; });
    return inflight;
  }

  function current() {
    if (!last) {
      return { capability: 'unavailable', proof: 'none', available: false, proven: false, scope: 'child-pid',
        pid_alive: null, cpu: { available: false, delta_ms: 0 },
        fs: { available: false, changed: false, truncated: false }, sampled_at_ms: null, age_ms: null };
    }
    const age = Math.max(0, clock() - last.sampled_at_ms);
    // A stale positive never keeps extending: it degrades to 'none' with the
    // capability of the last sample. 'negative' never expires.
    const proof = last.proof === 'positive' && age > 2 * intervalMs ? 'none' : last.proof;
    return {
      capability: last.capability,
      proof,
      available: last.capability === 'available',
      proven: proof === 'positive',
      scope: 'child-pid',
      pid_alive: last.pid_alive,
      cpu: { ...last.cpu },
      fs: { ...last.fs },
      sampled_at_ms: last.sampled_at_ms,
      age_ms: age,
    };
  }

  function stop() { stopped = true; }

  return { sample, current, stop };
}

module.exports = {
  LIMITS,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_READERS,
  createLocalProof,
  pidAlive,
  cpuTreeMs,
  fsFingerprint,
  linuxCpuTreeMs,
  darwinCpuTreeMs,
  parseProcStat,
  parsePsTime,
  parsePsOutput,
  sumProcessTree,
};
