#!/usr/bin/env node
'use strict';

// Pure conformance of the ROADMAP "## Alocação de tempo" section against the
// persisted selection, its options record and the immutable BASE contract.
// Nothing here touches disk: callers pass text and already-read records. The
// only roadmap parser is forge-status.parseRoadmap, loaded lazily when a caller
// does not pass the parsed slices. Import is inert.
//
// Options record consumed by expectedFrom (schema_version 1):
//   options: [{ id, label, ceiling_ms, nodes: [{ id, kind }], edges: [{ from, to }],
//     positions: [{ id, deferred: [node], linked_task: null | { moved_scope: [node], criteria, horizon } }] }]
// An edge { from, to } means `from` depends on `to`. Gates are nodes of kind "gate".
// The same record may instead carry the T02 producer shape, normalized by sourceGraph:
//   position: { id, nodes: [{ id, kind, depends: [node], covers: [scope item] }], deferrals: [{ scope_item }],
//     linked_task: null | { moved_scope: [scope item], nodes: [node], criteria, horizon } }
// Scope-item IDs differ from node IDs. `deferred` and `linked_task.moved_scope` of the normalized graph are always
// NODE IDs: a node whose covers all lie in the deferrals is deferred, linked_task.nodes are the moved nodes, and
// edges come from node.depends plus explicit edges.
//
// Execution mapping: the allocation kind is the lifecycle anchor, in ALLOCATION_KINDS order
// (preparation < slice < integration < review < corrections). "A depends on B" holds when A's row has a later kind
// than B's row; two slice rows need the roadmap slice of A to reach that of B; two rows of the same non-slice kind
// follow allocation array order (A's row after B's); the same non-slice row proves nothing and is refused.
// Node kinds allow only: delivery -> slice, gate -> integration|review, integration|review|corrections|preparation -> own kind;
// unknown kinds behave as delivery. Refined parts inherit the kind of their parent node.
//
// Section (one fenced ```json block under SECTION_HEADING, schema_version 1):
//   { schema_version, option_id, position_id, options_sha256, contract_sha256 (BASE),
//     allocation: [{ id, kind, slice?, ms, nodes: [node or refined part] }],
//     dependencies: [{ from, to }], deferred: [node], linked_task: null | { moved_scope: [node] },
//     refinements?: [{ node, parts: [part, ...] }] }
const SECTION_HEADING = '## Alocação de tempo';
const SECTION_SCHEMA_VERSION = 1;
const ALLOCATION_KINDS = Object.freeze(['preparation', 'slice', 'integration', 'review', 'corrections']);
const PRECONDITIONS = Object.freeze(['options-required', 'selection-required', 'activation-required']);
const SECTION_KEYS = ['schema_version', 'option_id', 'position_id', 'options_sha256', 'contract_sha256', 'allocation', 'dependencies', 'deferred', 'linked_task'];
const MAX_ROWS = 256, MAX_EDGES = 1024, MAX_SECTION = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/, FENCE = /^\s*(```|~~~)/;

function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, required, optional = []) { return object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function id(v) { return typeof v === 'string' && ID.test(v); }
function ms(v) { return Number.isSafeInteger(v) && v > 0; }
function idList(v, min = 0) { return Array.isArray(v) && v.length >= min && v.length <= MAX_ROWS && v.every(id) && new Set(v).size === v.length; }
function edgeKey(e) { return e.from + '>' + e.to; }
const NODE_ALLOCATIONS = Object.freeze({ delivery: ['slice'], gate: ['integration', 'review'], integration: ['integration'], review: ['review'],
  corrections: ['corrections'], preparation: ['preparation'] });
function allocationsOf(kind) { return Object.hasOwn(NODE_ALLOCATIONS, kind) ? NODE_ALLOCATIONS[kind] : NODE_ALLOCATIONS.delivery; }
function refuse(reason, extra = {}) { return { valid: false, status: 'refused', reason, ...extra }; }
function invalid(reason) { return { status: 'invalid', reason }; }
// Key order never changes semantic identity; array order does.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (!object(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
}

function sectionValid(v) {
  if (!exact(v, SECTION_KEYS, ['refinements']) || v.schema_version !== SECTION_SCHEMA_VERSION || !id(v.option_id) || !id(v.position_id)
      || !hash(v.options_sha256) || !hash(v.contract_sha256)) return false;
  const rows = v.allocation;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS || new Set(rows.map(r => r?.id)).size !== rows.length) return false;
  let total = 0;
  for (const r of rows) {
    if (!exact(r, ['id', 'kind', 'ms', 'nodes'], ['slice']) || !id(r.id) || !ALLOCATION_KINDS.includes(r.kind) || !ms(r.ms) || !idList(r.nodes)) return false;
    if (r.kind === 'slice' ? typeof r.slice !== 'string' || !/^S\d{2,}$/.test(r.slice) : r.slice !== undefined) return false;
    total += r.ms; if (!Number.isSafeInteger(total)) return false;
  }
  if (!Array.isArray(v.dependencies) || v.dependencies.length > MAX_EDGES
      || v.dependencies.some(e => !exact(e, ['from', 'to']) || !id(e.from) || !id(e.to) || e.from === e.to)) return false;
  if (!idList(v.deferred) || !(v.linked_task === null || exact(v.linked_task, ['moved_scope']) && idList(v.linked_task.moved_scope, 1))) return false;
  return v.refinements === undefined || Array.isArray(v.refinements) && v.refinements.length <= MAX_ROWS
    && v.refinements.every(r => exact(r, ['node', 'parts']) && id(r.node) && idList(r.parts, 2));
}

// Locates the single section outside code fences and parses its single JSON block.
function parseTimeSection(text) {
  if (typeof text !== 'string') return invalid('roadmap-time-content-invalid');
  const lines = text.split(/\r?\n/), headings = [];
  let fenced = false;
  lines.forEach((line, i) => { if (FENCE.test(line)) fenced = !fenced; else if (!fenced && line.trimEnd() === SECTION_HEADING) headings.push(i); });
  if (!headings.length) return { status: 'absent' };
  if (headings.length > 1) return invalid('roadmap-time-section-duplicate');
  let end = lines.length; fenced = false;
  for (let i = headings[0] + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    else if (!fenced && /^#{1,2}\s/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(headings[0] + 1, end), blocks = [];
  let open = -1, fences = 0;
  for (let i = 0; i < body.length; i++) {
    if (open < 0 && FENCE.test(body[i])) { fences++; if (body[i].trim() === '```json') open = i; else return invalid('roadmap-time-section-invalid'); }
    else if (open >= 0 && body[i].trim() === '```') { blocks.push(body.slice(open + 1, i).join('\n')); open = -1; }
  }
  if (open >= 0 || fences !== 1 || blocks.length !== 1) return invalid('roadmap-time-section-invalid');
  if (Buffer.byteLength(blocks[0]) > MAX_SECTION) return invalid('roadmap-time-section-too-large');
  let value; try { value = JSON.parse(blocks[0]); } catch { return invalid('roadmap-time-json-invalid'); }
  if (!sectionValid(value)) return invalid('roadmap-time-schema-invalid');
  return { status: 'valid', section: value };
}

