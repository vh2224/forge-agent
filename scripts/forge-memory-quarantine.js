'use strict';

// ── forge-memory-quarantine ───────────────────────────────────────────────────
// Recoverable holding area for memory fragments whose canonical envelope lives
// inside a grouped container (see writeFragment's `grouped-member` refusal in
// forge-memory.js).
//
// Why a sidecar directory and not a loose fragment: writing the loose file is
// exactly the damage the refusal exists to prevent — a loose file shadows the
// grouped member on the next read (loose-wins, forge-memory.js::listFragments).
// So the fact is parked whole, next to the store but outside it:
//
//   .gsd/memory/quarantine/<storageKey>~<ts>.json
//
// The directory is invisible to the store's own readers by construction:
// listFragments filters `isFile() && .md`, and the grouper skips non-`.md`
// entries — so a quarantined fact can never be listed, read or re-grouped by
// accident.  It is also outside the reach of `milestone_cleanup`, which walks
// `.gsd/milestones/**`.
//
// The `~` delimiter is deliberate: `-`, `_` and `.` are all legal *inside* a
// storage key, so any of them would make `<storageKey>~<ts>` ambiguous to parse
// back.  `~` sits outside the `[\w.\-]` class storage keys are built from.
//
// The `fragment` field carries the payload byte-for-byte as it was handed to
// writeFragment, so recovery is mechanical:
//
//   1. node scripts/forge-sweep-project.js --undo <container>
//   2. edit / confirm the loose fragment that reappears
//   3. node -e "…" | node scripts/forge-memory.js --write --cwd .   (field `fragment`)
//   4. re-group when the unit is sealed again

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUARANTINE_DIRNAME = 'quarantine';

// The store's own directory helper, so a symlinked .gsd/memory cannot make the
// quarantine land somewhere else than the store it belongs to.
function quarantineDir(cwd) {
  const { memoryDir } = require('./forge-memory');
  return path.join(memoryDir(cwd), QUARANTINE_DIRNAME);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// Resolve the workspace root first so a legitimate cwd alias (notably
// /var -> /private/var on macOS) is compared real-to-real. Every existing
// component below it is then resolved before mkdir/write: a pre-existing
// .gsd, memory, or quarantine junction may be used only when it remains inside
// that canonical workspace. This check deliberately precedes mkdirSync.
function secureQuarantineDir(cwd, create) {
  const workspace = path.resolve(cwd || process.cwd());
  const realWorkspace = fs.realpathSync(workspace);
  const components = ['.gsd', 'memory', QUARANTINE_DIRNAME];
  let cursor = workspace;

  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      if (!create) throw error;
      fs.mkdirSync(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      const error = new Error(`memory quarantine component is not a directory: ${cursor}`);
      error.code = 'MEMORY_QUARANTINE_PATH_UNSAFE';
      throw error;
    }
    const realComponent = fs.realpathSync(cursor);
    if (!isWithin(realWorkspace, realComponent)) {
      const error = new Error(`memory quarantine path escapes workspace: ${cursor} -> ${realComponent}`);
      error.code = 'MEMORY_QUARANTINE_PATH_ESCAPE';
      throw error;
    }
  }

  return fs.realpathSync(cursor);
}

