#!/usr/bin/env node
// forge-memory — Per-unit AUTO-MEMORY fragment store for Forge Agent
//
// Library exports:
//   MEMORY_DIR                          → string  // relative path '.gsd/memory'
//   memoryDir(cwd)                      → string  // absolute path to memory dir
//   fragmentPath(cwd, unitId, opts?)    → string  // absolute path to [<milestone>__]<unit-id>.md
//   parseFragment(text)                 → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, fragment, opts)  → { path, created }
//   readFragment(cwd, unitId, opts?)    → object | null
//   readFragmentText(cwd, entry)        → string // selected fragment payload
//   listFragments(cwd, opts?)           → Array<{ storageKey, unitId, milestoneId, path }>
//   validateUnitId(unitId)              → boolean
//   queryRelevant(query)                → bounded selector result
//
// CLI:
//   node forge-memory.js --list [--cwd <dir>]
//   node forge-memory.js --read <unit-id> [--milestone <id>] [--cwd <dir>]
//   node forge-memory.js --write [--milestone <id>] [--cwd <dir>]   (reads JSON fragment from stdin)
//   node forge-memory.js --validate <unit-id> [--cwd <dir>]
//   node forge-memory.js --query [options] [--cwd <dir>]
//   node forge-memory.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValid, entityKind } = require('./forge-ids');
const yamlSafe = require('./forge-yaml-safe');
const { isGroupedFile, readGroupedUnits, readSniffBuffer, publicEntry, unitTextOf } = require('./forge-grouped-file');

// ── Constants ─────────────────────────────────────────────────────────────────

const MEMORY_DIR = '.gsd/memory';
const MAX_QUERY_BYTES = 512 * 1024;
const FRAGMENT_LOCK_TTL_MS = 120 * 1000;
const FRAGMENT_LOCK_ATTEMPTS = 200;

// Pattern for forge-ask session IDs: ask-<session-id>
const ASK_ID_RE = /^ask-[A-Za-z0-9._-]+$/;

// Milestone-internal slices/tasks use local canonical IDs in the dispatch loop.
// They are not top-level forge-ids entities, but they are valid memory fragment
// owners (for example S02 plan research and T03 execution summaries).
const LOCAL_UNIT_ID_RE = /^(?:S\d+|T\d+(?:\.\d+)?)$/i;
const QUALIFIED_KEY_RE = /^(.+)__((?:S\d+|T\d+(?:\.\d+)?))$/i;

// ── Schema guard seam (M-S01 T04) ────────────────────────────────────────────
// Lazy require, deliberately: forge-schema-guard → forge-migrate →
// forge-projection → forge-memory is a top-level cycle (forge-migrate.js:33,
// forge-projection.js:34) — this file already resolves forge-projection lazily
// for the same reason (see queryRelevant below). The `catch` keeps this file
// loadable if the guard is not colocated (installed layouts).
//
// SINGLE INSERTION POINT PER SIDE:
//   read  → guardReadHere() at the top of listFragments/readFragment/queryRelevant
//   write → assertWriteHere() at the top of writeFragment
// queryRelevant is the MODULE boundary the guard exists for: forge-prompt.js
// calls it directly, never through this CLI, so a cliMain-only guard would miss
// the hot render path entirely.
// Only an ABSENT guard module is swallowed. A guard that exists but throws
// while initializing — or whose own transitive require fails (the guard pulls
// forge-migrate, which eagerly pulls projection/migrators/store-state/doctor)
// — is a real fault and must propagate rather than silently disabling both the
// read warning and the write refusal.
//
// SCOPE BOUNDARY (deliberate, do not 'complete' it): this narrows the CATCH
// only — it is about LOADING the guard, not about what the guard decides.
// The seam stays FAIL-OPEN on an unexpected runtime error raised inside the
// guard's own check (see the catch in assertWrite, forge-schema-guard.js).
// It is NOT fail-open on a stamp the guard could not READ: that case refuses
// the write, naming the errno. This note used to say the fail-open of
// assertWrite had been reviewed and kept as is — the PR #70 dogfood revised
// that decision: a directory at .gsd/SCHEMA-VERSION disabled the write guard
// silently, so "unreadable" now closes, while "absent" and "present but
// garbage" stay open.
function schemaGuard() {
  try {
    return require('./forge-schema-guard');
  } catch (err) {
    let absent;
    try {
      absent = require('./forge-optional-require').isAbsentModuleError(err, './forge-schema-guard');
    } catch (_) {
      // Classifier itself missing (partial install) → keep the historical
      // fail-open instead of crashing the store.
      absent = true;
    }
    if (absent) return null;
    throw err;
  }
}

// Fail-open read guard: returns { ok, partial, warning } and emits the warning
// to stderr at most once per process per cwd. Never throws, never blocks.
function guardReadHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return { ok: true, partial: false, warning: null };
  return guard.guardReadAndWarn(cwd || process.cwd());
}

// Write refusal: throws when the on-disk schema major is AHEAD of this
// tooling's. The CLI catch blocks turn that into stderr + exit 1.
function assertWriteHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return;
  guard.assertWriteOrThrow(cwd || process.cwd());
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertMemoryDirectory(cwd, create) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  if (create) fs.mkdirSync(resolvedCwd, { recursive: true });
  if (!fs.existsSync(resolvedCwd)) return null;
  const realCwd = fs.realpathSync(resolvedCwd);
  const dir = path.join(resolvedCwd, '.gsd', 'memory');
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir)) return null;
  const realDir = fs.realpathSync(dir);
  if (!isWithin(realCwd, realDir)) {
    throw new Error(`Memory directory escapes cwd: ${realDir}`);
  }
  if (!fs.statSync(realDir).isDirectory()) {
    throw new Error(`Memory path is not a directory: ${realDir}`);
  }
  return realDir;
}

function validateMilestoneId(id) {
  return Boolean(id && isValid(id) && entityKind(id) === 'milestone');
}

function milestoneFromOptions(opts) {
  if (!opts) return null;
  if (typeof opts === 'string') return opts;
  return opts.milestoneId || opts.milestone_id || null;
}

