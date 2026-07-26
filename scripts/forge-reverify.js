#!/usr/bin/env node
'use strict';

// forge-reverify.js — deterministic orchestrator-side sandbox re-verification.
// Formula-once rule: this helper alone owns the trigger and command-resolution
// rules; see shared/forge-dispatch.md § Sidecar dispatch state machine (TASK-015).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePackageManager } = require('./forge-isolation.js');
const { writeJsonAtomic } = require('./forge-surgical-reset.js');
const { extractRunnerTokens } = require('./forge-env-promote.js');

const DEFAULT_TIMEOUT_MS = 600000;

function needsReverification(result) {
  return Boolean(result && Array.isArray(result.must_haves_status)
    && result.must_haves_status.some(entry => entry && entry.status !== 'met'
      && entry.scope === 'environment' && entry.reason === 'sandbox-exec-blocked'));
}

function readText(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch { return null; }
}

function resolveVerifyCommand(codeDir) {
  const packageText = readText(path.join(codeDir, 'package.json'));
  if (packageText) {
    try {
      const pkg = JSON.parse(packageText);
      if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string') {
        const manager = resolvePackageManager(codeDir);
        return [manager ? manager.cmd : 'npm', 'test'];
      }
    } catch { /* malformed package files are not a verification command */ }
  }
  if (fs.existsSync(path.join(codeDir, 'go.mod'))) return ['go', 'test', './...'];
  if (fs.existsSync(path.join(codeDir, 'Cargo.toml'))) return ['cargo', 'test'];
  const pyproject = readText(path.join(codeDir, 'pyproject.toml'));
  const setupCfg = readText(path.join(codeDir, 'setup.cfg'));
  if (fs.existsSync(path.join(codeDir, 'pytest.ini')) || fs.existsSync(path.join(codeDir, 'tox.ini'))
      || (pyproject && /pytest/i.test(pyproject)) || (setupCfg && /^\[tool:pytest\]/mi.test(setupCfg))) {
    return ['pytest', '-q'];
  }
  const makefile = readText(path.join(codeDir, 'Makefile'));
  if (makefile && /^test:/m.test(makefile)) return ['make', 'test'];
  return null;
}

function commandText(argv) {
  return Array.isArray(argv) ? argv.join(' ') : '';
}

function outputTail(run) {
  const value = `${run && run.stderr || ''}${run && run.stdout || ''}`.trim();
  return value.slice(-500).replace(/\s+/g, ' ');
}

