#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { digest } = require('./forge-code-roots');
const questions = require('./forge-pending-questions');
const time = require('./forge-milestone-time');
const roots = [];
const M = 'M001', NOW = Date.parse('2026-11-01T12:00:00.000Z');
let serial = 0, passed = 0;
function owner(initialized = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-time-test-')); roots.push(cwd);
  if (initialized) fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
  return cwd;
}
function snapshot(cwd) {
  const result = {};
  function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
    result[path.relative(cwd, file)] = entry.isFile() ? [digest(fs.readFileSync(file)), stat.mtimeMs] : entry.isSymbolicLink() ? fs.readlinkSync(file) : 'directory';
    if (entry.isDirectory()) visit(file);
  } }
  visit(cwd); return result;
}
function rejectsUnchanged(cwd, code, callback) {
  const before = snapshot(cwd); assert.throws(callback, error => error.code === code, code);
  assert.deepStrictEqual(snapshot(cwd), before, 'refusal changed owner bytes or mtimes');
}
function payload() {
  return { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
    activated_at: new Date(NOW).toISOString(), preselection_started_at: new Date(NOW - 60000).toISOString(), ceiling_ms: 3600000,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(id => [id, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
}
function decision(cwd, kind, request, answer, overrides = {}) {
  const id = 'question-' + ++serial;
  const opened = questions.openQuestions({ cwd, unit: 'milestone-time/' + M + '-' + id, milestone: overrides.milestone || M,
    decision_set: overrides.set || 'milestone-time-' + kind, questions: [{ id, question: 'Escolha explícita?' }] });
  if (!overrides.pending) questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  let live = { reference: 'live-' + serial, status: 'resolved', answer, resolved_at: new Date(NOW).toISOString(), source: 'user-text',
    question: { identity_sha256: opened.identity_sha256, id }, ...overrides.live };
  const authority = time.createDecisionAuthority(() => live);
  const scope = { milestone: M, kind, request_sha256: digest(request), expires_at: NOW + 60000, ...overrides.scope };
  const handle = authority.issue(live.reference, scope, () => NOW);
  return { handle, live, scope, opened, revoke() { live = { ...live, status: 'pending' }; } };
}
function activate(cwd = owner()) {
  const contract = payload(), d = decision(cwd, 'activation', contract, 'option:balanced');
  const result = time.activateContract({ cwd, milestone: M, contract, handle: d.handle, now: NOW });
  return { cwd, contract, d, result };
}
function amendment(cwd, kind, patch, reason = 'Escolha explícita') {
  const request = { kind, reason, patch };
  const answer = kind === 'extension' ? `extend:${patch.ceiling_ms}` : kind === 'allocation' ? `allocation:${patch.allocation.roadmap_sha256}`
    : kind === 'scope-reduction' ? `reduce-scope:${patch.deferred_items.join(',')}` : 'continue-to-cap';
  return { request, d: decision(cwd, kind, request, answer) };
}
function amend(cwd, a) { return time.amendContract({ cwd, milestone: M, ...a.request, handle: a.d.handle, now: NOW }); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value) + '\n'); }
// S02 fixtures: enrollment, a materialized options record, an attested selection
// (activation + linked-task) and the ROADMAP time section. Records are synthetic.
const AUTH = 'create-without-auto-start';
function offered() {
  return { schema_version: 1, milestone: M, options: [
    { id: 'short', label: 'Curta', ceiling_ms: 3600000,
      nodes: [{ id: 'N1', kind: 'delivery' }, { id: 'N2', kind: 'delivery' }, { id: 'G1', kind: 'gate' }, { id: 'N3', kind: 'delivery' }, { id: 'N4', kind: 'delivery' }],
      edges: [{ from: 'N2', to: 'N1' }, { from: 'G1', to: 'N2' }, { from: 'N4', to: 'N2' }],
      positions: [{ id: 'P1', deferred: ['N3'], estimate: { low_ms: 1200000, high_ms: 1800000 }, linked_task: { moved_scope: ['N4'], criteria: { milestone: ['Entrega N1 e N2 verificada'], task: ['Entrega N4 verificada'] },
        horizon: { low_ms: 600000, high_ms: 1200000, ceiling_ms: 1800000 } } }, { id: 'P0', deferred: [], linked_task: null }] }] };
}
function enroll(cwd, source = 'owner') { return time.recordEnrollment({ cwd, milestone: M, source, now: NOW - 120000 }); }
function prepared(cwd = owner()) { enroll(cwd); const record = offered(); return { cwd, record, sha: time.recordOptions({ cwd, milestone: M, record }).options_sha256 }; }
function contractRequest(sha, authorization = AUTH) {
  const linked = offered().options[0].positions[0].linked_task;
  return { ...payload(), option: { id: 'short', options_sha256: sha, label: 'Curta' },
    linked_task: { position_id: 'P1', authorization, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon: linked.horizon, options_sha256: sha },
    chain_forecast: { low_ms: 1800000, high_ms: 3000000, basis: 'milestone-plus-linked-task' } };
}
function selectionInput(sha, authorization = AUTH) {
  return { choice: 'option', options_sha256: sha, option_id: 'short', position_id: 'P1', linked_task_authorization: authorization,
    contract_request: contractRequest(sha, authorization), rounds: [{ round: 1, outcome: 'answered' }] };
}
function linkedRequest(sha, authorization = AUTH) { return { milestone: M, options_sha256: sha, option_id: 'short', position_id: 'P1', authorization }; }
function select(cwd, sha) {
  const input = selectionInput(sha), activation = decision(cwd, 'activation', input.contract_request, 'option:short');
  const linked = decision(cwd, 'linked-task', linkedRequest(sha), 'linked-task:' + AUTH);
  const result = time.recordSelection({ cwd, milestone: M, selection: input, handles: { activation: activation.handle, 'linked-task': linked.handle }, now: NOW });
  return { input, activation, linked, result };
}
function delegatedSetup() {
  const { cwd, sha } = prepared(), s = select(cwd, sha);
  const activated = time.activateContract({ cwd, milestone: M, contract: s.input.contract_request, handle: s.activation.handle, now: NOW });
  const p = time.timePaths({ cwd, milestone: M });
  return { cwd, sha, p, base: digest(JSON.parse(fs.readFileSync(p.contract))), activated, s };
}
function timeSection(sha, base, overrides = {}) {
  return { schema_version: 1, option_id: 'short', position_id: 'P1', options_sha256: sha, contract_sha256: base,
    allocation: [{ id: 'prep', kind: 'preparation', ms: 500, nodes: [] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 3000, nodes: ['N1'] },
      { id: 's2', kind: 'slice', slice: 'S02', ms: 3000, nodes: ['N2'] }, { id: 'review', kind: 'review', ms: 1000, nodes: ['G1'] }],
    dependencies: [{ from: 'N2', to: 'N1' }, { from: 'G1', to: 'N2' }], deferred: ['N3'], linked_task: { moved_scope: ['N4'] }, ...overrides };
}
function roadmapText(value, options = {}) {
  return `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [${options.checked ? 'x' : ' '}] **S01: Primeira entrega** \`risk:low\` \`depends:[]\`\n`
    + `- [ ] **S02: Segunda entrega** \`risk:low\` \`depends:[${options.s02 ?? 'S01'}]\`\n${options.extraSlice || ''}\n`
    + `## Alocação de tempo\n\n\`\`\`json\n${typeof value === 'string' ? value : JSON.stringify(value, null, options.indent ?? 2)}\n\`\`\`\n`;
}
function writeRoadmap(cwd, value, options = {}) {
  const file = path.join(cwd, '.gsd/milestones', M, M + '-ROADMAP.md'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, roadmapText(value, options)); return file;
}
function delegate(cwd, extra = {}) { return time.recordDelegatedAllocation({ cwd, milestone: M, reason: 'Alocação técnica dentro da delegação', now: NOW, ...extra }); }
function link(target, at) { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); }
function test(name, callback) { callback(); passed++; console.log('PASS ' + name); }

