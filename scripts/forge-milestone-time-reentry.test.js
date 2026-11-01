#!/usr/bin/env node
'use strict';

// T10 public fixtures: actual T06 transport refusal, consume-failure, retained
// claim checkpoint, attested extension and same-snapshot linked reentry.
// Providers are stubs. These checks observe fixture callbacks and isolated
// owners/roots only, never a real remote host, provider payload or credential;
// native batch children and unknown probes stay outside the observed scope.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { digest } = require('./forge-code-roots');
const time = require('./forge-milestone-time');
const admission = require('./forge-milestone-time-admission');
const controller = require('./forge-unit-controller');
const orchestrate = require('./forge-orchestrate');
const workflow = require('./forge-long-workflow-adapter');
const drain = require('./forge-milestone-time-drain');
const recovery = require('./forge-attempt-recovery');
const lease = require('./forge-unit-lease');
const BASE = Date.parse('2026-11-01T12:00:00.000Z'), M = 'M001', UNIT = { type: 'execute-task', id: 'T01', key: 'execute-task/T01' };
const labs = [];
let serial = 0, passed = 0;
const iso = value => new Date(value).toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function test(name, fn) { await fn(); passed++; console.log('PASS T10 ' + name); }
function write(root, name, content) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content)); return file;
}
// Explicit fixture answers through the canonical question store and a live
// decision adapter; a serialized "approved" flag never reaches the contract.
function decide(cwd, milestone, kind, request, answer, at) {
  const questions = require('./forge-pending-questions'), id = 't10-' + kind + '-' + ++serial;
  const opened = questions.openQuestions({ cwd, milestone, unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Escolha explícita da fixture?' }] });
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const live = { reference: 'fixture-' + id, status: 'resolved', answer, source: 'user-text', resolved_at: iso(at),
    question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference,
    { milestone, kind, request_sha256: digest(request), expires_at: at + 60000 }, () => at);
}
function activate(cwd, milestone, at, ceiling) {
  const contract = { schema_version: 1, milestone, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
    activated_at: iso(at), preselection_started_at: iso(at - 5), ceiling_ms: ceiling,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
  time.activateContract({ cwd, milestone, contract, now: at, handle: decide(cwd, milestone, 'activation', contract, 'option:balanced', at) });
}
function extend(cwd, milestone, ceiling, at) {
  const request = { kind: 'extension', reason: 'Extensão explícita de fixture', patch: { ceiling_ms: ceiling } };
  return time.amendContract({ cwd, milestone, ...request, now: at, handle: decide(cwd, milestone, 'extension', request, 'extend:' + ceiling, at) });
}
function tree(root) {
  const rows = {};
  (function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(root, file).split(path.sep).join('/');
      if (relative === '.gsd/.locks' || relative.startsWith('.gsd/.locks/')) continue;
      const stat = fs.lstatSync(file);
      rows[relative] = stat.isDirectory() ? 'directory' : [stat.mtimeMs, sha(fs.readFileSync(file))];
      if (stat.isDirectory()) visit(file);
    }
  })(root);
  return rows;
}
function physical(f) { return [{ root_id: 'owner', path: f.owner }, { root_id: 'alpha', path: f.a }, { root_id: 'beta', path: f.b }]; }
// Trusted owner adapter: its own live observation of the run claim, receipt and
// roots. It never receives the drain's expected digests to echo back.
function liveRetained(f) {
  return challenge => {
    const run = read(path.join(f.owner, '.gsd/forge/runs', (f.milestone || M) + '.json'));
    return { writer_ended: true, run_id: run.id, unit: run.write_claim.unit, slice: challenge.begin.after.state.active_slice,
      begin_key: challenge.begin.idempotency_key, claim_generation: run.write_claim.generation,
      receipt_sha256: sha(fs.readFileSync(challenge.receipt_path)),
      reconciliation: challenge.terminal.terminal_failure ? 'failure-consumed' : 'published',
      roots: challenge.roots.map(root => ({ root_id: root.root_id, process_stopped: true, reconciled: true })),
      reference: 'fixture:live-owner-reconciliation' };
  };
}
function optionsOf(f) {
  const home = path.join(f.dir, 'isolated-home');
  return { now: () => BASE + f.at, prefsReader: () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }),
    inventoryReader: () => ({ roadmap_exists: true, context_exists: true, research_exists: true,
      slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [{ id: 'T01', checked: false }] }] }),
    userHome: home, env: { HOME: home, USERPROFILE: home },
    inspectAttempt: () => ({ receipt_path: f.receipt, request: f.request, roots: physical(f), pending_questions: [] }),
    processProbe: () => f.probe || 'stopped',
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    captureEntryBaseline: () => ({ sha256: 'a'.repeat(64), roots: physical(f) }),
    entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: iso(BASE + f.at) })),
    reconcileRetainedClaim: liveRetained(f) };
}
function invoke(f, command, snapshot, extra = {}, options = optionsOf(f)) {
  return workflow.invoke(f.host, 'auto', command, { ...f.input, ...extra }, snapshot, options).result;
}
// A fresh process rebuilds every live adapter from the same persisted bytes.
function restart(f, snapshotFile, command, extra = {}) {
  const data = { owner: f.owner, a: f.a, b: f.b, dir: f.dir, host: f.host, at: f.at, request: f.request, receipt: f.receipt,
    input: f.input, milestone: f.milestone };
  const dataFile = write(f.dir, 'restart-' + ++serial + '.json', { f: data, extra });
  const child = cp.spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), t = require(process.argv[1]), data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    process.stdout.write(JSON.stringify(t.invoke(data.f, process.argv[4], snapshot, data.extra)));
  `, __filename, dataFile, snapshotFile, command], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
function corpus(cwd) {
  const manifest = read(path.join(__dirname, '../shared/forge-procedures.json'));
  for (const item of manifest.modules.filter(row => row.status === 'ready')) write(cwd, item.path, fs.readFileSync(path.join(__dirname, '..', item.path), 'utf8'));
  write(cwd, 'shared/forge-procedures.json', manifest);
}
function sidecarFixture(host, contract = true) {
  const lab = require('./forge-code-roots.test').fixture(); labs.push(lab);
  const f = { ...lab, host, engine: host === 'claude' ? 'codex' : 'claude', at: 0, milestone: M,
    input: { cwd: lab.owner, milestone: M, workflow_id: 't10-' + host, owner_token: 't10-owner', max_steps: 10 } };
  fs.mkdirSync(path.join(lab.owner, '.gsd/forge'), { recursive: true });
  if (contract) activate(lab.owner, M, BASE, 100);
  corpus(lab.a);
  f.plan = write(lab.owner, '.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md', require('./forge-code-roots.test').plan(lab.contract));
  write(lab.owner, '.gsd/milestones/M001/slices/S01/S01-PLAN.md', '# Slice\n- [ ] **T01** fixture\n');
  require('./forge-state').write(lab.owner, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
  require('./forge-runs').add(lab.owner, { id: M, kind: 'milestone', session_id: 't10-fixture' });
  f.claim = require('./forge-write-claim').recordClaim(lab.owner, M, { schema_version: 2, source: 'plan-writes', unit: UNIT.key,
    execution_contract: lab.contract, paths: ['alpha::same.txt', 'beta::same.txt'] });
  // Legitimate uncommitted bytes that predate the attempt and must survive it.
  write(lab.a, 'dirty-before.txt', 'preexisting uncommitted work\n');
  f.request = sidecarRequest(f); f.runFile = path.join(lab.owner, '.gsd/forge/runs/M001.json');
  return f;
}
function sidecarRequest(f) {
  const model = f.engine === 'claude' ? 'claude-sonnet-5' : 'gpt-6-sol';
  const tiers = Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, [model]]));
  write(f.owner, '.gsd/forge-prefs.jsonc', { tier_models: tiers, routing: { default: { executor: tiers, planner: tiers } }, effort: { 'plan-slice': 'medium' } });
  const id = 't10-transport-' + ++serial;
  const r = { cwd: f.a, contextRoot: f.owner, milestoneId: M, scope: 'milestone', phase: 'execute', unitType: 'execute-task',
    sliceId: 'S01', taskId: 'T01', planFile: f.plan, execution_contract: f.contract, dispatchId: id, workflowId: 'fixture-workflow',
    resultFile: path.join(f.dir, id + '.json'), prompt: 'Isolated fixture only.', verification: { preferenceCommands: ['node --version'] },
    runId: M, claim: f.claim, gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' } };
  r.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', milestoneId: M,
    unitId: 'T01', planPath: f.plan, hostRuntime: f.host });
  assert.equal(r.route.resolved_worker_engine, f.engine); assert.equal(r.route.worker_mode, 'sidecar');
  return r;
}
function beginOf(f, result) { return controller.lookupRecord(f.owner, 'transaction', result.controller_result.details.transaction.idempotency_key); }
function begins(owner) {
  return fs.readdirSync(controller.transactionDir(owner)).filter(name => name.endsWith('.json'))
    .map(name => controller.readJson(path.join(controller.transactionDir(owner), name))).filter(row => row.action === 'begin');
}
// The genuine T06 refusal: real sidecar transport entry rechecks the clock and
// refuses before any provider, spawn or kill; it writes its own terminal receipt.
async function lateRefusal(f) {
  const xllm = require('./forge-xllm'), sidecar = require('./forge-unit-sidecar');
  const keys = ['invokeClaudeTransport', 'invokeCodexAppServer', 'runPlan', 'runExecute', 'terminateOwnedProcessTree'];
  const saved = Object.fromEntries(keys.map(key => [key, xllm[key]])), spawn = cp.spawn, counts = { providers: 0, spawns: 0, kills: 0 };
  for (const key of keys.slice(0, 4)) xllm[key] = async () => { counts.providers++; throw Object.assign(Error('fixture provider reached'), { code: 'fixture-provider-reached', provider_called: true }); };
  xllm.terminateOwnedProcessTree = () => { counts.kills++; throw Error('unexpected termination'); };
  cp.spawn = () => { counts.spawns++; throw Error('unexpected provider spawn'); };
  const stages = [];
  try {
    await assert.rejects(sidecar.runUnitSidecar(f.request, { now: () => BASE + f.at, announce: (stage, fields) => stages.push({ stage, ...fields }) }),
      error => admission.TRANSPORT_REFUSAL_CODES.includes(error.code) && error.provider_called === false);
  } finally { Object.assign(xllm, saved); cp.spawn = spawn; }
  assert.deepEqual(counts, { providers: 0, spawns: 0, kills: 0 });
  assert(stages.some(row => row.stage === 'recusado' && row.provider_called === false));
  f.receipt = f.request.resultFile + '.receipt.json';
  const receipt = read(f.receipt);
  assert.equal(receipt.phase, 'failed'); assert.equal(receipt.failure.provider_called, false);
  assert.equal(receipt.failure.layer, 'milestone-time-admission'); assert.equal(receipt.failure.possible_writes, false);
  assert(admission.TRANSPORT_REFUSAL_CODES.includes(receipt.failure.reason_code));
  return receipt;
}
// Strict negatives on a consumed attempt below the checkpoint: each mismatch
// stays held/unknown, refuses a checkpoint and writes nothing in the owner.
function retainedNegatives(f) {
  const base = optionsOf(f), before = tree(f.owner), begun = begins(f.owner)[0];
  const inspect = options => drain.inspectDrain(f.owner, M, options);
  assert.equal(inspect(base).claim, 'retained-reconciled', JSON.stringify(inspect(base)));
  const proof = change => ({ reconcileRetainedClaim: challenge => change(liveRetained(f)(challenge)) });
  const context = base.inspectAttempt();
  const cases = [
    ['adapter-absent', { reconcileRetainedClaim: undefined }, 'held'],
    ['probe-unknown', { processProbe: () => 'unknown' }, 'unknown'],
    ['probe-alive', { processProbe: () => 'alive' }, 'held'],
    ['lease-generation-is-not-claim-generation', proof(p => ({ ...p, claim_generation: begun.lease_generation })), 'unknown'],
    ['receipt-hash', proof(p => ({ ...p, receipt_sha256: '0'.repeat(64) })), 'unknown'],
    ['unreconciled-root', proof(p => ({ ...p, roots: p.roots.slice(1) })), 'unknown'],
    ['serialized-flag', proof(p => ({ ...p, writer_ended: 'true', approved: true })), 'unknown'],
    ['other-slice-same-unit-name', proof(p => ({ ...p, slice: 'S02' })), 'unknown'],
    ['other-begin', proof(p => ({ ...p, begin_key: 'foreign-begin' })), 'unknown'],
    ['adapter-throws-private', { reconcileRetainedClaim: () => { throw Error('C:\\private\\owner-session'); } }, 'unknown'],
    ['root-omitted', { inspectAttempt: () => ({ ...context, roots: physical(f).slice(0, 2) }) }, 'unknown'],
    ['foreign-run', { inspectAttempt: () => ({ ...context, request: { ...f.request, runId: 'other-run' } }) }, 'unknown'],
    ['foreign-request-claim', { inspectAttempt: () => ({ ...context, request: { ...f.request, claim: { ...f.request.claim, generation: 'other' } } }) }, 'unknown'],
    ['native-batch-unobservable', { inspectAttempt: () => ({ native_batch: true }) }, 'unknown'],
  ];
  for (const [name, patch, expected] of cases) {
    const options = { ...base, ...patch }, result = inspect(options);
    assert.equal(result.claim, expected, name); assert.notEqual(result.state, 'drained', name);
    assert(!JSON.stringify(result).includes('private') && !JSON.stringify(result).includes(f.owner), name);
    assert.deepEqual(result.observability, drain.OBSERVABILITY_LIMITS, name);
    assert.equal(drain.checkpointIfDrained(f.owner, M, options).status, 'not-drained', name);
  }
  assert.deepEqual(tree(f.owner), before, 'negative inspections and refused checkpoints wrote owner state');
  // Real source drift, restored byte-for-byte by the fixture only.
  const receiptBytes = fs.readFileSync(f.receipt), runBytes = fs.readFileSync(f.runFile);
  fs.writeFileSync(f.receipt, receiptBytes.toString() + ' ');
  assert.equal(inspect(base).claim, 'unknown', 'receipt drift after consume');
  fs.writeFileSync(f.receipt, receiptBytes);
  const run = JSON.parse(runBytes); run.write_claim.generation = 'successor-generation';
  fs.writeFileSync(f.runFile, JSON.stringify(run));
  assert.equal(inspect(base).claim, 'unknown', 'successor claim generation');
  delete run.write_claim.at; fs.writeFileSync(f.runFile, JSON.stringify(run));
  assert.equal(inspect(base).claim, 'unknown', 'malformed claim');
  fs.writeFileSync(f.runFile, runBytes);
  const other = lease.acquire(f.owner, UNIT.key, { ownerToken: 'successor-owner', hostRuntime: f.host, now: BASE + f.at });
  assert.equal(other.ok, true);
  assert.notEqual(inspect(base).state, 'drained', 'successor writer lease');
  assert.equal(lease.release(f.owner, UNIT.key, 'successor-owner', other.generation).ok, true);
  assert.equal(inspect(base).claim, 'retained-reconciled');
}
async function sidecarChain(host) {
  const f = sidecarFixture(host);
  f.at = 1; const selected = invoke(f, 'next');
  assert.equal(selected.outcome, 'dispatch_required', JSON.stringify(selected)); assert.equal(selected.unit.key, UNIT.key);
  const begun = beginOf(f, selected); assert.equal(begun.time_admission.decision, 'admitted');
  const runBytes = fs.readFileSync(f.runFile), dirty = fs.readFileSync(path.join(f.a, 'dirty-before.txt'));
  f.at = 101; await lateRefusal(f);
  assert.equal(lease.observe(f.owner, UNIT.key).lease.generation, begun.lease_generation, 'refusal never releases the lease');
  f.at = 110;
  const pending = drain.checkpointIfDrained(f.owner, M, optionsOf(f));
  assert.equal(pending.status, 'not-drained'); assert.equal(pending.drain.writers[0].classification, 'dead-requires-failure-consumption');
  f.at = 120; const consumed = invoke(f, 'consume-failure', selected.snapshot);
  assert.equal(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
  assert.equal(lease.observe(f.owner, UNIT.key).lease, null);
  assert.deepEqual(fs.readFileSync(f.runFile), runBytes, 'consume-failure kept the claim fence');
  f.at = 150; retainedNegatives(f);
  const blocked = invoke(f, 'next', consumed.snapshot);
  assert.equal(blocked.reason_code, 'milestone-budget-exhausted', JSON.stringify(blocked));
  const checkpoint = blocked.controller_result.details.time.checkpoint;
  assert.equal(checkpoint.status, 'checkpointed', JSON.stringify(checkpoint));
  const retained = checkpoint.record.drain.retained;
  assert.equal(checkpoint.record.drain.claim, 'retained-reconciled'); assert.equal(retained.reconciliation, 'failure-consumed');
  assert.equal(retained.unit, UNIT.key); assert.equal(retained.slice, 'S01'); assert.equal(retained.run, M);
  const serialized = JSON.stringify(checkpoint.record);
  for (const secret of [f.owner, f.a, f.b, f.claim.generation, 'preexisting uncommitted', f.request.resultFile]) assert(!serialized.includes(secret));
  assert.deepEqual(fs.readFileSync(f.runFile), runBytes, 'checkpoint kept claim bytes');
  assert.deepEqual(fs.readFileSync(path.join(f.a, 'dirty-before.txt')), dirty, 'checkpoint kept dirty bytes');
  const recordFile = path.join(f.owner, checkpoint.reference), recordBytes = fs.readFileSync(recordFile);
  assert.equal(drain.checkpointIfDrained(f.owner, M, optionsOf(f)).status, 'checkpointed');
  assert.deepEqual(fs.readFileSync(recordFile), recordBytes, 'replayed checkpoint is idempotent');
  write(f.a, 'dirty-before.txt', 'changed after checkpoint\n');
  assert.equal(drain.checkpointIfDrained(f.owner, M, optionsOf(f)).reason_code, 'time-drain-retained-changed');
  write(f.a, 'dirty-before.txt', dirty);
  assert.deepEqual(fs.readFileSync(recordFile), recordBytes);
  const snapshotFile = write(f.dir, 'workflow-snapshot.json', JSON.stringify(blocked.snapshot)), snapshotBytes = fs.readFileSync(snapshotFile);
  assert.equal(restart(f, snapshotFile, 'resume-budget').reason_code, 'budget-extension-required');
  f.at = 160; extend(f.owner, M, 1000, BASE + f.at);
  write(f.a, 'dirty-before.txt', 'evidence drift after restart\n');
  const drifted = restart(f, snapshotFile, 'resume-budget');
  assert.equal(drifted.reason_code, 'budget-retained-claim-changed', JSON.stringify(drifted));
  write(f.a, 'dirty-before.txt', dirty);
  f.at = 170; const required = restart(f, snapshotFile, 'resume-budget');
  assert.equal(required.outcome, 'blocked'); assert.equal(required.reason_code, 'linked-reentry-required', JSON.stringify(required));
  const failure = required.controller_result.details.failures[0];
  assert.equal(failure.failure_key, consumed.controller_result.details.failure_key);
  assert.equal(failure.failure_checksum, consumed.controller_result.details.failure_checksum); assert.equal(failure.unit, UNIT.key);
  const entry = { unit: selected.unit, entry: { entry_id: 't10-entry-' + host, authorization_ref: 'fixture-entry',
    failure_key: failure.failure_key, failure_checksum: failure.failure_checksum } };
  assert.equal(restart(f, snapshotFile, 'resume-budget', { ...entry, entry: { ...entry.entry, failure_checksum: '0'.repeat(64) } }).reason_code, 'budget-entry-invalid');
  const questions = require('./forge-pending-questions');
  const opened = questions.openQuestions({ cwd: f.owner, milestone: M, unit: UNIT.key, decision_set: 'functional-choice',
    questions: [{ id: 'functional-t10', question: 'Decisão funcional real?' }] });
  assert.equal(restart(f, snapshotFile, 'resume-budget', entry).reason_code, 'pending-questions');
  const listed = questions.listPendingQuestions({ cwd: f.owner, filter: { type: 'milestone', id: M } }).questions;
  assert(listed.some(row => row.id === 'functional-t10' && row.status === 'pending'), 'standing entry authority never answers a functional question');
  questions.answer({ cwd: f.owner, identity: opened.identity_sha256, answers: [{ id: 'functional-t10', answer: 'yes', source: 'user-text' }] });
  const beforeEntry = begins(f.owner).length;
  f.at = 180; const entered = restart(f, snapshotFile, 'resume-budget', entry);
  assert.equal(entered.outcome, 'dispatch_required', JSON.stringify(entered)); assert.equal(entered.reason_code, 'entry-ready');
  assert.equal(entered.workflow_id, blocked.workflow_id); assert.equal(entered.unit.key, UNIT.key);
  assert.equal(entered.snapshot.step_count, blocked.snapshot.step_count + 1); assert(!entered.snapshot.time_block);
  assert.deepEqual(fs.readFileSync(snapshotFile), snapshotBytes, 'the persisted snapshot was never edited');
  const linked = controller.lookupRecord(f.owner, 'transaction', entered.controller_result.details.transaction.idempotency_key);
  assert.equal(linked.time_admission.decision, 'admitted'); assert.equal(linked.linked_entry.failure_key, failure.failure_key);
  assert.notEqual(linked.idempotency_key, begun.idempotency_key); assert.notEqual(linked.lease_generation, begun.lease_generation);
  assert.equal(begins(f.owner).length, beforeEntry + 1, 'exactly the linked unit was entered');
  assert.deepEqual(fs.readFileSync(f.runFile), runBytes);
  // Crash before the new snapshot was saved: the same old snapshot and entry
  // replay the committed controller entry, never a second begin.
  const replayed = restart(f, snapshotFile, 'resume-budget', entry);
  assert.equal(replayed.reason_code, 'entry-ready', JSON.stringify(replayed));
  assert.equal(replayed.controller_result.details.transaction.idempotency_key, linked.idempotency_key);
  assert.equal(begins(f.owner).length, beforeEntry + 1);
  // Same resolved route/model/effort; the linked attempt has its own identity.
  const next = { ...f.request, linked_begin_key: linked.idempotency_key, dispatchId: f.request.dispatchId + '-linked',
    resultFile: f.request.resultFile + '.linked.json' };
  const bound = recovery.bindLinkedRequest(next, { ...optionsOf(f), ownerToken: f.input.owner_token });
  assert.deepEqual(bound.route, f.request.route);
  assert.notEqual(digest(recovery.requestIdentity(recovery.canonicalRequest(bound))),
    digest(recovery.requestIdentity(recovery.canonicalRequest(f.request))));
}
// A completed writer may keep legitimate uncommitted claimed bytes. A saved
// result that still needs publication never drains; a published one may.
async function completedWriter(host) {
  const f = sidecarFixture(host); f.at = 1; const selected = invoke(f, 'next');
  const side = require('./forge-unit-sidecar');
  const identity = digest(recovery.requestIdentity(recovery.canonicalRequest(f.request)));
  const receipt = phase => { f.receipt = write(f.dir, 'completed.receipt.json', { phase, dispatch_id: f.request.dispatchId,
    fingerprint: side.artifactFingerprint(f.request), recovery_identity_sha256: identity }); };
  receipt('executed');
  for (const root of [f.a, f.b]) write(root, 'same.txt', 'after\n');
  const head = root => cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 15000 }).stdout.trim();
  const heads = [head(f.a), head(f.b)], runBytes = fs.readFileSync(f.runFile);
  f.at = 120; const completed = invoke(f, 'complete', selected.snapshot, { result: { status: 'done' } });
  assert.equal(completed.outcome, 'completed', JSON.stringify(completed));
  f.at = 150;
  const unpublished = invoke(f, 'next', completed.snapshot).controller_result.details.time.checkpoint;
  assert.equal(unpublished.status, 'not-drained'); assert.equal(unpublished.drain.claim, 'held');
  assert.equal(unpublished.drain.claim_reason, 'retained-publication-required');
  receipt('ready');
  const published = invoke(f, 'next', completed.snapshot).controller_result.details.time.checkpoint;
  assert.equal(published.status, 'checkpointed', JSON.stringify(published));
  assert.equal(published.record.drain.retained.reconciliation, 'published');
  for (const root of [f.a, f.b]) assert.equal(fs.readFileSync(path.join(root, 'same.txt'), 'utf8'), 'after\n');
  assert.deepEqual([head(f.a), head(f.b)], heads, 'no forced commit'); assert.deepEqual(fs.readFileSync(f.runFile), runBytes, 'no release/clear');
}
async function untimed(host) {
  const f = sidecarFixture(host, false), before = tree(f.owner);
  assert.equal(drain.inspectDrain(f.owner, M, optionsOf(f)).state, 'not-applicable');
  assert.equal(drain.checkpointIfDrained(f.owner, M, optionsOf(f)).status, 'no-contract');
  assert.equal(orchestrate.run('resume-budget', { cwd: f.owner, milestone: M, host_runtime: host, owner_token: f.input.owner_token,
    time_block: { milestone: M, contract_version: 1, contract_sha256: 'a'.repeat(64) } }, optionsOf(f)).reason_code, 'milestone-time-invalid');
  const task = workflow.invoke(host, 'task', 'resume-budget', { workflow_id: 't10-task', cwd: f.owner }, null, optionsOf(f)).result;
  assert.equal(task.reason_code, 'budget-resume-invalid');
  assert.deepEqual(tree(f.owner), before, 'untimed milestone and independent task unchanged');
  f.at = 1; const selected = invoke(f, 'next');
  assert.equal(selected.outcome, 'dispatch_required'); assert(!selected.controller_result.details.time);
  assert(!Object.hasOwn(beginOf(f, selected), 'time_admission')); assert(!fs.existsSync(path.join(f.owner, '.gsd/forge/time')));
}
// First native attempt: prepare/start, actual late guard with zero host
// callbacks, canonical owner refusal receipt and the same linked protocol.
async function nativeChain() {
  const fixtures = require('./forge-native-recovery-delivery.test'), side = require('./forge-unit-sidecar');
  const delivery = require('./forge-native-recovery-delivery'), native = require('./forge-native-invocation');
  const { capabilities } = require('./forge-recovery-transition.test');
  const N = 'M901', start = Date.now() - 5000, ceiling = 3600000, clock = { at: start + ceiling + 1 };
  // A contract is activated before planning: set the fixture roadmap aside for
  // the activation only and restore the same bytes before the unit begins.
  const beforeBegin = lab => {
    const bytes = fs.readFileSync(lab.roadmap); fs.unlinkSync(lab.roadmap);
    try { activate(lab.owner, N, start, ceiling); } finally { fs.writeFileSync(lab.roadmap, bytes); }
  };
  const f = await fixtures.fixture({ runId: N, recordedClaim: true, beforeBegin });
  try {
    const handoff = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime), request = handoff.result.request;
    const options = { hostRuntime: 'codex', resolvedDispatch: request.route, activeCapabilities: capabilities,
      prompt: 'T10 first native attempt; no host invocation.', forkTurns: 'none', taskName: 't10-first-native', agentType: 'forge-executor',
      telemetryIdentity: request, terminalResult: value => delivery.resultContract.validate(value).ok, now: () => clock.at };
    const nativeInvocation = native.buildNativeInvocation(options); assert.equal(nativeInvocation.ok, true, nativeInvocation.reason_code);
    const receipts = [], session = delivery.prepare({ request, nativeInvocation, assertBoundary: f.assertBoundary,
      assertAuthority: f.assertBoundary, persistDeliveryReceipt: row => receipts.push(row) });
    let callbacks = 0;
    const outcome = await native.invokeNative(options, async () => { callbacks++; return f.result(); });
    assert.equal(outcome.ok, false); assert.equal(outcome.provider_called, false); assert.equal(callbacks, 0);
    assert(admission.TRANSPORT_REFUSAL_CODES.includes(outcome.reason_code), outcome.reason_code);
    assert.throws(() => session.refuseNotInvoked(outcome), /native-refusal-manifest-required/);
    const started = session.start(), manifestBytes = fs.readFileSync(started.manifest_file);
    for (const forged of [JSON.parse(JSON.stringify(outcome)), { ...outcome }, { ok: false, provider_called: false, reason_code: outcome.reason_code }]) {
      assert.throws(() => session.refuseNotInvoked(forged), /native-refusal-witness-required/);
    }
    const otherPrompt = await native.invokeNative({ ...options, prompt: 'another invocation' }, async () => { callbacks++; });
    assert.throws(() => session.refuseNotInvoked(otherPrompt), /native-refusal-witness-required/);
    const otherRequest = await native.invokeNative({ ...options, telemetryIdentity: { ...request, dispatchId: 'foreign-dispatch' } }, async () => { callbacks++; });
    assert.throws(() => session.refuseNotInvoked(otherRequest), /native-refusal-witness-required/);
    outcome.host_identity = { value: 'worker-identity' };
    assert.throws(() => session.refuseNotInvoked(outcome), /native-refusal-witness-required/); delete outcome.host_identity;
    const unexpected = write(f.a, 't10-unexpected.txt', 'delta');
    assert.throws(() => session.refuseNotInvoked(outcome), /native-refusal-code-changed/); fs.unlinkSync(unexpected);
    const saved = JSON.stringify({ phase: 'executed', result: f.result() });
    const savedFile = write(path.dirname(started.receipt_file), path.basename(started.receipt_file) + '.' + sha(saved) + '.json', saved);
    assert.throws(() => session.refuseNotInvoked(outcome), /native-refusal-saved-result/); fs.unlinkSync(savedFile);
    const runFile = path.join(f.owner, '.gsd/forge/runs', N + '.json'), runBytes = fs.readFileSync(runFile);
    const run = JSON.parse(runBytes); run.write_claim.generation = 'successor-generation'; fs.writeFileSync(runFile, JSON.stringify(run));
    assert.throws(() => session.refuseNotInvoked(outcome), /claim/); fs.writeFileSync(runFile, runBytes);
    assert.equal(callbacks, 0);
    const closure = session.refuseNotInvoked(outcome);
    assert.equal(closure.record.phase, 'failed'); assert(!Object.hasOwn(closure.record, 'result'));
    assert.deepEqual(closure.record.failure, { status: 'not-invoked', reason_code: outcome.reason_code, layer: 'milestone-time-admission',
      provider_called: false, possible_writes: false, reconciliation_required: false, host_callbacks: 0, witness: 'process-local-invocation-guard' });
    assert.equal(path.basename(closure.receipt_file), path.basename(started.receipt_file) + '.' + closure.receipt_sha256 + '.json');
    const closureBytes = fs.readFileSync(closure.receipt_file);
    assert.equal(session.refuseNotInvoked(outcome).receipt_sha256, closure.receipt_sha256, 'idempotent closure');
    assert.deepEqual(fs.readFileSync(closure.receipt_file), closureBytes);
    assert.throws(() => session.returned(f.result()), /native-refusal-closed/);
    assert.throws(() => session.verify(f.result()), /native-refusal-closed/);
    assert(!fs.existsSync(request.resultFile), 'no worker result');
    assert(!fs.existsSync(path.join(f.owner, '.gsd/milestones/M901/slices/S01/tasks/T01/T01-SUMMARY.md')), 'no success summary');
    assert.deepEqual(fs.readFileSync(started.manifest_file), manifestBytes);
    assert.equal(lease.observe(f.owner, UNIT.key).reason, 'lease-active', 'cleanup releases no lease');
    assert.deepEqual(fs.readFileSync(runFile), runBytes, 'cleanup releases no claim');
    const roots = [{ root_id: 'owner', path: f.owner }, ...f.contract.code_roots.map(root => ({ root_id: root.id, path: root.path }))];
    const live = { now: () => clock.at, inspectAttempt: () => ({ receipt_path: closure.receipt_file, request, roots, pending_questions: [] }),
      processProbe: () => 'stopped', reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
      captureEntryBaseline: () => ({ sha256: 'b'.repeat(64), roots }),
      entryAuthority: recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: iso(clock.at) })),
      reconcileRetainedClaim: liveRetained({ owner: f.owner, milestone: N }) };
    clock.at += 10;
    const consumed = orchestrate.run('consume-failure', { cwd: f.owner, milestone: N, unit: UNIT, begin_key: 'fixture-begin',
      owner_token: 'fixture-owner', host_runtime: 'codex', slice: 'S01' }, live);
    assert.equal(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
    assert.equal(lease.observe(f.owner, UNIT.key).lease, null);
    clock.at += 10;
    const checkpoint = drain.checkpointIfDrained(f.owner, N, live);
    assert.equal(checkpoint.status, 'checkpointed', JSON.stringify(checkpoint));
    assert.equal(checkpoint.record.drain.claim, 'retained-reconciled');
    assert.equal(checkpoint.record.drain.retained.receipt_sha256, closure.receipt_sha256);
    assert.deepEqual(fs.readFileSync(runFile), runBytes);
    clock.at += 10; extend(f.owner, N, 2 * ceiling, clock.at);
    const input = { cwd: f.owner, milestone: N, host_runtime: 'codex', owner_token: 'fixture-owner',
      time_block: { milestone: N, contract_version: 1, contract_sha256: checkpoint.record.contract_sha256 },
      consumed_failure: { unit: UNIT, failure_key: consumed.details.failure_key, failure_checksum: consumed.details.failure_checksum } };
    clock.at += 10;
    assert.equal(orchestrate.run('resume-budget', input, live).reason_code, 'linked-reentry-required');
    const entered = orchestrate.run('resume-budget', { ...input, unit: UNIT, entry: { entry_id: 't10-native-entry',
      authorization_ref: 'fixture-entry', failure_key: consumed.details.failure_key, failure_checksum: consumed.details.failure_checksum } }, live);
    assert.equal(entered.reason_code, 'entry-ready', JSON.stringify(entered));
    const linked = controller.lookupRecord(f.owner, 'transaction', entered.details.transaction.idempotency_key);
    assert.equal(linked.time_admission.decision, 'admitted'); assert.equal(linked.linked_entry.failure_key, consumed.details.failure_key);
    const bound = recovery.bindLinkedRequest({ ...request, linked_begin_key: linked.idempotency_key, dispatchId: request.dispatchId + '-linked',
      resultFile: request.resultFile + '.linked.json' }, { ...live, ownerToken: 'fixture-owner' });
    assert.deepEqual(bound.route, request.route);
    assert.equal(callbacks, 0);
  } finally { f.cleanup(); }
}
async function main() {
  for (const host of ['claude', 'codex']) {
    await test(host + ': actual sidecar late refusal, consume, retained checkpoint, extension and same-snapshot linked reentry', () => sidecarChain(host));
    await test(host + ': completed writer keeps dirty claimed bytes; saved unpublished result never drains', () => completedWriter(host));
    await test(host + ': untimed milestone and independent task remain unchanged', () => untimed(host));
  }
  await test('codex native: first prepare, zero-callback late guard, owner refusal receipt, consume, checkpoint, extension and linked reentry', nativeChain);
  await test('declared artifacts substantive without stubs', () => {
    for (const [name, minimum] of [['forge-milestone-time-reentry.test.js', 40], ['forge-milestone-time-drain.js', 40],
      ['forge-loop-controller.js', 40], ['forge-orchestrate.js', 40]]) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert(source.split('\n').length >= minimum, name);
      if (!name.endsWith('.test.js')) assert(!/\b(?:TODO|TBD|FIXME)\b/.test(source), name);
    }
  });
  console.log('PASS T10 reentry suite ' + passed + ' checks; stub providers and fixture callbacks only');
}
module.exports = { optionsOf, invoke };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(() => { for (const lab of labs) lab.cleanup(); });
