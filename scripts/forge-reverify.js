#!/usr/bin/env node
'use strict';

// forge-reverify.js — deterministic orchestrator-side environment re-verification.
// Formula-once rule: this helper alone owns the trigger and command-resolution
// rules. Since TASK-020 every unmet environment reason is covered: an
// unverified must-have remains unverified regardless of its stated excuse.
// This supersedes the former sandbox-exec-blocked-only trigger.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolvePackageManager } = require('./forge-isolation.js');
const { writeJsonAtomic } = require('./forge-surgical-reset.js');
const { extractRunnerTokens } = require('./forge-env-promote.js');

const DEFAULT_TIMEOUT_MS = 600000;

function isEnvironmentUnmet(entry) {
  return Boolean(entry && entry.status !== 'met' && entry.scope === 'environment');
}

// gsd-write-refused alleges that a .gsd/** artifact write was refused — only
// the orchestrator writes .gsd/**, and the only evidence for that claim is
// fs.existsSync + content, never a project test suite's exit code. Running
// the project's verify command proves nothing about a .gsd/** write, so this
// reason is excluded from the reverifiable set (TASK-020 review R1).
function isReverifiable(entry) {
  return isEnvironmentUnmet(entry) && entry.reason !== 'gsd-write-refused';
}

function needsReverification(result) {
  return Boolean(result && Array.isArray(result.must_haves_status)
    && result.must_haves_status.some(isReverifiable));
}

function readText(filename) {
  try { return fs.readFileSync(filename, 'utf8'); } catch { return null; }
}