// Windows ships npm/pnpm/yarn as `.cmd` shims. CreateProcess cannot execute a
// batch file, and Node >= 18.20 rejects one outright with EINVAL (the
// CVE-2024-27980 mitigation), so a bare spawnSync('npm', …) fails on every
// Windows host — re-verification silently degraded to no-command there and the
// TASK-015 gate was inert on the whole platform. Resolve the real target
// through PATH/PATHEXT and route ONLY a shim through the interpreter, so a real
// executable (go, cargo, pytest) keeps the direct shell-free spawn.
//
// `shell: true` would be shorter — it is what forge-isolation.js uses for
// installs — but it also turns an absent runner into cmd's exit 1, which reads
// as `failed` and routes the task into the failure path. Resolving first keeps
// every verdict's meaning intact: unresolvable → no-command without ever
// spawning, timeout → ETIMEDOUT, project exit code → verbatim.
function resolveExecutable(command) {
  const name = String(command || '');
  if (!name) return null;
  if (name.includes(path.sep) || name.includes('/')) {
    return fs.existsSync(name) ? name : null;
  }
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // PATHEXT first: npm ships an extensionless POSIX sibling next to npm.cmd,
    // and picking that one hands Windows a file it cannot execute.
    for (const extension of [...extensions, '']) {
      const candidate = path.join(dir, name + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

function quoteWindowsArg(arg) {
  const value = String(arg);
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

// null means "this command cannot be spawned at all" — the caller turns that
// into no-command without touching the payload.
function spawnPlan(argv) {
  if (process.platform !== 'win32') return { file: argv[0], args: argv.slice(1), options: {} };
  const resolved = resolveExecutable(argv[0]);
  if (!resolved) return null;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args: argv.slice(1), options: {} };
  const line = [resolved, ...argv.slice(1)].map(quoteWindowsArg).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // windowsVerbatimArguments: Node must not re-escape a line that is already
    // quoted for cmd — without it the nested quotes are mangled and cmd runs
    // something else entirely (and reports exit 0 for it).
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

function runVerification({ argv, codeDir, timeoutMs }) {
  if (!Array.isArray(argv) || !argv.length) return { verdict: 'no-command', command: '', exit_code: null };
  const planned = spawnPlan(argv);
  if (!planned) return { verdict: 'no-command', command: commandText(argv), exit_code: null };
  const run = spawnSync(planned.file, planned.args, {
    cwd: codeDir,
    encoding: 'utf8',
    shell: false,
    timeout: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...planned.options,
  });
  const base = { command: commandText(argv), exit_code: typeof run.status === 'number' ? run.status : null };
  if (run.error && (run.error.code === 'ENOENT' || run.error.code === 'ETIMEDOUT')) {
    return { ...base, verdict: 'no-command' };
  }
  if (run.status === 0 && !run.error) return { ...base, verdict: 'verified' };
  return { ...base, verdict: 'failed', tail: outputTail(run) };
}

// Keep this selector separate from applyVerdict: it is evaluated before any
// mutation so an entry is never selected merely because a prior mutation made
// it task-scoped. That ordering is what lets a failed re-run enter repair.
function affectedEntries(result) {
  return Array.isArray(result && result.must_haves_status) ? result.must_haves_status.filter(entry => entry
    && entry.status !== 'met' && entry.scope === 'environment' && entry.reason === 'sandbox-exec-blocked') : [];
}

// Refusal gate only — NEVER used to pick which command to run, nor to map an
// entry to a command. The single command re-verified always comes from
// resolveVerifyCommand (project-derived), never from must-have prose. This
// helper's only job is to say "these notes look like different commands, so
// don't blanket-apply one verdict to every entry" and let a human sort it out.
function hasDivergentCommandNotes(entries) {
  const tokenSets = entries
    .map(entry => extractRunnerTokens(typeof entry.note === 'string' ? entry.note : ''))
    .filter(tokens => tokens.length > 0);
  if (tokenSets.length < 2) return false;
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      const disjoint = tokenSets[i].every(token => !tokenSets[j].includes(token));
      if (disjoint) return true;
    }
  }
  return false;
}

function applyVerdict(result, outcome) {
  if (!result || !outcome || !['verified', 'failed'].includes(outcome.verdict)) return result;
  const suffix = outcome.verdict === 'verified'
    ? `re-verified by orchestrator: ${outcome.command} exit 0`
    : `orchestrator re-verification failed: ${outcome.command} exit ${outcome.exit_code}; ${outcome.tail || ''}`.replace(/; $/, '');
  for (const entry of affectedEntries(result)) {
    if (outcome.verdict === 'verified') entry.status = 'met';
    entry.scope = 'task';
    entry.reason = '';
    entry.note = `${typeof entry.note === 'string' ? entry.note : ''} | ${suffix}`;
  }
  return result;
}

/**
 * Produce one deterministic verdict and, only when requested, amend the
 * temporary result payload. The worker-owned result is otherwise untouched.
 */
function reverify({ result, codeDir, mode = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS, apply = false }) {
  if (mode === 'off') return { verdict: 'disabled', command: '', exit_code: null, entries: 0 };
  if (!needsReverification(result)) return { verdict: 'not-applicable', command: '', exit_code: null, entries: 0 };
  const pending = affectedEntries(result);
  if (pending.length >= 2 && hasDivergentCommandNotes(pending)) {
    // Two or more entries name visibly different commands — a single
    // re-run's exit code cannot speak for all of them. Refuse to apply in
    // bulk and surface for a human instead of guessing which entry to trust.
    return { verdict: 'ambiguous-multi-command', command: '', exit_code: null, entries: pending.length };
  }
  const argv = resolveVerifyCommand(codeDir);
  const outcome = argv
    ? runVerification({ argv, codeDir, timeoutMs })
    : { verdict: 'no-command', command: '', exit_code: null };
  outcome.entries = affectedEntries(result).length;
  if (apply) applyVerdict(result, outcome);
  return outcome;
}

function usage() {
  return 'Usage: node scripts/forge-reverify.js --result <file> --code-dir <dir> [--apply] [--mode auto|off] [--timeout-ms N] [--json]\n';
}

function runCli(args) {
  let resultPath = null;
  let codeDir = null;
  let apply = false;
  let mode = 'auto';
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--result' && args[i + 1]) resultPath = args[++i];
    else if (args[i] === '--code-dir' && args[i + 1]) codeDir = args[++i];
    else if (args[i] === '--mode' && args[i + 1]) mode = args[++i];
    else if (args[i] === '--timeout-ms' && args[i + 1]) timeoutMs = Number(args[++i]);
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--json') { /* JSON is always the machine output. */ }
    else if (args[i] === '--help') { process.stdout.write(usage()); return 0; }
    else { process.stderr.write(usage()); return 2; }
  }
  if (!resultPath || !codeDir || !['auto', 'off'].includes(mode) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(usage());
    return 2;
  }
  try {
    const absoluteResult = path.resolve(resultPath);
    const result = JSON.parse(fs.readFileSync(absoluteResult, 'utf8'));
    const outcome = reverify({ result, codeDir: path.resolve(codeDir), mode, timeoutMs, apply });
    if (apply && ['verified', 'failed'].includes(outcome.verdict)) {
      // Atomic (temp + rename) so a kill mid-write never leaves the result
      // file truncated for the next JSON.parse consumer.
      writeJsonAtomic(absoluteResult, result);
    }
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));

module.exports = {
  needsReverification, resolveVerifyCommand, runVerification, applyVerdict, reverify, runCli,
  // Exported for the platform-routing regression guard only.
  spawnPlan, resolveExecutable,
};
