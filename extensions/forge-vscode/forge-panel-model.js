'use strict';

// Pure DTO-to-node model. Labels come from the canonical DTO; only the states
// produced before or around the core read are labelled here.
const EMPTY_CHILDREN = Object.freeze([]);
const READ_ONLY = 'somente leitura';
const STATUSES = Object.freeze(['ok', 'empty', 'unavailable', 'invalid']);
const STATUS_LABELS = Object.freeze({ ok: 'atual', empty: 'vazio', unavailable: 'indisponível', invalid: 'inválido' });
const LOCAL_STATES = Object.freeze({
  'core-unavailable': Object.freeze({ status: 'unavailable', label: 'núcleo Forge indisponível' }),
  'core-timeout': Object.freeze({ status: 'unavailable', label: 'tempo de leitura do núcleo esgotado' }),
  'core-failed': Object.freeze({ status: 'unavailable', label: 'leitura do núcleo falhou' }),
  'workspace-not-local': Object.freeze({ status: 'empty', label: 'pasta fora do sistema de arquivos local' }),
  'no-workspace': Object.freeze({ status: 'empty', label: 'nenhuma pasta aberta' }),
  'dto-invalid': Object.freeze({ status: 'invalid', label: 'dados do painel inválidos' }),
});
const READING_LABEL = 'Lendo o trabalho...';
const LOCATION_LABELS = Object.freeze({ project: 'no projeto', worktree: 'no worktree', external: 'fora do projeto' });
const VALIDITY_LABELS = Object.freeze({ current: 'atual', stale: 'desatualizada', missing: 'ausente', unreadable: 'ilegível' });
const QUESTION_LABELS = Object.freeze({ pending: 'pendente', answered: 'respondida', resolved: 'resolvida' });
const GROUPS = Object.freeze([['works', 'work', 'Trabalho'], ['agents', 'agents', 'Agentes'],
  ['pending', 'pending', 'Pendências'], ['evidence', 'evidence', 'Evidências']]);
