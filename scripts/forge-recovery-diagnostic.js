#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ids = require('./forge-ids');
const personal = require('./forge-personal-context');
const recovery = require('./forge-claim-recovery');
const claims = require('./forge-write-claim');
const stuck = require('./forge-claim-stuck');
const controller = require('./forge-unit-controller');
const lease = require('./forge-unit-lease');
const { RESULT_STATUSES } = require('./forge-runtime');
const { resolveUserHome } = require('./forge-home');
const { validateWorktreeIdentity } = require('./forge-isolation');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && ids.isValid(id) && ['task', 'milestone'].includes(ids.entityKind(id));
// Controller filenames are base64url(key) + '.json', bounded to 255 bytes.
const validKey = key => typeof key === 'string' && key.trim() === key && key.length > 0
  && Buffer.from(key).toString('base64url').length + 5 <= 255 && !/[\x00-\x1f\x7f]/.test(key);
function samePath(a, b) {
  try { return path.relative(fs.realpathSync.native(a), fs.realpathSync.native(b)) === ''; }
  catch { return false; }
}

// Public diagnostics never interpolate exception messages or serialize internal records.
function reason(error) {
  if (error.code === 'ENOENT') return 'missing';
  if (error instanceof SyntaxError) return 'corrupt';
  if (error.code === 'ENAMETOOLONG') return 'invalid-name';
  if (error.code) return 'unreadable';
  return /-(path-escape|path-reparse|root-missing)$/.test(error.message || '') ? 'unsafe-path' : 'internal-error';
}
function readEvidence(root, file, json = true) {
  try {
    recovery.assertSafePath(root, file, 'diagnostic');
    const bytes = fs.readFileSync(file);
    return { state: 'current', source: file, hash: recovery.sha256(bytes), value: json ? JSON.parse(bytes.toString('utf8')) : bytes };
  } catch (error) { return { state: reason(error) }; }
}
function source(report, name, observation, uncertain = observation.state !== 'current') {
  report.sources.push({ name, state: observation.state, ...(observation.source ? { source: observation.source } : {}), ...(observation.hash ? { hash: observation.hash } : {}) });
  if (uncertain) report.uncertainties.push(`${name}: ${observation.state}`);
}
function safeRoot(project, target, aliases = []) {
  try { recovery.assertSafePath(project, target, 'source'); return project; } catch { /* validated worktree below */ }
  for (const alias of aliases) {
    if (!object(alias) || !path.isAbsolute(alias.repo || '') || !path.isAbsolute(alias.path || '') || typeof alias.branch !== 'string') continue;
    try {
      recovery.assertSafePath(alias.path, target, 'source');
      recovery.assertSafePath(project, alias.repo, 'repo');
      if (!validateWorktreeIdentity(alias.repo, alias.path, alias.branch).ok) continue;
      return alias.path;
    } catch { /* fail closed */ }
  }
  throw new Error('source-outside-project');
}
function capture(value) {
  return { text: value.text, source: value.source, hash: value.hash, capturedAt: value.capturedAt,
    resolved: value.resolved, validity: value.validity };
}

// Resolve only project metadata, never enumerate runs or inspect peer bindings.
// This mirrors the personal reader's longest validated project/alias match so
// all subsequent scoped reads use the owner, including when cwd has no .gsd.
function diagnosticProject(cwd, options) {
  const home = resolveUserHome(options);
  const store = readEvidence(home, path.join(home, '.forge-personal', 'context.json'));
  if (store.state !== 'current' || !object(store.value) || store.value.schemaVersion !== 1 || !object(store.value.projects)) return cwd;
  const candidates = Object.entries(store.value.projects).filter(([key, entry]) => {
    if (!object(entry) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
      || recovery.sha256(Buffer.from(entry.path)) !== key || !Array.isArray(entry.aliases)) return false;
    try { safeRoot(entry.path, cwd, entry.aliases); return true; } catch { return false; }
  });
  candidates.sort((a, b) => b[1].path.length - a[1].path.length);
  return candidates.length ? candidates[0][1].path : cwd;
}