try {
  test('exports-import-purity-and-lazy-owner-lock', () => {
    const expected = ['SCHEMA_VERSION', 'ENDPOINT_ITEMS', 'ITEM_STATES', 'AMENDMENT_KINDS', 'JOURNAL_TYPES', 'WAIT_CLASSES', 'timePaths', 'readContract', 'validateContract', 'createDecisionAuthority', 'activateContract', 'amendContract', 'appendJournal', 'readJournal', 'recordWarning', 'listWarnings', 'recordCheckpoint', 'readCheckpoints', 'main'];
    for (const name of expected) assert.ok(time[name] !== undefined, name);
    const file = require.resolve('./forge-milestone-time'), Module = require('module'), previous = Module._load;
    let localImports = [];
    Module._load = function (id, parent, ...args) { if (parent?.filename === file && id.startsWith('.')) localImports.push(id); return previous.call(this, id, parent, ...args); };
    const reads = ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'lstatSync', 'mkdirSync'];
    const saved = Object.fromEntries(reads.map(k => [k, fs[k]]));
    const source = fs.readFileSync(file, 'utf8');
    try {
      for (const k of reads) fs[k] = () => { throw new Error('import I/O ' + k); };
      const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths; mod._compile(source, file);
    } finally { for (const k of reads) fs[k] = saved[k]; Module._load = previous; }
    assert.deepStrictEqual(localImports, [], 'local dependencies must be lazy at import');
  });
  test('proposal-document-sha256-preserved-owner-contribution', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '../docs/milestone-time-options.md'));
    assert.strictEqual(digest(bytes), 'aa2d8a09f8d129ba1370506a6fda375627ed145225cb64280358315b6abbbb48');
  });
  test('declared-artifacts-exist-minimum-lines-and-no-module-stubs', () => {
    for (const [file, minimum] of [['shared/schemas/forge-milestone-time.schema.json', 60], ['scripts/forge-milestone-time.js', 260], ['scripts/forge-milestone-time.test.js', 220], ['docs/milestone-time-options.md', 100]]) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.ok(source.split('\n').length >= minimum, file);
      if (file === 'scripts/forge-milestone-time.js') assert.ok(!/TODO|TBD|FIXME/.test(source));
    }
  });
  test('absent-empty-and-uninitialized-owner-no-writes', () => {
    const cwd = owner(false), before = snapshot(cwd);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.strictEqual(time.appendJournal({ cwd, milestone: M, record: {} }).status, 'no-contract');
    assert.deepStrictEqual(snapshot(cwd), before);
    const contract = payload();
    rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.activateContract({ cwd, milestone: M, contract }));
    fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
    fs.mkdirSync(time.timePaths({ cwd, milestone: M }).directory, { recursive: true });
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    fs.writeFileSync(path.join(time.timePaths({ cwd, milestone: M }).directory, 'orphan'), 'x');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).reason, 'time-contract-base-missing');
  });
  test('attested-activation-layout-idempotence-and-no-retroactive-roadmap', () => {
    const { cwd, contract, d, result } = activate();
    assert.strictEqual(result.status, 'valid'); assert.strictEqual(result.version, 1);
    assert.ok(time.timePaths({ cwd, milestone: M }).contract.includes(path.join('.gsd', 'forge', 'time', M)));
    assert.strictEqual(time.validateContract(result.contract).valid, true);
    const before = snapshot(cwd);
    assert.deepStrictEqual(time.activateContract({ cwd, milestone: M, contract, handle: d.handle, now: NOW }), result);
    assert.deepStrictEqual(snapshot(cwd), before);
    const different = { ...contract, ceiling_ms: 5 }, dd = decision(cwd, 'activation', different, 'option:balanced');
    rejectsUnchanged(cwd, 'time-contract-conflict', () => time.activateContract({ cwd, milestone: M, contract: different, handle: dd.handle, now: NOW }));
    const other = owner(), c = payload(), od = decision(other, 'activation', c, 'option:balanced');
    write(path.join(other, '.gsd/milestones', M, M + '-ROADMAP.md'), {});
    rejectsUnchanged(other, 'time-contract-roadmap-exists', () => time.activateContract({ cwd: other, milestone: M, contract: c, handle: od.handle, now: NOW }));
  });
  test('opaque-authority-missing-serialized-expired-foreign-revoked-and-edited-json-zero-writes', () => {
    const cwd = owner(), contract = payload(), d = decision(cwd, 'activation', contract, 'option:balanced');
    for (const handle of [null, {}, JSON.parse(JSON.stringify(d.handle)), { approved: true }])
      rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.activateContract({ cwd, milestone: M, contract, handle, now: NOW }));
    rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.activateContract({ cwd, milestone: M, contract, handle: d.handle, now: NOW + 60000 }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', () => time.activateContract({ cwd, milestone: 'M002', contract: { ...contract, milestone: 'M002' }, handle: d.handle, now: NOW }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', () => time.activateContract({ cwd, milestone: M, contract: { ...contract, ceiling_ms: 10 }, handle: d.handle, now: NOW }));
    d.revoke(); rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.activateContract({ cwd, milestone: M, contract, handle: d.handle, now: NOW }));
    for (const overrides of [{ pending: true }, { milestone: 'M002' }, { set: 'foreign-decision' }]) {
      const x = decision(cwd, 'activation', contract, 'option:balanced', overrides);
      rejectsUnchanged(cwd, 'time-decision-scope-mismatch', () => time.activateContract({ cwd, milestone: M, contract, handle: x.handle, now: NOW }));
    }
    const mismatch = decision(cwd, 'activation', contract, 'operator-ceiling:7');
    rejectsUnchanged(cwd, 'time-decision-answer-mismatch', () => time.activateContract({ cwd, milestone: M, contract, handle: mismatch.handle, now: NOW }));
    const file = path.join(cwd, '.gsd/forge/questions', d.opened.identity_sha256 + '.json');
    const edited = JSON.parse(fs.readFileSync(file)); edited.approved = true; write(file, edited);
    rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.activateContract({ cwd, milestone: M, contract, handle: { reference: d.live.reference }, now: NOW }));
    const badAuthority = time.createDecisionAuthority(() => ({ ...d.live, source: 'prompt' }));
    assert.throws(() => badAuthority.issue(d.live.reference, d.scope, () => NOW), /time-decision-attestation-required/);
    assert.throws(() => time.createDecisionAuthority(() => d.live).issue(d.live.reference, { ...d.scope, expires_at: NOW + 3600001 }, () => NOW), /time-decision-attestation-required/);
    assert.throws(() => time.createDecisionAuthority(() => d.live).issue(d.live.reference, d.scope, () => NaN), /time-decision-attestation-required/);
  });
  test('owner-missing-ids-and-all-path-components-refuse-links', () => {
    for (const milestone of ['../M001', 'M001/escape', 'garbage']) assert.throws(() => time.timePaths({ cwd: owner(), milestone }), /time-work-id-invalid/);
    assert.throws(() => time.timePaths({ cwd: owner(), milestone: 'TASK-001' }), /time-work-kind-unsupported/);
    const { cwd } = activate(), p = time.timePaths({ cwd, milestone: M });
    const dest = owner();
    fs.renameSync(p.directory, path.join(dest, 'moved'));
    fs.symlinkSync(path.join(dest, 'moved'), p.directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).reason, 'time-path-link');
    rejectsUnchanged(cwd, 'time-path-link', () => time.appendJournal({ cwd, milestone: M, record: { type: 'presence', session_sha256: null, boundary: 'next', at: new Date(NOW).toISOString() } }));
    const empty = owner(false), c = payload(), attestedOwner = owner(), d = decision(attestedOwner, 'activation', c, 'option:balanced');
    rejectsUnchanged(empty, 'time-owner-missing', () => time.activateContract({ cwd: empty, milestone: M, contract: c, handle: d.handle, now: NOW }));
    for (const relative of ['.gsd', '.gsd/forge', '.gsd/forge/time']) {
      const targetOwner = activate().cwd, target = path.join(targetOwner, relative), moved = path.join(owner(), 'moved');
      fs.renameSync(target, moved); fs.symlinkSync(moved, target, process.platform === 'win32' ? 'junction' : 'dir');
      assert.strictEqual(time.readContract({ cwd: targetOwner, milestone: M }).reason, 'time-path-link');
      rejectsUnchanged(targetOwner, 'time-path-link', () => time.recordWarning({ cwd: targetOwner, milestone: M, record: { id: 'unsafe' } }));
    }
  });
  test('schema-required-enums-and-validation-agree', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/schemas/forge-milestone-time.schema.json'))), { result } = activate();
    assert.strictEqual(schema.$id, 'urn:forge:milestone-time:v1');
    result.contract.allocation = { roadmap_sha256: 'a'.repeat(64), items: [{ id: 'review', kind: 'review', ms: 1 }] };
    assert.deepStrictEqual(schema.$defs.itemState.enum, [...time.ITEM_STATES]);
    assert.deepStrictEqual(schema.properties.endpoint.properties.items.required, [...time.ENDPOINT_ITEMS]);
    assert.deepStrictEqual(schema.$defs.decision.properties.source.enum, ['user-text', 'tool-answer']);
    function checkRequired(spec, value, root) {
      if (!spec || value === null) return;
      if (spec.$ref) spec = schema.$defs[spec.$ref.split('/').pop()];
      if (spec.oneOf) { const variant = spec.oneOf.find(v => v.type === typeof value); if (variant) checkRequired(variant, value, root); return; }
      if (spec.type === 'array') { for (const row of value) checkRequired(spec.items, row, root); return; }
      for (const key of spec.required || []) { const copy = structuredClone(root); let target = copy;
        const locate = (node, candidate) => { if (candidate === value) return node; if (!candidate || typeof candidate !== 'object') return null;
          for (const k of Object.keys(candidate)) { const found = locate(node[k], candidate[k]); if (found) return found; } return null; };
        target = locate(copy, root); delete target[key]; assert.strictEqual(time.validateContract(copy).valid, false, 'required ' + key); }
      for (const [key, child] of Object.entries(spec.properties || {})) if (value[key] !== undefined && value[key] !== null) checkRequired(child, value[key], root);
    }
    checkRequired(schema, result.contract, result.contract);
    const kinds = schema.properties.allocation.oneOf[1].properties.items.items.properties.kind.enum;
    for (const kind of [...kinds, 'unexpected']) {
      const c = structuredClone(result.contract); c.allocation.items[0].kind = kind;
      assert.strictEqual(time.validateContract(c).valid, kinds.includes(kind));
    }
    for (const source of [...schema.$defs.decision.properties.source.enum, 'prompt']) {
      const c = structuredClone(result.contract); c.decision.source = source;
      assert.strictEqual(time.validateContract(c).valid, source !== 'prompt');
    }
    for (const milestone of ['M1', 'm001', 'M-20261101120000-', 'M-20261101-120000-ABC']) {
      const c = structuredClone(result.contract); c.milestone = milestone;
      assert.ok(new RegExp(schema.$defs.milestone.pattern).test(milestone)); assert.ok(time.validateContract(c).valid);
    }
    for (const state of time.ITEM_STATES) { const c = structuredClone(result.contract); c.endpoint.items.publication = state; assert.ok(time.validateContract(c).valid); }
    for (const mutate of [c => c.extra = 1, c => c.endpoint.items.extra = 'pending', c => c.endpoint.items.publication = 'bogus', c => c.linked_task = {}, c => c.chain_forecast = {}, c => c.clock_policy.version = 2, c => c.ceiling_ms = -1, c => c.activated_at = 'yesterday', c => c.milestone = 'TASK-001']) {
      const c = structuredClone(result.contract); mutate(c); assert.strictEqual(time.validateContract(c).valid, false);
    }
  });
  test('amendments-chain-extension-allocation-scope-reduction-continue-and-conflict', () => {
    const { cwd, contract, d } = activate(), prior = time.readContract({ cwd, milestone: M });
    time.recordCheckpoint({ cwd, milestone: M, record: { version: 1 } });
    const a = amendment(cwd, 'extension', { ceiling_ms: 7200000 });
    const second = amend(cwd, a); assert.strictEqual(second.version, 2); assert.strictEqual(second.contract.ceiling_ms, 7200000);
    assert.strictEqual(second.chain[1].previous_sha256, prior.sha256);
    const before = snapshot(cwd); assert.deepStrictEqual(amend(cwd, a), second); assert.deepStrictEqual(snapshot(cwd), before);
    const roadmap = path.join(cwd, '.gsd/milestones', M, M + '-ROADMAP.md'); write(roadmap, { slices: ['S01'] });
    const allocation = { roadmap_sha256: digest(fs.readFileSync(roadmap)), items: [{ id: 'slice-one', kind: 'slice', slice: 'S01', ms: 100 }] };
    assert.strictEqual(amend(cwd, amendment(cwd, 'allocation', { allocation })).contract.allocation.items[0].kind, 'slice');
    const reduced = amend(cwd, amendment(cwd, 'scope-reduction', { deferred_items: ['publication', 'S02', 'feature-extra'] }));
    assert.strictEqual(reduced.contract.endpoint.items.publication, 'deferred');
    assert.deepStrictEqual(reduced.chain.at(-1).patch.deferred_items, ['publication', 'S02', 'feature-extra']);
    assert.strictEqual(amend(cwd, amendment(cwd, 'continue-to-cap', {})).version, 5);
    assert.strictEqual(time.activateContract({ cwd, milestone: M, contract, handle: d.handle, now: NOW }).version, 5);
    assert.strictEqual(time.recordCheckpoint({ cwd, milestone: M, record: { version: 1 } }).record.version, 1);
    const lower = amendment(cwd, 'extension', { ceiling_ms: 1 });
    rejectsUnchanged(cwd, 'time-amendment-invalid', () => amend(cwd, lower));
    const wrong = amendment(cwd, 'allocation', { allocation: { ...allocation, roadmap_sha256: 'b'.repeat(64) } });
    rejectsUnchanged(cwd, 'time-allocation-roadmap-mismatch', () => amend(cwd, wrong));
    const conflict = { ...a.request, reason: 'Mudou' };
    assert.throws(() => time.amendContract({ cwd, milestone: M, ...conflict, handle: a.d.handle, now: NOW }), /time-decision-scope-mismatch/);
    const conflictHandle = time.createDecisionAuthority(() => a.d.live).issue(a.d.live.reference, { ...a.d.scope, request_sha256: digest(conflict) }, () => NOW);
    rejectsUnchanged(cwd, 'time-decision-conflict', () => time.amendContract({ cwd, milestone: M, ...conflict, handle: conflictHandle, now: NOW }));
  });
  test('contract-corruption-bounds-missing-duplicate-versions-hashes-fields-and-foreign-work', () => {
    const changes = [
      ['time-contract-json-invalid', (p) => fs.writeFileSync(p.contract, '{')],
      ['time-source-too-large', (p) => fs.writeFileSync(p.contract, ' '.repeat(256 * 1024 + 1))],
      ['time-contract-schema-invalid', (p, c) => write(p.contract, { ...c, extra: true })],
      ['time-contract-milestone-mismatch', (p, c) => write(p.contract, { ...c, milestone: 'M002' })],
      ['time-amendment-sequence-invalid', (p) => fs.renameSync(path.join(p.amendments, '0002.json'), path.join(p.amendments, '0003.json'))],
      ['time-amendment-chain-invalid', (p) => { const f = path.join(p.amendments, '0002.json'), v = JSON.parse(fs.readFileSync(f)); v.previous_sha256 = '0'.repeat(64); write(f, v); }],
      ['time-amendment-sequence-invalid', (p) => fs.copyFileSync(path.join(p.amendments, '0002.json'), path.join(p.amendments, '00002.json'))],
      ['time-source-too-large', (p) => fs.writeFileSync(path.join(p.amendments, '0002.json'), ' '.repeat(64 * 1024 + 1))],
      ['time-amendment-limit', (p) => { for (let n = 3; n < 259; n++) write(path.join(p.amendments, String(n).padStart(4, '0') + '.json'), {}); }]
    ];
    for (const [reason, change] of changes) { const { cwd } = activate(); amend(cwd, amendment(cwd, 'extension', { ceiling_ms: 7200000 })); const p = time.timePaths({ cwd, milestone: M });
      change(p, JSON.parse(fs.readFileSync(p.contract))); const before = snapshot(cwd), result = time.readContract({ cwd, milestone: M });
      assert.strictEqual(result.status, 'invalid', reason); assert.strictEqual(result.reason, reason); assert.ok(!result.contract); assert.deepStrictEqual(snapshot(cwd), before); }
  });
  test('journal-closed-presence-waits-bounds-conflicts-and-no-raw-session', () => {
    const { cwd } = activate(), p = time.timePaths({ cwd, milestone: M }), at = new Date(NOW).toISOString();
    const presence = { type: 'presence', session_sha256: digest('dummy-private-session'), boundary: 'session-start', at };
    const start = { type: 'wait-start', wait_id: 'human-1', class: 'human', source: { kind: 'question', ref: 'question-1' }, at };
    const end = { ...start, type: 'wait-end' };
    for (const record of [presence, start, end]) assert.strictEqual(time.appendJournal({ cwd, milestone: M, record }).status, 'valid');
    assert.strictEqual(time.readJournal({ cwd, milestone: M }).records.length, 3);
    assert.ok(!fs.readFileSync(p.journal, 'utf8').includes('dummy-private-session'));
    for (const record of [{ ...presence, session: 'raw' }, { ...presence, session_sha256: 'raw' }, { ...start, class: 'invalid' }, { ...start, source: null }, { ...start, source: { kind: 'file', ref: 'C:\\private\\secret' } }, { ...start, source: { kind: 'file', ref: '/secret' } }])
      rejectsUnchanged(cwd, 'time-journal-record-invalid', () => time.appendJournal({ cwd, milestone: M, record }));
    rejectsUnchanged(cwd, 'time-journal-wait-conflict', () => time.appendJournal({ cwd, milestone: M, record: { ...start, class: 'ci' } }));
    const bytes = fs.readFileSync(p.journal);
    for (const [value, reason] of [['{\n', 'time-journal-json-invalid'], ['x'.repeat(32769) + '\n', 'time-journal-line-limit'], [' '.repeat(2 * 1024 * 1024 + 1), 'time-source-too-large'], ['{}\n'.repeat(50001), 'time-journal-record-limit'], [JSON.stringify({ ...start, source: null }) + '\n', 'time-journal-record-invalid']]) {
      fs.writeFileSync(p.journal, value); assert.strictEqual(time.readJournal({ cwd, milestone: M }).reason, reason); }
    fs.writeFileSync(p.journal, bytes);
  });
  test('interrupted-publication-leaves-history-intact-and-resumes-under-owner-lock', () => {
    const { cwd, contract } = activate(), p = time.timePaths({ cwd, milestone: M });
    const staged = () => fs.existsSync(p.staging) ? fs.readdirSync(p.staging) : [];
    // A separate process exits abruptly after staging and before the hard link.
    // No finally runs: both staging and its dead owner mutex remain for recovery.
    const warning = { id: 'forecast-1', kind: 'at-risk', at: new Date(NOW).toISOString() };
    const script = `const fs=require('fs');fs.linkSync=()=>process.exit(77);require(${JSON.stringify(require.resolve('./forge-milestone-time'))})`
      + `.recordWarning({cwd:${JSON.stringify(cwd)},milestone:${JSON.stringify(M)},record:${JSON.stringify(warning)}});`;
    const crashed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(crashed.status, 77); assert.strictEqual(crashed.stderr, '');
    assert.strictEqual(staged().length, 1, 'the interrupted staging file exists outside committed directories');
    assert.ok(!fs.existsSync(p.warnings) || fs.readdirSync(p.warnings).length === 0);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'valid');
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).status, 'valid');
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).records.length, 0);
    time.recordWarning({ cwd, milestone: M, record: warning });
    assert.deepStrictEqual(staged(), [], 'the next publication reconciles the leftover');
    assert.strictEqual(fs.readFileSync(path.join(p.warnings, 'forecast-1.json'), 'utf8'), JSON.stringify(warning) + '\n');
    // The same interruption for an amendment and a checkpoint, simulated in-process.
    const interrupt = callback => {
      const link = fs.linkSync, unlink = fs.unlinkSync;
      fs.linkSync = () => { throw Object.assign(new Error('killed'), { code: 'EKILLED' }); };
      fs.unlinkSync = file => { if (!String(file).endsWith('.tmp')) unlink(file); };
      try { assert.throws(callback, e => e.code === 'EKILLED'); } finally { fs.linkSync = link; fs.unlinkSync = unlink; }
    };
    const a = amendment(cwd, 'extension', { ceiling_ms: 7200000 });
    interrupt(() => amend(cwd, a));
    assert.strictEqual(staged().length, 1);
    assert.deepStrictEqual(fs.existsSync(p.amendments) ? fs.readdirSync(p.amendments) : [], []);
    const intact = time.readContract({ cwd, milestone: M }); assert.strictEqual(intact.status, 'valid'); assert.strictEqual(intact.version, 1);
    assert.strictEqual(intact.contract.ceiling_ms, contract.ceiling_ms);
    const resumed = amend(cwd, a); assert.strictEqual(resumed.version, 2); assert.strictEqual(resumed.contract.ceiling_ms, 7200000);
    assert.deepStrictEqual(staged(), []);
    assert.strictEqual(amend(cwd, a).version, 2, 'replay is idempotent');
    const checkpoint = { version: 2, drained: true, overshoot_ms: 25 };
    interrupt(() => time.recordCheckpoint({ cwd, milestone: M, record: checkpoint }));
    assert.strictEqual(time.readCheckpoints({ cwd, milestone: M }).status, 'valid');
    time.recordCheckpoint({ cwd, milestone: M, record: checkpoint });
    assert.strictEqual(time.readCheckpoints({ cwd, milestone: M }).records.length, 1); assert.deepStrictEqual(staged(), []);
    // Unexpected committed names are still rejected.
    fs.writeFileSync(path.join(p.warnings, 'forecast-2.json.1.x.tmp'), '{}\n');
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).reason, 'time-record-invalid');
    fs.unlinkSync(path.join(p.warnings, 'forecast-2.json.1.x.tmp'));
    fs.writeFileSync(path.join(p.amendments, '0003.json.1.x.tmp'), '{}\n');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).reason, 'time-amendment-sequence-invalid');
  });
  test('warnings-checkpoints-exclusive-idempotent-limited-and-read-only', () => {
    const { cwd } = activate(), p = time.timePaths({ cwd, milestone: M });
    const warning = { id: 'forecast-1', kind: 'at-risk', at: new Date(NOW).toISOString() }, checkpoint = { version: 1, drained: true, overshoot_ms: 25 };
    time.recordWarning({ cwd, milestone: M, record: warning }); time.recordCheckpoint({ cwd, milestone: M, record: checkpoint });
    const before = snapshot(cwd);
    time.recordWarning({ cwd, milestone: M, record: warning }); time.recordCheckpoint({ cwd, milestone: M, record: checkpoint });
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).records.length, 1); assert.strictEqual(time.readCheckpoints({ cwd, milestone: M }).records.length, 1);
    time.readContract({ cwd, milestone: M }); time.readJournal({ cwd, milestone: M }); assert.deepStrictEqual(snapshot(cwd), before);
    rejectsUnchanged(cwd, 'time-record-conflict', () => time.recordWarning({ cwd, milestone: M, record: { ...warning, kind: 'exceeds' } }));
    rejectsUnchanged(cwd, 'time-record-conflict', () => time.recordCheckpoint({ cwd, milestone: M, record: { ...checkpoint, drained: false } }));
    for (let n = 2; n <= 257; n++) write(path.join(p.warnings, 'warning-' + n + '.json'), { id: 'warning-' + n });
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).reason, 'time-record-limit');
    for (let n = 2; n <= 257; n++) write(path.join(p.checkpoints, n + '.json'), { version: n });
    assert.strictEqual(time.readCheckpoints({ cwd, milestone: M }).reason, 'time-record-limit');
  });
  test('worker-evidence-single-owner-lock-coverage-last-idempotent-conflict-and-no-contract', () => {
    const { cwd } = activate(), p = time.timePaths({ cwd, milestone: M });
    const locking = require('./forge-artifact-reconciliation'), original = locking.withOwnerLock, link = fs.linkSync;
    const observation = { id: 'a'.repeat(64), milestone: M, duration_ms: 4 }, coverage = { id: 'b'.repeat(64), milestone: M, observations: ['a'.repeat(64)] };
    let calls = 0, order = [];
    locking.withOwnerLock = (root, callback) => { calls++; return original(root, callback); };
    fs.linkSync = (from, to) => { order.push(path.basename(path.dirname(to))); return link(from, to); };
    try {
      assert.deepStrictEqual(time.recordWorkerEvidence({ cwd, milestone: M, observations: [observation, observation], coverage }),
        { status: 'valid', published: 2, unchanged: 1 });
      assert.strictEqual(calls, 1); assert.deepStrictEqual(order, ['observations', 'coverage']);
    } finally { locking.withOwnerLock = original; fs.linkSync = link; }
    const before = snapshot(cwd);
    assert.deepStrictEqual(time.recordWorkerEvidence({ cwd, milestone: M, observations: [observation], coverage }), { status: 'valid', published: 0, unchanged: 2 });
    assert.deepStrictEqual(snapshot(cwd), before);
    assert.strictEqual(time.readObservations({ cwd, milestone: M }).records.length, 1); assert.strictEqual(time.readCoverage({ cwd, milestone: M }).records.length, 1);
    rejectsUnchanged(cwd, 'time-record-conflict', () => time.recordWorkerEvidence({ cwd, milestone: M, observations: [{ ...observation, duration_ms: 5 }], coverage }));
    rejectsUnchanged(cwd, 'time-record-invalid', () => time.recordWorkerEvidence({ cwd, milestone: M, observations: [{ ...observation, path: '/private/session' }], coverage }));
    assert.ok(fs.existsSync(path.join(p.observations, 'a'.repeat(64) + '.json')));
    const empty = owner(), untouched = snapshot(empty);
    assert.throws(() => time.recordWorkerEvidence({ cwd: empty, milestone: M, observations: [], coverage }), e => e.code === 'time-contract-required');
    assert.deepStrictEqual(snapshot(empty), untouched);
    assert.strictEqual(time.readObservations({ cwd: empty, milestone: M }).status, 'no-contract');
  });
  test('canonical-owner-lock-fault-and-exclusive-publication-preserve-history', () => {
    const { cwd } = activate(), p = time.timePaths({ cwd, milestone: M });
    const locking = require('./forge-artifact-reconciliation'), original = locking.withOwnerLock, append = fs.appendFileSync, link = fs.linkSync;
    let calls = 0;
    locking.withOwnerLock = (root, callback) => { assert.strictEqual(root, cwd); calls++; return original(root, callback); };
    try {
      const a = amendment(cwd, 'extension', { ceiling_ms: 7200000 });
      const before = snapshot(cwd);
      fs.linkSync = () => { throw Object.assign(new Error('injected publication fault'), { code: 'EIO' }); };
      assert.throws(() => amend(cwd, a), /injected/); fs.linkSync = link;
      assert.deepStrictEqual(snapshot(cwd), before); assert.strictEqual(amend(cwd, a).version, 2);
      time.recordWarning({ cwd, milestone: M, record: { id: 'lock-proof' } });
      time.recordCheckpoint({ cwd, milestone: M, record: { version: 2 } });
      fs.appendFileSync = () => { throw Object.assign(new Error('injected append fault'), { code: 'EIO' }); };
      const previous = snapshot(cwd);
      assert.throws(() => time.appendJournal({ cwd, milestone: M, record: { type: 'presence', session_sha256: null, boundary: 'next', at: new Date(NOW).toISOString() } }), /injected/);
      assert.deepStrictEqual(snapshot(cwd), previous); fs.appendFileSync = append;
      assert.ok(calls >= 5); assert.ok(fs.existsSync(p.contract));
      original(cwd, () => rejectsUnchanged(cwd, 'LOCK_BUSY', () => time.recordWarning({ cwd, milestone: M, record: { id: 'concurrent-writer' } })));
    } finally { locking.withOwnerLock = original; fs.appendFileSync = append; fs.linkSync = link; }
  });
  test('stable-bounded-reader-reused-for-contract-amendments-journal-warnings-checkpoints', () => {
    const source = require('./forge-autonomy-sources'), original = source.readBoundedStableFile, observed = [];
    source.readBoundedStableFile = (file, limit, opts) => { observed.push([file, limit]); return original(file, limit, opts); };
    try {
      const { cwd } = activate(); amend(cwd, amendment(cwd, 'extension', { ceiling_ms: 7200000 }));
      time.appendJournal({ cwd, milestone: M, record: { type: 'presence', session_sha256: null, boundary: 'next', at: new Date(NOW).toISOString() } });
      time.recordWarning({ cwd, milestone: M, record: { id: 'bounded' } });
      time.recordCheckpoint({ cwd, milestone: M, record: { version: 2 } });
      time.readJournal({ cwd, milestone: M }); time.listWarnings({ cwd, milestone: M }); time.readCheckpoints({ cwd, milestone: M });
      for (const [name, limit] of [['contract.json', 256 * 1024], ['0002.json', 64 * 1024], ['journal.jsonl', 2 * 1024 * 1024], ['bounded.json', 64 * 1024], ['2.json', 64 * 1024]])
        assert.ok(observed.some(([file, bytes]) => path.basename(file) === name && bytes === limit), name);
      const before = snapshot(cwd);
      source.readBoundedStableFile = () => ({ error: 'source_changed_during_read' });
      assert.strictEqual(time.readContract({ cwd, milestone: M }).reason, 'time-source-unstable');
      assert.deepStrictEqual(snapshot(cwd), before);
    } finally { source.readBoundedStableFile = original; }
  });
  test('cli-show-presence-waits-and-imported-answer-cannot-decide', () => {
    const { cwd } = activate(), cli = path.join(__dirname, 'forge-milestone-time.js');
    const run = (...args) => spawnSync(process.execPath, [cli, '--cwd', cwd, '--milestone', M, '--json', ...args], { encoding: 'utf8', windowsHide: true });
    let r = run('--show'); assert.strictEqual(r.status, 0, r.stderr); assert.ok(!r.stdout.includes(cwd)); JSON.parse(r.stdout);
    assert.strictEqual(run('--presence', 'next', '--session', 'dummy-session').status, 0);
    assert.strictEqual(run('--wait-start', 'cli-wait', '--class', 'ci', '--source-kind', 'check', '--source-ref', 'build').status, 0);
    assert.strictEqual(run('--wait-end', 'cli-wait', '--class', 'ci', '--source-kind', 'check', '--source-ref', 'build').status, 0);
    const request = { kind: 'extension', reason: 'Extensão explícita', patch: { ceiling_ms: 7200000 } }, d = decision(cwd, 'extension', request, 'extend:7200000');
    const importedFile = path.join(cwd, '.gsd/forge/questions', d.opened.identity_sha256 + '.json');
    const imported = JSON.parse(fs.readFileSync(importedFile)); imported.approved = true; imported.imported = true;
    write(importedFile, imported);
    const before = snapshot(cwd);
    r = run('--extend', '--ceiling-ms', '7200000', '--question-identity', d.opened.identity_sha256, '--question-id', d.live.question.id);
    assert.strictEqual(r.status, 3); assert.strictEqual(JSON.parse(r.stdout).reason, 'time-decision-attestation-required');
    assert.strictEqual(run('--decide', 'continue-to-cap').status, 3); assert.strictEqual(run('--decide', 'reduce-scope').status, 3);
    assert.deepStrictEqual(snapshot(cwd), before);
    assert.strictEqual(run('--unknown').status, 2); assert.strictEqual(run('--show', '--presence', 'next').status, 2);
  });
  test('s02-exports-closed-sets-public-data-and-declared-artifacts', () => {
    for (const name of ['DECISION_KINDS', 'PRE_ACTIVATION_ENTRIES', 'LINKED_TASK_AUTHORIZATIONS', 'isPublicData', 'recordEnrollment', 'readEnrollment', 'recordOptions',
      'readOptions', 'listOptions', 'recordSelection', 'readSelection', 'verifyDecision', 'recordDelegatedAllocation', 'roadmapIdentity', 'readObservations', 'readCoverage', 'recordWorkerEvidence'])
      assert.ok(time[name] !== undefined, name);
    assert.deepStrictEqual([...time.DECISION_KINDS], ['activation', 'extension', 'allocation', 'scope-reduction', 'continue-to-cap', 'linked-task']);
    assert.deepStrictEqual([...time.PRE_ACTIVATION_ENTRIES], ['enrollment.json', 'options', 'selection.json']);
    assert.deepStrictEqual([...time.LINKED_TASK_AUTHORIZATIONS], ['create-and-start-after-proven-completion', 'create-without-auto-start', 'none']);
    assert.ok(Object.isFrozen(time.DECISION_KINDS) && Object.isFrozen(time.PRE_ACTIVATION_ENTRIES) && Object.isFrozen(time.LINKED_TASK_AUTHORIZATIONS));
    assert.strictEqual(time.isPublicData({ a: ['ok'] }), true);
    for (const value of ['C:\\private', ' /etc/passwd', 'token: x', { session: 'raw' }, { constructor: 1 }]) assert.strictEqual(time.isPublicData(value), false);
    for (const [file, minimum] of [['scripts/forge-milestone-time.js', 520], ['scripts/forge-milestone-time.test.js', 540], ['shared/schemas/forge-milestone-time.schema.json', 140]]) {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); assert.ok(source.split('\n').length >= minimum, file);
    }
  });
  test('enrollment-immutable-idempotent-refusals-and-absent-versus-base-missing', () => {
    const cwd = owner(), p = time.timePaths({ cwd, milestone: M });
    assert.deepStrictEqual(time.readEnrollment({ cwd, milestone: M }), { status: 'absent' });
    const first = enroll(cwd, 'forge-new-milestone');
    assert.strictEqual(first.status, 'valid'); assert.deepStrictEqual(Object.keys(first.enrollment), ['schema_version', 'milestone', 'enrolled_at', 'source']);
    assert.strictEqual(first.enrollment.enrolled_at, new Date(NOW - 120000).toISOString()); assert.ok(fs.existsSync(path.join(p.directory, 'enrollment.json')));
    const before = snapshot(cwd);
    assert.deepStrictEqual(enroll(cwd, 'forge-auto'), first, 'repeat keeps the original source'); assert.deepStrictEqual(snapshot(cwd), before);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.strictEqual(time.readJournal({ cwd, milestone: M }).status, 'no-contract');
    assert.strictEqual(time.appendJournal({ cwd, milestone: M, record: {} }).status, 'no-contract');
    assert.strictEqual(time.listWarnings({ cwd, milestone: M }).status, 'no-contract');
    rejectsUnchanged(cwd, 'time-contract-required', () => time.recordWarning({ cwd, milestone: M, record: { id: 'w' } }));
    rejectsUnchanged(cwd, 'time-contract-required', () => time.recordCheckpoint({ cwd, milestone: M, record: { version: 1 } }));
    assert.deepStrictEqual(snapshot(cwd), before);
    for (const [source, now] of [['prompt', NOW], [undefined, NOW], ['owner', NaN]]) rejectsUnchanged(cwd, 'time-enrollment-invalid', () => time.recordEnrollment({ cwd, milestone: M, source, now }));
    const missing = owner(false); rejectsUnchanged(missing, 'time-owner-missing', () => enroll(missing)); assert.ok(!fs.existsSync(path.join(missing, '.gsd')));
    assert.throws(() => time.recordEnrollment({ cwd, milestone: 'TASK-001', source: 'owner', now: NOW }), e => e.code === 'time-work-kind-unsupported');
    const roadmapOwner = owner(); write(path.join(roadmapOwner, '.gsd/milestones', M, M + '-ROADMAP.md'), {});
    rejectsUnchanged(roadmapOwner, 'time-options-roadmap-exists', () => enroll(roadmapOwner));
    const { cwd: activeOwner } = activate(); rejectsUnchanged(activeOwner, 'time-options-contract-exists', () => enroll(activeOwner));
    fs.writeFileSync(path.join(p.directory, 'stray.json'), '{}\n');
    assert.strictEqual(time.readContract({ cwd, milestone: M }).reason, 'time-contract-base-missing', 'unexpected files stay invalid');
    fs.unlinkSync(path.join(p.directory, 'stray.json'));
    for (const [content, reason] of [['{', 'time-source-json-invalid'], [JSON.stringify({ ...first.enrollment, milestone: 'M002' }), 'time-enrollment-invalid'],
      [JSON.stringify({ ...first.enrollment, extra: 1 }), 'time-enrollment-invalid'], [' '.repeat(64 * 1024 + 1), 'time-source-too-large']]) {
      const corrupt = owner(); enroll(corrupt); fs.writeFileSync(time.timePaths({ cwd: corrupt, milestone: M }).directory + '/enrollment.json', content);
      const read = time.readEnrollment({ cwd: corrupt, milestone: M }); assert.strictEqual(read.status, 'invalid'); assert.strictEqual(read.reason, reason);
      assert.ok(!JSON.stringify(read).includes(corrupt), 'no absolute path in refusals');
    }
    const linked = owner(), moved = owner(); enroll(linked); const dir = time.timePaths({ cwd: linked, milestone: M }).directory;
    fs.renameSync(dir, path.join(moved, 'moved')); link(path.join(moved, 'moved'), dir);
    assert.strictEqual(time.readEnrollment({ cwd: linked, milestone: M }).reason, 'time-path-link');
    rejectsUnchanged(linked, 'time-path-link', () => enroll(linked));
  });
  test('options-digest-named-idempotent-limited-public-and-link-refusing', () => {
    const cwd = owner(), record = offered();
    rejectsUnchanged(cwd, 'time-enrollment-required', () => time.recordOptions({ cwd, milestone: M, record }));
    enroll(cwd);
    const stored = time.recordOptions({ cwd, milestone: M, record }), p = time.timePaths({ cwd, milestone: M });
    assert.strictEqual(stored.status, 'valid'); assert.strictEqual(stored.options_sha256, digest(record));
    assert.ok(fs.existsSync(path.join(p.directory, 'options', digest(record) + '.json')));
    const before = snapshot(cwd);
    assert.deepStrictEqual(time.recordOptions({ cwd, milestone: M, record }), stored); assert.deepStrictEqual(snapshot(cwd), before);
    assert.deepStrictEqual(time.readOptions({ cwd, milestone: M, options_sha256: stored.options_sha256 }), stored);
    assert.deepStrictEqual(time.readOptions({ cwd, milestone: M, options_sha256: 'f'.repeat(64) }), { status: 'absent' });
    assert.strictEqual(time.readOptions({ cwd, milestone: M, options_sha256: '../x' }).reason, 'time-options-invalid');
    assert.deepStrictEqual(time.listOptions({ cwd, milestone: M }).records.map(r => r.options_sha256), [stored.options_sha256]);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent', 'options alone remain pre-activation');
    for (const [value, code] of [[{ ...record, milestone: 'M002' }, 'time-options-invalid'], [{ ...record, schema_version: 2 }, 'time-options-invalid'],
      [{ ...record, note: 'C:\\Users\\private' }, 'time-options-invalid'], [{ ...record, blob: Array.from({ length: 257 }, () => 'x') }, 'time-options-invalid'],
      [{ ...record, pad: { a: Array(40).fill('x'.repeat(3990)), b: Array(40).fill('x'.repeat(3990)) } }, 'time-source-too-large'], [null, 'time-options-invalid']])
      rejectsUnchanged(cwd, code, () => time.recordOptions({ cwd, milestone: M, record: value }));
    const optionsDir = path.join(p.directory, 'options');
    for (let n = 1; n < 256; n++) { const r = { schema_version: 1, milestone: M, n }; write(path.join(optionsDir, digest(r) + '.json'), r); }
    assert.strictEqual(time.listOptions({ cwd, milestone: M }).records.length, 256);
    rejectsUnchanged(cwd, 'time-record-limit', () => time.recordOptions({ cwd, milestone: M, record: { schema_version: 1, milestone: M, n: 999 } }));
    const extra = { schema_version: 1, milestone: M, n: 1000 }; write(path.join(optionsDir, digest(extra) + '.json'), extra);
    assert.strictEqual(time.listOptions({ cwd, milestone: M }).reason, 'time-record-limit');
    const other = prepared(), otherDir = path.join(time.timePaths({ cwd: other.cwd, milestone: M }).directory, 'options'), file = path.join(otherDir, other.sha + '.json');
    fs.writeFileSync(file, JSON.stringify(other.record, null, 2) + '\n');
    assert.strictEqual(time.readOptions({ cwd: other.cwd, milestone: M, options_sha256: other.sha }).reason, 'time-record-invalid', 'bytes must be the canonical record');
    write(file, other.record); assert.strictEqual(time.readOptions({ cwd: other.cwd, milestone: M, options_sha256: other.sha }).status, 'valid');
    fs.renameSync(file, path.join(otherDir, 'e'.repeat(64) + '.json'));
    assert.strictEqual(time.listOptions({ cwd: other.cwd, milestone: M }).reason, 'time-record-invalid', 'name differs from content digest');
    const linked = prepared(), linkedDir = path.join(time.timePaths({ cwd: linked.cwd, milestone: M }).directory, 'options'), moved = owner();
    fs.renameSync(linkedDir, path.join(moved, 'moved')); link(path.join(moved, 'moved'), linkedDir);
    assert.strictEqual(time.listOptions({ cwd: linked.cwd, milestone: M }).reason, 'time-path-link');
    assert.strictEqual(time.readOptions({ cwd: linked.cwd, milestone: M, options_sha256: linked.sha }).reason, 'time-path-link');
  });
  test('verify-decision-live-handle-persisted-answer-and-every-negative-zero-writes', () => {
    const cwd = owner(), request = linkedRequest('a'.repeat(64)), expected = ['linked-task:' + AUTH];
    const d = decision(cwd, 'linked-task', request, 'linked-task:' + AUTH), before = snapshot(cwd);
    const verified = time.verifyDecision({ cwd, milestone: M, handle: d.handle, kind: 'linked-task', request, expected, now: NOW });
    assert.deepStrictEqual(verified, { reference: d.live.reference, question: d.live.question, answer: 'linked-task:' + AUTH, source: 'user-text',
      resolved_at: new Date(NOW).toISOString(), request_sha256: digest(request) });
    assert.deepStrictEqual(snapshot(cwd), before, 'verification never writes');
    const call = (overrides = {}) => () => time.verifyDecision({ cwd, milestone: M, handle: d.handle, kind: 'linked-task', request, expected, now: NOW, ...overrides });
    for (const handle of [undefined, null, {}, JSON.parse(JSON.stringify(d.handle)), structuredClone(d.handle), { approved: true }])
      rejectsUnchanged(cwd, 'time-decision-attestation-required', call({ handle }));
    rejectsUnchanged(cwd, 'time-decision-attestation-required', call({ now: NOW + 60000 }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ milestone: 'M002' }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ kind: 'activation' }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ request: { ...request, authorization: 'none' } }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ kind: 'approve-everything' }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ expected: [] }));
    rejectsUnchanged(cwd, 'time-decision-answer-mismatch', call({ expected: ['linked-task:none'] }));
    for (const overrides of [{ pending: true }, { milestone: 'M002' }, { set: 'milestone-time-activation' }]) {
      const x = decision(cwd, 'linked-task', request, 'linked-task:' + AUTH, overrides);
      rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ handle: x.handle }));
    }
    const divergent = decision(cwd, 'linked-task', request, 'linked-task:' + AUTH, { live: { answer: 'linked-task:none' } });
    rejectsUnchanged(cwd, 'time-decision-answer-mismatch', call({ handle: divergent.handle, expected: ['linked-task:none'] }));
    const revoked = decision(cwd, 'linked-task', request, 'linked-task:' + AUTH); revoked.revoke();
    rejectsUnchanged(cwd, 'time-decision-attestation-required', call({ handle: revoked.handle }));
    const foreignScope = decision(cwd, 'linked-task', request, 'linked-task:' + AUTH, { scope: { milestone: 'M002' } });
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call({ handle: foreignScope.handle }));
    const file = path.join(cwd, '.gsd/forge/questions', d.opened.identity_sha256 + '.json'), edited = JSON.parse(fs.readFileSync(file));
    edited.questions[0].status = 'pending'; delete edited.questions[0].answer; edited.approved = true; write(file, edited);
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', call());
  });
  test('selection-requires-live-authority-inside-the-mutator-and-is-idempotent', () => {
    const { cwd, sha } = prepared(), s = select(cwd, sha), p = time.timePaths({ cwd, milestone: M });
    assert.strictEqual(s.result.status, 'valid'); assert.ok(fs.existsSync(path.join(p.directory, 'selection.json')));
    const stored = time.readSelection({ cwd, milestone: M }); assert.deepStrictEqual(stored, s.result);
    assert.strictEqual(stored.selection_sha256, digest(stored.selection));
    assert.deepStrictEqual(stored.selection.decisions.map(r => [r.kind, r.decision.answer]), [['activation', 'option:short'], ['linked-task', 'linked-task:' + AUTH]]);
    assert.strictEqual(stored.selection.decisions[0].decision.request_sha256, digest(s.input.contract_request), 'request digest derives from the real request');
    assert.ok(!fs.readFileSync(path.join(p.directory, 'selection.json'), 'utf8').includes('handle'));
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    const before = snapshot(cwd);
    assert.deepStrictEqual(time.recordSelection({ cwd, milestone: M, selection: s.input, handles: { activation: s.activation.handle, 'linked-task': s.linked.handle }, now: NOW + 5 }), stored);
    assert.deepStrictEqual(snapshot(cwd), before, 'replay with authority is idempotent');
    rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.recordSelection({ cwd, milestone: M, selection: stored.selection, now: NOW }));
    const other = owner(); prepared(other);
    const otherSha = time.listOptions({ cwd: other, milestone: M }).records[0].options_sha256, input = selectionInput(otherSha);
    const a = decision(other, 'activation', input.contract_request, 'option:short'), l = decision(other, 'linked-task', linkedRequest(otherSha), 'linked-task:' + AUTH);
    const attempt = (handles, selection = input) => () => time.recordSelection({ cwd: other, milestone: M, selection, handles, now: NOW });
    const forged = { ...input, decisions: stored.selection.decisions };
    for (const handles of [undefined, {}, { activation: JSON.parse(JSON.stringify(a.handle)), 'linked-task': l.handle }, { activation: { approved: true }, 'linked-task': l.handle }])
      rejectsUnchanged(other, 'time-decision-attestation-required', attempt(handles, forged));
    rejectsUnchanged(other, 'time-decision-attestation-required', attempt({ activation: a.handle }));
    rejectsUnchanged(other, 'time-decision-attestation-required', () => time.recordSelection({ cwd: other, milestone: M, selection: input, handles: { activation: a.handle, 'linked-task': l.handle }, now: NOW + 60000 }));
    rejectsUnchanged(other, 'time-decision-scope-mismatch', attempt({ activation: a.handle, 'linked-task': l.handle }, { ...input, contract_request: { ...input.contract_request, ceiling_ms: 7200000 } }));
    rejectsUnchanged(other, 'time-decision-scope-mismatch', attempt({ activation: l.handle, 'linked-task': a.handle }));
    const pendingRound = decision(other, 'linked-task', linkedRequest(otherSha), 'linked-task:' + AUTH, { pending: true });
    rejectsUnchanged(other, 'time-decision-scope-mismatch', attempt({ activation: a.handle, 'linked-task': pendingRound.handle }));
    const conflicting = decision(other, 'linked-task', linkedRequest(otherSha), 'linked-task:none');
    rejectsUnchanged(other, 'time-decision-answer-mismatch', attempt({ activation: a.handle, 'linked-task': conflicting.handle }));
    const forgedAnswer = { ...forged, decisions: [{ kind: 'activation', decision: { ...stored.selection.decisions[0].decision, answer: 'option:long' } }] };
    rejectsUnchanged(other, 'time-decision-answer-mismatch', attempt({ activation: a.handle, 'linked-task': l.handle }, forgedAnswer));
    rejectsUnchanged(other, 'time-selection-option-unknown', attempt({ activation: a.handle, 'linked-task': l.handle }, { ...input, position_id: 'P9' }));
    rejectsUnchanged(other, 'time-selection-invalid', attempt({ activation: a.handle, 'linked-task': l.handle }, { ...input, contract_request: { ...input.contract_request, linked_task: null } }));
    rejectsUnchanged(other, 'time-options-required', attempt({ activation: a.handle, 'linked-task': l.handle }, { ...input, options_sha256: 'f'.repeat(64) }));
    const unenrolled = owner(); rejectsUnchanged(unenrolled, 'time-enrollment-required', () => time.recordSelection({ cwd: unenrolled, milestone: M, selection: input, handles: {}, now: NOW }));
    assert.strictEqual(time.recordSelection({ cwd: other, milestone: M, selection: input, handles: { activation: a.handle, 'linked-task': l.handle }, now: NOW }).status, 'valid');
    const changed = selectionInput(otherSha, 'none'), ca = decision(other, 'activation', changed.contract_request, 'option:short');
    const cl = decision(other, 'linked-task', linkedRequest(otherSha, 'none'), 'linked-task:none');
    rejectsUnchanged(other, 'time-selection-scope-incompatible', attempt({ activation: ca.handle, 'linked-task': cl.handle }, changed));
    const reauthorized = selectionInput(otherSha, 'create-and-start-after-proven-completion'), ra = decision(other, 'activation', reauthorized.contract_request, 'option:short');
    const rl = decision(other, 'linked-task', linkedRequest(otherSha, 'create-and-start-after-proven-completion'), 'linked-task:create-and-start-after-proven-completion');
    rejectsUnchanged(other, 'time-selection-conflict', attempt({ activation: ra.handle, 'linked-task': rl.handle }, reauthorized));
    const corrupt = path.join(time.timePaths({ cwd: other, milestone: M }).directory, 'selection.json'), value = JSON.parse(fs.readFileSync(corrupt));
    value.decisions = []; write(corrupt, value);
    assert.strictEqual(time.readSelection({ cwd: other, milestone: M }).reason, 'time-selection-invalid');
  });
  // Direct mutator calls with real live handles: the offered cap, strategy and scope policy are derived from the persisted option.
  function plainSelection(cwd, mutate = () => {}, ceiling = 3600000) {
    enroll(cwd); const record = offered(); mutate(record);
    const sha = time.recordOptions({ cwd, milestone: M, record }).options_sha256;
    const contract = { ...payload(), option: { id: 'short', options_sha256: sha, label: 'Curta', position_id: 'P0' }, ceiling_ms: ceiling };
    const input = { choice: 'option', options_sha256: sha, option_id: 'short', position_id: 'P0', linked_task_authorization: null, contract_request: contract, rounds: [] };
    // The live handle is issued eagerly; the returned callback is the direct mutator call.
    return { input, contract, run: answer => { const handle = decision(cwd, 'activation', contract, answer).handle;
      return () => time.recordSelection({ cwd, milestone: M, selection: input, handles: { activation: handle }, now: NOW }); } };
  }
  test('selection-derives-the-offered-ceiling-and-needs-the-explicit-operator-ceiling-for-a-custom-one', () => {
    const inflated = owner(), a = plainSelection(inflated, () => {}, 360000000);
    rejectsUnchanged(inflated, 'time-decision-answer-mismatch', a.run('option:short'));
    rejectsUnchanged(inflated, 'time-decision-answer-mismatch', a.run('operator-ceiling:3600000'));
    const custom = a.run('operator-ceiling:360000000')();
    assert.strictEqual(custom.selection.contract_request.ceiling_ms, 360000000);
    assert.strictEqual(custom.selection.decisions[0].decision.answer, 'operator-ceiling:360000000');
    const ordinary = owner(), b = plainSelection(ordinary);
    assert.strictEqual(b.run('option:short')().selection.contract_request.ceiling_ms, 3600000);
    const strategy = owner(), c = plainSelection(strategy); c.input.position_id = 'P9';
    rejectsUnchanged(strategy, 'time-selection-option-unknown', c.run('option:short'));
  });
  test('selection-rejects-infeasible-strategies-and-incompatible-ceilings-but-keeps-unknown-estimates-unknown', () => {
    const infeasible = owner(), a = plainSelection(infeasible, r => { r.options[0].positions[1].status = 'infeasible'; });
    rejectsUnchanged(infeasible, 'time-selection-infeasible', a.run('option:short'));
    const unknown = owner(), b = plainSelection(unknown, r => { delete r.options[0].ceiling_ms; r.options[0].positions[1].estimate = { low_ms: null, high_ms: null }; });
    rejectsUnchanged(unknown, 'time-decision-answer-mismatch', b.run('option:short'));
    const unknownRecorded = b.run('operator-ceiling:3600000')();
    assert.strictEqual(unknownRecorded.selection.contract_request.ceiling_ms, 3600000, 'no number is invented for an unknown forecast');
    const low = owner(), c = plainSelection(low, r => { r.options[0].positions[1].estimate = { low_ms: 4000000, high_ms: 5000000 }; });
    rejectsUnchanged(low, 'time-selection-ceiling-incompatible', c.run('option:short'));
    const lowConfidence = owner(), d = plainSelection(lowConfidence, r => { r.options[0].positions[1].estimate = { low_ms: 1000, high_ms: 2000, confidence: 'low' }; });
    assert.strictEqual(d.run('option:short')().status, 'valid');
    const cyclic = owner(), e = plainSelection(cyclic, r => { r.options[0].edges.push({ from: 'N1', to: 'N2' }); });
    rejectsUnchanged(cyclic, 'time-selection-graph-invalid', e.run('option:short'));
  });
  test('unlinked-selection-binds-the-position-so-one-handle-cannot-switch-strategies', () => {
    const amb = owner(), a = plainSelection(amb, r => { r.options[0].positions.push({ id: 'P2', deferred: ['N3'], linked_task: null }); });
    const handle = decision(amb, 'activation', a.contract, 'option:short').handle, run = selection => () => time.recordSelection({ cwd: amb, milestone: M, selection, handles: { activation: handle }, now: NOW });
    rejectsUnchanged(amb, 'time-selection-invalid', run({ ...a.input, position_id: 'P2' }));
    const forged = { ...a.contract, option: { ...a.contract.option, position_id: 'P2' } };
    rejectsUnchanged(amb, 'time-decision-scope-mismatch', run({ ...a.input, position_id: 'P2', contract_request: forged }));
    rejectsUnchanged(amb, 'time-selection-invalid', run({ ...a.input, contract_request: { ...a.contract, option: { id: 'short', options_sha256: a.contract.option.options_sha256, label: 'Curta' } } }));
    assert.strictEqual(run(a.input)().selection.position_id, 'P0', 'the handle still selects the strategy it attested');
  });
  test('selected-graph-is-validated-for-position-nodes-without-option-nodes-before-any-write', () => {
    const own = r => { const o = r.options[0]; r.options[0].positions[1].nodes = o.nodes.map(n => ({ ...n, depends: o.edges.filter(e => e.from === n.id).map(e => e.to) })); delete o.nodes; delete o.edges; };
    const good = owner(), ok = plainSelection(good, own).run('option:short')();
    assert.strictEqual(ok.status, 'valid');
    const cyclic = owner(), c = plainSelection(cyclic, r => { own(r); r.options[0].positions[1].nodes[0].depends = ['N2']; });
    rejectsUnchanged(cyclic, 'time-selection-graph-invalid', c.run('option:short'));
    const unknown = owner(), u = plainSelection(unknown, r => { own(r); r.options[0].positions[1].nodes[1].depends = ['ZZ']; });
    rejectsUnchanged(unknown, 'time-selection-graph-invalid', u.run('option:short'));
    assert.strictEqual(time.readSelection({ cwd: cyclic, milestone: M }).status, 'absent'); assert.strictEqual(time.readContract({ cwd: unknown, milestone: M }).status, 'absent');
  });
  // The complete planned T02 producer record, documented at optionsView in forge-milestone-roadmap-time, through the public APIs.
  // RAW PAYLOAD vs STORAGE ENVELOPE: `materialized()` is the raw payload handed to recordOptions as `record` and stored byte-for-byte
  // (canonical JSON) at options/<options_sha256>.json. options_sha256 is digest(record) as returned by recordOptions and can never be a
  // field of the record itself; the storage envelope { status, options_sha256, record } is only what readOptions/recordOptions return.
  // proposal_sha256 is digest(proposal). Every identity below is synthetic descriptive data: it is not attested and grants no authority.
  const PHASES = ['plan-milestone', 'discuss-milestone', 'research-milestone', 'plan-slice', 'research-slice', 'execute-task', 'complete-slice', 'complete-milestone'];
  const NODE_KINDS = ['preparation', 'slice', 'integration', 'review', 'corrections'];
  const POLICY = { id: 'forge-milestone-time-estimate', version: 1 };
  // Known by default: the history is empty, but every node carries a complete TOTAL-duration judgment (125000..375000 ms) that replaces its
  // unmeasured phases (never summed with the phase counts, no parallel credit). `unknown` removes the judgment basis of a remaining milestone
  // node of `media` (history stays empty), so its range, proposed ceiling and chain are honestly unknown (null).
  function materialized(unknown = false) {
    const sha = label => digest('synthetic:' + label);
    const judged = (id, low, high) => ({ low_ms: low, high_ms: high, reason: 'Histórico vazio: faixa justificada pelo trabalho do nó ' + id + ' e pelos arquivos investigados',
      sources: ['scripts/forge-milestone-time.js', 'docs/milestone-time-options.md'] });
    const node = (id, kind, phases, depends, covers) => ({ id, kind, title: 'Nó ' + id, phases, activities: ['trabalho do nó ' + id], judgment: judged(id, 125000, 375000), depends, covers });
    const nodes = [
      node('PREP', 'preparation', { 'plan-milestone': 1, 'research-milestone': 2 }, [], ['SC1']),
      node('N1', 'slice', { 'plan-slice': 1, 'execute-task': 3, 'complete-slice': 1 }, ['PREP'], ['SC1']),
      node('N2', 'slice', { 'plan-slice': 1, 'execute-task': 3, 'complete-slice': 1 }, ['N1'], ['SC2']),
      node('N3', 'slice', { 'plan-slice': 1, 'execute-task': 2 }, [], ['SC3']),
      node('N4', 'slice', { 'plan-slice': 1, 'execute-task': 2, 'complete-slice': 1 }, ['N2'], ['SC4']),
      node('INT', 'integration', { 'execute-task': 2 }, ['N2'], ['SC5']),
      node('REV', 'review', { 'complete-slice': 1, 'complete-milestone': 1 }, ['INT'], ['SC5']),
      node('COR', 'corrections', { 'execute-task': 1 }, ['REV'], ['SC5'])];
    const position = (id, label, extra = {}) => ({ id, label, status: 'viable', reason: 'Cobre o escopo indispensável e o endpoint verificado', strategy: 'Entrega em fatias dependentes com integração, revisão e correções',
      technical_choices: ['Fatias sequenciais com integração única'], deliverables: ['Entrega integrada verificada'], nodes: extra.nodes ?? nodes, parallel_groups: [{ nodes: ['N1', 'N3'], independence: 'Sem dependência mútua', isolation: 'Worktrees distintos' }],
      verifications: ['Suíte do milestone verde'], review: ['Revisão independente do diff'], risks: ['Histórico ausente'], uncertainties: ['Faixas por julgamento'], deferrals: [], linked_task: null, ...extra });
    const items = Object.fromEntries(time.ENDPOINT_ITEMS.map(i => [i, 'pending']));
    const linked = { moved_scope: ['SC4'], criteria: { milestone: ['Entrega N1 e N2 verificada'], task: ['Entrega N4 verificada'] }, nodes: ['N4'] };
    const scope = [['SC1', true, 'SCOPE'], ['SC2', true, 'CONTEXT'], ['SC3', false, 'BRAINSTORM'], ['SC4', false, 'REQUIREMENTS'], ['SC5', true, 'REQUIREMENTS']]
      .map(([i, indispensable, source]) => ({ id: i, title: 'Item ' + i, indispensable, source }));
    const proposal = { schema_version: 1, milestone: M, scope_items: scope, endpoint: { kind: 'verified-integrated-delivery', items }, recommended: 'curta', recommendation_reason: 'Cobre todo o escopo',
      positions: [position('curta', 'Escopo completo'), position('media', 'Com tarefa ligada', { deferrals: [{ scope_item: 'SC3', reason: 'Item opcional adiado', consent: 'required' }], linked_task: linked,
        ...(unknown ? { nodes: nodes.map(n => n.id === 'COR' ? { ...n, judgment: null } : n) } : {}) }),
        position('longa', 'Inviável no prazo', { status: 'infeasible', reason: 'Excede qualquer faixa defensável' })] };
    const inputs = { documents: [{ path: 'docs/milestone-time-options.md', sha256: sha('doc-options') }, { path: '.gsd/milestones/' + M + '/' + M + '-CONTEXT.md', sha256: sha('doc-context') }],
      code_root: { identity_sha256: sha('physical-root'), revision: 'synthetic-revision-0001', workspace: 'synthetic-workspace-0001' },
      code_files: [{ path: 'scripts/forge-milestone-time.js', sha256: sha('file-time') }, { path: 'scripts/forge-milestone-roadmap-time.js', sha256: sha('file-roadmap') }] };
    const history = { source: 'synthetic-fixture', observations: 0, phases: Object.fromEntries(PHASES.map(p => [p, { n: 0, dispersion: null, sources: [] }])), limitations: ['Histórico vazio: confiança baixa'] };
    return { schema_version: 1, milestone: M, materialized_at: new Date(NOW - 90000).toISOString(), proposal, proposal_sha256: digest(proposal), policy: POLICY,
      estimate: { policy: POLICY, positions: [{ position_id: 'curta', low_ms: 1000000, high_ms: 3000000, confidence: 'low', ceiling_ms: 3000000, linked_task_horizon: null },
        { position_id: 'media', low_ms: unknown ? null : 750000, high_ms: unknown ? null : 2250000, confidence: 'low', ceiling_ms: unknown ? null : 2250000,
          linked_task_horizon: { low_ms: 125000, high_ms: 375000, ceiling_ms: 375000 } },
        { position_id: 'longa', low_ms: null, high_ms: null, confidence: 'low', ceiling_ms: null, linked_task_horizon: null }] },
      inputs, history,
      producer_basis: { producer: 'synthetic-fixture', frozen_before: 'begin', frozen_at: new Date(NOW - 95000).toISOString(), attested: false,
        identity_sha256: sha('producer'), inputs_fingerprint_sha256: digest(inputs), history_fingerprint_sha256: digest(history) } };
  }
  test('materialized-producer-record-is-complete-and-uses-only-the-planned-enums-and-provenance', () => {
    const record = materialized(), { proposal } = record, endpoint = time.ENDPOINT_ITEMS;
    assert.deepStrictEqual(proposal.positions.map(p => p.id), ['curta', 'media', 'longa']);
    assert.deepStrictEqual(record.policy, POLICY); assert.deepStrictEqual(record.estimate.policy, POLICY); assert.strictEqual(record.proposal_sha256, digest(proposal));
    const ids = new Set(proposal.scope_items.map(i => i.id)); assert.strictEqual(ids.size, proposal.scope_items.length);
    for (const position of proposal.positions) {
      assert.deepStrictEqual([...new Set(position.nodes.map(n => n.kind))].sort(), [...NODE_KINDS].sort(), 'all planned kinds are present');
      assert.strictEqual(new Set(position.nodes.map(n => n.id)).size, position.nodes.length); assert.ok(position.nodes.every(n => !ids.has(n.id)), 'scope and node IDs are distinct');
      for (const n of position.nodes) {
        assert.ok(NODE_KINDS.includes(n.kind)); assert.ok(Object.keys(n.phases).length > 0);
        for (const [phase, count] of Object.entries(n.phases)) { assert.ok(PHASES.includes(phase), phase); assert.ok(Number.isInteger(count) && count >= 1 && count <= 999); }
        assert.ok(n.activities.length && n.covers.every(c => ids.has(c)) && n.depends.every(d => position.nodes.some(x => x.id === d)));
        assert.ok(n.judgment.reason && n.judgment.sources.length && n.judgment.low_ms <= n.judgment.high_ms, 'judgment is justified');
      }
      for (const k of ['strategy', 'technical_choices', 'deliverables', 'verifications', 'review', 'risks', 'uncertainties']) assert.ok(position[k].length, k);
    }
    const gates = proposal.positions[0].nodes.filter(n => n.covers.includes('SC5')).map(n => n.kind); assert.deepStrictEqual(gates, ['integration', 'review', 'corrections']);
    assert.ok(proposal.scope_items.find(i => i.id === 'SC5').indispensable, 'the gate item is indispensable and is never moved');
    const media = proposal.positions[1], moved = new Set(media.linked_task.moved_scope);
    assert.ok(proposal.scope_items.filter(i => moved.has(i.id) || media.deferrals.some(d => d.scope_item === i.id)).every(i => i.indispensable === false), 'only optional scope moves or is deferred');
    assert.deepStrictEqual(Object.keys(proposal.endpoint.items), endpoint); assert.strictEqual(proposal.endpoint.kind, 'verified-integrated-delivery');
    // Persisted estimates follow the node TOTAL-duration judgments of the actual partitions (no phase sums, no parallel credit, ceiling = upper bound).
    {
    const sumOf = nodes => ({ low_ms: nodes.reduce((t, n) => t + n.judgment.low_ms, 0), high_ms: nodes.reduce((t, n) => t + n.judgment.high_ms, 0) });
    const [curta, media] = proposal.positions, [eCurta, eMedia] = record.estimate.positions, outside = new Set([...media.linked_task.nodes, 'N3']);
    const mediaNodes = media.nodes.filter(n => !outside.has(n.id)), taskNodes = media.nodes.filter(n => media.linked_task.nodes.includes(n.id));
    assert.deepStrictEqual([curta.nodes.length, mediaNodes.length, taskNodes.length], [8, 6, 1]);
    assert.deepStrictEqual({ low_ms: eCurta.low_ms, high_ms: eCurta.high_ms, ceiling_ms: eCurta.ceiling_ms }, { ...sumOf(curta.nodes), ceiling_ms: sumOf(curta.nodes).high_ms });
    assert.deepStrictEqual({ low_ms: eMedia.low_ms, high_ms: eMedia.high_ms, ceiling_ms: eMedia.ceiling_ms }, { ...sumOf(mediaNodes), ceiling_ms: sumOf(mediaNodes).high_ms });
    assert.deepStrictEqual(eMedia.linked_task_horizon, { ...sumOf(taskNodes), ceiling_ms: sumOf(taskNodes).high_ms });
    assert.deepStrictEqual([eCurta.low_ms, eCurta.high_ms, eMedia.low_ms, eMedia.high_ms, eMedia.linked_task_horizon.low_ms, eMedia.linked_task_horizon.high_ms], [1000000, 3000000, 750000, 2250000, 125000, 375000]);
    assert.strictEqual(eMedia.low_ms + eMedia.linked_task_horizon.low_ms, 875000); assert.strictEqual(eMedia.high_ms + eMedia.linked_task_horizon.high_ms, 2625000);
    // The separate honest unknown variant: a remaining milestone node has no judgment basis and the history is empty, so nothing is derived.
    const open = materialized(true), eOpen = open.estimate.positions[1], mediaOpen = open.proposal.positions[1];
    assert.ok(mediaOpen.nodes.some(n => !outside.has(n.id) && n.judgment === null) && open.history.observations === 0);
    assert.deepStrictEqual([eOpen.low_ms, eOpen.high_ms, eOpen.ceiling_ms], [null, null, null]); assert.deepStrictEqual(eOpen.linked_task_horizon, eMedia.linked_task_horizon);
    assert.strictEqual(open.proposal_sha256, digest(open.proposal)); assert.notStrictEqual(open.proposal_sha256, record.proposal_sha256); assert.strictEqual(open.producer_basis.inputs_fingerprint_sha256, digest(open.inputs));
    }
    const { inputs, producer_basis: basis } = record, hex = /^[a-f0-9]{64}$/;
    assert.ok(inputs.documents.length && inputs.documents.every(d => hex.test(d.sha256) && !path.isAbsolute(d.path)) && inputs.code_files.every(d => hex.test(d.sha256) && !path.isAbsolute(d.path)));
    assert.ok(hex.test(inputs.code_root.identity_sha256) && inputs.code_root.revision && inputs.code_root.workspace);
    assert.strictEqual(basis.attested, false); assert.strictEqual(basis.frozen_before, 'begin'); assert.strictEqual(basis.inputs_fingerprint_sha256, digest(inputs));
    assert.ok(Date.parse(basis.frozen_at) <= Date.parse(record.materialized_at));
  });
  test('materialized-producer-record-is-selected-activated-and-conformed-through-the-public-apis', () => {
    const rt = require('./forge-milestone-roadmap-time'), items = materialized().proposal.endpoint;
    const prepareRecord = (cwd, unknown = false) => { enroll(cwd); const record = materialized(unknown); return { record, sha: time.recordOptions({ cwd, milestone: M, record }).options_sha256 }; };
    const expect = (cwd, record, sha) => { const contract = time.readContract({ cwd, milestone: M }).contract;
      return rt.expectedFrom({ enrollment: time.readEnrollment({ cwd, milestone: M }).enrollment, options: record, options_sha256: sha, selection: time.readSelection({ cwd, milestone: M }).selection,
        contract, contract_sha256: digest(contract), ceiling_ms: contract.ceiling_ms }); };
    // Full scope with the offered cap; the position is bound by the attested request.
    const a = owner(), { record, sha } = prepareRecord(a);
    assert.strictEqual(sha, digest(record), 'options_sha256 is the digest of the raw payload returned by recordOptions');
    const full ={ ...payload(), option: { id: 'curta', options_sha256: sha, label: 'Escopo completo', position_id: 'curta' }, endpoint: items, ceiling_ms: 3000000 };
    const fullInput = { choice: 'option', options_sha256: sha, option_id: 'curta', position_id: 'curta', linked_task_authorization: null, contract_request: full, rounds: [] };
    const fullHandle = decision(a, 'activation', full, 'option:curta').handle;
    rejectsUnchanged(a, 'time-selection-invalid', () => time.recordSelection({ cwd: a, milestone: M, selection: { ...fullInput, contract_request: { ...full, endpoint: { ...items, items: { ...items.items, publication: 'deferred' } } } }, handles: { activation: fullHandle }, now: NOW }));
    time.recordSelection({ cwd: a, milestone: M, selection: fullInput, handles: { activation: fullHandle }, now: NOW });
    time.activateContract({ cwd: a, milestone: M, contract: full, handle: fullHandle, now: NOW });
    const fullRule = expect(a, record, sha);
    assert.strictEqual(fullRule.status, 'ready', fullRule.reason); assert.deepStrictEqual(fullRule.nodes.map(n => n.id), ['PREP', 'N1', 'N2', 'N3', 'N4', 'INT', 'REV', 'COR']); assert.strictEqual(fullRule.linked_task, null);
    // The linked-task strategy runs twice. Known: the offered high-based cap (2250000) and the milestone-plus-task chain. Unknown (an uncovered
    // basis): only an explicit operator ceiling sets a cap and the chain stays unknown. Both conform to a real ROADMAP through the public APIs.
    const linkedFlow = unknown => {
    const b = owner(), prepared2 = prepareRecord(b, unknown), sha2 = prepared2.sha, ceiling = unknown ? 3600000 : 2250000;
    const linked = materialized().proposal.positions[1].linked_task, horizon = materialized().estimate.positions[1].linked_task_horizon;
    const chain = unknown ? null : { low_ms: 875000, high_ms: 2625000, basis: 'milestone-plus-linked-task' };
    const request = { ...payload(), option: { id: 'media', options_sha256: sha2, label: 'Com tarefa ligada' }, endpoint: items, ceiling_ms: ceiling,
      linked_task: { position_id: 'media', authorization: AUTH, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon, options_sha256: sha2 }, chain_forecast: chain };
    const input = { choice: 'option', options_sha256: sha2, option_id: 'media', position_id: 'media', linked_task_authorization: AUTH, contract_request: request, rounds: [] };
    const linkedAnswer = decision(b, 'linked-task', { milestone: M, options_sha256: sha2, option_id: 'media', position_id: 'media', authorization: AUTH }, 'linked-task:' + AUTH).handle;
    const run = (handle, selection = input) => () => time.recordSelection({ cwd: b, milestone: M, selection, handles: { activation: handle, 'linked-task': linkedAnswer }, now: NOW });
    rejectsUnchanged(b, 'time-decision-answer-mismatch', run(decision(b, 'activation', request, unknown ? 'option:media' : 'operator-ceiling:3600000').handle));
    const activation = decision(b, 'activation', request, unknown ? 'operator-ceiling:3600000' : 'option:media').handle;
    time.recordSelection({ cwd: b, milestone: M, selection: input, handles: { activation, 'linked-task': linkedAnswer }, now: NOW });
    const activated = time.activateContract({ cwd: b, milestone: M, contract: request, handle: activation, now: NOW });
    assert.deepStrictEqual(activated.contract.chain_forecast, chain, unknown ? 'an unknown milestone range keeps the chain forecast unknown' : 'the known chain is the milestone plus the task range');
    assert.strictEqual(activated.contract.ceiling_ms, ceiling);
    const rule = expect(b, prepared2.record, sha2);
    assert.strictEqual(rule.status, 'ready', rule.reason); assert.deepStrictEqual(rule.nodes.map(n => n.id), ['PREP', 'N1', 'N2', 'INT', 'REV', 'COR']);
    assert.deepStrictEqual(rule.deferred, ['N3']); assert.deepStrictEqual(rule.linked_task, { moved_scope: ['N4'] });
    // The same complete record conforms to a real ROADMAP: allocation covers every required kind and node, with sums derived from the APIs.
    const base = digest(activated.contract), rows = [{ id: 'prep', kind: 'preparation', ms: 200000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 400000, nodes: ['N1'] },
      { id: 's2', kind: 'slice', slice: 'S02', ms: 400000, nodes: ['N2'] }, { id: 'integration', kind: 'integration', ms: 200000, nodes: ['INT'] },
      { id: 'review', kind: 'review', ms: 200000, nodes: ['REV'] }, { id: 'corrections', kind: 'corrections', ms: 200000, nodes: ['COR'] }];
    const section = (allocation = rows) => ({ schema_version: 1, option_id: 'media', position_id: 'media', options_sha256: sha2, contract_sha256: base, allocation,
      dependencies: rule.edges, deferred: rule.deferred, linked_task: rule.linked_task });
    assert.deepStrictEqual(new Set(rows.map(r => r.kind)), new Set(rt.ALLOCATION_KINDS));
    const conformant = rt.validateRoadmapContent(roadmapText(section()), rule);
    assert.strictEqual(conformant.valid, true, conformant.reason); assert.strictEqual(conformant.status, 'conformant');
    assert.strictEqual(conformant.total_ms, rows.reduce((sum, r) => sum + r.ms, 0)); assert.ok(conformant.total_ms <= rule.ceiling_ms);
    assert.deepStrictEqual(conformant.mapping.map(m => m.node), ['COR', 'INT', 'N1', 'N2', 'PREP', 'REV']);
    assert.strictEqual(rt.validateRoadmapContent(roadmapText(section(rows.filter(r => r.id !== 'integration'))), rule).reason, 'roadmap-time-node-missing');
    assert.strictEqual(rt.validateRoadmapContent(roadmapText(section(rows.map(r => r.id === 'prep' ? { ...r, ms: 3600000 } : r))), rule).reason, 'roadmap-time-ceiling-exceeded');
    assert.strictEqual(rt.validateRoadmapContent(roadmapText(section(rows.map(r => r.id === 'review' ? { ...r, kind: 'corrections' } : r))), rule).valid, false);
    writeRoadmap(b, section());
    assert.strictEqual(delegate(b).status, 'valid', 'the delegated allocation accepts the complete record');
    };
    linkedFlow(false); linkedFlow(true);
    const c =owner(), prepared3 = prepareRecord(c), sha3 = prepared3.sha, bad = { ...full, option: { ...full.option, id: 'longa', label: 'Inviável no prazo', position_id: 'longa', options_sha256: sha3 } };
    const badHandle = decision(c, 'activation', bad, 'option:longa').handle;
    rejectsUnchanged(c, 'time-selection-infeasible', () => time.recordSelection({ cwd: c, milestone: M, now: NOW, handles: { activation: badHandle },
      selection: { ...fullInput, options_sha256: sha3, option_id: 'longa', position_id: 'longa', contract_request: bad } }));
  });
  // The chain forecast is bound to the offered milestone and linked-task ranges: the sum when both are known, otherwise unknown (null).
  test('chain-forecast-is-derived-from-the-offered-ranges-and-a-ceiling-never-manufactures-one', () => {
    const attempt = (known, chain) => {
      const cwd = owner(); enroll(cwd); const record = materialized(!known), ceiling = known ? 2250000 : 3600000;
      const sha = time.recordOptions({ cwd, milestone: M, record }).options_sha256, linked = record.proposal.positions[1].linked_task, horizon = record.estimate.positions[1].linked_task_horizon;
      const request = { ...payload(), option: { id: 'media', options_sha256: sha, label: 'Com tarefa ligada' }, endpoint: record.proposal.endpoint, ceiling_ms: ceiling,
        linked_task: { position_id: 'media', authorization: AUTH, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon, options_sha256: sha }, chain_forecast: chain };
      const input = { choice: 'option', options_sha256: sha, option_id: 'media', position_id: 'media', linked_task_authorization: AUTH, contract_request: request, rounds: [] };
      const handles = { activation: decision(cwd, 'activation', request, known ? 'option:media' : 'operator-ceiling:3600000').handle,
        'linked-task': decision(cwd, 'linked-task', { milestone: M, options_sha256: sha, option_id: 'media', position_id: 'media', authorization: AUTH }, 'linked-task:' + AUTH).handle };
      return { cwd, request, handles, run: () => time.recordSelection({ cwd, milestone: M, selection: input, handles, now: NOW }) };
    };
    const sum = { low_ms: 875000, high_ms: 2625000, basis: 'milestone-plus-linked-task' };
    for (const chain of [sum, { ...sum, low_ms: 1 }, { low_ms: 3600000, high_ms: 3600000, basis: sum.basis }]) {
      const fabricated = attempt(false, chain), p = time.timePaths({ cwd: fabricated.cwd, milestone: M });
      rejectsUnchanged(fabricated.cwd, 'time-selection-chain-forecast-invalid', fabricated.run);
      assert.strictEqual(time.readSelection({ cwd: fabricated.cwd, milestone: M }).status, 'absent'); assert.ok(!fs.existsSync(p.contract));
      assert.throws(() => time.activateContract({ cwd: fabricated.cwd, milestone: M, contract: fabricated.request, handle: fabricated.handles.activation, now: NOW }), e => e.code === 'time-selection-required');
    }
    const absent = attempt(true, null); rejectsUnchanged(absent.cwd, 'time-selection-chain-forecast-invalid', absent.run);
    for (const chain of [{ ...sum, high_ms: 2625001 }, { ...sum, low_ms: 875001 }, { ...sum, basis: 'guess' }]) { const wrong = attempt(true, chain); rejectsUnchanged(wrong.cwd, 'time-selection-chain-forecast-invalid', wrong.run); }
    const known = attempt(true, sum), selected = known.run(); assert.strictEqual(selected.status, 'valid'); assert.deepStrictEqual(selected.selection.contract_request.chain_forecast, sum);
    assert.deepStrictEqual(time.activateContract({ cwd: known.cwd, milestone: M, contract: known.request, handle: known.handles.activation, now: NOW }).contract.chain_forecast, sum);
    const unknown = attempt(false, null), recorded = unknown.run();
    assert.strictEqual(recorded.selection.contract_request.chain_forecast, null, 'unknown stays unknown beside a genuine custom ceiling');
    assert.strictEqual(recorded.selection.contract_request.ceiling_ms, 3600000);
  });
  // A PRESENT malformed edge declaration is refused on either level before any representation is chosen, with zero writes.
  test('malformed-explicit-edge-declarations-are-refused-before-selection-and-activation-with-zero-writes', () => {
    const own = r => { const o = r.options[0]; o.positions[1].nodes = o.nodes.map(n => ({ ...n, depends: o.edges.filter(e => e.from === n.id).map(e => e.to) })); delete o.nodes; delete o.edges; };
    const cases = [];
    for (const value of [{}, 'N2>N1', null, 7, true]) {
      cases.push(['option.edges beside option.nodes', r => { r.options[0].edges = value; }]);
      cases.push(['position.edges beside valid option.edges', r => { r.options[0].positions[1].edges = value; }]);
      cases.push(['option.edges beside position.nodes', r => { own(r); r.options[0].edges = value; }]);
      cases.push(['position.edges beside position.nodes', r => { own(r); r.options[0].positions[1].edges = value; }]);
      cases.push(['position.edges beside position.nodes and valid option.edges', r => { const edges = r.options[0].edges; own(r); r.options[0].edges = edges; r.options[0].positions[1].edges = value; }]);
    }
    for (const [name, mutate] of cases) {
      const cwd = owner(), s = plainSelection(cwd, mutate), p = time.timePaths({ cwd, milestone: M });
      rejectsUnchanged(cwd, 'time-selection-graph-invalid', s.run('option:short'));
      assert.strictEqual(time.readSelection({ cwd, milestone: M }).status, 'absent', name); assert.ok(!fs.existsSync(p.contract), name);
      assert.throws(() => time.activateContract({ cwd, milestone: M, contract: s.contract, handle: decision(cwd, 'activation', s.contract, 'option:short').handle, now: NOW }), e => e.code === 'time-selection-required', name);
    }
    const valid = owner(); assert.strictEqual(plainSelection(valid, r => { r.options[0].positions[1].edges = [{ from: 'N3', to: 'N1' }]; }).run('option:short')().status, 'valid', 'array declarations stay accepted');
  });
  // Selection applies the SAME selected-position projection as conformance (rt.selectedPartition): horizon membership, deferred/linked
  // disjointness, unknown IDs and cross-horizon prerequisites are refused before anything immutable is published, for both option shapes.
  test('selection-shares-the-horizon-partition-and-prerequisite-validation-with-conformance-and-writes-nothing-when-refused', () => {
    const rt = require('./forge-milestone-roadmap-time');
    const refused = (name, cwd, run, request, activation) => {
      const p = time.timePaths({ cwd, milestone: M });
      rejectsUnchanged(cwd, 'time-selection-graph-invalid', run);
      assert.strictEqual(time.readSelection({ cwd, milestone: M }).status, 'absent', name); assert.ok(!fs.existsSync(p.contract), name);
      assert.throws(() => time.activateContract({ cwd, milestone: M, contract: request, handle: activation, now: NOW }), e => e.code === 'time-selection-required', name);
    };
    const legacy = mutate => {
      const cwd = owner(); enroll(cwd); const record = offered(); mutate(record);
      const sha = time.recordOptions({ cwd, milestone: M, record }).options_sha256, input = selectionInput(sha);
      const activation = decision(cwd, 'activation', input.contract_request, 'option:short').handle, linkedHandle = decision(cwd, 'linked-task', linkedRequest(sha), 'linked-task:' + AUTH).handle;
      return { cwd, record, request: input.contract_request, activation, run: () => time.recordSelection({ cwd, milestone: M, selection: input, handles: { activation, 'linked-task': linkedHandle }, now: NOW }) };
    };
    const legacyCases = [
      ['legacy milestone prerequisite moved to the linked task', r => { r.options[0].edges.push({ from: 'G1', to: 'N4' }); }],
      ['legacy milestone prerequisite deferred', r => { r.options[0].edges.push({ from: 'N1', to: 'N3' }); }],
      ['legacy linked-task prerequisite deferred', r => { r.options[0].edges.push({ from: 'N4', to: 'N3' }); }],
      ['legacy unknown deferred membership', r => { r.options[0].positions[0].deferred = ['N3', 'ZZ']; }],
      ['legacy overlapping linked and deferred membership', r => { r.options[0].positions[0].deferred = ['N3', 'N4']; }],
      ['legacy empty milestone scope', r => { r.options[0].positions[0].deferred = ['N1', 'N2', 'G1', 'N3']; }]];
    for (const [name, mutate] of legacyCases) {
      const l = legacy(mutate);
      refused(name, l.cwd, l.run, l.request, l.activation);
    }
    const ghost = legacy(() => {}); assert.strictEqual(ghost.run().status, 'valid', 'the valid legacy partition selects');
    { const bad = legacy(r => { r.options[0].edges.push({ from: 'N4', to: 'N3' }); }).record.options[0];
      assert.strictEqual(rt.selectedPartition(rt.sourceGraph(bad, bad.positions[0])).status, 'invalid', 'pure validator refuses task -> deferred'); }
    assert.strictEqual(rt.selectedPartition(rt.sourceGraph(ghost.record.options[0], ghost.record.options[0].positions[0])).status, 'valid');
    const reverse = legacy(r => { r.options[0].edges.push({ from: 'N4', to: 'G1' }); });
    assert.strictEqual(reverse.run().status, 'valid', 'a task -> milestone prerequisite stays allowed');
    assert.strictEqual(time.activateContract({ cwd: reverse.cwd, milestone: M, contract: reverse.request, handle: reverse.activation, now: NOW }).status, 'valid');
    // Normalized complete producer shape (known media: offered cap 2250000, milestone-plus-task chain).
    const producer = mutate => {
      const cwd = owner(); enroll(cwd); const record = materialized(), position = record.proposal.positions[1];
      position.nodes = position.nodes.map(n => ({ ...n })); mutate(position); record.proposal_sha256 = digest(record.proposal);
      const sha = time.recordOptions({ cwd, milestone: M, record }).options_sha256, linked = position.linked_task, horizon = record.estimate.positions[1].linked_task_horizon;
      const request = { ...payload(), option: { id: 'media', options_sha256: sha, label: 'Com tarefa ligada' }, endpoint: record.proposal.endpoint, ceiling_ms: 2250000,
        linked_task: { position_id: 'media', authorization: AUTH, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon, options_sha256: sha },
        chain_forecast: { low_ms: 875000, high_ms: 2625000, basis: 'milestone-plus-linked-task' } };
      const input = { choice: 'option', options_sha256: sha, option_id: 'media', position_id: 'media', linked_task_authorization: AUTH, contract_request: request, rounds: [] };
      const activation = decision(cwd, 'activation', request, 'option:media').handle;
      const handles = { activation, 'linked-task': decision(cwd, 'linked-task', { milestone: M, options_sha256: sha, option_id: 'media', position_id: 'media', authorization: AUTH }, 'linked-task:' + AUTH).handle };
      return { cwd, request, activation, run: () => time.recordSelection({ cwd, milestone: M, selection: input, handles, now: NOW }) };
    };
    const node = (position, id) => position.nodes.find(n => n.id === id);
    const producerCases = [
      ['producer milestone prerequisite moved to the linked task', p => { node(p, 'INT').depends.push('N4'); }],
      ['producer milestone prerequisite deferred', p => { node(p, 'N2').depends.push('N3'); }],
      ['producer linked-task prerequisite deferred', p => { node(p, 'N4').depends.push('N3'); }],
      ['producer unknown linked membership', p => { p.linked_task.nodes = ['N4', 'ZZ']; }],
      ['producer linked membership absent', p => { delete p.linked_task.nodes; }],
      ['producer empty linked membership', p => { p.linked_task.nodes = []; }],
      ['producer repeated linked membership', p => { p.linked_task.nodes = ['N4', 'N4']; }],
      ['producer overlapping linked and deferred membership', p => { p.deferrals.push({ scope_item: 'SC4', reason: 'Também adiado', consent: 'required' }); }]];
    for (const [name, mutate] of producerCases) { const q = producer(mutate); refused(name, q.cwd, q.run, q.request, q.activation); }
    const valid = producer(() => {}), selected = valid.run(); assert.strictEqual(selected.status, 'valid');
    time.activateContract({ cwd: valid.cwd, milestone: M, contract: valid.request, handle: valid.activation, now: NOW });
    const upstream = producer(p => { node(p, 'N4').depends.push('REV'); }), later = upstream.run();
    assert.strictEqual(later.status, 'valid', 'a task -> milestone gate prerequisite stays allowed');
    time.activateContract({ cwd: upstream.cwd, milestone: M, contract: upstream.request, handle: upstream.activation, now: NOW });
    const contract = time.readContract({ cwd: upstream.cwd, milestone: M }).contract;
    const rule = rt.expectedFrom({ enrollment: time.readEnrollment({ cwd: upstream.cwd, milestone: M }).enrollment, options: time.readOptions({ cwd: upstream.cwd, milestone: M, options_sha256: later.selection.options_sha256 }).record,
      options_sha256: later.selection.options_sha256, selection: later.selection, contract, contract_sha256: digest(contract), ceiling_ms: contract.ceiling_ms });
    assert.strictEqual(rule.status, 'ready', rule.reason); assert.deepStrictEqual(rule.nodes.map(n => n.id), ['PREP', 'N1', 'N2', 'INT', 'REV', 'COR']);
  });
  test('fresh-linked-task-none-with-moved-scope-is-refused-before-selection-activation-and-allocation', () => {
    const { cwd, sha } = prepared(), p = time.timePaths({ cwd, milestone: M }), input = selectionInput(sha, 'none');
    const a = decision(cwd, 'activation', input.contract_request, 'option:short'), l = decision(cwd, 'linked-task', linkedRequest(sha, 'none'), 'linked-task:none');
    rejectsUnchanged(cwd, 'time-selection-scope-incompatible', () => time.recordSelection({ cwd, milestone: M, selection: input, handles: { activation: a.handle, 'linked-task': l.handle }, now: NOW }));
    assert.ok(!fs.existsSync(path.join(p.directory, 'selection.json')));
    assert.strictEqual(time.readSelection({ cwd, milestone: M }).status, 'absent');
    rejectsUnchanged(cwd, 'time-selection-required', () => time.activateContract({ cwd, milestone: M, contract: input.contract_request, handle: a.handle, now: NOW }));
    rejectsUnchanged(cwd, 'time-contract-required', () => delegate(cwd));
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.strictEqual(select(cwd, sha).result.selection.linked_task_authorization, AUTH, 'create-without-auto-start stays valid');
  });
  test('no-contract-selection-and-activation-cross-answers-never-substitute', () => {
    const { cwd, sha } = prepared(), request = { milestone: M, options_sha256: sha, choice: 'no-contract' };
    const input = { choice: 'no-contract', options_sha256: sha, rounds: [] }, run = handles => () => time.recordSelection({ cwd, milestone: M, selection: input, handles, now: NOW });
    rejectsUnchanged(cwd, 'time-decision-attestation-required', run(undefined));
    rejectsUnchanged(cwd, 'time-decision-attestation-required', () => time.recordSelection({ cwd, milestone: M, now: NOW,
      selection: { ...input, decisions: [{ kind: 'activation', decision: { reference: 'x', question: { identity_sha256: 'a'.repeat(64), id: 'q' }, answer: 'no-contract', source: 'user-text', resolved_at: new Date(NOW).toISOString(), request_sha256: digest(request) } }] } }));
    rejectsUnchanged(cwd, 'time-selection-invalid', () => time.recordSelection({ cwd, milestone: M, selection: { ...input, approved: true }, handles: {}, now: NOW }));
    const optionAnswer = decision(cwd, 'activation', request, 'option:short');
    rejectsUnchanged(cwd, 'time-decision-answer-mismatch', run({ activation: optionAnswer.handle }));
    const noContract = decision(cwd, 'activation', request, 'no-contract');
    const recorded = time.recordSelection({ cwd, milestone: M, selection: input, handles: { activation: noContract.handle }, now: NOW });
    assert.strictEqual(recorded.selection.choice, 'no-contract'); assert.strictEqual(recorded.selection.contract_request, null);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent', 'no-contract never activates');
    const contract = contractRequest(sha), live = decision(cwd, 'activation', contract, 'option:short');
    rejectsUnchanged(cwd, 'time-selection-no-contract', () => time.activateContract({ cwd, milestone: M, contract, handle: live.handle, now: NOW }));
    rejectsUnchanged(cwd, 'time-decision-scope-mismatch', () => time.activateContract({ cwd, milestone: M, contract, handle: noContract.handle, now: NOW }));
    const other = prepared(), wrong = contractRequest(other.sha), viaNoContract = decision(other.cwd, 'activation', wrong, 'no-contract');
    rejectsUnchanged(other.cwd, 'time-decision-answer-mismatch', () => time.activateContract({ cwd: other.cwd, milestone: M, contract: wrong, handle: viaNoContract.handle, now: NOW }));
    const unselected = decision(other.cwd, 'activation', wrong, 'option:short');
    rejectsUnchanged(other.cwd, 'time-selection-required', () => time.activateContract({ cwd: other.cwd, milestone: M, contract: wrong, handle: unselected.handle, now: NOW }));
    const s = select(other.cwd, other.sha), different = { ...s.input.contract_request, ceiling_ms: 7200000 }, dd = decision(other.cwd, 'activation', different, 'option:short');
    rejectsUnchanged(other.cwd, 'time-selection-mismatch', () => time.activateContract({ cwd: other.cwd, milestone: M, contract: different, handle: dd.handle, now: NOW }));
    const activated = time.activateContract({ cwd: other.cwd, milestone: M, contract: s.input.contract_request, handle: s.activation.handle, now: NOW });
    assert.strictEqual(activated.status, 'valid'); assert.strictEqual(activated.contract.linked_task.authorization, AUTH);
    const p = time.timePaths({ cwd: other.cwd, milestone: M });
    assert.deepStrictEqual(fs.readdirSync(p.directory).sort(), ['contract.json', 'enrollment.json', 'options', 'selection.json']);
    assert.strictEqual(activated.sha256, digest(JSON.parse(fs.readFileSync(p.contract))), 'pre-activation entries never enter materialization');
    rejectsUnchanged(other.cwd, 'time-options-contract-exists', () => time.recordOptions({ cwd: other.cwd, milestone: M, record: { schema_version: 1, milestone: M, n: 2 } }));
  });
  test('extended-contract-linked-task-chain-forecast-and-schema-agree', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/schemas/forge-milestone-time.schema.json')));
    const { activated } = delegatedSetup(), c = activated.contract;
    assert.strictEqual(time.validateContract(c).valid, true);
    const linked = schema.properties.linked_task.oneOf.find(v => v.type === 'object'), chain = schema.properties.chain_forecast.oneOf.find(v => v.type === 'object');
    assert.deepStrictEqual(linked.required, Object.keys(c.linked_task)); assert.deepStrictEqual(chain.required, Object.keys(c.chain_forecast));
    assert.deepStrictEqual(linked.properties.authorization.enum, [...time.LINKED_TASK_AUTHORIZATIONS]);
    assert.deepStrictEqual(chain.properties.basis.enum, ['milestone-plus-linked-task']);
    assert.deepStrictEqual(schema.$defs.horizon.required, ['low_ms', 'high_ms', 'ceiling_ms']);
    const allocation = schema.properties.allocation.oneOf[1];
    assert.deepStrictEqual(allocation.required, ['roadmap_sha256', 'items']); assert.ok(allocation.properties.structure_sha256);
    assert.deepStrictEqual(allocation.properties.items.items.required, ['id', 'kind', 'ms']); assert.ok(allocation.properties.items.items.properties.nodes);
    for (const key of linked.required) { const copy = structuredClone(c); delete copy.linked_task[key]; assert.strictEqual(time.validateContract(copy).valid, false, key); }
    for (const key of chain.required) { const copy = structuredClone(c); delete copy.chain_forecast[key]; assert.strictEqual(time.validateContract(copy).valid, false, key); }
    for (const key of schema.$defs.horizon.required) { const copy = structuredClone(c); delete copy.linked_task.horizon[key]; assert.strictEqual(time.validateContract(copy).valid, false, key); }
    for (const authorization of [...time.LINKED_TASK_AUTHORIZATIONS, 'auto']) {
      const copy = structuredClone(c); copy.linked_task.authorization = authorization; assert.strictEqual(time.validateContract(copy).valid, authorization !== 'auto');
    }
    for (const mutate of [x => x.chain_forecast.low_ms = x.chain_forecast.high_ms + 1, x => x.linked_task.horizon.low_ms = 2000000, x => x.linked_task.horizon.high_ms = 1900000,
      x => x.linked_task.options_sha256 = 'f'.repeat(64), x => x.linked_task.moved_scope = [], x => x.linked_task.criteria.task = [], x => x.chain_forecast.basis = 'guess',
      x => { x.linked_task = null; }, x => x.linked_task.extra = 1, x => x.linked_task.horizon.ceiling_ms = 0])
      { const copy = structuredClone(c); mutate(copy); assert.strictEqual(time.validateContract(copy).valid, false, String(mutate)); }
    const withoutChain = structuredClone(c); withoutChain.chain_forecast = null; assert.strictEqual(time.validateContract(withoutChain).valid, true);
    const legacyRun = activate(), legacy = legacyRun.result; assert.strictEqual(legacy.contract.linked_task, null); assert.strictEqual(legacy.contract.chain_forecast, null);
    const legacyBytes = fs.readFileSync(time.timePaths({ cwd: legacyRun.cwd, milestone: M }).contract, 'utf8');
    assert.strictEqual(legacyBytes, JSON.stringify({ ...payload(), decision: legacy.contract.decision }) + '\n', 'S01 bytes unchanged');
    assert.strictEqual(legacy.sha256, digest({ ...payload(), decision: legacy.contract.decision }), 'S01 null contracts keep their hash');
    const items = { roadmap_sha256: 'a'.repeat(64), items: [{ id: 'one', kind: 'slice', slice: 'S01', ms: 1 }] };
    for (const [patch, valid] of [[{}, true], [{ structure_sha256: 'b'.repeat(64) }, true], [{ structure_sha256: 'bad' }, false]]) {
      const copy = structuredClone(legacy.contract); copy.allocation = { ...items, ...patch }; assert.strictEqual(time.validateContract(copy).valid, valid);
    }
    for (const [nodes, valid] of [[['N1'], true], [[], true], [['N1', 'N1'], false], [['../x'], false]]) {
      const copy = structuredClone(legacy.contract); copy.allocation = { ...items, items: [{ ...items.items[0], nodes }] }; assert.strictEqual(time.validateContract(copy).valid, valid);
    }
  });
  test('roadmap-identity-structure-stable-for-checkbox-and-formatting-and-refuses-invalid', () => {
    const value = timeSection('a'.repeat(64), 'b'.repeat(64)), text = roadmapText(value), identity = time.roadmapIdentity(text);
    assert.deepStrictEqual(Object.keys(identity), ['sha256', 'structure_sha256']); assert.strictEqual(identity.sha256, digest(Buffer.from(text)));
    assert.deepStrictEqual(time.roadmapIdentity(Buffer.from(text)), identity);
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    for (const variant of [roadmapText(value, { checked: true }), roadmapText(value, { indent: 0 }), roadmapText(reordered), text.replace('## Slices', 'Prosa externa nova.\n\n## Slices')]) {
      const other = time.roadmapIdentity(variant); assert.notStrictEqual(other.sha256, identity.sha256); assert.strictEqual(other.structure_sha256, identity.structure_sha256);
    }
    const moved = structuredClone(value); moved.allocation[1].ms = 1;
    for (const variant of [roadmapText(moved), roadmapText(value, { s02: '' }), roadmapText({ ...value, contract_sha256: 'c'.repeat(64) }), text.replace('Segunda entrega', 'Outra entrega')])
      assert.notStrictEqual(time.roadmapIdentity(variant).structure_sha256, identity.structure_sha256);
    for (const [variant, code] of [[text + '\n## Alocação de tempo\n', 'time-roadmap-section-duplicate'], [roadmapText('{'), 'time-roadmap-json-invalid'],
      [roadmapText(value, { s02: 'S09' }), 'time-roadmap-dependency-invalid'], [roadmapText({ ...value, extra: 1 }), 'time-roadmap-schema-invalid'],
      [Buffer.from([0xff, 0xfe]), 'time-source-encoding-invalid'], [42, 'time-roadmap-invalid']])
      assert.throws(() => time.roadmapIdentity(variant), e => e.code === code, code);
  });
  test('delegated-allocation-real-conformance-under-lock-idempotence-and-refusals', () => {
    const { cwd, sha, base, p } = delegatedSetup(), roadmap = writeRoadmap(cwd, timeSection(sha, base));
    const locking = require('./forge-artifact-reconciliation'), original = locking.withOwnerLock; let locked = 0;
    locking.withOwnerLock = (root, callback) => { locked++; return original(root, callback); };
    let accepted; try { accepted = delegate(cwd); } finally { locking.withOwnerLock = original; }
    assert.strictEqual(locked, 1); assert.strictEqual(accepted.version, 2);
    const row = accepted.chain[1], identity = time.roadmapIdentity(fs.readFileSync(roadmap));
    assert.deepStrictEqual(Object.keys(row).filter(k => k !== 'sha256'), ['schema_version', 'milestone', 'version', 'previous_sha256', 'kind', 'reason', 'patch', 'delegation']);
    assert.strictEqual(row.kind, 'allocation'); assert.ok(!Object.hasOwn(row, 'decision'));
    assert.strictEqual(row.delegation.contract_sha256, base); assert.strictEqual(row.delegation.options_sha256, sha);
    assert.deepStrictEqual(row.delegation.decision, { reference: accepted.contract.decision.reference, question: accepted.contract.decision.question });
    assert.strictEqual(row.delegation.selection_sha256, time.readSelection({ cwd, milestone: M }).selection_sha256); assert.strictEqual(row.delegation.previous_allocation, null);
    assert.deepStrictEqual(accepted.contract.allocation, { roadmap_sha256: identity.sha256, structure_sha256: identity.structure_sha256,
      items: timeSection(sha, base).allocation.map(({ id, kind, slice, ms, nodes }) => ({ id, kind, ...(slice ? { slice } : {}), ms, nodes })) });
    assert.strictEqual(accepted.contract.decision.answer, 'option:short', 'activation authority preserved');
    let before = snapshot(cwd); assert.deepStrictEqual(delegate(cwd), accepted); assert.deepStrictEqual(snapshot(cwd), before);
    writeRoadmap(cwd, timeSection(sha, base), { checked: true, indent: 0 }); before = snapshot(cwd);
    assert.strictEqual(delegate(cwd).version, 2, 'checkbox and formatting are the same structure'); assert.deepStrictEqual(snapshot(cwd), before);
    rejectsUnchanged(cwd, 'time-allocation-conformance-mismatch', () => delegate(cwd, { conformance_sha256: 'f'.repeat(64) }));
    const refusals = [
      ['roadmap-time-node-missing', v => { v.allocation[2].nodes = []; v.allocation[2].kind = 'integration'; delete v.allocation[2].slice; }, { s02: 'S01' }, t => t.replace(/- \[ \] \*\*S02[^\n]*\n/, '')],
      ['roadmap-time-gate-missing', v => { v.allocation[3].nodes = []; }],
      ['roadmap-time-edge-mismatch', v => { v.dependencies = [{ from: 'N2', to: 'N1' }]; }],
      ['roadmap-time-edge-mismatch', v => { v.dependencies[1] = { from: 'G1', to: 'N1' }; }],
      ['roadmap-time-edge-unmapped', () => {}, { s02: '' }],
      ['roadmap-time-node-duplicate', v => { v.allocation[3].nodes = ['G1', 'N1']; }],
      ['roadmap-time-ceiling-exceeded', v => { v.allocation[1].ms = 3600000; }],
      ['roadmap-time-strategy-mismatch', v => { v.position_id = 'P0'; }],
      ['roadmap-time-deferred-mismatch', v => { v.deferred = ['N3', 'N1']; }],
      ['roadmap-time-deferred-mismatch', v => { v.deferred = []; v.allocation[3].nodes = ['G1']; }],
      ['roadmap-time-node-out-of-scope', v => { v.allocation[3].nodes = ['G1', 'N4']; }],
      ['roadmap-time-contract-mismatch', v => { v.contract_sha256 = accepted.sha256; }]];
    for (const [reason, mutate, options = {}, edit = t => t] of refusals) {
      const v = timeSection(sha, base); mutate(v); fs.writeFileSync(roadmap, edit(roadmapText(v, options)));
      const total = v.allocation.reduce((s, r) => s + r.ms, 0);
      if (reason !== 'roadmap-time-ceiling-exceeded') assert.ok(total <= accepted.contract.ceiling_ms, reason + ' stays below the ceiling');
      const snap = snapshot(cwd);
      assert.throws(() => delegate(cwd), e => e.code === 'time-allocation-nonconformant' && e.reason === reason && !e.message.includes(cwd), reason);
      assert.deepStrictEqual(snapshot(cwd), snap, reason + ' wrote bytes');
    }
    fs.writeFileSync(roadmap, roadmapText(timeSection(sha, base)) + '\n## Alocação de tempo\n');
    assert.throws(() => delegate(cwd), e => e.code === 'time-allocation-nonconformant' && e.reason === 'roadmap-time-section-duplicate');
    fs.unlinkSync(roadmap); rejectsUnchanged(cwd, 'time-allocation-roadmap-missing', () => delegate(cwd));
    const smaller = timeSection(sha, base); smaller.allocation = smaller.allocation.map(r => ({ ...r, ms: 100 })); writeRoadmap(cwd, smaller);
    const second = delegate(cwd, { reason: 'Menos tempo técnico com o mesmo escopo' });
    assert.strictEqual(second.version, 3); assert.deepStrictEqual(second.chain[2].delegation.previous_allocation, { version: 2, sha256: accepted.sha256 });
    assert.strictEqual(second.contract.allocation.items.reduce((s, r) => s + r.ms, 0), 400);
    const refined = timeSection(sha, base, { refinements: [{ node: 'N2', parts: ['N2a', 'N2b'] }] });
    refined.allocation = [refined.allocation[0], refined.allocation[1], { id: 's2', kind: 'slice', slice: 'S02', ms: 1000, nodes: ['N2a'] },
      { id: 's3', kind: 'slice', slice: 'S03', ms: 1000, nodes: ['N2b'] }, refined.allocation[3]];
    writeRoadmap(cwd, refined, { extraSlice: '- [ ] **S03: Terceira** `depends:[S02]`\n' });
    const third = delegate(cwd, { reason: 'Reestruturação técnica conforme' });
    assert.strictEqual(third.version, 4); assert.deepStrictEqual(third.chain[3].delegation.previous_allocation, { version: 3, sha256: second.sha256 });
    assert.deepStrictEqual(third.contract.allocation.items.find(r => r.id === 's3').nodes, ['N2b']);
    assert.strictEqual(time.readContract({ cwd, milestone: M }).version, 4);
    const legacy = activate(); writeRoadmap(legacy.cwd, timeSection(sha, base));
    rejectsUnchanged(legacy.cwd, 'time-selection-required', () => delegate(legacy.cwd));
    rejectsUnchanged(owner(), 'time-contract-required', () => delegate(owner()));
    assert.ok(fs.existsSync(path.join(p.amendments, '0004.json')));
  });
  test('delegated-chain-tampering-is-invalid-and-copied-hashes-prove-nothing', () => {
    const tampered = [
      ['time-amendment-invalid', row => { row.delegation.conformance_sha256 = 'f'.repeat(64); }],
      ['time-amendment-invalid', row => { row.delegation.contract_sha256 = 'f'.repeat(64); }],
      ['time-amendment-invalid', row => { row.delegation.decision.reference = 'forged'; }],
      ['time-amendment-invalid', row => { row.delegation.options_sha256 = 'f'.repeat(64); }],
      ['time-amendment-invalid', row => { row.patch.allocation.items[1].ms += 1; }],
      ['time-amendment-invalid', row => { row.kind = 'extension'; }],
      ['time-amendment-invalid', row => { row.decision = row.delegation; }],
      ['time-amendment-invalid', row => { delete row.patch.allocation.structure_sha256; }],
      ['time-delegation-chain-invalid', row => { row.delegation.previous_allocation = { version: 1, sha256: row.previous_sha256 }; }]];
    for (const [reason, change] of tampered) {
      const { cwd, sha, base, p } = delegatedSetup(); writeRoadmap(cwd, timeSection(sha, base)); delegate(cwd);
      const file = path.join(p.amendments, '0002.json'), row = JSON.parse(fs.readFileSync(file)); change(row); write(file, row);
      const read = time.readContract({ cwd, milestone: M }); assert.strictEqual(read.status, 'invalid', reason); assert.strictEqual(read.reason, reason);
    }
  });
  test('mixed-human-and-delegated-chains-keep-read-amend-and-extended-label', () => {
    const admission = require('./forge-milestone-time-admission');
    const { cwd, sha, base } = delegatedSetup(); writeRoadmap(cwd, timeSection(sha, base));
    const first = delegate(cwd), smaller = timeSection(sha, base); smaller.allocation[1].ms = 10; writeRoadmap(cwd, smaller);
    const second = delegate(cwd); assert.strictEqual(second.version, 3, 'two delegated rows without a decision do not conflict');
    assert.ok(first.chain.length === 2 && second.chain.every((r, i) => i === 0 || !r.decision));
    const extension = amend(cwd, amendment(cwd, 'extension', { ceiling_ms: 7200000 }));
    assert.strictEqual(extension.version, 4); assert.strictEqual(extension.contract.ceiling_ms, 7200000);
    assert.strictEqual(admission.readTimeStatus(cwd, M, { now: NOW + 1000 }).state, 'extended');
    const larger = timeSection(sha, base); larger.allocation[1].ms = 5000000; writeRoadmap(cwd, larger);
    const third = delegate(cwd, { reason: 'Alocação dentro do teto estendido' });
    assert.strictEqual(third.version, 5); assert.strictEqual(third.chain.at(-1).kind, 'allocation');
    assert.strictEqual(admission.readTimeStatus(cwd, M, { now: NOW + 1000 }).state, 'extended', 'a delegated allocation keeps the extension label');
    const again = amend(cwd, amendment(cwd, 'extension', { ceiling_ms: 9000000 }));
    assert.strictEqual(again.version, 6); assert.strictEqual(admission.readTimeStatus(cwd, M, { now: NOW + 1000 }).state, 'extended');
    const replay = amendment(cwd, 'continue-to-cap', {}); assert.strictEqual(amend(cwd, replay).version, 7); assert.strictEqual(amend(cwd, replay).version, 7);
    assert.strictEqual(admission.readTimeStatus(cwd, M, { now: NOW + 1000 }).state, 'active');
    const over = timeSection(sha, base); over.allocation[1].ms = 9000001; writeRoadmap(cwd, over);
    assert.throws(() => delegate(cwd), e => e.reason === 'roadmap-time-ceiling-exceeded', 'never extends the ceiling by delegation');
    const legacyOwner = activate().cwd; amend(legacyOwner, amendment(legacyOwner, 'extension', { ceiling_ms: 7200000 }));
    assert.strictEqual(admission.readTimeStatus(legacyOwner, M, { now: NOW + 1000 }).state, 'extended');
  });
  test('interrupted-pre-activation-publication-leaves-no-committed-record', () => {
    const cwd = owner(), p = time.timePaths({ cwd, milestone: M }), link = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('killed'), { code: 'EKILLED' }); };
    try { assert.throws(() => enroll(cwd), e => e.code === 'EKILLED'); } finally { fs.linkSync = link; }
    assert.strictEqual(time.readEnrollment({ cwd, milestone: M }).status, 'absent'); assert.strictEqual(time.readContract({ cwd, milestone: M }).status, 'absent');
    assert.ok(!fs.existsSync(p.directory) || fs.readdirSync(p.directory).length === 0);
    assert.strictEqual(enroll(cwd).status, 'valid'); assert.ok(!fs.existsSync(p.staging) || fs.readdirSync(p.staging).length === 0);
  });
  test('handoff-binding-private-path-and-caller-proof-cannot-mint-publication', () => {
    const { cwd } = activate();
    for (const key of ['record', 'build', 'anchor', 'binding', 'proof']) {
      rejectsUnchanged(cwd, 'time-record-invalid', () => time.publishLinkedTaskHandoff({ cwd, milestone: M, [key]: {} }));
    }
    for (const relative of ['linked-task-bindings/handoff.json', 'linked-task/bindings/handoff.json']) {
      rejectsUnchanged(cwd, 'time-record-path-invalid', () => time.publishOwnerRecord({ cwd, milestone: M, path: relative, record: { schema_version: 1 } }));
      assert.strictEqual(time.readOwnerRecord({ cwd, milestone: M, path: relative }).status, 'invalid');
    }
    assert.deepStrictEqual(time.readHandoffBinding({ cwd, milestone: M }), { status: 'absent' });
    const empty = owner(); rejectsUnchanged(empty, 'time-contract-required', () => time.publishLinkedTaskHandoff({ cwd: empty, milestone: M }));
  });
  console.log(`PASS milestone-time ${passed} named checks`);
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
