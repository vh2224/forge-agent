#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const rt = require('./forge-milestone-roadmap-time');
const OPT = 'a'.repeat(64), BASE = 'b'.repeat(64);
const kinds = ['preparation', 'slice', 'review', 'corrections', 'slice', 'review', 'corrections', 'slice', 'review', 'corrections', 'integration'];
const ids = ['prep', 's1', 'r1', 'c1', 's2', 'r2', 'c2', 's3', 'r3', 'c3', 'integrate'];
function fixture() {
  const nodes = ids.map((id, i) => ({ id, kind: kinds[i] }));
  const edges = ids.slice(1).map((from, i) => ({ from, to: ids[i] }));
  const expected = rt.expectedFrom({ enrollment: {}, options: { options: [{ id: 'short', ceiling_ms: 11000, nodes, edges,
    positions: [{ id: 'short', deferred: [], linked_task: null }] }] }, options_sha256: OPT,
  selection: { choice: 'option', option_id: 'short', position_id: 'short', options_sha256: OPT },
  contract: { option: { id: 'short', options_sha256: OPT }, ceiling_ms: 11000, linked_task: null }, contract_sha256: BASE });
  const section = { schema_version: 1, option_id: 'short', position_id: 'short', options_sha256: OPT, contract_sha256: BASE,
    allocation: ids.map((id, i) => ({ id, kind: kinds[i], ms: 1000, nodes: [id], ...(kinds[i] === 'slice' ? { slice: 'S0' + (ids.slice(0, i + 1).filter(x => /^s\d/.test(x)).length) } : {}) })),
    dependencies: edges, deferred: [], linked_task: null };
  const slices = [{ id: 'S01', dependencies: [] }, { id: 'S02', dependencies: ['S01'] }, { id: 'S03', dependencies: ['S02'] }];
  return { expected, section, slices };
}
function check(f) { return rt.validateRoadmap(rt.inspectRoadmapContent('## Alocação de tempo\n\n```json\n' + JSON.stringify(f.section) + '\n```\n', { slices: f.slices }), f.expected); }
function swap(f, a, b) { const x = f.section.allocation; [x[a], x[b]] = [x[b], x[a]]; }
let count = 0;
function test(name, fn) { fn(); console.log('PASS ' + name); count++; }
test('three-slice-review-correction-chain-is-conformant-without-relabel-or-contract-change', () => {
  const f = fixture(), before = JSON.stringify(f.expected), r = check(f);
  assert.equal(r.valid, true, JSON.stringify(r)); assert.equal(r.total_ms, 11000);
  assert.equal(JSON.stringify(f.expected), before); assert.equal(r.mapping.length, 11);
});
test('quality-prerequisites-cannot-follow-their-dependent-slice-or-integration', () => {
  for (const [a, b] of [[3, 4], [6, 7], [9, 10], [1, 2]]) {
    const f = fixture(); swap(f, a, b); assert.equal(check(f).valid, false, a + ':' + b);
  }
});
test('two-slice-endpoints-still-require-roadmap-reachability-and-chronology', () => {
  const f = fixture(); f.expected.edges.push({ from: 's3', to: 's1' }); f.section.dependencies.push({ from: 's3', to: 's1' });
  assert.equal(check(f).valid, true);
  f.slices[2].dependencies = []; assert.equal(check(f).reason, 'roadmap-time-edge-unmapped');
  const reversed = fixture(); reversed.expected.edges = [{ from: 's2', to: 's1' }]; reversed.section.dependencies = reversed.expected.edges;
  swap(reversed, 1, 4); assert.equal(check(reversed).valid, false);
});
test('transitive-slice-dependencies-through-quality-nodes-require-roadmap-reachability', () => {
  for (const indexes of [[1], [2], [1, 2]]) {
    const f = fixture(); for (const index of indexes) f.slices[index].dependencies = [];
    assert.equal(check(f).reason, 'roadmap-time-edge-unmapped', indexes.join(','));
  }
});
test('quality-kind-and-selected-contract-remain-exact', () => {
  for (const mutate of [f => { f.section.allocation[2].kind = 'integration'; }, f => { f.section.contract_sha256 = 'c'.repeat(64); },
    f => { f.section.dependencies.pop(); }, f => { f.section.allocation[0].ms++; }]) {
    const f = fixture(); mutate(f); assert.equal(check(f).valid, false);
  }
});
test('same-row-quality-dependency-is-not-a-proven-order', () => {
  const f = fixture(); f.expected.nodes[3].kind = 'review'; f.section.allocation[2].nodes.push('c1'); f.section.allocation.splice(3, 1);
  assert.equal(check(f).reason, 'roadmap-time-edge-unmapped');
});
test('distinct-rows-of-the-same-slice-still-declare-chronology', () => {
  const f = fixture(); f.slices = [f.slices[0]];
  for (const row of f.section.allocation) if (row.kind === 'slice') row.slice = 'S01';
  f.expected.edges = [{ from: 's2', to: 's1' }]; f.section.dependencies = f.expected.edges;
  assert.equal(check(f).valid, true); swap(f, 1, 4);
  assert.equal(check(f).reason, 'roadmap-time-edge-unmapped');
});
test('every-refined-prerequisite-must-precede-the-dependent', () => {
  const f = fixture(); f.section.refinements = [{ node: 'c1', parts: ['c1a', 'c1b'] }];
  f.section.allocation[3].nodes = ['c1a']; f.section.allocation[3].ms = 500;
  f.section.allocation.splice(5, 0, { id: 'late-fix', kind: 'corrections', ms: 500, nodes: ['c1b'] });
  assert.equal(check(f).valid, false);
});
console.log(count + ' staged roadmap checks passed');