function qualifiedStorageKey(unitId, milestoneId) {
  if (!LOCAL_UNIT_ID_RE.test(unitId) || !milestoneId) return unitId;
  if (!validateMilestoneId(milestoneId)) {
    throw new Error(`Invalid memory milestone ID: "${milestoneId}"`);
  }
  return `${milestoneId}__${unitId}`;
}

function parseStorageKey(storageKey) {
  if (storageKey === 'legacy-orphan') {
    return { storageKey, unitId: storageKey, milestoneId: null };
  }
  if (validateUnitId(storageKey)) {
    return { storageKey, unitId: storageKey, milestoneId: null };
  }
  const match = String(storageKey).match(QUALIFIED_KEY_RE);
  if (!match || !validateMilestoneId(match[1]) || !LOCAL_UNIT_ID_RE.test(match[2])) {
    return null;
  }
  return { storageKey, unitId: match[2], milestoneId: match[1] };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* compatibility fallback */ }
  }
}

function assertFragmentLockDirectory(cwd) {
  const memoryRoot = assertMemoryDirectory(cwd, true);
  const lockRoot = path.join(memoryRoot, '.locks');
  fs.mkdirSync(lockRoot, { recursive: true });
  const realLockRoot = fs.realpathSync(lockRoot);
  if (!isWithin(memoryRoot, realLockRoot) || !fs.statSync(realLockRoot).isDirectory()) {
    throw new Error(`Memory lock directory escapes fragment store: ${realLockRoot}`);
  }
  return realLockRoot;
}

