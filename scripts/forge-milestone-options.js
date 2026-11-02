#!/usr/bin/env node
'use strict';

// Milestone time options (S02): validator of the worker proposal (<M>-OPTIONS.json),
// bounded read-only history, evidence estimator v1, owner materialization, pt-BR
// render and the decision rounds. Import is inert: only core modules load here and
// every local dependency is required lazily. Worker text is data and never grants
// authority; producer identities and input fingerprints come only from the owner.
const fs = require('fs');
const path = require('path');

const PROPOSAL_SCHEMA_VERSION = 1;
const POSITION_IDS = Object.freeze(['curta', 'media', 'longa']);
const MEASURABLE_PHASES = Object.freeze(['plan-milestone', 'discuss-milestone', 'research-milestone', 'plan-slice', 'research-slice', 'execute-task', 'complete-slice', 'complete-milestone']);
const NODE_KINDS = Object.freeze(['preparation', 'slice', 'integration', 'review', 'corrections']);
// Endpoint gates that must stay on the milestone side of every position.
const GATE_KINDS = Object.freeze(['preparation', 'integration', 'review', 'corrections']);
const SCOPE_SOURCES = Object.freeze(['SCOPE', 'CONTEXT', 'BRAINSTORM', 'REQUIREMENTS']);
const PROPOSAL_ITEM_STATES = Object.freeze(['included', 'pending', 'deferred', 'not-applicable']);
const POSITION_STATUSES = Object.freeze(['viable', 'infeasible']);
const DEFERRAL_CONSENT = 'required';
const ESTIMATE_POLICY = Object.freeze({ id: 'forge-milestone-time-estimate', version: 1 });
// max_source_bytes is forge-phase-cost MAX_BYTES (asserted by the suite and at read time).
const HISTORY_LIMITS = Object.freeze({ max_sources: 64, max_total_bytes: 64 * 1024 * 1024, max_source_bytes: 2 * 1024 * 1024 });
// Policy thresholds are sample counts and factor bounds, never durations.
const CALIBRATED_SAMPLES = 5;
const FACTOR_MIN = 0.5, FACTOR_MAX = 3;
const PHASE_COUNT_MAX = 999;
const MAX_PROPOSAL_BYTES = 128 * 1024, MAX_RECORD_BYTES = 256 * 1024;
const MAX_NODES = 64, MAX_SCOPE_ITEMS = 64, MAX_LIST = 32, MAX_TEXT = 1000, MAX_LABEL = 60, MAX_INPUT_FILES = 256;
const LINKED_TASK_AUTHORIZATIONS = Object.freeze(['create-and-start-after-proven-completion', 'create-without-auto-start', 'none']);
const ROUND_TYPES = Object.freeze(['mode', 'position', 'strategy', 'ceiling', 'linked', 'scope']);
// Backtracking steps the exact labelled-graph comparison may spend on one pair; past it the answer is unknown, never "identical".
const COMPARISON_STEP_LIMIT = 200000;
const MIN_CEILING_MS = 60000, MAX_CEILING_MS = 365 * 24 * 3600000;

// Required keys and enums of the v1 proposal; the JSON schema declares the same sets.
const REQUIRED = Object.freeze({
  proposal: ['schema_version', 'milestone', 'scope_items', 'endpoint', 'recommended', 'recommendation_reason', 'positions'],
  scope_item: ['id', 'title', 'indispensable', 'source'],
  endpoint: ['kind', 'items'],
  position: ['id', 'label', 'status', 'reason', 'strategy', 'technical_choices', 'deliverables', 'nodes', 'parallel_groups', 'verifications', 'review', 'risks', 'uncertainties', 'deferrals', 'linked_task'],
  node: ['id', 'kind', 'title', 'phases', 'activities', 'judgment', 'depends', 'covers'],
  range_judgment: ['low_ms', 'high_ms', 'reason', 'sources'],
  factor_judgment: ['factor_low', 'factor_high', 'reason', 'sources'],
  parallel_group: ['nodes', 'independence', 'isolation'],
  deferral: ['scope_item', 'reason', 'consent'],
  linked_task: ['moved_scope', 'criteria', 'nodes'],
  criteria: ['milestone', 'task'],
});
const REFUSALS = Object.freeze(['options-schema-invalid', 'options-milestone-mismatch', 'options-positions-invalid', 'options-number-unsourced', 'options-phase-unknown',
  'options-graph-invalid', 'options-node-unestimable', 'options-positions-identical', 'options-deferral-unmarked', 'options-endpoint-gates-missing',
  'options-linked-task-indispensable', 'options-parallel-undeclared', 'options-infeasible-reason-missing', 'options-recommendation-invalid', 'options-text-invalid', 'options-comparison-limit']);

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/, HASH = /^[a-f0-9]{64}$/;
// Worker text may not carry prompt envelopes or procedure markers.
const MARKER = /\[\s*(?:END\s+)?DATA\b|DATA FROM|forge-procedure/i;
// A duration written into prose is an unsourced number (only phase counts and labelled judgments are numbers).
const DURATION_TEXT = /(?:^|[^\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:ms|s|seg(?:undos?)?|min(?:utos?)?|h|hrs?|horas?|d|dias?|semanas?|m[eê]s(?:es)?|hours?|minutes?|days?|weeks?)(?![\p{L}\p{N}])/iu;

function fail(code, detail) { throw Object.assign(new Error(detail ? code + ': ' + detail : code), { code }); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) { return object(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k)); }
function id(v) { return typeof v === 'string' && ID.test(v); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function ms(v) { return Number.isSafeInteger(v) && v > 0; }
function text(v, max = MAX_TEXT) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max; }
function textList(v, min = 0) { return Array.isArray(v) && v.length >= min && v.length <= MAX_LIST && v.every(x => text(x)); }
function idList(v, min = 0, max = MAX_NODES) { return Array.isArray(v) && v.length >= min && v.length <= max && v.every(id) && new Set(v).size === v.length; }
function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v; }
function digest(v) { return require('./forge-code-roots').digest(v); }
function canonical(v) { return require('./forge-milestone-roadmap-time').canonical(v); }
function isPublicData(v) { return require('./forge-milestone-time').isPublicData(v); }
function milestoneId(v) {
  const ids = require('./forge-ids');
  return typeof v === 'string' && !/[\\/\0]/.test(v) && ids.isValid(v) && ids.entityKind(v) === 'milestone';
}
// Every derived duration must stay a positive safe integer; an unsupported value is refused, never clamped or rounded.
function safe(value, at) { if (!ms(value)) fail('options-duration-unsafe', at); return value; }
function refused(reason, at) { return { valid: false, reason, path: at || '' }; }

