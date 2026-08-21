#!/usr/bin/env node
/**
 * forge-resources-bench.js
 *
 * The INSTRUMENT for S06/T06 — not the measurement. Builds the four-cell
 * matrix (solo/batch x controle off/on) with configurable repetitions, an
 * in-cell WITNESS of the resource control actually in effect (never the
 * requested state — see forge-resources-enforcement.test.js and D9), and
 * incremental JSONL so a run interrupted by the 10-minute Bash ceiling (A4)
 * leaves every already-finished corrida on disk.
 *
 * D5 (hard boundary, inherited): this harness only times. It signals ONLY
 * processes it itself created and THEIR descendants — each child is spawned
 * as a process-group leader (`detached`) and reaped with a group kill, so an
 * in-flight grandchild cannot survive as an orphan and contaminate later
 * cells. It never signals a process it did not spawn.
 *
 * Execution-side evidence (S06 review, R2): the measured corrida is routed
 * through the REAL enforcement entrypoint (`forge-reverify.js`'s
 * `acquireReverifyClamp` — the production consumer of `acquireCommandBudget`
 * + `planRewriteArgv`) and the child preloads
 * `forge-resources-bench-dump.js`, which writes argv/NODE_OPTIONS/heap
 * ceiling FROM INSIDE the child. A cell is reported as enforced only when
 * that child-written line corroborates it; every other outcome carries a
 * named `unapplied:*` reason and an `/on` cell with zero corroborated
 * corridas summarizes as `inconclusive:enforcement-unapplied:<reason>`.
 *
 * D10: sizing/enforcement resolution is never reimplemented here. The
 * witness is collected by requiring `forge-doctor.js`'s `checkResources`,
 * which itself defers to `forge-resources.js`'s `resolveResourceBudget` —
 * this module owns none of that logic (see also `readResourcePrefs` in
 * forge-resources.js:206, and `checkResources` in forge-doctor.js:474).
 *
 * Cells: `solo/off`, `solo/on`, `batch/off`, `batch/on`. `off` writes
 * `resources.enforcement: 'off'` to the project-local preference layer
 * (`.gsd/forge-prefs.jsonc` — see forge-home.js:134 `resolvePreferencePaths`
 * `.local.jsoncPath`, and forge-resources-enforcement.test.js's
 * `workspaceWith()` fixture, which writes the exact same file). `on` writes
 * `clamp`. Repetitions are INTERLEAVED across cells (round-robin), not
 * blocked, so machine drift over a long run distributes instead of
 * concentrating in one cell (S06-PLAN.md "Desenho exigido").
 *
 * Anti-silence floor (precedent: forge-overlap.js, S05): a cell with zero
 * `ok` corridas summarizes as `inconclusive:<reason>`, NEVER `clean` and
 * NEVER silently absent from the table. An `aborted:<reason>` corrida stays
 * in the JSONL and in the per-cell count, but is excluded from the
 * median/min/max (a timed-out run is not a measurement of the thing under
 * test).
 *
 * Prefs restoration (must-have, non-negotiable): every corrida this module
 * runs may have rewritten the project-local prefs file. The ORIGINAL bytes
 * (or absence) are snapshotted once before the first write and restored on
 * every exit path — normal completion, thrown exception, SIGINT, SIGTERM —
 * via a single idempotent `doRestore()` guarded by a `restored` flag so a
 * signal arriving during the `finally` block cannot double-write.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const CELLS = ['solo/off', 'solo/on', 'batch/off', 'batch/on'];
const DEFAULT_COMMAND = 'node scripts/run-tests.js';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_REPS = 3;
const MIN_REPS = 3;
const DEFAULT_COMPETITORS = 2;

// ── Local prefs file (project-local layer, same file the operator edits —
// same path the enforcement suite fixtures write) ──────────────────────────
function localPrefsPath(cwd) {
  return path.join(cwd, '.gsd', 'forge-prefs.jsonc');
}

function cellEnforcement(cell) {
  return cell.endsWith('/off') ? 'off' : 'clamp';
}

function snapshotPrefsFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return { existed: true, content };
  } catch {
    return { existed: false, content: null };
  }
}

function restorePrefsFile(filePath, snapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, snapshot.content);
  } else {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

// Surgically update ONLY `resources.enforcement`, preserving every other
// namespace already in the operator's local prefs file. That file is the
// project-local layer of the standard cascade and legally carries full JSONC
// (comments, trailing commas) plus unrelated blocks such as
// `forge_isolation` — so it is read with the SAME JSONC-tolerant parser the
// resolvers use (`forge-prefs.js#parseJsonc`), never `JSON.parse`.
//
// R1 (S06 review): the previous `JSON.parse` + `catch { base = {} }` threw on
// any real JSONC and then REPLACED the document with a file containing only
// `resources.enforcement` — it destroyed the operator's `forge_isolation`
// block in T06's live run. Unparseable input now ABORTS before any write:
// refusing to proceed is the only safe posture, because "start fresh" here
// means "delete the operator's configuration".
function writeEnforcement(filePath, value) {
  let base = {};
  let raw = null;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { raw = null; }
  if (raw !== null && raw.trim() !== '') {
    const { parseJsonc } = require('./forge-prefs.js');
    const parsed = parseJsonc(raw);
    if (!parsed.ok) {
      const err = parsed.error || {};
      throw new Error(
        `forge-resources-bench: recusa escrever ${filePath} — JSONC não parseável`
        + `${err.line ? ` (linha ${err.line})` : ''}: ${err.message || 'erro desconhecido'}.`
        + ' Nada foi modificado.',
      );
    }
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      throw new Error(
        `forge-resources-bench: recusa escrever ${filePath} — o documento não é um objeto JSON. Nada foi modificado.`,
      );
    }
    base = parsed.value;
  }
  base.resources = Object.assign({}, base.resources, { enforcement: value });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
}

// ── Command parsing (shell:false, MEM004 — no shell-string parsing) ───────
// `--command` accepts either a JSON array of argv tokens (unambiguous, the
// only supported form for arguments containing spaces/quotes) or a bare
// whitespace-split string (sufficient for the default `node
// scripts/run-tests.js`).
function parseCommand(raw) {
  const trimmed = String(raw || DEFAULT_COMMAND).trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || arr.some((t) => typeof t !== 'string')) {
      throw new Error('--command JSON array must contain only strings');
    }
    return arr;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

// ── Witness (D9 — collected fresh, in-cell, never assumed) ────────────────
function collectWitness(cwd) {
  // Lazy require: keeps `parseCommand`/`median` etc. testable without the
  // doctor module's heavier dependency graph loading on every import.
  const { checkResources } = require('./forge-doctor.js');
  const r = checkResources(cwd, {});
  if (r.skipped) {
    return { ok: false, skipped: r.skipped };
  }
  return {
    ok: true,
    verdict: r.verdict,
    pool: r.pool,
    census: r.census,
  };
}

// checkResources() does not surface the raw contract fields (enforcement,
// workers, heapMb) directly — it folds them into a formatted `message`
// string plus a census verdict. The witness this module's must-haves
// require (enforcement/workers/heapMb/aggregate/RAM) needs the contract
// itself, so this reads it the same way checkResources does — via the same
// resolver, never reimplemented (D10) — and augments with the aggregate.
function collectContractWitness(cwd) {
  const { resolveResourceBudget } = require('./forge-resources.js');
  const contract = resolveResourceBudget({ cwd, noEvents: true });
  const totalMb = Math.round(require('os').totalmem() / (1024 * 1024));
  return {
    enforcement: contract.enforcement,
    workers: contract.workers,
    heapMb: contract.heapMb,
    aggregateMb: contract.workers * contract.heapMb,
    totalMb,
    pressureLevel: contract.pressureLevel,
    reason: contract.reason,
    source: contract.source,
  };
}

// ── Process-group cleanup (R3) ────────────────────────────────────────────
// Every process this harness spawns is made a group leader (`detached`), so
// killing `-pid` reaps the whole subtree. Without this, SIGKILL on the
// immediate PID reparents any in-flight grandchild to PID 1, where it keeps
// burning CPU into subsequent interleaved cells and past harness exit (23
// such orphans were measured on this machine at load average 55.77).
//
// D5 is NOT weakened: these are descendants of processes this module itself
// created. It still never signals a process it did not spawn.
const liveChildren = new Set();
const ownedChildState = new WeakMap();
const TASKKILL_TIMEOUT_MS = 5000;
const CHILD_EXIT_CONFIRM_MS = 250;

function hasOwnedChildExited(child) {
  const state = ownedChildState.get(child);
  return Boolean(
    (state && state.exited)
    || typeof child.exitCode === 'number'
    || (child.signalCode !== undefined && child.signalCode !== null),
  );
}

function confirmOwnedChildExited(child, timeoutMs = CHILD_EXIT_CONFIRM_MS) {
  if (hasOwnedChildExited(child)) return Promise.resolve(true);
  if (typeof child.once !== 'function' || typeof child.removeListener !== 'function') {
    return new Promise((resolve) => {
      setTimeout(() => resolve(hasOwnedChildExited(child)), timeoutMs);
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(exited || hasOwnedChildExited(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

function killTree(child, options = {}) {
  if (!child || typeof child.pid !== 'number') return { ok: true, skipped: true };
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const reportDegraded = options.reportDegraded || ((reason) => {
    process.stderr.write(`forge-resources-bench: cleanup-tree-degraded pid=${child.pid} reason=${reason}\n`);
  });
  try {
    if (platform === 'win32') {
      const result = spawnSyncImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: TASKKILL_TIMEOUT_MS,
      });
      if (result.error || result.status !== 0) {
        const reason = result.error && result.error.code ? result.error.code : `exit-${result.status}`;
        reportDegraded(reason);
        child.kill('SIGKILL');
        return { ok: false, degraded: true, reason };
      }
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
    return { ok: true };
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    return { ok: false, degraded: true, reason: 'exception' };
  }
}

function killAllLive() {
  for (const child of Array.from(liveChildren)) killTree(child);
  liveChildren.clear();
}

function killTreeAsync(child, options = {}) {
  if (!child || typeof child.pid !== 'number') return Promise.resolve({ ok: true, skipped: true });
  if ((options.platform || process.platform) !== 'win32') return Promise.resolve(killTree(child, options));
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || TASKKILL_TIMEOUT_MS;
  const reportDegraded = options.reportDegraded || ((reason) => {
    process.stderr.write(`forge-resources-bench: cleanup-tree-degraded pid=${child.pid} reason=${reason}\n`);
  });
  return new Promise((resolve) => {
    let settled = false;
    let resolutionStarted = false;
    let killer;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fallback = (reason) => {
      reportDegraded(reason);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, degraded: true, reason });
    };
    const resolveNonSuccess = async (reason) => {
      if (resolutionStarted || settled) return;
      resolutionStarted = true;
      if (reason === 'exit-128' && await confirmOwnedChildExited(child, options.exitConfirmMs)) {
        finish({ ok: true, alreadyExited: true, taskkillReason: reason });
        return;
      }
      fallback(reason);
    };
    try {
      killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      resolveNonSuccess('spawn-exception');
      return;
    }
    timer = setTimeout(() => {
      try { killer.kill(); } catch { /* already gone */ }
      resolveNonSuccess('timeout');
    }, timeoutMs);
    killer.once('error', (error) => resolveNonSuccess(error.code || 'spawn-error'));
    killer.once('close', (code) => {
      if (code === 0) finish({ ok: true });
      else resolveNonSuccess(`exit-${code}`);
    });
  });
}

