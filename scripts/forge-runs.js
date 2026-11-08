#!/usr/bin/env node
// forge-runs — Runs registry CRUD for multi-run workspace
//
// Manages .gsd/forge/runs/{id}.json — the truth source for active Forge orchestrators
// in a workspace. See shared/forge-state.md §2 for schema.
//
// Library exports (require from other scripts):
//   listAll(cwd) / listActive(cwd) / get(cwd, id)
//   add(cwd, record) / update(cwd, id, patch) / remove(cwd, id)
//   bumpHeartbeat(cwd, id) / cleanupStale(cwd, thresholdMs)
//   resolveBySessionId(cwd, sessionId) / oldestActive(cwd)
//   refreshLegacyAlias(cwd) / migrateLegacyState(cwd)
//
// CLI usage (see --help):
//   node forge-runs.js --list
//   node forge-runs.js --add --id M065 --kind milestone --session abc --cwd <path>
//   node forge-runs.js --bump M065
//   node forge-runs.js --cleanup-stale
//   node forge-runs.js --migrate-legacy

'use strict';

const fs   = require('fs');
const path = require('path');
const ids  = require('./forge-ids.js');
const lock = require('./forge-lock.js');
const { normalizeHostRuntime } = require('./forge-runtime.js');

const STALE_THRESHOLD_MS  = 30 * 60 * 1000;   // 30min: garbage-collect
const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000;   // 15min: run "fresco" — Stop hook + statusline
const ALIAS_FILE         = 'auto-mode.json'; // legacy alias

function runsDir(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'runs');
}

/**
 * Create `.gsd/forge/runs/` — but only inside a directory that already has `.gsd/`.
 *
 * Fourth `.gsd/` manufacturer closed (see forge-lock.js:33-56 for the canonical
 * pattern and the camada-2 escape of 96b6e8c this mirrors). A bare
 * `mkdirSync(..., { recursive: true })` here would enroll any directory as a
 * Forge project the moment a run is registered against it. Creating `.gsd/` is
 * `/forge-init`'s job and nothing else's.
 */