// ---------------------------------------------------------------------------
// Proposal validator
// ---------------------------------------------------------------------------
function walkStrings(value, at, visit) {
  if (typeof value === 'string') return visit(value, at);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const r = walkStrings(value[i], at + '[' + i + ']', visit); if (r) return r; } return null; }
  if (object(value)) for (const [k, x] of Object.entries(value)) {
    const r = visit(k, at ? at + '.' + k : k) || walkStrings(x, at ? at + '.' + k : k, visit); if (r) return r;
  }
  return null;
}
function textFailure(proposal) {
  const bad = walkStrings(proposal, '', (s, at) => /[\x00-\x1f\x7f]/.test(s) || MARKER.test(s) || !isPublicData(s) ? at || '(raiz)' : null);
  if (bad) return bad;
  return isPublicData(proposal) ? null : '(raiz)';
}
function judgmentShape(j) {
  if (j === null) return true;
  if (exact(j, REQUIRED.range_judgment)) return typeof j.low_ms === 'number' && typeof j.high_ms === 'number' && typeof j.reason === 'string' && Array.isArray(j.sources) && j.sources.every(s => typeof s === 'string');
  if (exact(j, REQUIRED.factor_judgment)) return typeof j.factor_low === 'number' && typeof j.factor_high === 'number' && typeof j.reason === 'string' && Array.isArray(j.sources) && j.sources.every(s => typeof s === 'string');
  return false;
}
// Structural (schema) check. Phase names and numeric values are checked by later named steps.
function schemaFailure(p) {
  if (!exact(p, REQUIRED.proposal)) return '(raiz)';
  if (p.schema_version !== PROPOSAL_SCHEMA_VERSION) return 'schema_version';
  if (typeof p.milestone !== 'string') return 'milestone';
  if (!Array.isArray(p.scope_items) || !p.scope_items.length || p.scope_items.length > MAX_SCOPE_ITEMS) return 'scope_items';
  for (const [i, s] of p.scope_items.entries()) {
    if (!exact(s, REQUIRED.scope_item) || !id(s.id) || !text(s.title) || typeof s.indispensable !== 'boolean' || !SCOPE_SOURCES.includes(s.source)) return 'scope_items[' + i + ']';
  }
  const endpointItems = require('./forge-milestone-time').ENDPOINT_ITEMS;
  if (!exact(p.endpoint, REQUIRED.endpoint) || p.endpoint.kind !== 'verified-integrated-delivery' || !exact(p.endpoint.items, endpointItems)
      || !endpointItems.every(k => PROPOSAL_ITEM_STATES.includes(p.endpoint.items[k]))) return 'endpoint';
  if (!(p.recommended === null || typeof p.recommended === 'string')) return 'recommended';
  if (!(p.recommendation_reason === null || typeof p.recommendation_reason === 'string' && p.recommendation_reason.length <= MAX_TEXT)) return 'recommendation_reason';
  if (!Array.isArray(p.positions)) return 'positions';
  for (const [i, x] of p.positions.entries()) {
    const at = 'positions[' + i + ']';
    if (!exact(x, REQUIRED.position)) return at;
    if (!id(x.id)) return at + '.id';
    if (!text(x.label, MAX_LABEL)) return at + '.label';
    if (!POSITION_STATUSES.includes(x.status)) return at + '.status';
    if (typeof x.reason !== 'string' || x.reason.length > MAX_TEXT) return at + '.reason';
    if (!text(x.strategy)) return at + '.strategy';
    for (const k of ['technical_choices', 'risks', 'uncertainties']) if (!textList(x[k])) return at + '.' + k;
    for (const k of ['deliverables', 'verifications', 'review']) if (!textList(x[k], 1)) return at + '.' + k;
    if (!Array.isArray(x.nodes) || !x.nodes.length || x.nodes.length > MAX_NODES) return at + '.nodes';
    for (const [j, n] of x.nodes.entries()) {
      const nat = at + '.nodes[' + j + ']';
      if (!exact(n, REQUIRED.node) || !id(n.id) || !NODE_KINDS.includes(n.kind) || !text(n.title)) return nat;
      if (!object(n.phases) || Object.keys(n.phases).length > MEASURABLE_PHASES.length + 8) return nat + '.phases';
      if (!textList(n.activities, 1)) return nat + '.activities';
      if (!judgmentShape(n.judgment)) return nat + '.judgment';
      if (!Array.isArray(n.depends) || n.depends.length > MAX_NODES || !n.depends.every(id)) return nat + '.depends';
      if (!Array.isArray(n.covers) || n.covers.length > MAX_SCOPE_ITEMS || !n.covers.every(id)) return nat + '.covers';
    }
    if (!Array.isArray(x.parallel_groups) || x.parallel_groups.length > MAX_LIST) return at + '.parallel_groups';
    for (const [j, g] of x.parallel_groups.entries()) {
      if (!exact(g, REQUIRED.parallel_group) || !Array.isArray(g.nodes) || !g.nodes.every(id) || typeof g.independence !== 'string' || typeof g.isolation !== 'string') return at + '.parallel_groups[' + j + ']';
    }
    if (!Array.isArray(x.deferrals) || x.deferrals.length > MAX_SCOPE_ITEMS) return at + '.deferrals';
    for (const [j, d] of x.deferrals.entries()) {
      if (!exact(d, REQUIRED.deferral) || !id(d.scope_item) || !text(d.reason) || typeof d.consent !== 'string') return at + '.deferrals[' + j + ']';
    }
    if (x.linked_task !== null) {
      const t = x.linked_task;
      if (!exact(t, REQUIRED.linked_task) || !idList(t.moved_scope, 1, MAX_SCOPE_ITEMS) || !idList(t.nodes, 1) || !exact(t.criteria, REQUIRED.criteria)
          || !textList(t.criteria.milestone, 1) || !textList(t.criteria.task, 1)) return at + '.linked_task';
    }
  }
  return null;
}
function numberFailure(p) {
  for (const [i, x] of p.positions.entries()) for (const [j, n] of x.nodes.entries()) {
    const at = 'positions[' + i + '].nodes[' + j + ']';
    for (const [phase, count] of Object.entries(n.phases)) if (!Number.isInteger(count) || count < 1 || count > PHASE_COUNT_MAX) return at + '.phases.' + phase;
    const g = n.judgment;
    if (g === null) continue;
    if (!text(g.reason) || !textList(g.sources, 1)) return at + '.judgment';
    if (Object.hasOwn(g, 'low_ms') ? !ms(g.low_ms) || !ms(g.high_ms) || g.low_ms > g.high_ms
      : !Number.isFinite(g.factor_low) || !Number.isFinite(g.factor_high) || g.factor_low < FACTOR_MIN || g.factor_high > FACTOR_MAX || g.factor_low > g.factor_high) return at + '.judgment';
  }
  // Durations in prose bypass the sourced numbers; only a judgment reason explains its own labelled range.
  return walkStrings(p, '', (s, at) => !/\.judgment\.reason$/.test(at) && DURATION_TEXT.test(s) ? at : null);
}
function reachable(edges, from) {
  const seen = new Set(), stack = [from];
  while (stack.length) for (const next of edges.get(stack.pop()) || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  return seen;
}
// Phase counts and judgments are numbers, not work: they never make a different strategy. Node IDs, node order and dependency order are cosmetic too:
// each node is labelled by its own work plus its neighbours' labels (refined in both directions over the validated acyclic graph); the strategy is the sorted label multiset.
function structuralView(x) {
  const hash = v => require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);
  const linked = new Set(x.linked_task === null ? [] : x.linked_task.nodes), position = new Map(x.nodes.map((n, i) => [n.id, i]));
  const down = x.nodes.map(n => n.depends.map(d => position.get(d))), up = x.nodes.map(() => []);
  down.forEach((list, i) => list.forEach(d => up[d].push(i)));
  let labels = x.nodes.map(n => hash({ kind: n.kind, phases: Object.keys(n.phases).sort(), activities: [...n.activities].sort(), covers: [...n.covers].sort(), linked: linked.has(n.id) }));
  for (let round = 0; round < x.nodes.length; round++) {
    const previous = labels;
    labels = previous.map((label, i) => hash({ label, down: down[i].map(d => previous[d]).sort(), up: up[i].map(u => previous[u]).sort() }));
  }
  const edges = down.flatMap((list, i) => list.map(d => labels[i] + '>' + labels[d])).sort();
  const print = JSON.stringify({ nodes: [...labels].sort(), edges, deferrals: x.deferrals.map(d => d.scope_item).sort(), moved: x.linked_task === null ? null : [...x.linked_task.moved_scope].sort() });
  return { print, labels, down: down.map(list => new Set(list)) };
}
// The fingerprint is only a necessary condition. Exact check: a label-preserving bijection of the nodes that keeps every directed dependency and no other.
// Returns true, false, or null when the step limit is hit (unknown).
function sameLabelledGraph(a, b, limit) {
  const n = a.labels.length;
  if (n !== b.labels.length) return false;
  const adjacent = a.down.map((set, i) => { const all = new Set(set); a.down.forEach((other, j) => { if (other.has(i)) all.add(j); }); return all; });
  const order = [], placed = new Set();
  while (order.length < n) {
    let next = -1;
    for (let i = 0; i < n && next < 0; i++) if (!placed.has(i) && order.some(j => adjacent[i].has(j))) next = i;
    if (next < 0) next = a.labels.findIndex((_, i) => !placed.has(i));
    placed.add(next); order.push(next);
  }
  const map = new Array(n).fill(-1), used = new Set();
  let steps = 0;
  const search = depth => {
    if (depth === n) return true;
    const i = order[depth];
    for (let j = 0; j < n; j++) {
      if (used.has(j) || a.labels[i] !== b.labels[j] || a.down[i].size !== b.down[j].size) continue;
      if (++steps > limit) return null;
      let fits = true;
      for (let k = 0; k < depth && fits; k++) { const m = order[k]; fits = a.down[i].has(m) === b.down[j].has(map[m]) && a.down[m].has(i) === b.down[map[m]].has(j); }
      if (!fits) continue;
      map[i] = j; used.add(j);
      const found = search(depth + 1);
      if (found !== false) return found;
      map[i] = -1; used.delete(j);
    }
    return false;
  };
  return search(0);
}
// The side partition used by T01 selection and roadmap conformance, from the same functions.
function partitionOf(position) {
  const rt = require('./forge-milestone-roadmap-time');
  const graph = rt.sourceGraph({}, position);
  if (graph.status !== 'valid') return { status: 'invalid', reason: graph.reason };
  const part = rt.selectedPartition(graph);
  if (part.status !== 'valid') return { status: 'invalid', reason: part.reason };
  return { status: 'valid', graph, part };
}
function validateProposal(proposal, milestone, limits = {}) {
  if (!object(proposal)) return refused('options-schema-invalid', '(raiz)');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(proposal)); } catch { return refused('options-schema-invalid', '(raiz)'); }
  if (size > MAX_PROPOSAL_BYTES) return refused('options-schema-invalid', '(tamanho)');
  const textAt = textFailure(proposal);
  if (textAt) return refused('options-text-invalid', textAt);
  const schemaAt = schemaFailure(proposal);
  if (schemaAt) return refused('options-schema-invalid', schemaAt);
  if (milestone !== undefined && proposal.milestone !== milestone || !milestoneId(proposal.milestone)) return refused('options-milestone-mismatch', 'milestone');
  const positions = proposal.positions;
  if (positions.length !== POSITION_IDS.length || new Set(positions.map(x => x.id)).size !== positions.length || !positions.every(x => POSITION_IDS.includes(x.id))
      || new Set(positions.map(x => x.label)).size !== positions.length) return refused('options-positions-invalid', 'positions');
  for (const [i, x] of positions.entries()) for (const [j, n] of x.nodes.entries()) {
    const unknown = Object.keys(n.phases).find(k => !MEASURABLE_PHASES.includes(k));
    if (unknown !== undefined) return refused('options-phase-unknown', 'positions[' + i + '].nodes[' + j + '].phases.' + unknown);
  }
  const numberAt = numberFailure(proposal);
  if (numberAt) return refused('options-number-unsourced', numberAt);
  const scopeIds = proposal.scope_items.map(s => s.id), scope = new Map(proposal.scope_items.map(s => [s.id, s]));
  if (new Set(scopeIds).size !== scopeIds.length) return refused('options-graph-invalid', 'scope_items');
  const parts = [];
  for (const [i, x] of positions.entries()) {
    const at = 'positions[' + i + ']', ids = x.nodes.map(n => n.id), known = new Set(ids);
    if (known.size !== ids.length || ids.some(n => scope.has(n))) return refused('options-graph-invalid', at + '.nodes');
    for (const [j, n] of x.nodes.entries()) {
      if (new Set(n.depends).size !== n.depends.length || n.depends.some(d => d === n.id || !known.has(d))) return refused('options-graph-invalid', at + '.nodes[' + j + '].depends');
      if (new Set(n.covers).size !== n.covers.length || n.covers.some(c => !scope.has(c))) return refused('options-graph-invalid', at + '.nodes[' + j + '].covers');
    }
    const deferred = x.deferrals.map(d => d.scope_item);
    if (new Set(deferred).size !== deferred.length || deferred.some(c => !scope.has(c))) return refused('options-graph-invalid', at + '.deferrals');
    if (x.linked_task && (x.linked_task.moved_scope.some(c => !scope.has(c)) || x.linked_task.nodes.some(n => !known.has(n)))) return refused('options-graph-invalid', at + '.linked_task');
    const partition = partitionOf(x);
    if (partition.status !== 'valid') return refused('options-graph-invalid', at + '.nodes');
    parts.push(partition);
  }
  for (const [i, x] of positions.entries()) for (const [j, n] of x.nodes.entries()) {
    if (!Object.keys(n.phases).length && !(n.judgment && Object.hasOwn(n.judgment, 'low_ms'))) return refused('options-node-unestimable', 'positions[' + i + '].nodes[' + j + ']');
  }
  for (const [i, x] of positions.entries()) {
    const at = 'positions[' + i + ']', deferred = new Set(x.deferrals.map(d => d.scope_item)), moved = new Set(x.linked_task?.moved_scope || []);
    for (const [j, d] of x.deferrals.entries()) {
      if (d.consent !== DEFERRAL_CONSENT) return refused('options-deferral-unmarked', at + '.deferrals[' + j + ']');
      if (scope.get(d.scope_item).indispensable) return refused('options-positions-invalid', at + '.deferrals[' + j + ']');
      if (moved.has(d.scope_item)) return refused('options-graph-invalid', at + '.deferrals[' + j + ']');
    }
    const { part } = parts[i], milestoneSide = x.nodes.filter(n => part.scope.has(n.id));
    // A scope item no milestone or task node delivers is an implicit deferral unless it is marked.
    const covered = new Set(x.nodes.filter(n => part.scope.has(n.id) || part.moved.includes(n.id)).flatMap(n => n.covers));
    const silent = scopeIds.find(s => !covered.has(s) && !deferred.has(s));
    if (silent !== undefined) return refused('options-deferral-unmarked', at + '.scope_items.' + silent);
    for (const n of milestoneSide) if (n.covers.some(c => deferred.has(c) && !n.covers.every(k => deferred.has(k)))) return refused('options-deferral-unmarked', at + '.nodes.' + n.id);
    if (x.linked_task) {
      const t = x.linked_task, taskNodes = x.nodes.filter(n => t.nodes.includes(n.id));
      if (t.moved_scope.some(c => scope.get(c).indispensable)) return refused('options-linked-task-indispensable', at + '.linked_task.moved_scope');
      if (taskNodes.some(n => n.kind !== 'slice')) return refused('options-linked-task-indispensable', at + '.linked_task.nodes');
      // Moved nodes and moved scope agree: task nodes deliver only moved items and every moved item only on the task side.
      if (taskNodes.some(n => !n.covers.length || n.covers.some(c => !moved.has(c))) || t.moved_scope.some(c => !taskNodes.some(n => n.covers.includes(c)))
          || milestoneSide.some(n => n.covers.some(c => moved.has(c)))) return refused('options-graph-invalid', at + '.linked_task');
    }
    const kinds = new Set(milestoneSide.map(n => n.kind));
    const missing = GATE_KINDS.find(k => !kinds.has(k));
    if (missing !== undefined) return refused('options-endpoint-gates-missing', at + '.nodes.' + missing);
    // Indispensable items stay delivered on the milestone side.
    const milestoneCovers = new Set(milestoneSide.flatMap(n => n.covers));
    const lost = proposal.scope_items.find(s => s.indispensable && !milestoneCovers.has(s.id));
    if (lost) return refused('options-linked-task-indispensable', at + '.scope_items.' + lost.id);
  }
  for (const [i, x] of positions.entries()) {
    const edges = new Map(x.nodes.map(n => [n.id, n.depends]));
    for (const [j, g] of x.parallel_groups.entries()) {
      const at = 'positions[' + i + '].parallel_groups[' + j + ']';
      if (g.nodes.length < 2 || new Set(g.nodes).size !== g.nodes.length || g.nodes.some(n => !edges.has(n)) || !text(g.independence) || !text(g.isolation)) return refused('options-parallel-undeclared', at);
      for (const a of g.nodes) { const deps = reachable(edges, a); if (g.nodes.some(b => b !== a && deps.has(b))) return refused('options-parallel-undeclared', at); }
    }
  }
  for (const [i, x] of positions.entries()) if (x.status === 'infeasible' && !x.reason.trim()) return refused('options-infeasible-reason-missing', 'positions[' + i + '].reason');
  const viable = positions.filter(x => x.status === 'viable'), seenViews = new Map();
  const stepLimit = Number.isSafeInteger(limits.comparison_steps) ? limits.comparison_steps : COMPARISON_STEP_LIMIT;
  for (const x of viable) {
    const view = structuralView(x), same = seenViews.get(view.print) || [];
    for (const other of same) {
      const equal = sameLabelledGraph(other, view, stepLimit);
      if (equal === null) return refused('options-comparison-limit', 'positions[' + positions.indexOf(x) + ']');
      if (equal) return refused('options-positions-identical', 'positions[' + positions.indexOf(x) + ']');
    }
    seenViews.set(view.print, [...same, view]);
  }
  if (proposal.recommended !== null && (!viable.some(x => x.id === proposal.recommended) || !text(proposal.recommendation_reason))) return refused('options-recommendation-invalid', 'recommended');
  return { valid: true };
}
function inspectProposalContent(content, milestone) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_PROPOSAL_BYTES) return refused('options-schema-invalid', '(conteúdo)');
  let value;
  try { value = JSON.parse(content); } catch { return refused('options-schema-invalid', '(json)'); }
  const result = validateProposal(value, milestone);
  return result.valid ? { valid: true, proposal: value } : result;
}
function validateProposalContent(content, milestone) { return inspectProposalContent(content, milestone).valid; }