async function killAllLiveAsync(options = {}) {
  const children = Array.from(liveChildren);
  liveChildren.clear();
  const results = await Promise.all(children.map((child) => killTreeAsync(child, options)));
  const degraded = results.filter((result) => !result || result.ok === false);
  if (degraded.length > 0) {
    const reasons = degraded.map((result) => (result && result.reason) || 'unknown');
    const error = new Error(`cleanup-degraded:${reasons.join(',')}`);
    error.code = 'CLEANUP_DEGRADED';
    error.results = results;
    throw error;
  }
  return { ok: true, results };
}

function createSpawnFence() {
  return { closed: false, reason: null };
}

function closeSpawnFence(fence, reason) {
  fence.closed = true;
  fence.reason = reason;
}

async function completeSignalShutdown({
  signal, cancellationFence, restore, cleanup, exit, writeDiagnostic,
}) {
  closeSpawnFence(cancellationFence, `signal:${signal}`);
  restore();
  let cleanupError = null;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  const finalRestore = restore(true);
  if (!finalRestore.ok) {
    writeDiagnostic(`final-restore-failed:${finalRestore.error.message}`);
    exit(74);
    return;
  }
  if (cleanupError) {
    writeDiagnostic(`signal-cleanup-failed:${cleanupError.message}`);
    exit(75);
    return;
  }
  exit(signal === 'SIGINT' ? 130 : 143);
}

