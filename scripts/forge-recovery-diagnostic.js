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
  try { recovery.assertSafePath(project, target, 'source'); return project; } catch { /* validated aliases below */ }
  // An ancestor of the project may have an OS alias (macOS /var -> /private/var).
  // Find the same root in the target's spelling, then validate every descendant
  // before reading. Realpath(target) alone would erase forbidden child symlinks.
  for (let ancestor = path.resolve(target); ; ancestor = path.dirname(ancestor)) {
    if (samePath(project, ancestor)) {
      try { recovery.assertSafePath(ancestor, target, 'source'); return ancestor; }
      catch { break; } // A linked descendant may belong to a validated worktree.
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  for (const alias of aliases) {
    if (!object(alias) || !path.isAbsolute(alias.repo || '') || !path.isAbsolute(alias.path || '') || typeof alias.branch !== 'string') continue;
    try {
      const root = safeRoot(alias.path, target);
      safeRoot(project, alias.repo);
      if (!validateWorktreeIdentity(alias.repo, alias.path, alias.branch).ok) continue;
      return root;
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
  if (work.reliability !== 'current') report.uncertainties.push(`Continuidade: ${textLabel(work.reliability)}`);
  report.coverage.personal = 'observed';
}

function inspectClaim(project, id, record, report, runHash) {
  const claim = record.write_claim;
  if (claim == null) { report.claim = { state: 'absent' }; report.coverage.claim = 'observed'; return; }
  try { claims.validateHeldClaim({ ...claim, released: null }); }
  catch { source(report, 'claim', { state: 'schema-invalid' }); return; }
  if (claim.released != null && claims.isHeld(claim)) {
    source(report, 'claim-release', { state: 'schema-invalid' }); return;
  }
  const classification = stuck.classifyStuck(record);
  report.claim = { state: claim.released ? 'released' : 'held', classification: classification.kind };
  if (classification.kind === 'stuck' || classification.kind === 'unmeasured') report.uncertainties.push(`Reserva de escrita ${classification.kind === 'stuck' ? 'travada' : 'não medida'}; exige inspeção e decisão na autoridade original.`);
  if (!claim.released) { report.coverage.claim = 'observed'; return; } // Orphan bundles are deliberately never discovered.
  report.provenResults.push({ kind: 'claim-release', at: claim.released.at, mechanism: claim.released.mechanism });
  const evidence = claim.released.evidence;
  if (!evidence || !evidence.bundle) { report.coverage.claim = 'observed'; return; } // A clean release needs no bundle.
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
  report.coverage.claim = 'observed';
}

function inspectController(project, id, key, report) {
  if (ids.entityKind(id) !== 'milestone' || !key) {
    report.controller = { coverage: 'unavailable', reason: ids.entityKind(id) === 'task' ? 'standalone-task' : 'key-not-provided' };
    report.coverage.controller = 'not-covered'; return;
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
  if (t.phase !== 'committed') report.uncertainties.push('Controlador interrompido: publicação pode preceder a fase; não repetir efeitos pelo diagnóstico.');
  report.coverage.controller = 'observed';
}

function createRecoveryReport(id, failedPhase) {
  const report = { id, observedAt: new Date().toISOString(), status: 'partial', sources: [], provenResults: [],
    uncertainties: [], artifacts: [], continuity: { state: 'unproven' }, pendingDecisions: [], acceptances: [],
    claim: { state: 'unknown' }, controller: { coverage: 'unavailable' },
    coverage: { personal: 'not-observed', claim: 'not-observed', controller: 'not-observed', artifacts: 'not-observed' },
    uncovered: ['sweep', 'sidecar-reset', 'other-journals'],
    nextSafeStep: 'Inspecionar as fontes indicadas e resolver pendências na autoridade original; qualquer ação futura exige revalidação e autorização. Esta observação não autoriza replay nem atestações.' };
  if (failedPhase) source(report, failedPhase, { state: 'internal-error' });
  return report;
}

function inspectRecovery(options = {}) {
  if (!validId(options.id) || (options.controllerKey !== undefined && !validKey(options.controllerKey))) throw new TypeError('invalid-arguments');
  const report = createRecoveryReport(options.id);
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
  report.coverage.artifacts = 'observed';
  for (const suffix of [r.kind === 'task' ? 'PLAN' : 'STATE', 'SUMMARY']) {
    const file = path.join(directory, `${options.id}-${suffix}.md`);
    const observed = readEvidence(project, file, false);
    if (!['current', 'missing'].includes(observed.state)) report.coverage.artifacts = 'incomplete';
    if (observed.state === 'current') report.artifacts.push({ kind: suffix.toLowerCase(), source: path.relative(project, file), hash: observed.hash, existence: 'observed', integrity: 'unverified' });
    if (suffix !== 'SUMMARY' || observed.state !== 'missing') source(report, suffix.toLowerCase(), observed);
  }
  for (const [phase, inspect] of [
    ['personal', () => inspectPersonal(project, options.id, options, report)],
    ['claim', () => inspectClaim(project, options.id, r, report, run.hash)],
    ['controller', () => inspectController(project, options.id, options.controllerKey, report)],
  ]) {
    report.coverage[phase] = 'incomplete';
    try { inspect(); } catch { report.coverage[phase] = 'incomplete'; source(report, phase, { state: 'internal-error' }); }
  }
  report.status = report.uncertainties.length ? 'partial' : 'ok';
  return report;
}

const TEXT_LABELS = {
  ok: 'observações válidas', partial: 'parcial', current: 'atual', missing: 'ausente', corrupt: 'corrompido',
  stale: 'desatualizado', unreadable: 'ilegível', 'unsafe-path': 'caminho inseguro', 'invalid-name': 'nome inválido',
  invalid: 'inválido', 'schema-invalid': 'estrutura inválida', 'schema-unsupported': 'versão não suportada',
  'internal-error': 'falha interna', 'snapshot-changed': 'evidência alterada durante a inspeção',
  unproven: 'não comprovado', unknown: 'desconhecido', unavailable: 'não disponível', observed: 'observado',
  verified: 'verificado', unverified: 'não verificado', 'identity-checked': 'somente identidade conferida',
  'integrity-unverified': 'integridade não verificada', conflicts: 'conflitos', superseded: 'substituído por outra transação',
  recorded: 'registrado', open: 'em aberto', pending: 'pendente', completed: 'concluído', active: 'ativo', inactive: 'inativo',
  held: 'retida', released: 'liberada', absent: 'ausente', stuck: 'travada', unmeasured: 'não medido', skip: 'não aplicável',
  personal: 'contexto pessoal', diagnostic: 'diagnóstico', run: 'registro do trabalho', 'run-identity': 'identidade do trabalho',
  plan: 'plano', state: 'estado', summary: 'resumo', work: 'trabalho', 'personal-store': 'store pessoal',
  'personal-sources': 'fontes pessoais', checkpoint: 'checkpoint', acceptances: 'aceites', nextAction: 'próxima ação',
  'checkpoint/acceptances': 'checkpoint de aceites', 'checkpoint/pending': 'checkpoint de pendências',
  'checkpoint/nextAction': 'checkpoint da próxima ação', 'checkpoint/lastResult': 'checkpoint do último resultado',
  'checkpoint/handoff': 'checkpoint da passagem de contexto',
  lastResult: 'último resultado', handoff: 'passagem de contexto', 'needs-reconciliation': 'exige reconciliação',
  'run-corrupt': 'registro do trabalho corrompido', 'run-unreadable': 'registro do trabalho ilegível',
  claim: 'reserva de escrita', 'claim-release': 'liberação da reserva', 'claim-manifest': 'manifesto do bundle',
  'claim-manifest-schema': 'estrutura do manifesto', 'claim-bundle': 'bundle da reserva', 'claim-preview': 'prévia do bundle',
  'personal-checkpoint': 'resultado registrado no checkpoint', controller: 'controlador',
  'controller-transaction': 'transação do controlador', 'controller-identity': 'identidade da transação',
  'controller-result': 'resultado publicado', 'controller-boundary': 'marco publicado',
  'controller-result-identity': 'identidade do resultado', 'controller-boundary-identity': 'identidade do marco',
  'controller-result-schema': 'estrutura do resultado', 'controller-boundary-schema': 'estrutura do marco',
  'controller-result-published': 'publicação do resultado observada', 'controller-boundary-published': 'publicação do marco observada',
  'key-not-provided': 'chave não informada', 'standalone-task': 'task avulsa sem cobertura do controlador',
  intent: 'intenção registrada', 'result-published': 'resultado publicado', 'event-published': 'evento publicado',
  'boundary-pending': 'marco pendente', 'state-published': 'estado publicado', 'lease-release-pending': 'liberação da concessão pendente',
  'lease-released': 'concessão liberada', 'boundary-ready': 'marco pronto', committed: 'transação confirmada',
  explicit: 'explícito', manual: 'manual', 'ttl-expired': 'prazo expirado', sweep: 'limpeza',
  'sidecar-reset': 'reinício do sidecar', 'other-journals': 'outros journals',
};
function safeText(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function textLabel(value) {
  if (value == null) return 'não informado';
  return safeText(Object.hasOwn(TEXT_LABELS, value) ? TEXT_LABELS[value] : value);
}
function renderCapture(item) {
  return `${safeText(item.text)} — ${textLabel(item.validity)}; resolvido: ${item.resolved ? 'sim' : 'não'}`
    + `\n    Fonte: ${safeText(item.source)}; SHA-256: ${safeText(item.hash)}; capturado em: ${safeText(item.capturedAt || 'não informado')}`;
}
function renderRecovery(report) {
  const lines = [`Diagnóstico de recuperação: ${safeText(report.id)}`, `Observado em: ${safeText(report.observedAt)}`,
    `Estado: ${textLabel(report.status)} (não significa conclusão do trabalho)`];
  const coverage = report.coverage || {};
  const personalObserved = coverage.personal === 'observed';
  const resultsObserved = personalObserved && coverage.claim === 'observed' && ['observed', 'not-covered'].includes(coverage.controller);
  const section = (heading, entries, observed = true) => {
    lines.push(`\n${heading}:`, ...entries.map(entry => `- ${entry}`));
    if (!observed) lines.push('- Observação incompleta: outros registros podem não ter sido lidos.');
    else if (!entries.length) lines.push('- Nenhum registro nas fontes observadas.');
  };
  section('Fontes e estado da evidência', report.sources.map(item => `${textLabel(item.name)}: ${textLabel(item.state)}`
    + (item.source ? `\n    Fonte: ${safeText(item.source)}` : '') + (item.hash ? `\n    SHA-256: ${safeText(item.hash)}` : '')), report.sources.length > 0);
  section('Resultado comprovado', report.provenResults.map(item => textLabel(item.kind)
    + (item.evidence ? `: ${renderCapture(item.evidence)}` : '')
    + (item.at != null ? `; instante registrado (ms): ${safeText(item.at)}; mecanismo: ${textLabel(item.mechanism)}` : '')), resultsObserved);
  section('Incertezas', report.uncertainties.map(item => {
    const pair = report.sources.find(entry => item === `${entry.name}: ${entry.state}`
      && Object.hasOwn(TEXT_LABELS, entry.name) && Object.hasOwn(TEXT_LABELS, entry.state));
    return pair ? `${textLabel(pair.name)}: ${textLabel(pair.state)}` : safeText(item);
  }), report.status === 'ok' || report.uncertainties.length > 0);
  section('Artefatos preservados', report.artifacts.map(item => `${textLabel(item.kind)}: ${textLabel(item.existence)}; integridade: ${textLabel(item.integrity)}`
    + `\n    Fonte: ${safeText(item.source)}` + (item.hash ? `; SHA-256: ${safeText(item.hash)}` : '')
    + (item.conflicts != null ? `; conflitos: ${safeText(item.conflicts)}` : '')), coverage.artifacts === 'observed');
  const continuity = report.continuity;
  section('Continuidade pessoal', [`Registro: ${textLabel(continuity.state)}; vínculo pessoal: ${continuity.bound == null ? 'não comprovado' : continuity.bound ? 'sim' : 'não'}`,
    `Situação do trabalho: ${textLabel(continuity.workStatus)}; atividade: ${textLabel(continuity.activity)}`,
    ...Object.entries(continuity.checkpoint || {}).flatMap(([field, entries]) => entries.map(item => `${textLabel(field)}: ${renderCapture(item)}`))], personalObserved);
  section('Decisões pendentes', report.pendingDecisions.map(renderCapture), personalObserved);
  section('Aceites registrados', report.acceptances.map(renderCapture), personalObserved);
  section('Reserva de escrita', [`Estado: ${textLabel(report.claim.state)}`
    + (report.claim.classification ? `; classificação: ${textLabel(report.claim.classification)}` : '')], coverage.claim === 'observed');
  const control = report.controller;
  section('Controlador', [`Cobertura: ${textLabel(control.coverage)}` + (control.reason ? `; motivo: ${textLabel(control.reason)}` : ''),
    ...(control.phase ? [`Fase: ${textLabel(control.phase)}; transação confirmada: ${control.transactionCommitted ? 'sim' : 'não'}; conclusão global: ${textLabel(control.globalCompletion)}`] : [])], ['observed', 'not-covered'].includes(coverage.controller));
  section('Famílias não cobertas (resultado desconhecido)', report.uncovered.map(textLabel));
  lines.push(`\nPróximo passo seguro: ${safeText(report.nextSafeStep)}`);
  return lines.join('\n') + '\n';
}

module.exports = { inspectRecovery, renderRecovery, createRecoveryReport, validId, validKey };
