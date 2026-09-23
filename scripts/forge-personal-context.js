#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveUserHome } = require('./forge-home');
const { resolveOwner } = require('./forge-workspace');
const { resolveRunAddress } = require('./forge-run-address');
const { validateWorktreeIdentity } = require('./forge-isolation');
const ids = require('./forge-ids');
const state = require('./forge-state');
const lock = require('./forge-lock');

const SCHEMA_VERSION = 1;
const CAPTURES = ['nextAction', 'pending', 'acceptances', 'lastResult', 'handoff'];
const emptyStore = () => ({ schemaVersion: SCHEMA_VERSION, projects: {} });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (reason, error) => ({ status: 'error', reason, ...(error ? { message: error.message } : {}) });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('absolute-path-required');
  const resolved = fs.realpathSync(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function within(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function validId(id, kind) {
  return typeof id === 'string' && ids.isValid(id) && ['task', 'milestone'].includes(ids.entityKind(id))
    && (!kind || ids.entityKind(id) === kind);
}
function unanchoredProject(options) {
  return options.project != null && (typeof options.project !== 'string' || !path.isAbsolute(options.project));
}
function paths(options = {}) {
  const home = resolveUserHome(options);
  const root = path.join(home, '.forge-personal');
  for (const entry of [root, path.join(root, 'context.json'), path.join(root, '.gsd'), path.join(root, '.gsd', '.locks'), path.join(root, '.gsd', '.locks', 'context')]) {
    if (fs.existsSync(entry) && !within(canonical(entry), path.join(canonical(home), '.forge-personal'))) throw new Error('personal-namespace-escape');
  }
  return { root, file: path.join(root, 'context.json') };
}
function readJson(file) {
  try { return { status: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (error) {
    return { ...failure(error.code === 'ENOENT' ? 'missing' : error instanceof SyntaxError ? 'corrupt' : 'unreadable', error), file };
  }
}
function validCapture(value) {
  return object(value) && typeof value.text === 'string' && typeof value.source === 'string'
    && path.isAbsolute(value.source) && /^[a-f0-9]{64}$/.test(value.hash)
    && typeof value.capturedAt === 'string' && typeof value.resolved === 'boolean';
}
function validStore(store) {
  if (!object(store) || !object(store.projects)) return false;
  for (const [key, project] of Object.entries(store.projects)) {
    if (!object(project) || typeof project.path !== 'string' || !path.isAbsolute(project.path)
      || digest(project.path) !== key || !Array.isArray(project.aliases) || !object(project.bindings)) return false;
    if (project.aliases.some(a => !object(a) || typeof a.path !== 'string' || typeof a.repo !== 'string' || !path.isAbsolute(a.path) || !path.isAbsolute(a.repo)
      || !within(a.repo, project.path) || typeof a.branch !== 'string')) return false;
    for (const [id, binding] of Object.entries(project.bindings)) {
      if (!object(binding) || !validId(id, binding.kind) || binding.id !== id
        || !['create', 'explicit-resume'].includes(binding.origin) || typeof binding.boundAt !== 'string'
        || !object(binding.checkpoint)) return false;
      for (const [field, captures] of Object.entries(binding.checkpoint)) {
        if (!CAPTURES.includes(field) || !Array.isArray(captures) || !captures.every(validCapture)) return false;
      }
    }
  }
  return true;
}
function readStore(options) {
  let result;
  try { result = readJson(paths(options).file); } catch (error) { return failure('namespace-invalid', error); }
  if (result.status !== 'ok') return result;
  if (!object(result.value) || result.value.schemaVersion !== SCHEMA_VERSION) return failure('schema-unsupported');
  return validStore(result.value) ? result : failure('schema-invalid');
}

function validAlias(project, alias) {
  try {
    return within(canonical(alias.repo), project.path) && canonical(alias.path) === alias.path
      && validateWorktreeIdentity(alias.repo, alias.path, alias.branch).ok;
  } catch { return false; }
}

// Existing ancestors are resolved even for missing files: a symlink cannot hide
// behind ENOENT and turn a project-relative reference into an arbitrary read.
function safeSource(project, source) {
  if (typeof source !== 'string' || !source) throw new Error('invalid-source');
  const absolute = path.isAbsolute(source) ? source : path.resolve(project.path, source);
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('source-unresolvable');
    ancestor = parent;
  }
  const actual = path.resolve(canonical(ancestor), path.relative(ancestor, absolute));
  const roots = [project.path, ...project.aliases.filter(a => validAlias(project, a)).map(a => a.path)];
  if (!roots.some(root => within(actual, root))) throw new Error('source-outside-project');
  return actual;
}
function resolveProject(store, options, mutation = false) {
  if (options.project) {
    const projectPath = canonical(options.project);
    if (mutation && canonical(resolveOwner(projectPath) || projectPath) !== projectPath) throw new Error('project-not-owner');
    return { key: digest(projectPath), path: projectPath };
  }
  const cwd = canonical(options.cwd || process.cwd());
  const candidates = Object.entries(store.projects).filter(([, project]) => within(cwd, project.path)
    || project.aliases.some(a => within(cwd, a.path) && validAlias(project, a)));
  candidates.sort((a, b) => b[1].path.length - a[1].path.length);
  if (candidates.length) return { key: candidates[0][0], path: candidates[0][1].path };
  if (mutation) {
    const owner = resolveOwner(cwd);
    if (owner) return { key: digest(canonical(owner)), path: canonical(owner) };
  }
  return null;
}
function mutate(options, operation) {
  let location;
  let handle, temp, result;
  const perform = () => {
    location = paths(options);
    // Validate before mkdir, then reread under the shared personal mutex.
    const prior = readStore(options);
    if (prior.status !== 'ok' && prior.reason !== 'missing') return prior;
    fs.mkdirSync(path.join(location.root, '.gsd'), { recursive: true });
    handle = lock.acquireSync(location.root, 'context', { retries: 100, backoffMin: 10, backoffMax: 30 });
    const current = readStore(options);
    if (current.status !== 'ok' && current.reason !== 'missing') return current;
    const store = current.status === 'ok' ? current.value : emptyStore();
    const result = operation(store);
    if (result.status !== 'ok' || result.unchanged) return result;
    if (!validStore(store)) return failure('schema-invalid');
    temp = `${location.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (!lock.assertOwned(handle)) return failure('lock-lost');
    fs.renameSync(temp, location.file);
    return result;
  };
  try { result = perform(); } catch (error) { result = failure('write-failed', error); }
  const cleanup = [];
  try { if (temp && fs.existsSync(temp)) fs.unlinkSync(temp); } catch (error) { cleanup.push({ reason: 'temporary-cleanup-failed', message: error.message }); }
  try {
    if (handle) {
      const released = lock.releaseHandle(handle);
      if (!released.ok) cleanup.push({ reason: 'lock-release-failed', detail: released });
    }
  } catch (error) { cleanup.push({ reason: 'lock-release-failed', message: error.message }); }
  if (cleanup.length) {
    return { ...result, status: result.status === 'ok' ? 'partial' : result.status, cleanup,
      recovery: 'Inspect the private context lock ownership before retrying; do not assume expiry repaired it.' };
  }
  return result;
}

function bindWork(options = {}) {
  if (!validId(options.id, options.kind)) return failure('invalid-id');
  if (!['create', 'explicit-resume'].includes(options.intent)) return failure('intent-required');
  if (unanchoredProject(options)) return failure('project-unanchored');
  return mutate(options, store => {
    const address = resolveProject(store, options, true);
    if (!address || !fs.existsSync(path.join(address.path, '.gsd'))) return failure('project-unresolved');
    const record = readJson(safeSource({ path: address.path, aliases: [] }, path.join('.gsd', 'forge', 'runs', `${options.id}.json`)));
    const aliases = [];
    if (record.status === 'ok') {
      if (!object(record.value) || record.value.id !== options.id || record.value.kind !== ids.entityKind(options.id)) return failure('run-invalid');
      if (record.value.project && (!path.isAbsolute(record.value.project) || canonical(record.value.project) !== address.path)) return failure('run-project-mismatch');
      // Empty explicit registry bounds resolveRunAddress to this project and ID.
      const runAddress = resolveRunAddress(address.path, options.id, { home: resolveUserHome(options), registry: { version: 1, roots: [], entries: [], quarantine: [] } });
      if (!runAddress.project.path || canonical(runAddress.project.path) !== address.path) return failure('run-project-mismatch');
      for (const wt of runAddress.run.worktrees) {
        if (!wt || !path.isAbsolute(wt.repo || '') || !path.isAbsolute(wt.path || '') || !within(canonical(wt.repo), address.path)
          || !validateWorktreeIdentity(wt.repo, wt.path, runAddress.run.branch).ok) return failure('worktree-invalid');
        aliases.push({ repo: canonical(wt.repo), path: canonical(wt.path), branch: runAddress.run.branch });
      }
    } else if (record.reason !== 'missing') return { ...record, reason: `run-${record.reason}` };
    const directory = path.join(address.path, '.gsd', ids.entityKind(options.id) === 'task' ? 'tasks' : 'milestones', options.id);
    if (!fs.existsSync(directory) || !within(canonical(directory), address.path)) return failure('work-missing');
    const project = store.projects[address.key] || { path: address.path, aliases: [], bindings: {} };
    for (const alias of aliases) if (!project.aliases.some(a => a.path === alias.path && a.branch === alias.branch)) project.aliases.push(alias);
    const existing = project.bindings[options.id];
    project.bindings[options.id] = existing || { id: options.id, kind: ids.entityKind(options.id), origin: options.intent, boundAt: new Date().toISOString(), checkpoint: {} };
    store.projects[address.key] = project;
    return { status: 'ok', reason: existing ? 'already-bound' : 'bound', id: options.id, project: address.path };
  });
}

function saveCheckpoint(options = {}) {
  if (!validId(options.id)) return failure('invalid-id');
  if (options.intent !== 'checkpoint' || !object(options.checkpoint)) return failure('intent-required');
  if (unanchoredProject(options)) return failure('project-unanchored');
  return mutate(options, store => {
    const address = resolveProject(store, options);
    const project = address && store.projects[address.key];
    const binding = project && project.bindings[options.id];
    if (!binding) return failure('not-bound');
    const next = { ...binding.checkpoint };
    for (const [field, entries] of Object.entries(options.checkpoint)) {
      if (!CAPTURES.includes(field) || !Array.isArray(entries)) return failure('checkpoint-invalid');
      const captures = entries.map(entry => {
        if (!object(entry) || typeof entry.text !== 'string' || !entry.text.trim()) throw new Error('capture-text-required');
        const source = safeSource(project, entry.source);
        return { text: entry.text, source, hash: digest(fs.readFileSync(source)), capturedAt: new Date().toISOString(), resolved: entry.resolved === true };
      });
      // Acceptances are historical decisions: retain previous observations.
      if (field === 'acceptances') {
        next[field] = [...(next[field] || [])];
        for (const capture of captures) {
          const latest = next[field].filter(old => old.text === capture.text).at(-1);
          if (!latest || latest.hash !== capture.hash || latest.source !== capture.source || latest.resolved !== capture.resolved) next[field].push(capture);
        }
      } else next[field] = captures;
    }
    binding.checkpoint = next;
    return { status: 'ok', reason: 'checkpoint-saved', id: options.id };
  });
}
function observe(project, capture) {
  try {
    const source = safeSource(project, capture.source);
    const hash = digest(fs.readFileSync(source));
    return { ...capture, validity: hash === capture.hash ? 'current' : 'stale' };
  } catch (error) { return { ...capture, validity: error.code === 'ENOENT' ? 'missing' : 'unreadable', diagnostic: error.message }; }
}
function inspectWork(project, binding) {
  const checkpoint = Object.fromEntries(Object.entries(binding.checkpoint).map(([field, entries]) => [field, entries.map(c => observe(project, c))]));
  const read = relative => {
    try {
      const source = safeSource(project, relative);
      const content = fs.readFileSync(source, 'utf8');
      return { status: 'ok', source, hash: digest(content), content };
    } catch (error) { return failure(error.code === 'ENOENT' ? 'missing' : 'unreadable', error); }
  };
  const registry = read(path.join('.gsd', 'forge', 'runs', `${binding.id}.json`));
  let activity = 'unknown', runDiagnostic = registry.reason || null;
  if (registry.status === 'ok') {
    try {
      const run = JSON.parse(registry.content);
      if (!object(run) || run.id !== binding.id || run.kind !== binding.kind || typeof run.active !== 'boolean') throw new Error('run-schema');
      if (run.project && (!path.isAbsolute(run.project) || canonical(run.project) !== project.path)) throw new Error('run-project-mismatch');
      activity = run.active ? 'active' : 'inactive';
    } catch { runDiagnostic = 'corrupt'; }
  }
  const terminalFile = binding.kind === 'task'
    ? path.join('.gsd', 'tasks', binding.id, `${binding.id}-PLAN.md`)
    : path.join('.gsd', 'milestones', binding.id, `${binding.id}-STATE.md`);
  const terminal = read(terminalFile);
  let completed = false, nextAction = null, validatedState = null;
  if (terminal.status === 'ok') {
    if (binding.kind === 'task') completed = /^---\r?\n[\s\S]*?^status:\s*["']?DONE["']?\s*\r?$/m.test(terminal.content.split(/\r?\n---/)[0]);
    else {
      try {
        const current = state.read(project.path, binding.id);
        if (!current || current.milestone !== binding.id || !/^---\r?\n/.test(current._raw)) terminal.reason = 'state-invalid';
        else if (digest(current._raw) !== terminal.hash) terminal.reason = 'state-changed';
        else {
          validatedState = { milestone: binding.id, phase: current.phase, active_slice: current.active_slice,
            active_task: current.active_task, auto_mode: current.auto_mode };
          completed = /^(done|completed)$/i.test(current._frontmatter.status || '');
          nextAction = current.next_action ? { text: current.next_action, source: terminal.source, hash: terminal.hash, validity: 'current' } : null;
        }
      } catch (error) { terminal.reason = error.code === 'ENOENT' ? 'state-missing' : 'state-unreadable'; }
    }
  }
  // Older acceptance observations remain visible, but an explicit recapture of
  // the same decision supersedes their confidence without deleting history.
  const effectiveAcceptances = (checkpoint.acceptances || []).filter((capture, index, entries) => !entries.slice(index + 1).some(later => later.text === capture.text));
  const observations = Object.entries(checkpoint).flatMap(([field, entries]) => field === 'acceptances' ? effectiveAcceptances : entries);
  // Loose-task SUMMARY is only terminal when explicitly captured as the final
  // result after reconciliation. Its presence alone never completes the work.
  const finalResult = (checkpoint.lastResult || []).find(c => c.resolved && c.validity === 'current');
  if (finalResult) completed = true;
  const unreliable = observations.some(c => c.validity !== 'current');
  const pending = (checkpoint.pending || []).some(c => !c.resolved) || effectiveAcceptances.some(c => !c.resolved);
  const actionable = (checkpoint.nextAction || []).some(c => !c.resolved);
  const workStatus = completed && !pending && !actionable && !unreliable ? 'completed' : pending ? 'pending' : terminal.status !== 'ok' || terminal.reason ? 'unknown' : 'open';
  const action = unreliable ? { text: 'Reconcile changed or missing sources; preserve recorded acceptances.', validity: 'reconciliation-required' }
    : (checkpoint.nextAction || []).find(c => !c.resolved) || nextAction;
  return { id: binding.id, kind: binding.kind, activity, runDiagnostic, workStatus, checkpoint,
    state: validatedState && !unreliable ? { ...validatedState, next_action: action ? action.text : '' } : null,
    reliability: unreliable ? 'needs-reconciliation' : runDiagnostic && runDiagnostic !== 'missing' ? `run-${runDiagnostic}` : finalResult ? 'current' : terminal.reason || 'current',
    nextAction: action,
    lastResult: (checkpoint.lastResult || []).filter(c => c.validity === 'current').at(-1) || null,
    terminalEvidence: finalResult ? { source: finalResult.source, hash: finalResult.hash, completed } : terminal.status === 'ok' ? { source: terminal.source, hash: terminal.hash, completed } : { reason: terminal.reason } };
}

function readPersonalSnapshot(options = {}) {
  if (unanchoredProject(options)) return { ...failure('project-unanchored'), works: [], scope: 'personal' };
  if (options.inspect === true) {
    if (!validId(options.id)) return failure('invalid-id');
    try {
      const existing = readStore(options);
      const address = resolveProject(existing.status === 'ok' ? existing.value : emptyStore(), options, true);
      if (!address) return failure('project-unresolved');
      return { status: 'ok', reason: 'explicit-inspection', scope: 'inspection', project: address.path,
        works: [inspectWork({ path: address.path, aliases: [] }, { id: options.id, kind: ids.entityKind(options.id), checkpoint: {} })] };
    } catch (error) { return failure('project-unresolved', error); }
  }
  const store = readStore(options);
  if (store.status !== 'ok') return store.reason === 'missing'
    ? { status: 'ok', reason: 'no-bindings', works: [], scope: 'personal' } : { ...store, works: [], scope: 'personal' };
  try {
    const address = resolveProject(store.value, options);
    if (!address) return { ...failure('project-unresolved'), works: [], scope: 'personal' };
    const project = address && store.value.projects[address.key];
    if (!project) return { status: 'ok', reason: 'no-bindings', works: [], scope: 'personal' };
    if (canonical(project.path) !== project.path) return failure('project-changed');
    const works = Object.values(project.bindings).filter(b => !options.id || b.id === options.id).map(b => inspectWork(project, b));
    return { status: 'ok', reason: works.length ? 'snapshot' : 'no-bindings', scope: 'personal', project: project.path, works };
  } catch (error) { return { ...failure('project-unresolved', error), works: [], scope: 'personal' }; }
}
function selectPersonalWork(options = {}) {
  const snapshot = readPersonalSnapshot(options);
  if (snapshot.status !== 'ok') return snapshot;
  const candidates = snapshot.works.filter(w => w.workStatus === 'open' && w.reliability === 'current');
  const unresolved = snapshot.works.some(w => w.workStatus !== 'completed');
  return { ...snapshot, reason: candidates.length > 1 ? 'selection-required' : candidates.length ? 'selected' : unresolved ? 'attention-required' : snapshot.works.length ? 'all-completed' : 'no-bindings',
    candidates: candidates.map(w => ({ id: w.id, kind: w.kind })), selected: candidates.length === 1 ? candidates[0] : null };
}

module.exports = { bindWork, saveCheckpoint, readPersonalSnapshot, selectPersonalWork };
if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (!flag.startsWith('--')) continue;
    args[flag.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  }
  let result;
  try {
    const options = { project: args.project, cwd: args.cwd, id: args.id, intent: args.intent };
    if (args.bind) result = bindWork(options);
    else if (args.checkpoint) result = saveCheckpoint({ ...options, checkpoint: JSON.parse(fs.readFileSync(args.file, 'utf8')) });
    else if (args.select) result = selectPersonalWork(options);
    else if (args.snapshot) result = readPersonalSnapshot(options);
    else result = failure('command-required');
  } catch (error) { result = failure('invalid-arguments', error); }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'ok' ? 0 : 1;
}