function assertRestoration(runError, restoration) {
  if (restoration.ok) return;
  if (runError) {
    throw new AggregateError(
      [runError, restoration.error],
      `benchmark failed and preferences could not be restored: ${restoration.error.message}`,
      { cause: runError },
    );
  }
  throw restoration.error;
}

// Spawn one child in its own process group, resolving with a classified
// outcome. Async (never `spawnSync`) for two reasons: the event loop stays
// free so the SIGINT/SIGTERM prefs-restore handlers actually run mid-corrida
// (R1's signal-path hole — `spawnSync` blocked them until the child exited),
// and the group-kill path is shared with the competitors.
function spawnTracked(cmd, args, {
  cwd, timeoutMs, env, cancellationFence = null, spawnImpl = spawn, cleanupOptions = {},
}) {
  if (cancellationFence && cancellationFence.closed) {
    return Promise.resolve({
      wallMs: 0, exitCode: null, signal: 'spawn-fenced', timedOut: false,
      error: cancellationFence.reason || 'cancelled',
    });
  }
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let timedOut = false;
    let operationalCleanupStarted = false;
    let child;
    try {
      child = spawnImpl(cmd, args, {
        cwd,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
        ...(env ? { env } : {}),
      });
    } catch (e) {
      resolve({ wallMs: 0, exitCode: null, signal: 'spawn-error', timedOut: false, error: e.message });
      return;
    }
    liveChildren.add(child);
    const childState = { exited: false };
    ownedChildState.set(child, childState);
    const killer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (payload, untrack = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (untrack) liveChildren.delete(child);
      resolve({ wallMs: Date.now() - start, timedOut, ...payload });
    };
    const observeExit = (payload) => {
      childState.exited = true;
      if (operationalCleanupStarted) return;
      liveChildren.delete(child);
      finish(payload);
    };
    child.on('exit', (code, signal) => observeExit({ exitCode: code, signal: signal || null }));
    child.on('close', (code, signal) => observeExit({ exitCode: code, signal: signal || null }));
    child.on('error', async (e) => {
      const ownsProcess = typeof child.pid === 'number';
      if (!ownsProcess) {
        finish({ exitCode: null, signal: 'spawn-error', error: e.message, cleanupPending: false }, true);
        return;
      }
      if (operationalCleanupStarted || settled) return;
      operationalCleanupStarted = true;
      clearTimeout(killer);
      let cleanup;
      try {
        cleanup = await killTreeAsync(child, cleanupOptions);
      } catch (cleanupError) {
        cleanup = { ok: false, degraded: true, reason: cleanupError.code || cleanupError.message || 'exception' };
      }
      finish({
        exitCode: null,
        signal: 'spawn-error',
        error: e.message,
        cleanup,
        cleanupPending: !cleanup.ok,
      }, cleanup.ok);
    });
  });
}

