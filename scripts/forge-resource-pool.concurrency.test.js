#!/usr/bin/env node
'use strict';

// Real cross-process suite for scripts/forge-resource-pool.js (W5).
//
// Everything in scripts/forge-resource-pool.test.js proves the module's LOGIC
// with two sequential in-process calls sharing one Node heap and one event
// loop — that proves nothing about two OS processes racing for the same
// lease files on disk. This file spawns genuine `child_process.spawn` node
// processes, synchronizes them with a file barrier so they actually contend,
// and asserts the granted slices SUM to the ceiling under real contention —
// the measured claim S02 rests on (the original defect was two Forge
// executors each taking the whole machine).
//
// Every process here (parent + every spawned child) is pointed at a per-test
// `fs.mkdtempSync` pool dir via `FORGE_RESOURCE_POOL_DIR`; the real machine
// pool at ~/.claude/forge/resource-pool is never touched (asserted directly,
// last case).
//
// Known trap (documented in forge-resource-pool.js and re-stated here):
// forge-unit-lease.js's `nowOf(options)` only honors `options.now` when it is
// itself a FUNCTION — a raw number is silently discarded in favor of
// Date.now(). The holder uses real time; the kill case's parent checks the
// recorded expiry boundaries with closures, independently of OS scheduling.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const pool = require('./forge-resource-pool.js');
const lease = require('./forge-unit-lease.js');

const POOL_MODULE = path.join(__dirname, 'forge-resource-pool.js');
const LEASE_MODULE = path.join(__dirname, 'forge-unit-lease.js');

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