// ---------------------------------------------------------------------------
// History: bounded, read-only, deterministic
// ---------------------------------------------------------------------------
function emptyPhases() { return Object.fromEntries(MEASURABLE_PHASES.map(p => [p, { n: 0, p50_ms: null, p90_ms: null, min_ms: null, max_ms: null, dispersion: null, sources: [] }])); }
function linkFree(root, relative) {
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') return 'missing'; return 'unreadable'; }
    if (stat.isSymbolicLink()) return 'link';
  }
  return 'ok';
}
function percentile(sorted, q) { return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]; }
// Successful samples come only from action complete. A unit paused and later completed
// contributes the sum of its active segments: the paused gap lies outside every interval.
function samplesOf(read, accept) {
  const result = { samples: Object.create(null), failures: 0, excluded: { open: read.open.length, ambiguous: read.ambiguous.length, unfinished_paused: 0, zero_duration: 0 } };
  const carry = new Map();
  for (const row of [...read.intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!accept(row)) continue;
    const key = JSON.stringify([row.milestone, row.unit, row.host]), duration = row.end - row.start;
    if (row.action === 'pause') { carry.set(key, (carry.get(key) || 0) + duration); continue; }
    const paused = carry.get(key) || 0; carry.delete(key);
    if (row.action !== 'complete') { result.failures++; continue; }
    if (!MEASURABLE_PHASES.includes(row.phase)) continue;
    const total = duration + paused;
    if (total <= 0) { result.excluded.zero_duration++; continue; }
    (result.samples[row.phase] ||= []).push(total);
  }
  result.excluded.unfinished_paused = carry.size;
  return result;
}
function readSource(owner, relative, kind, remaining, accept) {
  const row = { path: relative, kind, status: 'unavailable', reason: null, sha256: null, bytes: null, samples: {}, failures: 0,
    excluded: { open: 0, ambiguous: 0, unfinished_paused: 0, zero_duration: 0 } };
  const links = linkFree(owner, relative);
  if (links !== 'ok') { row.reason = links === 'link' ? 'history-source-link' : links === 'missing' ? 'history-source-missing' : 'history-source-unreadable'; return { row }; }
  const file = path.join(owner, relative), { MAX_BYTES, analyzeEventIntervals } = require('./forge-phase-cost');
  if (MAX_BYTES !== HISTORY_LIMITS.max_source_bytes) fail('history-limits-drift');
  let stat;
  try { stat = fs.lstatSync(file); } catch { row.reason = 'history-source-unreadable'; return { row }; }
  if (!stat.isFile()) { row.reason = 'history-source-not-file'; return { row }; }
  row.bytes = stat.size;
  if (stat.size > MAX_BYTES) { row.reason = 'history-source-too-large'; return { row }; }
  if (stat.size > remaining) { row.reason = 'history-total-limit'; return { row }; }
  let real;
  try { real = fs.realpathSync.native(file); } catch { row.reason = 'history-source-unreadable'; return { row }; }
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, MAX_BYTES, { expectedReal: real });
  if (read.error) { row.reason = read.error === 'source_too_large' ? 'history-source-too-large' : read.error === 'source_changed_during_read' ? 'history-source-unstable' : 'history-source-unreadable'; return { row }; }
  row.bytes = read.buffer.length; row.sha256 = digest(read.buffer);
  let analysis;
  try { analysis = analyzeEventIntervals(read.buffer); } catch (e) { row.reason = 'history-source-invalid'; row.detail = typeof e.code === 'string' && e.code.startsWith('phase-cost-') ? e.code : 'phase-cost-unknown'; return { row, bytes: row.bytes }; }
  const sampled = samplesOf(analysis, accept);
  row.status = 'available'; row.failures = sampled.failures; row.excluded = sampled.excluded;
  row.samples = Object.fromEntries(MEASURABLE_PHASES.filter(p => sampled.samples[p]).map(p => [p, sampled.samples[p].length]));
  return { row, bytes: row.bytes, samples: sampled.samples };
}
function readHistory(options = {}) {
  const milestone = options.milestone;
  if (!milestoneId(milestone)) fail('history-milestone-invalid');
  if (typeof options.cwd !== 'string' || !options.cwd) fail('history-owner-invalid');
  const ids = require('./forge-ids');
  const history = { schema_version: 1, policy: { ...ESTIMATE_POLICY }, limits: { ...HISTORY_LIMITS }, status: 'empty', reason: null, sources: [], omitted_sources: 0,
    total_bytes: 0, observations: 0, failures: 0, excluded: { open: 0, ambiguous: 0, unfinished_paused: 0, zero_duration: 0 }, phases: emptyPhases(), limitations: [] };
  let owner;
  try { owner = fs.realpathSync.native(path.resolve(options.cwd)); if (!fs.statSync(owner).isDirectory()) throw new Error('not-directory'); }
  catch { history.status = 'unavailable'; history.reason = 'history-owner-unreadable'; history.limitations.push('Raiz do owner ilegível: nenhum histórico usado'); return history; }
  const ledger = linkFree(owner, '.gsd/ledger');
  if (ledger === 'link' || linkFree(owner, '.gsd') === 'link') { history.status = 'unavailable'; history.reason = 'history-link-refused'; history.limitations.push('Link recusado no caminho do histórico'); return history; }
  let names = [];
  if (ledger === 'ok') {
    try { names = fs.readdirSync(path.join(owner, '.gsd/ledger')); } catch { history.status = 'unavailable'; history.reason = 'history-ledger-unreadable'; return history; }
  }
  // Closed milestones: one regular ledger fragment per milestone, never the current one.
  const closed = names.filter(name => name.endsWith('.md')).map(name => name.slice(0, -3))
    .filter(m => m !== milestone && milestoneId(m) && ids.entityKind(m) === 'milestone' && (() => {
      try { const s = fs.lstatSync(path.join(owner, '.gsd/ledger', m + '.md')); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
    })()).sort().reverse();
  const candidates = closed.map(m => ({ relative: '.gsd/milestones/' + m + '/' + m + '-events.jsonl', kind: 'milestone', accept: row => row.milestone === m }));
  // The shared controller file is only a task candidate within the canonical limit.
  if (fs.existsSync(path.join(owner, '.gsd/forge/events.jsonl')) || linkFree(owner, '.gsd/forge/events.jsonl') === 'link') {
    candidates.push({ relative: '.gsd/forge/events.jsonl', kind: 'shared-tasks', accept: row => row.milestone !== milestone && ids.entityKind(row.milestone) === 'task' && ids.isValid(row.milestone) });
  }
  history.omitted_sources = Math.max(0, candidates.length - HISTORY_LIMITS.max_sources);
  const pooled = Object.create(null), contributors = Object.create(null);
  for (const candidate of candidates.slice(0, HISTORY_LIMITS.max_sources)) {
    const read = readSource(owner, candidate.relative, candidate.kind, HISTORY_LIMITS.max_total_bytes - history.total_bytes, candidate.accept);
    history.sources.push(read.row);
    if (read.bytes) history.total_bytes += read.bytes;
    if (read.row.status !== 'available') continue;
    history.failures += read.row.failures;
    for (const k of Object.keys(history.excluded)) history.excluded[k] += read.row.excluded[k];
    for (const [phase, list] of Object.entries(read.samples)) { (pooled[phase] ||= []).push(...list); (contributors[phase] ||= []).push(candidate.relative); }
  }
  for (const phase of MEASURABLE_PHASES) {
    const list = (pooled[phase] || []).slice().sort((a, b) => a - b);
    if (!list.length) continue;
    const p50 = percentile(list, 0.5), p90 = percentile(list, 0.9);
    history.phases[phase] = { n: list.length, p50_ms: p50, p90_ms: p90, min_ms: list[0], max_ms: list[list.length - 1],
      dispersion: list.length >= 2 ? Math.round(p90 / p50 * 1000) / 1000 : null, sources: contributors[phase] };
    history.observations += list.length;
  }
  const unavailable = history.sources.filter(s => s.status !== 'available');
  history.status = history.observations ? 'available' : unavailable.length ? 'unavailable' : 'empty';
  if (!history.observations) history.limitations.push('Histórico sem amostras: só julgamento rotulado pode dar números, com confiança baixa');
  if (unavailable.length) history.limitations.push(unavailable.length + ' fonte(s) indisponível(is) com motivo; nada foi truncado nem zerado');
  if (history.omitted_sources) history.limitations.push(history.omitted_sources + ' fonte(s) além do limite de fontes não lida(s)');
  history.limitations.push('Intervalos do controller incluem trabalho do owner; consumo não é tempo de parede');
  history.limitations.push('Só lacunas de pausa explícita são excluídas; esperas sem classificação (humana, CI, externa) seguem nas amostras e são desconhecidas');
  return history;
}

// ---------------------------------------------------------------------------
// Estimator v1
// ---------------------------------------------------------------------------
function historyPhases(history) { return object(history) && object(history.phases) ? history.phases : {}; }
function nodeCost(node, phases) {
  const entries = Object.entries(node.phases), stats = entries.map(([p, count]) => ({ p, count, s: object(phases[p]) ? phases[p] : { n: 0 } }));
  const complete = entries.length > 0 && stats.every(x => Number.isSafeInteger(x.s.n) && x.s.n >= 1 && ms(x.s.p50_ms) && ms(x.s.p90_ms));
  const calibrated = complete && stats.every(x => x.s.n >= CALIBRATED_SAMPLES);
  const judgment = node.judgment, range = judgment && Object.hasOwn(judgment, 'low_ms') ? judgment : null, factor = judgment && Object.hasOwn(judgment, 'factor_low') ? judgment : null;
  const minSamples = entries.length ? Math.min(...stats.map(x => Number.isSafeInteger(x.s.n) ? x.s.n : 0)) : 0;
  const fromHistory = confidence => {
    let low = stats.reduce((t, x) => safe(t + safe(x.count * x.s.p50_ms, node.id), node.id), 0), high = stats.reduce((t, x) => safe(t + safe(x.count * x.s.p90_ms, node.id), node.id), 0);
    if (factor) { low = safe(Math.round(low * factor.factor_low), node.id); high = safe(Math.round(high * factor.factor_high), node.id); }
    return { id: node.id, basis: 'history', low_ms: low, high_ms: high, confidence, min_samples: minSamples, factor: factor ? { low: factor.factor_low, high: factor.factor_high, reason: factor.reason } : null,
      reason: 'Contagens de fase × p50/p90 do histórico' + (factor ? ' com fator rotulado' : ''), sources: [...new Set(stats.flatMap(x => x.s.sources || []))].sort() };
  };
  if (calibrated) return fromHistory('medium');
  // A TOTAL-duration judgment replaces unmeasured phases; it is never added to them.
  if (range) return { id: node.id, basis: 'judgment', low_ms: range.low_ms, high_ms: range.high_ms, confidence: 'low', min_samples: minSamples, factor: null, reason: range.reason, sources: [...range.sources] };
  if (complete) return fromHistory('low');
  const missing = stats.filter(x => !(x.s.n >= 1)).map(x => x.p);
  return { id: node.id, basis: 'unknown', low_ms: null, high_ms: null, confidence: null, min_samples: minSamples, factor: null,
    reason: factor ? 'Fator rotulado sem base de duração' : 'Sem amostras para ' + (missing.join(', ') || 'nenhuma fase') + ' e sem julgamento', sources: [] };
}
// Longest dependency path; informative only, never credited against the serial sum.
function criticalPath(nodes, edges, key) {
  const deps = new Map(nodes.map(n => [n.id, []])), cost = new Map(nodes.map(n => [n.id, n[key]])), memo = new Map();
  for (const e of edges) if (deps.has(e.from) && deps.has(e.to)) deps.get(e.from).push(e.to);
  const visit = idv => {
    if (memo.has(idv)) return memo.get(idv);
    let best = { total: 0, path: [] };
    for (const d of [...deps.get(idv)].sort()) { const r = visit(d); if (r.total > best.total) best = r; }
    const result = { total: safe(best.total + cost.get(idv), idv), path: [...best.path, idv] }; memo.set(idv, result); return result;
  };
  let best = { total: 0, path: [] };
  for (const n of [...nodes].sort((a, b) => a.id < b.id ? -1 : 1)) { const r = visit(n.id); if (r.total > best.total) best = r; }
  return best;
}
function sideEstimate(costs, edges) {
  const unknown = costs.filter(c => c.basis === 'unknown');
  if (!costs.length) return { status: 'empty', low_ms: null, high_ms: null, ceiling_ms: null, confidence: null, critical_path: null, insufficient: [] };
  if (unknown.length) return { status: 'evidence-insufficient', low_ms: null, high_ms: null, ceiling_ms: null, confidence: null, critical_path: null, insufficient: unknown.map(c => c.id) };
  const low = costs.reduce((t, c) => safe(t + c.low_ms, c.id), 0), high = costs.reduce((t, c) => safe(t + c.high_ms, c.id), 0);
  const pathLow = criticalPath(costs, edges, 'low_ms'), pathHigh = criticalPath(costs, edges, 'high_ms');
  return { status: 'estimated', low_ms: low, high_ms: high, ceiling_ms: high, confidence: costs.every(c => c.confidence === 'medium') ? 'medium' : 'low',
    critical_path: { label: 'caminho crítico do DAG (informativo, sem crédito)', low_ms: pathLow.total, high_ms: pathHigh.total, nodes: pathHigh.path }, insufficient: [] };
}
function estimatePosition(position, phases) {
  // linked_task_horizon keeps exactly the contract horizon keys; its status is a sibling field.
  const nullHorizon = { low_ms: null, high_ms: null, ceiling_ms: null };
  const base = { position_id: position.id, status: 'infeasible', low_ms: null, high_ms: null, confidence: null, ceiling_ms: null,
    linked_task_horizon: position.linked_task === null ? null : nullHorizon, linked_task_status: position.linked_task === null ? null : 'not-estimated', chain: null };
  if (position.status === 'infeasible') return { ...base, reason: position.reason, nodes: [], serial_sum: null, critical_path: null, coverage: null, parallel: null, uncertainty: null };
  const partition = partitionOf(position);
  if (partition.status !== 'valid') fail('options-graph-invalid');
  const { part } = partition, costs = position.nodes.map(n => nodeCost(n, phases));
  const side = n => part.scope.has(n.id) ? 'milestone' : part.moved.includes(n.id) ? 'task' : 'deferred';
  const milestoneCosts = costs.filter((c, i) => side(position.nodes[i]) === 'milestone'), taskCosts = costs.filter((c, i) => side(position.nodes[i]) === 'task');
  const m = sideEstimate(milestoneCosts, part.edges), t = position.linked_task === null ? null : sideEstimate(taskCosts, partition.graph.edges.filter(e => part.moved.includes(e.from) && part.moved.includes(e.to)));
  const covered = kind => position.nodes.some((n, i) => side(n) === 'milestone' && n.kind === kind && costs[i].basis !== 'unknown');
  const used = costs.filter(c => c.basis === 'history');
  const dispersions = Object.entries(phases).filter(([p, s]) => used.length && position.nodes.some(n => Object.hasOwn(n.phases, p)) && object(s) && typeof s.dispersion === 'number').map(([, s]) => s.dispersion);
  const chain = t && m.status === 'estimated' && t.status === 'estimated'
    ? { label: 'cadeia milestone + task ligada (não reduz o total)', basis: 'milestone-plus-linked-task', low_ms: safe(m.low_ms + t.low_ms, 'chain'), high_ms: safe(m.high_ms + t.high_ms, 'chain') } : null;
  return { position_id: position.id, status: m.status === 'estimated' ? 'estimated' : 'evidence-insufficient', low_ms: m.low_ms, high_ms: m.high_ms, confidence: m.confidence, ceiling_ms: m.ceiling_ms,
    linked_task_horizon: t === null ? null : { low_ms: t.low_ms, high_ms: t.high_ms, ceiling_ms: t.ceiling_ms }, linked_task_status: t === null ? null : t.status,
    chain, reason: m.status === 'estimated' ? 'Soma serial dos nós do lado da milestone; teto proposto = topo da faixa defensável' : 'Evidência insuficiente: ' + m.insufficient.join(', '),
    nodes: costs.map((c, i) => ({ ...c, side: side(position.nodes[i]) })),
    serial_sum: m.status === 'estimated' ? { label: 'soma serial sem crédito de paralelismo', low_ms: m.low_ms, high_ms: m.high_ms } : null,
    critical_path: m.critical_path,
    coverage: Object.fromEntries(GATE_KINDS.map(k => [k, covered(k)])),
    parallel: { declared_groups: position.parallel_groups.length, credited_ms: 0, reason: 'Sem claims, isolamento, transporte e capacidade reais antes do plano das slices' },
    uncertainty: { min_samples: used.length ? Math.min(...used.map(c => c.min_samples)) : 0, ratio_samples: dispersions.length, max_dispersion: dispersions.length ? Math.max(...dispersions) : null,
      judgment_nodes: costs.filter(c => c.basis === 'judgment').map(c => c.id), insufficient_nodes: costs.filter(c => c.basis === 'unknown').map(c => c.id),
      factor_nodes: costs.filter(c => c.factor).map(c => c.id) } };
}
function estimate(proposal, history) {
  const checked = validateProposal(proposal);
  if (!checked.valid) fail(checked.reason, checked.path);
  const phases = historyPhases(history);
  return { policy: { ...ESTIMATE_POLICY }, thresholds: { calibrated_samples: CALIBRATED_SAMPLES, factor_min: FACTOR_MIN, factor_max: FACTOR_MAX },
    history: { status: object(history) && typeof history.status === 'string' ? history.status : 'empty', observations: object(history) && Number.isSafeInteger(history.observations) ? history.observations : 0 },
    interpretation: 'Consumo de trabalho e coordenação identificáveis; não é tempo de parede',
    overhead: { coordination: 'incluída nos intervalos do controller', waits: { pause: 'excluída somente quando há pausa explícita registrada', human: 'não separada por esta evidência: desconhecida, pode permanecer na amostra',
      ci: 'não separada por esta evidência: desconhecida, pode permanecer na amostra', external: 'não separada por esta evidência: desconhecida, pode permanecer na amostra',
      unclassified: 'sem classificação: desconhecida, pode permanecer na amostra' }, unknown: 'explícito, sem duração inventada' },
    positions: proposal.positions.map(x => estimatePosition(x, phases)) };
}

// ---------------------------------------------------------------------------
// Owner materialization
// ---------------------------------------------------------------------------
function relativePath(v) {
  return text(v, 512) && !path.isAbsolute(v) && !/^[a-zA-Z]:/.test(v) && !v.includes('\\') && !v.split('/').some(p => p === '..' || p === '') && isPublicData(v);
}
function inputsValid(v) {
  const files = list => Array.isArray(list) && list.length <= MAX_INPUT_FILES && list.every(f => exact(f, ['path', 'sha256']) && relativePath(f.path) && hash(f.sha256))
    && new Set(list.map(f => f.path)).size === list.length;
  return exact(v, ['documents', 'code_root', 'code_files']) && files(v.documents) && v.documents.length > 0 && files(v.code_files)
    && exact(v.code_root, ['identity_sha256', 'revision', 'workspace']) && hash(v.code_root.identity_sha256) && text(v.code_root.revision, 200) && text(v.code_root.workspace, 200)
    && isPublicData(v);
}
function historyValid(v) {
  return object(v) && v.schema_version === 1 && Array.isArray(v.sources) && v.sources.length <= HISTORY_LIMITS.max_sources && object(v.phases)
    && Object.keys(v.phases).every(p => MEASURABLE_PHASES.includes(p)) && isPublicData(v);
}
function materialize(options = {}) {
  const { milestone, proposal, inputs, producer_basis: producer, history, now } = options;
  if (!milestoneId(milestone)) fail('options-milestone-mismatch');
  const checked = validateProposal(proposal, milestone);
  if (!checked.valid) fail(checked.reason, checked.path);
  // Inputs and producer identity are captured by the owner; the worker proposal carries none of them.
  if (!inputsValid(inputs)) fail('options-inputs-invalid');
  if (!exact(producer, ['producer', 'identity_sha256', 'frozen_at']) || !id(producer.producer) || !hash(producer.identity_sha256) || !instant(producer.frozen_at)) fail('options-producer-invalid');
  if (!historyValid(history)) fail('options-history-invalid');
  if (!Number.isSafeInteger(now) || now < 0) fail('options-instant-invalid');
  const materializedAt = new Date(now).toISOString();
  if (Date.parse(producer.frozen_at) > now) fail('options-producer-invalid');
  const frozenProposal = canonical(structuredClone(proposal)), frozenInputs = canonical(structuredClone(inputs)), frozenHistory = canonical(structuredClone(history));
  const record = canonical({ schema_version: 1, milestone, materialized_at: materializedAt, proposal: frozenProposal, proposal_sha256: digest(frozenProposal),
    policy: { ...ESTIMATE_POLICY }, estimate: estimate(frozenProposal, frozenHistory), inputs: frozenInputs, history: frozenHistory,
    producer_basis: { producer: producer.producer, identity_sha256: producer.identity_sha256, frozen_at: producer.frozen_at, frozen_before: 'begin', attested: false,
      inputs_fingerprint_sha256: digest(frozenInputs), history_fingerprint_sha256: digest(frozenHistory) } });
  if (!isPublicData(record)) fail('options-record-not-public');
  const bytes = Buffer.byteLength(JSON.stringify(record) + '\n');
  if (bytes > MAX_RECORD_BYTES) fail('options-record-too-large');
  return { record, options_sha256: digest(record), proposal_sha256: record.proposal_sha256, bytes };
}
// A relevant code/document change before the choice invalidates the proposal; after
// the choice, legitimate change never erases the chosen history.
function inputsFreshness(record, current, options = {}) {
  if (!object(record) || !inputsValid(record.inputs)) fail('options-inputs-invalid');
  if (options.selected === true) return { status: 'historical', changed: [] };
  if (!inputsValid(current)) fail('options-inputs-invalid');
  const changed = [];
  if (digest(canonical(record.inputs.code_root)) !== digest(canonical(current.code_root))) changed.push('code_root');
  for (const k of ['documents', 'code_files']) {
    const before = new Map(record.inputs[k].map(f => [f.path, f.sha256])), after = new Map(current[k].map(f => [f.path, f.sha256]));
    for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) if (before.get(p) !== after.get(p)) changed.push(k + ':' + p);
  }
  return { status: changed.length ? 'stale' : 'fresh', changed };
}