// Read-only projection of the roadmap: slices from parseRoadmap plus the parsed
// section. `structure` excludes checkboxes, risk tags and prose outside the JSON.
function inspectRoadmapContent(text, roadmap) {
  if (typeof text !== 'string') return invalid('roadmap-time-content-invalid');
  const parsed = roadmap === undefined ? require('./forge-status').parseRoadmap(text) : roadmap;
  if (!object(parsed) || !Array.isArray(parsed.slices)) return invalid('roadmap-time-roadmap-invalid');
  if (parsed.slices.some(s => s?.dependency_status === 'invalid')) return invalid('roadmap-time-dependency-invalid');
  const read = parseTimeSection(text);
  if (read.status === 'invalid') return read;
  const slices = parsed.slices.map(s => ({ id: s.id, title: s.title, dependencies: [...(s.dependencies || [])] }));
  const section = read.status === 'valid' ? read.section : null;
  return { status: 'valid', section, slices, structure: canonical({ schema: 'forge-roadmap-structure-v1', slices, time: section }) };
}

// The single source-graph normalizer shared by selection and conformance. It validates the COMPLETE graph (duplicate
// or unknown nodes, malformed or repeated edges, self-edges, cycles) before any horizon is split and returns node-ID
// based nodes, edges, deferred and linked_task from the stored options shape or the T02 producer shape.
function graphInvalid(reason) { return { status: 'invalid', reason }; }
function sourceGraph(option, position) {
  if (!object(option) || !object(position)) return graphInvalid('roadmap-time-graph-node-invalid');
  const own = Array.isArray(position.nodes), list = own ? position.nodes : option.nodes;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROWS) return graphInvalid('roadmap-time-graph-node-invalid');
  const all = new Set(), nodes = [], raw = [];
  for (const n of list) {
    if (!object(n) || !id(n.id) || !id(n.kind) || all.has(n.id) || n.covers !== undefined && !idList(n.covers)) return graphInvalid('roadmap-time-graph-node-invalid');
    all.add(n.id); nodes.push({ id: n.id, kind: n.kind, ...(n.covers ? { covers: [...n.covers] } : {}) });
  }
  for (const n of list) if (n.depends !== undefined) {
    if (!idList(n.depends)) return graphInvalid('roadmap-time-graph-edge-invalid');
    for (const to of n.depends) raw.push({ from: n.id, to });
  }
  // A PRESENT edge declaration of the wrong type (object, string, null) is malformed on either level: it is refused before
  // a representation is chosen and never treated as absent, even when another valid representation exists.
  for (const declared of [position.edges, option.edges]) if (declared !== undefined && !Array.isArray(declared)) return graphInvalid('roadmap-time-graph-edge-invalid');
  const explicit = Array.isArray(position.edges) ? position.edges : Array.isArray(option.edges) ? option.edges : null;
  if (explicit === null && !own && !list.some(n => n.depends !== undefined)) return graphInvalid('roadmap-time-graph-edge-invalid');
  raw.push(...(explicit || []));
  if (raw.length > MAX_EDGES) return graphInvalid('roadmap-time-graph-edge-invalid');
  const keys = new Set(), next = new Map(nodes.map(n => [n.id, []])), edges = [];
  for (const e of raw) {
    if (!exact(e, ['from', 'to']) || !all.has(e.from) || !all.has(e.to) || e.from === e.to || keys.has(edgeKey(e))) return graphInvalid('roadmap-time-graph-edge-invalid');
    keys.add(edgeKey(e)); next.get(e.from).push(e.to); edges.push({ from: e.from, to: e.to });
  }
  const state = new Map();
  const cyclic = n => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) return true;
    state.set(n, 1);
    const hit = next.get(n).some(cyclic); state.set(n, 2); return hit;
  };
  if (nodes.some(n => cyclic(n.id))) return graphInvalid('roadmap-time-graph-cycle');
  // Producer deferrals name scope items: a node is deferred when every item it covers is deferred.
  let deferred = position.deferred ?? [];
  if (position.deferred === undefined && Array.isArray(position.deferrals)) {
    const items = new Set(position.deferrals.map(d => d?.scope_item));
    deferred = nodes.filter(n => n.covers?.length && n.covers.every(c => items.has(c))).map(n => n.id);
  }
  let linked = position.linked_task ?? null;
  if (linked !== null) {
    if (!object(linked)) return graphInvalid('roadmap-time-graph-node-invalid');
    const { nodes: moved, moved_scope: items, ...rest } = linked;
    linked = { ...rest, moved_scope: Array.isArray(moved) ? moved : items, ...(Array.isArray(moved) ? { scope_items: items } : {}) };
  }
  return { status: 'valid', nodes, edges, deferred: [...deferred], linked_task: linked };
}

