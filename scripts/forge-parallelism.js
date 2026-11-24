#!/usr/bin/env node
// forge-parallelism.js — compute a parallel batch of ready tasks for execute-task dispatch.
//
// Usage:
//   node scripts/forge-parallelism.js --slice-plan <path> [--max-concurrent N]
//
// Reads:
//   - <slice-plan>        : S##-PLAN.md listing tasks (checkbox state = done/pending)
//   - sibling tasks/T##/T##-PLAN.md frontmatter for each task (depends: [], writes: [])
//
// Output (stdout): single-line JSON
//   { mode: "parallel" | "single" | "legacy" | "blocked" | "none",
//     batch: [{id, planPath}],
//     reason: string,
//     details?: object,
//     dag_status?: "valid" | "legacy" | "invalid",   (issue 343, additive)
//     diagnostics?: string[] }                       (issue 343, additive)
//
// Modes:
//   parallel  — batch.length >= 2, orchestrator dispatches multiple Agent() in one message
//   single    — batch.length == 1, normal single dispatch (modern plan, but only 1 ready)
//   legacy    — any task in slice is missing depends OR writes frontmatter → force sequential
//   blocked   — there are pending tasks but none have all deps satisfied (shouldn't happen in valid plans)
//   none      — all tasks already marked done
//
// issue 343 U0a: depends/writes come from the shared parseExecutionFields decoder
// (forge-must-haves decodeDeclarationList) and the pure validateTaskDag decides
// legacy (absent declarations) apart from invalid (malformed declarations or
// unknown, self or cyclic references). An invalid graph never yields `parallel`: it
// stays sequential, one ready task at a time. This CLI is a compatibility reader;
// the canonical batch decision does not depend on it.
//
// issue 343 U0a-r1: parseTaskFrontmatter is a scheduling reader with a fixed
// projection. A YAML-null value (`writes:` with no list) is never read as `[]`, and
// a list with a leading or interior blank line — readable, but refused by the
// temporal guard — is named too; a task with any such diagnostic is never ready.
// Only an explicit `writes: []` declares no writes. pathsOverlap bounds its work
// explicitly (GLOB_BOUNDS) and reports exhausted or undecided work as a conflict.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// issue 343 U0a: forge-must-haves is required only inside the readers. This module
// must keep loading alone (forge-parallelism-exports.test.js copies it to an empty
// directory) and forge-code-roots requires it at top level.
function sharedDecoder() { return require('./forge-must-haves'); }

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function emit(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj));
  if (typeof exitCode === 'number') process.exit(exitCode);
}

// Convert a glob-ish path pattern into a RegExp. Supports **, *, ?, and literal segments.
// Always uses forward slashes (Windows-safe).
function globToRegex(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i++; }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function normalizeFilesystemPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function canonicalizeClaimPath(p) {
  const raw = String(p || '').replace(/\\/g, '/');
  if (raw === '') return '';
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(`claim path must be relative: ${raw}`);
  const stack = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) throw new Error(`path escapes root: ${raw}`);
      stack.pop();
    } else stack.push(segment);
  }
  return stack.length === 0 ? '.' : stack.join('/');
}

// Canonical one-way relation: a claim declaration covers a concrete path by
// equality, directory ancestry, or glob syntax. The concrete path is never
// interpreted as a pattern.
function claimPathMatches(claimPath, realPath) {
  let claim; let real;
  try { claim = canonicalizeClaimPath(claimPath); real = canonicalizeClaimPath(realPath); }
  catch { return true; } // malformed/escaping claims cover everything (fail closed)
  if (!claim || !real) return false;
  if (claim === '.') return true;
  if (claim === real || real.startsWith(`${claim}/`)) return true;
  try { return globToRegex(claim).test(real); } catch { return false; }
}