async function runChild(cmd, args, cwd, timeoutMs, opts = {}) {
  const r = await spawnTracked(cmd, args, {
    cwd, timeoutMs, env: opts.env, cancellationFence: opts.cancellationFence,
  });
  if (r.signal === 'spawn-fenced') return { wallMs: 0, exitCode: null, status: 'aborted:signal-cancelled' };
  if (r.timedOut) return { wallMs: r.wallMs, exitCode: null, status: 'aborted:timeout-exceeded' };
  if (r.signal === 'spawn-error') return { wallMs: r.wallMs, exitCode: null, status: 'aborted:spawn-error' };
  if (r.signal) return { wallMs: r.wallMs, exitCode: null, status: `aborted:killed-${r.signal}` };
  if (r.exitCode === 0) return { wallMs: r.wallMs, exitCode: 0, status: 'ok' };
  return { wallMs: r.wallMs, exitCode: r.exitCode, status: `aborted:non-zero-exit-${r.exitCode}` };
}

// Competitors are fire-and-forget context (S06-PLAN.md: "o wall-clock dos
// competidores é registrado como contexto, não como o número"). They are
// spawned async, never synchronously blocking the measured corrida's start.
async function spawnCompetitor(cmd, args, cwd, timeoutMs, cancellationFence = null) {
  const r = await spawnTracked(cmd, args, { cwd, timeoutMs, cancellationFence });
  return { wallMs: r.wallMs, exitCode: r.exitCode, signal: r.signal || null };
}