// Compact UTC stamp: 20260818T2256013Z-shaped, sortable, no separators that
// collide with the `~` delimiter or with path syntax.
function compactStamp(date) {
  return (date || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// `<storageKey>~<ts>.json`, with a numeric `~2`, `~3`… suffix on collision.
// Two refusals inside the same second must not overwrite each other: the whole
// point of the quarantine is that no fact is lost.
//
// The refusal path runs deliberately BEFORE any lock (forge-memory.js::
// writeFragment), so nothing serializes two processes quarantining the same
// storage key in the same second.  Therefore the name is not resolved by
// looking (existsSync) and then writing — that gap is the whole bug — but by
// creating the file with an exclusive-create flag and letting the filesystem
// arbitrate: `wx` fails with EEXIST for the loser, who then tries the next
// suffix.
const MAX_COLLISION_SUFFIX = 1000;

function candidatePath(dir, storageKey, stamp, n) {
  const base = `${storageKey}~${stamp}`;
  return path.join(dir, n === 1 ? `${base}.json` : `${base}~${n}.json`);
}

// Kept for callers that only need the name shape (no side effect).
function resolveTargetPath(dir, storageKey, stamp) {
  let n = 1;
  let candidate = candidatePath(dir, storageKey, stamp, n);
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = candidatePath(dir, storageKey, stamp, n);
  }
  return candidate;
}

// Atomically creates the quarantine candidate.  Returns the path actually
// written.  Exhausting the suffix ceiling fails by name — never overwrites, and
// never reports success it did not achieve.
function writeExclusive(dir, storageKey, stamp, data) {
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n += 1) {
    const candidate = candidatePath(dir, storageKey, stamp, n);
    try {
      fs.writeFileSync(candidate, data, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(
    `quarantineFragment: mais de ${MAX_COLLISION_SUFFIX} colisões para `
    + `${storageKey}~${stamp} — nada foi escrito (o fato NÃO foi parqueado).`
  );
}

function stableQuarantinePath(dir, storageKey, extractionId) {
  const identity = crypto.createHash('sha256')
    .update(`${storageKey}\x00${extractionId}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(dir, `${storageKey}~extraction-${identity}.json`);
}

function writeReplaySafe(dir, storageKey, extractionId, data) {
  const target = stableQuarantinePath(dir, storageKey, extractionId);
  try {
    fs.writeFileSync(target, data, { encoding: 'utf8', flag: 'wx' });
    return { path: target, replayed: false };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  const existing = fs.readFileSync(target, 'utf8');
  if (existing !== data) {
    const error = new Error(`quarantine extraction identity conflict: ${extractionId}`);
    error.code = 'MEMORY_QUARANTINE_CONFLICT';
    throw error;
  }
  return { path: target, replayed: true };
}

// ── quarantineFragment ────────────────────────────────────────────────────────
// Parks `fragment` whole. `info` carries the refusal context:
//   { storageKey, unitId, milestoneId, container, reason, remedy }
// Returns { path }.
function quarantineFragment(cwd, fragment, info) {
  if (!fragment || typeof fragment !== 'object') {
    throw new Error('quarantineFragment requires a fragment object');
  }
  const meta = info || {};
  const storageKey = meta.storageKey;
  if (!storageKey || typeof storageKey !== 'string') {
    throw new Error('quarantineFragment requires info.storageKey');
  }

  const dir = secureQuarantineDir(cwd, true);

  const refusedAt = new Date();

  const record = {
    refused_at: meta.extractedAt || refusedAt.toISOString(),
    storage_key: storageKey,
    unit_id: meta.unitId || fragment.unit_id || null,
    milestone_id: meta.milestoneId || null,
    container: meta.container || null,
    reason: meta.reason || null,
    remedy: meta.remedy || null,
    extraction_id: meta.extractionId || null,
    // Exact payload handed to writeFragment — re-injectable verbatim.
    fragment,
  };

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (meta.extractionId) {
    return writeReplaySafe(dir, storageKey, meta.extractionId, serialized);
  }
  return {
    path: writeExclusive(dir, storageKey, compactStamp(refusedAt), serialized),
    replayed: false,
  };
}

// ── listQuarantine ────────────────────────────────────────────────────────────
// Reads the quarantine directory for the doctor / operator.  A missing
// directory is the ordinary empty case ([]).  Any OTHER readdir failure
// (EACCES/EIO/ENOTDIR…) is rethrown: an empty list is an assertion that the
// directory was read and held nothing, and a detector that reports its own
// blindness as good news is indistinguishable from a broken one.  The caller
// (forge-doctor's advisory check) already turns the throw into `skipped: error`.
//
// An unreadable or unparseable entry is returned as { path, unreadable: true,
// error } — never dropped silently.  Trusted fields are assigned LAST, so file
// content can never forge `path`/`unreadable`; a parsed value that is not a
// plain object is itself reported as unreadable rather than propagated.
function listQuarantine(cwd) {
  let dir;
  try {
    dir = secureQuarantineDir(cwd, false);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  names.sort();

  return names.map(name => {
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          path: filePath,
          unreadable: true,
          error: `forma inesperada de registro (${Array.isArray(parsed) ? 'array' : typeof parsed})`,
        };
      }
      return { ...parsed, path: filePath, unreadable: false };
    } catch (error) {
      return { path: filePath, unreadable: true, error: error.message };
    }
  });
}

module.exports = {
  QUARANTINE_DIRNAME,
  quarantineDir,
  quarantineFragment,
  listQuarantine,
  _private: {
    compactStamp,
    resolveTargetPath,
    writeExclusive,
    stableQuarantinePath,
    writeReplaySafe,
    secureQuarantineDir,
    isWithin,
    MAX_COLLISION_SUFFIX,
  },
};
