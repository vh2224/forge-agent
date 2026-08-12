'use strict';

// forge-gsd-census.js — READ-ONLY census + compare instrument for .gsd/.
//
// Purpose (S04 T01): the single instrument every before/after comparison of
// this slice is measured against — same spirit as forge-cost-baseline.js
// (S01): a deterministic, reproducible measurement, never a one-off shell
// pipeline (that would be a second copy of the form, and would not survive
// review — see forge-cost-baseline.js's own header for the same argument).
//
// Contract (LOCKED — mirrors T01-PLAN.md must_haves):
//   - census(cwd, opts) is READ-ONLY. The only write path in this whole
//     module is writeCensus()/--out, invoked explicitly.
//   - Hashing reads BYTES ON DISK (crypto.createHash('sha256') over the raw
//     buffer, same idiom as forge-vcs.js svnHashPath) — this measures bytes,
//     not logical content, deliberately: the census exists to prove nothing
//     was lost at the byte level, not to compare parsed meaning.
//   - An unreadable file (EACCES, EISDIR, any errno) becomes a NAMED-REASON
//     entry in the envelope; it is never a silent skip and never crashes the
//     whole census (S02/R2, S03/R1 of this milestone: unreadable is not
//     evidence of "same").
//   - compare() emits, per store, `identical | changed | inconclusive` with
//     added/removed/modified ENUMERATED — never inferred from a count alone.
//     ANTI-SILENCE FLOOR (S07, durable repo rule): a store with 0 files on
//     BOTH sides is `inconclusive`, never `identical` — "identical" is a
//     claim about a comparison that was actually made; comparing zero files
//     is indistinguishable, byte for byte, from a broken comparator. A store
//     that saw an unreadable file on EITHER side can likewise never resolve
//     to `identical` (rule reproduced three times already in this milestone:
//     S02/R2, S03/R1, PR #70 dogfood).
//
// Path containment: realpath-vs-realpath against the REAL `.gsd/` root —
// never lexical-vs-real (this repo itself runs from a worktree under
// .forge-worktrees; see forge-memory-index.js resolveCitation for the same
// discipline). A symlink found while walking a store whose real target
// resolves outside the real root is enumerated as `skipped` with a named
// reason, never followed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ── STORE_DIRS / TREE_DIRS ───────────────────────────────────────────────────
// Per-file (hashed) stores vs. per-directory-count (unhashed) trees. Trees are
// unhashed deliberately (T01-PLAN step 2): .gsd/milestones/**/.gsd/tasks/**
// can carry hundreds of files — hashing all of them on every census would be
// paying for detail the compare mode does not need at that granularity.
const STORE_DIRS = {
  ledger: '.gsd/ledger',
  decisions: '.gsd/decisions',
  memory: '.gsd/memory',
  checker_memory: '.gsd/checker-memory',
  sessions: '.gsd/sessions',
  items: '.gsd/items',
};

// Declared "not swept" by /forge-sweep policy (S04-PLAN, S04-CONTEXT): these
// two trees are outside the sweep's reach by contract, and the census total
// decomposition must say so explicitly rather than let the number look
// disappointing without explanation.
const NOT_SWEPT_TREES = new Set(['forge']);
const NOT_SWEPT_STORES = new Set(['items']);

// ── isWithin (molde de forge-prompt.js / forge-memory-index.js) ────────────
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  };
}