function inspectPersonal(project, id, options, report) {
  const home = resolveUserHome(options);
  const storeFile = path.join(home, '.forge-personal', 'context.json');
  // Read only this binding's source paths before invoking the canonical snapshot.
  // The canonical reader remains responsible for the full store schema/semantics.
  const store = readEvidence(home, storeFile);
  if (!['current', 'missing'].includes(store.state)) {
    source(report, 'personal-store', store); return;
  }
  if (store.state === 'current' && object(store.value) && object(store.value.projects)) {
    const canonicalProject = fs.realpathSync(project);
    const entry = store.value.projects[recovery.sha256(Buffer.from(process.platform === 'win32' ? canonicalProject.toLowerCase() : canonicalProject))];
    const binding = entry && entry.bindings && entry.bindings[id];
    if (binding && object(binding.checkpoint)) {
      try {
        for (const entries of Object.values(binding.checkpoint)) {
          if (!Array.isArray(entries)) continue;
          for (const item of entries) {
            if (!object(item) || typeof item.source !== 'string' || !path.isAbsolute(item.source)) throw new Error('source-invalid');
            safeRoot(project, item.source, Array.isArray(entry.aliases) ? entry.aliases : []);
          }
        }
      } catch { source(report, 'personal-sources', { state: 'unsafe-path' }); return; }
    }
  }
  const args = { ...options, project: undefined, cwd: options.project || options.cwd || project, id };
  let snapshot = personal.readPersonalSnapshot(args);
  const bound = snapshot.status === 'ok' && snapshot.reason !== 'no-bindings';
  if (snapshot.status === 'ok' && snapshot.reason === 'no-bindings') snapshot = personal.readPersonalSnapshot({ ...args, project, inspect: true });
  if (snapshot.status !== 'ok') {
    source(report, 'personal-store', { state: snapshot.reason }); return;
  }
  source(report, 'personal-store', store, false);
  const work = snapshot.works[0];
  const checkpoint = work.checkpoint;
  report.continuity = { bound, state: Object.values(checkpoint).some(entries => entries.length) ? 'recorded' : 'unproven',
    workStatus: work.workStatus, activity: work.activity,
    checkpoint: Object.fromEntries(Object.entries(checkpoint).map(([field, entries]) => [field, entries.map(capture)])) };
  for (const [field, entries] of Object.entries(checkpoint)) {
    const effective = field === 'acceptances' ? entries.filter((item, index) => !entries.slice(index + 1).some(later => later.text === item.text)) : entries;
    for (const item of effective) source(report, `checkpoint/${field}`, { state: item.validity, hash: item.hash });
  }
  report.pendingDecisions = (checkpoint.pending || []).filter(item => !item.resolved).map(capture);
  const acceptances = checkpoint.acceptances || [];
  report.pendingDecisions.push(...acceptances.filter((item, index) => !item.resolved && !acceptances.slice(index + 1).some(later => later.text === item.text)).map(capture));
  report.acceptances = acceptances.map(capture);
  if (work.lastResult) report.provenResults.push({ kind: 'personal-checkpoint', evidence: capture(work.lastResult) });
  if (report.continuity.state === 'unproven') report.uncertainties.push('Continuidade pessoal sem checkpoint comprovado.');
  if (report.pendingDecisions.length) report.uncertainties.push('Decisões humanas permanecem pendentes.');
  if (work.reliability !== 'current') report.uncertainties.push(`Continuidade: ${work.reliability}`);
}

