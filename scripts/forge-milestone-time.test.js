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
  console.log(`PASS milestone-time ${passed} named checks`);
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