// ── Enforcement wiring (R2) ───────────────────────────────────────────────
// The measured child is routed through the REAL enforcement entrypoint —
// `forge-reverify.js#acquireReverifyClamp`, which is the production consumer
// of `acquireCommandBudget` + `planRewriteArgv` — instead of being spawned
// raw. Nothing about sizing, rewriting or leasing is reimplemented here
// (D10); this module only calls the consumer and then asks the CHILD what it
// received.
const DUMP_MODULE = path.join(__dirname, 'forge-resources-bench-dump.js');
const PARENT_NODE_OPTIONS = process.env.NODE_OPTIONS || null;

// Frozen enum — a cell is only ever reported as enforced under an `applied:*`
// reason, and every other outcome is NAMED rather than silently labelled by
// the cell's requested state.
const ENFORCEMENT_REASONS = Object.freeze({
  APPLIED_HEAP: 'applied:heap-clamped',
  APPLIED_RUNNER: 'applied:runner-flags',
  APPLIED_BOTH: 'applied:heap-and-runner-flags',
  OFF: 'unapplied:enforcement-off',
  PARENT_NODE_OPTIONS: 'unapplied:node-options-parent-defined',
  NO_DUMP_PATH: 'unapplied:no-child-dump:dump-path-unsafe',
  NO_DUMP_CHILD: 'unapplied:no-child-dump:child-wrote-nothing',
  UNKNOWN: 'unapplied:unknown',
});

function acquireClamp(argv, cwd, timeoutMs) {
  try {
    const { acquireReverifyClamp, releaseReverifyClamp } = require('./forge-reverify.js');
    const clamp = acquireReverifyClamp(argv, {
      codeDir: cwd,
      timeoutMs,
      gsdDir: path.join(cwd, '.gsd'),
    });
    return { clamp, release: () => { try { releaseReverifyClamp(clamp, cwd); } catch { /* MEM008 */ } } };
  } catch {
    return { clamp: { argv, env: null, handle: null, resourcesMod: null }, release: () => {} };
  }
}