function resolveVerifyCommand(codeDir, gsdDir = path.join(codeDir, '.gsd')) {
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
  const standards = readText(path.join(gsdDir, 'CODING-STANDARDS.md'));
  if (!standards) return null;
  const header = standards.match(/^## Lint & Format Commands[ \t]*$/m);
  if (!header || typeof header.index !== 'number') return null;
  const section = standards.slice(header.index + header[0].length).split(/^## /m)[0];
  const testLine = section.match(/^- \*\*Test:\*\*[ \t]*(.+)$/m);
  if (!testLine || testLine[1].trim() === '(none detected)') return null;
  const commands = [...testLine[1].matchAll(/`([^`]+)`/g)].map(match => match[1]);
  // spawn runs with shell:false, so only commands tokenizable by a lossless
  // space-split may pass; anything needing shell parsing (quotes, escapes,
  // metacharacters) falls to null (no-command) — the pre-existing safe default.
  const safe = commands.find(command => !/["'\\*?|&;><$(]/.test(command));
  return safe ? safe.trim().split(/[ \t]+/).filter(Boolean) : null;
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
    args: ['/d', '/s', '/c', `call ${line}`],
    options: { windowsVerbatimArguments: true },
  };
}

// ── Resource wiring (S04/T03) ────────────────────────────────────────────
//
// `forge-reverify.js` is a THIN consumer (D10) of `forge-resources.js` /
// `forge-command-rewrite.js` — it derives ZERO worker/heap/ceiling numbers
// itself. Mirrors `forge-verify.js`'s `acquireClampForCommand` (S04/T02) and
// `forge-hook.js:731-838`'s S03 command-rewrite branch: lazy require, W5
// release-on-every-path, MEM008 fail-open when the resources/rewrite module
// is missing or throws — the spawn then runs exactly as it did before this
// wiring existed.
//
// Unlike T02's string consumer, `runVerification` spawns with `shell:false`
// and an explicit argv array — `planRewriteArgv` (T01) is the ONLY place
// that may split a `NAME=value` assignment out of argv into `env`. This
// function never re-implements that split, and never places an assignment
// token back into argv (that is precisely the hazard T01 exists to close:
// `shell:false` would execute `NAME=value` as the binary name).
//
// Best-effort event append for the resource-clamp wiring — mirrors
// `forge-verify.js`'s `appendResourceEvent`. Silent-fail (MEM008): event
// logging never affects the verdict.
function appendReverifyResourceEvent(codeDir, gsdDirOpt, kind, payload) {
  try {
    const codeDirAbs = path.resolve(codeDir);
    const ownerGsd = gsdDirOpt ? path.resolve(gsdDirOpt) : path.join(codeDirAbs, '.gsd');
    const eventsDir = path.join(ownerGsd, 'forge');
    fs.mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload });
    fs.appendFileSync(path.join(eventsDir, 'events.jsonl'), line + '\n', 'utf8');
  } catch { /* MEM008 — silent-fail */ }
}

/**
 * Attempt to acquire a resource-pool lease and a rewritten argv for one
 * re-verification command. Returns byte-identical passthrough (same argv
 * reference, no env override beyond the NODE_OPTIONS overlay) on every
 * failure mode (module missing, module throws, non-runner argv, unrecognized
 * runner form, unsafe token) — never throws.
 *
 * @returns {{ argv: string[], env: object|null, handle: object|null, resourcesMod: object|null }}
 */
function acquireReverifyClamp(argv, opts) {
  const passthrough = { argv, env: null, handle: null, resourcesMod: null };
  let resourcesMod;
  try {
    resourcesMod = typeof opts.requireResources === 'function'
      ? opts.requireResources() : require('./forge-resources.js');
    if (!resourcesMod || typeof resourcesMod.acquireCommandBudget !== 'function' ||
        typeof resourcesMod.releaseCommandBudget !== 'function') {
      throw new Error('forge-resources.js missing acquireCommandBudget/releaseCommandBudget');
    }
  } catch {
    return passthrough;
  }
  let rewriteMod;
  try {
    rewriteMod = typeof opts.requireCommandRewrite === 'function'
      ? opts.requireCommandRewrite() : require('./forge-command-rewrite.js');
    if (!rewriteMod || typeof rewriteMod.planRewriteArgv !== 'function') {
      throw new Error('forge-command-rewrite.js missing planRewriteArgv');
    }
  } catch {
    return passthrough;
  }

  let handle = null;
  try {
    const contract = resourcesMod.acquireCommandBudget({
      cwd: opts.codeDir,
      commandTimeoutMs: opts.timeoutMs,
      session: opts.session,
    });
    if (contract && contract.pool && contract.pool.handle &&
        Array.isArray(contract.pool.handle.slots) && contract.pool.handle.slots.length) {
      handle = contract.pool.handle;
    }

    if (contract && contract.enforcement === 'off') {
      // `resources.enforcement: off` (S06/T03) — same bypass as
      // forge-verify.js. Placed BEFORE the NODE_OPTIONS overlay is computed
      // so `off` yields the full passthrough: argv byte-identical AND no
      // heap NODE_OPTIONS injected (env stays null, the spawn inherits the
      // parent environment untouched). FAIL-SAFE: only the exact string
      // `off` bypasses. D10: reads, never derives.
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.codeDir }); } catch { /* MEM008 */ }
      }
      appendReverifyResourceEvent(opts.codeDir, opts.gsdDir, 'resource-clamp-skipped', {
        reason: 'intact:enforcement-off',
      });
      return passthrough;
    }

    // NODE_OPTIONS overlay from the contract's heapMb — never overwrites a
    // parent-defined NODE_OPTIONS (a human's choice always wins, same rule
    // T02 uses). Applies on BOTH outcomes below — T03-PLAN step 2d: env is
    // still explicit on the intact path too, only argv stays untouched.
    const overlay = {};
    let nodeOptionsReason = null;
    if (process.env.NODE_OPTIONS) {
      nodeOptionsReason = 'node-options-preserved-parent-defined';
    } else if (contract && Number.isFinite(contract.heapMb)) {
      overlay.NODE_OPTIONS = `--max-old-space-size=${contract.heapMb}`;
    }

    if (contract && contract.admit === false) {
      // Critical pressure: admission refused. D3 is LOCKED — never refuse
      // the spawn. Skip the rewrite entirely and run argv byte-identical
      // rather than hand a zero-worker contract to the planner.
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.codeDir }); } catch { /* MEM008 */ }
      }
      appendReverifyResourceEvent(opts.codeDir, opts.gsdDir, 'resource-clamp-skipped', {
        reason: 'intact:admission-refused-advisory',
      });
      return { argv, env: { ...process.env, ...overlay }, handle: null, resourcesMod: null };
    }

    const plan = rewriteMod.planRewriteArgv(argv, contract, { cwd: opts.codeDir });

    if (plan.outcome !== 'rewritten') {
      // W5 (non-error intact path): release immediately, argv byte-identical.
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.codeDir }); } catch { /* MEM008 */ }
      }
      appendReverifyResourceEvent(opts.codeDir, opts.gsdDir, 'resource-clamp-skipped', {
        reason: `intact:${plan.reason}`,
      });
      return { argv, env: { ...process.env, ...overlay }, handle: null, resourcesMod: null };
    }

    // `plan.env` holds the NAME=value assignments the adapter split out of
    // argv (e.g. vitest's NODE_OPTIONS/VITEST_MAX_FORKS) — never re-merged
    // into argv. A parent-defined NODE_OPTIONS still wins even when the
    // rewrite embedded its own value.
    const env = { ...process.env, ...plan.env, ...overlay };
    if (nodeOptionsReason) env.NODE_OPTIONS = process.env.NODE_OPTIONS;

    appendReverifyResourceEvent(opts.codeDir, opts.gsdDir, 'resource-clamp-applied', {
      reason: plan.reason,
      runner: plan.runner,
      workers: contract.workers,
      ...(nodeOptionsReason ? { node_options_reason: nodeOptionsReason } : {}),
    });

    return { argv: plan.argv, env, handle, resourcesMod };
  } catch {
    // W5: release-on-error — a lease acquired above MUST be released here
    // before falling through with the argv byte-identical.
    if (handle) {
      try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.codeDir }); } catch { /* MEM008 */ }
    }
    return passthrough;
  }
}

function releaseReverifyClamp(clamp, codeDir) {
  if (clamp && clamp.handle && clamp.resourcesMod &&
      typeof clamp.resourcesMod.releaseCommandBudget === 'function') {
    try { clamp.resourcesMod.releaseCommandBudget(clamp.handle, { cwd: codeDir }); } catch { /* MEM008 */ }
  }
}

function runVerification({ argv, codeDir, timeoutMs, gsdDir, session, requireResources, requireCommandRewrite, spawnPlanFn }) {
  if (!Array.isArray(argv) || !argv.length) return { verdict: 'no-command', command: '', exit_code: null };
  // `spawnPlanFn` is a test-only injection seam (S04 review R5) — production
  // callers never pass it, so `spawnPlan` (POSIX: never null; win32: null
  // when the executable can't be resolved) is unchanged for every real
  // invocation. It exists solely so the `spawnPlan === null` leg of the
  // verdict table is provable on any host, not just win32.
  const plan = typeof spawnPlanFn === 'function' ? spawnPlanFn : spawnPlan;
  const originalPlanned = plan(argv);
  if (!originalPlanned) return { verdict: 'no-command', command: commandText(argv), exit_code: null };

  // MEM008: any throw anywhere in the clamp path degrades to the exact
  // pre-wiring argv/spawn, never propagates.
  let clamp;
  try {
    clamp = acquireReverifyClamp(argv, { codeDir, timeoutMs, gsdDir, session, requireResources, requireCommandRewrite });
  } catch {
    clamp = { argv, env: null, handle: null, resourcesMod: null };
  }

  // Windows `.cmd`/`windowsVerbatimArguments` routing must be derived from
  // the FINAL argv — a rewritten argv (e.g. jest's appended
  // `--maxWorkers=N`) recomputes spawnPlan; an intact argv (same reference)
  // reuses the plan already validated above, so that path stays exactly
  // byte-identical to before this wiring.
  const rewrote = clamp.argv !== argv;
  const planned = rewrote ? plan(clamp.argv) : originalPlanned;
  if (!planned) {
    releaseReverifyClamp(clamp, codeDir); // W5
    return { verdict: 'no-command', command: commandText(argv), exit_code: null };
  }

  let run;
  try {
    run = spawnSync(planned.file, planned.args, {
      cwd: codeDir,
      encoding: 'utf8',
      shell: false,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...planned.options,
      ...(clamp.env ? { env: clamp.env } : {}),
    });
  } finally {
    // W5: released on every exit of the spawn — verified, failed, ENOENT,
    // ETIMEDOUT, or an exception unwinding through this try.
    releaseReverifyClamp(clamp, codeDir);
  }
  const base = { command: commandText(argv), exit_code: typeof run.status === 'number' ? run.status : null };
  if (run.error && (run.error.code === 'ENOENT' || run.error.code === 'ETIMEDOUT')) {
    return { ...base, verdict: 'no-command' };
  }
  if (run.status === 0 && !run.error) return { ...base, verdict: 'verified' };
  return { ...base, verdict: 'failed', tail: outputTail(run) };
}

// Keep this selector separate from applyVerdict: it is evaluated before any
// mutation so an entry is never selected merely because a prior mutation made
// it task-scoped. Since TASK-020 it covers every environment reason: an
// unverified must-have is unverified regardless of its stated excuse.
function affectedEntries(result) {
  return Array.isArray(result && result.must_haves_status) ? result.must_haves_status.filter(isReverifiable) : [];
}

// Refusal gate only — NEVER used to pick which command to run, nor to map an
// entry to a command. The single command re-verified always comes from
// resolveVerifyCommand (project-derived), never from must-have prose. This
// helper's only job is to say "these notes look like different commands, so
// don't blanket-apply one verdict to every entry" and let a human sort it out.
//
// 2026-08-06 (I-20260729180247-hasdivergentcommandnotes, TASK-020 review R1):
// an entry whose note names NO runner token at all used to be filtered out of
// the comparison (`.filter(tokens => tokens.length > 0)`) before the pairwise
// disjoint check ran. A token-less note describes no command, so a single
// re-run's exit code is not evidence about it either way — dropping it from
// the gate silently granted the bulk verdict to exactly the entry least able
// to support it (the TASK-020 class — "environment from the sidecar is never
// evidence" — one level up, applied to the gate itself instead of the
// corroborator). Now: if ANY entry's token set is empty, gate unconditionally
// (return true) before the pairwise comparison ever runs. Restoring the old
// `.filter(...)` would silently re-admit that entry into a bulk verdict it
// never spoke to.
function hasDivergentCommandNotes(entries) {
  if (entries.length < 2) return false;
  const tokenSets = entries.map(entry => extractRunnerTokens(typeof entry.note === 'string' ? entry.note : ''));
  if (tokenSets.some(tokens => tokens.length === 0)) return true;
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
function reverify({ result, codeDir, gsdDir, mode = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS, apply = false }) {
  if (mode === 'off') return { verdict: 'disabled', command: '', exit_code: null, entries: 0 };
  if (!needsReverification(result)) return { verdict: 'not-applicable', command: '', exit_code: null, entries: 0 };
  const pending = affectedEntries(result);
  if (pending.length >= 2 && hasDivergentCommandNotes(pending)) {
    // Two or more entries name visibly different commands — a single
    // re-run's exit code cannot speak for all of them. Refuse to apply in
    // bulk and surface for a human instead of guessing which entry to trust.
    return { verdict: 'ambiguous-multi-command', command: '', exit_code: null, entries: pending.length };
  }
  const argv = resolveVerifyCommand(codeDir, gsdDir);
  const outcome = argv
    ? runVerification({ argv, codeDir, timeoutMs, gsdDir })
    : { verdict: 'no-command', command: '', exit_code: null };
  outcome.entries = affectedEntries(result).length;
  if (apply) applyVerdict(result, outcome);
  return outcome;
}

function usage() {
  return 'Usage: node scripts/forge-reverify.js --result <file> --code-dir <dir> [--gsd-dir <dir>] [--apply] [--mode auto|off] [--timeout-ms N] [--json]\n';
}

function runCli(args) {
  let resultPath = null;
  let codeDir = null;
  let gsdDir = null;
  let apply = false;
  let mode = 'auto';
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--result' && args[i + 1]) resultPath = args[++i];
    else if (args[i] === '--code-dir' && args[i + 1]) codeDir = args[++i];
    else if (args[i] === '--gsd-dir' && args[i + 1]) gsdDir = args[++i];
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
    const outcome = reverify({ result, codeDir: path.resolve(codeDir), gsdDir: gsdDir ? path.resolve(gsdDir) : undefined, mode, timeoutMs, apply });
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
  isEnvironmentUnmet, isReverifiable, needsReverification, resolveVerifyCommand, runVerification, applyVerdict, reverify, runCli,
  hasDivergentCommandNotes,
  // Exported for the platform-routing regression guard only.
  spawnPlan, resolveExecutable,
  // Exported for the resource-clamp test suite (S04/T03) only.
  acquireReverifyClamp, releaseReverifyClamp,
};