const known = new WeakSet();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value, missing = '') {
  return typeof value === 'string' && value.trim() ? value : missing;
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function node(id, label, description = '', children = EMPTY_CHILDREN) {
  const frozen = Object.freeze({ id, label, description, tooltip: description ? `${label} — ${description}` : label,
    children: Object.freeze(children) });
  known.add(frozen);
  return frozen;
}

// Shape gate shared with the reader. Rows stay defensive in the builders below.
function isPanelDto(dto) {
  return isObject(dto) && dto.schema_version === 1 && isObject(dto.state) && STATUSES.includes(dto.state.status)
    && typeof dto.state.reason === 'string' && typeof dto.state.label === 'string'
    && GROUPS.every(([key]) => Array.isArray(dto[key]) && dto[key].length <= 64)
    && isObject(dto.sections) && isObject(dto.census)
    && typeof dto.generated_at === 'string' && Number.isFinite(Date.parse(dto.generated_at))
    && typeof dto.stable_sha256 === 'string' && /^[a-f0-9]{64}$/.test(dto.stable_sha256);
}

function localResult(reason) {
  const key = Object.hasOwn(LOCAL_STATES, reason) ? reason : 'dto-invalid';
  return Object.freeze({ local: true, state: Object.freeze({ status: LOCAL_STATES[key].status, reason: key }) });
}

function isLocalResult(result) {
  return isObject(result) && result.local === true && isObject(result.state) && Object.hasOwn(LOCAL_STATES, result.state.reason);
}

function summarize(result) {
  const dto = isPanelDto(result) ? result : null;
  const state = dto ? dto.state : isLocalResult(result) ? result.state : localResult('dto-invalid').state;
  return Object.freeze({ status: state.status, reason: state.reason,
    counts: Object.freeze(Object.fromEntries(GROUPS.map(([key]) => [key, dto ? dto[key].length : 0]))),
    stable_sha256: dto ? dto.stable_sha256 : null, generated_at: dto ? dto.generated_at : null });
}

function readingNodes() {
  return Object.freeze([node('state', READING_LABEL, READ_ONLY)]);
}

function stateNodes(label, status) {
  return Object.freeze([node('state', label, `${STATUS_LABELS[status]} · ${READ_ONLY}`)]);
}

function clockText(value) {
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) return 'horário desconhecido';
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

function join(parts) {
  return parts.filter(part => typeof part === 'string' && part).join(' · ');
}

function sectionNotes(dto, key, prefix) {
  const notes = [];
  const section = isObject(dto.sections[key]) ? dto.sections[key] : null;
  if (section && section.status !== 'ok') notes.push(str(section.label, 'seção indisponível'));
  const census = isObject(dto.census[key]) ? dto.census[key] : {};
  const hidden = key === 'pending' ? count(census.row_excess) + count(census.excess) : count(census.excess);
  if (hidden) notes.push(`mais ${hidden} acima do limite, não exibidos`);
  if (key === 'pending' && count(census.foreign)) notes.push(`${count(census.foreign)} de outro escopo, só contagem`);
  if (key === 'pending' && count(census.invalid)) notes.push(`${count(census.invalid)} inválidas ignoradas`);
  if (key === 'agents' && isObject(dto.census.events) && count(dto.census.events.skipped_malformed)) {
    notes.push(`${count(dto.census.events.skipped_malformed)} eventos malformados ignorados`);
  }
  return notes.map((text, index) => node(`${prefix}/note/${index}`, text));
}

function workNode(work, id) {
  const children = [];
  const next = isObject(work.next_action) ? work.next_action : {};
  children.push(node(`${id}/next`, `Próximo passo: ${str(next.text, 'não registrado')}`,
    next.validity && next.validity !== 'current' ? `validade: ${str(next.validity)}` : ''));
  const position = join([work.active_slice ? `fatia ${str(work.active_slice)}` : '', work.active_task ? `tarefa ${str(work.active_task)}` : '']);
  if (position) children.push(node(`${id}/position`, `Posição: ${position}`));
  const phase = isObject(work.phase) ? work.phase : {};
  const freshness = work.freshness !== 'current' ? `dados ${str(work.freshness_label, 'desconhecido')}` : '';
  return node(id, str(work.id, 'trabalho sem identificador'), join([str(phase.label), str(work.status_label), freshness]), children);
}

function agentNode(agent, id) {
  const model = isObject(agent.model) ? agent.model : {};
  const phase = isObject(agent.phase) ? agent.phase : {};
  const activity = isObject(agent.activity) ? agent.activity : {};
  const local = Array.isArray(activity.local) ? activity.local.filter(value => typeof value === 'string') : [];
  const children = [
    node(`${id}/phase`, `Fase: ${str(phase.label, 'desconhecida')}`),
    node(`${id}/model`, `Modelo resolvido: ${str(model.resolved, 'não informado')}`,
      join([`observado: ${str(model.observed, 'não observado')}`, model.divergent === true ? 'divergente' : ''])),
    node(`${id}/activity`, `Atividade: ${str(activity.label, 'desconhecida')}`, local.length ? `local: ${local.join(', ')}` : ''),
  ];
  const navigation = Array.isArray(agent.navigation) ? agent.navigation.filter(value => typeof value === 'string' && value) : [];
  if (navigation.length) children.push(node(`${id}/navigation`, `Navegação condicional: ${navigation.join('; ')}`));
  const freshness = agent.freshness && agent.freshness !== 'current' ? `dados ${str(agent.freshness)}` : '';
  return node(id, join([str(agent.kind_label, 'executor'), str(agent.task) || str(agent.unit) || str(agent.dispatch_id)]),
    join([str(agent.host), str(agent.transport), freshness]), children);
}

function pendingNode(row, id, agents) {
  const agent = row.dispatch_id ? agents.find(item => isObject(item) && item.dispatch_id === row.dispatch_id) : null;
  const origin = join([str(row.unit), str(row.milestone)]);
  return node(id, `${str(row.id, 'pergunta')}: ${str(row.question, 'sem texto')}`,
    join([Object.hasOwn(QUESTION_LABELS, row.status) ? QUESTION_LABELS[row.status] : str(row.status, 'desconhecida'),
      origin ? `origem ${origin}` : '', agent ? str(agent.kind_label) : '']));
}

function evidenceNode(row, id) {
  return node(id, str(row.label, 'evidência'), join([str(row.path, 'sem caminho relativo'),
    Object.hasOwn(LOCATION_LABELS, row.location) ? LOCATION_LABELS[row.location] : 'localização desconhecida',
    `validade ${Object.hasOwn(VALIDITY_LABELS, row.validity) ? VALIDITY_LABELS[row.validity] : 'desconhecida'}`]));
}

function okNodes(dto, at) {
  const builders = { works: workNode, agents: agentNode, evidence: evidenceNode,
    pending: (row, id) => pendingNode(row, id, dto.agents) };
  const groups = GROUPS.map(([key, prefix, label]) => {
    const rows = dto[key].filter(isObject).map((row, index) => builders[key](row, `${prefix}/${index}`));
    const children = rows.concat(sectionNotes(dto, key, prefix));
    return node(prefix, label, String(rows.length), children);
  });
  const project = isObject(dto.project) ? str(dto.project.label) : '';
  groups.push(node('footer', `Lido às ${clockText(at)}`, join([project, READ_ONLY])));
  return Object.freeze(groups);
}

function buildNodes(dto, options = {}) {
  try {
    if (isLocalResult(dto)) {
      const state = LOCAL_STATES[dto.state.reason];
      return stateNodes(state.label, state.status);
    }
    if (!isPanelDto(dto)) return stateNodes(LOCAL_STATES['dto-invalid'].label, 'invalid');
    if (dto.state.status !== 'ok') return stateNodes(str(dto.state.label, dto.state.reason), dto.state.status);
    return okNodes(dto, options.now === undefined ? dto.generated_at : options.now);
  } catch (_) {
    return stateNodes(LOCAL_STATES['dto-invalid'].label, 'invalid');
  }
}

function getChildren(nodes, element) {
  if (element === undefined || element === null) return nodes;
  return known.has(element) ? element.children : EMPTY_CHILDREN;
}

// Only display fields leave the model: no command, contextValue or resource.
function getTreeItem(element) {
  if (!known.has(element)) return Object.freeze({ label: '', collapsibleState: 0 });
  return Object.freeze({
    id: element.id,
    label: element.label,
    description: element.description,
    tooltip: element.tooltip,
    // TreeItemCollapsibleState: None = 0, Collapsed = 1; no host dependency.
    collapsibleState: element.children.length ? 1 : 0,
  });
}

module.exports = { LOCAL_STATES, READING_LABEL, isPanelDto, localResult, summarize, readingNodes, buildNodes, getChildren, getTreeItem };