// ── walkStore ────────────────────────────────────────────────────────────────
// Recursive walk of a single store directory. Returns { present, files, errors, skipped }.
// files: [{ path, sha256, bytes }] sorted by path (determinism).
// errors: [{ path, reason }] — read failures, never silent, never a throw that
//   aborts the whole census.
// skipped: [{ path, reason }] — symlinks whose real target resolves outside
//   the real .gsd/ root; enumerated, never followed.
function walkStore(cwd, storeRelDir, gsdRealRoot) {
  const dirAbs = path.join(cwd, storeRelDir);
  const result = { present: false, files: [], errors: [], skipped: [] };

  let rootStat;
  try {
    rootStat = fs.statSync(dirAbs);
  } catch (_) {
    return result; // absent store: present:false, everything empty — not an error.
  }
  if (!rootStat.isDirectory()) {
    result.present = true;
    result.errors.push({ path: toPosix(storeRelDir), reason: 'not-a-directory' });
    return result;
  }
  result.present = true;

  const stack = [dirAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      result.errors.push({ path: toPosix(path.relative(cwd, dir)), reason: (e && e.code) || 'readdir-error' });
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relToCwd = toPosix(path.relative(cwd, abs));

      if (entry.isSymbolicLink()) {
        let realTarget = null;
        try {
          realTarget = fs.realpathSync(abs);
        } catch (e) {
          result.errors.push({ path: relToCwd, reason: (e && e.code) || 'symlink-broken' });
          continue;
        }
        if (!isWithin(gsdRealRoot, realTarget)) {
          result.skipped.push({ path: relToCwd, reason: 'symlink-outside-root' });
          continue;
        }
        // Real target is contained — follow it as either a file or directory.
        let targetStat;
        try {
          targetStat = fs.statSync(realTarget);
        } catch (e) {
          result.errors.push({ path: relToCwd, reason: (e && e.code) || 'stat-error' });
          continue;
        }
        if (targetStat.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (targetStat.isFile()) {
          try {
            const h = hashFile(abs);
            result.files.push({ path: relToCwd, sha256: h.sha256, bytes: h.bytes });
          } catch (e) {
            result.errors.push({ path: relToCwd, reason: (e && e.code) || 'read-error' });
          }
        }
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) {
        try {
          const h = hashFile(abs);
          result.files.push({ path: relToCwd, sha256: h.sha256, bytes: h.bytes });
        } catch (e) {
          result.errors.push({ path: relToCwd, reason: (e && e.code) || 'read-error' });
        }
        continue;
      }
      // Other entry kinds (fifo, socket, char/block device) — named, not silent.
      result.errors.push({ path: relToCwd, reason: 'unsupported-entry-type' });
    }
  }

  result.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  result.errors.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  result.skipped.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return result;
}

// ── countTree ────────────────────────────────────────────────────────────────
// Unhashed recursive file/byte count for a directory. Never throws; an absent
// directory yields { present: false, files: 0, bytes: 0 }. Errors reading a
// sub-entry are counted separately (error_files) so totals still reconcile:
// files + error_files == every filesystem entry seen.
function countTree(absDir) {
  let rootStat;
  try {
    rootStat = fs.statSync(absDir);
  } catch (_) {
    return { present: false, files: 0, bytes: 0, error_files: 0 };
  }
  if (!rootStat.isDirectory()) {
    return { present: true, files: 0, bytes: 0, error_files: 1 };
  }

  let files = 0;
  let bytes = 0;
  let errorFiles = 0;
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      errorFiles += 1;
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(abs); // follows symlinks for size purposes
          if (st.isFile()) {
            files += 1;
            bytes += st.size;
          }
        } catch (_) {
          errorFiles += 1;
        }
      }
    }
  }
  return { present: true, files, bytes, error_files: errorFiles };
}

// ── walkTreeDirs ─────────────────────────────────────────────────────────────
// One level of subdirectories under `parentRelDir` (e.g. .gsd/milestones/*/),
// each measured with countTree. Returns { present, entries: {id -> {files,bytes,error_files}} }.
function walkTreeDirs(cwd, parentRelDir) {
  const parentAbs = path.join(cwd, parentRelDir);
  let entries;
  try {
    entries = fs.readdirSync(parentAbs, { withFileTypes: true });
  } catch (_) {
    return { present: false, entries: {} };
  }
  const out = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(parentAbs, entry.name);
    out[entry.name] = countTree(abs);
  }
  return { present: true, entries: out };
}

