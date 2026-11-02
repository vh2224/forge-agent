#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const rt = require('./forge-milestone-roadmap-time');
const OPT = 'c'.repeat(64), BASE = 'd'.repeat(64);
let passed = 0;
function test(name, callback) { callback(); passed++; console.log('PASS ' + name); }
function optionsRecord() {
  return { schema_version: 1, milestone: 'M001', options: [
    { id: 'short', label: 'Curta', ceiling_ms: 10000,
      nodes: [{ id: 'N1', kind: 'delivery' }, { id: 'N2', kind: 'delivery' }, { id: 'G1', kind: 'gate' }, { id: 'N3', kind: 'delivery' }, { id: 'N4', kind: 'delivery' }],
      edges: [{ from: 'N2', to: 'N1' }, { from: 'G1', to: 'N2' }, { from: 'N4', to: 'N2' }],
      positions: [
        { id: 'P1', deferred: ['N3'], linked_task: { moved_scope: ['N4'], criteria: { milestone: ['Entrega N1-N2'], task: ['Entrega N4'] }, horizon: { low_ms: 1, high_ms: 2, ceiling_ms: 3 } } },
        { id: 'P0', deferred: [], linked_task: null }] },
    { id: 'long', label: 'Longa', ceiling_ms: 20000, nodes: [{ id: 'N1', kind: 'delivery' }], edges: [], positions: [{ id: 'P0', deferred: [], linked_task: null }] }] };
}
function selection(overrides = {}) { return { choice: 'option', options_sha256: OPT, option_id: 'short', position_id: 'P1', ...overrides }; }
function contract(overrides = {}) { return { option: { id: 'short', options_sha256: OPT, label: 'Curta' }, ceiling_ms: 10000, linked_task: { position_id: 'P1' }, ...overrides }; }
function expected(overrides = {}) {
  return rt.expectedFrom({ enrollment: { schema_version: 1 }, options: optionsRecord(), options_sha256: OPT, selection: selection(), contract: contract(), contract_sha256: BASE, ...overrides });
}
function section(overrides = {}) {
  return { schema_version: 1, option_id: 'short', position_id: 'P1', options_sha256: OPT, contract_sha256: BASE,
    allocation: [{ id: 'prep', kind: 'preparation', ms: 500, nodes: [] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 3000, nodes: ['N1'] },
      { id: 's2', kind: 'slice', slice: 'S02', ms: 3000, nodes: ['N2'] }, { id: 'review', kind: 'review', ms: 1000, nodes: ['G1'] }],
    dependencies: [{ from: 'N2', to: 'N1' }, { from: 'G1', to: 'N2' }], deferred: ['N3'], linked_task: { moved_scope: ['N4'] }, ...overrides };
}
function roadmap(value, options = {}) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, options.indent ?? 2);
  return `# M001: Fixture — Roadmap\n\n${options.prose || 'Visão geral.'}\n\n## Slices\n\n`
    + `- [${options.checked ? 'x' : ' '}] **S01: Primeira entrega** \`risk:low\` \`depends:[]\`\n`
    + `- [ ] **S02: Segunda entrega** \`risk:medium\` \`depends:[${options.s02 ?? 'S01'}]\`\n${options.extraSlice || ''}\n`
    + (options.noSection ? '' : `${rt.SECTION_HEADING}\n\nTexto livre da seção.\n\n\`\`\`json\n${json}\n\`\`\`\n`) + (options.tail || '');
}
function check(text, rule = expected()) { return rt.validateRoadmapContent(text, rule); }
function refused(reason, text, rule) { const r = check(text, rule); assert.equal(r.valid, false, reason); assert.equal(r.reason, reason); return r; }