// issue 343 U0a-r1: explicit bounds on the glob intersection, checked before
// anything is allocated. A declaration longer than `inputChars`, a segment pair
// whose product automaton would exceed `states`, or one comparison spending more
// than `work` steps (compared literal characters plus explored states, cumulative
// over all its segments) is undecided — and undecided is a conflict, never a
// disjointness. Real declarations stay far below them; only adversarial input
// reaches them, and it is then serialized.
const GLOB_BOUNDS = Object.freeze({ inputChars: 4096, states: 65536, work: 32768 });

// issue 343 U0a: a write declaration as written — `path`, `root::path` or
// { root_id, path }. Returns { root, path } with a canonical relative path, or null
// when it is empty, malformed, absolute, escaping or longer than the input bound
// (unknown = conflict).
const ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function declaredTarget(value) {
  let root = null, relative;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.root_id !== 'string' || !ROOT_ID.test(value.root_id) || typeof value.path !== 'string') return null;
    if (value.path.length > GLOB_BOUNDS.inputChars) return null;
    root = value.root_id; relative = value.path;
  } else {
    relative = String(value || '');
    if (relative.length > GLOB_BOUNDS.inputChars) return null;
    const at = relative.indexOf('::');
    if (at >= 0) {
      root = relative.slice(0, at); relative = relative.slice(at + 2);
      if (!ROOT_ID.test(root)) return null;
    }
  }
  if (relative.includes('::')) return null;
  let canonical;
  try { canonical = canonicalizeClaimPath(relative); } catch (_) { return null; }
  return canonical ? { root, path: canonical } : null;
}

// Emptiness test of the product of two single-segment glob automata over `*` (any
// run), `?` (one character) and literals: is there one name both match? Returns
// true, false, or null when the bounds are exhausted (undecided). Two literal
// segments compare directly; otherwise the product size is checked before its
// visited table is allocated, and every explored state spends one unit of the
// comparison's shared `budget`.
function segmentsIntersect(left, right, budget) {
  if (!/[*?]/.test(left) && !/[*?]/.test(right)) {
    budget.work -= left.length + right.length;
    return budget.work < 0 ? null : left === right;
  }
  const width = right.length + 1, states = (left.length + 1) * width;
  if (states > GLOB_BOUNDS.states) return null;
  const seen = new Uint8Array(states), stack = [0];
  while (stack.length) {
    if (--budget.work < 0) return null;
    const key = stack.pop();
    if (seen[key]) continue;
    seen[key] = 1;
    const i = Math.floor(key / width), j = key % width;
    if (i === left.length && j === right.length) return true;
    const a = left[i], b = right[j];
    if (a === '*') { stack.push(key + width); if (j < right.length && b !== '*') stack.push(key + 1); }
    if (b === '*') { stack.push(key + 1); if (i < left.length && a !== '*') stack.push(key + width); }
    if (i < left.length && j < right.length && a !== '*' && b !== '*' && (a === '?' || b === '?' || a === b)) stack.push(key + width + 1);
  }
  return false;
}

// Two write-declarations conflict unless they provably name disjoint paths
// (issue 343 U0a: conservative segment-wise intersection). Declarations are
// possibly-directory patterns, as in claimPathMatches: ancestry conflicts. Disjoint
// only when both name different declared roots of the one execution contract, or
// when, at some depth before any `**`, the two segment patterns share no name.
// Literals compare case-insensitively (the file system may fold case); anything
// undecided — including work beyond GLOB_BOUNDS (U0a-r1) — is a conflict.
function pathsOverlap(a, b) {
  const left = declaredTarget(a), right = declaredTarget(b);
  if (!left || !right) return true; // defensive: empty/malformed/oversized path = unknown = conflict
  if (left.path === '.' || right.path === '.') return true; // workspace claim overlaps every path
  if (left.root !== null && right.root !== null && left.root !== right.root) return false;
  const sa = left.path.split('/'), sb = right.path.split('/'), budget = { work: GLOB_BOUNDS.work };
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i].includes('**') || sb[i].includes('**')) return true; // compatible prefix up to a globstar
    const shared = segmentsIntersect(sa[i].toLowerCase(), sb[i].toLowerCase(), budget);
    if (shared === null) return true; // bounds exhausted: undecided = conflict
    if (!shared) return false;
  }
  return true; // equal, or one is an ancestor of the other
}

