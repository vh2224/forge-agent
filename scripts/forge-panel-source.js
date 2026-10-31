#!/usr/bin/env node
'use strict';

// A bounded, ephemeral DTO. Canonical readers own scope and source validity.
const fs = require('fs');
const path = require('path');
const { resolveUserHome } = require('./forge-home');
const { plainText } = require('./forge-sidecar-identity');
const { sha256, canonical } = require('./forge-delivery');

const LIMITS = Object.freeze({ store: 8 * 1024 * 1024, works: 32, agents: 64, pending: 64, evidence: 64,
  text: 240, dto: 512 * 1024 });
const STATE_REASONS = Object.freeze(Object.fromEntries([
  ['snapshot', 'ok', 'trabalho pessoal'], ['no-workspace', 'empty', 'nenhuma pasta aberta'],
  ['no-bindings', 'empty', 'nenhum vínculo pessoal'], ['workspace-ambiguous', 'empty', 'pastas de projetos diferentes'],
  ['workspace-not-local', 'empty', 'pasta fora do sistema de arquivos local'],
  ['project-unresolved', 'unavailable', 'projeto não resolvido'],
  ['personal-store-too-large', 'unavailable', 'contexto pessoal acima do limite'],
  ['store-unreadable', 'unavailable', 'contexto pessoal ilegível'], ['core-unavailable', 'unavailable', 'núcleo Forge indisponível'],
  ['core-timeout', 'unavailable', 'tempo de leitura do núcleo esgotado'], ['core-failed', 'unavailable', 'leitura do núcleo falhou'],
  ['personal-store-invalid', 'invalid', 'arquivo de contexto pessoal inválido'], ['store-corrupt', 'invalid', 'contexto pessoal corrompido'],
  ['schema-invalid', 'invalid', 'estrutura do contexto pessoal inválida'], ['schema-unsupported', 'invalid', 'versão do contexto pessoal não suportada'],
  ['namespace-invalid', 'invalid', 'namespace pessoal inválido'], ['project-changed', 'invalid', 'projeto alterado'],
  ['dto-invalid', 'invalid', 'dados do painel inválidos'],
].map(([reason, status, label]) => [reason, Object.freeze({ status, reason, label })])));
const STATUS_LABELS = Object.freeze({ open: 'em aberto', pending: 'pendente', completed: 'concluído', unknown: 'desconhecido' });
const FRESHNESS_LABELS = Object.freeze({ current: 'atual', stale: 'desatualizado', missing: 'ausente', invalid: 'inválido', unknown: 'desconhecido' });
const WORK_PHASES = Object.freeze({ 'plan-milestone': 'planning', 'discuss-milestone': 'planning', 'plan-slice': 'planning',
  'research-milestone': 'preparing', 'research-slice': 'preparing', 'execute-task': 'executing',
  'complete-slice': 'verifying', 'complete-milestone': 'verifying' });
const PENDING_LABELS = Object.freeze({ 'owner-missing': 'fonte de pendências ausente', 'no-questions': 'nenhuma pergunta registrada',
  'no-matching-questions': 'nenhuma pergunta no escopo pessoal', 'questions-unreadable': 'fonte de perguntas ilegível',
  'no-bindings': 'nenhum vínculo pessoal' });