// The ONE normalization boundary from a persisted options record to the offered options consumed by selection
// (recordSelection) and conformance (expectedFrom). Two shapes are accepted:
//  - stored shape: { options: [{ id, label, ceiling_ms, endpoint?, nodes?, edges?, positions: [...] }] } (returned as is);
//  - T02 materialized producer record { schema_version, milestone, proposal, estimate, inputs, producer_basis, ... } where
//    proposal is the v1 proposal (proposal.positions[] with id, label, status, nodes[{id, kind, depends, covers}], deferrals,
//    linked_task: null | { moved_scope: [scope item], criteria, nodes: [node] }) and estimate carries the persisted numbers:
//      estimate.positions: [{ position_id, low_ms, high_ms (null = unknown), confidence, ceiling_ms (null = no offered cap),
//        linked_task_horizon: null | { low_ms, high_ms, ceiling_ms } }]   (linked_task_horizon is required when linked_task is set)
//    Each proposal position becomes one option with the same id holding exactly that position, so option_id === position_id.
//    inputs and producer_basis are descriptive provenance only: they never grant authority and are not interpreted here.
// Unknown estimates stay unknown (null): no number is derived. Returns { status: 'valid', options } or { status: 'invalid', reason }.
function optionsView(record) {
  const bad = invalid('roadmap-time-options-invalid');
  if (!object(record)) return bad;
  if (Array.isArray(record.options)) return { status: 'valid', options: record.options };
  const { proposal, estimate } = record;
  if (!object(proposal) || !Array.isArray(proposal.positions) || !proposal.positions.length || proposal.positions.length > MAX_ROWS || !object(proposal.endpoint)
      || !object(estimate) || !Array.isArray(estimate.positions) || !object(record.inputs) || !object(record.producer_basis)) return bad;
  const options = [];
  for (const p of proposal.positions) {
    const e = object(p) ? estimate.positions.find(x => x?.position_id === p.id) : undefined;
    if (!object(e) || !id(p.id) || !Array.isArray(p.nodes) || !Array.isArray(p.deferrals) || options.some(o => o.id === p.id)) return bad;
    const unknown = v => v === null || ms(v);
    if (!unknown(e.low_ms) || !unknown(e.high_ms) || !unknown(e.ceiling_ms) || p.linked_task !== null && !(object(p.linked_task) && object(e.linked_task_horizon))) return bad;
    options.push({ id: p.id, label: p.label, ...(ms(e.ceiling_ms) ? { ceiling_ms: e.ceiling_ms } : {}), endpoint: proposal.endpoint,
      positions: [{ id: p.id, status: p.status, nodes: p.nodes, deferrals: p.deferrals,
        linked_task: p.linked_task === null ? null : { ...p.linked_task, horizon: e.linked_task_horizon },
        estimate: { low_ms: e.low_ms, high_ms: e.high_ms, ...(e.confidence !== undefined ? { confidence: e.confidence } : {}) } }] });
  }
  return { status: 'valid', options };
}