// ── census ───────────────────────────────────────────────────────────────────
// census(cwd, opts) -> {
//   generated_at, cwd,
//   stores: { <storeName>: walkStore result + totals },
//   trees: {
//     milestones: { present, entries: { id -> {files,bytes,error_files} }, totals },
//     tasks: { present, entries: { id -> {files,bytes,error_files} }, totals },
//     forge: countTree result,
//   },
//   totals: { files, bytes, swept: {files,bytes}, not_swept: {files,bytes} },
// }
// READ-ONLY: this function never writes to disk. The only write path in this
// module is writeCensus()/--out.
function census(cwd, opts) {
  const options = opts || {};
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const gsdAbs = path.join(resolvedCwd, '.gsd');

  let gsdRealRoot = gsdAbs;
  try {
    gsdRealRoot = fs.realpathSync(gsdAbs);
  } catch (_) {
    gsdRealRoot = gsdAbs; // absent .gsd/ — every store will simply be present:false.
  }

  const stores = {};
  for (const [name, relDir] of Object.entries(STORE_DIRS)) {
    const walked = walkStore(resolvedCwd, relDir, gsdRealRoot);
    const totalBytes = walked.files.reduce((sum, f) => sum + f.bytes, 0);
    stores[name] = {
      dir: toPosix(relDir),
      present: walked.present,
      files: walked.files,
      errors: walked.errors,
      skipped: walked.skipped,
      totals: { files: walked.files.length, bytes: totalBytes, errors: walked.errors.length },
    };
  }

  const milestones = walkTreeDirs(resolvedCwd, path.join('.gsd', 'milestones'));
  const tasks = walkTreeDirs(resolvedCwd, path.join('.gsd', 'tasks'));
  const forge = countTree(path.join(resolvedCwd, '.gsd', 'forge'));

  const milestonesTotals = Object.values(milestones.entries).reduce(
    (acc, e) => ({ files: acc.files + e.files, bytes: acc.bytes + e.bytes }),
    { files: 0, bytes: 0 }
  );
  const tasksTotals = Object.values(tasks.entries).reduce(
    (acc, e) => ({ files: acc.files + e.files, bytes: acc.bytes + e.bytes }),
    { files: 0, bytes: 0 }
  );

  const trees = {
    milestones: { present: milestones.present, entries: milestones.entries, totals: milestonesTotals },
    tasks: { present: tasks.present, entries: tasks.entries, totals: tasksTotals },
    forge: { present: forge.present, files: forge.files, bytes: forge.bytes, error_files: forge.error_files },
  };

  // Totals: swept vs not_swept decomposition (S04-PLAN: "não engane em nenhuma
  // das duas direções"). not_swept = forge tree + items store (declared
  // untouched by /forge-sweep policy). Everything else is swept-eligible mass.
  let sweptFiles = 0;
  let sweptBytes = 0;
  let notSweptFiles = 0;
  let notSweptBytes = 0;

  for (const [name, s] of Object.entries(stores)) {
    if (NOT_SWEPT_STORES.has(name)) {
      notSweptFiles += s.totals.files;
      notSweptBytes += s.totals.bytes;
    } else {
      sweptFiles += s.totals.files;
      sweptBytes += s.totals.bytes;
    }
  }
  sweptFiles += milestonesTotals.files + tasksTotals.files;
  sweptBytes += milestonesTotals.bytes + tasksTotals.bytes;
  if (NOT_SWEPT_TREES.has('forge')) {
    notSweptFiles += trees.forge.files;
    notSweptBytes += trees.forge.bytes;
  }

  const totals = {
    files: sweptFiles + notSweptFiles,
    bytes: sweptBytes + notSweptBytes,
    swept: { files: sweptFiles, bytes: sweptBytes },
    not_swept: { files: notSweptFiles, bytes: notSweptBytes },
  };

  return {
    generated_at: options.deterministicTimestamp || new Date().toISOString(),
    cwd: resolvedCwd,
    stores,
    trees,
    totals,
  };
}

// ── compare ──────────────────────────────────────────────────────────────────
// compare(before, after) -> {
//   stores: { <storeName>: { verdict, added[], removed[], modified[], unchanged_count,
//                             unreadable_before[], unreadable_after[] } },
//   trees: {
//     milestones: { dirs_added[], dirs_removed[], dirs_changed[{id,before,after}] },
//     tasks: { same shape },
//     forge: { delta_files, delta_bytes },
//   },
// }
// ANTI-SILENCE FLOOR: a store with 0 files on BOTH sides (no unreadable
// entries either) is `inconclusive`, never `identical` — see module header.
function compareStore(beforeStore, afterStore) {
  const before = beforeStore || { files: [], errors: [] };
  const after = afterStore || { files: [], errors: [] };

  const beforeMap = new Map(before.files.map((f) => [f.path, f.sha256]));
  const afterMap = new Map(after.files.map((f) => [f.path, f.sha256]));

  const added = [];
  const removed = [];
  const modified = [];
  let unchangedCount = 0;

  for (const [p, sha] of afterMap.entries()) {
    if (!beforeMap.has(p)) {
      added.push(p);
    } else if (beforeMap.get(p) !== sha) {
      modified.push(p);
    } else {
      unchangedCount += 1;
    }
  }
  for (const p of beforeMap.keys()) {
    if (!afterMap.has(p)) removed.push(p);
  }
  added.sort((a, b) => a.localeCompare(b, 'en'));
  removed.sort((a, b) => a.localeCompare(b, 'en'));
  modified.sort((a, b) => a.localeCompare(b, 'en'));

  const unreadableBefore = (before.errors || []).map((e) => e.path).sort((a, b) => a.localeCompare(b, 'en'));
  const unreadableAfter = (after.errors || []).map((e) => e.path).sort((a, b) => a.localeCompare(b, 'en'));

  const totalConsideredBefore = beforeMap.size + unreadableBefore.length;
  const totalConsideredAfter = afterMap.size + unreadableAfter.length;
  const hasUnreadable = unreadableBefore.length > 0 || unreadableAfter.length > 0;
  const hasDiff = added.length > 0 || removed.length > 0 || modified.length > 0;

  let verdict;
  if (totalConsideredBefore === 0 && totalConsideredAfter === 0) {
    // ANTI-SILENCE FLOOR — the case this module exists to prove: 0 files
    // compared on both sides is a claim of NO comparison, never "same".
    verdict = 'inconclusive';
  } else if (hasUnreadable) {
    // Unreadable ≠ evidence of "same" (S02/R2, S03/R1, PR#70 dogfood): a store
    // that could not be fully read can never resolve to `identical`. If real
    // diffs were also found, `changed` still communicates more than
    // `inconclusive` would — the diffs ARE evidence, even if incomplete.
    verdict = hasDiff ? 'changed' : 'inconclusive';
  } else if (hasDiff) {
    verdict = 'changed';
  } else {
    verdict = 'identical';
  }

  return {
    verdict,
    added,
    removed,
    modified,
    unchanged_count: unchangedCount,
    unreadable_before: unreadableBefore,
    unreadable_after: unreadableAfter,
  };
}

