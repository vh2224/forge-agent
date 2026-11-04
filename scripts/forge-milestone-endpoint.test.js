#!/usr/bin/env node
'use strict';

// T02 endpoint suite: temporary owner/code/home roots, real Git, real controller
// begin/complete, real forge-delivery, real runRootVerification with node commands and
// real forge-pending-questions. No network or provider; every root is removed in finally.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const clock = require('./forge-milestone-time-clock');
const time = require('./forge-milestone-time');
const delivery = require('./forge-delivery');
const controller = require('./forge-unit-controller');
const verify = require('./forge-verify');
const codeRoots = require('./forge-code-roots');
const questions = require('./forge-pending-questions');
const admission = require('./forge-milestone-time-admission');
const endpoint = require('./forge-milestone-endpoint');
const M = 'M001', SCRIPT = path.join(__dirname, 'forge-milestone-endpoint.js');
const SCHEMA = path.join(__dirname, '..', 'shared', 'schemas', 'forge-milestone-endpoint.schema.json');
const ENVELOPE = `.gsd/milestones/${M}/${M}-ENDPOINT-VERIFICATION-primary-ENVELOPE.json`, RECORD = `.gsd/forge/time/${M}/endpoint.json`;
const ANCHORS = `.gsd/forge/time/${M}/endpoint-anchors`;
const phaseCost = require('./forge-phase-cost');
const roots = [];
let checks = 0, serial = 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = ms => new Date(ms).toISOString();
const DOCS_CHECK = "require('assert/strict').equal(require('./notes'), 'docs'); console.log('PASS docs-root-behavior');\n";
const CHECK ="const value = require('./result'); require('assert/strict').equal(typeof value, 'number');\n"
  + "if (process.argv[2]) require('assert/strict').equal(value, Number(process.argv[2]));\nconsole.log('PASS shared-source-behavior');\n";
function pass(name) { checks++; console.log('PASS ' + name); }
function tempDir(prefix) { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(dir); return dir; }
function file(cwd, ref) { return path.join(cwd, ...ref.split('/')); }
function write(cwd, ref, value) {
  const target = file(cwd, ref); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); return target;
}
function json(cwd, ref) { return JSON.parse(fs.readFileSync(file(cwd, ref), 'utf8')); }
// Runs fn and restores every listed file (or its absence) afterwards.
function restoring(cwd, refs, fn) {
  const saved = refs.map(ref => [ref, fs.existsSync(file(cwd, ref)) ? fs.readFileSync(file(cwd, ref)) : null]);
  try { return fn(); } finally { for (const [ref, bytes] of saved) bytes === null ? fs.rmSync(file(cwd, ref), { force: true }) : write(cwd, ref, bytes); }
}
function tree(cwd, sub = '.gsd') {
  const result = {};
  (function visit(dir) {
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name), stat = fs.lstatSync(target);
      if (name === '.locks') continue;
      result[path.relative(cwd, target)] = [stat.mtimeMs, stat.isFile() ? sha(fs.readFileSync(target)) : 'directory'];
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(target);
    }
  })(path.join(cwd, sub));
  return result;
}
function gitIn(cwd) { return args => require('./forge-git-process').git(cwd, args).trim(); }
function commit(git, message) { git(['add', '-A']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]); }
function proof(f) { return clock.readEndpointProof({ cwd: f.cwd, milestone: M }); }
function expectProof(f, status, reason, label) {
  const result = proof(f), seen = JSON.stringify({ status: result.status, reason: result.reason, detail: result.detail, root: result.root_id });
  assert.equal(result.status, status, label + ' ' + seen); if (reason) assert.equal(result.reason, reason, label + ' ' + seen); return result;
}
function authorize(cwd, kind, request, answer) {
  const id = 'q' + ++serial, opened = questions.openQuestions({ cwd, milestone: M, unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Confirma?' }] });
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const live = { reference: 'live-' + serial, status: 'resolved', answer, resolved_at: iso(Date.now() - 1), source: 'user-text',
    question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: M, kind, request_sha256: codeRoots.digest(request), expires_at: Date.now() + 60000 });
}
// One milestone with an S01 contract, one slice and two tasks over real Git: A (T01)
// verifies scripts/result.js at r1, B (T02) legitimately changes it at r2.
// With { docs: true } the milestone spans two physical Git roots: primary (T01, T02) and a separate
// docs repository (T03) whose own command, scope and verification envelope are part of the endpoint.
function fixture(opts = {}) {
  const cwd = tempDir('forge-endpoint-'), git = gitIn(cwd), dir = `.gsd/milestones/${M}`, sdir = `${dir}/slices/S01`;
  git(['init', '--quiet']);
  write(cwd, '.gitignore', '.gsd/\n'); write(cwd, 'scripts/result.js', 'module.exports = 1;\n'); write(cwd, 'scripts/check.js', CHECK);
  commit(git, 'r0 initial');
  const docs = opts.docs ? tempDir('forge-endpoint-docs2-') : null, docsGit = docs ? gitIn(docs) : null;
  if (docs) { docsGit(['init', '--quiet']); write(docs, 'notes.js', "module.exports = 'docs';\n"); write(docs, 'check.js', DOCS_CHECK); commit(docsGit, 'docs root r0'); }
  const execution = docs ? codeRoots.validateContract({ schema_version: 2, owner: cwd, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: cwd }, { id: 'docs', path: docs }] })
    : codeRoots.singleContract(cwd, cwd);
  const header = rootId => docs ? `depends: []\nroots_schema: 2\nprimary_root_id: ${rootId}\ncode_roots:\n`
    + execution.code_roots.map(r => `  - id: ${r.id}\n    path: ${JSON.stringify(r.path.replace(/\\/g, '/'))}\n    vcs: ${r.vcs}\n`).join('') : '';
  const qualify = (rootId, value) => docs ? JSON.stringify(`${rootId}::${value}`) : value;
  fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
  const t0 = Date.now(), inventoryReader = () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }, { id: 'T02' }, ...(docs ? [{ id: 'T03' }] : [])] }] }), completed = {};
  const finish = unit => {
    require('./forge-state').write(cwd, { milestone: M, kind: 'milestone', phase: unit.split('/')[0], active_slice: 'S01',
      active_task: unit.startsWith('execute-task/') ? unit.split('/')[1] : '—', next_action: 'complete', auto_mode: 'on' });
    const request = { milestone: M, unit, host_runtime: 'codex', owner_token: 'fixture-owner', ...(unit.startsWith('complete-milestone/') ? {} : { slice: 'S01' }) };
    const at = Date.now() + 1, opts = { now: () => at, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader };
    const begin = controller.begin(cwd, { ...request, idempotency_key: unit + ':begin' }, opts);
    const done = controller.complete(cwd, { ...request, generation: begin.generation, idempotency_key: unit + ':complete', result: { status: 'succeeded' } }, opts);
    assert.equal(done.transaction.phase, 'committed'); completed[unit] = iso(at);
  };
  const children = [], envelopes = [], revisions = [];
  const tasks = [{ id: 'T01', writes: ['scripts/result.js', 'scripts/check.js'], verify: ['node scripts/check.js'] },
    { id: 'T02', writes: ['scripts/result.js'], verify: ['node scripts/check.js', 'node scripts/check.js 2'], source: 'module.exports = 2;\n' }];
  if (docs) tasks.push({ id: 'T03', root: 'docs', writes: ['check.js', 'notes.js'], verify: ['node check.js'], output: 'notes.js' });
  for (const task of tasks) {
    if (task.source) { write(cwd, 'scripts/result.js', task.source); commit(git, 'B legitimately changes the source verified by A'); }
    revisions.push(git(['rev-parse', 'HEAD']));
    const unit = { type: 'task', id: task.id, slice: 'S01', milestone: M }, base = `${sdir}/tasks/${task.id}/${task.id}`;
    const rootId = task.root || 'primary', q = value => qualify(rootId, value);
    const plan = `---\nid: ${task.id}\n${header(rootId)}writes:\n${task.writes.map(w => `  - ${q(w)}\n`).join('')}must_haves:\n  truths:\n    - observed shared source behavior\n`
      + `  artifacts: []\n  key_links: []\nexpected_output:\n  - ${q(task.output || 'scripts/result.js')}\nverify:\n${task.verify.map(c => `  - ${c}\n`).join('')}---\n`;
    write(cwd, base + '-PLAN.md', plan);
    // The docs task is planned from the docs checkout: same two roots, docs as the plan's primary root.
    const taskContract = rootId === 'docs' ? codeRoots.validateContract({ ...execution, primary_root_id: 'docs' }) : execution;
    const gate = verify.runRootVerification(taskContract, docs ? { unit, planFingerprint: sha(plan), commandTimeoutMs: 30000,
      commandsByRoot: { primary: rootId === 'primary' ? task.verify : ['node scripts/check.js'], docs: rootId === 'docs' ? task.verify : ['node check.js'] } }
      : { unit, planFingerprint: sha(plan), taskPlanVerify: verify.parsePlanVerify(plan), commandTimeoutMs: 30000 });
    const own = gate.roots.find(row => row.root_id === rootId);
    assert.equal(gate.passed, true, JSON.stringify(gate.roots.map(r => r.result.checks.map(c => [c.command, c.exitCode, c.stderr]))));
    const envelopeRef = base + '-VERIFY-ENVELOPE.json'; write(cwd, envelopeRef, own); envelopes.push({ envelopeRef, envelope: own });
    // A criterion without root-qualified paths needs verification from every physical root.
    const bindings = [{ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: envelopeRef, check_index: 0 } }];
    for (const other of gate.roots.filter(row => row !== own)) {
      const otherRef = `${base}-VERIFY-ENVELOPE-${other.root_id}.json`; write(cwd, otherRef, other);
      bindings.push({ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: otherRef, check_index: 0 } });
    }
    const input = { schema_version: docs ? 2 : 1, ...(docs ? { execution_contract: taskContract } : {}), unit, plan: base + '-PLAN.md', plan_fingerprint: sha(plan), bindings };
    write(cwd, base + '-DELIVERY-INPUT.json', input);
    const projected = delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: rootId === 'docs' ? docs : cwd });
    assert(projected.criteria.every(row => row.status === 'verificado'), JSON.stringify([projected.diagnostics, projected.criteria]));
    write(cwd, base + '-DELIVERY.json', projected); children.push({ unit, delivery: base + '-DELIVERY.json' });
    finish('execute-task/' + task.id);
  }
  const sliceBody = '# S01\n- [x] T01: First verified child\n- [x] T02: Later child legitimately changing the shared source\n' + (docs ? '- [x] T03: Docs root child\n' : '');
  // Over two roots the slice plan is structured as well and is verified by both roots like any other plan.
  const slicePlan = docs ? `---\nid: S01\n${header('primary')}writes:\n  - ${qualify('primary', 'scripts/result.js')}\nmust_haves:\n  truths:\n    - slice children verified in every root\n`
    + `  artifacts: []\n  key_links: []\nexpected_output:\n  - ${qualify('primary', 'scripts/result.js')}\n---\n` + sliceBody : sliceBody;
  write(cwd, `${sdir}/S01-PLAN.md`, slicePlan); write(cwd, `${sdir}/S01-REVIEW.md`, '# Revisão S01\nSem objeções.\n');
  const sliceBindings = [];
  if (docs) {
    const unit = { type: 'slice', id: 'S01', milestone: M }, gate = verify.runRootVerification(execution, { unit, planFingerprint: sha(slicePlan), commandTimeoutMs: 30000,
      commandsByRoot: { primary: ['node scripts/check.js'], docs: ['node check.js'] } });
    assert.equal(gate.passed, true);
    for (const row of gate.roots) {
      const ref = `${sdir}/S01-VERIFY-ENVELOPE-${row.root_id}.json`; write(cwd, ref, row);
      sliceBindings.push({ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: ref, check_index: 0 } });
    }
  }
  const sliceInput = { schema_version: docs ? 2 : 1, ...(docs ? { execution_contract: execution } : {}), unit: { type: 'slice', id: 'S01', milestone: M }, plan: `${sdir}/S01-PLAN.md`, plan_fingerprint: sha(slicePlan),
    expected_children: children, bindings: sliceBindings, facts: { review: { status: 'aprovado', reference: 'S01-REVIEW.md' } } };
  write(cwd, `${sdir}/S01-DELIVERY-INPUT.json`, sliceInput);
  write(cwd, `${sdir}/S01-DELIVERY.json`, delivery.buildDelivery(sliceInput, { ownerRoot: cwd, codeDir: cwd }));
  finish('complete-slice/S01');
  const roadmap = `# ${M}: Endpoint fixture\n\n- [x] **S01: Shared source slice** \`risk:low\` \`depends:[]\`\n`;
  write(cwd, `${dir}/${M}-ROADMAP.md`, roadmap);
  const milestoneInput = { schema_version: 2, unit: { type: 'milestone', id: M }, plan: `${dir}/${M}-ROADMAP.md`, plan_fingerprint: sha(roadmap),
    execution_contract: execution, expected_children: [{ unit: { type: 'slice', id: 'S01', milestone: M }, delivery: `${sdir}/S01-DELIVERY.json` }], bindings: [] };
  const publishMilestone = input => {
    write(cwd, `${dir}/${M}-DELIVERY-INPUT.json`, input);
    const projection = delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd }); write(cwd, `${dir}/${M}-DELIVERY.json`, projection); return projection;
  };
  const projection = publishMilestone(milestoneInput);
  if (!docs) assert.deepEqual(projection.diagnostics, ['child_plan_legacy_or_unstructured:M001/slice/S01', 'child_reported:plan_legacy:M001/slice/S01', 'plan_legacy']);
  assert((docs || projection.criteria.length === 2) && projection.criteria.every(row => row.status === 'verificado'), JSON.stringify(projection.diagnostics));
  finish('complete-milestone/' + M);
  const contract = { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' }, activated_at: iso(t0 - 1000), preselection_started_at: iso(t0 - 2000),
    ceiling_ms: opts.ceiling ?? 3600000, endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: { roadmap_sha256: sha(roadmap), items: [{ id: 's1', kind: 'slice', slice: 'S01', ms: Math.min(600000, opts.ceiling ?? 600000) }] }, linked_task: null, chain_forecast: null,
    decision: { reference: 'fixture-only', question: { identity_sha256: 'b'.repeat(64), id: 'q1' }, answer: 'option:balanced', source: 'user-text',
      resolved_at: iso(t0 - 1000), request_sha256: 'c'.repeat(64) } };
  write(cwd, `.gsd/forge/time/${M}/contract.json`, contract);
  return { cwd, git, docs, docsGit, execution, dir, sdir, children, envelopes, revisions, completed, milestoneInput, publishMilestone, roadmap, contract };
}