function removeStaleFragmentLock(lockDir, ttlMs) {
  let stat;
  try {
    stat = fs.lstatSync(lockDir);
  } catch (_) {
    return true;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unsafe memory fragment lock: ${lockDir}`);
  }
  if (Date.now() - stat.mtimeMs <= ttlMs) return false;

  const entries = fs.readdirSync(lockDir, { withFileTypes: true });
  if (entries.some(entry => entry.name !== 'owner.json' || !entry.isFile())) {
    throw new Error(`Refusing to steal malformed memory fragment lock: ${lockDir}`);
  }
  if (entries.length === 1) fs.unlinkSync(path.join(lockDir, 'owner.json'));
  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

// Atomic mkdir mutex used around the complete read -> merge -> write transaction.
// The lower-level writeAtomic lock alone starts too late and permits lost updates.
function acquireFragmentLock(cwd, fpath, opts) {
  opts = opts || {};
  const lockRoot = assertFragmentLockDirectory(cwd);
  const resolvedTarget = path.resolve(fpath);
  // NTFS is normally case-insensitive: T01.md and t01.md must share a mutex.
  const lockIdentity = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  const lockName = crypto.createHash('sha256').update(lockIdentity).digest('hex') + '.lock';
  const lockDir = path.join(lockRoot, lockName);
  const ttlMs = opts.lockTtlMs || FRAGMENT_LOCK_TTL_MS;
  const attempts = opts.lockAttempts || FRAGMENT_LOCK_ATTEMPTS;
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < attempts; attempt++) {
    let owned = false;
    try {
      fs.mkdirSync(lockDir);
      owned = true;
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        token,
        pid: process.pid,
        acquired_at: Date.now(),
      }), { encoding: 'utf8', flag: 'wx' });
      return {
        release() {
          try {
            const ownerPath = path.join(lockDir, 'owner.json');
            const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            if (owner.token !== token) return false;
            fs.unlinkSync(ownerPath);
            fs.rmdirSync(lockDir);
            return true;
          } catch (_) {
            return false;
          }
        },
      };
    } catch (error) {
      if (owned) {
        // mkdir succeeded and owner creation failed: remove only our own empty
        // dir. Gated on `owned` so a failed mkdir can never delete the lock
        // directory another writer is holding.
        try { fs.rmdirSync(lockDir); } catch (_) {}
        throw error;
      }
      // Windows reports EPERM (sometimes EACCES) instead of EEXIST when mkdir
      // races the rmdir a releasing writer is doing: the directory sits in
      // pending-delete state, where it neither exists nor can be created.
      // Treating that as fatal killed a contended writer with exit 1 —
      // observed as `EPERM: operation not permitted, mkdir '<hash>.lock'` under
      // 20 concurrent writers on windows-latest — when it is contention, the
      // one thing this loop already knows how to wait out.
      const contended = error.code === 'EEXIST'
        || (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES'));
      if (!contended) throw error;
      if (removeStaleFragmentLock(lockDir, ttlMs)) {
        attempt--;
        continue;
      }
      if (attempt < attempts - 1) sleepSync(Math.min(50, 5 + attempt));
    }
  }
  throw new Error(`memory fragment lock contention: ${fpath}`);
}

function readQueryFile(cwd, filename) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const realCwd = fs.realpathSync(resolvedCwd);
  const target = path.resolve(resolvedCwd, filename);
  if (!isWithin(resolvedCwd, target)) {
    throw new Error(`--query-file path must stay inside cwd: ${target}`);
  }
  const realTarget = fs.realpathSync(target);
  if (!isWithin(realCwd, realTarget)) {
    throw new Error(`--query-file path must stay inside cwd: ${realTarget}`);
  }
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error(`--query-file is not a file: ${realTarget}`);
  if (stat.size > MAX_QUERY_BYTES) {
    throw new Error(`--query-file exceeds ${MAX_QUERY_BYTES} bytes`);
  }
  return fs.readFileSync(realTarget, 'utf8');
}

// ── memoryDir ─────────────────────────────────────────────────────────────────
// Returns the absolute path to the memory directory for a given cwd.
function memoryDir(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.gsd', 'memory');
}

// ── validateUnitId ────────────────────────────────────────────────────────────
// Returns true if id is a valid unit ID for a MEMORY fragment.
// Accepts four shapes:
//   1. Milestone IDs (via forge-ids.isValid + entityKind === 'milestone')
//   2. Task IDs     (via forge-ids.isValid + entityKind === 'task')
//   3. Milestone-local slice/task IDs (S## / T## / T##.N)
//   4. ask-<session-id> literals (^ask-[A-Za-z0-9._-]+$)
function validateUnitId(id) {
  if (!id) return false;
  // Shape 4: forge-ask session
  if (ASK_ID_RE.test(id)) return true;
  // Shape 3: milestone-local unit IDs used by forge-auto/forge-next.
  if (LOCAL_UNIT_ID_RE.test(id)) return true;
  // Shapes 1 & 2: delegate to forge-ids.
  if (!isValid(id)) return false;
  const kind = entityKind(id);
  return kind === 'milestone' || kind === 'task';
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a unit ID.
// Throws if the ID is not a valid memory unit ID.
function fragmentPath(cwd, unitId, opts) {
  if (!validateUnitId(unitId)) {
    throw new Error(
      `Invalid memory unit ID: "${unitId}". ` +
      'Expected a milestone ID (M###, M-<ts>-<slug>), ' +
      'task ID (TASK-###, T-<ts>-<slug>), local S##/T##/T##.N, ' +
      'or ask-<session-id>.'
    );
  }
  const milestoneId = milestoneFromOptions(opts);
  const storageKey = qualifiedStorageKey(unitId, milestoneId);
  return path.join(memoryDir(cwd), `${storageKey}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a MEMORY fragment markdown file (YAML frontmatter + body).
// The `facts:` key holds a block array of objects, each with keys:
//   { mem_id, category, text, created_at, source_unit }
// The `stats:` key holds a block array of stat event objects, each with keys:
//   { kind, mem_id, ts, ...payload }
// Decay is computed on-projection — NOT manufactured as events here.
// Unknown frontmatter keys are passed through as-is.
// Accepts both inline ([...]) and block (- item) array forms.
// Uses yamlSafe.parseScalar for scalar values (supports block-scalar `|` form).
// EOL: this parser feeds writeFragment's read-modify-write (parseFragment →
// mergeFacts/mergeStats → serializeFrontmatter → writeAtomic). Normalising CRLF→LF
// here would silently rewrite every line of a Windows-authored .gsd/memory fragment
// (D-S03-2). So the anchors are made TOLERANT, never normalising; the EOL actually
// observed is captured by writeFragment from the same bytes and re-emitted.
function parseFragment(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      unit_id: null,
      facts: [],
      stats: [],
      body: text.trim(),
    };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  const OBJECT_ARRAY_KEYS = new Set(['facts', 'stats']);

  const lines = frontmatter.split(/\r\n|\n|\r/);
  let currentKey = null;
  let currentArray = null;
  let inObjectArray = false;
  let currentObject = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of an object array item: "  - key: value" or "- key: value"
    const objectItemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (objectItemStart && currentKey && OBJECT_ARRAY_KEYS.has(currentKey) && Array.isArray(result[currentKey])) {
      // Save previous object
      if (currentObject !== null) {
        result[currentKey].push(currentObject);
      }
      currentObject = {};
      const key = objectItemStart[2];
      const rawVal = objectItemStart[3].trim();
      // Build a synthetic lines slice for parseScalar: value line + subsequent lines
      // baseIndent for nested object items is 4 (they are indented under "  - ")
      const syntheticLines = [rawVal].concat(lines.slice(i + 1));
      const parsed = yamlSafe.parseScalar(syntheticLines, 0, 4);
      currentObject[key] = parsed.value;
      // Advance i by however many extra lines were consumed (parsed.nextIndex - 1
      // because the for-loop will add 1 on next iteration)
      i += parsed.nextIndex - 1;
      inObjectArray = true;
      currentArray = null;
      continue;
    }

    // Continuation of an object item: "    key: value"
    if (inObjectArray && currentObject !== null) {
      const objKv = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (objKv) {
        const rawVal = objKv[2].trim();
        const syntheticLines = [rawVal].concat(lines.slice(i + 1));
        const parsed = yamlSafe.parseScalar(syntheticLines, 0, 4);
        currentObject[objKv[1]] = parsed.value;
        i += parsed.nextIndex - 1;
        continue;
      }
      // Unindented or non-kv line ends the current object
      if (currentObject !== null) {
        result[currentKey].push(currentObject);
        currentObject = null;
        inObjectArray = false;
      }
    }

    // Plain block array item: "  - value" or "- value" (non-object arrays)
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArray !== null && currentKey && !OBJECT_ARRAY_KEYS.has(currentKey)) {
      currentArray.push(arrayItem[1].trim());
      continue;
    }

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      if (OBJECT_ARRAY_KEYS.has(key)) {
        result[key] = [];
        currentKey = key;
        currentArray = null;
        currentObject = null;
        inObjectArray = false;
        continue;
      }

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        currentArray = null;
        inObjectArray = false;
      } else if (rawVal === '') {
        // Could be a block array starting next, or a block scalar `|`
        // Peek ahead: if next line starts with `- ` it's a block array;
        // if it starts with `|`, use parseScalar for block scalar.
        // For simplicity, treat empty value as block-array start (existing behavior).
        // Block scalar `|` is handled by parseScalar when rawVal === '|'.
        result[key] = [];
        currentKey = key;
        currentArray = result[key];
        inObjectArray = false;
      } else {
        // Use parseScalar to handle plain, quoted, and block-scalar forms
        const syntheticLines = [rawVal].concat(lines.slice(i + 1));
        const parsed = yamlSafe.parseScalar(syntheticLines, 0, 0);
        result[key] = parsed.value;
        i += parsed.nextIndex - 1;
        currentKey = key;
        currentArray = null;
        inObjectArray = false;
      }
      continue;
    }

    // Unrecognized line — flush pending object and reset context
    if (currentObject !== null) {
      result[currentKey].push(currentObject);
      currentObject = null;
    }
    inObjectArray = false;
    currentArray = null;
  }

  // Flush trailing object
  if (currentObject !== null) {
    result[currentKey].push(currentObject);
  }

  // Ensure facts and stats are always arrays
  if (!Array.isArray(result['facts'])) result['facts'] = [];
  if (!Array.isArray(result['stats'])) result['stats'] = [];

  result.unit_id = result.unit_id || null;
  result.body = body;

  return result;
}