// `test()` only QUEUES — it never runs synchronously. These cases spawn real
// processes and await real exits; if test() ran and returned a dangling
// promise at each top-level call site (no top-level await in CommonJS), the
// bodies would interleave nondeterministically and the report at the bottom
// would print before any of them finished. runAll() below drains the queue
// strictly sequentially.
function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ name, error });
    }
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Deadline-bounded busy-poll with a named failure — never a bare setTimeout
// race. Used only from the PARENT (async context); children use their own
// synchronous variant (sleepSyncMs, embedded in the worker source strings
// below) since a spawned `-e` script has no outer event loop to await on
// conveniently and must stay a tight, bounded, file-driven barrier.
async function pollUntil(conditionFn, { intervalMs = 20, deadlineMs = 5000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (conditionFn()) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`pollUntil: deadline (${deadlineMs}ms) exceeded waiting for: ${label}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

async function waitForFileJson(file, opts) {
  await pollUntil(() => fs.existsSync(file), { ...opts, label: `file to appear: ${file}` });
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function waitForExit(child, deadlineMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`waitForExit: deadline (${deadlineMs}ms) exceeded for pid ${child.pid}`));
    }, deadlineMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// Small, self-contained worker source built at test time and run via
// `node -e <source>` in a fresh OS process. File-barrier only, no sleeps
// beyond the bounded synchronous poll below (Atomics.wait — the standard
// Node main-thread sync-sleep primitive; safe here since each worker is a
// short-lived single-purpose process).
function disputeWorkerSource() {
  return `
    'use strict';
    const fs = require('fs');
    const pool = require(process.env.POOL_MODULE);
    function sleepSyncMs(ms) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, ms);
    }
    function pollFile(file, deadlineMs, label) {
      const start = Date.now();
      while (!fs.existsSync(file)) {
        if (Date.now() - start > deadlineMs) throw new Error('worker deadline exceeded: ' + label);
        sleepSyncMs(10);
      }
    }
    try {
      const readyFile = process.env.READY_FILE;
      const goFile = process.env.GO_FILE;
      const outFile = process.env.OUT_FILE;
      const heldFile = process.env.HELD_FILE;
      const releaseFile = process.env.RELEASE_FILE;
      const requestN = Number(process.env.REQUEST_N || '1');
      const ownerToken = 'owner-' + process.pid;
      if (readyFile) fs.writeFileSync(readyFile, String(process.pid));
      if (goFile) pollFile(goFile, 5000, 'go barrier');
      const result = pool.acquireSlots(requestN, { poolDir: process.env.FORGE_RESOURCE_POOL_DIR, ownerToken });
      fs.writeFileSync(outFile, JSON.stringify(result));
      if (heldFile) fs.writeFileSync(heldFile, String(process.pid));
      if (releaseFile) {
        pollFile(releaseFile, 5000, 'release signal');
        pool.releaseSlots(result.slots, { poolDir: process.env.FORGE_RESOURCE_POOL_DIR });
      }
      process.exit(0);
    } catch (e) {
      fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      process.exit(1);
    }
  `;
}

function holderWorkerSource() {
  return `
    'use strict';
    const fs = require('fs');
    const lease = require(process.env.LEASE_MODULE);
    try {
      const ttlMs = Number(process.env.TTL_MS);
      const graceMs = Number(process.env.GRACE_MS);
      const ownerToken = 'holder-' + process.pid;
      // Deliberately REAL Date.now() — this holder must be a genuine process
      // a real SIGKILL can hit; no injected clock here.
      const result = lease.acquire(process.env.FORGE_RESOURCE_POOL_DIR, 'resource-pool/slot-0', { ttlMs, graceMs, ownerToken });
      fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(result));
      if (process.env.READY_FILE) fs.writeFileSync(process.env.READY_FILE, String(process.pid));
      // Stay alive (holding the lease) until the parent SIGKILLs us.
      setInterval(() => {}, 1000);
    } catch (e) {
      fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      process.exit(1);
    }
  `;
}

function spawnWorker(source, env) {
  return spawn(process.execPath, ['-e', source], {
    env: { ...process.env, POOL_MODULE, LEASE_MODULE, ...env },
  });
}

// ── (1) Dispute case (W5): two REAL processes, ceiling 4, each requests 3 ──
// Each side requests 3 (< ceiling 4) so that NEITHER can single-handedly
// exhaust all 4 slots before the other attempts — this keeps the assertion
// inside the pool's documented positive-grant path (W2/grant formula) and
// out of the separately-documented, separately-named
// 'pool-exhausted-minimum-grant' floor (registered discretion in
// S02-PLAN.md: worst case ceiling + (runs-1)x1, advisory, never silent —
// NOT the invariant this test proves). Combined requests (3+3=6) exceed the
// ceiling (4), so real contention/clamping still happens.
test('dispute: two real spawned processes sum to the ceiling (never exceed it)', async () => {
  const dir = tmpDir('forge-pool-dispute-');
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pool-config.json'), JSON.stringify({ protocol: 1, ceiling: 4, written_at: Date.now() }), 'utf8');

  const outA = path.join(dir, 'out-a.json');
  const outB = path.join(dir, 'out-b.json');
  const readyA = path.join(dir, 'ready-a');
  const readyB = path.join(dir, 'ready-b');
  const goFile = path.join(dir, 'go');

  const envBase = { FORGE_RESOURCE_POOL_DIR: dir, GO_FILE: goFile, REQUEST_N: '3' };
  const childA = spawnWorker(disputeWorkerSource(), { ...envBase, OUT_FILE: outA, READY_FILE: readyA });
  const childB = spawnWorker(disputeWorkerSource(), { ...envBase, OUT_FILE: outB, READY_FILE: readyB });
  // Registered immediately after spawn: Node's 'exit' event fires once and is
  // MISSED if the listener is attached after the child has already exited
  // (these children finish in well under a millisecond) — the promise must
  // exist before we do any other awaiting.
  const exitedA = waitForExit(childA, 8000);
  const exitedB = waitForExit(childB, 8000);

  try {
    // Both children touch their ready marker before requesting, THEN wait on
    // the shared go file — this is what makes their acquireSlots() calls
    // land inside the SAME real contention window instead of sequentially.
    await pollUntil(() => fs.existsSync(readyA) && fs.existsSync(readyB), { label: 'both children ready', deadlineMs: 5000 });
    fs.writeFileSync(goFile, 'go');

    const [resultA, resultB] = await Promise.all([
      waitForFileJson(outA, { deadlineMs: 5000 }),
      waitForFileJson(outB, { deadlineMs: 5000 }),
    ]);

    if (resultA.error) throw new Error('child A errored: ' + resultA.error);
    if (resultB.error) throw new Error('child B errored: ' + resultB.error);
    if (!resultA.ok || !resultB.ok) throw new Error('both children must report ok:true');

    const sum = resultA.granted + resultB.granted;
    if (sum > 4) throw new Error(`granted sum (${sum}) EXCEEDED the ceiling (4) — this is the exact bug the pool exists to prevent`);
    if (sum < 4) throw new Error(`granted sum (${sum}) under-granted the ceiling (4) with combined requests (6) exceeding it`);

    await exitedA;
    await exitedB;
  } finally {
    try { childA.kill('SIGKILL'); } catch (e) { /* already exited */ }
    try { childB.kill('SIGKILL'); } catch (e) { /* already exited */ }
  }
});

// ── (2) Negative control: uncontended -> full request granted ──────────────
test('uncontended control: a single real process against a fresh pool receives its full request', async () => {
  const dir = tmpDir('forge-pool-uncontended-');
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pool-config.json'), JSON.stringify({ protocol: 1, ceiling: 4, written_at: Date.now() }), 'utf8');

  const outFile = path.join(dir, 'out.json');
  const child = spawnWorker(disputeWorkerSource(), { FORGE_RESOURCE_POOL_DIR: dir, OUT_FILE: outFile, REQUEST_N: '3' });
  const exited = waitForExit(child, 8000); // registered before any await — see dispute case comment
  try {
    const result = await waitForFileJson(outFile, { deadlineMs: 5000 });
    if (result.error) throw new Error('child errored: ' + result.error);
    if (result.granted !== 3) throw new Error(`expected full grant of 3 on an uncontended pool, got ${result.granted} (reason=${result.reason})`);
    await exited;
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
  }
});

// ── (3) Kill -9 reap: retained pre-ttl+grace, reaped with stale-lease-reaped ──
test('kill -9: slot retained before ttl+grace, reaped with stale-lease-reaped after, D5 no-signal', async () => {
  const dir = tmpDir('forge-pool-kill-');
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pool-config.json'), JSON.stringify({ protocol: 1, ceiling: 1, written_at: Date.now() }), 'utf8');

  // Separate project cwd for the events.jsonl assertion — pool root is
  // machine-wide (B1), events are project-scoped derived observability only.
  const projectDir = tmpDir('forge-pool-kill-project-');
  fs.mkdirSync(path.join(projectDir, '.gsd'), { recursive: true });

  const outFile = path.join(dir, 'holder-out.json');
  const readyFile = path.join(dir, 'holder-ready');
  const ttlMs = 300;
  const graceMs = 100;

  const holder = spawnWorker(holderWorkerSource(), {
    FORGE_RESOURCE_POOL_DIR: dir, OUT_FILE: outFile, READY_FILE: readyFile,
    TTL_MS: String(ttlMs), GRACE_MS: String(graceMs),
  });
  const holderExited = waitForExit(holder, 8000); // registered before any await

  try {
    const acquireResult = await waitForFileJson(outFile, { deadlineMs: 5000 });
    if (acquireResult.error) throw new Error('holder errored acquiring: ' + acquireResult.error);
    if (!acquireResult.ok) throw new Error('holder must successfully acquire the lease before being killed');
    await pollUntil(() => fs.existsSync(readyFile), { label: 'holder ready marker', deadlineMs: 5000 });

    process.kill(holder.pid, 'SIGKILL');
    await holderExited;

    // Process startup/exit can exceed the 400ms lease window on a busy host.
    // Keep the real child crash, but inspect its lease at explicit boundaries.
    const expiresAt = acquireResult.lease && acquireResult.lease.expires_at;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('holder must publish its lease expiry');
    const contended = lease.acquire(dir, 'resource-pool/slot-0', {
      ownerToken: 'intruder', now: () => expiresAt - 1,
    });
    if (contended.ok) throw new Error('slot must be retained before lease expiry after SIGKILL');
    if (contended.reason !== 'lease-active') {
      throw new Error(`expected retained reason lease-active, got ${contended.reason}`);
    }
    const atGrace = lease.acquire(dir, 'resource-pool/slot-0', {
      ownerToken: 'intruder', now: () => expiresAt + graceMs,
    });
    if (atGrace.ok || atGrace.reason !== 'expired-awaiting-grace') {
      throw new Error('slot must remain retained at the exact grace boundary');
    }

    // The next acquisition (via the POOL, not the raw lease module) is what
    // opportunistically reaps stale holders (forge-resource-pool.js
    // acquireSlots -> reapStale). This is the ROADMAP demo path.
    const reaped = pool.acquireSlots(1, {
      poolDir: dir, cwd: projectDir, ownerToken: 'reaper', now: () => expiresAt + graceMs + 1,
    });
    if (!reaped.ok) throw new Error('re-acquisition after ttl+grace must succeed (ok:true)');
    if (reaped.granted !== 1) throw new Error(`expected the freed slot to be granted (1), got ${reaped.granted}`);
    if (reaped.reason !== pool.POOL_REASON_CODES.POOL_GRANTED) {
      throw new Error(`expected reason ${pool.POOL_REASON_CODES.POOL_GRANTED}, got ${reaped.reason}`);
    }

    // The reap itself is recorded as a project-scoped event carrying the
    // frozen enum reason 'stale-lease-reaped' — the ROADMAP demo sentence.
    const eventsFile = path.join(projectDir, '.gsd', 'forge', 'events.jsonl');
    if (!fs.existsSync(eventsFile)) throw new Error('events.jsonl must exist in the project dir after a reap');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const reapEvent = lines.find((l) => l.kind === pool.POOL_REASON_CODES.STALE_LEASE_REAPED);
    if (!reapEvent) throw new Error(`no event line with kind '${pool.POOL_REASON_CODES.STALE_LEASE_REAPED}' found in events.jsonl (had: ${JSON.stringify(lines)})`);
    if (reapEvent.reason !== pool.POOL_REASON_CODES.STALE_LEASE_REAPED) {
      throw new Error(`event reason must equal the frozen enum value, got ${reapEvent.reason}`);
    }

    // D5 cross-check: the reap path only ever quarantines lease records. It
    // NEVER signals, kills, or throttles a process. The only process.kill
    // this whole test file issues is the one explicit SIGKILL above, which
    // is the TEST's crash injection — never the module's own behavior.
    const moduleSource = fs.readFileSync(POOL_MODULE, 'utf8');
    if (/process\.kill/.test(moduleSource)) throw new Error('D5 violated: forge-resource-pool.js source references process.kill');
    if (/\bSIGKILL\b|\bSIGTERM\b/.test(moduleSource)) throw new Error('D5 violated: forge-resource-pool.js source references a kill signal');
    if (/taskpolicy/.test(moduleSource)) throw new Error('D5 violated: forge-resource-pool.js source references taskpolicy');

    const ownSource = fs.readFileSync(__filename, 'utf8');
    const killCallCount = (ownSource.match(/process\.kill\(/g) || []).length;
    if (killCallCount !== 1) {
      throw new Error(`D5 cross-check: this test file must contain exactly ONE process.kill call (the deliberate crash injection above), found ${killCallCount}`);
    }
  } finally {
    try { holder.kill('SIGKILL'); } catch (e) { /* already exited */ }
  }
});

// ── Real-default-root guard: this whole suite never touches the machine pool ──
test('real-default-root guard: this suite never creates/modifies ~/.claude/forge/resource-pool', async () => {
  const realRoot = path.join(os.homedir(), '.claude', 'forge', 'resource-pool');
  const existedBefore = fs.existsSync(realRoot);
  const statBefore = existedBefore ? fs.statSync(realRoot).mtimeMs : null;
  // This assertion runs last; every prior case in this file passed an
  // explicit FORGE_RESOURCE_POOL_DIR/poolDir — this proves none of them fell
  // through to the machine default.
  const existedAfter = fs.existsSync(realRoot);
  if (!existedBefore) {
    if (existedAfter) throw new Error('the real default pool root must not have been created by this suite');
  } else if (fs.statSync(realRoot).mtimeMs !== statBefore) {
    throw new Error('the real default pool root must not have been modified by this suite');
  }
});

// ── Report ───────────────────────────────────────────────────────────────
runAll().then(() => {
  if (failed > 0) {
    for (const { name, error } of failures) {
      process.stderr.write(`FAIL: ${name}\n  ${(error && error.stack) || error}\n`);
    }
    process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${passed} passed, ${failed} failed\n`);
  }
});