// The ONE selected-position projection shared by selection (before any immutable record is published) and conformance:
// horizon membership (linked/deferred IDs known, disjoint, milestone scope nonempty) and cross-horizon prerequisites
// (a milestone node cannot require work moved to the linked task or deferred; task -> milestone edges stay allowed).
function selectedPartition(graph, extra = []) {
  const bad = invalid('roadmap-time-expected-invalid');
  if (!object(graph) || graph.status !== 'valid' || !idList(extra)) return bad;
  const all = new Set(graph.nodes.map(n => n.id)), linked = graph.linked_task;
  const moved = linked === null ? [] : linked.moved_scope;
  if (!idList(graph.deferred) || linked !== null && !idList(moved, 1)) return bad;
  // Attested scope reductions may also name endpoint items or slices: only nodes matter here.
  const deferred = [...new Set([...graph.deferred, ...extra.filter(n => all.has(n))])];
  if ([...moved, ...deferred].some(n => !all.has(n)) || moved.some(n => deferred.includes(n))) return bad;
  const scope = new Set([...all].filter(n => !moved.includes(n) && !deferred.includes(n)));
  if (!scope.size) return bad;
  const edges = [];
  for (const e of graph.edges) {
    // Linked-task work cannot require work deferred outside both horizons; deferred-origin edges leave the projection.
    if (moved.includes(e.from) && deferred.includes(e.to)) return bad;
    if (!scope.has(e.from)) continue;
    if (!scope.has(e.to)) return bad;
    edges.push({ from: e.from, to: e.to });
  }
  return { status: 'valid', moved, deferred, scope, edges, linked };
}
function pending(precondition) { return { status: 'pending', precondition }; }
// Derives the conformance rule only from the persisted selection, its options
// record and the immutable BASE contract. No enrollment and no selection, or a
// no-contract selection, is legacy: no rule (null). `deferred` may only carry
// identifiers already deferred by an attested scope-reduction decision, and
// `ceiling_ms` the current ceiling, never below the base one.
function expectedFrom(input = {}) {
  const { enrollment = null, options = null, options_sha256 = null, selection = null, contract = null, contract_sha256 = null } = input;
  if (!enrollment && !selection) return null;
  if (selection?.choice === 'no-contract') return null;
  if (!selection) return pending(options ? 'selection-required' : 'options-required');
  if (!contract) return pending('activation-required');
  const bad = invalid('roadmap-time-expected-invalid');
  const view = optionsView(options);
  if (selection.choice !== 'option' || view.status !== 'valid' || !hash(options_sha256) || !hash(contract_sha256)
      || selection.options_sha256 !== options_sha256 || contract.option?.options_sha256 !== options_sha256 || contract.option?.id !== selection.option_id) return bad;
  const option = view.options.find(o => o?.id === selection.option_id);
  const position = Array.isArray(option?.positions) ? option.positions.find(p => p?.id === selection.position_id) : undefined;
  if (!object(position) || (contract.option.position_id ?? position.id) !== position.id) return bad;
  const graph = sourceGraph(option, position);
  if (graph.status !== 'valid') return invalid(graph.reason);
  const part = selectedPartition(graph, input.deferred ?? []);
  if (part.status !== 'valid') return bad;
  const { moved, deferred, scope, edges, linked } = part;
  if ((contract.linked_task?.position_id ?? null) !== (linked === null ? null : position.id)) return bad;
  const ceiling = ms(input.ceiling_ms) && input.ceiling_ms >= contract.ceiling_ms ? input.ceiling_ms : contract.ceiling_ms;
  if (!ms(ceiling)) return bad;
  return { status: 'ready', option_id: option.id, position_id: position.id, options_sha256, contract_sha256, ceiling_ms: ceiling,
    nodes: graph.nodes.filter(n => scope.has(n.id)).map(n => ({ id: n.id, kind: n.kind })),
    edges: edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))), deferred: deferred.sort(),
    linked_task: linked === null ? null : { moved_scope: [...moved].sort() } };
}
function expectedValid(e) {
  return exact(e, ['status', 'option_id', 'position_id', 'options_sha256', 'contract_sha256', 'ceiling_ms', 'nodes', 'edges', 'deferred', 'linked_task'])
    && e.status === 'ready' && id(e.option_id) && id(e.position_id) && hash(e.options_sha256) && hash(e.contract_sha256) && ms(e.ceiling_ms)
    && Array.isArray(e.nodes) && e.nodes.length > 0 && e.nodes.every(n => object(n) && id(n.id)) && Array.isArray(e.edges) && idList(e.deferred)
    && (e.linked_task === null || object(e.linked_task) && idList(e.linked_task.moved_scope, 1));
}
function sameSet(a, b) { const x = new Set(a); return x.size === new Set(b).size && [...b].every(v => x.has(v)); }