function compareTreeDirs(beforeTree, afterTree) {
  const before = (beforeTree && beforeTree.entries) || {};
  const after = (afterTree && afterTree.entries) || {};
  const beforeIds = new Set(Object.keys(before));
  const afterIds = new Set(Object.keys(after));

  const dirsAdded = [...afterIds].filter((id) => !beforeIds.has(id)).sort((a, b) => a.localeCompare(b, 'en'));
  const dirsRemoved = [...beforeIds].filter((id) => !afterIds.has(id)).sort((a, b) => a.localeCompare(b, 'en'));
  const dirsChanged = [];
  for (const id of beforeIds) {
    if (!afterIds.has(id)) continue;
    const b = before[id];
    const a = after[id];
    if (b.files !== a.files || b.bytes !== a.bytes) {
      dirsChanged.push({ id, before: { files: b.files, bytes: b.bytes }, after: { files: a.files, bytes: a.bytes } });
    }
  }
  dirsChanged.sort((x, y) => x.id.localeCompare(y.id, 'en'));

  return { dirs_added: dirsAdded, dirs_removed: dirsRemoved, dirs_changed: dirsChanged };
}

function compare(before, after) {
  const beforeStores = (before && before.stores) || {};
  const afterStores = (after && after.stores) || {};
  const storeNames = new Set([...Object.keys(beforeStores), ...Object.keys(afterStores)]);

  const stores = {};
  for (const name of storeNames) {
    stores[name] = compareStore(beforeStores[name], afterStores[name]);
  }

  const beforeTrees = (before && before.trees) || {};
  const afterTrees = (after && after.trees) || {};

  const trees = {
    milestones: compareTreeDirs(beforeTrees.milestones, afterTrees.milestones),
    tasks: compareTreeDirs(beforeTrees.tasks, afterTrees.tasks),
    forge: {
      delta_files: ((afterTrees.forge && afterTrees.forge.files) || 0) - ((beforeTrees.forge && beforeTrees.forge.files) || 0),
      delta_bytes: ((afterTrees.forge && afterTrees.forge.bytes) || 0) - ((beforeTrees.forge && beforeTrees.forge.bytes) || 0),
    },
  };

  return { stores, trees };
}

// ── writeCensus ──────────────────────────────────────────────────────────────
// The ONLY write path in this module. Contained under cwd via isWithin — same
// discipline as forge-memory-index.js writeIndex.
function writeCensus(result, cwd, outRel) {
  const root = path.resolve(cwd);
  const outAbs = path.resolve(root, outRel);
  if (!isWithin(root, outAbs)) {
    throw new Error(`--out escapes cwd: ${outRel}`);
  }
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(result) + '\n', 'utf8');
  return { path: outAbs, bytes: Buffer.byteLength(JSON.stringify(result) + '\n', 'utf8') };
}