function writesConflict(writesA, writesB) {
  if (!Array.isArray(writesA) || !Array.isArray(writesB)) return true;
  if (writesA.length === 0 || writesB.length === 0) return false; // empty = no writes = no conflict
  for (const a of writesA) {
    for (const b of writesB) {
      if (pathsOverlap(a, b)) return true;
    }
  }
  return false;
}

function copyItems(items) {
  return items.map(item => (typeof item === 'string' ? item : { ...item }));
}

// Parse the YAML frontmatter of a task plan. Returns { depends, writes, diagnostics }
// where each list is an array or null (null without a diagnostic = field absent →
// legacy). issue 343: both come from the shared structural decoder through this
// scheduling reader's fixed projection (U0a-r1). A complete list keeps every item,
// blank lines included, so write-coverage still observes each declared write; a
// YAML-null value (`writes:` with no list) or a malformed declaration is null.
// Every decoder diagnostic becomes an additive `diagnostics` entry
// (`<key>:<name>`): declaration-empty-value, the named error of a malformed
// declaration and the blank gaps the temporal guard refuses
// (declaration-leading-blank, declaration-interior-blank). A diagnosed task never
// becomes ready and never enters a batch.
function parseTaskFrontmatter(planPath) {
  if (!planPath || !fs.existsSync(planPath)) return null;
  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch (_) {
    return null;
  }
  const must = sharedDecoder();
  const fm = must.extractFrontmatter(text);
  if (fm === null) return null;
  const result = { depends: null, writes: null, diagnostics: [] };
  for (const key of ['depends', 'writes']) {
    const decoded = must.decodeDeclarationList(fm, key);
    if (decoded.status === 'valid') result[key] = copyItems(decoded.items);
    for (const name of decoded.diagnostics) result.diagnostics.push(`${key}:${name}`);
  }
  return result;
}

// Parse either inline (`key: [a, b]`) or block (`key:\n  - a\n  - b`) YAML list.
// Returns the array (possibly empty) or null if the key is not present. issue 343:
// the shared decoder reads it (the frontmatter passes through extractFrontmatter,
// the one CRLF normalizer). A complete list keeps every item, blank lines
// included; a YAML-null value or a malformed declaration throws
// plan-declaration-<key>-invalid (detail: the decoder diagnostic), never [].
function parseListField(fm, key) {
  const must = sharedDecoder();
  const normalized = must.extractFrontmatter(`---\n${String(fm)}\n---`);
  const decoded = must.decodeDeclarationList(normalized === null ? '' : normalized, key);
  if (decoded.status === 'absent') return null;
  if (decoded.status !== 'valid') {
    const detail = decoded.diagnostics[0];
    throw Object.assign(new Error(`plan-declaration-${key}-invalid: ${detail}`), { code: `plan-declaration-${key}-invalid`, detail });
  }
  return copyItems(decoded.items);
}

// Discover tasks by scanning the sibling `tasks/T##/` directories on disk.
// A task is "done" iff its `T##-SUMMARY.md` exists — this matches the dispatch table's
// source-of-truth (orchestrator already uses SUMMARY presence as the done signal).
function discoverTasks(sliceDir) {
  const tasksRoot = path.join(sliceDir, 'tasks');
  if (!fs.existsSync(tasksRoot)) return [];
  const entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^T\d+(\.\d+)?$/.test(e.name)) continue;
    const id = e.name;
    const taskDir = path.join(tasksRoot, id);
    const planPath = path.join(taskDir, id + '-PLAN.md');
    const summaryPath = path.join(taskDir, id + '-SUMMARY.md');
    if (!fs.existsSync(planPath)) continue;
    tasks.push({
      id,
      done: fs.existsSync(summaryPath),
      planPath,
    });
  }
  // Sort decimal-aware: T03 < T03.1 < T03.2 < T04.
  // Parse T(\d+)(?:\.(\d+))? — sub-tasks without .N get minor = -1 (sort before sub-tasks).
  function parseTaskId(id) {
    const m = id.match(/^T(\d+)(?:\.(\d+))?$/);
    if (!m) return { major: 0, minor: -1 };
    return { major: parseInt(m[1], 10), minor: m[2] !== undefined ? parseInt(m[2], 10) : -1 };
  }
  tasks.sort((a, b) => {
    const pa = parseTaskId(a.id);
    const pb = parseTaskId(b.id);
    if (pa.major !== pb.major) return pa.major - pb.major;
    return pa.minor - pb.minor;
  });
  return tasks;
}

