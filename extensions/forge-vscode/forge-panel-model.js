'use strict';

const SYNTHETIC_LABEL = 'Dados sintéticos';
const EMPTY_CHILDREN = Object.freeze([]);

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function node(label, detail = '', children = EMPTY_CHILDREN) {
  const description = detail ? `${detail} · ${SYNTHETIC_LABEL}` : SYNTHETIC_LABEL;
  return Object.freeze({ label, description, tooltip: `${label}: ${description}`, children: Object.freeze(children) });
}

function buildNodes(snapshot) {
  if (snapshot == null) return Object.freeze([node('Sem dados sintéticos')]);
  const valid = snapshot.synthetic === true && typeof snapshot.phase === 'string'
    && Array.isArray(snapshot.agents) && snapshot.agents.every(agent => agent && text(agent.name)
      && ['nativo', 'sidecar'].includes(agent.type))
    && Array.isArray(snapshot.pending) && snapshot.pending.every(item => item && text(item.id) && text(item.text))
    && Array.isArray(snapshot.evidence) && snapshot.evidence.every(item => item && text(item.label)
      && text(item.link) && !/[:\\?#]/.test(item.link)
      && item.link.split('/').every(part => part && part !== '.' && part !== '..'));
  if (!valid) return Object.freeze([node('Snapshot sintético inválido')]);
  if (!snapshot.phase.trim() && !snapshot.agents.length && !snapshot.pending.length && !snapshot.evidence.length) {
    return Object.freeze([node('Sem dados sintéticos')]);
  }
  return Object.freeze([
    node('Fase', snapshot.phase || 'Não informada'),
    node('Agentes', '', snapshot.agents.map(agent => node(agent.name, agent.type))),
    node('Pendências', '', snapshot.pending.map(item => node(`${item.id}: ${item.text}`))),
    node('Evidências', '', snapshot.evidence.map(item => node(item.label, item.link))),
  ]);
}

function getChildren(nodes, element) {
  return element ? element.children : nodes;
}

function getTreeItem(element) {
  return Object.freeze({
    label: element.label,
    description: element.description,
    tooltip: element.tooltip,
    // TreeItemCollapsibleState: None = 0, Collapsed = 1; no host dependency.
    collapsibleState: element.children.length ? 1 : 0,
  });
}

module.exports = { buildNodes, getChildren, getTreeItem };