function ensureRunsDir(cwd) {
  const gsd = path.join(cwd, '.gsd');
  if (!fs.existsSync(gsd)) {
    const err = new Error(
      `forge-runs: ${cwd} has no .gsd/ — refusing to create one (run /forge-init first)`);
    err.code = 'ENOGSD';
    throw err;
  }
  const dir = runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runFile(cwd, id) {
  return path.join(runsDir(cwd), `${id}.json`);
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * The run's ADDRESS fields — `branch`, `root`, `project` — defaulted to `null`
 * on read.
 *
 * They are additive: every record written before they existed (all 7 live ones
 * at the time of writing) is missing all three, and nothing migrates them. The
 * defaulting happens HERE, on read, rather than by rewriting files, so a record
 * on disk stays byte-identical until something has a real reason to write it.
 *
 * `null` and not `undefined` deliberately. `undefined` disappears through
 * `JSON.stringify` — a caller serialising a legacy record would emit an object
 * with no `branch` key at all, indistinguishable from "this run has no branch
 * field concept", which is the silence-vs-absence confusion this milestone
 * keeps paying for. `null` says "known field, no value".
 *
 * `''` (empty string) is normalized to `null` here too, not just `undefined`.
 * (S06/T04 review R3.) The `shared`-mode resume path in forge-auto/SKILL.md
 * interpolates an empty `$RUN_BRANCH` straight into a JSON patch string
 * (`"branch":"$RUN_BRANCH"` -> `"branch":""`), bypassing `add()`'s `|| null`
 * normalization entirely — `update()` is a bare `Object.assign` with no
 * normalization of its own. Without this, `''` would round-trip on disk as
 * `''`, and Swift's `public let branch: String?` decodes `""` as `.some("")`,
 * not `.none` — an `== nil` check on the client would misclassify a
 * shared-mode run as having a branch. Normalizing on READ (here, for both
 * `get()` and `listAll()`) converges both write paths (the interpolated
 * resume patch AND any future caller) without requiring every writer to
 * remember to normalize — the same reasoning that already justified doing
 * this for `undefined` instead of fixing every call site.
 *
 * Unknown keys are preserved untouched (spread first): a record written by a
 * newer Forge must survive a round-trip through an older reader.
 */
function withAddressDefaults(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  return Object.assign({}, rec, {
    branch:  (rec.branch  === undefined || rec.branch  === '') ? null : rec.branch,
    root:    (rec.root    === undefined || rec.root    === '') ? null : rec.root,
    project: (rec.project === undefined || rec.project === '') ? null : rec.project,
    // ── Unit-context axis (S01/T02) ──────────────────────────────────────────
    // `worker` is "UNIT_TYPE/UNIT_ID" and carries NO slice, so the evidence log
    // could never name the slice a tool call belonged to. `worker_slice` is the
    // missing third axis, additive by READ (default applied here) exactly like
    // branch/root/project above: live records in .gsd/forge/runs/ are never
    // rewritten, and SCHEMA-VERSION is not bumped.
    worker_slice: (rec.worker_slice === undefined || rec.worker_slice === '') ? null : rec.worker_slice,
    // ── Write-claim axis (S03/T01) ────────────────────────────────────────────
    // What the current unit declares it is about to write, plus the CODE_DIR
    // it is writing from as a GIVEN fact (never derived — see
    // forge-write-claim.js). Additive by READ exactly like the fields above:
    // live records in .gsd/forge/runs/ are never rewritten, no SCHEMA-VERSION
    // bump. `null` means "never claimed"; a recorded object (even with
    // `paths: []`) means "claimed, honestly empty" — the two must never
    // collapse (see forge-write-claim.js::readClaim).
    write_claim: (rec.write_claim === undefined || rec.write_claim === '') ? null : rec.write_claim,
  });
}

// Closed set. `id` is the basename without `.json` — the key the registry itself uses, so an
// unreadable record can still be NAMED by the census that reports it.
const UNPARSEABLE_REASONS = ['json-parse-failed', 'read-failed'];

/**
 * ADDITIVE (PR #110, finding 3). `listAll` used to `catch { return null }` + `.filter(Boolean)`, so
 * a truncated `runs/*.json` vanished BEFORE any consumer could count it — and `runs_examined`
 * downstream counted post-filter, making the census report a universe that silently shrank.
 *
 * This returns both halves. `listAll` stays byte-compatible as a wrapper over `parsed`: additive by
 * READING, no migration, no SCHEMA-VERSION bump, every existing caller unchanged.
 */
function listAllDetailed(cwd, limits) {
  if (limits) return boundedCensus(cwd, limits);
  const dir = runsDir(cwd);
  if (!fs.existsSync(dir)) return { parsed: [], unparseable: [] };
  const parsed = [];
  const unparseable = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, f);
    const id = path.basename(f, '.json');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
      unparseable.push({ id, file, reason: 'read-failed' });
      continue;
    }
    try {
      parsed.push(withAddressDefaults(JSON.parse(raw)));
    } catch (_) {
      unparseable.push({ id, file, reason: 'json-parse-failed' });
    }
  }
  return { parsed, unparseable };
}

// Ownership callers must bound the directory and every entry before payload I/O.
function boundedCensus(cwd, { maxRuns = 512, maxBytes = 64 * 1024 } = {}) {
  const dir = runsDir(cwd), parsed = [], unparseable = [];
  const unsafe = () => ({ parsed: [], unparseable: [{ reason: 'unsafe-registry' }] });
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 512 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) return unsafe();
  let handle;
  try {
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return unsafe();
    handle = fs.opendirSync(dir);
    const rows = []; let entry;
    while ((entry = handle.readSync())) {
      if (!entry.name.endsWith('.json')) continue;
      if (rows.length >= maxRuns) return unsafe();
      const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return unsafe();
      rows.push({ file, stat, id: path.basename(entry.name, '.json') });
    }
    const stable = (a, b) => b.isFile() && !b.isSymbolicLink() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
    for (const row of rows) if (!stable(row.stat, fs.lstatSync(row.file))) return unsafe();
    for (const row of rows) {
      if (!stable(row.stat, fs.lstatSync(row.file))) return unsafe();
      const io = Object.create(fs);
      io.openSync = file => {
        if (!stable(row.stat, fs.lstatSync(file))) throw new Error('unstable registry entry');
        return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
      };
      io.fstatSync = fd => {
        const stat = fs.fstatSync(fd);
        if (!stable(row.stat, stat)) throw new Error('unstable registry entry');
        return stat;
      };
      const read = require('./forge-autonomy-sources').readBoundedStableFile(row.file, maxBytes, { io, expectedReal: fs.realpathSync.native(row.file) });
      if (read.error || !stable(row.stat, fs.lstatSync(row.file))) return unsafe();
      try { parsed.push(withAddressDefaults(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)))); }
      catch { unparseable.push({ id: row.id, reason: 'json-parse-failed' }); }
    }
    const after = fs.lstatSync(dir);
    if (!after.isDirectory() || after.isSymbolicLink() || ['dev', 'ino', 'mtimeMs', 'ctimeMs'].some(k => directory[k] !== after[k])) return unsafe();
    return { parsed, unparseable };
  } catch (e) { return e.code === 'ENOENT' && !handle ? { parsed, unparseable } : unsafe(); }
  finally { if (handle) handle.closeSync(); }
}