// issue 343 U0a: the pure task DAG of one slice. `rows` are { id, depends, writes,
// invalid? } (null depends/writes = absent declaration; `invalid` = decoder
// diagnostics); `scopeTaskIds` is the canonical actionable S-plan set, not a
// directory scan. Status: `invalid` for any diagnostic (bad or duplicate IDs, set
// mismatch, missing plan, malformed declaration, unknown/self reference, cycle);
// `legacy` when declarations are absent and `legacyPolicy` is 'sequential' (the
// default 'refuse' makes them invalid); else `valid`. The graph digest covers task
// IDs, edges and legacy IDs only — never checkbox or done state. No prefs, lease,
// claim, worker or filesystem access.
const LOCAL_TASK_ID = /^T\d+(?:\.\d+)?$/;
const DAG_LEGACY_POLICIES = Object.freeze(['refuse', 'sequential']);
function deepFreezeDag(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreezeDag(item);
  }
  return value;
}
function validateTaskDag(rows, options) {
  const opts = options || {}, policy = opts.legacyPolicy === undefined ? 'refuse' : opts.legacyPolicy;
  const result = (status, taskIds, edges, order, legacy, diagnostics) => deepFreezeDag({
    status, task_ids: taskIds, edges, topological_order: order,
    graph_sha256: status === 'invalid' ? null : crypto.createHash('sha256').update(JSON.stringify({
      schema: 'forge-task-dag-v1', task_ids: taskIds, edges: edges.map(edge => [edge.task, edge.depends_on]), legacy_task_ids: legacy,
    }), 'utf8').digest('hex'),
    legacy_task_ids: legacy, diagnostics,
  });
  if (!Array.isArray(rows) || !Array.isArray(opts.scopeTaskIds) || !DAG_LEGACY_POLICIES.includes(policy)) {
    return result('invalid', [], [], null, [], ['dag-input-invalid']);
  }
  const diagnostics = [], taskIds = [], scoped = new Set();
  for (const id of opts.scopeTaskIds) {
    if (typeof id !== 'string' || !LOCAL_TASK_ID.test(id)) { diagnostics.push(`dag-task-id-invalid:${String(id)}`); continue; }
    if (scoped.has(id)) { diagnostics.push(`dag-scope-duplicate:${id}`); continue; }
    scoped.add(id); taskIds.push(id);
  }
  const byId = new Map();
  for (const row of rows) {
    const id = row && row.id;
    if (typeof id !== 'string' || !LOCAL_TASK_ID.test(id)) { diagnostics.push(`dag-task-id-invalid:${String(id)}`); continue; }
    if (byId.has(id)) { diagnostics.push(`dag-task-id-duplicate:${id}`); continue; }
    byId.set(id, row);
    if (!scoped.has(id)) diagnostics.push(`dag-task-unlisted:${id}`);
  }
  const position = new Map(taskIds.map((id, index) => [id, index]));
  const legacy = [], edges = [], prerequisites = new Map();
  for (const id of taskIds) {
    const row = byId.get(id);
    if (!row) { diagnostics.push(`dag-plan-missing:${id}`); continue; }
    const invalid = Array.isArray(row.invalid) ? row.invalid : [];
    for (const entry of invalid) diagnostics.push(`dag-declaration-invalid:${id}:${entry}`);
    if (invalid.length) continue;
    const absent = ['depends', 'writes'].filter(key => row[key] === null || row[key] === undefined);
    for (const key of ['depends', 'writes']) {
      if (!absent.includes(key) && !Array.isArray(row[key])) diagnostics.push(`dag-declaration-invalid:${id}:${key}`);
    }
    if (absent.length && policy === 'sequential') legacy.push(id);
    else for (const key of absent) diagnostics.push(`dag-declaration-missing:${id}:${key}`);
    if (!Array.isArray(row.depends)) continue;
    const own = new Set();
    for (const dependency of row.depends) {
      if (typeof dependency !== 'string' || !LOCAL_TASK_ID.test(dependency)) { diagnostics.push(`dag-reference-invalid:${id}`); continue; }
      if (dependency === id) { diagnostics.push(`dag-reference-self:${id}`); continue; }
      if (!scoped.has(dependency)) { diagnostics.push(`dag-reference-unknown:${id}:${dependency}`); continue; }
      own.add(dependency);
    }
    const sorted = [...own].sort((x, y) => position.get(x) - position.get(y));
    prerequisites.set(id, sorted);
    for (const dependency of sorted) edges.push({ task: id, depends_on: dependency });
  }
  // One deterministic cycle report (depth-first, canonical order).
  const state = new Map();
  let cycle = null;
  const visit = (id, trail) => {
    if (cycle || state.get(id) === 2) return;
    if (state.get(id) === 1) { cycle = [...trail.slice(trail.indexOf(id)), id]; return; }
    state.set(id, 1); trail.push(id);
    for (const next of prerequisites.get(id) || []) visit(next, trail);
    trail.pop(); state.set(id, 2);
  };
  for (const id of taskIds) visit(id, []);
  if (cycle) diagnostics.push(`dag-cycle:${cycle.join('>')}`);
  if (diagnostics.length) return result('invalid', taskIds, edges, null, legacy, diagnostics);
  if (legacy.length) return result('legacy', taskIds, edges, null, legacy, diagnostics);
  // Kahn order with the canonical S-plan order as the tie-break.
  const remaining = new Set(taskIds), order = [];
  while (remaining.size) {
    const next = taskIds.find(id => remaining.has(id) && (prerequisites.get(id) || []).every(dependency => !remaining.has(dependency)));
    if (next === undefined) return result('invalid', taskIds, edges, null, legacy, ['dag-cycle:unresolved']);
    order.push(next); remaining.delete(next);
  }
  return result('valid', taskIds, edges, order, legacy, diagnostics);
}