const home = tempDir('forge-endpoint-home-'), savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home; process.env.USERPROFILE = home;
let completedAll = false;
try {
  const f = fixture(), cwd = f.cwd, readOnly = tree(cwd);
  const strictInput = { cwd, milestone: M };
  // ---- Truth 0: one canonical completion helper, unchanged historical/strict readers.
  const historical = clock.readHistoricalDeliveries(strictInput), strict = clock.readDeliveries(strictInput);
  assert.equal(historical.proven.length, 1, JSON.stringify(historical)); assert.equal(historical.proven[0].coverage.units, 3);
  assert.equal(historical.proven[0].coverage.captures, 2); assert.equal(historical.current_integrated_acceptance, 'not-evaluated');
  assert.notEqual(historical.proven[0].captures[0].revision, historical.proven[0].captures[1].revision);
  assert.equal(strict.proven.length, 0); assert.equal(strict.unproven[0].reason, 'delivery-current-source-changed'); assert.equal(strict.current_source_conformity, 'changed');
  const task = clock.readHistoricalTaskDelivery({ cwd, milestone: M, slice: 'S01', task: 'T01', completedAt: f.completed['execute-task/T01'] });
  assert.equal(task.status, 'proven', JSON.stringify(task));
  const source = fs.readFileSync(path.join(__dirname, 'forge-milestone-time-clock.js'), 'utf8');
  assert.equal(source.split("boundary.handoff_ready !== true").length, 2, 'exactly one canonical completion check');
  assert.equal(source.split('function canonicalCompletion(').length, 2, 'one helper definition');
  assert.match(source, /canonicalCompletion\(options, rows, 'complete-slice\/' \+ slice\)/); assert.match(source, /unit = 'complete-milestone\/' \+ M;[\s\S]*canonicalCompletion\(options, rows, unit\)/);
  expectProof(f, 'unproven', 'endpoint-verification-missing', 'read-only proof');
  assert.deepEqual(tree(cwd), readOnly, 'readers never write');
  restoring(cwd, [path.relative(cwd, controller.transactionFile(cwd, 'complete-slice/S01:complete')).split(path.sep).join('/')], () => {
    const tx = controller.transactionFile(cwd, 'complete-slice/S01:complete'), raw = controller.lookupRecord(cwd, 'transaction', 'complete-slice/S01:complete');
    controller.writeAtomic(tx, { ...raw, phase: 'intent' });
    assert.equal(clock.readHistoricalDeliveries(strictInput).unproven[0].reason, 'delivery-completion-unproven');
  });
  assert.equal(clock.readHistoricalDeliveries(strictInput).proven.length, 1);
  pass('canonical-completion-helper-and-readers');
  console.log('ok - T02 endpoint: scoped canonical completion helper preserves historical and strict readers');

  // ---- Truth 1: completion, delivery, inventory, closed slices, selection and question census.
  const missing = expectProof(f, 'unproven', 'endpoint-verification-missing', 'no fresh envelope yet');
  assert.deepEqual(missing.verification_plan.roots, [{ root_id: 'primary', commands: ['node scripts/check.js', 'node scripts/check.js 2'] }]);
  assert.equal(clock.readEndpointProof({ cwd, milestone: M, proven: true, status: 'proven', proof: { status: 'proven' }, codeDir: home,
    currentHashReader: () => ({ ok: true, hash: 'f'.repeat(40) }) }).reason, 'endpoint-verification-missing', 'caller objects and seams grant nothing');
  assert.equal(clock.readEndpointProof(null).reason, 'endpoint-owner-invalid');
  assert.equal(clock.readEndpointProof({ cwd, milestone: '../M001' }).reason, 'endpoint-milestone-invalid');
  const events = `${f.dir}/${M}-events.jsonl`, milestoneTx = path.relative(cwd, controller.transactionFile(cwd, `complete-milestone/${M}:complete`)).split(path.sep).join('/');
  restoring(cwd, [events, `${f.dir}/${M}-SUMMARY.md`, `.gsd/ledger/${M}.md`, `.gsd/forge/runs/${M}.json`], () => {
    const lines = fs.readFileSync(file(cwd, events), 'utf8').split('\n').filter(line => line && !line.includes(`"complete-milestone/${M}"`));
    write(cwd, events, lines.join('\n') + '\n'); write(cwd, `${f.dir}/${M}-SUMMARY.md`, '# Done\nstatus: complete\n');
    write(cwd, `.gsd/ledger/${M}.md`, `## ${M}\n`); write(cwd, `.gsd/forge/runs/${M}.json`, { id: M, active: false, status: 'complete' });
    expectProof(f, 'unproven', 'endpoint-completion-missing', 'SUMMARY, checkbox, ledger and inactive run are not completion');
  });
  restoring(cwd, [milestoneTx], () => {
    controller.writeAtomic(file(cwd, milestoneTx), { ...controller.lookupRecord(cwd, 'transaction', `complete-milestone/${M}:complete`), phase: 'boundary-ready' });
    assert.equal(expectProof(f, 'unproven', 'endpoint-completion-unproven', 'uncommitted milestone transaction').detail, 'delivery-completion-unproven');
  });
  const mDelivery = `${f.dir}/${M}-DELIVERY.json`, mInput = `${f.dir}/${M}-DELIVERY-INPUT.json`;
  restoring(cwd, [mDelivery], () => { fs.rmSync(file(cwd, mDelivery)); expectProof(f, 'unproven', 'endpoint-delivery-missing', 'milestone delivery missing'); });
  restoring(cwd, [mDelivery], () => {
    write(cwd, mDelivery, delivery.finalizeOutput({ ...json(cwd, mDelivery), criteria: json(cwd, mDelivery).criteria.map(c => ({ ...c, pending: ['unbound'] })) }));
    expectProof(f, 'unproven', 'endpoint-delivery-unproven', 'pending criterion');
  });
  restoring(cwd, [f.envelopes[0].envelopeRef], () => {
    write(cwd, f.envelopes[0].envelopeRef, { ...f.envelopes[0].envelope, result: { ...f.envelopes[0].envelope.result, passed: false } });
    expectProof(f, 'unproven', 'endpoint-delivery-unproven', 'child history is rebuilt, never trusted');
  });
  restoring(cwd, [mDelivery, mInput, `${f.dir}/${M}-ROADMAP.md`], () => {
    const two = f.roadmap + '- [x] **S02: Unlisted slice** `risk:low` `depends:[S01]`\n'; write(cwd, `${f.dir}/${M}-ROADMAP.md`, two);
    f.publishMilestone({ ...f.milestoneInput, plan_fingerprint: sha(two) });
    expectProof(f, 'unproven', 'endpoint-child-inventory-mismatch', 'roadmap slice without expected child');
  });
  restoring(cwd, [`${f.sdir}/S01-REVIEW.md`], () => {
    fs.rmSync(file(cwd, `${f.sdir}/S01-REVIEW.md`));
    const unclosed = expectProof(f, 'unproven', 'endpoint-slice-unclosed', 'unreviewed slice');
    assert.deepEqual([unclosed.slice, unclosed.detail, unclosed.proof], ['S01', 'slice-unreviewed', 'slice-review-missing']);
    assert.deepEqual(controller.sliceClosure(cwd, M, 'S01', Date.now()), { reason: 'slice-unreviewed', proof: 'slice-review-missing' });
  });
  assert.equal(controller.sliceClosure(cwd, M, 'S01', Date.now()), null);
  const contractRef = `.gsd/forge/time/${M}/contract.json`;
  restoring(cwd, [`.gsd/forge/time/${M}/enrollment.json`], () => {
    write(cwd, `.gsd/forge/time/${M}/enrollment.json`, { schema_version: 1, milestone: M, enrolled_at: iso(Date.now() - 5000), source: 'owner' });
    assert.equal(expectProof(f, 'unproven', 'endpoint-selection-undecided', 'enrolled without decided selection').detail, 'roadmap-preexisting');
  });
  restoring(cwd, [contractRef], () => {
    write(cwd, contractRef, { ...f.contract, allocation: { ...f.contract.allocation, roadmap_sha256: 'd'.repeat(64) } });
    expectProof(f, 'unproven', 'endpoint-roadmap-nonconformant', 'allocation of another roadmap');
    write(cwd, contractRef, { ...f.contract, allocation: null }); expectProof(f, 'unproven', 'endpoint-allocation-missing', 'S01 contract without allocation');
    fs.rmSync(file(cwd, contractRef)); expectProof(f, 'unproven', 'endpoint-contract-missing', 'no contract');
    write(cwd, contractRef, '{'); expectProof(f, 'unproven', 'endpoint-contract-invalid', 'damaged contract');
  });
  const opened = questions.openQuestions({ cwd, milestone: M, unit: 'milestone-time/endpoint-check', decision_set: 'milestone-time-linked-task',
    questions: [{ id: 'confirm', question: 'Pergunta obrigatória pendente?' }] });
  assert.equal(expectProof(f, 'unproven', 'endpoint-question-pending', 'required pending question').questions, 1);
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id: 'confirm', answer: 'sim', source: 'user-text' }] });
  expectProof(f, 'unproven', 'endpoint-verification-missing', 'answered question no longer blocks');
  const foreign = [];
  for (let i = 0; i < 65; i++) foreign.push(questions.openQuestions({ cwd, milestone: 'M002', unit: 'milestone-time/foreign-' + i,
    decision_set: 'milestone-time-linked-task', questions: [{ id: 'x' + i, question: 'Alheia?' }] }).identity_sha256);
  assert.equal(expectProof(f, 'unknown', 'endpoint-question-census-unknown', '65 foreign states are never zero').detail, 'census-incomplete');
  for (const id of foreign) for (const suffix of ['.json', '.origin.json']) fs.rmSync(file(cwd, `.gsd/forge/questions/${id}${suffix}`));
  restoring(cwd, [`.gsd/forge/questions/${'e'.repeat(64)}.json`], () => {
    write(cwd, `.gsd/forge/questions/${'e'.repeat(64)}.json`, '{');
    expectProof(f, 'unknown', 'endpoint-question-census-unknown', 'corrupt question state');
  });
  fs.mkdirSync(file(cwd, '.gsd/archive'), { recursive: true }); fs.renameSync(file(cwd, f.dir), file(cwd, `.gsd/archive/${M}`));
  try { assert.equal(expectProof(f, 'unproven', 'endpoint-sources-missing', 'milestone_cleanup archive before the proof').detail, f.dir); }
  finally { fs.renameSync(file(cwd, `.gsd/archive/${M}`), file(cwd, f.dir)); }
  // No endpoint record: checkbox, SUMMARY, ledger, inactive run or an imported timestamp never freeze.
  const unfrozenAt = Date.now(), plain = JSON.stringify(clock.readClock({ cwd, milestone: M, now: unfrozenAt }));
  restoring(cwd, [`${f.dir}/${M}-SUMMARY.md`, `.gsd/ledger/${M}.md`, `.gsd/forge/runs/${M}.json`, `${f.dir}/${M}-ENDPOINT.json`], () => {
    write(cwd, `${f.dir}/${M}-SUMMARY.md`, 'status: complete\n'); write(cwd, `.gsd/ledger/${M}.md`, `## ${M}\n`);
    write(cwd, `.gsd/forge/runs/${M}.json`, { id: M, active: false }); write(cwd, `${f.dir}/${M}-ENDPOINT.json`, { endpoint_at: iso(unfrozenAt - 10), frozen: true });
    assert.equal(JSON.stringify(clock.readClock({ cwd, milestone: M, now: unfrozenAt })), plain, 'byte-identical without endpoint.json');
  });
  assert(!Object.hasOwn(JSON.parse(plain), 'frozen') && !Object.hasOwn(JSON.parse(plain), 'endpoint'));
  pass('proof-negatives-before-fresh-verification');
  console.log('ok - T02 endpoint: proof requires completion delivery inventory closed slices selection and complete question census');

  // ---- Truth 2: fresh integrated envelopes for every physical root and the current source union.
  const schemaOne = { ...f.milestoneInput, schema_version: 1 }; delete schemaOne.execution_contract;
  restoring(cwd, [mDelivery, mInput], () => {
    f.publishMilestone(schemaOne);
    assert.equal(expectProof(f, 'unproven', 'endpoint-verification-unavailable', 'schema 1 has no root contract').detail, 'execution-contract-missing');
    const before = tree(cwd), refused = endpoint.writeEndpointVerification({ cwd, milestone: M });
    assert.deepEqual([refused.status, refused.reason], ['refused', 'endpoint-verification-unavailable']); assert.deepEqual(tree(cwd), before);
  });
  const docs = tempDir('forge-endpoint-docs-'), docsGit = gitIn(docs);
  docsGit(['init', '--quiet']); write(docs, 'README.md', '# docs\n'); commit(docsGit, 'docs root');
  restoring(cwd, [mDelivery, mInput], () => {
    const two = codeRoots.validateContract({ schema_version: 2, owner: cwd, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: cwd }, { id: 'docs', path: docs }] });
    f.publishMilestone({ ...f.milestoneInput, execution_contract: two });
    const result = expectProof(f, 'unproven', 'endpoint-verification-unavailable', 'every root needs declared commands');
    assert.deepEqual([result.detail, result.root_id], ['commands-empty', 'docs']);
  });
  const written = endpoint.writeEndpointVerification({ cwd, milestone: M });
  assert.equal(written.status, 'verified', JSON.stringify(written));
  assert.deepEqual(written.envelopes, [{ root_id: 'primary', reference: ENVELOPE, passed: true, checks: 2 }]);
  const envelope = json(cwd, ENVELOPE);
  assert.deepEqual([envelope.kind, envelope.unit, envelope.root_id, envelope.result.checks.map(c => [c.command, c.exitCode])],
    ['verification', { type: 'milestone', id: M }, 'primary', [['node scripts/check.js', 0], ['node scripts/check.js 2', 0]]]);
  let proven = expectProof(f, 'proven', null, 'fresh verification of the integrated code');
  assert.deepEqual(proven.proof.roots.map(r => r.root_id), codeRoots.validateContract(f.milestoneInput.execution_contract).code_roots.map(r => r.id));
  assert.deepEqual(proven.proof.roots[0].scope.map(r => r.path).sort(), ['scripts/check.js', 'scripts/result.js']);
  assert.equal(proven.proof.roots[0].revision, f.revisions[1]); assert.equal(proven.proof.roots[0].checks, 2);
  assert(!JSON.stringify(proven).includes(cwd) && !JSON.stringify(proven).includes(cwd.replace(/\\/g, '/')));
  const tampered = [
    [e => ({ ...e, unit: { type: 'milestone', id: 'M002' } }), 'endpoint-verification-foreign'],
    [e => ({ ...e, root_identity_sha256: 'f'.repeat(64) }), 'endpoint-verification-foreign'],
    [e => ({ ...e, plan_fingerprint: 'f'.repeat(64) }), 'endpoint-verification-foreign'],
    [e => ({ ...e, code_dir: docs }), 'endpoint-verification-foreign'],
    [e => ({ ...e, result: { ...e.result, checks: e.result.checks.slice(0, 1) } }), 'endpoint-verification-foreign'],
    [e => ({ ...e, captured_at: f.completed[`complete-milestone/${M}`] }), 'endpoint-verification-stale'],
    [e => ({ ...e, captured_at: iso(Date.now() + 3600000) }), 'endpoint-verification-stale'],
    [e => ({ ...e, result: { ...e.result, passed: false } }), 'endpoint-verification-failed'],
    [e => ({ ...e, result: { ...e.result, checks: e.result.checks.map((c, i) => i ? { ...c, exitCode: 1 } : c) } }), 'endpoint-verification-failed'],
    [e => ({ ...e, result: { ...e.result, skipped: 'no-stack' } }), 'endpoint-verification-failed'],
    [e => ({ ...e, result: { ...e.result, checks: [] } }), 'endpoint-verification-failed'],
  ];
  for (const [mutate, reason] of tampered) restoring(cwd, [ENVELOPE], () => { write(cwd, ENVELOPE, mutate(envelope)); expectProof(f, 'unproven', reason, 'envelope ' + reason); });
  restoring(cwd, [ENVELOPE], () => { fs.rmSync(file(cwd, ENVELOPE)); expectProof(f, 'unproven', 'endpoint-verification-missing', 'envelope removed'); });
  restoring(cwd, ['scripts/check.js'], () => { fs.rmSync(file(cwd, 'scripts/check.js')); expectProof(f, 'unproven', 'endpoint-scope-missing', 'declared write absent'); });
  write(cwd, 'scripts/result.js', 'module.exports = "not a number";\n');
  assert.equal(endpoint.writeEndpointVerification({ cwd, milestone: M }).status, 'failed');
  assert.equal(json(cwd, ENVELOPE).result.passed, false, 'a failed fresh run is evidence, never proof');
  write(cwd, 'scripts/result.js', 'module.exports = 2;\n');
  expectProof(f, 'unproven', 'endpoint-verification-failed', 'the failed envelope stays failed');
  assert.equal(endpoint.writeEndpointVerification({ cwd, milestone: M }).status, 'verified');
  expectProof(f, 'proven', null, 'a new fresh verification after the correction');
  write(cwd, 'NOTES.md', 'later legitimate commit\n'); commit(f.git, 'r3 unrelated change');
  assert.equal(expectProof(f, 'unproven', 'endpoint-source-drift', 'checkout moved after capture').detail, 'revision-moved');
  assert.equal(endpoint.writeEndpointVerification({ cwd, milestone: M }).status, 'verified');
  proven = expectProof(f, 'proven', null, 'legitimate update re-verified');
  assert.equal(proven.proof.roots[0].revision, f.git(['rev-parse', 'HEAD']));
  pass('fresh-envelopes-every-root-and-union');
  console.log('ok - T02 endpoint: fresh integrated envelopes cover every physical root and current source union');

  // ---- Truth 3: real Git A/B.
  const ab = clock.readHistoricalDeliveries(strictInput);
  assert.equal(ab.proven.length, 1); pass('endpoint-ab-historical-children');
  const rB = f.git(['rev-parse', 'HEAD:scripts/result.js']);
  assert.equal(proven.proof.roots[0].scope.find(r => r.path === 'scripts/result.js').hash, rB);
  assert.notEqual(ab.proven[0].captures[0].source_bindings[0].hash, rB, 'A captured the r1 blob that B replaced');
  pass('endpoint-ab-proven-without-deadlock');
  restoring(cwd, ['scripts/result.js'], () => {
    write(cwd, 'scripts/result.js', 'module.exports = 2; // changed after the capture\n');
    assert.equal(expectProof(f, 'unproven', 'endpoint-source-drift', 'post-capture drift').detail, 'delivery-current-source-changed');
    const before = tree(cwd), refused = endpoint.recordEndpoint({ cwd, milestone: M });
    assert.deepEqual([refused.status, refused.reason], ['refused', 'endpoint-source-drift']); assert.deepEqual(tree(cwd), before);
    assert(!fs.existsSync(file(cwd, RECORD)));
  });
  pass('endpoint-ab-post-capture-drift');
  assert.equal(clock.readDeliveries(strictInput).unproven[0].reason, 'delivery-current-source-changed'); pass('endpoint-ab-strict-unchanged');
  console.log('ok - T02 endpoint: real Git A B historical children pass and post-capture drift refuses');

  // ---- Truth 4: verification, record, reader and CLI over the immutable owner publication.
  {
    const Module = require('module'), target = require.resolve('./forge-milestone-endpoint'), text = fs.readFileSync(target, 'utf8');
    const saved = Module._load, reads = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync'], originals = Object.fromEntries(reads.map(k => [k, fs[k]]));
    try {
      Module._load = function (id, parent, ...args) { if (parent?.filename === target && id.startsWith('.')) throw Error('eager local'); return saved.call(this, id, parent, ...args); };
      for (const k of reads) fs[k] = () => { throw Error('import I/O'); };
      const mod = new Module(target, module); mod.filename = target; mod.paths = module.paths; mod._compile(text, target);
    } finally { Module._load = saved; Object.assign(fs, originals); }
  }
  for (const name of ['writeEndpointVerification', 'recordEndpoint', 'readEndpoint', 'main']) assert.equal(typeof endpoint[name], 'function');
  assert.equal(endpoint.ENDPOINT_SCHEMA_VERSION, 1);
  assert.deepEqual(endpoint.readEndpoint({ cwd, milestone: M }), { status: 'absent' });
  assert.equal(endpoint.readEndpoint({ cwd, milestone: '../x' }).reason, 'endpoint-milestone-invalid');
  assert.equal(endpoint.recordEndpoint({ cwd, milestone: '../M001' }).reason, 'endpoint-milestone-invalid');
  restoring(cwd, [events], () => {
    fs.appendFileSync(file(cwd, events), JSON.stringify({ event: 'unit-began', milestone: M, unit: 'execute-task/T09', ts: iso(Date.now()), action: 'begin', host_runtime: 'codex' }) + '\n');
    const deferred = endpoint.recordEndpoint({ cwd, milestone: M });
    assert.deepEqual([deferred.status, deferred.reason, deferred.detail], ['refused', 'endpoint-boundary-deferred', 'begin-open']);
    assert(!fs.existsSync(file(cwd, RECORD)));
  });
  const branch = f.git(['symbolic-ref', '--short', 'HEAD']);
  f.git(['checkout', '--quiet', '-b', 'token=fixture']);
  try { assert.equal(endpoint.recordEndpoint({ cwd, milestone: M }).reason, 'endpoint-record-not-public'); assert(!fs.existsSync(file(cwd, RECORD))); }
  finally { f.git(['checkout', '--quiet', branch]); f.git(['branch', '--quiet', '-D', 'token=fixture']); }
  const staging = file(cwd, '.gsd/forge/time-staging'), elsewhere = tempDir('forge-endpoint-link-');
  fs.symlinkSync(elsewhere, staging, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.equal(endpoint.recordEndpoint({ cwd, milestone: M }).reason, 'endpoint-path-link'); assert(!fs.existsSync(file(cwd, RECORD))); }
  finally { try { fs.unlinkSync(staging); } catch { fs.rmdirSync(staging); } }
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing published through the link');
  // ---- Corrective R5: census, contract identity and snapshot are rebuilt inside the one owner publication lock.
  {
    const reconcile = require('./forge-artifact-reconciliation'), savedLock = reconcile.withOwnerLock;
    let raced = null, depth = 0, deepestRace = 0;
    reconcile.withOwnerLock = function (...args) {
      // The canonical question publication commits after the pre-lock proof and before the endpoint publication.
      if (!raced) raced = questions.openQuestions({ cwd, milestone: M, unit: 'milestone-time/endpoint-race', decision_set: 'milestone-time-linked-task',
        questions: [{ id: 'race', question: 'Pergunta obrigatória publicada entre o censo e o registro?' }] });
      depth++; deepestRace = Math.max(deepestRace, depth);
      try { return savedLock.apply(this, args); } finally { depth--; }
    };
    let refusedRace; try { refusedRace = endpoint.recordEndpoint({ cwd, milestone: M, now: Date.now() }); } finally { reconcile.withOwnerLock = savedLock; }
    assert(raced?.identity_sha256, 'the canonical question was published inside the interleaving window');
    assert.deepEqual([refusedRace.status, refusedRace.reason], ['refused', 'endpoint-question-pending'], JSON.stringify(refusedRace));
    assert.equal(deepestRace, 1, 'no nested owner lock');
    assert(!fs.existsSync(file(cwd, RECORD)) && !fs.existsSync(file(cwd, ANCHORS)), 'a stale census publishes neither record nor anchor');
    assert.deepEqual(endpoint.readEndpoint({ cwd, milestone: M }), { status: 'absent' });
    questions.answer({ cwd, identity: raced.identity_sha256, answers: [{ id: 'race', answer: 'sim', source: 'user-text' }] });
    expectProof(f, 'proven', null, 'the answered question no longer blocks the recompute');
    pass('endpoint-publication-lock-recheck');
  }
  // ---- Corrective R6 (replay): an interrupted publication leaves at most an unreferenced anchor.
  {
    const replayAt = Date.now(), savedLink = fs.linkSync;
    fs.linkSync = function (from, to, ...rest) {
      if (path.basename(to) === 'endpoint.json') throw Object.assign(new Error('simulated interruption'), { code: 'EIO' });
      return savedLink.call(this, from, to, ...rest);
    };
    let interrupted; try { interrupted = endpoint.recordEndpoint({ cwd, milestone: M, now: replayAt }); } finally { fs.linkSync = savedLink; }
    assert.equal(interrupted.status, 'refused');
    assert.equal(fs.readdirSync(file(cwd, ANCHORS)).length, 1, 'only the anchor was published'); assert(!fs.existsSync(file(cwd, RECORD)));
    assert.deepEqual(endpoint.readEndpoint({ cwd, milestone: M }), { status: 'absent' });
    assert(!Object.hasOwn(clock.readClock({ cwd, milestone: M, now: replayAt + 1000 }), 'frozen'), 'an incompletely anchored record never freezes');
    const replayed = endpoint.recordEndpoint({ cwd, milestone: M, now: replayAt });
    assert.equal(replayed.status, 'recorded', JSON.stringify(replayed));
    assert.equal(fs.readdirSync(file(cwd, ANCHORS)).length, 1, 'the replay reuses the same anchor');
    assert.equal(endpoint.readEndpoint({ cwd, milestone: M }).status, 'valid');
    // ---- Fourth correction R10: the snapshot authority is derived internally and bound to independent evidence.
    {
      const SNAPSHOTS = `.gsd/forge/time/${M}/endpoint-snapshots`, genuine = json(cwd, RECORD), genuineSha = codeRoots.digest(genuine);
      const genuineAnchor = json(cwd, `${ANCHORS}/${genuineSha}.json`), witness = json(cwd, `${SNAPSHOTS}/${genuineSha}.json`);
      assert.deepEqual([witness.kind, witness.record_sha256, witness.snapshot_sha256, witness.endpoint_at], ['forge-milestone-endpoint-snapshot', genuineSha, genuineAnchor.snapshot_sha256, genuine.endpoint_at]);
      assert(time.isPublicData(witness));
      const forged = structuredClone(genuine);
      for (const k of ['unknown_ms', 'consumed_ms']) { forged.clock[k] += 1000; forged.time_state[k] += 1000; }
      forged.clock.by_class.unknown += 1000; if (forged.time_state.remaining_ms !== null) forged.time_state.remaining_ms -= 1000;
      assert.deepEqual(endpoint.validateEndpointRecord(forged), { valid: true }, 'coherent changed consumption');
      const sectionsOf = (value, keys) => codeRoots.digest(Object.fromEntries(keys.map(k => [k, value[k]])));
      const forgedSha = codeRoots.digest(forged);
      const forgedAnchor = { ...genuineAnchor, record_sha256: forgedSha, snapshot_sha256: sectionsOf(forged, ['endpoint_at', 'time_state', 'clock']),
        proof_sha256: sectionsOf(forged, ['milestone', 'policy', 'contract', 'completion', 'delivery', 'selection', 'roadmap', 'reviews', 'roots', 'questions']) };
      assert.equal(forgedAnchor.proof_sha256, genuineAnchor.proof_sha256, 'the genuine proof sections are retained');
      // Every byte under .gsd except the two imported paths (changed endpoint.json and its matching forged anchor) is compared, including the genuine anchor and witness.
      const imported = new Set([RECORD, `${ANCHORS}/${forgedSha}.json`].map(ref => path.normalize(`.gsd/${ref.replace(/^\.gsd\//, '')}`)));
      const stores = () => Object.fromEntries(Object.entries(tree(cwd)).filter(([name]) => !imported.has(path.normalize(name))).map(([name, row]) => [name, row[1]]));
      const genuineBytes = [RECORD, `${ANCHORS}/${genuineSha}.json`, `${SNAPSHOTS}/${genuineSha}.json`].map(ref => fs.readFileSync(file(cwd, ref)));
      const canonicalBefore = stores(), later = Date.parse(genuine.endpoint_at) + 1000;
      assert(Object.keys(canonicalBefore).some(name => path.normalize(name) === path.normalize(`${SNAPSHOTS}/${genuineSha}.json`)), 'the genuine witness is part of the compared stores');
      assert(Object.keys(canonicalBefore).some(name => path.normalize(name) === path.normalize(`${ANCHORS}/${genuineSha}.json`)), 'the genuine anchor is part of the compared stores');
      // Pair-only import: the genuine anchor and snapshot witness stay in place; only endpoint.json and the forged matching anchor change.
      restoring(cwd, [RECORD, `${ANCHORS}/${forgedSha}.json`], () => {
        write(cwd, RECORD, forged); write(cwd, `${ANCHORS}/${forgedSha}.json`, forgedAnchor);
        const read = endpoint.readEndpoint({ cwd, milestone: M }), live = clock.readClock({ cwd, milestone: M, now: later });
        assert.deepEqual([read.status, read.reason, live.status, live.reason, Object.hasOwn(live, 'frozen')], ['invalid', 'endpoint-snapshot-unbound', 'unknown', 'clock-endpoint-invalid', false]);
        assert.deepEqual(stores(), canonicalBefore, 'genuine anchor, witness and canonical stores untouched by the coherent pair import');
        assert(fs.readFileSync(file(cwd, `${ANCHORS}/${genuineSha}.json`)).equals(genuineBytes[1]) && fs.readFileSync(file(cwd, `${SNAPSHOTS}/${genuineSha}.json`)).equals(genuineBytes[2]), 'genuine witness bytes identical');
      });
      assert(fs.readFileSync(file(cwd, RECORD)).equals(genuineBytes[0]) && endpoint.readEndpoint({ cwd, milestone: M }).status === 'valid', 'the genuine record is restored and valid');
      assert(!fs.existsSync(file(cwd, `${ANCHORS}/${forgedSha}.json`)), 'the forged anchor is gone');
      restoring(cwd, [RECORD, `${ANCHORS}/${genuineSha}.json`, `${SNAPSHOTS}/${genuineSha}.json`, `${ANCHORS}/${forgedSha}.json`], () => {
        fs.rmSync(file(cwd, RECORD)); fs.rmSync(file(cwd, `${ANCHORS}/${genuineSha}.json`)); fs.rmSync(file(cwd, `${SNAPSHOTS}/${genuineSha}.json`));
        // Same current contract and unchanged proof: the builder cannot supply the snapshot.
        assert.throws(() => time.publishAnchoredEndpoint({ cwd, milestone: M, build: () => ({ record: forged }) }), e => e.code === 'endpoint-snapshot-mismatch');
        assert(!fs.existsSync(file(cwd, RECORD)) && !fs.existsSync(file(cwd, `${ANCHORS}/${forgedSha}.json`)) && !fs.existsSync(file(cwd, `${SNAPSHOTS}/${forgedSha}.json`)), 'no partial publication');
        const canonicalOnly = all => Object.fromEntries(Object.entries(all).filter(([name]) => !name.includes('endpoint')));
        assert.deepEqual(canonicalOnly(stores()), canonicalOnly(canonicalBefore), 'canonical completion, delivery and review bytes unchanged');
        const control = time.publishAnchoredEndpoint({ cwd, milestone: M, build: () => ({ record: genuine }) });
        assert.deepEqual([control.status, endpoint.readEndpoint({ cwd, milestone: M }).status], ['published', 'valid'], 'the genuine record still publishes and reads');
        fs.rmSync(file(cwd, `${SNAPSHOTS}/${genuineSha}.json`));
        assert.deepEqual(endpoint.readEndpoint({ cwd, milestone: M }).reason, 'endpoint-snapshot-unbound', 'a missing witness never freezes');
      });
      assert(endpoint.readEndpoint({ cwd, milestone: M }).status === 'valid');
      console.log('ok - T02 endpoint: canonical publication binds genuine clock snapshot against coherent pair and current proof API misuse');
      pass('endpoint-snapshot-coherent-pair-and-builder-negatives');
    }
    fs.rmSync(file(cwd, RECORD)); fs.rmSync(file(cwd, ANCHORS), { recursive: true }); fs.rmSync(file(cwd, `.gsd/forge/time/${M}/endpoint-snapshots`), { recursive: true });
    pass('endpoint-interrupted-publication-replay');
  }
  const recon = require('./forge-artifact-reconciliation'), lock = require('./forge-lock'), order = [];
  const savedOwnerLock = recon.withOwnerLock, savedAcquire = lock.acquireProcessSync;
  let depth = 0, deepest = 0;
  recon.withOwnerLock = function (...args) { depth++; deepest = Math.max(deepest, depth); order.push('owner-lock'); try { return savedOwnerLock.apply(this, args); } finally { depth--; } };
  lock.acquireProcessSync = function (root, name, ...rest) { order.push(name); return savedAcquire.call(this, root, name, ...rest); };
  const endpointAt = Date.now(), beforeClock = clock.readClock({ cwd, milestone: M, now: endpointAt });
  let recorded;
  try { recorded = endpoint.recordEndpoint({ cwd, milestone: M, now: endpointAt, proof: { status: 'proven' }, record: { forged: true }, approved: true }); }
  finally { recon.withOwnerLock = savedOwnerLock; lock.acquireProcessSync = savedAcquire; }
  assert.equal(recorded.status, 'recorded', JSON.stringify(recorded)); assert.equal(recorded.endpoint_at, iso(endpointAt));
  assert.equal(deepest, 1, 'never a nested owner lock'); assert.equal(order.filter(x => x === 'owner-lock').length, 1, 'one canonical publication');
  assert(order.indexOf('unit-controller-transactions') >= 0 && order.indexOf('unit-controller-transactions') < order.indexOf('owner-lock'), order.join(','));
  const stored = endpoint.readEndpoint({ cwd, milestone: M }), record = stored.record, recordBytes = fs.readFileSync(file(cwd, RECORD));
  assert.equal(stored.status, 'valid'); assert.equal(stored.sha256, recorded.sha256); assert(!Object.hasOwn(record, 'forged'));
  assert.equal(record.delivery.fingerprint, proven.proof.delivery.fingerprint); assert.deepEqual(record.roots, proven.proof.roots);
  const mtime = fs.statSync(file(cwd, RECORD)).mtimeMs;
  assert.equal(endpoint.recordEndpoint({ cwd, milestone: M }).status, 'unchanged');
  assert(fs.readFileSync(file(cwd, RECORD)).equals(recordBytes) && fs.statSync(file(cwd, RECORD)).mtimeMs === mtime, 'repeat never writes');
  const savedRead = time.readOwnerRecord;
  time.readOwnerRecord = () => ({ status: 'absent' });
  let conflict; try { conflict = endpoint.recordEndpoint({ cwd, milestone: M, now: endpointAt + 1 }); } finally { time.readOwnerRecord = savedRead; }
  assert.equal(conflict.reason, 'endpoint-record-conflict'); assert(fs.readFileSync(file(cwd, RECORD)).equals(recordBytes));
  const envelopeBytes = fs.readFileSync(file(cwd, ENVELOPE)), late = endpoint.writeEndpointVerification({ cwd, milestone: M });
  assert.deepEqual([late.status, late.reason], ['refused', 'endpoint-already-recorded']); assert(fs.readFileSync(file(cwd, ENVELOPE)).equals(envelopeBytes));
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env } });
  const leak = out => out.includes(cwd) || out.includes(cwd.replace(/\\/g, '/')) || out.includes(cwd.replace(/\\/g, '\\\\'));
  const show = cli('--show', '--cwd', cwd, '--milestone', M, '--json');
  assert.equal(show.status, 0, show.stderr); assert.equal(JSON.parse(show.stdout).sha256, stored.sha256); assert(!leak(show.stdout));
  const proveCli = cli('--prove', '--cwd', cwd, '--milestone', M, '--json');
  assert.equal(proveCli.status, 0, proveCli.stdout); assert.equal(JSON.parse(proveCli.stdout).status, 'proven'); assert(!leak(proveCli.stdout));
  const again = cli('--record', '--cwd', cwd, '--milestone', M, '--json');
  assert.equal(again.status, 0); assert.equal(JSON.parse(again.stdout).status, 'unchanged');
  const verifyCli = cli('--verify', '--cwd', cwd, '--milestone', M, '--json');
  assert.equal(verifyCli.status, 3); assert.equal(JSON.parse(verifyCli.stdout).reason, 'endpoint-already-recorded');
  assert.match(cli('--show', '--cwd', cwd, '--milestone', M).stdout, /^Endpoint registrado em /);
  assert.match(cli('--verify', '--cwd', cwd, '--milestone', M).stdout, /^Operação de endpoint recusada: endpoint-already-recorded/);
  const empty = tempDir('forge-endpoint-empty-'); fs.mkdirSync(path.join(empty, '.gsd/forge'), { recursive: true });
  const refusedCli = cli('--prove', '--cwd', empty, '--milestone', M, '--json');
  assert.equal(refusedCli.status, 3); assert.equal(JSON.parse(refusedCli.stdout).reason, 'endpoint-sources-missing'); assert(!refusedCli.stdout.includes(empty));
  for (const args of [[], ['--show', '--prove', '--cwd', cwd, '--milestone', M], ['--show', '--cwd', cwd], ['--show', '--cwd', cwd, '--milestone', M, '--bad'],
    ['--show', '--cwd', cwd, '--milestone', M, '--timeout-ms', '10'], ['--verify', '--cwd', cwd, '--milestone', M, '--timeout-ms', '0']]) {
    const usage = cli(...args); assert.equal(usage.status, 2, args.join(' ')); assert.match(usage.stderr, /^Uso: /);
  }
  pass('verify-record-read-cli');
  console.log('ok - T02 endpoint: verify record read and CLI use immutable owner publication with typed refusals');

  // ---- Truth 5: schema, public data, 64 KiB bound and validator agree.
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')), F = endpoint.ENDPOINT_RECORD_FIELDS;
  assert.deepEqual([schema.$schema, schema.$id], ['https://json-schema.org/draft/2020-12/schema', 'urn:forge:milestone-endpoint:v1']);
  assert.deepEqual(schema.required, Object.keys(record)); assert.deepEqual(schema.required, [...F.record]);
  for (const key of ['policy', 'contract', 'completion', 'delivery', 'selection', 'roadmap', 'questions', 'time_state', 'clock']) {
    assert.deepEqual(schema.properties[key].required, [...F[key]], key); assert.deepEqual(Object.keys(record[key]), [...F[key]], key);
  }
  for (const [def, key, value] of [['child', 'child', record.delivery.children[0]], ['review', 'review', record.reviews[0]], ['root', 'root', record.roots[0]],
    ['scopeEntry', 'scope', record.roots[0].scope[0]], ['gap', 'gap', record.clock.gaps[0] || { start: 0, end: 0, reason: 'no-source' }]]) {
    assert.deepEqual(schema.$defs[def].required, [...F[key]], def); assert.deepEqual(Object.keys(value), [...F[key]], def);
  }
  assert.deepEqual(schema.properties.selection.properties.status.enum, [...endpoint.SELECTION_STATUSES]);
  assert.deepEqual(schema.properties.time_state.properties.state.enum, [...admission.TIME_STATES, null]);
  assert.deepEqual(schema.properties.time_state.properties.forecast.enum, [...endpoint.FORECASTS]);
  assert.deepEqual(schema.properties.clock.properties.by_class.required, [...clock.CLOCK_POLICY.classes]);
  assert.deepEqual(schema.properties.clock.properties.waits.required, clock.CLOCK_POLICY.classes.filter(k => !clock.CLOCK_POLICY.consumption[k]));
  assert.deepEqual(schema.$defs.gap.properties.reason.enum, [...endpoint.GAP_REASONS]);
  assert.deepEqual([schema.properties.policy.properties.id.const, schema.properties.kind.const, schema.properties.schema_version.const],
    [clock.ENDPOINT_PROOF_POLICY.id, 'forge-milestone-endpoint', endpoint.ENDPOINT_SCHEMA_VERSION]);
  assert(time.isPublicData(record)); assert(recordBytes.length <= 64 * 1024); assert(!leak(recordBytes.toString('utf8')));
  assert.deepEqual(endpoint.validateEndpointRecord(record), { valid: true });
  const clone = () => structuredClone(record), longScope = Array.from({ length: 70 }, (_, i) => ({ path: 'p'.repeat(1000) + i, hash: 'a'.repeat(40) }));
  for (const [mutate, reason] of [
    [r => ({ ...r, extra: 1 }), 'endpoint-record-invalid'], [r => { delete r.questions; return r; }, 'endpoint-record-invalid'],
    [r => { r.selection.status = 'approved'; return r; }, 'endpoint-record-invalid'], [r => { r.time_state.state = 'endpoint-proven'; return r; }, 'endpoint-record-invalid'],
    [r => { r.questions.pending = 1; return r; }, 'endpoint-record-invalid'], [r => { r.roots = []; return r; }, 'endpoint-record-invalid'],
    [r => { r.roots[0].branch = 'token=abc'; return r; }, 'endpoint-record-not-public'], [r => { r.roots[0].scope = longScope; return r; }, 'endpoint-record-too-large'],
    [r => { r.clock.consumed_ms += 1; r.time_state.consumed_ms += 1; return r; }, 'endpoint-record-incoherent'],
    [r => { r.time_state.consumed_ms += 1; return r; }, 'endpoint-record-incoherent'],
    [r => { r.endpoint_at = r.completion.committed_at; return r; }, 'endpoint-record-incoherent']]) {
    assert.equal(endpoint.validateEndpointRecord(mutate(clone())).reason, reason, reason);
  }
  const oversized = clone(); oversized.roots[0].scope = longScope;
  assert.throws(() => time.publishOwnerRecord({ cwd, milestone: M, path: 'endpoint.json', record: oversized }), e => e.code === 'time-source-too-large');
  assert(fs.readFileSync(file(cwd, RECORD)).equals(recordBytes));
  pass('schema-validator-public-bounded');
  console.log('ok - T02 endpoint: schema public data bounded record and validator agree');

  // ---- Truth 6: frozen clock.
  assert.deepEqual(record.clock.effort, beforeClock.effort, 'effort copied as observed; owner verification is not worker effort');
  assert.equal(record.clock.effort.worker.invocations, 0); assert.equal(record.clock.consumed_ms, beforeClock.consumption.consumed_ms);
  assert.deepEqual(record.clock.by_class, beforeClock.consumption.by_class);
  const later = endpointAt + 5000, frozen = clock.readClock({ cwd, milestone: M, now: later });
  assert.equal(frozen.frozen, true); assert.deepEqual(frozen.endpoint, { at: iso(endpointAt), sha256: stored.sha256 });
  assert.deepEqual(frozen.consumption, { consumed_ms: record.clock.consumed_ms, unknown_ms: record.clock.unknown_ms, by_class: record.clock.by_class });
  assert.deepEqual([frozen.effort, frozen.waits, frozen.gaps], [record.clock.effort, record.clock.waits, record.clock.gaps]);
  assert.equal(frozen.elapsed.after_endpoint_ms, 5000); assert.equal(frozen.elapsed.since_activation_ms, later - Date.parse(f.contract.activated_at));
  assert(frozen.sources.some(s => s.path === events && s.status === 'valid') && frozen.sources.some(s => s.path === RECORD && s.status === 'valid'));
  const status = admission.readTimeStatus(cwd, M, { now: later });
  assert.equal(status.contract, 'valid'); assert.equal(status.clocks.consumed_ms, record.clock.consumed_ms);
  assert(!status.unknowns.includes('clock-source-unstable'), JSON.stringify(status.unknowns)); assert.deepEqual(status.open_writers, []);
  assert(!Object.hasOwn(clock.readClock({ cwd, milestone: M, now: endpointAt - 1 }), 'frozen'), 'before endpoint_at the clock runs normally');
  const request = { kind: 'extension', reason: 'Extensão explícita depois do endpoint', patch: { ceiling_ms: 7200000 } };
  time.amendContract({ cwd, milestone: M, ...request, handle: authorize(cwd, 'extension', request, 'extend:7200000') });
  assert.equal(time.readContract({ cwd, milestone: M }).version, 2); assert.equal(endpoint.readEndpoint({ cwd, milestone: M }).status, 'valid');
  time.appendJournal({ cwd, milestone: M, record: { type: 'presence', session_sha256: null, boundary: 'status', at: iso(later + 1000) } });
  fs.appendFileSync(file(cwd, events), [['unit-began', 'begin', 2000], ['unit-transition', 'complete', 60000]].map(([event, action, at]) =>
    JSON.stringify({ event, milestone: M, unit: 'execute-task/T09', ts: iso(later + at), action, host_runtime: 'codex' })).join('\n') + '\n');
  const reopened = clock.readClock({ cwd, milestone: M, now: later + 120000 });
  assert.equal(reopened.frozen, true); assert.deepEqual(reopened.consumption, frozen.consumption, 'extension, journal and events never reopen');
  assert.equal(reopened.elapsed.after_endpoint_ms, 125000);
  for (const mutate of [r => { r.clock.consumed_ms += 1; }, r => { r.milestone = 'M002'; }, r => { r.contract.sha256 = 'e'.repeat(64); r.contract.version = 2; }]) {
    restoring(cwd, [RECORD], () => {
      const value = clone(); mutate(value); fs.writeFileSync(file(cwd, RECORD), JSON.stringify(value) + '\n');
      const read = clock.readClock({ cwd, milestone: M, now: later }); assert.deepEqual([read.status, read.reason], ['unknown', 'clock-endpoint-invalid']);
    });
  }
  restoring(cwd, [RECORD], () => {
    fs.writeFileSync(file(cwd, RECORD), JSON.stringify(record, null, 2) + '\n');
    assert.equal(clock.readClock({ cwd, milestone: M, now: later }).reason, 'clock-endpoint-invalid', 'non-canonical bytes');
  });
  assert.equal(clock.readClock({ cwd, milestone: M, now: later }).frozen, true);
  pass('frozen-clock-snapshot-sources-elapsed');

  // ---- Corrective R6: the payload is bound to its publication anchor, never to its own digest.
  const anchorRef = `${ANCHORS}/${stored.sha256}.json`, anchorBytes = fs.readFileSync(file(cwd, anchorRef));
  {
    const anchor = JSON.parse(anchorBytes.toString('utf8'));
    assert.deepEqual([anchor.kind, anchor.milestone, anchor.record_sha256, anchor.contract.sha256], ['forge-milestone-endpoint-anchor', M, stored.sha256, record.contract.sha256]);
    assert(time.isPublicData(anchor) && anchorBytes.toString('utf8') === JSON.stringify(anchor) + '\n');
    const coherent = mutate => { const value = clone(); mutate(value); assert.deepEqual(endpoint.validateEndpointRecord(value), { valid: true }, 'coherent in every closed check'); return value; };
    const forgeries = [
      coherent(v => { for (const k of ['unknown_ms', 'consumed_ms']) { v.clock[k] += 1000; v.time_state[k] += 1000; } v.clock.by_class.unknown += 1000; }),
      coherent(v => { v.completion.event_sha256 = 'a'.repeat(64); }),
      coherent(v => { v.delivery.sha256 = 'b'.repeat(64); v.delivery.fingerprint = 'c'.repeat(64); })];
    const state = () => [endpoint.readEndpoint({ cwd, milestone: M }), clock.readClock({ cwd, milestone: M, now: later })];
    for (const forged of forgeries) {
      restoring(cwd, [RECORD], () => {
        fs.writeFileSync(file(cwd, RECORD), JSON.stringify(forged) + '\n');
        const [read, live] = state();
        assert.deepEqual([read.status, read.reason], ['invalid', 'endpoint-anchor-missing']);
        assert.deepEqual([live.status, live.reason, Object.hasOwn(live, 'frozen')], ['unknown', 'clock-endpoint-invalid', false]);
      });
    }
    // A schema-valid record written through the generic owner-record API carries no authority.
    restoring(cwd, [RECORD, anchorRef], () => {
      fs.rmSync(file(cwd, RECORD)); fs.rmSync(file(cwd, anchorRef));
      assert.equal(time.publishOwnerRecord({ cwd, milestone: M, path: 'endpoint.json', record: forgeries[0] }).status, 'published');
      const [read, live] = state();
      assert.deepEqual([read.status, read.reason, live.reason], ['invalid', 'endpoint-anchor-missing', 'clock-endpoint-invalid']);
      assert.throws(() => time.publishOwnerRecord({ cwd, milestone: M, path: `endpoint-anchors/${codeRoots.digest(forgeries[0])}.json`, record: JSON.parse(anchorBytes.toString('utf8')) }),
        e => e.code === 'time-record-path-invalid');
      const replay = endpoint.recordEndpoint({ cwd, milestone: M, now: later + 200000 });
      assert.deepEqual([replay.status, replay.reason], ['refused', 'endpoint-record-invalid']);
      assert(!fs.existsSync(file(cwd, anchorRef)), 'no anchor is minted for an imported record');
    });
    for (const [label, bytes, reason] of [
      ['changed snapshot digest', JSON.stringify({ ...anchor, snapshot_sha256: 'd'.repeat(64) }) + '\n', 'endpoint-anchor-mismatch'],
      ['changed contract binding', JSON.stringify({ ...anchor, contract: { ...anchor.contract, version: 9 } }) + '\n', 'endpoint-anchor-mismatch'],
      ['non-canonical bytes', JSON.stringify(anchor, null, 2) + '\n', 'endpoint-anchor-invalid']]) {
      restoring(cwd, [anchorRef], () => {
        fs.writeFileSync(file(cwd, anchorRef), bytes);
        const [read, live] = state(); assert.deepEqual([read.reason, live.reason], [reason, 'clock-endpoint-invalid'], label);
      });
    }
    restoring(cwd, [anchorRef], () => {
      fs.rmSync(file(cwd, anchorRef)); const [read, live] = state();
      assert.deepEqual([read.reason, live.reason], ['endpoint-anchor-missing', 'clock-endpoint-invalid']);
    });
    assert.throws(() => time.publishAnchoredEndpoint({ cwd, milestone: M, build: () => ({ record: forgeries[0], anchor: { ...JSON.parse(anchorBytes.toString('utf8')) } }) }),
      e => e.code === 'time-record-invalid', 'an anchor naming another record is refused');
    assert(fs.readFileSync(file(cwd, anchorRef)).equals(anchorBytes) && state()[0].status === 'valid');
    pass('endpoint-anchor-binding-negatives');

    // ---- Corrective R8: coherent endpoint+anchor and API misuse refuse against untouched canonical stores.
    const sections = (value, keys) => codeRoots.digest(Object.fromEntries(keys.map(k => [k, value[k]])));
    const anchorFor = value => ({ ...anchor, record_sha256: codeRoots.digest(value),
      proof_sha256: sections(value, ['milestone', 'policy', 'contract', 'completion', 'delivery', 'selection', 'roadmap', 'reviews', 'roots', 'questions']),
      snapshot_sha256: sections(value, ['endpoint_at', 'time_state', 'clock']) });
    assert.equal(typeof anchor.completion_key, 'string');
    const contents = () => Object.fromEntries(Object.entries(tree(cwd)).map(([name, row]) => [name, row[1]])), canonicalBefore = contents();
    for (const [label, forged, detail] of [['completion event', forgeries[1], 'completion-mismatch'], ['delivery digest', forgeries[2], 'delivery-mismatch']]) {
      const forgedAnchor = anchorFor(forged), forgedRef = `${ANCHORS}/${codeRoots.digest(forged)}.json`;
      restoring(cwd, [RECORD, anchorRef, forgedRef], () => {
        fs.writeFileSync(file(cwd, RECORD), JSON.stringify(forged) + '\n'); fs.writeFileSync(file(cwd, forgedRef), JSON.stringify(forgedAnchor) + '\n');
        const [read, live] = state();
        assert.deepEqual([read.status, read.reason, read.detail, live.status, live.reason], ['invalid', 'endpoint-canonical-mismatch', detail, 'unknown', 'clock-endpoint-invalid'], label);
      });
    }
    // The publisher recomputes the proof: a coherent forged record is refused with or without a caller anchor.
    restoring(cwd, [RECORD, anchorRef], () => {
      fs.rmSync(file(cwd, RECORD)); fs.rmSync(file(cwd, anchorRef));
      const forgedRef = `${ANCHORS}/${codeRoots.digest(forgeries[1])}.json`;
      assert.throws(() => time.publishAnchoredEndpoint({ cwd, milestone: M, build: () => ({ record: forgeries[1], anchor: anchorFor(forgeries[1]) }) }),
        e => e.code === 'time-record-invalid', 'a caller anchor is never accepted');
      for (const forged of [forgeries[0], forgeries[1], forgeries[2]]) {
        assert.throws(() => time.publishAnchoredEndpoint({ cwd, milestone: M, build: () => ({ record: forged }) }), e => e.code === 'endpoint-proof-mismatch');
      }
      assert(!fs.existsSync(file(cwd, RECORD)) && !fs.existsSync(file(cwd, forgedRef)), 'no partial publication');
    });
    assert.deepEqual(contents(), canonicalBefore, 'canonical stores untouched by the misuse attempts');
    assert(state()[0].status === 'valid');
    console.log('ok - T02 endpoint: coherent endpoint anchor forgery refuses against canonical immutable evidence');
    pass('endpoint-anchor-canonical-misuse-negatives');
  }

  // ---- Corrective R7: a valid endpoint is resolved before live consumption is recomputed.
  {
    const nowAt = later + 120000, journalRef = `.gsd/forge/time/${M}/journal.jsonl`, savedMax = phaseCost.MAX_BYTES;
    const baseline = clock.readClock({ cwd, milestone: M, now: nowAt });
    assert.equal(baseline.frozen, true); assert.equal(baseline.sources.some(s => s.path === 'live-consumption'), false, 'healthy live sources add no marker');
    const same = live => {
      assert.equal(live.status, 'measured'); assert.equal(live.frozen, true); assert.deepEqual(live.endpoint, baseline.endpoint);
      assert.deepEqual(live.consumption, baseline.consumption); assert.deepEqual([live.effort, live.waits, live.gaps], [baseline.effort, baseline.waits, baseline.gaps]);
      assert.deepEqual(live.elapsed, baseline.elapsed);
      assert(live.sources.some(s => s.path === RECORD && s.status === 'valid'), 'bounded current-source metadata keeps the record');
      return live.sources.find(s => s.path === 'live-consumption');
    };
    phaseCost.MAX_BYTES = 64;
    try {
      const marker = same(clock.readClock({ cwd, milestone: M, now: nowAt }));
      assert.deepEqual([marker.status, marker.reason, marker.sha256], ['unavailable', 'clock-source-limit', null]);
      // Corrective R9: under the live size limit the real status keeps the terminal data; writers are explicitly unknown, never zero.
      const limited = admission.readTimeStatus(cwd, M, { now: nowAt }), summary = admission.summarizeTimeStatus(limited);
      assert.deepEqual([limited.contract, limited.clocks.consumed_ms, limited.clocks.unknown_ms], ['valid', baseline.consumption.consumed_ms, baseline.consumption.unknown_ms]);
      assert(Number.isSafeInteger(limited.remaining_ms) && limited.unknowns.includes('open-writers-unknown'), 'unknown writers stay explicit');
      assert.deepEqual([summary.consumed_ms, summary.unknown], [baseline.consumption.consumed_ms, true]);
      restoring(cwd, [RECORD], () => {
        fs.rmSync(file(cwd, RECORD)); const legacy = clock.readClock({ cwd, milestone: M, now: nowAt });
        assert.deepEqual([legacy.status, legacy.reason, Object.hasOwn(legacy, 'frozen')], ['unknown', 'clock-source-limit', false], 'without an endpoint the legacy path is unchanged');
      });
      restoring(cwd, [RECORD], () => {
        const forged = clone(); forged.clock.by_class.unknown += 1000; forged.clock.unknown_ms += 1000; forged.clock.consumed_ms += 1000;
        forged.time_state.unknown_ms += 1000; forged.time_state.consumed_ms += 1000;
        fs.writeFileSync(file(cwd, RECORD), JSON.stringify(forged) + '\n');
        assert.equal(clock.readClock({ cwd, milestone: M, now: nowAt }).reason, 'clock-endpoint-invalid', 'tamper still fails closed under the limit');
      });
    } finally { phaseCost.MAX_BYTES = savedMax; }
    restoring(cwd, [journalRef], () => {
      write(cwd, journalRef, '{broken\n');
      const marker = same(clock.readClock({ cwd, milestone: M, now: nowAt }));
      assert.equal(marker.status, 'unavailable'); assert.match(marker.reason, /^(?:time|clock)-/);
      // Corrective R9: the healthy event stream is listed, so the real status keeps the frozen consumption and known writers.
      const status = admission.readTimeStatus(cwd, M, { now: nowAt });
      assert.deepEqual([status.contract, status.clocks.consumed_ms, status.clocks.unknown_ms, status.remaining_ms],
        [ 'valid', baseline.consumption.consumed_ms, baseline.consumption.unknown_ms, status.horizon.ceiling_ms - baseline.consumption.consumed_ms]);
      assert(Array.isArray(status.open_writers) && !status.unknowns.includes('open-writers-unknown'), 'writers observed from the healthy stream');
      assert.equal(admission.summarizeTimeStatus(status).consumed_ms, baseline.consumption.consumed_ms);
    });
    assert.equal(clock.readClock({ cwd, milestone: M, now: nowAt }).sources.some(s => s.path === 'live-consumption'), false);
    console.log('ok - T02 endpoint: frozen admission retains consumption with bounded known or unknown writers');
    pass('frozen-snapshot-survives-live-source-limit');
  }
  console.log('ok - T02 endpoint: frozen clock preserves snapshot and coherent sources while elapsed stays separate');

  // ---- Third scoped completion: two physical Git roots, each with its own commands, scope and fresh envelope.
  {
    const g = fixture({ docs: true }), gc = g.cwd, gd = g.docs, DOCS_ENVELOPE = ENVELOPE.replace('-primary-', '-docs-');
    const [one, two] = g.execution.code_roots;
    assert.deepEqual([one.id, two.id], ['primary', 'docs']); assert.notEqual(one.identity_sha256, two.identity_sha256);
    assert.notEqual(fs.realpathSync.native(gc), fs.realpathSync.native(gd)); assert.notEqual(g.git(['rev-parse', '--git-dir']), '');
    assert(fs.existsSync(path.join(gd, '.git')) && fs.existsSync(path.join(gc, '.git')), 'two physical Git repositories');
    const plan = expectProof(g, 'unproven', 'endpoint-verification-missing', 'each root needs its own fresh envelope').verification_plan;
    assert.deepEqual(plan.roots, [{ root_id: 'primary', commands: ['node scripts/check.js', 'node scripts/check.js 2'] }, { root_id: 'docs', commands: ['node check.js'] }]);
    const wrote = endpoint.writeEndpointVerification({ cwd: gc, milestone: M });
    assert.equal(wrote.status, 'verified', JSON.stringify(wrote));
    assert.deepEqual(wrote.envelopes, [{ root_id: 'primary', reference: ENVELOPE, passed: true, checks: 2 }, { root_id: 'docs', reference: DOCS_ENVELOPE, passed: true, checks: 1 }]);
    const envelopes = [json(gc, ENVELOPE), json(gc, DOCS_ENVELOPE)];
    for (const [env, row] of [[envelopes[0], one], [envelopes[1], two]]) {
      assert.deepEqual([env.root_id, env.root_identity_sha256, env.execution_contract_sha256, env.result.passed, !!env.result.skipped],
        [row.id, row.identity_sha256, codeRoots.digest(g.execution), true, false]);
      assert(env.result.checks.every(c => c.exitCode === 0 && !c.skipped));
    }
    assert.deepEqual(envelopes[1].result.checks.map(c => c.command), ['node check.js']); assert.equal(envelopes[1].code_dir, gd);
    const first = expectProof(g, 'proven', null, 'both physical roots freshly verified');
    assert.deepEqual(first.proof.roots.map(r => r.root_id), ['primary', 'docs']);
    assert.deepEqual(first.proof.roots.map(r => r.root_identity_sha256), [one.identity_sha256, two.identity_sha256]);
    assert.deepEqual(first.proof.roots.map(r => r.checks), [2, 1]);
    assert.deepEqual(first.proof.roots[0].scope.map(r => r.path).sort(), ['scripts/check.js', 'scripts/result.js']);
    assert.deepEqual(first.proof.roots[1].scope.map(r => r.path).sort(), ['check.js', 'notes.js'], 'the docs root scope comes from the union of declared plans');
    assert.deepEqual([first.proof.roots[0].revision, first.proof.roots[1].revision], [g.git(['rev-parse', 'HEAD']), g.docsGit(['rev-parse', 'HEAD'])]);
    assert(!JSON.stringify(first).includes(gc) && !JSON.stringify(first).includes(gd));
    // Second-root-only negatives: the primary evidence stays valid and untouched, only the docs root changes.
    const bytesOf = () => Object.fromEntries(Object.entries(tree(gc)).map(([name, row]) => [name, row[1]]));
    const primaryBytes = fs.readFileSync(file(gc, ENVELOPE)), before = bytesOf();
    restoring(gd, ['notes.js'], () => {
      write(gd, 'notes.js', "module.exports = 'docs changed after the capture';\n");
      const drift = expectProof(g, 'unproven', 'endpoint-source-drift', 'docs scoped source changed after capture');
      assert.deepEqual([drift.root_id, drift.detail], ['docs', 'delivery-current-source-changed']);
      const refused = endpoint.recordEndpoint({ cwd: gc, milestone: M });
      assert.deepEqual([refused.status, refused.reason], ['refused', 'endpoint-source-drift']);
      assert(!fs.existsSync(file(gc, RECORD)) && !fs.existsSync(file(gc, ANCHORS)), 'no partial publication');
    });
    restoring(gc, [DOCS_ENVELOPE], () => {
      fs.rmSync(file(gc, DOCS_ENVELOPE));
      assert.equal(expectProof(g, 'unproven', 'endpoint-verification-missing', 'docs envelope removed').root_id, 'docs');
      assert.equal(endpoint.recordEndpoint({ cwd: gc, milestone: M }).reason, 'endpoint-verification-missing'); assert(!fs.existsSync(file(gc, RECORD)));
    });
    restoring(gc, [DOCS_ENVELOPE], () => {
      write(gc, DOCS_ENVELOPE, { ...envelopes[1], captured_at: g.completed[`complete-milestone/${M}`] });
      assert.equal(expectProof(g, 'unproven', 'endpoint-verification-stale', 'docs envelope predates the completion').root_id, 'docs');
    });
    restoring(gc, [DOCS_ENVELOPE], () => {
      write(gc, DOCS_ENVELOPE, { ...envelopes[1], result: { ...envelopes[1].result, checks: envelopes[1].result.checks.map(c => ({ ...c, exitCode: 1 })) } });
      assert.equal(expectProof(g, 'unproven', 'endpoint-verification-failed', 'docs check failed').root_id, 'docs');
    });
    assert(fs.readFileSync(file(gc, ENVELOPE)).equals(primaryBytes), 'primary evidence never touched');
    assert.deepEqual(bytesOf(), before, 'the refusals left the owner stores untouched');
    expectProof(g, 'proven', null, 'restored two-root evidence');
    // A legitimate update of only the docs repository: stale until the owner re-verifies both roots.
    write(gd, 'extra.md', 'later docs commit\n'); commit(g.docsGit, 'docs r1 unrelated change');
    const moved = expectProof(g, 'unproven', 'endpoint-source-drift', 'docs checkout moved after capture');
    assert.deepEqual([moved.root_id, moved.detail], ['docs', 'revision-moved']);
    assert.equal(endpoint.writeEndpointVerification({ cwd: gc, milestone: M }).status, 'verified');
    const proven2 = expectProof(g, 'proven', null, 'both roots re-verified after the docs update');
    assert.deepEqual([proven2.proof.roots[0].revision, proven2.proof.roots[1].revision], [g.git(['rev-parse', 'HEAD']), g.docsGit(['rev-parse', 'HEAD'])]);
    assert.notEqual(proven2.proof.roots[1].revision, first.proof.roots[1].revision);
    // Publication and frozen reads over both roots.
    const at = Date.now(), recordedTwo = endpoint.recordEndpoint({ cwd: gc, milestone: M, now: at });
    assert.equal(recordedTwo.status, 'recorded', JSON.stringify(recordedTwo));
    const read = endpoint.readEndpoint({ cwd: gc, milestone: M });
    assert.equal(read.status, 'valid', JSON.stringify(read)); assert.deepEqual(read.record.roots, proven2.proof.roots);
    assert.deepEqual(read.record.roots.map(r => r.root_id), ['primary', 'docs']); assert.deepEqual(endpoint.validateEndpointRecord(read.record), { valid: true });
    assert.notEqual(read.record.roots[0].envelope_sha256, read.record.roots[1].envelope_sha256);
    assert(time.isPublicData(read.record) && !fs.readFileSync(file(gc, RECORD), 'utf8').includes(gd.replace(/\\/g, '/')) && !fs.readFileSync(file(gc, RECORD), 'utf8').includes(gc.replace(/\\/g, '/')));
    assert.equal(endpoint.recordEndpoint({ cwd: gc, milestone: M }).status, 'unchanged', 'repeat is idempotent');
    const live = clock.readClock({ cwd: gc, milestone: M, now: at + 5000 });
    assert.equal(live.frozen, true); assert.deepEqual(live.endpoint, { at: iso(at), sha256: read.sha256 }); assert.equal(live.elapsed.after_endpoint_ms, 5000);
    assert.equal(admission.readTimeStatus(gc, M, { now: at + 5000 }).contract, 'valid');
    pass('endpoint-two-physical-roots-proof-publication-refusal');
    console.log('ok - T02 endpoint: two physical roots complete integrated proof publication and scoped refusal');
  }

  // ---- Fourth correction R11: at the cap an unreadable writer census is never an empty one.
  {
    const c = fixture({ ceiling: 1 }), cc = c.cwd, EVENTS = `.gsd/milestones/${M}/${M}-events.jsonl`;
    assert.equal(endpoint.writeEndpointVerification({ cwd: cc, milestone: M }).status, 'verified');
    const at = Date.now(), recorded = endpoint.recordEndpoint({ cwd: cc, milestone: M, now: at });
    assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
    const snapshot = endpoint.readEndpoint({ cwd: cc, milestone: M }).record.clock, now = at + 5000;
    assert(snapshot.consumed_ms >= 1, 'the frozen consumption reached the cap');
    time.recordCheckpoint({ cwd: cc, milestone: M, record: { version: 1, decision_pending: true } });
    const healthy = admission.readTimeStatus(cc, M, { now });
    assert.deepEqual([healthy.state, healthy.checkpoint?.decision_pending, healthy.unknowns.includes('open-writers-unknown'), healthy.open_writers], ['checkpointed', true, false, []], 'known empty census keeps the checkpoint');
    const refuse = () => {
      const decision = admission.decideAdmission(cc, { milestone: M, unit: 'execute-task/T09', now });
      assert.deepEqual([decision.allowed, decision.reason_code], [false, 'milestone-budget-exhausted']);
      assert.throws(() => admission.assertTransportEntry({ cwd: cc, milestone: M, unit: 'execute-task/T09', now }), e => e.code === 'milestone-budget-exhausted' && e.provider_called === false);
    };
    refuse();
    const savedMax = phaseCost.MAX_BYTES;
    phaseCost.MAX_BYTES = 64;
    try {
      const limited = admission.readTimeStatus(cc, M, { now });
      assert.deepEqual([limited.contract, limited.clocks.consumed_ms, limited.clocks.unknown_ms], ['valid', snapshot.consumed_ms, snapshot.unknown_ms], 'terminal consumption preserved');
      assert(limited.remaining_ms <= 0 && limited.unknowns.includes('open-writers-unknown'));
      assert.deepEqual([limited.state, limited.checkpoint], ['draining', null], 'neither a ready checkpoint nor an exhausted-as-zero state');
      assert.equal(admission.summarizeTimeStatus(limited).unknown, true);
      refuse();
    } finally { phaseCost.MAX_BYTES = savedMax; }
    // Actual CLI over a real oversized event stream: the same unknown census, the same refusal.
    restoring(cc, [EVENTS], () => {
      fs.appendFileSync(file(cc, EVENTS), '#'.repeat(phaseCost.MAX_BYTES + 1) + '\n');
      const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-milestone-time-admission.js'), '--status', '--cwd', cc, '--milestone', M, '--json'], { encoding: 'utf8', timeout: 120000 });
      assert.equal(cli.status, 0, cli.stderr);
      const status = JSON.parse(cli.stdout);
      assert.deepEqual([status.state, status.checkpoint, status.clocks.consumed_ms], ['draining', null, snapshot.consumed_ms]);
      assert(status.unknowns.includes('open-writers-unknown') && status.remaining_ms <= 0);
      const gate = spawnSync(process.execPath, [path.join(__dirname, 'forge-milestone-time-admission.js'), '--admit-transport', '--cwd', cc, '--milestone', M, '--unit', 'execute-task/T09', '--json'], { encoding: 'utf8', timeout: 120000 });
      assert.equal(gate.status, 3); assert.equal(JSON.parse(gate.stdout).reason_code, 'milestone-budget-exhausted');
    });
    console.log('ok - T02 endpoint: unknown writer census never projects ready checkpoint at cap');
    pass('endpoint-at-cap-unknown-census-status');
  }

  // ---- Truth 7 (part): only sliceClosure is a new controller export; clock adds two.
  assert.deepEqual(Object.keys(controller), ['PROTOCOL_VERSION', 'BOUNDARY_KINDS', 'ACTIONS', 'PHASES', 'REASON_CODES', 'TIME_ADMISSION_CODES', 'ControllerError',
    'selectNextUnit', 'discoverInventory', 'select', 'begin', 'transition', 'persistResult', 'complete', 'pause', 'fail', 'expireSafe', 'resume', 'handoff',
    'pendingTransactions', 'projectLogicalHistory', 'logicalState', 'resolvePrefs', 'transactionDir', 'resultDir', 'boundaryDir', 'eventsFile', 'transactionFile',
    'resultFile', 'boundaryFile', 'readEvents', 'readJson', 'writeAtomic', 'lookupRecord', 'preflightPaths', 'consumeFailure', 'reenter', 'failureProjection',
    'validateLinkedEntry', 'validateTerminalLinkedEntry', 'sliceClosure', 'dependencies']);
  assert.deepEqual(Object.keys(clock), ['CLOCK_POLICY', 'FORECAST_POLICY', 'DELIVERY_PROOF_MODES', 'computeClock', 'readClock', 'readDeliveries',
    'readHistoricalDeliveries', 'readHistoricalTaskDelivery', 'computeForecast', 'readForecast', 'main', 'ENDPOINT_PROOF_POLICY', 'readEndpointProof']);
  assert(Object.isFrozen(clock.ENDPOINT_PROOF_POLICY) && Object.isFrozen(clock.ENDPOINT_PROOF_POLICY.limitations));
  assert(f.envelopes.every(row => row.envelope.kind === 'verification' && /^[a-f0-9]{40}$/.test(row.envelope.revision)), 'real runRootVerification envelopes');
  for (const [name, minimum, stubs] of [['forge-milestone-time-clock.js', 680, true], ['forge-unit-controller.js', 1781, true], ['forge-milestone-endpoint.js', 180, true],
    ['forge-milestone-endpoint.test.js', 260, false]]) {
    const text = fs.readFileSync(path.join(__dirname, name), 'utf8'); assert(text.split('\n').length >= minimum, name);
    if (stubs) assert(!/TODO|TBD|FIXME/.test(text), name);
  }
  assert(fs.readFileSync(SCHEMA, 'utf8').split('\n').length >= 50);
  pass('controller-and-clock-exports');
  completedAll = true;
} finally {
  process.env.HOME = savedEnv.HOME; process.env.USERPROFILE = savedEnv.USERPROFILE;
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
}
assert(completedAll && roots.every(dir => !fs.existsSync(dir)), 'every temporary root removed');
console.log('ok - T02 endpoint: canonical real fixtures preserve controller and existing suite expectations');
console.log('PASS endpoint-suite ' + checks + ' groups');