// ── factHash ──────────────────────────────────────────────────────────────────
// Stable hash for a fact's mem_id — primary dedup key.
// Same mem_id is always the same fact: re-writing is a no-op.
function factHash(f) {
  return String(f.mem_id || '');
}

// ── statHash ─────────────────────────────────────────────────────────────────
// Stable SHA1 hash for a stat event's (kind, mem_id, ts) dedup tuple.
function statHash(s) {
  const raw = [s.kind || '', s.mem_id || '', s.ts || ''].join('\x00');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── mergeFacts ────────────────────────────────────────────────────────────────
// Merges two arrays of fact objects.
// Dedup by mem_id — existing fact fields are NEVER mutated.
// New facts are appended; result sorted by created_at ASC then mem_id for stability.
function mergeFacts(existing, incoming) {
  const seen = new Set(existing.map(factHash));
  const merged = [...existing];

  for (const f of incoming) {
    const h = factHash(f);
    if (h && !seen.has(h)) {
      seen.add(h);
      merged.push(f);
    }
  }

  merged.sort((a, b) => {
    const ca = String(a.created_at || '');
    const cb = String(b.created_at || '');
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return String(a.mem_id || '').localeCompare(String(b.mem_id || ''));
  });

  return merged;
}

// ── mergeStats ────────────────────────────────────────────────────────────────
// Merges two arrays of stat event objects.
// Dedup by SHA1(kind, mem_id, ts) — re-writing the same event is a no-op.
// Result sorted by ts ASC then by hash for stability.
function mergeStats(existing, incoming) {
  const seen = new Set(existing.map(statHash));
  const merged = [...existing];

  for (const s of incoming) {
    const h = statHash(s);
    if (!seen.has(h)) {
      seen.add(h);
      merged.push(s);
    }
  }

  merged.sort((a, b) => {
    const ta = String(a.ts || '');
    const tb = String(b.ts || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return statHash(a).localeCompare(statHash(b));
  });

  return merged;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes a fragment object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// `facts` and `stats` use block-of-objects form.
// Simple arrays use block form. Scalars use yamlSafe.serializeScalar.
// `eol` is the line ending captured from the fragment already on disk (Form B —
// the writer re-emits the operator's bytes, it does not impose LF). Defaults to LF
// for a fragment that does not exist yet, where there is nothing to preserve.
function serializeFrontmatter(fragment, eol) {
  const nl = eol || '\n';
  const skip = new Set(['body']);
  const keys = Object.keys(fragment).filter(k => !skip.has(k)).sort();

  const FACT_KEYS = ['mem_id', 'category', 'text', 'created_at', 'source_unit'];
  const STAT_KEYS = ['kind', 'mem_id', 'ts'];

  const lines = [];
  for (const key of keys) {
    const val = fragment[key];

    if (key === 'facts') {
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('facts: []');
      } else {
        lines.push('facts:');
        for (const f of val) {
          // Canonical keys first, then extras alphabetically
          const allKeys = [
            ...FACT_KEYS.filter(k => k in f),
            ...Object.keys(f).filter(k => !FACT_KEYS.includes(k)).sort(),
          ];
          let first = true;
          for (const fk of allKeys) {
            const prefix = first ? '  - ' : '    ';
            const fv = f[fk] !== undefined && f[fk] !== null ? f[fk] : '';
            // Nested object items are at indent level 4 (under "  - ")
            lines.push(`${prefix}${fk}: ${yamlSafe.serializeScalar(String(fv), 4)}`);
            first = false;
          }
        }
      }
      continue;
    }

    if (key === 'stats') {
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('stats: []');
      } else {
        lines.push('stats:');
        for (const s of val) {
          // Canonical keys first (kind, mem_id, ts), then extras alphabetically
          const extraKeys = Object.keys(s).filter(k => !STAT_KEYS.includes(k)).sort();
          const allKeys = [
            ...STAT_KEYS.filter(k => k in s),
            ...extraKeys,
          ];
          let first = true;
          for (const sk of allKeys) {
            const prefix = first ? '  - ' : '    ';
            const sv = s[sk] !== undefined && s[sk] !== null ? s[sk] : '';
            lines.push(`${prefix}${sk}: ${yamlSafe.serializeScalar(String(sv), 4)}`);
            first = false;
          }
        }
      }
      continue;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (val === null || val === undefined) {
      lines.push(`${key}: `);
    } else {
      lines.push(`${key}: ${yamlSafe.serializeScalar(String(val), 0)}`);
    }
  }
  // Block scalars produced by yamlSafe.serializeScalar are internally LF-joined;
  // re-emit them with the captured EOL too, so the file the writer produces is not
  // half CRLF and half LF. `/\r\n?|\n/` — a lone CR degrades the same way (measured).
  const out = lines.join(nl);
  return nl === '\n' ? out : out.replace(/\r\n?|\n/g, nl);
}

// Returns the listFragments envelope whose storage key matches and which is
// grouped (i.e. lives inside a container), or null.  The match is on the exact
// qualified storage key, mirroring readFragment's lookup: a bare `T01` never
// matches a member stored as `M-…__T01`.
//
// A failure to list is deliberately NOT swallowed into "no member": treating an
// unreadable store as clean is what would let a shadowing write through on the
// one occasion the answer mattered.
function detectGroupedMember(cwd, storageKey, opts) {
  return listFragments(cwd, opts)
    .find(item => item.storageKey === storageKey && item.grouped === true) || null;
}

// ── writeFragment ─────────────────────────────────────────────────────────────
// Writes a MEMORY fragment to disk.
// fragment shape: { unit_id, facts?: [...], stats?: [...], ...rest }
// opts shape: { runId?, sessionId?, milestoneId? }. For local S##/T## IDs,
// milestoneId qualifies the physical fragment and prevents cross-milestone collisions.
// Merges with existing fragment if present.
//   - facts: dedup by mem_id; existing fact fields NEVER mutated (append-only).
//   - stats: dedup by SHA1(kind, mem_id, ts); append-only.
// Byte-compares after merge — skips write if content is identical (idempotent).
// Returns { path: string, created: boolean }
// created: false if content is identical after merge.
//
// One additive return shape exists: when the unit has no loose file and its
// canonical envelope lives inside a grouped container, the write is REFUSED by
// name rather than performed, and the return carries
//   { path, created: false, quarantined: true, reason: 'grouped-member',
//     container, remedy }
// where `path` points at the quarantine record (where the bytes actually live),
// not at the store.  Refusing is not an error: writing the loose file would
// shadow the grouped member on the next read, and throwing would turn a
// successful sweep into a failed milestone on a hot path.  Consumers that do
// not know the field ignore it, as with every other additive field here.
function writeFragment(cwd, fragment, opts) {
  opts = opts || {};
  // Refuse before validation, lock acquisition or merge — nothing reaches disk
  // and no lock is taken on a write that is going to be refused anyway.
  assertWriteHere(cwd);
  if (!fragment || !fragment.unit_id) {
    throw new Error('fragment.unit_id is required');
  }

  const optionMilestone = milestoneFromOptions(opts);
  const payloadMilestone = fragment.milestone_id || null;
  if (optionMilestone && payloadMilestone && optionMilestone !== payloadMilestone) {
    throw new Error(`Conflicting memory milestone IDs: "${optionMilestone}" and "${payloadMilestone}"`);
  }
  const milestoneId = optionMilestone || payloadMilestone;
  if (milestoneId && !validateMilestoneId(milestoneId)) {
    throw new Error(`Invalid memory milestone ID: "${milestoneId}"`);
  }
  const fpath = fragmentPath(cwd, fragment.unit_id, { milestoneId }); // throws if invalid id

  // Grouped-member refusal — before assertMemoryDirectory(create) and before
  // the lock, so a refused write takes no lock and merges nothing: NO fragment
  // is written to the store, and the fragment path itself is never touched.
  // What the refusal DOES write is the quarantine sidecar: quarantineFragment
  // mkdir -p's <memoryDir>/quarantine and parks the refused fact there, so the
  // bytes are recoverable instead of lost.  That single sidecar file is the only
  // byte written under .gsd/memory/ on this path — an earlier revision of this
  // comment claimed none at all, which the code has never done.
  //
  // The loose file wins whenever it exists: this mirrors grouped-survivor in
  // forge-memory-rewrite.js — refuse only when the canonical envelope is the
  // grouped one.  A loose file coexisting with a same-keyed container is the
  // ordinary merge case and stays exactly as it was.
  if (!fs.existsSync(fpath)) {
    const storageKey = qualifiedStorageKey(fragment.unit_id, milestoneId);
    const member = detectGroupedMember(cwd, storageKey, { milestoneId });
    if (member) {
      const remedy = `forge-sweep-project --undo ${member.path} → editar → reagrupar`;
      const { quarantineFragment } = require('./forge-memory-quarantine');
      const parked = quarantineFragment(cwd, fragment, {
        storageKey,
        unitId: fragment.unit_id,
        milestoneId: milestoneId || null,
        container: member.path,
        reason: 'grouped-member',
        remedy,
      });
      process.stderr.write(
        `[forge-memory] recusa: unidade ${storageKey} vive no container ${member.path} — `
        + `fato em quarentena: ${parked.path}. Remédio: ${remedy}\n`
      );
      return {
        path: parked.path,
        created: false,
        quarantined: true,
        reason: 'grouped-member',
        container: member.path,
        remedy,
      };
    }
  }

  // mkdir -p, then resolve the directory to prevent a .gsd/memory symlink
  // from redirecting writes outside the workspace.
  assertMemoryDirectory(cwd, true);
  const transactionLock = acquireFragmentLock(cwd, fpath, opts);
  try {
    if (fs.existsSync(fpath)) {
      const targetStat = fs.lstatSync(fpath);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
        throw new Error(`Refusing to merge non-regular memory fragment: ${fpath}`);
      }
    }

    // Read and merge only after acquiring the transaction lock. This is what
    // prevents two background forge-memory agents from both merging stale data.
    let base;
    // Form B: capture the EOL of the fragment already on disk and re-emit it below.
    // A fragment authored on Windows stays CRLF; a new one is written LF.
    let eol = '\n';
    if (fs.existsSync(fpath)) {
      const rawExisting = fs.readFileSync(fpath, 'utf8');
      eol = (rawExisting.match(/\r\n|\n|\r/) || ['\n'])[0];
      const existing = parseFragment(rawExisting);
      const existingFacts = Array.isArray(existing.facts) ? existing.facts : [];
      const incomingFacts = Array.isArray(fragment.facts) ? fragment.facts : [];
      const existingStats = Array.isArray(existing.stats) ? existing.stats : [];
      const incomingStats = Array.isArray(fragment.stats) ? fragment.stats : [];
      const mergedFacts = mergeFacts(existingFacts, incomingFacts);
      const mergedStats = mergeStats(existingStats, incomingStats);
      base = { ...existing, ...fragment, facts: mergedFacts, stats: mergedStats };
    } else {
      const facts = Array.isArray(fragment.facts) ? mergeFacts([], fragment.facts) : [];
      const stats = Array.isArray(fragment.stats) ? mergeStats([], fragment.stats) : [];
      base = { ...fragment, facts, stats };
    }
    if (milestoneId) base.milestone_id = milestoneId;

    const frontmatter = serializeFrontmatter(base, eol);
    const rawBody = base.body ? `${eol}${base.body}` : '';
    const body = eol === '\n' ? rawBody : rawBody.replace(/\r\n?|\n/g, eol);
    const content = `---${eol}${frontmatter}${eol}---${eol}${body}`;

    if (fs.existsSync(fpath) && fs.readFileSync(fpath, 'utf8') === content) {
      return { path: fpath, created: false };
    }

    yamlSafe.writeAtomic(fpath, content, {
      cwd,
      runId: opts.runId || null,
      sessionId: opts.sessionId || null,
    });
    return { path: fpath, created: true };
  } finally {
    transactionLock.release();
  }
}

// ── readFragment ──────────────────────────────────────────────────────────────
// Reads and parses a MEMORY fragment. Returns null if the file does not exist.
function readFragment(cwd, unitId, opts) {
  guardReadHere(cwd);
  let fpath;
  try {
    fpath = fragmentPath(cwd, unitId, opts);
  } catch (e) {
    throw e; // propagate invalid id error
  }

  if (fs.existsSync(fpath)) {
    assertMemoryDirectory(cwd, false);
    const targetStat = fs.lstatSync(fpath);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Refusing to read non-regular memory fragment: ${fpath}`);
    }
    return parseFragment(fs.readFileSync(fpath, 'utf8'));
  }

  // A grouped container has no per-unit path.  Find its expanded envelope only
  // after the ordinary loose-file lookup so a newly written loose fragment wins.
  const storageKey = qualifiedStorageKey(unitId, milestoneFromOptions(opts));
  const entry = listFragments(cwd, opts).find(item => item.storageKey === storageKey);
  return entry ? parseFragment(readFragmentText(cwd, entry)) : null;
}

// Reads the payload represented by one listFragments() envelope. Grouped
// envelopes all point at the physical container, so reading entry.path directly
// would incorrectly return every member rather than this unit.
function readFragmentText(cwd, entry) {
  if (!entry || !entry.path) throw new Error('memory fragment entry is required');
  if (!entry.grouped) return fs.readFileSync(entry.path, 'utf8');
  const parsed = readGroupedUnits(entry.path);
  const unit = parsed.units.find(item => item.id === entry.storageKey);
  if (!unit) throw new Error(`Grouped memory unit not found: ${entry.storageKey}`);
  return unitTextOf(unit.content);
}

// ── listFragments ─────────────────────────────────────────────────────────────
// Lists all fragment files in the memory directory.
// Returns Array<{ storageKey, unitId, milestoneId, path }> sorted by storageKey.
// Returns [] if the directory does not exist.
function listFragments(cwd, opts) {
  guardReadHere(cwd);
  const dir = assertMemoryDirectory(cwd, false);
  if (!dir) return [];

  const milestoneId = milestoneFromOptions(opts);
  if (milestoneId && !validateMilestoneId(milestoneId)) {
    throw new Error(`Invalid memory milestone ID: "${milestoneId}"`);
  }

  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'));
  const looseKeys = new Set();
  const fragments = [];

  for (const file of files) {
    const filePath = path.join(dir, file.name);
    // A failed sniff (null) means "not classified as a container": the entry is
    // still returned and the read error stays with the consumer, one unit at a
    // time, as it did before grouping existed. See readSniffBuffer.
    const buffer = readSniffBuffer(filePath);
    // Unreadable AND epoch-shaped: pushing it as a loose fragment named
    // `2026-Q1` would make every unit inside it vanish with nothing on stderr.
    if (buffer === null && isGroupedFile(file.name)) {
      process.stderr.write(`[forge-memory] warn: container ${file.name}: container-unreadable — unidades não listadas\n`);
      continue;
    }
    if (buffer !== null && isGroupedFile(file.name, buffer)) continue;
    const parsed = parseStorageKey(file.name.slice(0, -3));
    if (!parsed) continue;
    looseKeys.add(parsed.storageKey);
    fragments.push({ ...parsed, path: filePath, grouped: false, epoch: null });
  }

  for (const file of files) {
    const filePath = path.join(dir, file.name);
    const buffer = readSniffBuffer(filePath);
    if (buffer === null || !isGroupedFile(file.name, buffer)) continue;
    const grouped = readGroupedUnits(filePath);
    for (const error of grouped.errors) {
      process.stderr.write(`[forge-memory] warn: container ${file.name} id ${error.id || '<unknown>'}: ${error.reason}\n`);
    }
    for (const member of grouped.units) {
      const parsed = parseStorageKey(member.id);
      if (!parsed) {
        process.stderr.write(`[forge-memory] warn: container ${file.name} id ${member.id}: invalid storage key; discarded\n`);
        continue;
      }
      if (looseKeys.has(parsed.storageKey)) {
        process.stderr.write(`[forge-memory] warn: unidade ${member.id} existe solta e em ${file.name} — usando a solta\n`);
        continue;
      }
      fragments.push({ ...parsed, path: filePath, grouped: true, epoch: grouped.epoch });
    }
  }

  const filtered = milestoneId
    ? fragments.filter(fragment => fragment.milestoneId === milestoneId)
    : fragments;
  filtered.sort((a, b) => a.storageKey.localeCompare(b.storageKey));

  return filtered;
}

// Trusted in-process selector seam consumed by forge-prompt.js.  The lazy
// require avoids the forge-memory <-> forge-projection module cycle.
function queryRelevant(query) {
  if (!query || typeof query !== 'object') throw new Error('memory query must be an object');
  // Module-boundary guard (forge-prompt.js:306 calls this directly). The
  // delegate below guards too; the dedupe Set in forge-schema-guard collapses
  // both into a single stderr emission per cwd.
  guardReadHere(query.cwd || process.cwd());
  const { queryMemoryEntries } = require('./forge-projection');
  return queryMemoryEntries(query.cwd || process.cwd(), {
    unitType: query.unitType,
    query: query.query,
    limit: query.limit,
    maxTokens: query.maxTokens,
    nowMs: query.nowMs,
  });
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  MEMORY_DIR,
  memoryDir,
  fragmentPath,
  qualifiedStorageKey,
  parseStorageKey,
  parseFragment,
  serializeFrontmatter,
  writeFragment,
  readFragment,
  readFragmentText,
  listFragments,
  validateUnitId,
  validateMilestoneId,
  queryRelevant,
  ASK_ID_RE,
  _private: { detectGroupedMember },
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-memory.js <command> [options]

Commands:
  --list [--milestone <id>] [--cwd <dir>] List all memory fragments (JSON array)
  --read <unit-id> [--milestone <id>]     Read and print a fragment (JSON), null if missing
  --write [--milestone <id>]              Write/merge fragment from stdin (JSON fragment)
  --validate <unit-id> [--milestone <id>] Validate ID and check if fragment exists
  --query|--select [options] [--cwd <dir>]
                                          Select relevant memories deterministically
  --help, -h                              Show this help

Unit ID forms accepted:
  M###, M-<ts>-<slug>            Milestone IDs
  TASK-###, T-<ts>-<slug>        Task IDs
  S##, T##, T##.N                Milestone-local slice/task IDs
  ask-<session-id>               forge-ask session IDs

Options:
  --cwd <dir>                 Working directory (default: process.cwd())
  --milestone <id>            Namespace local S##/T## fragments by milestone
  --unit-type <type>          Query phase, e.g. execute-task or plan-slice
  --text <query>              Query text (prefer --query-file for long plans)
  --query-file <path>         Read query text from inside --cwd (max 512 KiB)
  --limit <n>                 Maximum entries (default: 8, max: 50)
  --max-tokens <n>            chars/4 output budget (default: 2000, max: 16000)
  --format json|markdown      Output shape (default: json)

Exit codes:
  0  Success
  1  Runtime error (invalid id, parse error, I/O failure)
  2  Unknown or missing arguments`);
}

function cliMain(argv) {
  // Parse --cwd
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  let milestoneId = null;
  const milestoneIdx = argv.indexOf('--milestone');
  if (milestoneIdx !== -1) {
    milestoneId = argv[milestoneIdx + 1];
    if (!milestoneId || milestoneId.startsWith('--')) {
      process.stderr.write('--milestone requires a milestone ID\n');
      process.exit(2);
    }
    if (!validateMilestoneId(milestoneId)) {
      process.stderr.write(`Invalid memory milestone ID: "${milestoneId}"\n`);
      process.exit(1);
    }
    argv = argv.filter((_, i) => i !== milestoneIdx && i !== milestoneIdx + 1);
  }

  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === '--list') {
    // Bare JSON ARRAY — data, not an envelope, and the one array output with
    // live consumers (skills/forge-auto, forge-next, forge-sweep iterate it).
    // No schema_partial key: the partial signal travels on stderr only,
    // emitted inside listFragments. --query/--select DO carry the fields.
    // Projected through publicEntry for the same reason as forge-ledger.js:
    // rich library entries, frozen CLI row keys, one shared projection. The
    // removal-based projection matters most here — this store's stable keys
    // come from parseStorageKey, so a whitelist would drop them.
    const result = listFragments(cwd, { milestoneId }).map(publicEntry);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires a unit ID\n');
      process.exit(2);
    }
    const fragment = readFragment(cwd, id, { milestoneId });
    console.log(JSON.stringify(fragment));
    process.exit(0);
  }

  if (cmd === '--hit') {
    // Records kind:'hit' stat events on the owning fragments for facts that
    // were actually INJECTED into a worker prompt. This is the usage signal
    // the ranking (confidence × max(1, hits)) was designed around and never
    // received: measured before this existed, all 71 facts in this repo's
    // store carried hits: 0 — selection had no feedback loop.
    //
    // stdin: the --select/--query result envelope ({entries:[...]}) or a bare
    // array of {unit_id, mem_id, milestone_id?}. Piping --select's own output
    // back in is the intended idiom — no second lookup of who owns which fact.
    // Advisory by contract: per-owner failures are reported in `skipped`, the
    // exit is 0 unless the stdin payload itself is unusable.
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
      process.stderr.write(`--hit: unparseable stdin payload (${e.message})\n`);
      process.exit(1);
    }
    const entries = Array.isArray(payload) ? payload
      : (payload && Array.isArray(payload.entries)) ? payload.entries : null;
    if (entries === null) {
      process.stderr.write('--hit expects a JSON array or a --select envelope ({entries:[...]}) on stdin\n');
      process.exit(1);
    }
    const ts = new Date().toISOString();
    const byOwner = new Map();
    const skipped = [];
    for (const entry of entries) {
      const unitId = entry && String(entry.unit_id || '').trim();
      const memId = entry && String(entry.mem_id || '').trim();
      if (!unitId || !memId) {
        skipped.push({ entry, reason: 'missing-unit-or-mem-id' });
        continue;
      }
      const owner = `${unitId}\u0000${entry.milestone_id || ''}`;
      if (!byOwner.has(owner)) {
        byOwner.set(owner, { unit_id: unitId, milestone_id: entry.milestone_id || null, stats: [] });
      }
      byOwner.get(owner).stats.push({ kind: 'hit', mem_id: memId, ts });
    }
    const fragments = [];
    let recorded = 0;
    for (const owner of byOwner.values()) {
      try {
        const fragment = { unit_id: owner.unit_id, facts: [], stats: owner.stats };
        if (owner.milestone_id) fragment.milestone_id = owner.milestone_id;
        const written = writeFragment(cwd, fragment, {});
        const landed = written && !written.quarantined;
        if (landed) recorded += owner.stats.length;
        fragments.push({ unit_id: owner.unit_id, hits: owner.stats.length, landed });
      } catch (e) {
        skipped.push({ unit_id: owner.unit_id, reason: e.message });
      }
    }
    console.log(JSON.stringify({ recorded, fragments, skipped }));
    process.exit(0);
  }

  if (cmd === '--query' || cmd === '--select') {
    const allowedOptions = new Set([
      '--unit-type', '--text', '--query-file', '--limit', '--max-tokens', '--format',
    ]);
    for (let i = 1; i < argv.length; i += 2) {
      const name = argv[i];
      const value = argv[i + 1];
      if (!allowedOptions.has(name)) throw new Error(`Unknown query option: ${name}`);
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    }
    const option = (name, fallback) => {
      const idx = argv.indexOf(name);
      if (idx === -1) return fallback;
      const value = argv[idx + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    };

    let result;
    try {
      const unitType = option('--unit-type', 'other');
      const queryFile = option('--query-file', null);
      let query = option('--text', '');
      if (queryFile) {
        query = readQueryFile(cwd, queryFile);
      }
      if (query.includes('\0')) throw new Error('query text must not contain NUL bytes');
      if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
        throw new Error(`query text exceeds ${MAX_QUERY_BYTES} bytes`);
      }
      const limit = option('--limit', '8');
      const maxTokens = option('--max-tokens', '2000');
      const format = option('--format', 'json').toLowerCase();
      if (!['json', 'markdown'].includes(format)) {
        throw new Error('--format must be json or markdown');
      }

      // Lazy require avoids a top-level forge-memory <-> forge-projection cycle.
      const { queryMemoryEntries } = require('./forge-projection');
      result = queryMemoryEntries(cwd, { unitType, query, limit, maxTokens });
      if (format === 'markdown') process.stdout.write(result.markdown + '\n');
      else console.log(JSON.stringify(result));
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (cmd === '--write') {
    // Read JSON fragment from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      let fragment;
      try {
        fragment = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
        process.exit(1);
      }
      let result;
      try {
        result = writeFragment(cwd, fragment, { milestoneId });
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a unit ID\n');
      process.exit(2);
    }
    let exists = false;
    let existsError = null;
    try {
      const fpath = fragmentPath(cwd, id, { milestoneId });
      exists = fs.existsSync(fpath);
    } catch (e) {
      existsError = e.message;
    }
    const result = {
      id,
      valid: validateUnitId(id),
      exists: existsError ? false : exists,
    };
    if (existsError) result.error = existsError;
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Unknown command
  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
}

// ── Inline regression smoke ───────────────────────────────────────────────────
// Verifies multi-line round-trip AND forge-projection.js renderMemory regression.
// Usage: node scripts/forge-memory.js --smoke-regression
if (require.main === module && process.argv[2] === '--smoke-regression') {
  const os = require('os');
  let allPassed = true;

  function smokeAssert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + ' | expected=' + JSON.stringify(expected) + ' got=' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  const smokeDir = path.join(process.cwd(), '.gsd-smoke-t03');
  try {
    // ── A: multi-line round-trip ──────────────────────────────────────────────
    const multiLineText = 'line1\nline2\nline3';
    const fragment = {
      unit_id: 'M-20260527000000-smoke',
      facts: [{
        mem_id: 'SMOKE-001',
        category: 'pattern',
        text: multiLineText,
        created_at: '2026-05-27',
        source_unit: 'M-20260527000000-smoke',
      }],
      stats: [],
    };

    // 2-arg form (back-compat)
    const writeResult = writeFragment(smokeDir, fragment);
    smokeAssert('A: writeFragment returns path', typeof writeResult.path, 'string');
    smokeAssert('A: writeFragment returns created:true on first write', writeResult.created, true);

    // Read back via readFragment
    const readBack = readFragment(smokeDir, 'M-20260527000000-smoke');
    smokeAssert('A: readFragment returns object', readBack !== null, true);
    const roundTrippedText = readBack && readBack.facts && readBack.facts[0] && readBack.facts[0].text;
    smokeAssert('A: multi-line round-trip exact', roundTrippedText, multiLineText);

    // ── B: leading-[ round-trip ───────────────────────────────────────────────
    const bracketFragment = {
      unit_id: 'M-20260527000001-smoke',
      facts: [{
        mem_id: 'SMOKE-002',
        category: 'note',
        text: '[brackets',
        created_at: '2026-05-27',
        source_unit: 'M-20260527000001-smoke',
      }],
      stats: [],
    };
    writeFragment(smokeDir, bracketFragment);
    const bracketRead = readFragment(smokeDir, 'M-20260527000001-smoke');
    const bracketText = bracketRead && bracketRead.facts && bracketRead.facts[0] && bracketRead.facts[0].text;
    smokeAssert('B: [bracket round-trip exact', bracketText, '[brackets');

    // ── C: idempotent re-write returns created:false ──────────────────────────
    const writeResult2 = writeFragment(smokeDir, fragment);
    smokeAssert('C: idempotent re-write returns created:false', writeResult2.created, false);

    // ── D: 3-arg form with runId/sessionId ───────────────────────────────────
    const fragment3arg = {
      unit_id: 'M-20260527000002-smoke',
      facts: [{
        mem_id: 'SMOKE-003',
        category: 'pattern',
        text: 'three arg test',
        created_at: '2026-05-27',
        source_unit: 'M-20260527000002-smoke',
      }],
      stats: [],
    };
    const r3 = writeFragment(smokeDir, fragment3arg, { runId: 'test-run-001', sessionId: 'test-sess-001' });
    smokeAssert('D: 3-arg writeFragment returns created:true', r3.created, true);

    // ── E: forge-projection.js renderMemory regression smoke ─────────────────
    let renderMemory;
    try {
      const projection = require('./forge-projection');
      renderMemory = projection.renderMemory;
    } catch (e) {
      console.log('WARN: forge-projection.js not loadable: ' + e.message + ' — skipping renderMemory regression');
      renderMemory = null;
    }

    if (renderMemory) {
      let renderOutput;
      let renderThrew = false;
      try {
        renderOutput = renderMemory(smokeDir);
      } catch (e) {
        renderThrew = true;
        console.log('FAIL: E: renderMemory threw: ' + e.message);
        allPassed = false;
      }
      if (!renderThrew) {
        smokeAssert('E: renderMemory returns non-empty string', typeof renderOutput === 'string' && renderOutput.length > 0, true);
        // The multi-line content should appear in some form in the output
        // renderMemory joins lines with \n or emits them as-is — we check for at least one segment
        const hasContent = typeof renderOutput === 'string' && renderOutput.includes('line1');
        smokeAssert('E: renderMemory output contains multi-line content', hasContent, true);
      }
    }

  } finally {
    // Cleanup smoke dir
    try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch {}
  }

  if (allPassed) {
    console.log('\nSMOKE-REGRESSION: PASS');
    process.exit(0);
  } else {
    console.log('\nSMOKE-REGRESSION: FAIL');
    process.exit(1);
  }
}

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