function listAll(cwd) {
  return listAllDetailed(cwd).parsed;
}

function listActive(cwd) {
  return listAll(cwd).filter(r => r.active === true);
}

function get(cwd, id) {
  const f = runFile(cwd, id);
  if (!fs.existsSync(f)) return null;
  try { return withAddressDefaults(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  catch { return null; }
}

function resolveBySessionId(cwd, sessionId) {
  if (!sessionId) return null;
  return listActive(cwd).find(r => r.session_id === sessionId) || null;
}

// Host identity is observed only from this process, never selected from a run.
function observeHostSession(hostRuntime, expectedSession) {
  if (hostRuntime === 'claude') {
    const value = process.env.FORGE_CLAUDE_OWNER_SESSION_ID;
    return process.env.FORGE_CLAUDE_OWNER_SOURCE === 'claude-sessionstart-env-v1'
      && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
      && expectedSession === value ? { sessionId: value, hostRuntime: 'claude', source: 'claude-sessionstart-env-v1' } : null;
  }
  if (hostRuntime !== 'codex') return null;
  for (const source of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
    const value = process.env[source];
    if (typeof value === 'string' && value.trim() && value.length <= 1024 && !/[\r\n\0]/.test(value)) return { sessionId: value, hostRuntime: 'codex', source };
  }
  return null;
}

function validSessionOwner(owner) {
  return !!owner && typeof owner.sessionId === 'string' && owner.sessionId.trim() !== '' && ['claude', 'codex'].includes(owner.hostRuntime);
}

function matchesSessionOwner(record, owner) {
  return validSessionOwner(owner) && record?.active === true && record.session_id === owner.sessionId && record.host_runtime === owner.hostRuntime;
}

function resolveBySessionOwner(cwd, owner) {
  if (!validSessionOwner(owner)) return null;
  const census = boundedCensus(cwd);
  if (census.unparseable.length) return null;
  const matches = census.parsed.filter(record => matchesSessionOwner(record, owner));
  return matches.length === 1 && typeof matches[0].id === 'string' && ids.isValid(matches[0].id) ? matches[0] : null;
}

function bumpOwnedHeartbeat(cwd, id, owner, timestamp, guard) {
  const now = timestamp === undefined ? Date.now() : timestamp;
  if (!validSessionOwner(owner) || !ids.isValid(id) || !Number.isSafeInteger(now) || now <= 0) return { updated: false, record: null };
  // The trusted caller supplies its observed host/session, not a serialized
  // authorization. Recheck both axes and uniqueness INSIDE the existing mutex.
  return updateWith(cwd, id, current => {
    if (!matchesSessionOwner(current, owner) || resolveBySessionOwner(cwd, owner)?.id !== id) return null;
    if (Number.isFinite(current.last_heartbeat) && now <= current.last_heartbeat) return null;
    return { last_heartbeat: now };
  }, guard);
}

function registryPresent(cwd) {
  try { fs.lstatSync(runsDir(cwd)); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

function legacyOwnedRecord(cwd, owner) {
  if (!validSessionOwner(owner) || registryPresent(cwd)) return null;
  try {
    const root = fs.realpathSync.native(cwd), file = path.join(root, '.gsd', 'forge', ALIAS_FILE);
    for (const relative of ['.gsd', '.gsd/forge', '.gsd/forge/' + ALIAS_FILE]) {
      const stat = fs.lstatSync(path.join(root, relative));
      if (stat.isSymbolicLink() || (relative.endsWith(ALIAS_FILE) ? !stat.isFile() || stat.size > 65536 : !stat.isDirectory())) return null;
    }
    const read = require('./forge-autonomy-sources').readBoundedStableFile(file, 65536, { expectedReal: fs.realpathSync.native(file) });
    if (read.error) return null;
    const record = JSON.parse(read.buffer.toString('utf8'));
    return matchesSessionOwner(record, owner) ? record : null;
  } catch { return null; }
}

function bumpLegacyOwnedHeartbeat(cwd, owner, timestamp) {
  const now = timestamp === undefined ? Date.now() : timestamp;
  if (!Number.isSafeInteger(now) || now <= 0 || !legacyOwnedRecord(cwd, owner)) return false;
  // add/update share this fence: a newly created registry cannot race a legacy
  // alias write. An absent/mismatched identity never creates even the mutex.
  return withRegistryFence(cwd, () => {
    const record = legacyOwnedRecord(cwd, owner);
    if (!record || Number.isFinite(record.last_heartbeat) && now <= record.last_heartbeat) return false;
    writeAtomic(path.join(cwd, '.gsd', 'forge', ALIAS_FILE), { ...record, last_heartbeat: now });
    return true;
  });
}

function oldestActive(cwd) {
  const active = listActive(cwd);
  if (active.length === 0) return null;
  return active.reduce((a, b) => (a.started_at <= b.started_at ? a : b));
}

// ── Write (atomic via temp+rename) ──────────────────────────────────────────
function writeAtomic(filePath, record) {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath);
  // Random suffix avoids collisions if two writers hit the same id concurrently
  const tmp  = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeMetadataPatch(patch) {
  const next = Object.assign({}, patch || {});
  if (Object.prototype.hasOwnProperty.call(next, 'host_runtime')) {
    if (next.host_runtime === undefined || next.host_runtime === null || next.host_runtime === '') delete next.host_runtime;
    else next.host_runtime = normalizeHostRuntime(next.host_runtime);
  }
  for (const key of ['owner', 'session', 'heartbeat', 'expires_at', 'worker_engine', 'worker_slice', 'write_claim']) {
    if (Object.prototype.hasOwnProperty.call(next, key) && next[key] === undefined) delete next[key];
  }
  return next;
}

function withRunLock(cwd, id, fn) {
  const handle = lock.acquireSync(cwd, `run-${id}`, { holderRunId: id, retries: 80 });
  try { return fn(); } finally { handle.release(); }
}

const registryGuards = new WeakMap(), heldRegistries = new Set();
function registryKey(cwd) {
  const actual = fs.realpathSync.native(cwd);
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
function withRegistryFence(cwd, callback, guard) {
  const key = registryKey(cwd);
  const held = guard && registryGuards.get(guard);
  if (held && held.key === key && lock.assertOwned(held.handle)) return callback(guard);
  if (heldRegistries.has(key)) throw Object.assign(new Error('run ownership transfer in progress'), { code: 'EOWNERSHIPBUSY' });
  const handle = lock.acquireProcessSync(cwd, 'runs-ownership', { retries: 1 });
  const token = Object.freeze({}); registryGuards.set(token, { key, handle }); heldRegistries.add(key);
  try { return callback(token); }
  finally { registryGuards.delete(token); heldRegistries.delete(key); handle.release(); }
}

function add(cwd, record, guard) {
  if (!record || !record.id || !record.kind || (!record.session_id && !record.session)) {
    throw new Error('forge-runs.add: record requires id, kind and session_id or session');
  }
  if (!fs.existsSync(path.join(cwd, '.gsd'))) ensureRunsDir(cwd);
  return withRegistryFence(cwd, () => withRunLock(cwd, record.id, () => {
  ensureRunsDir(cwd);
  const now = Date.now();
  const supplied = normalizeMetadataPatch(record);
  const full = Object.assign({}, supplied, {
    kind: record.kind,
    id: record.id,
    session_id: record.session_id || record.session,
    active: record.active !== false,
    started_at: record.started_at || now,
    last_heartbeat: record.last_heartbeat || now,
    worker: record.worker || null,
    worker_started: record.worker_started || null,
    // Explicit `null`, never `undefined`: undefined disappears in
    // JSON.stringify and a consumer could not tell "no value" from
    // "field absent". (S01/T02, additive-by-read axis — see withAddressDefaults.)
    worker_slice: record.worker_slice || null,
    isolation_mode: record.isolation_mode || 'shared',
    milestone_dir: record.milestone_dir || (record.kind === 'milestone' ? `.gsd/milestones/${record.id}/` : null),
    cwd: record.cwd || cwd,
    account: record.account || null,   // which Claude account is driving this run (display/audit)
    // ── Address fields (S06/T03) ────────────────────────────────────────────
    // What makes a run ADDRESSABLE rather than merely present. Before these,
    // two runs on the same project in different branches had byte-identical
    // `cwd` and nothing else to tell them apart — they were distinguishable
    // only by the accident of differing filenames, which is not an address.
    //
    // `add()` records what it is GIVEN and derives nothing. Derivation is
    // forge-run-address.js's job, and keeping the two apart is what lets the
    // resolver treat a recorded value as authoritative (precedence: record
    // beats derivation) without the record having quietly been a derivation
    // all along.
    branch:  record.branch  || null,   // git branch this run owns (`forge/{id}` under branch/worktree)
    root:    record.root    || null,   // declared root containing this run's project
    project: record.project || null,   // owning project (the nearest `.gsd/` — resolveOwner)
    // Additive fields keep older registry records readable without migration.
    worktrees: Array.isArray(record.worktrees) ? record.worktrees : [],
    attached_to: record.attached_to || null,
  });
  if (Object.prototype.hasOwnProperty.call(supplied, 'host_runtime')) full.host_runtime = supplied.host_runtime;
  if (Object.prototype.hasOwnProperty.call(supplied, 'session')) full.session = supplied.session;
  if (Object.prototype.hasOwnProperty.call(supplied, 'owner')) full.owner = supplied.owner;
  if (Object.prototype.hasOwnProperty.call(supplied, 'heartbeat')) full.heartbeat = supplied.heartbeat;
  if (Object.prototype.hasOwnProperty.call(supplied, 'expires_at')) full.expires_at = supplied.expires_at;
  if (record.kind === 'task') {
    full.task_description = record.task_description || '';
    full.pending_decisions = record.pending_decisions || [];
    full.pending_memories  = record.pending_memories  || [];
  }
  writeAtomic(runFile(cwd, record.id), full);
  refreshLegacyAlias(cwd);
  return full;
  }), guard);
}

function update(cwd, id, patch, guard) {
  return withRegistryFence(cwd, () => withRunLock(cwd, id, () => {
    const current = get(cwd, id);
    if (!current) throw new Error(`forge-runs.update: run ${id} not found`);
    const next = Object.assign({}, current, normalizeMetadataPatch(patch));
    writeAtomic(runFile(cwd, id), next);
    refreshLegacyAlias(cwd);
    return next;
  }), guard);
}

/**
 * ADDITIVE sibling of `update` (S05/review R1) — `update` keeps its signature
 * and its behaviour, byte for byte. The difference is WHERE the read happens.
 *
 * `update(cwd, id, patch)` locks the WRITE. A caller that computed `patch`
 * from a `get()` taken BEFORE the call performs a read-modify-write ACROSS
 * the lock: the file write is serialized, the identity of what was read is
 * not. When the patch replaces a whole slot (`write_claim`), a record written
 * by someone else in that window is silently overwritten by the stale object.
 * That is not a hypothetical here — it is exactly how a fresh claim could be
 * replaced by an older one already carrying a `released` envelope, which turns
 * live in-flight writes into unfenced ones (under-block).
 *
 * `updateWith` closes the window by running the mutator INSIDE the lock, over
 * the record read inside the same lock. The mutator decides:
 *   - return an object -> that patch is applied  -> `{ updated: true,  record }`
 *   - return `null`/`undefined` -> ABORT, nothing is written -> `{ updated: false, record }`
 * Abort is a first-class outcome, not an error: a caller that finds the world
 * changed under it must be able to refuse in a NAMED way rather than write
 * anyway. The return shape is deliberately DIFFERENT from `update`'s (which
 * returns the record) so no caller can confuse the two.
 */
function updateWith(cwd, id, mutator, guard) {
  if (typeof mutator !== 'function') {
    throw new Error('forge-runs.updateWith: mutator must be a function');
  }
  return withRegistryFence(cwd, () => withRunLock(cwd, id, () => {
    const current = get(cwd, id);
    if (!current) throw new Error(`forge-runs.updateWith: run ${id} not found`);
    const patch = mutator(current);
    if (patch === null || patch === undefined) return { updated: false, record: current };
    const next = Object.assign({}, current, normalizeMetadataPatch(patch));
    writeAtomic(runFile(cwd, id), next);
    refreshLegacyAlias(cwd);
    return { updated: true, record: next };
  }), guard);
}

function remove(cwd, id, guard) {
  return withRegistryFence(cwd, () => withRunLock(cwd, id, () => {
    const f = runFile(cwd, id);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    refreshLegacyAlias(cwd);
  }), guard);
}

function bumpHeartbeat(cwd, id, ts) {
  return update(cwd, id, { last_heartbeat: ts || Date.now() });
}

function cleanupStale(cwd, thresholdMs) {
  const threshold = thresholdMs || STALE_THRESHOLD_MS;
  const now = Date.now();
  const removed = [];
  for (const r of listAll(cwd)) {
    if ((now - (r.last_heartbeat || 0)) > threshold) {
      remove(cwd, r.id);
      removed.push(r.id);
    }
  }
  return removed;
}

// ── Legacy alias (auto-mode.json mirror of oldest active) ───────────────────
function refreshLegacyAlias(cwd) {
  // Best-effort mirror: silently no-op without .gsd/ rather than manufacture it.
  // Unlike ensureRunsDir this must never throw — remove()/cleanupStale() call it
  // from paths that must not hard-fail (skills chain these with `|| true`).
  if (!fs.existsSync(path.join(cwd, '.gsd'))) return;
  const aliasPath = path.join(cwd, '.gsd', 'forge', ALIAS_FILE);
  const oldest = oldestActive(cwd);
  let mirror;
  if (oldest) {
    mirror = {
      active: true,
      started_at: oldest.started_at,
      last_heartbeat: oldest.last_heartbeat,
      worker: oldest.worker,
      worker_started: oldest.worker_started,
      // Mirror the slice axis alongside worker/worker_started (S01/T02): the
      // hook's legacy fallback reads THIS file when no run resolves by
      // session_id, so an alias without the axis makes that path re-emit a
      // slice-less context — the exact hole the axis exists to close.
      // `oldest` comes from listActive → withAddressDefaults, so the field is
      // always present as null rather than undefined.
      worker_slice: oldest.worker_slice === undefined ? null : oldest.worker_slice,
    };
  } else {
    mirror = { active: false };
  }
  try {
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    writeAtomic(aliasPath, mirror);
  } catch { /* alias is best-effort */ }
}

// ── Migration ───────────────────────────────────────────────────────────────
// Detect a pre-M004 STATE.md and migrate to M###-STATE.md + dashboard regen.
// Idempotent: if STATE.md already has the AUTO-GENERATED marker, no-op.
function migrateLegacyState(cwd) {
  const statePath = path.join(cwd, '.gsd', 'STATE.md');
  if (!fs.existsSync(statePath)) return { migrated: false, reason: 'no STATE.md' };

  const raw = fs.readFileSync(statePath, 'utf8');
  if (raw.startsWith('<!-- AUTO-GENERATED')) {
    return { migrated: false, reason: 'already dashboard' };
  }

  // Parse legacy fields
  const m = raw.match(/\*\*Active Milestone:\*\*\s*([^\n]+)/i);
  if (!m) return { migrated: false, reason: 'no Active Milestone field' };

  const milestoneText = m[1].trim();
  const token = milestoneText.split(/\s/)[0];
  if (!token || !ids.isValid(token) || ids.entityKind(token) !== 'milestone') {
    return { migrated: false, reason: 'no active milestone in legacy STATE' };
  }
  const milestoneId = token;

  const milestoneDir = path.join(cwd, '.gsd', 'milestones', milestoneId);
  if (!fs.existsSync(milestoneDir)) {
    return { migrated: false, reason: `milestone dir ${milestoneId} not found` };
  }

  // Extract optional fields
  const slice = (raw.match(/\*\*Active Slice:\*\*\s*([^\n]+)/i)   || [, '—'])[1].trim();
  const task  = (raw.match(/\*\*Active Task:\*\*\s*([^\n]+)/i)    || [, '—'])[1].trim();
  const phase = (raw.match(/\*\*Phase:\*\*\s*([^\n]+)/i)          || [, 'idle'])[1].trim();
  const auto  = (raw.match(/\*\*Auto-mode:\*\*\s*([^\n]+)/i)      || [, 'off'])[1].trim();
  const nextActMatch = raw.match(/## Next Action\s*\n([\s\S]*?)(?=\n##|\n---|\n\*\*|$)/i);
  const nextAction = nextActMatch ? nextActMatch[1].trim() : '(see legacy STATE.md backup)';

  // Write per-milestone state
  const nowIso = new Date().toISOString();
  const perMilestonePath = path.join(milestoneDir, `${milestoneId}-STATE.md`);
  const content = `---
milestone: ${milestoneId}
kind: milestone
created: ${nowIso}
last_updated: ${nowIso}
isolation_mode: shared
---

# ${milestoneId} State

**Active Slice:** ${slice}
**Active Task:** ${task}
**Phase:** ${phase}
**Auto-mode:** ${auto}
**Next Action:** ${nextAction}

## Notes (migrated from legacy STATE.md)

Run record migrated by forge-runs.js on ${nowIso}. Legacy single-run STATE.md was overwritten as dashboard.
`;
  fs.writeFileSync(perMilestonePath, content, 'utf8');
  return { migrated: true, milestoneId, perMilestonePath };
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

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help || (Object.keys(args).length === 0)) {
    process.stdout.write(`forge-runs — registry CRUD

Flags:
  --list                   list all runs (active + inactive)
  --list-active            list only active runs
  --get <id>               get single run record
  --add --id <id> --kind <milestone|task> --session <id> [--account <name>] [--worktrees <json>] [--attached-to <run-id>]
        [--branch <git-branch>] [--root <root>] [--project <path>]          create
                           (address fields are recorded as given — never derived here;
                            see forge-run-address.js --address for resolution)
  --update <id> --json <patch-json>                       update fields
  --remove <id>            delete record
  --bump <id>              bump last_heartbeat to now
  --heartbeat [--run <id>] --worker "<unit>" [--worker-slice <S##>] | --clear
                           one-spawn worker heartbeat (legacy auto-mode.json when --run absent)
  --cleanup-stale [--threshold-ms <n>]   garbage-collect stale records
  --resolve-session <id>   find active run for session_id
  --refresh-legacy-alias   rewrite auto-mode.json mirror
  --migrate-legacy         detect legacy STATE.md, migrate
  --cwd <path>             override working directory
`);
    return;
  }

  try {
    const observedOwner = args['observed-owner'] ? observeHostSession(args['host-runtime'], args['expected-owner-session']) : null;
    if (args['observed-owner'] && (!observedOwner || args.session && args.session !== observedOwner.sessionId)) throw new Error('owner-session-unavailable-or-mismatch');
    if (args['owner-session']) {
      const observed = observeHostSession(args['host-runtime'], args['expected-owner-session']);
      if (!observed) throw new Error('owner-session-unavailable');
      process.stdout.write(observed.sessionId + '\n');
    } else if (args.list) {
      process.stdout.write(JSON.stringify(listAll(cwd), null, 2) + '\n');
    } else if (args['list-active']) {
      process.stdout.write(JSON.stringify(listActive(cwd), null, 2) + '\n');
    } else if (args.get) {
      const r = get(cwd, args.get);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else if (args.add) {
      let worktrees = [];
      if (args.worktrees !== undefined) {
        if (typeof args.worktrees !== 'string') {
          throw new Error('forge-runs: --worktrees requires a JSON array value');
        }
        try {
          worktrees = JSON.parse(args.worktrees);
        } catch (e) {
          throw new Error(`forge-runs: invalid --worktrees JSON: ${e.message}`);
        }
        if (!Array.isArray(worktrees)) {
          throw new Error('forge-runs: --worktrees must be a JSON array');
        }
      }
      const r = add(cwd, {
        id: args.id,
        kind: args.kind,
        session_id: observedOwner ? observedOwner.sessionId : args.session,
        ...(observedOwner ? { host_runtime: observedOwner.hostRuntime, owner_session_source: observedOwner.source } : {}),
        isolation_mode: args['isolation-mode'] || 'shared',
        task_description: args['task-description'],
        account: (typeof args.account === 'string') ? args.account : (process.env.FORGE_ACCOUNT || null),
        worktrees,
        attached_to: (typeof args['attached-to'] === 'string') ? args['attached-to'] : null,
        // `--branch` with no value parses as boolean true; only a real string is a value.
        branch:  (typeof args.branch  === 'string') ? args.branch  : null,
        root:    (typeof args.root    === 'string') ? args.root    : null,
        project: (typeof args.project === 'string') ? args.project : null,
        cwd,
      });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.update) {
      const patch = args.json ? JSON.parse(args.json) : {};
      let r;
      if (observedOwner) {
        // A real current session may resume its own binding. A seed or foreign
        // owner is not transferred here; explicit transfer needs separate proof.
        const changed = updateWith(cwd, args.update, current => {
          if (!matchesSessionOwner(current, observedOwner) || resolveBySessionOwner(cwd, observedOwner)?.id !== args.update) return null;
          return { ...patch, session_id: observedOwner.sessionId, host_runtime: observedOwner.hostRuntime, owner_session_source: observedOwner.source };
        });
        if (!changed.updated) throw new Error('owner-session-binding-unknown-or-mismatch');
        r = changed.record;
      } else r = update(cwd, args.update, patch);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.remove) {
      remove(cwd, args.remove);
      process.stdout.write('ok\n');
    } else if (args.heartbeat !== undefined) {
      // One-spawn worker heartbeat (2026-08-24 diagnosis): the skills used to
      // burn a `node -e Date.now()` spawn plus a --update spawn (and a cat +
      // echo pair on the legacy path) around EVERY dispatch, just to stamp or
      // clear the worker field. Date.now lives here now; the legacy
      // auto-mode.json fallback too, so the skill block is a single line.
      //   --heartbeat --run <id> --worker "unit/id" [--worker-slice S##]  → set
      //   --heartbeat --run <id> --clear                                  → clear
      //   (--run absent/empty → legacy auto-mode.json path)
      const now = Date.now();
      const clearing = args.clear === true;
      const worker = clearing ? null : (typeof args.worker === 'string' ? args.worker : null);
      const workerSlice = clearing ? null
        : (typeof args['worker-slice'] === 'string' && args['worker-slice'] !== 'null' ? args['worker-slice'] : null);
      if (!clearing && !worker) throw new Error('forge-runs: --heartbeat requires --worker "<unit>" or --clear');
      const runId = typeof args.run === 'string' ? args.run : '';
      if (runId) {
        const r = update(cwd, runId, {
          worker, worker_slice: workerSlice,
          worker_started: clearing ? null : now,
          last_heartbeat: now, active: true,
        });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      } else {
        // Legacy single-run path — auto-mode.json is the only carrier.
        const legacyPath = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
        let startedAt = now;
        try {
          const txt = fs.readFileSync(path.join(cwd, '.gsd', 'forge', 'auto-mode-started.txt'), 'utf8').trim();
          if (/^\d+$/.test(txt)) startedAt = parseInt(txt, 10);
        } catch { /* absent → now */ }
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, JSON.stringify({
          active: true, started_at: startedAt, last_heartbeat: now,
          worker, worker_slice: workerSlice, worker_started: clearing ? null : now,
        }) + '\n');
        process.stdout.write('ok\n');
      }
    } else if (args.bump) {
      const r = bumpHeartbeat(cwd, args.bump);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args['cleanup-stale']) {
      const threshold = args['threshold-ms'] ? parseInt(args['threshold-ms'], 10) : STALE_THRESHOLD_MS;
      const removed = cleanupStale(cwd, threshold);
      process.stdout.write(JSON.stringify({ removed }, null, 2) + '\n');
    } else if (args['resolve-session']) {
      const r = resolveBySessionId(cwd, args['resolve-session']);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else if (args['refresh-legacy-alias']) {
      refreshLegacyAlias(cwd);
      process.stdout.write('ok\n');
    } else if (args['migrate-legacy']) {
      const result = migrateLegacyState(cwd);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stderr.write('forge-runs: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-runs error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  listAll, listAllDetailed, boundedCensus, withRegistryFence, listActive, get,
  add, update, updateWith, remove,
  bumpHeartbeat, cleanupStale,
  observeHostSession, resolveBySessionId, resolveBySessionOwner, bumpOwnedHeartbeat, bumpLegacyOwnedHeartbeat, oldestActive,
  refreshLegacyAlias, migrateLegacyState,
  withAddressDefaults,
  runsDir, runFile, writeAtomic, withRunLock, normalizeMetadataPatch,
  STALE_THRESHOLD_MS,
  ACTIVE_THRESHOLD_MS,
};