// `NODE_OPTIONS` is space-separated and unquotable in practice, so a path
// containing whitespace cannot carry the preload — that refuses with a named
// reason instead of pretending the child was observed.
function withDumpPreload(env, dumpFile) {
  if (/\s/.test(dumpFile) || /\s/.test(DUMP_MODULE)) {
    return { env, disabledReason: ENFORCEMENT_REASONS.NO_DUMP_PATH };
  }
  const base = env ? { ...env } : { ...process.env };
  base.NODE_OPTIONS = `${base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ` : ''}--require ${DUMP_MODULE}`;
  base.FORGE_BENCH_DUMP = dumpFile;
  return { env: base, disabledReason: null };
}

// Decides `applied` from the CHILD's own dump line — never from the parent's
// intent. `probeReason` is the rewrite planner's own outcome code, used only
// to name WHY nothing was applied.
function evaluateEnforcement({
  cell, argvBefore, argvAfter, dumpRecords, disabledReason, probeReason,
}) {
  const requested = cellEnforcement(cell);
  const argvChanged = argvBefore.join('\0') !== argvAfter.join('\0');
  const base = { requested, argvChanged, childObserved: false, applied: false };

  if (disabledReason) return { ...base, reason: disabledReason };
  const first = (dumpRecords || [])[0];
  if (!first) return { ...base, reason: ENFORCEMENT_REASONS.NO_DUMP_CHILD };

  const heapMatch = /--max-old-space-size=(\d+)/.exec(first.nodeOptions || '');
  const childHeapMb = heapMatch ? Number(heapMatch[1]) : null;
  const injected = argvAfter.filter((t) => !argvBefore.includes(t));
  const childArgv = Array.isArray(first.argv) ? first.argv : [];
  const runnerApplied = argvChanged && injected.length > 0 && injected.every((t) => childArgv.includes(t));

  const observed = {
    ...base,
    childObserved: true,
    childHeapMb,
    childHeapLimitMb: first.heapLimitMb === undefined ? null : first.heapLimitMb,
    childPid: first.pid,
    injectedTokens: injected,
  };

  if (childHeapMb !== null && runnerApplied) return { ...observed, applied: true, reason: ENFORCEMENT_REASONS.APPLIED_BOTH };
  if (childHeapMb !== null) return { ...observed, applied: true, reason: ENFORCEMENT_REASONS.APPLIED_HEAP };
  if (runnerApplied) return { ...observed, applied: true, reason: ENFORCEMENT_REASONS.APPLIED_RUNNER };
  if (requested === 'off') return { ...observed, reason: ENFORCEMENT_REASONS.OFF };
  if (PARENT_NODE_OPTIONS) return { ...observed, reason: ENFORCEMENT_REASONS.PARENT_NODE_OPTIONS };
  return { ...observed, reason: probeReason ? `unapplied:${probeReason}` : ENFORCEMENT_REASONS.UNKNOWN };
}

async function runOneCorrida(opts) {
  const {
    cell, rep, command, cwd, timeoutMs, competitors, outFile, cancellationFence = null,
  } = opts;
  if (cancellationFence && cancellationFence.closed) return null;
  writeEnforcement(localPrefsPath(cwd), cellEnforcement(cell));

  const witness = collectContractWitness(cwd);

  const [cmd, ...args] = command;
  let competitorPromises = [];
  if (cell.startsWith('batch/') && competitors > 0) {
    competitorPromises = Array.from(
      { length: competitors },
      () => spawnCompetitor(cmd, args, cwd, timeoutMs, cancellationFence),
    );
  }

  // Route the measured workload through the real enforcement entrypoint and
  // give the child a way to testify about what it received.
  if (cancellationFence && cancellationFence.closed) return null;
  const { clamp, release } = acquireClamp(command, cwd, timeoutMs);
  const dumpFile = path.join(
    path.dirname(outFile),
    `.bench-dump-${cell.replace(/\//g, '-')}-${rep}-${process.pid}.jsonl`,
  );
  const { env, disabledReason } = withDumpPreload(clamp.env, dumpFile);

  let probeReason = null;
  try {
    const { planRewriteArgv } = require('./forge-command-rewrite.js');
    // Read-only probe over the SAME planner the clamp used — for the failure
    // reason only, never to decide what the child runs.
    const plan = planRewriteArgv(command, witness, { cwd });
    if (plan.outcome !== 'rewritten') probeReason = plan.reason;
  } catch { /* diagnostic only */ }

  let measured;
  try {
    const [runCmd, ...runArgs] = clamp.argv;
    measured = await runChild(runCmd, runArgs, cwd, timeoutMs, { env, cancellationFence });
  } finally {
    release();
  }

  const dumpRecords = readJsonlRecords(dumpFile);
  try { fs.unlinkSync(dumpFile); } catch { /* best effort */ }

  const enforcement = evaluateEnforcement({
    cell,
    argvBefore: command,
    argvAfter: clamp.argv,
    dumpRecords,
    disabledReason,
    probeReason,
  });

  const competitorResults = competitorPromises.length ? await Promise.all(competitorPromises) : undefined;

  const record = {
    cell,
    rep,
    ts: new Date().toISOString(),
    wallMs: measured.wallMs,
    exitCode: measured.exitCode,
    status: measured.status,
    witness,
    enforcement,
  };
  if (competitorResults) record.competitors = competitorResults;

  fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

// ── Planning ────────────────────────────────────────────────────────────
// Interleaved round-robin: for rep 1..n, one corrida per cell in order —
// never all reps of one cell back to back (S06-PLAN.md "intercale as
// células").
function planRuns(cells, reps) {
  const plan = [];
  for (let r = 1; r <= reps; r += 1) {
    for (const cell of cells) plan.push({ cell, rep: r });
  }
  return plan;
}

// ── Aggregation ─────────────────────────────────────────────────────────
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readJsonlRecords(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function summarizeRecords(records, cells) {
  const byCell = {};
  for (const cell of cells) byCell[cell] = [];
  for (const rec of records) {
    if (!byCell[rec.cell]) byCell[rec.cell] = [];
    byCell[rec.cell].push(rec);
  }

  const summary = {};
  for (const cell of Object.keys(byCell)) {
    const recs = byCell[cell];
    const ok = recs.filter((r) => r.status === 'ok').map((r) => r.wallMs).sort((a, b) => a - b);
    const aborted = recs.filter((r) => r.status !== 'ok');
    const lastWitness = recs.length ? recs[recs.length - 1].witness : null;

    if (ok.length === 0) {
      // Anti-silence floor: zero `ok` corridas is `inconclusive`, NEVER
      // `clean`, and the cell stays in the table (never omitted).
      summary[cell] = {
        n: recs.length,
        nOk: 0,
        median: null,
        min: null,
        max: null,
        aborted: aborted.map((r) => ({ rep: r.rep, status: r.status })),
        witness: lastWitness,
        verdict: recs.length === 0 ? 'inconclusive:no-data' : 'inconclusive:zero-ok-runs',
      };
      continue;
    }

    // R2: a cell may only be reported as `measured` under the enforcement it
    // requested when a CHILD-written dump corroborates that something was
    // actually applied. Zero corroborated corridas in an `/on` cell is
    // `inconclusive:enforcement-unapplied:<named reason>` — never a silent
    // `on` label over a child that received nothing.
    const enf = recs.map((r) => r.enforcement).filter(Boolean);
    const nApplied = enf.filter((e) => e.applied).length;
    const reasons = Array.from(new Set(enf.map((e) => e.reason)));
    const enforcement = {
      nApplied,
      nObserved: enf.filter((e) => e.childObserved).length,
      reasons,
    };
    const unapplied = cell.endsWith('/on') && nApplied === 0;

    summary[cell] = {
      n: recs.length,
      nOk: ok.length,
      median: median(ok),
      min: ok[0],
      max: ok[ok.length - 1],
      aborted: aborted.map((r) => ({ rep: r.rep, status: r.status })),
      witness: lastWitness,
      enforcement,
      verdict: unapplied
        ? `inconclusive:enforcement-unapplied:${reasons[0] || ENFORCEMENT_REASONS.NO_DUMP_CHILD}`
        : 'measured',
    };
  }
  return summary;
}

function summarizeFile(filePath, cells) {
  return summarizeRecords(readJsonlRecords(filePath), cells || CELLS);
}

function formatSummary(summary) {
  const lines = [];
  for (const cell of Object.keys(summary)) {
    const s = summary[cell];
    if (!s.nOk) {
      lines.push(`${cell}: ${s.verdict} (n=${s.n}, ok=${s.nOk})`);
      continue;
    }
    const w = s.witness || {};
    const e = s.enforcement || {};
    lines.push(
      `${cell}: n=${s.n} ok=${s.nOk} mediana=${s.median}ms min=${s.min}ms max=${s.max}ms`
      + ` aborted=${s.aborted.length}`
      + `${w.enforcement ? ` enforcement=${w.enforcement} workers=${w.workers} heapMb=${w.heapMb} agregado=${w.aggregateMb}MB RAM=${w.totalMb}MB` : ''}`
      + `${e.reasons ? ` aplicado-no-filho=${e.nApplied}/${s.n} (${e.reasons.join('|')})` : ''}`
      + `${s.verdict === 'measured' ? '' : ` → ${s.verdict}`}`,
    );
  }
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'dry-run') { args.dryRun = true; continue; }
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function runMatrix(opts) {
  const {
    cwd, cells, reps, competitors, command, timeoutMs, outFile,
  } = opts;
  const prefsPath = localPrefsPath(cwd);
  const snapshot = snapshotPrefsFile(prefsPath);
  const restorePrefs = opts.restorePrefsFile || restorePrefsFile;
  const cancellationFence = createSpawnFence();
  let restored = false;
  const doRestore = (force = false) => {
    if (restored && !force) return { ok: true, skipped: true };
    restored = true;
    try {
      restorePrefs(prefsPath, snapshot);
      return { ok: true };
    } catch (e) {
      process.stderr.write(`forge-resources-bench: ERRO ao restaurar prefs (${e.message}) — verifique ${prefsPath} manualmente.\n`);
      return { ok: false, error: e };
    }
  };

  // The measured corrida and the competitors are now spawned asynchronously
  // (never `spawnSync`), so the event loop is free and these handlers run
  // MID-corrida instead of only after the child returned — that was the
  // signal-path hole T06 reported under SIGTERM. Children live in their own
  // process groups, so they must be reaped explicitly (R3) before exit.
  let signalCleanupStarted = false;
  const onSignal = (sig) => async () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    await completeSignalShutdown({
      signal: sig,
      cancellationFence,
      restore: doRestore,
      cleanup: killAllLiveAsync,
      exit: (code) => process.exit(code),
      writeDiagnostic: (message) => process.stderr.write(`forge-resources-bench: ${message}\n`),
    });
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));

  let runError = null;
  try {
    const plan = planRuns(cells, reps);
    for (const { cell, rep } of plan) {
      if (cancellationFence.closed) break;
      // eslint-disable-next-line no-await-in-loop
      const record = await runOneCorrida({
        cell, rep, command, cwd, timeoutMs, competitors, outFile, cancellationFence,
      });
      if (!record || cancellationFence.closed) break;
    }
    return summarizeFile(outFile, cells);
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    killAllLive();
    const restoration = doRestore();
    assertRestoration(runError, restoration);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const cwd = args.cwd || process.cwd();

  if (args.summarize) {
    const summary = summarizeFile(args.summarize, CELLS);
    process.stdout.write(`${formatSummary(summary)}\n`);
    return;
  }

  const reps = Math.max(MIN_REPS, Number.parseInt(args.reps, 10) || DEFAULT_REPS);
  const competitors = Number.isInteger(Number.parseInt(args.competitors, 10))
    ? Number.parseInt(args.competitors, 10) : DEFAULT_COMPETITORS;
  const cells = args.cells ? String(args.cells).split(',').map((c) => c.trim()).filter(Boolean) : CELLS;
  const timeoutMs = Number.parseInt(args['timeout-ms'], 10) || DEFAULT_TIMEOUT_MS;
  const outFile = args.out || path.join(cwd, '.gsd', 'forge', `resources-bench-${Date.now()}.jsonl`);
  const command = parseCommand(args.command);

  if (args.dryRun) {
    const plan = planRuns(cells, reps);
    process.stdout.write(`${JSON.stringify({
      dryRun: true, plan, command, competitors, timeoutMs, outFile,
    }, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const summary = await runMatrix({
    cwd, cells, reps, competitors, command, timeoutMs, outFile,
  });
  process.stdout.write(`${formatSummary(summary)}\n`);
  process.stdout.write(`\narquivo: ${outFile}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`forge-resources-bench: erro fatal (${e.message})\n`);
    process.exit(1);
  });
}

module.exports = {
  CELLS,
  DEFAULT_COMMAND,
  localPrefsPath,
  cellEnforcement,
  snapshotPrefsFile,
  restorePrefsFile,
  writeEnforcement,
  parseCommand,
  runChild,
  spawnCompetitor,
  killTree,
  killTreeAsync,
  killAllLiveAsync,
  createSpawnFence,
  closeSpawnFence,
  completeSignalShutdown,
  assertRestoration,
  spawnTracked,
  TASKKILL_TIMEOUT_MS,
  ENFORCEMENT_REASONS,
  evaluateEnforcement,
  withDumpPreload,
  DUMP_MODULE,
  runOneCorrida,
  planRuns,
  median,
  readJsonlRecords,
  summarizeRecords,
  summarizeFile,
  formatSummary,
  parseArgs,
  runMatrix,
  main,
};