function inspectClaim(project, id, record, report, runHash) {
  const claim = record.write_claim;
  if (claim == null) { report.claim = { state: 'absent' }; return; }
  try { claims.validateHeldClaim({ ...claim, released: null }); }
  catch { source(report, 'claim', { state: 'schema-invalid' }); return; }
  if (claim.released != null && claims.isHeld(claim)) {
    source(report, 'claim-release', { state: 'schema-invalid' }); return;
  }
  const classification = stuck.classifyStuck(record);
  report.claim = { state: claim.released ? 'released' : 'held', classification: classification.kind };
  if (classification.kind === 'stuck' || classification.kind === 'unmeasured') report.uncertainties.push(`Claim: ${classification.kind}; exige inspeção e decisão na autoridade original.`);
  if (!claim.released) return; // Orphan bundles are deliberately never discovered.
  report.provenResults.push({ kind: 'claim-release', at: claim.released.at, mechanism: claim.released.mechanism });
  const evidence = claim.released.evidence;
  if (!evidence || !evidence.bundle) return; // A clean release needs no bundle.
  const bundle = typeof evidence.bundle === 'string' ? path.resolve(project, evidence.bundle) : '';
  const root = path.join(project, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(id));
  let manifest;
  let artifact;
  try {
    recovery.assertSafePath(project, root, 'bundle');
    recovery.assertSafePath(root, bundle, 'bundle');
    artifact = { kind: 'claim-bundle', source: path.relative(project, bundle), existence: fs.existsSync(bundle) ? 'observed' : 'missing', integrity: 'unverified', conflicts: null };
    report.artifacts.push(artifact);
    manifest = readEvidence(project, path.join(bundle, 'manifest.json'));
    source(report, 'claim-manifest', manifest);
    if (manifest.state !== 'current') return;
    if (manifest.hash !== evidence.manifest_sha256) {
      source(report, 'claim-preview', { state: 'snapshot-changed' }); return;
    }
    recovery.assertSafePath(project, path.join(bundle, 'manifest.sha256'), 'bundle');
    const value = manifest.value;
    if (!object(value) || value.version !== 1 || value.run_id !== id || !Array.isArray(value.entries)
      || typeof value.code_dir !== 'string' || !path.isAbsolute(value.code_dir)) {
      source(report, 'claim-manifest-schema', { state: 'schema-invalid' }); return;
    }
    const aliases = Array.isArray(record.worktrees) ? record.worktrees.map(w => ({ ...w, branch: record.branch })) : [];
    const codeDirectory = value.code_dir;
    const codeRoot = safeRoot(project, codeDirectory, aliases);
    for (const entry of value.entries) {
      if (!object(entry) || typeof entry.path !== 'string' || path.isAbsolute(entry.path)) throw new Error('entry-invalid');
      recovery.assertSafePath(codeRoot, path.resolve(codeDirectory, entry.path), 'target');
      if (entry.present) {
        if (typeof entry.payload !== 'string') throw new Error('payload-invalid');
        recovery.assertSafePath(project, path.join(bundle, 'payload'), 'payload');
        recovery.assertSafePath(path.join(bundle, 'payload'), path.resolve(bundle, entry.payload), 'payload');
      }
    }
  } catch { source(report, 'claim-bundle', { state: 'unsafe-path' }); return; }
  const unchanged = () => {
    const currentRun = readEvidence(project, path.join(project, '.gsd', 'forge', 'runs', `${id}.json`));
    const currentManifest = readEvidence(project, path.join(bundle, 'manifest.json'));
    return currentRun.state === 'current' && currentRun.hash === runHash
      && currentManifest.state === 'current' && currentManifest.hash === manifest.hash;
  };
  if (!unchanged()) { source(report, 'claim-preview', { state: 'snapshot-changed' }); return; }
  const preview = recovery.restore(project, id, { apply: false });
  if (!unchanged()) { source(report, 'claim-preview', { state: 'snapshot-changed' }); return; }
  const verified = Array.isArray(preview.actions) && Array.isArray(preview.conflicts);
  artifact.integrity = verified ? 'verified' : 'unverified';
  artifact.conflicts = verified ? preview.conflicts.length : null;
  source(report, 'claim-preview', { state: preview.ok ? 'current' : verified ? 'conflicts' : 'integrity-unverified' });
}

function inspectController(project, id, key, report) {
  if (ids.entityKind(id) !== 'milestone' || !key) {
    report.controller = { coverage: 'unavailable', reason: ids.entityKind(id) === 'task' ? 'standalone-task' : 'key-not-provided' }; return;
  }
  const transaction = readEvidence(project, controller.transactionFile(project, key));
  source(report, 'controller-transaction', transaction);
  if (transaction.state !== 'current') return;
  const t = transaction.value;
  let unit;
  try { unit = lease.normalizeUnitKey(t.unit); } catch { /* schema failure below */ }
  if (!object(t) || t.protocol_version !== controller.PROTOCOL_VERSION || t.idempotency_key !== key
    || t.milestone !== id || !controller.PHASES.includes(t.phase) || !controller.ACTIONS.includes(t.action)
    || !object(t.unit) || !unit || t.unit.key !== unit || !validKey(unit)) {
    source(report, 'controller-identity', { state: 'schema-invalid' }); return;
  }
  report.controller = { coverage: 'observed', phase: t.phase, transactionCommitted: t.phase === 'committed', globalCompletion: 'unproven' };
  for (const [name, file] of [['result', controller.resultFile(project, key)], ['boundary', controller.boundaryFile(project, unit)]]) {
    if (t[name] == null) continue;
    const observed = readEvidence(project, file);
    source(report, `controller-${name}`, observed);
    if (observed.state !== 'current') continue;
    const v = observed.value;
    if (!object(v) || v.protocol_version !== controller.PROTOCOL_VERSION || !validKey(v.idempotency_key) || v.milestone !== id || v.unit !== unit) {
      source(report, `controller-${name}-identity`, { state: 'schema-invalid' }); continue;
    }
    if ((name === 'result' && !RESULT_STATUSES.includes(v.status))
      || (name === 'boundary' && (!controller.BOUNDARY_KINDS.includes(v.kind) || !RESULT_STATUSES.includes(v.outcome) || typeof v.handoff_ready !== 'boolean'))) {
      source(report, `controller-${name}-schema`, { state: 'schema-invalid' }); continue;
    }
    if (v.idempotency_key !== key) {
      source(report, `controller-${name}-identity`, { state: name === 'boundary' ? 'superseded' : 'schema-invalid' }); continue;
    }
    report.artifacts.push({ kind: `controller-${name}`, source: path.relative(project, file), existence: 'observed', integrity: 'identity-checked' });
    report.provenResults.push({ kind: `controller-${name}-published` });
  }
  if (t.phase !== 'committed') report.uncertainties.push('Controller interrompido: publicação pode preceder a fase; não repetir efeitos pelo diagnóstico.');
}