function main() {
  const args = parseArgs(process.argv);
  const slicePlanPath = args['slice-plan'];
  const maxConcurrent = Math.max(1, parseInt(args['max-concurrent'] || '3', 10) || 3);

  if (!slicePlanPath) {
    emit({ mode: 'error', batch: [], reason: 'missing --slice-plan argument' }, 1);
    return;
  }
  if (!fs.existsSync(slicePlanPath)) {
    emit({ mode: 'error', batch: [], reason: 'slice-plan not found: ' + slicePlanPath }, 1);
    return;
  }

  const sliceDir = path.dirname(slicePlanPath);
  const tasks = discoverTasks(sliceDir);

  if (tasks.length === 0) {
    emit({ mode: 'none', batch: [], reason: 'no tasks/T##/T##-PLAN.md files found under slice' });
    return;
  }

  // Enrich with frontmatter. Use forward-slash paths in output.
  const enriched = tasks.map(t => {
    const fm = parseTaskFrontmatter(t.planPath);
    return {
      id: t.id,
      done: t.done,
      depends: fm ? fm.depends : null,
      writes: fm ? fm.writes : null,
      invalid: fm ? fm.diagnostics : [],
      planPath: normalizeFilesystemPath(t.planPath),
    };
  });

  const pending = enriched.filter(t => !t.done);
  if (pending.length === 0) {
    emit({ mode: 'none', batch: [], reason: 'all tasks complete' });
    return;
  }

  // issue 343 U0a: this compatibility reader's scope is the discovered task set.
  const dag = validateTaskDag(enriched.map(t => ({ id: t.id, depends: t.depends, writes: t.writes, invalid: t.invalid })),
    { scopeTaskIds: enriched.map(t => t.id), legacyPolicy: 'sequential' });
  const graph = { dag_status: dag.status, diagnostics: [...dag.diagnostics] };

  // Legacy mode: any task in the slice is missing depends/writes → force sequential.
  if (dag.status === 'legacy') {
    const next = pending[0];
    emit({
      mode: 'legacy',
      batch: [{ id: next.id, planPath: next.planPath }],
      reason: 'legacy plan — at least one task missing depends/writes frontmatter; forcing sequential',
      ...graph,
    });
    return;
  }

  // Modern mode: build ready set. A task whose declarations are malformed is never ready.
  const doneIds = new Set(enriched.filter(t => t.done).map(t => t.id));
  const knownIds = new Set(enriched.map(t => t.id));
  const ready = pending.filter(t =>
    t.invalid.length === 0 && Array.isArray(t.depends) && Array.isArray(t.writes) && t.depends.every(d => doneIds.has(d))
  );

  if (ready.length === 0) {
    emit({
      mode: 'blocked',
      batch: [],
      reason: 'all pending tasks have unmet dependencies',
      details: {
        pending: pending.map(t => ({
          id: t.id,
          depends: t.depends,
          unmet: (t.depends || []).filter(d => !doneIds.has(d)),
        })),
      },
      ...graph,
    });
    return;
  }

  // Conflict resolution — greedy pick preserving plan order. An invalid graph is
  // sequential: one task at a time, never a parallel batch.
  const limit = dag.status === 'valid' ? maxConcurrent : 1;
  const batch = [];
  const claimed = [];
  const skipped = [];
  for (const t of ready) {
    if (batch.length >= limit) {
      skipped.push({ id: t.id, reason: dag.status === 'valid' ? 'max-concurrent reached' : 'sequential: invalid task graph' });
      continue;
    }
    const w = t.writes || [];
    const conflictWith = claimed.find(c => writesConflict(c.writes, w));
    if (conflictWith) {
      skipped.push({ id: t.id, reason: 'writes conflict with ' + conflictWith.id });
      continue;
    }
    // Also: if any unknown dep id appears in depends, warn (defensive).
    const strayDeps = (t.depends || []).filter(d => !knownIds.has(d));
    if (strayDeps.length > 0) {
      skipped.push({ id: t.id, reason: 'unknown dependency ids: ' + strayDeps.join(',') });
      continue;
    }
    batch.push({ id: t.id, planPath: t.planPath });
    claimed.push({ id: t.id, writes: w });
  }

  if (batch.length === 0) {
    // Every ready task was filtered out — surface as blocked so orchestrator can react.
    emit({
      mode: 'blocked',
      batch: [],
      reason: 'all ready tasks filtered out (conflicts or stray deps)',
      details: { skipped },
      ...graph,
    });
    return;
  }

  const mode = batch.length > 1 ? 'parallel' : 'single';
  emit({
    mode,
    batch,
    reason: mode === 'parallel'
      ? batch.length + ' independent tasks ready (' + ready.length + ' in ready set)'
      : 'single task ready (' + ready.length + ' in ready set)',
    details: {
      readyCount: ready.length,
      pendingCount: pending.length,
      maxConcurrent,
      skipped,
    },
    ...graph,
  });
}

module.exports = {
  globToRegex,
  normalizePath: normalizeFilesystemPath,
  normalizeFilesystemPath,
  canonicalizeClaimPath,
  claimPathMatches,
  pathsOverlap,
  writesConflict,
  parseTaskFrontmatter,
  parseListField,
  discoverTasks,
  validateTaskDag,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    emit({ mode: 'error', batch: [], reason: 'parser error: ' + (e && e.message || String(e)) }, 1);
  }
}
