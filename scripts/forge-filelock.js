#!/usr/bin/env node
// forge-filelock — Cross-run file ownership tracking for shared isolation mode (M004+)
//
// Lock files live under .gsd/forge/file-locks/{base64url(relative_path)}.json
// Used by forge-hook.js PreToolUse to block Write/Edit when another active run
// currently owns the file. Lock TTL defaults to 60s; stale locks are auto-takeable.
//
// This is **defense-in-depth** — primary isolation comes from branch/worktree modes.
// In shared mode, file-locks prevent the most common collisions when two runs
// happen to touch the same path. They are NOT a hard mutex (TOCTOU race exists
// between read and write); enough for normal concurrent operation, not for
// adversarial scenarios.
//
// Library exports:
//   acquireFileLock(cwd, filePath, runId, sessionId, opts) → { acquired, holder }
//   releaseFileLock(cwd, filePath, runId)               → boolean
//   checkFileLock(cwd, filePath)                        → { held, holder, age_ms } | null
//   lockPathFor(cwd, filePath)                          → absolute path of lock file
//
// CLI:
//   node forge-filelock.js --acquire <relpath> --run M065 --session abc [--ttl 60000]
//   node forge-filelock.js --release <relpath> --run M065
//   node forge-filelock.js --check <relpath>

'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 60_000;

let runs = null;
try { runs = require('./forge-runs.js'); } catch {}

function locksDir(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'file-locks');
}

// base64url encode the path so any nesting is flat-filesystem-safe
function encodePath(p) {
  return Buffer.from(String(p), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function lockPathFor(cwd, filePath) {
  return path.join(locksDir(cwd), encodePath(filePath) + '.json');
}

function readLock(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
  catch { return null; }
}

function isHolderRunActive(cwd, runId) {
  if (!runs || !runId) return false;
  try {
    const r = runs.get(cwd, runId);
    return !!(r && r.active);
  } catch { return false; }
}

// ── Public API ──────────────────────────────────────────────────────────────
function acquireFileLock(cwd, filePath, runId, sessionId, opts) {
  opts = opts || {};
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const lockFile = lockPathFor(cwd, filePath);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const existing = readLock(lockFile);
  const now = Date.now();

  if (existing) {
    const ageMs = now - (existing.acquired_at || 0);
    const sameRun  = existing.run_id === runId;
    const expired  = ageMs > ttlMs;
    const ownerActive = isHolderRunActive(cwd, existing.run_id);

    if (sameRun) {
      // Renew our own lock
      const meta = { run_id: runId, session_id: sessionId, file_path: filePath, acquired_at: now, intent: opts.intent || 'edit' };
      fs.writeFileSync(lockFile, JSON.stringify(meta), 'utf8');
      return { acquired: true, holder: null, renewed: true };
    }

    // Different holder
    if (!ownerActive || expired) {
      // Steal: owner gone or stale
      const meta = { run_id: runId, session_id: sessionId, file_path: filePath, acquired_at: now, intent: opts.intent || 'edit' };
      fs.writeFileSync(lockFile, JSON.stringify(meta), 'utf8');
      return { acquired: true, holder: null, stolen: { from: existing.run_id, reason: !ownerActive ? 'inactive' : 'expired', age_ms: ageMs } };
    }

    // Active holder, fresh lock — DENY
    return {
      acquired: false,
      holder: {
        run_id: existing.run_id,
        session_id: existing.session_id,
        acquired_at: existing.acquired_at,
        age_ms: ageMs,
        file_path: existing.file_path,
      },
    };
  }

  // Fresh acquisition
  const meta = { run_id: runId, session_id: sessionId, file_path: filePath, acquired_at: now, intent: opts.intent || 'edit' };
  fs.writeFileSync(lockFile, JSON.stringify(meta), 'utf8');
  return { acquired: true, holder: null };
}

function releaseFileLock(cwd, filePath, runId) {
  const lockFile = lockPathFor(cwd, filePath);
  const existing = readLock(lockFile);
  if (!existing) return false;
  // Only release if we own it
  if (runId && existing.run_id !== runId) return false;
  try { fs.unlinkSync(lockFile); return true; }
  catch { return false; }
}

function checkFileLock(cwd, filePath) {
  const lockFile = lockPathFor(cwd, filePath);
  const existing = readLock(lockFile);
  if (!existing) return { held: false };
  return {
    held: true,
    holder: existing,
    age_ms: Date.now() - (existing.acquired_at || 0),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help) {
    process.stdout.write(`forge-filelock — cross-run file ownership tracking

Flags:
  --acquire <relpath> --run <id> --session <id> [--ttl <ms>] [--intent <s>]
                                acquire / renew lock; exit 0 + JSON {acquired:true} on success;
                                exit 1 + JSON {acquired:false, holder:{...}} on conflict
  --release <relpath> [--run <id>]
                                release lock (only if owned by --run, if specified)
  --check <relpath>             check current state
  --cwd <path>                  override working directory
`);
    return;
  }

  try {
    if (args.acquire) {
      const r = acquireFileLock(cwd, args.acquire, args.run || null, args.session || null, {
        ttlMs: args.ttl ? parseInt(args.ttl, 10) : undefined,
        intent: args.intent,
      });
      process.stdout.write(JSON.stringify(r) + '\n');
      if (!r.acquired) process.exit(1);
    } else if (args.release) {
      const ok = releaseFileLock(cwd, args.release, args.run);
      process.stdout.write(ok ? 'released\n' : 'not held (or not owned)\n');
      if (!ok) process.exit(1);
    } else if (args.check) {
      const r = checkFileLock(cwd, args.check);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      process.stderr.write('forge-filelock: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-filelock error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  acquireFileLock, releaseFileLock, checkFileLock,
  lockPathFor, encodePath,
  DEFAULT_TTL_MS,
};
