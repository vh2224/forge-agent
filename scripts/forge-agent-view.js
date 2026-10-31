#!/usr/bin/env node
'use strict';

// A projection of canonical records, never a store or a worker supervisor.
// Filesystem-dependent modules are loaded only at the read boundary.
const { observation, diagnostic, isSafeModelId } = require('./forge-sidecar-diagnostic');
const liveness = require('./forge-sidecar-liveness');
const { plainText, HUMAN_PREFIX } = require('./forge-sidecar-identity');
const { EVENT_KEYS, validateAgentId, normalizeHostIdentity, buildAgentIdentityEvent } = require('./forge-agent-identity');

const PHASES = Object.freeze({ preparing: 'preparando', planning: 'planejando', executing: 'executando agente',
  verifying: 'verificando a entrega', publishing: 'publicando evidência', reviewing: 'revisando',
  waiting: 'aguardando decisão', completed: 'concluído', failed: 'falhou', unknown: 'desconhecido' });
const ACTIVITY_LABELS = Object.freeze({ recent: 'atividade remota recente', delayed: 'atividade remota atrasada', absent: 'atividade remota ausente',
  dead: 'atividade remota encerrada pela liveness', unknown: 'atividade remota desconhecida',
  'tool-running': 'ferramenta em andamento com atividade remota suspensa' });
const KIND_LABELS = Object.freeze({ native: 'executor nativo', sidecar: 'executor sidecar', unknown: 'executor desconhecido' });
const EMPTY_LABELS = Object.freeze({ 'no-agents': 'nenhum agente no escopo informado',
  'events-too-large': 'fonte de eventos acima do limite; censo indisponível',
  source_unreadable: 'fonte de eventos ilegível; censo indisponível',
  source_link: 'fonte de eventos com link; censo indisponível',
  'no-bindings': 'nenhum vínculo pessoal; censo indisponível' });