// Validates an inspected roadmap against an expected rule. A pending
// precondition refuses before any content is examined.
function validateRoadmap(inspected, expected) {
  if (expected === null || expected === undefined) return { valid: true, status: 'no-rule' };
  if (expected?.status === 'pending') return refuse('roadmap-time-preparation-pending', { precondition: PRECONDITIONS.includes(expected.precondition) ? expected.precondition : 'unknown' });
  if (expected?.status === 'invalid') return refuse(typeof expected.reason === 'string' && expected.reason.startsWith('roadmap-time-') ? expected.reason : 'roadmap-time-expected-invalid');
  if (!expectedValid(expected)) return refuse('roadmap-time-expected-invalid');
  if (inspected?.status === 'invalid') return refuse(inspected.reason);
  if (inspected?.status !== 'valid' || !Array.isArray(inspected.slices)) return refuse('roadmap-time-content-invalid');
  const s = inspected.section;
  if (!s) return refuse('roadmap-time-section-missing');
  if (!inspected.slices.length) return refuse('roadmap-time-slices-missing');
  if (s.option_id !== expected.option_id || s.position_id !== expected.position_id || s.options_sha256 !== expected.options_sha256) return refuse('roadmap-time-strategy-mismatch');
  if (s.contract_sha256 !== expected.contract_sha256) return refuse('roadmap-time-contract-mismatch');
  const roadmapSlices = new Map(inspected.slices.map(r => [r.id, r.dependencies || []]));
  for (const r of s.allocation) {
    if (r.kind === 'slice' && !roadmapSlices.has(r.slice)) return refuse('roadmap-time-slice-unknown', { slice: r.slice });
    if (r.kind === 'slice' && !r.nodes.length) return refuse('roadmap-time-slice-empty', { slice: r.slice });
  }
  for (const slice of roadmapSlices.keys()) if (!s.allocation.some(r => r.slice === slice)) return refuse('roadmap-time-slice-unallocated', { slice });
  // Explicit refinement: a node split into parts, each mapped exactly once.
  const scope = new Map(expected.nodes.map(n => [n.id, n])), parts = new Map(), refined = new Set();
  const outside = new Set([...expected.deferred, ...(expected.linked_task?.moved_scope || [])]);
  for (const r of s.refinements || []) {
    if (!scope.has(r.node) || refined.has(r.node)) return refuse('roadmap-time-refinement-invalid', { node: r.node });
    refined.add(r.node);
    for (const part of r.parts) {
      if (scope.has(part) || outside.has(part) || parts.has(part)) return refuse('roadmap-time-refinement-invalid', { node: r.node });
      parts.set(part, r.node);
    }
  }
  const seen = new Set(), slicesOf = new Map([...scope.keys()].map(n => [n, new Set()])), rowsOf = new Map([...scope.keys()].map(n => [n, []]));
  for (const r of s.allocation) for (const entry of r.nodes) {
    if (seen.has(entry)) return refuse('roadmap-time-node-duplicate', { node: parts.get(entry) || entry });
    seen.add(entry);
    if (outside.has(entry)) return refuse('roadmap-time-node-out-of-scope', { node: entry });
    const node = parts.get(entry) || entry;
    if (!scope.has(node)) return refuse('roadmap-time-node-unknown', { node: entry });
    if (refined.has(entry)) return refuse('roadmap-time-refinement-invalid', { node: entry });
    if (!allocationsOf(scope.get(node).kind).includes(r.kind)) return refuse('roadmap-time-node-kind-mismatch', { node, kind: r.kind });
    if (!rowsOf.get(node).includes(r)) rowsOf.get(node).push(r);
    if (r.kind === 'slice') slicesOf.get(node).add(r.slice);
  }
  for (const part of parts.keys()) if (!seen.has(part)) return refuse('roadmap-time-refinement-invalid', { node: parts.get(part) });
  for (const [node, row] of scope) {
    if (!seen.has(node) && !refined.has(node)) return refuse(row.kind === 'gate' ? 'roadmap-time-gate-missing' : 'roadmap-time-node-missing', { node });
  }
  if (!sameSet(s.deferred, expected.deferred)) return refuse('roadmap-time-deferred-mismatch');
  if ((s.linked_task === null) !== (expected.linked_task === null)
      || s.linked_task && !sameSet(s.linked_task.moved_scope, expected.linked_task.moved_scope)) return refuse('roadmap-time-linked-task-mismatch');
  const declared = s.dependencies.map(edgeKey);
  if (new Set(declared).size !== declared.length || !sameSet(declared, expected.edges.map(edgeKey))) return refuse('roadmap-time-edge-mismatch');
  function reaches(from, to, visited = new Set()) {
    if (from === to) return true;
    if (visited.has(from)) return false; visited.add(from);
    return (roadmapSlices.get(from) || []).some(next => reaches(next, to, visited));
  }
  const rank = r => ALLOCATION_KINDS.indexOf(r.kind);
  for (const e of expected.edges) {
    for (const a of rowsOf.get(e.from)) for (const b of rowsOf.get(e.to)) {
      if (rank(a) < rank(b)) return refuse('roadmap-time-edge-inverted', { edge: edgeKey(e) });
      const ordered = rank(a) > rank(b) || (a.kind === 'slice' ? reaches(a.slice, b.slice) : s.allocation.indexOf(a) > s.allocation.indexOf(b));
      if (!ordered) return refuse('roadmap-time-edge-unmapped', { edge: edgeKey(e) });
    }
  }
  const total = s.allocation.reduce((sum, r) => sum + r.ms, 0);
  if (total > expected.ceiling_ms) return refuse('roadmap-time-ceiling-exceeded', { total_ms: total, ceiling_ms: expected.ceiling_ms });
  const mapping = [...scope.keys()].sort().map(node => ({ node, items: s.allocation.filter(r => r.nodes.some(x => (parts.get(x) || x) === node)).map(r => r.id),
    slices: [...slicesOf.get(node)].sort() }));
  return { valid: true, status: 'conformant', total_ms: total, ceiling_ms: expected.ceiling_ms, mapping };
}
function validateRoadmapContent(text, expected, roadmap) {
  if (expected === null || expected === undefined || expected?.status === 'pending' || expected?.status === 'invalid') return validateRoadmap(null, expected);
  return validateRoadmap(inspectRoadmapContent(text, roadmap), expected);
}

module.exports = { SECTION_HEADING, SECTION_SCHEMA_VERSION, ALLOCATION_KINDS, PRECONDITIONS, parseTimeSection, inspectRoadmapContent,
  expectedFrom, sourceGraph, selectedPartition, optionsView, validateRoadmap, validateRoadmapContent, canonical };