// plainText owns Unicode/terminal sanitization. Path redaction is a separate
// privacy constraint on every projected string, including technical labels.
function text(value, missing = null) {
  const clean = plainText(value, { missing, limit: LIMITS.text });
  if (typeof clean !== 'string') return clean;
  return clean.replace(/(?:[a-z]:[\\/]|\\\\|\/\/)[^\s"'<>|,;]*/gi, '[caminho]')
    .replace(/(^|[\s("'=:\[\{>])\/[^\s"'<>|,;]*/g, '$1[caminho]');
}
const state = reason => ({ ...(Object.hasOwn(STATE_REASONS, reason) ? STATE_REASONS[reason] : STATE_REASONS['store-unreadable']) });
function section(status, reason, label) { return { status, reason, label: text(label) }; }
function clock(value) {
  const result = value === undefined ? Date.now() : value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || !Number.isFinite(new Date(result).getTime())) throw new Error('panel-clock-invalid');
  return result;
}
function freshness(work) {
  const captures = Object.values(work.checkpoint || {}).flat();
  const reasons = [work.reliability, work.terminalEvidence?.reason, ...captures.map(row => row.validity)];
  if (reasons.some(value => ['needs-reconciliation', 'stale', 'state-changed'].includes(value))) return 'stale';
  if (reasons.some(value => ['state-missing', 'missing'].includes(value))) return 'missing';
  if (reasons.some(value => ['state-invalid', 'state-unreadable', 'run-corrupt', 'unreadable'].includes(value))) return 'invalid';
  return work.reliability === 'current' && captures.every(row => row.validity === 'current') ? 'current' : 'unknown';
}
function within(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function stableProjection(dto) {
  const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
  // Displayed semantic values are included; only generated_at and clock-derived
  // ages (agent freshness, local activity text) stay out so the same visible
  // projection hashes identically at different instants.
  return { state: pick(dto.state, ['status', 'reason']), sections: dto.sections, census: dto.census,
    works: dto.works.map(row => ({ ...pick(row, ['id', 'kind', 'status', 'freshness', 'active_slice', 'active_task']),
      phase: row.phase.value, raw_phase: row.phase.raw, next_action: pick(row.next_action, ['text', 'validity']) })),
    agents: dto.agents.map(row => ({ ...pick(row, ['dispatch_id', 'kind', 'unit', 'host', 'transport', 'outcome', 'task']),
      model: pick(row.model, ['requested', 'resolved', 'observed', 'divergent']), phase: row.phase.value, activity: row.activity.remote })),
    pending: dto.pending.map(row => pick(row, ['id', 'status', 'answered', 'unit', 'dispatch_id', 'question'])),
    evidence: dto.evidence.map(row => pick(row, ['label', 'path', 'location', 'validity', 'work_id'])) };
}

function readPanelSource(options = {}) {
  const now = clock(options.now), folders = options.folders === undefined ? [options.cwd || process.cwd()] : options.folders;
  const dto = { schema_version: 1, state: state('no-workspace'), project: null, works: [], agents: [], pending: [], evidence: [],
    sections: {}, census: { folders: { total: Array.isArray(folders) ? folders.length : 0, ignored: 0 },
      works: { total: 0, shown: 0, excess: 0 }, agents: { total: 0, shown: 0, excess: 0 },
      pending: { total: 0, shown: 0, excess: 0, invalid: 0, foreign: 0, row_excess: 0 }, evidence: { total: 0, shown: 0, excess: 0 }, events: null },
    generated_at: new Date(now).toISOString(), stable_sha256: '' };
  const finish = reason => {
    if (reason) dto.state = state(reason);
    for (const name of ['works', 'agents', 'pending', 'evidence']) {
      const census = dto.census[name]; census.shown = dto[name].length;
      if (name === 'pending') census.row_excess = Math.max(0, (census.rows || 0) - census.shown);
      else census.excess = census.total - census.shown;
      if (!dto.sections[name]) dto.sections[name] = section(dto.state.status, dto.state.reason, dto.state.label);
    }
    dto.stable_sha256 = sha256(JSON.stringify(canonical(stableProjection(dto))));
    // Section and text ceilings normally keep this far below the byte ceiling.
    // Preserve counts if multi-byte adversarial input still reaches the limit.
    while (Buffer.byteLength(JSON.stringify(dto)) > LIMITS.dto) {
      const name = ['evidence', 'pending', 'agents', 'works'].find(key => dto[key].length);
      if (!name) break;
      dto[name].pop(); const census = dto.census[name]; census.shown--;
      if (name === 'pending') census.row_excess++; else census.excess++;
      dto.stable_sha256 = sha256(JSON.stringify(canonical(stableProjection(dto))));
    }
    return dto;
  };
  if (!Array.isArray(folders) || !folders.length) return finish('no-workspace');
  let home;
  try {
    home = resolveUserHome(options);
    const store = path.join(home, '.forge-personal/context.json');
    // Reject redirected namespace components as well as the store itself.
    for (const candidate of [path.dirname(store), store]) {
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || candidate === store && !stat.isFile()) return finish('personal-store-invalid');
        if (candidate === store && stat.size > LIMITS.store) return finish('personal-store-too-large');
      } catch (error) { if (error.code !== 'ENOENT') return finish('store-unreadable'); }
    }
  } catch { return finish('namespace-invalid'); }
  const { readPersonalSnapshot } = require('./forge-personal-context');
  const { deriveAgentView, readAgentSources, PHASES, ACTIVITY_LABELS, KIND_LABELS, EMPTY_LABELS } = require('./forge-agent-view');
  const { listPendingQuestions } = require('./forge-pending-questions');
  const readOptions = { userHome: home, env: options.env };
  const projects = new Map(), validatedFolders = [], errors = [];
  for (const folder of folders) {
    const snapshot = readPersonalSnapshot({ ...readOptions, cwd: folder });
    if (snapshot.status !== 'ok') { dto.census.folders.ignored++; errors.push(snapshot.reason); continue; }
    if (!snapshot.project) { dto.census.folders.ignored++; continue; }
    projects.set(snapshot.project, snapshot); validatedFolders.push({ path: path.resolve(folder), owner: snapshot.project });
  }
  if (projects.size > 1) return finish('workspace-ambiguous');
  const serious = errors.find(reason => reason !== 'project-unresolved');
  const errorReason = reason => reason === 'corrupt' ? 'store-corrupt' : reason === 'unreadable' ? 'store-unreadable'
    : Object.hasOwn(STATE_REASONS, reason) ? reason : 'store-unreadable';
  if (serious) return finish(errorReason(serious));
  if (!projects.size) return finish(errors.length ? errorReason(errors[0]) : 'no-bindings');
  const [project, snapshot] = [...projects][0];
  if (!snapshot.works.length) return finish('no-bindings');
  dto.state = state('snapshot'); dto.project = { label: text(path.basename(project), 'projeto') };
  let bundle;
  try { bundle = readAgentSources({ ...readOptions, cwd: project, filter: { type: 'personal' } }); }
  catch { bundle = { sources: { events: { census: null } }, empty_reason: 'source_unreadable' }; }
  const view = deriveAgentView(bundle, { now });
  let questions;
  try { questions = listPendingQuestions({ ...readOptions, cwd: project, filter: { type: 'personal' } }); }
  catch { questions = { questions: [], census: { total: 0, invalid: 0, foreign: 0, excess: 0 }, empty_reason: 'questions-unreadable' }; }
  dto.census.events = view.sources.events.census;
  dto.census.works.total = snapshot.works.length;
  dto.works = snapshot.works.slice(0, LIMITS.works).map(work => {
    const status = Object.hasOwn(STATUS_LABELS, work.workStatus) ? work.workStatus : 'unknown';
    const raw = work.state?.phase ?? null;
    const phase = status === 'completed' ? 'completed' : status === 'pending' ? 'waiting' : Object.hasOwn(WORK_PHASES, raw) ? WORK_PHASES[raw] : 'unknown';
    const fresh = freshness(work);
    return { id: text(work.id), kind: text(work.kind), status, status_label: STATUS_LABELS[status],
      phase: { value: phase, label: PHASES[phase], raw: text(raw) }, active_slice: text(work.state?.active_slice), active_task: text(work.state?.active_task),
      next_action: { text: text(work.nextAction?.text), validity: text(work.nextAction?.validity, 'unknown') },
      freshness: fresh, freshness_label: FRESHNESS_LABELS[fresh] };
  });
  dto.census.agents.total = view.agents.length;
  dto.agents = view.agents.slice(0, LIMITS.agents).map(agent => ({ dispatch_id: text(agent.dispatch_id), kind: agent.kind,
    kind_label: KIND_LABELS[agent.kind] || KIND_LABELS.unknown, unit: text(agent.unit), milestone: text(agent.milestone), slice: text(agent.slice),
    workflow_id: text(agent.workflow_id), task: text(agent.task), host: agent.host_runtime, engine: agent.engine, transport: agent.transport,
    model: { requested: text(agent.model.requested), resolved: text(agent.model.resolved), observed: text(agent.model.observed), divergent: agent.model.divergent },
    effort: { requested: agent.effort.requested, resolved: agent.effort.resolved }, phase: { value: agent.phase, label: PHASES[agent.phase] }, outcome: text(agent.outcome),
    activity: { remote: agent.activity.remote, label: ACTIVITY_LABELS[agent.activity.remote], local: agent.activity.local.map(value => text(value)) },
    freshness: agent.freshness, questions: Array.isArray(agent.questions) ? agent.questions.map(value => text(value)) : agent.questions,
    // Closed canonical navigation text includes /subagents, a command, not a path.
    navigation: agent.navigation.map(row => plainText(row.label, { limit: LIMITS.text })) }));
  Object.assign(dto.census.pending, questions.census, { rows: questions.questions.length });
  dto.pending = questions.questions.slice(0, LIMITS.pending).map(row => ({ id: text(row.id), question: text(row.question), status: row.status,
    answered: row.answered, unit: text(row.origin.unit), milestone: text(row.origin.milestone), workflow_id: text(row.origin.workflow_id),
    dispatch_id: text(row.origin.dispatch_id), agent_kind: view.agents.find(agent => row.origin.dispatch_id && agent.dispatch_id === row.origin.dispatch_id)?.kind || null,
    last_round_outcome: text(row.last_round?.outcome) }));
  // These are already observed references, never new reads. The snapshot's
  // source boundary has validated each current/stale source and worktree alias.
  for (const work of snapshot.works) {
    const entries = Object.entries(work.checkpoint || {}).flatMap(([field, captures]) => captures.map(capture => ({ field, capture })));
    if (work.lastResult) entries.push({ field: 'lastResult', capture: work.lastResult });
    if (work.terminalEvidence?.source) entries.push({ field: 'terminalEvidence', capture: { ...work.terminalEvidence,
      validity: work.terminalEvidence.reason === 'state-changed' ? 'stale' : work.terminalEvidence.reason ? 'unreadable' : 'current' } });
    for (const { field, capture } of entries) {
      dto.census.evidence.total++;
      if (dto.evidence.length >= LIMITS.evidence) continue;
      const validity = ['current', 'stale', 'missing', 'unreadable'].includes(capture.validity) ? capture.validity : 'unreadable';
      let location = 'external', relative = null;
      if (validity !== 'unreadable' && typeof capture.source === 'string' && path.isAbsolute(capture.source)) {
        const root = within(capture.source, project) ? project : validatedFolders.find(folder => folder.owner === project && within(capture.source, folder.path))?.path;
        if (root) { relative = text(path.relative(root, capture.source).split(path.sep).join('/')); location = root === project ? 'project' : 'worktree'; }
      }
      dto.evidence.push({ label: text(capture.text, field), work_id: text(work.id), field, path: relative, location, validity });
    }
  }
  dto.sections.works = section('ok', 'snapshot', 'trabalho pessoal');
  dto.sections.agents = view.empty_reason ? section(view.empty_reason === 'no-agents' || view.empty_reason === 'no-bindings' ? 'empty' : 'unavailable', text(view.empty_reason), EMPTY_LABELS[view.empty_reason] || 'fonte de agentes indisponível')
    : section('ok', 'snapshot', 'agentes do trabalho pessoal');
  dto.sections.pending = questions.empty_reason ? section(questions.empty_reason === 'questions-unreadable' ? 'unavailable' : 'empty', text(questions.empty_reason), PENDING_LABELS[questions.empty_reason] || 'fonte de perguntas indisponível')
    : section('ok', 'snapshot', 'perguntas do trabalho pessoal');
  dto.sections.evidence = section(dto.evidence.length ? 'ok' : 'empty', dto.evidence.length ? 'snapshot' : 'no-evidence', dto.evidence.length ? 'evidências registradas' : 'nenhuma evidência registrada');
  return finish();
}

function main(argv = process.argv.slice(2), io = process) {
  const options = {}; let json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--json') { json = true; continue; }
      if (!['--cwd', '--folder', '--now'].includes(flag) || typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--')) throw new Error('panel-usage');
      const value = argv[++i];
      if (flag === '--folder') (options.folders ||= []).push(value);
      else if (flag === '--now') options.now = clock(value);
      else options.cwd = value;
    }
  } catch {
    io.stderr.write('uso: forge-panel-source.js [--cwd <pasta>] [--folder <pasta>]... [--now <instante>] [--json]\n'); return 2;
  }
  let dto;
  try { dto = readPanelSource(options); }
  catch {
    dto = readPanelSource({ folders: [], now: options.now }); dto.state = state('core-failed');
    for (const key of Object.keys(dto.sections)) dto.sections[key] = section('unavailable', 'core-failed', dto.state.label);
    dto.stable_sha256 = sha256(JSON.stringify(canonical(stableProjection(dto))));
  }
  io.stdout.write((json ? JSON.stringify(dto) : `Forge · ${dto.state.label} · ${dto.works.length} trabalhos · ${dto.agents.length} agentes · ${dto.pending.length} perguntas`) + '\n');
  return 0;
}

module.exports = { readPanelSource, stableProjection, STATE_REASONS, LIMITS, main };
if (require.main === module) process.exitCode = main();