test('exports-constants-and-declared-artifacts-substantive', () => {
  for (const name of ['SECTION_HEADING', 'SECTION_SCHEMA_VERSION', 'parseTimeSection', 'validateRoadmap', 'validateRoadmapContent', 'inspectRoadmapContent', 'expectedFrom'])
    assert.ok(rt[name] !== undefined, name);
  assert.equal(rt.SECTION_HEADING, '## Alocação de tempo'); assert.equal(rt.SECTION_SCHEMA_VERSION, 1);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/schemas/forge-milestone-time.schema.json')));
  assert.deepEqual(schema.properties.allocation.oneOf[1].properties.items.items.properties.kind.enum, [...rt.ALLOCATION_KINDS]);
  for (const [file, minimum] of [['forge-milestone-roadmap-time.js', 170], ['forge-milestone-roadmap-time.test.js', 190]]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(source.split('\n').length >= minimum, file);
    if (!file.endsWith('.test.js')) assert.ok(!/\b(?:TODO|TBD|FIXME)\b/.test(source), file);
  }
});
test('pure-module-no-disk-access-on-import-or-validation', () => {
  const file = require.resolve('./forge-milestone-roadmap-time'), Module = require('module'), source = fs.readFileSync(file, 'utf8');
  require('./forge-status');
  const names = ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'lstatSync', 'mkdirSync', 'openSync', 'existsSync', 'realpathSync'];
  const saved = Object.fromEntries(names.map(k => [k, fs[k]])), previous = Module._load, imports = [];
  Module._load = function (id, parent, ...args) { if (parent?.filename === file && id.startsWith('.')) imports.push(id); return previous.call(this, id, parent, ...args); };
  try {
    for (const k of names) fs[k] = () => { throw new Error('disk access ' + k); };
    const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths; mod._compile(source, file);
    assert.deepEqual(imports, [], 'local dependencies stay lazy at import');
    assert.equal(mod.exports.validateRoadmapContent(roadmap(section()), expected()).valid, true);
    assert.equal(rt.validateRoadmapContent(roadmap(section()), expected()).status, 'conformant');
  } finally { for (const k of names) fs[k] = saved[k]; Module._load = previous; }
});
test('complete-acceptance-mapping-total-and-lower-total-is-not-a-minimum', () => {
  const r = check(roadmap(section()));
  assert.equal(r.valid, true); assert.equal(r.total_ms, 7500); assert.equal(r.ceiling_ms, 10000);
  assert.deepEqual(r.mapping.find(m => m.node === 'N2'), { node: 'N2', items: ['s2'], slices: ['S02'] });
  assert.deepEqual(r.mapping.map(m => m.node), ['G1', 'N1', 'N2']);
  const small = section(); small.allocation = small.allocation.map(row => ({ ...row, ms: 1 }));
  assert.equal(check(roadmap(small)).valid, true, 'the low forecast bound is never a mandatory minimum');
  const crlf = roadmap(section()).replace(/\n/g, '\r\n');
  assert.equal(check(crlf).valid, true);
});
test('explicit-refinement-of-one-node-across-slices-is-verifiable', () => {
  const text = roadmap(section({ allocation: [{ id: 's1', kind: 'slice', slice: 'S01', ms: 3000, nodes: ['N1'] },
    { id: 's2', kind: 'slice', slice: 'S02', ms: 2000, nodes: ['N2a'] }, { id: 's3', kind: 'slice', slice: 'S03', ms: 2000, nodes: ['N2b'] },
    { id: 'review', kind: 'review', ms: 500, nodes: ['G1'] }], refinements: [{ node: 'N2', parts: ['N2a', 'N2b'] }] }),
  { extraSlice: '- [ ] **S03: Terceira parte** `risk:low` `depends:[S02]`\n' });
  const r = check(text); assert.equal(r.valid, true, r.reason);
  assert.deepEqual(r.mapping.find(m => m.node === 'N2'), { node: 'N2', items: ['s2', 's3'], slices: ['S02', 'S03'] });
  const both = JSON.parse(JSON.stringify(section({ refinements: [{ node: 'N2', parts: ['N2a', 'N2b'] }] })));
  both.allocation[2].nodes = ['N2', 'N2a', 'N2b'];
  refused('roadmap-time-refinement-invalid', roadmap(both));
  const missingPart = section({ refinements: [{ node: 'N2', parts: ['N2a', 'N2b'] }] }); missingPart.allocation[2].nodes = ['N2a'];
  refused('roadmap-time-refinement-invalid', roadmap(missingPart));
  const collision = section({ refinements: [{ node: 'N2', parts: ['N1', 'N2b'] }] });
  refused('roadmap-time-refinement-invalid', roadmap(collision));
  refused('roadmap-time-refinement-invalid', roadmap(section({ refinements: [{ node: 'N3', parts: ['N3a', 'N3b'] }] })));
  refused('roadmap-time-refinement-invalid', roadmap(section({ refinements: [{ node: 'N2', parts: ['A1', 'A2'] }, { node: 'N2', parts: ['B1', 'B2'] }] })));
});
test('legacy-without-rule-and-no-contract-selection-are-unchanged', () => {
  assert.equal(rt.expectedFrom({}), null);
  assert.equal(rt.expectedFrom({ contract: contract(), contract_sha256: BASE }), null, 'S01 contract without enrollment or selection');
  assert.equal(expected({ selection: { choice: 'no-contract', options_sha256: OPT } }), null);
  for (const text of ['', '# qualquer\n', roadmap(section()), roadmap('{', {})]) assert.deepEqual(rt.validateRoadmapContent(text, null), { valid: true, status: 'no-rule' });
});
test('pending-preparation-or-selection-refuses-before-reading-content', () => {
  const cases = [
    [{ enrollment: { schema_version: 1 } }, 'options-required'],
    [{ enrollment: { schema_version: 1 }, options: optionsRecord(), options_sha256: OPT }, 'selection-required'],
    [{ enrollment: { schema_version: 1 }, options: optionsRecord(), options_sha256: OPT, selection: selection() }, 'activation-required']];
  for (const [input, precondition] of cases) {
    const rule = rt.expectedFrom(input);
    assert.deepEqual(rule, { status: 'pending', precondition });
    for (const text of [roadmap(section()), roadmap('{'), 42, undefined]) {
      const r = rt.validateRoadmapContent(text, rule);
      assert.equal(r.valid, false); assert.equal(r.reason, 'roadmap-time-preparation-pending'); assert.equal(r.precondition, precondition);
    }
    assert.equal(rt.validateRoadmap({ status: 'valid', section: section(), slices: [{ id: 'S01', dependencies: [] }] }, rule).reason, 'roadmap-time-preparation-pending');
  }
});
test('section-parse-refusals-missing-duplicate-json-schema-and-fences', () => {
  refused('roadmap-time-section-missing', roadmap(section(), { noSection: true }));
  refused('roadmap-time-section-duplicate', roadmap(section(), { tail: `\n${rt.SECTION_HEADING}\n\n\`\`\`json\n{}\n\`\`\`\n` }));
  refused('roadmap-time-json-invalid', roadmap('{"schema_version": 1,'));
  refused('roadmap-time-schema-invalid', roadmap(section({ extra: true })));
  refused('roadmap-time-schema-invalid', roadmap(section({ schema_version: 2 })));
  for (const row of [{ id: 'x', kind: 'slice', ms: 1, nodes: [] }, { id: 'x', kind: 'review', slice: 'S01', ms: 1, nodes: [] }, { id: 'x', kind: 'bogus', ms: 1, nodes: [] },
    { id: 'x', kind: 'review', ms: 0, nodes: [] }, { id: 'x', kind: 'review', ms: 1, nodes: ['A', 'A'] }, { id: 'x', kind: 'review', ms: 1 }])
    refused('roadmap-time-schema-invalid', roadmap(section({ allocation: [...section().allocation, row] })));
  refused('roadmap-time-schema-invalid', roadmap(section({ allocation: [...section().allocation, section().allocation[1]] })));
  refused('roadmap-time-schema-invalid', roadmap(section({ dependencies: [{ from: 'N1', to: 'N1' }] })));
  refused('roadmap-time-schema-invalid', roadmap(section({ linked_task: { moved_scope: [] } })));
  const twoBlocks = roadmap(section()).replace('Texto livre da seção.', '```json\n{}\n```');
  refused('roadmap-time-section-invalid', twoBlocks);
  refused('roadmap-time-section-invalid', roadmap(section()).replace('```json', '```js'));
  refused('roadmap-time-section-invalid', roadmap(section()).replace(/\n```\n$/, '\n'));
  const fencedHeading = roadmap(section(), { prose: `\`\`\`md\n${rt.SECTION_HEADING}\n\`\`\`` });
  assert.equal(check(fencedHeading).valid, true, 'a heading inside a code fence is not a second section');
  assert.equal(rt.parseTimeSection(42).reason, 'roadmap-time-content-invalid');
  refused('roadmap-time-section-too-large', roadmap(section()).replace('{', '{' + ' '.repeat(64 * 1024)));
});
test('roadmap-dependency-invalid-and-unknown-or-unallocated-slices-refuse', () => {
  refused('roadmap-time-dependency-invalid', roadmap(section(), { s02: 'S09' }));
  refused('roadmap-time-dependency-invalid', roadmap(section(), { s02: 'S02' }));
  refused('roadmap-time-slice-unknown', roadmap(section({ allocation: [...section().allocation, { id: 's9', kind: 'slice', slice: 'S09', ms: 1, nodes: [] }] })));
  refused('roadmap-time-slice-unallocated', roadmap(section(), { extraSlice: '- [ ] **S03: Inventada** `depends:[S02]`\n' }));
  const empty = section(); empty.allocation[2].nodes = []; empty.allocation[3].nodes = ['G1', 'N2'];
  refused('roadmap-time-slice-empty', roadmap(empty));
  assert.equal(rt.validateRoadmap({ status: 'valid', section: section(), slices: [] }, expected()).reason, 'roadmap-time-slices-missing');
  assert.equal(rt.inspectRoadmapContent('x', { slices: null }).reason, 'roadmap-time-roadmap-invalid');
});
test('strategy-contract-deferred-and-linked-task-must-match-the-selection', () => {
  refused('roadmap-time-strategy-mismatch', roadmap(section({ option_id: 'long' })));
  refused('roadmap-time-strategy-mismatch', roadmap(section({ position_id: 'P0' })));
  refused('roadmap-time-strategy-mismatch', roadmap(section({ options_sha256: 'e'.repeat(64) })));
  refused('roadmap-time-contract-mismatch', roadmap(section({ contract_sha256: 'e'.repeat(64) })));
  refused('roadmap-time-deferred-mismatch', roadmap(section({ deferred: [] })));
  refused('roadmap-time-node-out-of-scope', roadmap(section({ deferred: [], allocation: [...section().allocation.slice(0, 3), { id: 'review', kind: 'review', ms: 1, nodes: ['G1', 'N3'] }] })));
  refused('roadmap-time-linked-task-mismatch', roadmap(section({ linked_task: null })));
  refused('roadmap-time-deferred-mismatch', roadmap(section({ linked_task: { moved_scope: ['N3'] }, deferred: ['N4'] })));
  refused('roadmap-time-linked-task-mismatch', roadmap(section({ linked_task: { moved_scope: ['N4', 'N3'] }, deferred: ['N3'] })));
  const moved = section(); moved.allocation[3].nodes = ['G1', 'N4'];
  refused('roadmap-time-node-out-of-scope', roadmap(moved));
});
test('coverage-no-node-gate-or-edge-may-vanish-duplicate-or-change-even-below-ceiling', () => {
  const omitted = section(); omitted.allocation[2].nodes = []; omitted.allocation[2].kind = 'integration'; delete omitted.allocation[2].slice;
  const r = refused('roadmap-time-node-missing', roadmap(omitted, { s02: 'S01' }).replace(/- \[ \] \*\*S02[^\n]*\n/, ''));
  assert.equal(r.node, 'N2');
  const gate = section(); gate.allocation[3].nodes = [];
  assert.equal(refused('roadmap-time-gate-missing', roadmap(gate)).node, 'G1');
  const duplicated = section(); duplicated.allocation[2].nodes = ['N2', 'N1'];
  refused('roadmap-time-node-duplicate', roadmap(duplicated));
  const unknown = section(); unknown.allocation[3].nodes = ['G1', 'Z9'];
  refused('roadmap-time-node-unknown', roadmap(unknown));
  refused('roadmap-time-edge-mismatch', roadmap(section({ dependencies: [{ from: 'N2', to: 'N1' }] })));
  refused('roadmap-time-edge-mismatch', roadmap(section({ dependencies: [{ from: 'N1', to: 'N2' }, { from: 'G1', to: 'N2' }] })));
  refused('roadmap-time-edge-mismatch', roadmap(section({ dependencies: [...section().dependencies, { from: 'G1', to: 'N1' }] })));
  refused('roadmap-time-edge-mismatch', roadmap(section({ dependencies: [...section().dependencies, { from: 'N2', to: 'N1' }] })));
  refused('roadmap-time-edge-unmapped', roadmap(section(), { s02: '' }));
  const swapped = section(); swapped.allocation[1].nodes = ['N2']; swapped.allocation[2].nodes = ['N1'];
  assert.equal(refused('roadmap-time-edge-unmapped', roadmap(swapped)).edge, 'N2>N1');
  for (const bad of [omitted, gate, duplicated]) assert.ok(bad.allocation.reduce((s, row) => s + row.ms, 0) < 10000, 'refusal is not a budget artefact');
});
test('ceiling-is-the-current-one-and-never-below-base', () => {
  const big = section(); big.allocation[1].ms = 9000;
  const over = refused('roadmap-time-ceiling-exceeded', roadmap(big)); assert.equal(over.total_ms, 13500);
  assert.equal(check(roadmap(big), expected({ ceiling_ms: 20000 })).valid, true, 'an attested extension raises the current ceiling');
  refused('roadmap-time-ceiling-exceeded', roadmap(big), expected({ ceiling_ms: 1 }));
  assert.equal(expected({ ceiling_ms: 1 }).ceiling_ms, 10000);
});
test('expected-invalid-when-records-disagree-or-the-graph-crosses-horizons', () => {
  const bad = input => { const rule = expected(input); assert.equal(rule.status, 'invalid'); assert.equal(rule.reason, 'roadmap-time-expected-invalid');
    assert.equal(check(roadmap(section()), rule).reason, 'roadmap-time-expected-invalid'); };
  bad({ options_sha256: 'e'.repeat(64) });
  bad({ contract: contract({ option: { id: 'long', options_sha256: OPT, label: 'Longa' } }) });
  bad({ selection: selection({ position_id: 'P9' }) });
  bad({ contract: contract({ linked_task: null }) });
  bad({ contract_sha256: 'short' });
  const crossing = optionsRecord(); crossing.options[0].edges.push({ from: 'N1', to: 'N3' }); bad({ options: crossing });
  const overlap = optionsRecord(); overlap.options[0].positions[0].deferred = ['N4']; bad({ options: overlap });
  const everything = optionsRecord(); everything.options[0].positions[0].deferred = ['N1', 'N2', 'G1', 'N3']; bad({ options: everything });
  assert.equal(rt.validateRoadmap({ status: 'valid', section: section(), slices: [] }, { ...expected(), approved: true }).reason, 'roadmap-time-expected-invalid');
  assert.equal(rt.validateRoadmap({ status: 'valid', section: section(), slices: [] }, { status: 'ready' }).reason, 'roadmap-time-expected-invalid');
  const extra = expected({ deferred: ['G1'] });
  assert.equal(extra.status, 'ready'); assert.deepEqual(extra.deferred, ['G1', 'N3'], 'attested scope reduction joins the selected deferral');
  assert.equal(expected({ deferred: ['N2'] }).status, 'invalid', 'G1 still depends on the deferred N2');
});
test('structure-identity-ignores-checkbox-formatting-key-order-and-outer-prose', () => {
  const base = rt.inspectRoadmapContent(roadmap(section()));
  assert.equal(base.status, 'valid'); assert.deepEqual(base.slices.map(s => s.id), ['S01', 'S02']);
  const reordered = Object.fromEntries(Object.entries(section()).reverse());
  for (const text of [roadmap(section(), { checked: true }), roadmap(section(), { indent: 0 }), roadmap(reordered, { indent: 4 }),
    roadmap(section(), { prose: 'Outra prosa externa.' }), roadmap(section()).replace('Texto livre da seção.', 'Prosa diferente.')])
    assert.deepEqual(rt.inspectRoadmapContent(text).structure, base.structure);
  const changedMs = section(); changedMs.allocation[1].ms = 2999;
  const changedNodes = section(); changedNodes.allocation[1].nodes = ['N1', 'N9'];
  for (const text of [roadmap(changedMs), roadmap(changedNodes), roadmap(section({ dependencies: [] })), roadmap(section(), { s02: '' }),
    roadmap(section({ contract_sha256: 'e'.repeat(64) })), roadmap(section(), { noSection: true })])
    assert.notDeepEqual(rt.inspectRoadmapContent(text).structure, base.structure);
  for (const [text, reason] of [[roadmap(section(), { tail: `\n${rt.SECTION_HEADING}\n` }), 'roadmap-time-section-duplicate'], [roadmap('{'), 'roadmap-time-json-invalid'],
    [roadmap(section(), { s02: 'S07' }), 'roadmap-time-dependency-invalid'], [roadmap(section({ extra: 1 })), 'roadmap-time-schema-invalid']])
    assert.deepEqual(rt.inspectRoadmapContent(text), { status: 'invalid', reason });
  assert.equal(rt.inspectRoadmapContent(roadmap(section(), { noSection: true })).section, null);
});
// Quality-role fixture: integration, review and corrections nodes with their own allocation roles.
function qualityOptions(extraEdges = []) {
  const record = optionsRecord(), option = record.options[0];
  option.nodes.push({ id: 'I1', kind: 'integration' }, { id: 'R1', kind: 'review' }, { id: 'C1', kind: 'corrections' });
  option.edges.push({ from: 'I1', to: 'N2' }, { from: 'R1', to: 'I1' }, { from: 'C1', to: 'R1' }, ...extraEdges);
  return record;
}
function qualitySection(overrides = {}) {
  const base = section();
  base.allocation = [{ id: 'prep', kind: 'preparation', ms: 500, nodes: [] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1000, nodes: ['N1'] },
    { id: 's2', kind: 'slice', slice: 'S02', ms: 1000, nodes: ['N2'] }, { id: 'integ', kind: 'integration', ms: 500, nodes: ['I1'] },
    { id: 'review', kind: 'review', ms: 500, nodes: ['G1', 'R1'] }, { id: 'fix', kind: 'corrections', ms: 500, nodes: ['C1'] }];
  base.dependencies = [{ from: 'N2', to: 'N1' }, { from: 'G1', to: 'N2' }, { from: 'I1', to: 'N2' }, { from: 'R1', to: 'I1' }, { from: 'C1', to: 'R1' }];
  return { ...base, ...overrides };
}
function quality(rows, edges, extraEdges) {
  const rule = expected({ options: qualityOptions(extraEdges) }), value = qualitySection(edges ? { dependencies: edges } : {});
  if (rows) value.allocation = rows(value.allocation);
  return check(roadmap(value), rule);
}
test('quality-roles-keep-their-allocation-kind-and-complete-scope-is-conformant', () => {
  const ok = quality(); assert.equal(ok.valid, true, ok.reason);
  assert.deepEqual(ok.mapping.find(m => m.node === 'C1'), { node: 'C1', items: ['fix'], slices: [] });
  const relabel = (node, from, to) => rows => { const r = rows.map(x => ({ ...x, nodes: x.nodes.filter(n => n !== node) }));
    r.find(x => x.id === to).nodes.push(node); return r; };
  for (const [node, to] of [['I1', 's2'], ['C1', 's1'], ['G1', 's2'], ['R1', 's1'], ['I1', 'fix'], ['C1', 'review'], ['R1', 'integ']]) {
    const r = quality(relabel(node, null, to)); assert.equal(r.valid, false, node + '>' + to);
    assert.equal(r.reason, 'roadmap-time-node-kind-mismatch'); assert.equal(r.node, node);
  }
  const asPreparation = quality(rows => rows.map(x => x.id === 'prep' ? { ...x, nodes: ['N1'] } : x.id === 's1' ? { ...x, nodes: ['N9'] } : x));
  assert.equal(asPreparation.reason, 'roadmap-time-node-kind-mismatch', 'delivery work cannot become already-spent preparation');
  assert.equal(asPreparation.node, 'N1');
});
test('dependencies-need-an-enforceable-order-for-non-slice-endpoints', () => {
  const base = qualitySection().dependencies;
  const record = qualityOptions([{ from: 'N1', to: 'X1' }]); record.options[0].nodes.push({ id: 'X1', kind: 'integration' });
  const value = qualitySection({ dependencies: [...base, { from: 'N1', to: 'X1' }] }); value.allocation[3].nodes.push('X1');
  const inverted = check(roadmap(value), expected({ options: record }));
  assert.equal(inverted.reason, 'roadmap-time-edge-inverted', 'delivery cannot depend on a later integration phase'); assert.equal(inverted.edge, 'N1>X1');
  const withEdge = [...base, { from: 'R1', to: 'G1' }];
  const sameRow = quality(null, withEdge, [{ from: 'R1', to: 'G1' }]);
  assert.equal(sameRow.reason, 'roadmap-time-edge-unmapped'); assert.equal(sameRow.edge, 'R1>G1');
  const split = rows => { const r = rows.map(x => x.id === 'review' ? { ...x, nodes: ['G1'] } : x); r.splice(5, 0, { id: 'review2', kind: 'review', ms: 100, nodes: ['R1'] }); return r; };
  assert.equal(quality(split, withEdge, [{ from: 'R1', to: 'G1' }]).valid, true, 'rows of the same kind follow allocation order');
  const reversed = rows => split(rows).map(x => x.id === 'review' ? { ...x, nodes: ['R1'] } : x.id === 'review2' ? { ...x, nodes: ['G1'] } : x);
  assert.equal(quality(reversed, withEdge, [{ from: 'R1', to: 'G1' }]).reason, 'roadmap-time-edge-unmapped');
  const copied = quality(rows => rows.map(x => x.id === 'integ' ? { ...x, nodes: [] } : x.id === 'review' ? { ...x, nodes: ['G1', 'R1', 'I1'] } : x));
  assert.equal(copied.reason, 'roadmap-time-node-kind-mismatch', 'a copied edge with a relabeled endpoint proves nothing');
});
test('source-graph-is-validated-as-a-dag-before-horizons-are-split', () => {
  const graphRule = (nodes, edges, linked = null) => {
    const record = { schema_version: 1, milestone: 'M001', options: [{ id: 'short', label: 'Curta', ceiling_ms: 10000, nodes, edges,
      positions: [{ id: 'P0', deferred: [], linked_task: linked }] }] };
    return expected({ options: record, selection: selection({ position_id: 'P0' }), contract: contract({ linked_task: linked ? { position_id: 'P0' } : null }) });
  };
  const nodes = [{ id: 'N1', kind: 'delivery' }, { id: 'N2', kind: 'delivery' }];
  const cycle = graphRule(nodes, [{ from: 'N1', to: 'N2' }, { from: 'N2', to: 'N1' }]);
  assert.deepEqual(cycle, { status: 'invalid', reason: 'roadmap-time-graph-cycle' });
  const oneSlice = qualitySection({ allocation: [{ id: 's1', kind: 'slice', slice: 'S01', ms: 1, nodes: ['N1', 'N2'] }, { id: 's2', kind: 'slice', slice: 'S02', ms: 1, nodes: [] }] });
  assert.equal(check(roadmap(oneSlice), cycle).reason, 'roadmap-time-graph-cycle', 'a cycle inside one slice is still invalid');
  const three = [...nodes, { id: 'N5', kind: 'delivery' }, { id: 'N6', kind: 'delivery' }];
  const confined = graphRule(three, [{ from: 'N5', to: 'N6' }, { from: 'N6', to: 'N5' }], { moved_scope: ['N5', 'N6'], criteria: {}, horizon: {} });
  assert.equal(confined.reason, 'roadmap-time-graph-cycle', 'a cycle confined to linked-task work is invalid');
  assert.equal(graphRule(three, [{ from: 'N1', to: 'N1' }]).reason, 'roadmap-time-graph-edge-invalid');
  assert.equal(graphRule(three, [{ from: 'N1', to: 'N2' }, { from: 'N1', to: 'N2' }]).reason, 'roadmap-time-graph-edge-invalid');
  assert.equal(graphRule(three, [{ from: 'N1', to: 'Z9' }]).reason, 'roadmap-time-graph-edge-invalid');
  assert.equal(graphRule(three, [{ from: 'N1' }]).reason, 'roadmap-time-graph-edge-invalid');
  assert.equal(graphRule([...nodes, { id: 'N1', kind: 'delivery' }], []).reason, 'roadmap-time-graph-node-invalid');
  assert.equal(graphRule(three, [{ from: 'N1', to: 'N2' }]).status, 'ready');
});
// A fixture shaped exactly like the T02 producer proposal: positions[], per-node depends/covers, scope-item
// deferrals and moved_scope, linked-task nodes, explicit unknown estimate and a custom ceiling.
function producerProposal() {
  const node = (id, kind, depends, covers) => ({ id, kind, title: 'Nó ' + id, phases: { implementation: 3 }, activities: ['trabalho'], judgment: null, depends, covers });
  const full = { id: 'P0', label: 'Escopo completo', status: 'viable', reason: 'cobre todo o escopo', strategy: 'serial', technical_choices: [], deliverables: [],
    nodes: [node('N1', 'delivery', [], ['SC1']), node('N2', 'delivery', ['N1'], ['SC2']), node('G1', 'gate', ['N2'], ['SC2']), node('N3', 'delivery', [], ['SC3']), node('N4', 'delivery', ['N2'], ['SC4'])],
    parallel_groups: [], verifications: [], review: [], risks: [], uncertainties: [], deferrals: [], linked_task: null };
  const reduced = { ...full, id: 'P1', label: 'Com tarefa ligada', deferrals: [{ scope_item: 'SC3', reason: 'adiado', consent: 'required' }],
    linked_task: { moved_scope: ['SC4'], criteria: { milestone: ['Entrega N1 e N2'], task: ['Entrega N4'] }, nodes: ['N4'], horizon: { low_ms: 1, high_ms: 2, ceiling_ms: 3 } } };
  return { schema_version: 1, scope_items: ['SC1', 'SC2', 'SC3', 'SC4'].map(i => ({ id: i, title: i, indispensable: true, source: 'SCOPE' })), recommended: 'P0', positions: [full, reduced,
    { ...full, id: 'P2', status: 'infeasible', reason: 'sem estimativa' }] };
}
test('producer-shaped-proposal-normalizes-covers-deferrals-and-linked-task-nodes', () => {
  const proposal = producerProposal(), [full, reduced] = proposal.positions;
  const graph = rt.sourceGraph({ id: 'short' }, reduced);
  assert.equal(graph.status, 'valid');
  assert.deepEqual(graph.deferred, ['N3'], 'the deferred scope item SC3 maps to the node that only covers it');
  assert.deepEqual(graph.linked_task.moved_scope, ['N4']); assert.deepEqual(graph.linked_task.scope_items, ['SC4']);
  assert.deepEqual(graph.linked_task.criteria, reduced.linked_task.criteria);
  assert.deepEqual(graph.nodes.find(n => n.id === 'G1').covers, ['SC2']);
  assert.deepEqual(graph.edges.map(e => e.from + '>' + e.to).sort(), ['G1>N2', 'N2>N1', 'N4>N2']);
  const rule = expected({ options: { schema_version: 1, milestone: 'M001', options: [{ id: 'short', label: 'Curta', ceiling_ms: 10000, positions: proposal.positions }] } });
  assert.equal(rule.status, 'ready', rule.reason); assert.deepEqual(rule.nodes.map(n => n.id), ['N1', 'N2', 'G1']);
  assert.deepEqual(rule.deferred, ['N3']); assert.deepEqual(rule.linked_task, { moved_scope: ['N4'] });
  assert.equal(check(roadmap(section()), rule).valid, true, 'the producer shape and the options shape yield the same conformance');
  const complete = expected({ options: { schema_version: 1, milestone: 'M001', options: [{ id: 'short', label: 'Curta', ceiling_ms: 10000, positions: [full] }] },
    selection: selection({ position_id: 'P0' }), contract: contract({ linked_task: null }) });
  assert.equal(complete.status, 'ready'); assert.equal(complete.nodes.length, 5); assert.equal(complete.linked_task, null);
  const cyclic = structuredClone(full); cyclic.nodes[0].depends = ['N2'];
  assert.equal(rt.sourceGraph({ id: 'short' }, cyclic).reason, 'roadmap-time-graph-cycle');
  assert.equal(rt.sourceGraph({ id: 'short' }, { ...full, nodes: [...full.nodes, full.nodes[0]] }).reason, 'roadmap-time-graph-node-invalid');
});
test('options-view-normalizes-the-materialized-record-once-and-keeps-unknown-estimates-unknown', () => {
  const proposal = producerProposal(), [full, reduced, longa] = proposal.positions;
  const record = { schema_version: 1, milestone: 'M001', proposal: { ...proposal, endpoint: { kind: 'verified-integrated-delivery', items: {} } },
    estimate: { positions: [{ position_id: 'P0', low_ms: 1, high_ms: 2, confidence: 'low', ceiling_ms: 10000, linked_task_horizon: null },
      { position_id: 'P1', low_ms: null, high_ms: null, confidence: 'low', ceiling_ms: null, linked_task_horizon: reduced.linked_task.horizon },
      { position_id: 'P2', low_ms: null, high_ms: null, confidence: 'low', ceiling_ms: null, linked_task_horizon: null }] }, inputs: {}, producer_basis: {} };
  const view = rt.optionsView(record);
  assert.equal(view.status, 'valid'); assert.deepEqual(view.options.map(o => o.id), ['P0', 'P1', 'P2']);
  assert.equal(view.options[0].ceiling_ms, 10000); assert.equal('ceiling_ms' in view.options[1], false, 'an unknown cap is not invented');
  assert.equal(view.options[1].positions[0].estimate.high_ms, null); assert.deepEqual(view.options[1].positions[0].linked_task.horizon, reduced.linked_task.horizon);
  const rule = expected({ options: record, selection: selection({ option_id: 'P1', position_id: 'P1' }), contract: contract({ option: { id: 'P1', options_sha256: OPT, label: 'x' } }) });
  assert.equal(rule.status, 'ready', rule.reason); assert.deepEqual(rule.deferred, ['N3']); assert.deepEqual(rule.linked_task, { moved_scope: ['N4'] });
  assert.equal(rt.optionsView({ ...record, estimate: { positions: [] } }).status, 'invalid');
  assert.equal(rt.optionsView({ ...record, proposal: { ...record.proposal, positions: [full, full] } }).status, 'invalid');
  assert.equal(rt.optionsView(null).status, 'invalid'); assert.equal(longa.status, 'infeasible');
});
test('present-malformed-edge-declarations-are-refused-on-either-level-and-absent-ones-are-not', () => {
  const option = () => structuredClone(optionsRecord().options[0]), position = o => o.positions[1];
  assert.equal(rt.sourceGraph(option(), position(option())).status, 'valid');
  for (const value of [{}, 'N2>N1', null, 7]) {
    for (const [name, build] of [
      ['option.edges', () => { const o = option(); o.edges = value; return [o, position(o)]; }],
      ['position.edges', () => { const o = option(); position(o).edges = value; return [o, position(o)]; }],
      ['option.edges beside position.nodes', () => { const o = option(); const p = position(o); p.nodes = o.nodes.map(n => ({ ...n, depends: [] })); o.edges = value; return [o, p]; }],
      ['position.edges beside position.nodes', () => { const o = option(); const p = position(o); p.nodes = o.nodes.map(n => ({ ...n, depends: [] })); p.edges = value; return [o, p]; }]]) {
      const graph = rt.sourceGraph(...build());
      assert.deepEqual(graph, { status: 'invalid', reason: 'roadmap-time-graph-edge-invalid' }, name);
    }
  }
  const o = option(); delete o.edges; const p = position(o); p.nodes = o.nodes.map(n => ({ ...n, depends: [] }));
  assert.equal(rt.sourceGraph(o, p).status, 'valid', 'absent edges stay valid beside position.nodes');
});
console.log(`PASS roadmap-time ${passed} named checks; pure validator, no disk`);