// ---------------------------------------------------------------------------
// pt-BR render
// ---------------------------------------------------------------------------
function formatDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'desconhecido';
  if (value < 60000) return Math.round(value / 1000) + ' s';
  const minutes = Math.round(value / 60000), d = Math.floor(minutes / 1440), h = Math.floor(minutes % 1440 / 60), m = minutes % 60;
  return [d && d + ' d', h && h + ' h', m && m + ' min'].filter(Boolean).join(' ') || '0 min';
}
function rangeText(low, high) { return ms(low) && ms(high) ? formatDuration(low) + ' a ' + formatDuration(high) : '—'; }
// Compact, explicitly labelled form for the bounded round descriptions: one largest whole unit, "≈" when rounded; the exact values stay in the immutable record.
function compactDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'desconhecido';
  const [unit, size] = [['d', 86400000], ['h', 3600000], ['min', 60000], ['s', 1000]].find(([, n]) => value >= n) || ['ms', 1];
  return (value % size ? '≈' : '') + Math.round(value / size) + ' ' + unit;
}
function compactRange(low, high) { return ms(low) && ms(high) ? compactDuration(low) + ' a ' + compactDuration(high) : '—'; }
const ITEM_LABELS = { publication: 'Publicação', installation: 'Instalação', 'manual-uat': 'UAT manual', 'external-waits': 'Esperas externas' };
const STATE_LABELS = { included: 'incluído', pending: 'pendente', deferred: 'adiado', 'not-applicable': 'não se aplica', completed: 'concluído' };
const KIND_LABELS = { preparation: 'preparação', slice: 'fatia', integration: 'integração', review: 'revisão', corrections: 'correções' };
const AUTH_LABELS = { 'create-and-start-after-proven-completion': 'Criar e iniciar após prova', 'create-without-auto-start': 'Criar sem iniciar', none: 'Não criar task' };
function recordView(record) {
  const rt = require('./forge-milestone-roadmap-time');
  if (!object(record) || !object(record.proposal) || !object(record.estimate) || !Array.isArray(record.estimate.positions) || rt.optionsView(record).status !== 'valid') fail('options-record-invalid');
  const checked = validateProposal(record.proposal, record.milestone);
  if (!checked.valid) fail('options-record-invalid');
  return { sha: digest(record), positions: record.proposal.positions.map(p => ({ p, e: record.estimate.positions.find(x => x.position_id === p.id) })) };
}
function renderOptionsMarkdown(record) {
  const { sha, positions } = recordView(record), proposal = record.proposal, out = [];
  const bullet = list => list.length ? list.map(x => '  - ' + x) : ['  - (nenhum)'];
  out.push('# Opções de prazo — ' + record.milestone, '',
    '- Registro: `' + sha + '`; proposta `' + record.proposal_sha256 + '`; política ' + record.policy.id + ' v' + record.policy.version + '.',
    '- Materializado em ' + record.materialized_at + '; produtor `' + record.producer_basis.producer + '` congelado antes do início (' + record.producer_basis.frozen_at + '), sem atestação pelo worker.',
    proposal.recommended ? '- Recomendação: ' + proposal.recommended + ' — ' + proposal.recommendation_reason + ' (nenhuma opção vem pré-selecionada).' : '- Sem recomendação; nenhuma opção vem pré-selecionada.',
    '- Números: consumo de trabalho e coordenação identificáveis, não tempo de parede; só pausas explicitamente registradas ficam fora; esperas humanas, de CI, externas ou sem classificação não são separadas por esta evidência (desconhecidas) e podem permanecer nas amostras; overhead desconhecido fica explícito.', '',
    '## Marco final (entrega verificada e integrada)', '');
  for (const k of Object.keys(ITEM_LABELS)) out.push('- ' + ITEM_LABELS[k] + ': ' + (STATE_LABELS[proposal.endpoint.items[k]] || proposal.endpoint.items[k]));
  const h = record.history;
  out.push('', '## Histórico usado', '', '- Situação: ' + h.status + '; amostras: ' + (h.observations || 0) + '; fontes lidas: ' + h.sources.filter(s => s.status === 'available').length
    + '; indisponíveis: ' + h.sources.filter(s => s.status !== 'available').length + '; fora do limite: ' + (h.omitted_sources || 0) + '.');
  for (const s of h.sources) out.push('- Fonte `' + s.path + '`: ' + (s.status === 'available' ? 'sha256 ' + s.sha256.slice(0, 12) + ', ' + s.bytes + ' bytes, amostras '
    + (Object.entries(s.samples).map(([p, n]) => p + '=' + n).join(', ') || 'nenhuma') : 'indisponível (' + s.reason + ')'));
  for (const p of MEASURABLE_PHASES) {
    const s = h.phases[p];
    if (s && s.n) out.push('- Fase ' + p + ': n=' + s.n + ', p50 ' + formatDuration(s.p50_ms) + ', p90 ' + formatDuration(s.p90_ms) + ', dispersão ' + (s.dispersion ?? '—') + '.');
  }
  for (const l of h.limitations || []) out.push('- Limitação: ' + l);
  for (const id of POSITION_IDS) {
    const { p, e } = positions.find(x => x.p.id === id);
    out.push('', '## Posição ' + p.id + ' — ' + p.label, '');
    if (p.status === 'infeasible') { out.push('- Situação: inviável — ' + p.reason, '- Sem números: posição inviável não recebe faixa nem teto.'); continue; }
    out.push('- Estratégia: ' + p.strategy, '- Escolhas técnicas:', ...bullet(p.technical_choices), '- Entregas:', ...bullet(p.deliverables), '- Divisão preliminar:');
    for (const [i, n] of p.nodes.entries()) {
      const c = e.nodes[i], basis = c.basis === 'history' ? 'histórico (' + c.min_samples + ' amostras mín.; fontes ' + (c.sources.join(', ') || '—') + ')' + (c.factor ? '; fator rotulado ' + c.factor.low + '–' + c.factor.high + ': ' + c.factor.reason : '')
        : c.basis === 'judgment' ? 'julgamento rotulado: ' + c.reason + ' (fontes ' + c.sources.join(', ') + ')' : 'evidência insuficiente: ' + c.reason;
      out.push('  - `' + n.id + '` ' + (KIND_LABELS[n.kind] || n.kind) + ' — ' + n.title + ' [' + c.side + ']; fases ' + Object.entries(n.phases).map(([k, v]) => k + '×' + v).join(', ')
        + '; depende de ' + (n.depends.join(', ') || 'nada') + '; ' + (c.basis === 'unknown' ? '' : rangeText(c.low_ms, c.high_ms) + ' por ') + basis);
    }
    out.push('- Caminho crítico: ' + (e.critical_path ? e.critical_path.nodes.join(' → ') + ' (' + rangeText(e.critical_path.low_ms, e.critical_path.high_ms) + '; informativo)' : 'desconhecido'));
    out.push('- Paralelismo declarado: ' + (p.parallel_groups.map(g => g.nodes.join(' ∥ ') + ' (' + g.independence + '; ' + g.isolation + ')').join('; ') || 'nenhum')
      + '. Crédito: nenhum — ' + e.parallel.reason + '.');
    out.push('- Verificações:', ...bullet(p.verifications), '- Revisão:', ...bullet(p.review));
    const corrections = e.nodes.filter((c, i) => p.nodes[i].kind === 'corrections' && c.side === 'milestone');
    out.push('- Margem de correção: ' + (corrections.map(c => c.id + ' ' + rangeText(c.low_ms, c.high_ms)).join('; ') || 'desconhecida'));
    out.push('- Riscos:', ...bullet(p.risks), '- Incertezas:', ...bullet(p.uncertainties),
      '  - Amostras mínimas ' + e.uncertainty.min_samples + '; amostras da razão ' + e.uncertainty.ratio_samples + '; dispersão máx. ' + (e.uncertainty.max_dispersion ?? '—')
      + '; nós de julgamento ' + (e.uncertainty.judgment_nodes.join(', ') || 'nenhum') + '; insuficiências ' + (e.uncertainty.insufficient_nodes.join(', ') || 'nenhuma') + '.');
    out.push('- Adiamentos:', ...bullet(p.deferrals.map(d => d.scope_item + ': ' + d.reason + ' (consentimento explícito exigido)')));
    if (p.linked_task) {
      const t = p.linked_task, th = e.linked_task_horizon;
      out.push('- Task ligada:', '  - Escopo movido: ' + t.moved_scope.join(', ') + ' (nós ' + t.nodes.join(', ') + ')',
        '  - Critérios da milestone: ' + t.criteria.milestone.join('; '), '  - Critérios da task: ' + t.criteria.task.join('; '),
        '  - Horizonte da task: ' + (e.linked_task_status === 'estimated' ? rangeText(th.low_ms, th.high_ms) + '; teto ' + formatDuration(th.ceiling_ms) : 'evidência insuficiente, sem número'),
        '  - Previsão da cadeia (milestone + task, não reduz o total): ' + (e.chain ? rangeText(e.chain.low_ms, e.chain.high_ms) : 'desconhecida'),
        '  - Autorizações: ' + LINKED_TASK_AUTHORIZATIONS.map(a => AUTH_LABELS[a]).join('; ') + '. Não criar a task não apaga o escopo movido.');
    }
    if (e.status === 'estimated') {
      out.push('- Previsão (' + e.serial_sum.label + '): ' + rangeText(e.low_ms, e.high_ms) + '; teto proposto ' + formatDuration(e.ceiling_ms) + ' (topo da faixa defensável); confiança ' + (e.confidence === 'medium' ? 'média' : 'baixa') + '.');
    } else out.push('- Previsão: evidência insuficiente — ' + e.reason + '. Sem número; só um teto próprio com esta estratégia ou reestimativa.');
  }
  const markdown = out.join('\n') + '\n';
  if (/(?:^|[\s(`'"])(?:[a-zA-Z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|etc)\/)/.test(markdown)) fail('options-render-path');
  return markdown;
}

// ---------------------------------------------------------------------------
// Decision rounds
// ---------------------------------------------------------------------------
function parseOperatorCeiling(value) {
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d{0,14})(m|h|d)?$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]), result = n * ({ m: 60000, h: 3600000, d: 86400000 }[match[2]] || 1);
  return Number.isSafeInteger(result) && result >= MIN_CEILING_MS && result <= MAX_CEILING_MS ? result : null;
}
function bounded(s, max) { if (Array.from(s).length > max) fail('options-round-text-too-long'); return s; }
// A description keeps its full wording when it fits; otherwise the same text is rebuilt with compact labelled durations, never truncated and never without a horizon.
function fit(build) { const full = build(false); return Array.from(full).length <= 240 ? full : build(true); }
function horizonsText(e, compact = false) {
  const range = compact ? compactRange : rangeText;
  if (!e || e.status === 'infeasible') return 'milestone —; task —; cadeia —';
  const t = e.linked_task_horizon;
  return 'milestone ' + range(e.low_ms, e.high_ms) + '; task ' + (t ? range(t.low_ms, t.high_ms) : '—') + '; cadeia ' + (e.chain ? range(e.chain.low_ms, e.chain.high_ms) : '—');
}
function optionLabel(p) { return p.label + ' (' + p.id + ')'; }
// A linked position can only activate a contract when its task horizon is estimated (T01 horizonValid); the chain stays null while the milestone is unknown.
function linkedHorizonKnown(x) {
  if (x.p.linked_task === null) return true;
  const h = x.e.linked_task_horizon;
  return x.e.linked_task_status === 'estimated' && !!h && ms(h.low_ms) && ms(h.high_ms) && ms(h.ceiling_ms) && h.low_ms <= h.high_ms && h.high_ms <= h.ceiling_ms;
}
function roundsContext(record) {
  const { sha, positions } = recordView(record);
  const viable = positions.filter(x => x.p.status === 'viable');
  return { sha, suffix: sha.slice(0, 12), viable, offered: viable.filter(x => x.e.status === 'estimated' && ms(x.e.ceiling_ms) && linkedHorizonKnown(x)), recommended: record.proposal.recommended };
}
// Bounded display of the moved scope; the exact IDs stay in the structured round data and in the immutable record.
function scopeSummary(ctx, x) {
  const n = x.p.linked_task.moved_scope.length;
  return n + ' ite' + (n === 1 ? 'm' : 'ns') + ' (IDs completos em linked_task.moved_scope da posição ' + x.p.id + ', registro ' + ctx.suffix + ')';
}
function scopeData(ctx, x) { return { options_sha256: ctx.sha, position_id: x.p.id, moved_scope: [...x.p.linked_task.moved_scope] }; }
function makeRound(ctx, type, fields) {
  const round = { id: 'time-' + type + '-' + ctx.suffix, type, decision_set: ['linked', 'scope'].includes(type) ? 'milestone-time-linked-task' : 'milestone-time-activation',
    header: bounded(fields.header, 12), question: bounded(fields.question, 240), options: fields.options.map(o => ({ label: bounded(o.label, 80), description: bounded(o.description, 240), answer: o.answer })) };
  const rec = fields.options.find(o => o.answer === 'option:' + ctx.recommended);
  if (rec) round.recommended = rec.label;
  if (fields.scope) round.scope = fields.scope;
  if (fields.free_text) Object.assign(round, { free_text: true, answer_format: 'operator-ceiling:<ms>', position_id: fields.position_id, minimum_ms: fields.minimum_ms });
  return round;
}
const NO_CONTRACT = { label: 'Sem contrato', description: 'Segue sem contrato de tempo; nada é ativado. Horizontes: milestone —; task —; cadeia —.', answer: 'no-contract' };
const RE_ESTIMATE = { label: 'Reestimar', description: 'Pede nova estimativa com escopo completo antes de qualquer teto; nada é ativado. Horizontes: milestone —; task —; cadeia —.', answer: 're-estimate' };
function positionOption(x, consequence) { return { label: optionLabel(x.p), description: fit(c => (typeof consequence === 'function' ? consequence(c) : consequence) + ' Horizontes: ' + horizonsText(x.e, c) + '.'), answer: 'option:' + x.p.id }; }
function offeredConsequence(x) { return c => 'Ativa contrato com o teto proposto ' + (c ? compactDuration : formatDuration)(x.e.ceiling_ms) + '.'; }
function compactOrFull(value) { const full = formatDuration(value); return Array.from(full).length <= 40 ? full : compactDuration(value); }
function modeRound(ctx) {
  if (!ctx.viable.length) {
    return makeRound(ctx, 'mode', { header: 'Prazo', question: 'Nenhuma posição é viável no limite explícito da proposta. Como seguir?', options: [RE_ESTIMATE, NO_CONTRACT] });
  }
  const ceiling = { label: 'Teto próprio', description: fit(c => ctx.viable.length === 1
    ? 'Mantém a estratégia ' + ctx.viable[0].p.id + ', o DAG e o escopo; você informa o teto. Horizontes: ' + horizonsText(ctx.viable[0].e, c) + '.'
    : 'Escolhe uma estratégia viável e depois o teto; DAG e escopo ficam iguais. Horizontes da milestone: ' + ctx.viable.map(x => x.p.id + ' ' + (c ? compactRange : rangeText)(x.e.low_ms, x.e.high_ms)).join('; ') + '.'), answer: 'mode:operator-ceiling' };
  const first = ctx.offered.length >= 2 && ctx.viable.length >= 2
    ? { label: 'Escolher posição', description: fit(c => 'Escolhe uma das ' + ctx.offered.length + ' posições com teto proposto. Horizontes da milestone: ' + ctx.offered.map(x => x.p.id + ' ' + (c ? compactRange : rangeText)(x.e.low_ms, x.e.high_ms)).join('; ') + '.'), answer: 'mode:position' }
    : ctx.offered.length === 1 ? positionOption(ctx.offered[0], offeredConsequence(ctx.offered[0])) : RE_ESTIMATE;
  return makeRound(ctx, 'mode', { header: 'Prazo', question: 'Como definir o prazo desta milestone? A recomendação, se houver, não vem pré-selecionada.', options: [first, ceiling, NO_CONTRACT] });
}
function positionRound(ctx) {
  return makeRound(ctx, 'position', { header: 'Posição', question: 'Qual posição ativa o contrato com o teto proposto?', options: ctx.offered.map(x => positionOption(x, offeredConsequence(x))) });
}
function strategyRound(ctx) {
  return makeRound(ctx, 'strategy', { header: 'Estratégia', question: 'Qual estratégia viável o teto próprio vai manter (posição, DAG e escopo)?',
    options: ctx.viable.map(x => positionOption(x, 'Mantém esta estratégia; o teto vem a seguir.')) });
}
function ceilingRound(ctx, x) {
  const minimum = x.e.status === 'estimated' && ms(x.e.high_ms) ? x.e.high_ms : null;
  return makeRound(ctx, 'ceiling', { header: 'Teto próprio', free_text: true, position_id: x.p.id, minimum_ms: minimum, options: [],
    question: 'Informe o teto próprio para a posição ' + x.p.id + ' (ex.: 90m, 6h, 2d ou ms).' + (minimum ? ' Mínimo: ' + compactOrFull(minimum) + '.' : ' A previsão segue desconhecida.') });
}
function linkedRound(ctx, x) {
  const horizons = c => ' Horizontes: ' + horizonsText(x.e, c) + '.';
  const options = [
    { label: AUTH_LABELS['create-and-start-after-proven-completion'], description: fit(c => 'Cria a task ligada e a inicia só após a conclusão provada da milestone.' + horizons(c)), answer: 'linked-task:create-and-start-after-proven-completion' },
    { label: AUTH_LABELS['create-without-auto-start'], description: fit(c => 'Cria a task ligada sem início automático.' + horizons(c)), answer: 'linked-task:create-without-auto-start' },
    { label: AUTH_LABELS.none, description: fit(c => 'Não cria a task; o escopo movido segue exigindo escopo completo, reestimativa ou consentimento à redução. Horizontes: milestone ' + (c ? compactRange : rangeText)(x.e.low_ms, x.e.high_ms) + '; task —; cadeia —.'), answer: 'linked-task:none' }];
  return makeRound(ctx, 'linked', { header: 'Task ligada', question: 'A posição ' + x.p.id + ' move ' + scopeSummary(ctx, x) + ' para uma task ligada. Qual autorização?', scope: scopeData(ctx, x), options });
}
function scopeRound(ctx, x) {
  const items = x.p.linked_task.moved_scope;
  return makeRound(ctx, 'scope', { header: 'Escopo', question: 'Sem task ligada, o escopo movido (' + scopeSummary(ctx, x) + ') não pode sumir. Como seguir?', scope: scopeData(ctx, x), options: [
    { label: 'Reestimar escopo completo', description: 'Pede nova estimativa com o escopo movido de volta à milestone; nada é ativado. Horizontes: milestone —; task —; cadeia —.', answer: 're-estimate' },
    { label: 'Consentir na redução', description: 'Consente explicitamente adiar ' + scopeSummary(ctx, x) + '; exige nova estimativa sem esses itens. Horizontes: milestone —; task —; cadeia —.', answer: 'reduce-scope:' + items.join(',') },
    NO_CONTRACT] });
}
function acceptedAnswer(round, answered) {
  const value = answered[round.id];
  if (value === undefined) return { value: null };
  if (round.free_text) {
    const m = typeof value === 'string' && /^operator-ceiling:(\d+)$/.exec(value), n = m ? Number(m[1]) : NaN;
    if (!m || !Number.isSafeInteger(n) || n < MIN_CEILING_MS || n > MAX_CEILING_MS) return { value: null, invalid: 'answer-not-offered' };
    if (round.minimum_ms && n < round.minimum_ms) return { value: null, invalid: 'operator-ceiling-incompatible' };
    return { value };
  }
  return round.options.some(o => o.answer === value) ? { value } : { value: null, invalid: 'answer-not-offered' };
}
// Pure: the next round, or the outcome once every required round is answered.
function selectionRounds(record, answered = {}) {
  if (!object(answered)) fail('options-answers-invalid');
  const ctx = roundsContext(record), decisions = [];
  const ask = round => { const r = acceptedAnswer(round, answered); if (r.value === null) return { round: r.invalid ? { ...round, invalid_answer: r.invalid } : round }; decisions.push({ round_id: round.id, type: round.type, decision_set: round.decision_set, answer: r.value }); return { value: r.value }; };
  const done = (choice, extra = {}) => ({ done: true, choice, options_sha256: ctx.sha, option_id: null, position_id: null, ceiling: null, activation_answer: choice === 'no-contract' ? 'no-contract' : null,
    linked_task_authorization: null, scope_reduction: null, decisions, ...extra });
  let step = ask(modeRound(ctx));
  if (step.round) return step.round;
  let answer = step.value, chosen = null, ceiling = null, activation = null;
  if (answer === 'no-contract') return done('no-contract');
  if (answer === 're-estimate') return done('re-estimate');
  if (answer === 'mode:position') {
    step = ask(positionRound(ctx)); if (step.round) return step.round; answer = step.value;
  }
  if (answer.startsWith('option:')) {
    chosen = ctx.offered.find(x => 'option:' + x.p.id === answer);
    ceiling = { source: 'offered', ceiling_ms: chosen.e.ceiling_ms }; activation = answer;
  } else if (answer === 'mode:operator-ceiling') {
    if (ctx.viable.length === 1) chosen = ctx.viable[0];
    else { step = ask(strategyRound(ctx)); if (step.round) return step.round; chosen = ctx.viable.find(x => 'option:' + x.p.id === step.value); }
    // The parser accepts at most 365 days: an estimated upper bound above it leaves no usable custom ceiling, so no number is requested.
    if (chosen.e.status === 'estimated' && ms(chosen.e.high_ms) && chosen.e.high_ms > MAX_CEILING_MS) return done('re-estimate', { option_id: null, position_id: chosen.p.id, reason: 'operator-ceiling-above-maximum' });
    step = ask(ceilingRound(ctx, chosen)); if (step.round) return step.round;
    activation = step.value; ceiling = { source: 'operator', ceiling_ms: Number(step.value.slice('operator-ceiling:'.length)) };
  }
  const base = { option_id: chosen.p.id, position_id: chosen.p.id, ceiling, activation_answer: activation };
  if (chosen.p.linked_task === null) return done('option', base);
  step = ask(linkedRound(ctx, chosen)); if (step.round) return step.round;
  const authorization = step.value.slice('linked-task:'.length);
  if (authorization !== 'none') {
    // The T01 contract needs a positive task horizon and chain; unknown ones are never fabricated nor activated.
    if (!linkedHorizonKnown(chosen)) return done('re-estimate', { position_id: chosen.p.id, linked_task_authorization: authorization, reason: 'linked-task-horizon-unknown' });
    return done('option', { ...base, linked_task_authorization: authorization });
  }
  // Declining the task never removes the moved scope and is not consent to reduce it.
  step = ask(scopeRound(ctx, chosen)); if (step.round) return step.round;
  if (step.value === 'no-contract') return done('no-contract');
  return done('re-estimate', { position_id: chosen.p.id, scope_reduction: step.value === 're-estimate' ? null : { scope_items: [...chosen.p.linked_task.moved_scope], consent: 'explicit' } });
}
// Maps the exact round label (ignoring the "(Recomendado)" suffix) or the free ceiling text to the canonical answer.
function canonicalAnswer(round, response) {
  if (!object(round) || typeof response !== 'string' || !Array.isArray(round.options)) return null;
  if (round.free_text) {
    const value = parseOperatorCeiling(response);
    return value === null || round.minimum_ms && value < round.minimum_ms ? null : 'operator-ceiling:' + value;
  }
  const label = response.trim().replace(/ \(Recomendado\)$/, '');
  const option = round.options.find(o => o.label === label);
  return option ? option.answer : null;
}

// ---------------------------------------------------------------------------
// CLI (read-only)
// ---------------------------------------------------------------------------
function readBounded(file, max) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail('options-file-unreadable'); }
  if (stat.isSymbolicLink()) fail('options-file-link');
  if (!stat.isFile()) fail('options-file-unreadable');
  if (stat.size > max) fail('options-file-too-large');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, max, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail(read.error === 'source_too_large' ? 'options-file-too-large' : 'options-file-unreadable');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(read.buffer); } catch { fail('options-file-encoding'); }
}
function main(argv = process.argv.slice(2), io = process) {
  const json = argv.includes('--json'), options = {};
  let action = null;
  const write = (status, payload, message) => { io.stdout.write(json ? JSON.stringify(payload) + '\n' : message + '\n'); return status; };
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--json') continue;
      if (flag === '--estimate') { if (action) fail('options-usage'); action = flag; continue; }
      if (!['--validate', '--render', '--milestone', '--cwd'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('options-usage');
      if (['--validate', '--render'].includes(flag)) { if (action) fail('options-usage'); action = flag; }
      options[flag.slice(2)] = argv[++i];
    }
    if (action === '--validate') {
      if (!options.milestone || options.cwd) fail('options-usage');
      const result = inspectProposalContent(readBounded(path.resolve(options.validate), MAX_PROPOSAL_BYTES), options.milestone);
      if (!result.valid) return write(3, { status: 'refused', reason: result.reason, path: result.path }, 'Proposta recusada: ' + result.reason + ' em ' + result.path);
      return write(0, { status: 'valid' }, 'Proposta válida.');
    }
    if (action === '--estimate') {
      if (!options.cwd || !options.milestone || !milestoneId(options.milestone)) fail('options-usage');
      const owner = path.resolve(options.cwd), relative = '.gsd/milestones/' + options.milestone + '/' + options.milestone + '-OPTIONS.json';
      if (linkFree(owner, relative) === 'link') fail('options-file-link');
      const result = inspectProposalContent(readBounded(path.join(owner, relative), MAX_PROPOSAL_BYTES), options.milestone);
      if (!result.valid) return write(3, { status: 'refused', reason: result.reason, path: result.path }, 'Proposta recusada: ' + result.reason + ' em ' + result.path);
      const history = readHistory({ cwd: owner, milestone: options.milestone }), preview = estimate(result.proposal, history);
      const lines = preview.positions.map(e => e.position_id + ': ' + (e.status === 'estimated' ? rangeText(e.low_ms, e.high_ms) + ', teto proposto ' + formatDuration(e.ceiling_ms)
        + ', confiança ' + (e.confidence === 'medium' ? 'média' : 'baixa') : e.status === 'infeasible' ? 'inviável' : 'evidência insuficiente'));
      return write(0, { status: 'preview', milestone: options.milestone, proposal: relative, history: { status: history.status, observations: history.observations, sources: history.sources }, estimate: preview },
        'Prévia somente leitura (' + history.observations + ' amostras):\n' + lines.join('\n'));
    }
    if (action === '--render') {
      if (options.cwd || options.milestone) fail('options-usage');
      let record;
      try { record = JSON.parse(readBounded(path.resolve(options.render), MAX_RECORD_BYTES)); } catch (e) { if (e.code) throw e; fail('options-record-invalid'); }
      const markdown = renderOptionsMarkdown(record);
      return write(0, { status: 'rendered', options_sha256: digest(record), markdown }, markdown.trimEnd());
    }
    fail('options-usage');
  } catch (e) {
    const reason = typeof e.code === 'string' && /^(options|history)-/.test(e.code) ? e.code : 'options-operation-refused';
    if (reason === 'options-usage') return write(2, { status: 'usage', reason }, 'Uso: --validate <arquivo> --milestone <M> | --estimate --cwd <owner> --milestone <M> | --render <registro> [--json]');
    return write(3, { status: 'refused', reason }, 'Operação recusada: ' + reason);
  }
}

module.exports = { PROPOSAL_SCHEMA_VERSION, POSITION_IDS, MEASURABLE_PHASES, NODE_KINDS, GATE_KINDS, SCOPE_SOURCES, PROPOSAL_ITEM_STATES, POSITION_STATUSES,
  ESTIMATE_POLICY, HISTORY_LIMITS, CALIBRATED_SAMPLES, FACTOR_MIN, FACTOR_MAX, MAX_PROPOSAL_BYTES, MAX_RECORD_BYTES, REQUIRED, REFUSALS, ROUND_TYPES,
  LINKED_TASK_AUTHORIZATIONS, validateProposal, validateProposalContent, inspectProposalContent, readHistory, estimate, materialize, inputsFreshness,
  renderOptionsMarkdown, selectionRounds, canonicalAnswer, parseOperatorCeiling, formatDuration, main };
if (require.main === module) process.exitCode = main();