// ── renderMarkdown ───────────────────────────────────────────────────────────
function renderMarkdown(result) {
  const lines = [];
  lines.push('# Censo do .gsd/');
  lines.push('');
  lines.push(`- cwd: \`${result.cwd}\``);
  lines.push(`- generated_at: ${result.generated_at}`);
  lines.push('');
  lines.push('| store | present | files | bytes | errors |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [name, s] of Object.entries(result.stores)) {
    lines.push(`| ${name} | ${s.present} | ${s.totals.files} | ${s.totals.bytes} | ${s.totals.errors} |`);
  }
  lines.push('');
  lines.push(`| trees | files | bytes |`);
  lines.push('| --- | --- | --- |');
  lines.push(`| milestones | ${result.trees.milestones.totals.files} | ${result.trees.milestones.totals.bytes} |`);
  lines.push(`| tasks | ${result.trees.tasks.totals.files} | ${result.trees.tasks.totals.bytes} |`);
  lines.push(`| forge | ${result.trees.forge.files} | ${result.trees.forge.bytes} |`);
  lines.push('');
  lines.push(`- totals: files=${result.totals.files} bytes=${result.totals.bytes}`);
  lines.push(`  - swept: files=${result.totals.swept.files} bytes=${result.totals.swept.bytes}`);
  lines.push(`  - not_swept: files=${result.totals.not_swept.files} bytes=${result.totals.not_swept.bytes}`);
  return lines.join('\n') + '\n';
}

function renderCompareMarkdown(result) {
  const lines = [];
  lines.push('# Comparação de censos .gsd/');
  lines.push('');
  lines.push('| store | verdict | added | removed | modified | unchanged |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const [name, s] of Object.entries(result.stores)) {
    lines.push(`| ${name} | ${s.verdict} | ${s.added.length} | ${s.removed.length} | ${s.modified.length} | ${s.unchanged_count} |`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// node forge-gsd-census.js [--json] [--markdown] [--cwd <dir>] [--out <file>] [--baseline <file>]
// Molde: forge-cost-baseline.js parseArgs / exit contract.
function parseArgs(argv) {
  const KNOWN_BOOL = new Set(['json', 'markdown', 'help']);
  const KNOWN_VAL = new Set(['cwd', 'out', 'baseline']);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw Object.assign(new Error(`Unexpected argument: ${token}`), { exitCode: 2 });
    }
    const key = token.slice(2);
    if (KNOWN_BOOL.has(key)) {
      args[key] = true;
      continue;
    }
    if (!KNOWN_VAL.has(key)) {
      throw Object.assign(new Error(`Unknown option: --${key}`), { exitCode: 2 });
    }
    if (i + 1 >= argv.length) {
      throw Object.assign(new Error(`Missing value for --${key}`), { exitCode: 2 });
    }
    args[key] = argv[++i];
  }
  return args;
}

function printUsage() {
  process.stdout.write(`Usage:
  node forge-gsd-census.js [--json] [--markdown] [--cwd <dir>] [--out <file>]
  node forge-gsd-census.js --baseline <file> [--json] [--markdown] [--cwd <dir>]

Options:
  --json        Print the census/compare result as JSON (default mode)
  --markdown    Print a markdown table instead of JSON
  --cwd DIR     Project root to census (default: cwd)
  --out FILE    Write the census result to FILE (the ONLY write path)
  --baseline FILE  Compare current census against a prior census JSON file
  --help        Show this message
`);
}

function cliMain(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  if (args.baseline !== undefined) {
    let beforeRaw;
    try {
      beforeRaw = fs.readFileSync(path.resolve(args.baseline), 'utf8');
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: `--baseline unreadable: ${e.message}` }) + '\n');
      return 2;
    }
    let before;
    try {
      before = JSON.parse(beforeRaw);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: `--baseline invalid JSON: ${e.message}` }) + '\n');
      return 2;
    }
    const after = census(cwd, {});
    const result = compare(before, after);
    if (args.markdown) {
      process.stdout.write(renderCompareMarkdown(result));
    } else {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    return 0;
  }

  const result = census(cwd, {});
  if (args.out !== undefined) {
    writeCensus(result, cwd, args.out);
  }
  if (args.markdown) {
    process.stdout.write(renderMarkdown(result));
  } else {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  return 0;
}

if (require.main === module) {
  try {
    const code = cliMain(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  census,
  compare,
  writeCensus,
  renderMarkdown,
  renderCompareMarkdown,
  STORE_DIRS,
  NOT_SWEPT_STORES,
  NOT_SWEPT_TREES,
  _private: { walkStore, countTree, walkTreeDirs, isWithin, compareStore, compareTreeDirs, hashFile, spawnSync },
};