const AGENT_ROLES = Object.freeze(Object.fromEntries([
  ['advocate', 'Defensor', 'Avalia os achados da revisão e fundamenta a resposta técnica'],
  ['completer', 'Consolidador', 'Confere entregas e consolida as evidências da unidade'],
  ['discusser', 'Discussão', 'Examina alternativas e registra decisões de arquitetura'],
  ['executor', 'Executor', 'Implementa a tarefa e verifica seus critérios de entrega'],
  ['memory', 'Memória', 'Extrai aprendizados verificáveis para a memória do projeto'],
  ['plan-checker', 'Verificador do plano', 'Confere escopo dependências e critérios do plano'],
  ['planner', 'Planejador', 'Organiza tarefas dependências e critérios verificáveis'],
  ['researcher', 'Pesquisador', 'Investiga fontes atuais e registra achados e incertezas'],
  ['reviewer', 'Revisor', 'Revisa mudanças e confronta os critérios com a evidência'],
  ['worker', 'Colaborador', 'Executa o trabalho delimitado e comunica seu resultado'],
].map(([role, label, description]) => [`forge-${role}`, Object.freeze({ label, description })])));
const NAVIGATION = Object.freeze([
  Object.freeze({ kind: 'native', host: 'codex', surface: 'cli', status: 'conditional', command: '/subagents', label: 'no CLI, use /subagents' }),
  Object.freeze({ kind: 'native', host: 'codex', surface: 'ide', status: 'conditional', label: 'quando disponível, painel de agentes em segundo plano da extensão' }),
  Object.freeze({ kind: 'native', host: 'claude', surface: 'terminal', status: 'conditional', label: 'painel de agentes abaixo do prompt' }),
  Object.freeze({ kind: 'sidecar', host: 'any', surface: 'conversation', status: 'conditional', label: 'esta conversa e o registro técnico' }),
]);
const LIMITS = Object.freeze({ events: 16 * 1024 * 1024, receipt: 1024 * 1024, journal: 32768, plans: 1024 * 1024,
  lines: 20000, references: 32 });
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const TRANSPORTS = ['native-tool', 'in-process', 'claude-cli', 'app-server'];
const RECORDS = ['dispatch', 'sidecar-unit', 'sidecar-no-progress'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ms = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeModel = value => isSafeModelId(value) ? value : 'unknown';
const safeEffort = value => EFFORTS.includes(value) ? value : 'unknown';
// Reuse the existing telemetry vocabulary, without coercing or shortening IDs.
const safeCode = value => typeof value === 'string' && require('./forge-attempt-telemetry').code(value) === value ? value : null;
const safeDispatch = value => require('./forge-attempt-telemetry').dispatchCode(value);
const valueOf = input => object(input?.value) ? input.value : input;
const lastValue = (rows, getter) => {
  for (let i = rows.length - 1; i >= 0; i--) {
    const value = getter(rows[i]);
    if (value !== undefined && value !== null) return value;
  }
  return null;
};
function wall(value) {
  const candidate = typeof value === 'string' ? ms(Date.parse(value)) : ms(value);
  return candidate !== null && Number.isFinite(new Date(candidate).getTime()) ? candidate : null;
}
function clockValue(now) { return wall(typeof now === 'function' ? now() : now); }
function matches(record, scope) {
  if (scope.type === 'personal') return (scope.works || []).some(id => record.workflow_id === id || record.milestone === id);
  if (scope.type === 'milestone') return record.milestone === scope.id || record.workflow_id === scope.id;
  if (scope.type === 'workflow') return record.workflow_id === scope.id;
  if (scope.type === 'unit') return record.unit === scope.id;
  return false;
}
function canJoin(record, scope, dispatches) {
  if (matches(record, scope)) return true;
  if (!dispatches.has(safeDispatch(record.dispatch_id))) return false;
  // An unlabelled entry dispatch may join its scoped unit result; an explicitly
  // foreign record may not borrow membership merely by copying the key.
  if (scope.type === 'unit') return !record.unit;
  if (scope.type === 'workflow') return !record.workflow_id && (!record.milestone || record.milestone === scope.id);
  return !record.workflow_id && !record.milestone;
}
function kindOf(rows) {
  const modes = new Set();
  for (const row of rows) {
    if (['native', 'sidecar'].includes(row.worker_mode)) modes.add(row.worker_mode);
    if (['native-tool', 'in-process'].includes(row.transport)) modes.add('native');
    if (['claude-cli', 'app-server'].includes(row.transport)) modes.add('sidecar');
  }
  return modes.size === 1 ? [...modes][0] : 'unknown';
}
function hostIdentity(kind, dispatch, identities, journals) {
  const unknown = reason => ({ value: 'unknown', source: 'unknown', provenance: 'unknown', reason });
  if (kind !== 'native') return unknown('host-id-not-recorded');
  const candidates = [];
  for (const row of identities) {
    if (!dispatch || row.dispatch_id !== dispatch || row.agent_id_source !== 'host-tool-return' || !validateAgentId(row.agent_id).ok) continue;
    if (typeof row.ts !== 'string' || Object.keys(row).length !== EVENT_KEYS.length
        || !EVENT_KEYS.every(key => Object.hasOwn(row, key))) continue;
    try {
      const checked = buildAgentIdentityEvent(row, 0);
      if (row.worker_mode !== 'native' || checked.agent_id !== row.agent_id) continue;
      candidates.push({ value: checked.agent_id, source: 'host-tool-return', provenance: checked.evidence });
    } catch { /* Malformed or unproven identity is not a host observation. */ }
  }
  for (const wrapper of journals) {
    const host = normalizeHostIdentity(valueOf(wrapper)?.host_identity);
    if (!host || !dispatch || host.dispatch_id !== dispatch) continue;
    if (host.conflict) return unknown('host-id-conflict');
    candidates.push({ value: host.value, source: host.source, provenance: 'journal-unpublished' });
  }
  if (new Set(candidates.map(row => row.value)).size > 1) return unknown('host-id-conflict');
  return candidates.length ? { ...candidates[0], reason: null } : unknown('host-id-not-recorded');
}

// The same decision is used for persisted snapshots and live activity lines.
function deriveActivity(raw, { now, startedAt, journal, live = false, heartbeat = false } = {}) {
  let source = 'unknown', observedAt = null, age = null, timing = 'unknown', beat = null, remoteCount = null;
  let threshold = liveness.DEFAULTS.suspectMs, thresholdSource = 'locked-default';
  let obs = object(raw) ? observation(raw) : null;
  let gap = obs?.gap_suspended === true, silence = obs?.remote_silence_ms ?? null;
  if (journal) {
    observedAt = wall(journal.last_wall_ms);
    source = journal.capabilities?.remote_events === 'available' ? 'native-journal' : 'unknown';
    timing = 'journal.last_wall_ms';
    const start = ms(journal.start_wall_ms), remote = ms(journal.last_remote_ms);
    const elapsed = observedAt !== null && start !== null && observedAt >= start ? observedAt - start : null;
    gap = journal.capabilities?.open_tools === 'available' && journal.open_tools === true;
    silence = elapsed !== null && remote !== null && elapsed >= remote ? elapsed - remote : null;
    remoteCount = remote !== null ? 1 : 0;
    if (Number.isSafeInteger(journal.policy?.suspectMs) && journal.policy.suspectMs > 0
        && journal.policy.suspectMs <= liveness.DEFAULTS.suspectMs) {
      threshold = journal.policy.suspectMs; thresholdSource = 'journal-policy';
    }
    if (source !== 'unknown' && elapsed !== null && liveness.STATES.includes(journal.activity)) {
      const evaluated = liveness.evaluate({ elapsed_ms: elapsed, first_remote_ms: journal.first_remote_ms,
        remote_silence_ms: silence, gap_suspended: gap }, {}, journal.policy);
      beat = { state: journal.activity, reason: evaluated.reason };
    }
  } else if (obs) {
    source = obs.remote_event_count === 0 ? 'observed-none'
      : raw.remote_source === 'cli-reported-protocol' ? 'cli-reported-protocol' : 'unknown';
    remoteCount = obs.remote_event_count;
    beat = obs.liveness || null;
    // Normalization must not upgrade a missing/invalid reason or suspension flag
    // into the explicit unsuspended remote-working observation required here.
    if (beat?.state === 'working' && (raw.liveness?.reason !== null || raw.gap_suspended !== false)) beat = null;
    if (live) { observedAt = clockValue(now); timing = 'live'; }
    else {
      const start = wall(startedAt);
      if (start !== null && obs.elapsed_ms !== null) observedAt = ms(start + obs.elapsed_ms);
      timing = 'derived:receipt.started_at+observation.elapsed_ms';
    }
  }
  const current = clockValue(now);
  if (observedAt !== null && current !== null && current >= observedAt) age = current - observedAt;
  const clockBad = (obs !== null || journal) && (observedAt === null || age === null);
  let remote = 'unknown';
  if (!clockBad && source !== 'unknown') {
    if (beat?.state === 'dead') remote = 'dead';
    else if (gap) remote = 'tool-running';
    else if (remoteCount === 0) remote = 'absent';
    else if (remoteCount > 0 && (beat?.state === 'slow-suspect' || silence !== null && silence + age > threshold)) remote = 'delayed';
    else if (remoteCount > 0 && beat?.state === 'working' && beat.reason === null && !gap && silence !== null
        && silence + age <= threshold) remote = 'recent';
  }
  const local = [];
  if (heartbeat) local.push('heartbeat');
  if (obs) local.push('snapshot');
  if (journal) local.push('journal-tick');
  return { remote, local, tools: obs?.tool_activity || null,
    terminal: obs?.terminal_observed === true ? obs.process_exit_observed ? 'rejected-after-exit' : 'unvalidated' : 'unknown',
    observed_at: clockBad ? null : observedAt === null ? null : new Date(observedAt).toISOString(),
    observed_at_source: timing, observation_age_ms: age, remote_silence_ms: clockBad || silence === null ? null : silence + age,
    threshold_ms: threshold, threshold_source: thresholdSource, reason: clockBad ? 'clock-inconsistent' : null };
}

/** Pure: no default wall clock, filesystem, mutation or discovery. */
function deriveAgentView(input, options = {}) {
  const bundle = Array.isArray(input) ? { records: input } : input || {};
  const { now, receipts = bundle.receipts || [], journals = bundle.journals || [], titles = bundle.titles || {} } = options;
  const scope = options.scope || bundle.scope || { type: 'unknown' };
  const sources = bundle.sources || { events: { reference: 'unknown', census: null }, receipts: [], journals: [] };
  const empty = options.empty_reason || bundle.empty_reason;
  if (empty) return { schema_version: 1, scope, sources, agents: [], empty_reason: empty };
  const records = (bundle.records || []).filter(object);
  const scopedIds = new Set(records.filter(row => RECORDS.includes(row.event) && matches(row, scope))
    .map(row => safeDispatch(row.dispatch_id)).filter(Boolean));
  const identityRecords = new Map();
  for (const row of records.filter(row => row.event === 'agent-identity' && scopedIds.has(safeDispatch(row.dispatch_id)))) {
    if (!identityRecords.has(row.dispatch_id)) identityRecords.set(row.dispatch_id, []);
    identityRecords.get(row.dispatch_id).push(row);
  }
  const groups = new Map();
  for (const row of records) {
    if (!RECORDS.includes(row.event) || !canJoin(row, scope, scopedIds)) continue;
    const dispatch = safeDispatch(row.dispatch_id);
    const key = dispatch || Symbol('unjoined-record');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  // Scope membership is established by dispatch data, never an orphan identity.
  const agents = [];
  for (const rows of groups.values()) {
    const dispatchId = safeDispatch(rows[0].dispatch_id);
    const scopedReceipts = dispatchId ? receipts.filter(row => valueOf(row)?.dispatch_id === dispatchId) : [];
    const scopedJournals = dispatchId ? journals.filter(row => valueOf(row)?.schema_version === 1
      && valueOf(row)?.host_identity?.dispatch_id === dispatchId && normalizeHostIdentity(valueOf(row).host_identity)) : [];
    const receipt = valueOf(scopedReceipts.at(-1)) || null, journal = valueOf(scopedJournals.at(-1)) || null;
    const route = receipt?.route || {};
    const combined = [...rows, route, ...(receipt ? [receipt] : [])];
    const pick = getter => lastValue(combined, getter);
    const kind = kindOf(combined);
    const identities = identityRecords.get(dispatchId) || [];
    const identity = hostIdentity(kind, dispatchId, identities, scopedJournals);
    const unit = safeCode(pick(row => row.unit)) || 'unknown';
    const telemetryRows = combined.flatMap(row => [row, ...(object(row.telemetry) ? [row.telemetry] : []),
      ...(object(row.final_evidence) ? [row.final_evidence] : [])]);
    const tele = getter => lastValue(telemetryRows, getter);
    const rawObservation = tele(row => row.observation || row.diagnostic?.observation);
    const activity = deriveActivity(rawObservation, { now, startedAt: receipt?.started_at, journal: kind === 'native' ? journal : null,
      heartbeat: rows.some(row => row.heartbeat === true || row.event === 'sidecar-no-progress') });
    const observed = tele(row => typeof row.model_observed_source === 'string' && row.model_observed_source.trim()
      && isSafeModelId(row.model_observed) ? row.model_observed : row.observation?.model_source === 'claude-json-modelUsage'
        && isSafeModelId(row.observation.model_observed) ? row.observation.model_observed : null);
    const model = { requested: safeModel(tele(row => row.model_requested)),
      resolved: safeModel(tele(row => row.model_resolved || row.model)),
      sent: safeModel(tele(row => row.model_sent || row.model_argument)), observed: safeModel(observed) };
    model.divergent = model.observed !== 'unknown' && model.resolved !== 'unknown' && model.observed !== model.resolved;
    const effort = { requested: safeEffort(tele(row => row.effort_requested)),
      resolved: safeEffort(tele(row => row.effort_resolved || row.effort)),
      sent: safeEffort(tele(row => row.effort_sent || row.effort_argument)), applied: safeEffort(tele(row => row.effort_applied)) };
    const finalEvent = rows.filter(row => row.event === 'sidecar-unit' && ['done', 'partial', 'blocked', 'failed'].includes(row.status)).at(-1);
    const result = receipt?.result || receipt?.extraction || receipt?.response || {};
    const outcomeStatus = finalEvent?.status || result.status || (receipt?.phase === 'failed' ? 'failed' : null);
    let outcome = outcomeStatus || 'unknown', phase = 'unknown';
    if (outcomeStatus === 'done') phase = finalEvent ? 'completed' : receipt?.phase === 'ready' ? 'publishing' : 'verifying';
    else if (outcomeStatus === 'partial') phase = 'waiting';
    else if (['blocked', 'failed'].includes(outcomeStatus)) phase = 'failed';
    else if (receipt?.phase === 'executed') phase = 'verifying';
    else if (receipt?.phase === 'ready') phase = 'publishing';
    else if (receipt?.phase === 'started' || rows.some(row => row.status === 'started'
        || row.event === 'dispatch' && row.transport !== 'in-process')) phase = 'executing';
    else if (rows.some(row => row.event === 'dispatch' && row.transport === 'in-process')) outcome = 'returned';
    // A terminal protocol packet is explicitly not validation or publication.
    if (activity.terminal !== 'unknown' && !finalEvent && !['executed', 'ready'].includes(receipt?.phase)) { phase = 'unknown'; outcome = 'unknown'; }
    const tier = pick(row => row.tier), ceiling = liveness.ceilingForTier(tier);
    const start = wall(receipt?.started_at) ?? ms(journal?.start_wall_ms) ?? wall(rows.find(row => row.event === 'dispatch' || row.status === 'started')?.ts);
    const current = clockValue(now), ceilingMs = ceiling ?? liveness.TIER_CEILING_MS.max;
    const stale = !finalEvent && !['executed', 'ready', 'failed'].includes(receipt?.phase) && activity.terminal === 'unknown'
      && start !== null && current !== null && current >= start && current - start > ceilingMs;
    if (stale) { phase = 'unknown'; outcome = 'unknown'; activity.remote = 'unknown'; }
    const questionRows = receipt?.pending_questions || result.questions;
    const questions = phase === 'waiting' && Array.isArray(questionRows)
      ? questionRows.filter(row => object(row) && row.status !== 'resolved' && safeCode(row.id)).map(row => row.id) : 'unknown';
    const host = ['codex', 'claude'].includes(pick(row => row.host_runtime)) ? pick(row => row.host_runtime) : 'unknown';
    const transport = TRANSPORTS.includes(pick(row => row.transport)) ? pick(row => row.transport) : 'unknown';
    const requestedName = plainText(lastValue(identities, row => row.task_name) || pick(row => row.task_name), { missing: 'unknown', limit: 120 });
    agents.push({ kind, unit, milestone: safeCode(pick(row => row.milestone)) || 'unknown', slice: safeCode(pick(row => row.slice)) || 'unknown',
      workflow_id: safeCode(pick(row => row.workflow_id)) || 'unknown', dispatch_id: dispatchId || 'unknown', host_runtime: host,
      engine: ['codex', 'claude', 'agy'].includes(pick(row => row.engine || row.worker_engine || row.resolved_worker_engine))
        ? pick(row => row.engine || row.worker_engine || row.resolved_worker_engine) : 'unknown', transport,
      task: plainText(titles[dispatchId] || lastValue(identities, row => row.description) || unit, { missing: 'unknown', limit: 160 }),
      task_name: requestedName, identity, native_thread: kind === 'native', model, effort, outcome,
      phase, questions, reason: phase === 'failed' ? diagnostic(finalEvent?.diagnostic?.reason || finalEvent?.reason_code || receipt?.failure?.diagnostic?.reason).reason : null,
      activity, freshness: stale ? 'stale' : 'current', freshness_ceiling_ms: ceilingMs,
      freshness_ceiling_source: ceiling === null ? 'fallback:TIER_CEILING_MS.max' : 'ceilingForTier',
      navigation: NAVIGATION.filter(row => row.kind === kind && (row.host === host || row.host === 'any')),
      technical: { dispatch_id: dispatchId, receipt: scopedReceipts.at(-1)?.source || null } });
  }
  return { schema_version: 1, scope, sources, agents, empty_reason: agents.length ? null : 'no-agents' };
}

// Human output uses closed labels; arbitrary descriptions and technical IDs stay
// in JSON. plainText is the only terminal/Unicode sanitizer on this surface.
function humanLine(parts) { return plainText(parts.join(' · '), { missing: PHASES.unknown, limit: 250 }); }
const humanModel = value => value === 'unknown' || !isSafeModelId(value) ? 'desconhecido' : value;
function formatPhaseLine(phase, fields = {}) {
  const parts = [HUMAN_PREFIX, PHASES[phase] || PHASES.unknown];
  if (fields.reason_code || fields.reason) parts.push(diagnostic(fields.reason_code || fields.reason).reason);
  return humanLine(parts);
}
function activityLine(activity) {
  const labels = ACTIVITY_LABELS;
  const parts = [HUMAN_PREFIX, labels[activity.remote] || labels.unknown];
  if (activity.local?.length) parts.push('atividade local registrada separadamente');
  if (activity.terminal === 'unvalidated') parts.push('terminal recebido, processo sem encerramento confirmado e resultado não validado');
  if (activity.terminal === 'rejected-after-exit') parts.push('terminal recebido e resultado rejeitado ou falha depois do encerramento');
  if (activity.observation_age_ms !== null && activity.observation_age_ms !== undefined) parts.push(`idade da observação ${activity.observation_age_ms} ms`);
  if (activity.reason) parts.push(diagnostic(activity.reason).reason);
  return humanLine(parts);
}
function formatActivityLine(raw, fields = {}) {
  return activityLine(deriveActivity(raw, { ...fields, live: true, now: fields.now ?? 0 }));
}
function renderAgentView(view) {
  if (!view.agents.length) {
    const labels = EMPTY_LABELS;
    return humanLine([HUMAN_PREFIX, Object.hasOwn(labels, view.empty_reason) ? labels[view.empty_reason]
      : `censo indisponível; ${diagnostic(view.empty_reason).reason}`]);
  }
  return view.agents.flatMap(agent => [
    humanLine([HUMAN_PREFIX, KIND_LABELS[agent.kind] || KIND_LABELS.unknown,
      `host ${['codex', 'claude'].includes(agent.host_runtime) ? agent.host_runtime : 'desconhecido'}`,
      `transporte ${TRANSPORTS.includes(agent.transport) ? agent.transport : 'desconhecido'}`,
      `modelo resolvido ${humanModel(agent.model.resolved)}`, `observado ${humanModel(agent.model.observed)}`,
      `identidade ${agent.identity.provenance === 'native-lifecycle' ? 'native-lifecycle' : agent.identity.provenance === 'caller-attested' ? 'caller-attested' : agent.identity.provenance === 'journal-unpublished' ? 'journal ainda não publicado' : 'desconhecida'}`]),
    formatPhaseLine(agent.phase, { reason: agent.reason }), activityLine(agent.activity),
    ...NAVIGATION.filter(row => row.kind === agent.kind && (row.host === agent.host_runtime || row.host === 'any'))
      .map(row => humanLine([HUMAN_PREFIX, 'navegação condicional', row.label])),
  ]).join('\n');
}

/** Only supplied references are read; every payload is fixed and bounded. */
function readAgentSources(options = {}) {
  const fs = require('fs'), path = require('path');
  const { readBoundedStableFile } = require('./forge-autonomy-sources');
  const { resolveSafeFile, sha256 } = require('./forge-delivery');
  const { parseJsonlText } = require('./forge-jsonl');
  const ids = require('./forge-ids');
  const owner = fs.realpathSync.native(path.resolve(options.cwd || '.'));
  const filter = options.filter;
  if (!object(filter) || !['personal', 'milestone', 'workflow', 'unit'].includes(filter.type)
      || filter.type !== 'personal' && !safeCode(filter.id)) throw new Error('agent-view-scope-required');
  let scope = { ...filter }, emptyReason = null;
  if (filter.type === 'personal') {
    // Personal context owns address canonicalization (including Windows aliases).
    // Native realpath is for the bounded file reader, not a replacement profile key.
    const snapshot = require('./forge-personal-context').readPersonalSnapshot({ ...options, cwd: options.cwd || '.' });
    scope = { type: 'personal', works: (snapshot.works || []).map(row => row.id).filter(id => ids.isValid(id)) };
    if (snapshot.status !== 'ok' || !scope.works.length) emptyReason = snapshot.reason || 'no-bindings';
  }
  const label = (file, buffer) => {
    const relative = path.relative(owner, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/') : `sha256:${sha256(buffer)}`;
  };
  function read(reference, limit, contained) {
    try {
      const absolute = path.resolve(owner, reference);
      // Reject links in every component, including directory junctions.
      let walk = absolute;
      for (;;) {
        if (fs.lstatSync(walk).isSymbolicLink()) return { error: 'source_link' };
        const parent = path.dirname(walk);
        if (parent === walk) break;
        walk = parent;
      }
      const real = fs.realpathSync.native(absolute);
      const resolved = resolveSafeFile(real, contained ? [owner] : [path.dirname(real)], { maxBytes: limit });
      if (resolved.error) return resolved;
      const result = readBoundedStableFile(real, limit, { expectedReal: real });
      return result.error ? result : { ...result, source: label(real, result.buffer) };
    } catch { return { error: 'source_unreadable' }; }
  }
  const eventLimit = positiveLimit(options.maxEventBytes, LIMITS.events);
  const eventRead = emptyReason ? { error: emptyReason } : read('.gsd/forge/events.jsonl', eventLimit, true);
  const parsed = eventRead.error ? parseJsonlText('') : parseJsonlText(eventRead.buffer.toString('utf8'), { maxLines: positiveLimit(options.maxLines, LIMITS.lines) });
  const census = { total: parsed.total, skipped_empty: parsed.skipped_empty, skipped_malformed: parsed.skipped_malformed,
    truncated_tail: parsed.truncated_tail, reason: eventRead.error === 'source_too_large' ? 'events-too-large' : eventRead.error || null };
  const matching = parsed.lines.filter(row => object(row) && RECORDS.includes(row.event) && matches(row, scope));
  const dispatches = new Set(matching.map(row => safeDispatch(row.dispatch_id)).filter(Boolean));
  const scoped = parsed.lines.filter(row => object(row) && RECORDS.includes(row.event) && canJoin(row, scope, dispatches));
  const scopedSet = new Set(scoped);
  const records = parsed.lines.filter(row => scopedSet.has(row) || object(row) && row.event === 'agent-identity' && dispatches.has(row.dispatch_id));
  const sources = { events: { reference: eventRead.source || '.gsd/forge/events.jsonl', census }, receipts: [], journals: [], titles: [] };
  function references(kind, limit, accept) {
    const output = [];
    const supplied = Array.isArray(options[kind]) ? options[kind] : [];
    for (const reference of supplied.slice(0, LIMITS.references)) {
      const result = read(reference, limit, false);
      if (result.error) { sources[kind].push({ reference: 'unknown', reason: result.error }); continue; }
      let value;
      try { value = JSON.parse(result.buffer.toString('utf8')); } catch { sources[kind].push({ reference: result.source, reason: 'source_json' }); continue; }
      if (!object(value) || !accept(value)) continue;
      output.push({ value, source: result.source }); sources[kind].push({ reference: result.source, reason: null });
    }
    if (supplied.length > LIMITS.references) sources[kind].push({ reference: 'unknown', reason: 'source_count_limit' });
    return output;
  }
  const receipts = references('receipts', LIMITS.receipt, row => dispatches.has(row.dispatch_id));
  const journals = references('journals', LIMITS.journal, row => row.schema_version === 1
    && normalizeHostIdentity(row.host_identity) && dispatches.has(row.host_identity.dispatch_id));
  const titles = {};
  const titleReads = new Set();
  const planTitles = new Map();
  for (const row of scoped) {
    const titleKey = safeDispatch(row.dispatch_id);
    if (!titleKey || titleReads.has(titleKey)) continue;
    const unit = typeof row.unit === 'string' ? row.unit.split('/') : [];
    const id = unit.length === 2 ? unit[1] : null;
    let relative = null;
    if (unit[0] === 'execute-task' && ids.isValid(id) && ids.entityKind(id) === 'task') relative = `.gsd/tasks/${id}/${id}-PLAN.md`;
    // Short slice/task IDs are not entities in forge-ids: validate their numeric
    // suffix through its legacy milestone recognizer as well as the exact shape.
    if (unit[0] === 'execute-task' && /^T\d{2,}$/.test(id || '') && ids.isValid(`M${id.slice(1)}`)
        && /^S\d{2,}$/.test(row.slice || '') && ids.isValid(`M${row.slice.slice(1)}`)
        && ids.isValid(row.milestone) && ids.entityKind(row.milestone) === 'milestone') {
      relative = `.gsd/milestones/${row.milestone}/slices/${row.slice}/tasks/${id}/${id}-PLAN.md`;
    }
    if (!relative) continue;
    titleReads.add(titleKey);
    if (planTitles.has(relative)) {
      if (planTitles.get(relative)) titles[titleKey] = planTitles.get(relative);
      continue;
    }
    planTitles.set(relative, null);
    const result = read(relative, LIMITS.plans, true);
    if (result.error) continue;
    const text = result.buffer.toString('utf8');
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const title = front?.[1].match(/^title\s*:\s*(.*?)\s*$/m)?.[1] || text.match(/^#[ \t]+(.+)$/m)?.[1];
    if (title) { titles[titleKey] = plainText(title.startsWith("'") && title.endsWith("'") || title.startsWith('"') && title.endsWith('"') ? title.slice(1, -1) : title, { missing: null, limit: 160 }); planTitles.set(relative, titles[titleKey]); sources.titles.push({ reference: result.source }); }
  }
  return { records, receipts, journals, titles, scope, sources,
    empty_reason: emptyReason || (eventRead.error ? census.reason : null) };
}
function positiveLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) throw new Error('agent-view-limit-invalid');
  return value;
}
function main(argv) {
  try {
    const options = { receipts: [], journals: [] }; let json = false, now;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--json') { json = true; continue; }
      if (['--personal', '--milestone', '--workflow', '--unit'].includes(flag)) {
        if (options.filter) throw new Error('agent-view-scope-required');
        options.filter = { type: flag.slice(2), ...(flag === '--personal' ? {} : { id: argv[++i] }) }; continue;
      }
      if (!['--cwd', '--receipt', '--journal', '--max-lines', '--max-event-bytes', '--now'].includes(flag)
          || typeof argv[i + 1] !== 'string') throw new Error('agent-view-usage');
      const value = argv[++i];
      if (flag === '--receipt' || flag === '--journal') options[flag === '--receipt' ? 'receipts' : 'journals'].push(value);
      else if (flag === '--cwd') options.cwd = value;
      else if (flag === '--now') { now = wall(value); if (now === null) now = ms(Number(value)); if (now === null) throw new Error('agent-view-clock-invalid'); }
      else options[flag === '--max-lines' ? 'maxLines' : 'maxEventBytes'] = Number(value);
    }
    if (!options.filter) throw new Error('agent-view-scope-required');
    const view = deriveAgentView(readAgentSources(options), { now: now ?? Date.now() });
    process.stdout.write((json ? JSON.stringify(view) : renderAgentView(view)) + '\n'); return 0;
  } catch {
    process.stderr.write('uso: forge-agent-view.js (--personal | --milestone <id> | --workflow <id> | --unit <unidade>) [--cwd <owner>] [--json] [--receipt <arquivo>] [--journal <arquivo>] [--max-lines <n>] [--max-event-bytes <n>] [--now <instante>]\n'); return 2;
  }
}

module.exports = { deriveAgentView, readAgentSources, renderAgentView, formatPhaseLine, formatActivityLine, PHASES, AGENT_ROLES, NAVIGATION,
  ACTIVITY_LABELS, KIND_LABELS, EMPTY_LABELS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