function inspectRecovery(options = {}) {
  if (!validId(options.id) || (options.controllerKey !== undefined && !validKey(options.controllerKey))) throw new TypeError('invalid-arguments');
  const report = { id: options.id, observedAt: new Date().toISOString(), status: 'partial', sources: [], provenResults: [],
    uncertainties: [], artifacts: [], continuity: { state: 'unproven' }, pendingDecisions: [], acceptances: [],
    claim: { state: 'unknown' }, controller: { coverage: 'unavailable' },
    uncovered: ['sweep', 'sidecar-reset', 'other-journals'],
    nextSafeStep: 'Inspecionar as fontes indicadas e resolver pendências na autoridade original; qualquer ação futura exige revalidação e autorização. Esta observação não autoriza replay nem atestações.' };
  let project;
  try {
    project = path.resolve(options.project || options.cwd || process.cwd());
    project = diagnosticProject(project, options);
    recovery.assertSafePath(project, path.join(project, '.gsd'), 'project');
    if (!fs.statSync(path.join(project, '.gsd')).isDirectory()) throw new Error('project-invalid');
    // Match personal-context's canonicalization (native realpath expands 8.3
    // names differently on Windows and would select a different store key).
    project = fs.realpathSync(project);
  } catch { source(report, 'project', { state: 'invalid' }); return report; }
  const run = readEvidence(project, path.join(project, '.gsd', 'forge', 'runs', `${options.id}.json`));
  source(report, 'run', run);
  if (run.state !== 'current') return report;
  const r = run.value;
  if (!object(r) || r.id !== options.id || r.kind !== ids.entityKind(options.id) || typeof r.active !== 'boolean'
    || (r.project != null && r.project !== '' && (typeof r.project !== 'string' || !path.isAbsolute(r.project) || !samePath(project, r.project)))) {
    source(report, 'run-identity', { state: 'schema-invalid' }); return report;
  }
  const directory = path.join(project, '.gsd', r.kind === 'task' ? 'tasks' : 'milestones', options.id);
  // Guard canonical personal-context reads before calling its reader.
  try {
    recovery.assertSafePath(project, directory, 'work');
    recovery.assertSafePath(project, path.join(directory, `${options.id}-${r.kind === 'task' ? 'PLAN' : 'STATE'}.md`), 'terminal');
  } catch { source(report, 'work', { state: 'unsafe-path' }); return report; }
  for (const suffix of [r.kind === 'task' ? 'PLAN' : 'STATE', 'SUMMARY']) {
    const file = path.join(directory, `${options.id}-${suffix}.md`);
    const observed = readEvidence(project, file, false);
    if (observed.state === 'current') report.artifacts.push({ kind: suffix.toLowerCase(), source: path.relative(project, file), hash: observed.hash, existence: 'observed', integrity: 'unverified' });
    if (suffix !== 'SUMMARY' || observed.state !== 'missing') source(report, suffix.toLowerCase(), observed);
  }
  inspectPersonal(project, options.id, options, report);
  inspectClaim(project, options.id, r, report, run.hash);
  inspectController(project, options.id, options.controllerKey, report);
  report.status = report.uncertainties.length ? 'partial' : 'ok';
  return report;
}

function renderRecovery(report) {
  const sections = [['Fontes e estado da evidência', report.sources], ['Resultado comprovado', report.provenResults],
    ['Incertezas', report.uncertainties], ['Artefatos preservados', report.artifacts], ['Continuidade pessoal', report.continuity],
    ['Decisões pendentes', report.pendingDecisions], ['Aceites registrados', report.acceptances], ['Claim', report.claim],
    ['Controller', report.controller], ['Famílias não cobertas (unknown)', report.uncovered]];
  return `Diagnóstico de recuperação: ${report.id}\nObservado em: ${report.observedAt}\nEstado: ${report.status} (não significa conclusão do trabalho)\n`
    + sections.map(([label, value]) => `${label}: ${JSON.stringify(value, null, 2)}`).join('\n')
    + `\nPróximo passo seguro: ${report.nextSafeStep}\n`;
}

module.exports = { inspectRecovery, renderRecovery, validId, validKey };
