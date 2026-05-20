#!/usr/bin/env node
// forge-lock — Cross-platform mutex via mkdir atomicity (POSIX + NTFS)
//
// Used by: dashboard regen (S01), global merger (S05).
// Lock files live under .gsd/.locks/{name}/ with metadata.json inside.
// See shared/forge-state.md §6.
//
// Library exports:
//   acquire(cwd, name, opts) → { release(), metadata, lockDir }
//   tryAcquire(cwd, name, opts) → same shape or null on busy
//   release(cwd, name) → boolean (was held)
//   status(cwd, name) → { held, metadata, age_ms } | null
//
// CLI:
//   node forge-lock.js --acquire DECISIONS.md [--ttl 30000] [--holder <id>]
//   node forge-lock.js --release DECISIONS.md
//   node forge-lock.js --status DECISIONS.md

'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_TTL_MS      = 30_000;
const DEFAULT_RETRIES     = 10;
const DEFAULT_BACKOFF_MIN = 100;
const DEFAULT_BACKOFF_MAX = 300;

function locksDir(cwd) {
  return path.join(cwd, '.gsd', '.locks');
}

function lockPath(cwd, name) {
  // Sanitize: only allow safe chars in name
  const safe = String(name).replace(/[^\w.\-]/g, '_');
  return path.join(locksDir(cwd), safe);
}

function metaPath(lockDir) {
  return path.join(lockDir, 'metadata.json');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function readMetadata(lockDir) {
  try { return JSON.parse(fs.readFileSync(metaPath(lockDir), 'utf8')); }
  catch { return null; }
}

function lockAge(lockDir) {
  try {
    const stat = fs.statSync(lockDir);
    return Date.now() - stat.mtimeMs;
  } catch { return null; }
}

// Try to take a stale lock by removing it. Returns true if removed (and we
// can now retry mkdir), false if not stale or removal failed.
function stealIfStale(lockDir, ttlMs) {
  const age = lockAge(lockDir);
  if (age === null) return false;
  if (age <= ttlMs) return false;
  try {
    const meta = metaPath(lockDir);
    if (fs.existsSync(meta)) fs.unlinkSync(meta);
    fs.rmdirSync(lockDir);
    return true;
  } catch { return false; }
}

// ── Public API ──────────────────────────────────────────────────────────────
async function acquire(cwd, name, opts) {
  opts = opts || {};
  const ttlMs      = opts.ttlMs      || DEFAULT_TTL_MS;
  const retries    = opts.retries    || DEFAULT_RETRIES;
  const backoffMin = opts.backoffMin || DEFAULT_BACKOFF_MIN;
  const backoffMax = opts.backoffMax || DEFAULT_BACKOFF_MAX;

  fs.mkdirSync(locksDir(cwd), { recursive: true });
  const lockDir = lockPath(cwd, name);

  const metadata = {
    acquired_at: Date.now(),
    holder_pid: opts.holderPid || process.pid,
    holder_run_id: opts.holderRunId || null,
    ttl_ms: ttlMs,
    name,
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.mkdirSync(lockDir);                                    // atomic — throws EEXIST if held
      fs.writeFileSync(metaPath(lockDir), JSON.stringify(metadata), 'utf8');
      return {
        lockDir,
        metadata,
        release: () => releaseSync(cwd, name),
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Held by someone else — try stale steal
      if (stealIfStale(lockDir, ttlMs)) {
        // Don't count steal as an attempt — try mkdir again immediately
        attempt--;
        continue;
      }
      // Active holder — backoff
      if (attempt < retries - 1) {
        await sleep(jitter(backoffMin, backoffMax));
      }
    }
  }

  const m = readMetadata(lockDir);
  const age = lockAge(lockDir);
  throw new Error(`forge-lock: could not acquire "${name}" after ${retries} attempts (held by pid=${m && m.holder_pid}, run=${m && m.holder_run_id}, age=${age}ms, ttl=${ttlMs}ms)`);
}

function tryAcquireSync(cwd, name, opts) {
  opts = opts || {};
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  fs.mkdirSync(locksDir(cwd), { recursive: true });
  const lockDir = lockPath(cwd, name);

  const metadata = {
    acquired_at: Date.now(),
    holder_pid: opts.holderPid || process.pid,
    holder_run_id: opts.holderRunId || null,
    ttl_ms: ttlMs,
    name,
  };

  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(metaPath(lockDir), JSON.stringify(metadata), 'utf8');
    return { lockDir, metadata, release: () => releaseSync(cwd, name) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (stealIfStale(lockDir, ttlMs)) {
      try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(metaPath(lockDir), JSON.stringify(metadata), 'utf8');
        return { lockDir, metadata, release: () => releaseSync(cwd, name) };
      } catch { return null; }
    }
    return null;
  }
}

function releaseSync(cwd, name) {
  const lockDir = lockPath(cwd, name);
  try {
    const meta = metaPath(lockDir);
    if (fs.existsSync(meta)) fs.unlinkSync(meta);
    fs.rmdirSync(lockDir);
    return true;
  } catch { return false; }
}

function status(cwd, name) {
  const lockDir = lockPath(cwd, name);
  if (!fs.existsSync(lockDir)) return { held: false };
  return {
    held: true,
    metadata: readMetadata(lockDir),
    age_ms: lockAge(lockDir),
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
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

async function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help) {
    process.stdout.write(`forge-lock — mkdir-mutex helper

Flags:
  --acquire <name>           acquire; print JSON {lockDir,metadata}
    --ttl <ms>                 default 30000
    --holder <run-id>          tag the holder for debugging
    --retries <n>              default 10
  --try-acquire <name>       non-blocking; exit 1 + "busy" if can't acquire
  --release <name>           release; exit 0 if was held, 1 if not
  --status <name>            print {held, metadata, age_ms}
  --cwd <path>               override working directory

Note: --acquire holds the lock only for the duration of the node process.
For sustained holds in scripts, use the library API and call release().
`);
    return;
  }

  try {
    if (args.acquire) {
      const opts = {
        ttlMs: args.ttl ? parseInt(args.ttl, 10) : undefined,
        holderRunId: args.holder || null,
        retries: args.retries ? parseInt(args.retries, 10) : undefined,
      };
      const r = await acquire(cwd, args.acquire, opts);
      process.stdout.write(JSON.stringify({ lockDir: r.lockDir, metadata: r.metadata }, null, 2) + '\n');
      // Keep process alive briefly so cli caller can observe acquisition?
      // No — exit cleanly. Caller should hold via library.
    } else if (args['try-acquire']) {
      const opts = {
        ttlMs: args.ttl ? parseInt(args.ttl, 10) : undefined,
        holderRunId: args.holder || null,
      };
      const r = tryAcquireSync(cwd, args['try-acquire'], opts);
      if (r) {
        process.stdout.write(JSON.stringify({ lockDir: r.lockDir, metadata: r.metadata }, null, 2) + '\n');
      } else {
        process.stderr.write('busy\n');
        process.exit(1);
      }
    } else if (args.release) {
      const ok = releaseSync(cwd, args.release);
      process.stdout.write(ok ? 'released\n' : 'not held\n');
      if (!ok) process.exit(1);
    } else if (args.status) {
      process.stdout.write(JSON.stringify(status(cwd, args.status), null, 2) + '\n');
    } else {
      process.stderr.write('forge-lock: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-lock error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  acquire, tryAcquireSync, releaseSync, status,
  locksDir, lockPath,
  DEFAULT_TTL_MS,
};
