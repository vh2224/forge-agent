'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const controller = require('./forge-unit-controller'), adapter = require('./forge-long-workflow-adapter'), state = require('./forge-state');
const sidecar = require('./forge-unit-sidecar'), lease = require('./forge-unit-lease'), runs = require('./forge-runs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-incomplete-resume-'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
function fixture(host, type = 'complete-slice') {
  const cwd = path.join(root, host + '-' + fs.readdirSync(root).length), milestone = 'M-20261109000000-incomplete';
  fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
  const input = { cwd, milestone, workflow_id: 'incomplete-resume', owner_token: 'fixture-owner', inventory: {
    roadmap_exists: true, context_exists: true, research_exists: true,
    slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [] }, { id: 'S02', checked: false, plan_exists: false, tasks: [] }] } };
  const f = { cwd, milestone, host, input, current: null, request: null, receipt: null, options: { prefsReader, inventoryReader: () => input.inventory } };
  f.call = (command, snapshot, extra = {}, changes = {}) => adapter.invoke(host, 'auto', command, { ...input, ...extra }, snapshot, { ...f.options, ...changes }).result;
  if (type === 'plan-slice') {
    input.inventory.slices[0].plan_exists = false;
    const git = require('child_process').spawnSync('git', ['init', '-q', cwd], { encoding: 'utf8', windowsHide: true }); assert.equal(git.status, 0, git.stderr);
    fs.writeFileSync(path.join(cwd, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-sonnet-5', max: 'claude-sonnet-5' } }));
  }
  if (type === 'complete-milestone') input.inventory.slices.forEach(row => { row.checked = true; });
  f.current = f.call('next'); assert.equal(f.current.unit.key, type + '/' + (type === 'complete-milestone' ? milestone : 'S01'));
  return f;
}
async function partial(f, selected, questions = [], status = 'partial') {
  const transaction = selected.controller_result.details.transaction;
  const begin = controller.lookupRecord(f.cwd, 'transaction', transaction.idempotency_key);
  const type = begin.unit.type;
  const request = { cwd: f.cwd, contextRoot: f.cwd, milestoneId: f.milestone,
    ...(/slice|plan-check|execute-task/.test(type) ? { sliceId: begin.unit.id } : {}), scope: 'milestone',
    executionRouting: { workerEngine: 'claude', workerMode: 'sidecar', sidecarDeclared: true },
    phase: type.startsWith('plan-') ? 'plan' : 'complete', unitType: type, dispatchId: crypto.randomUUID(), workflowId: 'synthetic-no-provider',
    route: { host_runtime: f.host, resolved_worker_engine: f.host }, resultFile: path.join(root, crypto.randomUUID() + '.json'),
    ...(f.claim ? { claim: f.claim } : {}) };
  sidecar.beginArtifactAttempt(request);
  const result = { status, summary: 'Synthetic returned ' + status, questions,
    artifacts: status === 'done' ? sidecar.locations(request).required.map(relative => ({ path: relative, content: '---\ntier: standard\neffort: medium\ndepends: []\nexpected_output: [src/result.js]\nwrites: [src/result.js]\nmust_haves:\n  truths: [Observable fixture output]\n  artifacts: []\n  key_links: []\n---\n# Plan\n\n## Steps\n\n1. Deliver fixture output.\n\n## Must-Haves\n\n- Observable fixture output.\n\n## Standards\n\n- Use canonical APIs.\n\n## Files to Change\n\n- src/result.js\n' })) : [] };
  // This private fixture simulates an observed synthetic transport result;
  // no resolve, provider, native host tool or operational receipt is involved.
  await sidecar.acceptArtifactResult(request, result, { providerCalled: true });
  f.request = request; f.receipt = request.resultFile + '.receipt.json';
  f.options = { prefsReader, inventoryReader: () => f.input.inventory, processProbe: () => 'stopped',
    inspectAttempt: () => ({ begin_key: begin.idempotency_key, begin_checksum: require('./forge-orchestrate').checksum(begin),
      request, receipt_path: f.receipt, roots: [{ root_id: 'primary', path: f.cwd }], pending_questions: [] }),
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }) };
  return result;
}
async function main() {
  if (process.argv.includes('--review-only')) return reviewCases();

  // Low-level controller work is independently leased. Serial workflows use a
  // named fenced boundary; blocking all begin calls breaks real #336 windows.
  {
    const f = fixture('codex');
    const other = { milestone: f.milestone, unit: 'execute-task/T02', slice: 'S01', host_runtime: 'codex', owner_token: 'independent-owner', idempotency_key: 'independent-begin' };
    const second = controller.begin(f.cwd, other, f.options); assert.equal(second.ok, true);
    controller.complete(f.cwd, { ...other, generation: second.generation, idempotency_key: 'independent-complete', result: { status: 'succeeded' } }, f.options);
    assert(controller.incompleteUnits(f.cwd, f.milestone).some(row => row.unit.key === 'complete-slice/S01'));
    f.input.inventory.slices[0].checked = true;
    const before = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
    assert.equal(f.call('next').reason_code, 'unit-incomplete');
    assert.deepEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)), before, 'serial refusal precedes S02 transaction/state effects');
    assert.equal(lease.observe(f.cwd, 'plan-slice/S02').lease, null);
    const contested = fixture('claude');
    assert.equal(contested.call('next', undefined, { owner_token: 'foreign-owner', idempotency_key: 'foreign-begin' }).reason_code, 'lease-active');
    console.log('PASS independent low-level begin remains available; serial advance refuses before effects; real same-unit lease keeps its reason');
  }
  {
    const f = fixture('codex'), selected = f.current, result = await partial(f, selected);
    const paused = f.call('complete', selected.snapshot, { result }); assert.equal(paused.lifecycle, 'paused');
    const other = controller.begin(f.cwd, { milestone: f.milestone, unit: 'execute-task/T02', slice: 'S01', host_runtime: 'codex', owner_token: 'independent-owner', idempotency_key: 'resume-blocker' }, f.options);
    assert.equal(other.ok, true);
    const before = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute' }).reason_code, 'unit-incomplete');
    assert.equal(lease.observe(f.cwd, 'complete-slice/S01').lease, null, 'resume cannot reacquire a lease before detecting other incomplete lineage');
    assert.deepEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)), before);
    console.log('PASS serial execution resume detects another unfinished lineage before its new lease or publication');
  }
  {
    const cwd = path.join(root, 'serial-atomic'), milestone = 'M-20261109000000-atomic';
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
    state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
    let observed = false;
    const begun = controller.beginSerial(cwd, { milestone, unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'serial-owner', idempotency_key: 'atomic-begin' }, { prefsReader, failpoint: point => {
      if (point !== 'serial-lineage-checked') return false;
      const lock = require('./forge-lock').tryAcquireSync(cwd, 'unit-controller-transactions', { allowStaleRecovery: false, processOwnerOnly: true });
      if (lock) lock.release(); assert.equal(lock, null, 'serial lineage check holds the actual controller publication mutex');
      assert.equal(lease.observe(cwd, 'execute-task/T01').lease, null, 'serial fence precedes lease acquisition'); observed = true; return false;
    } });
    assert.equal(begun.ok, true); assert(observed);
    console.log('PASS serial lineage validation and begin share one actual controller mutex before the first lease');
  }
  {
    const cwd = path.join(root, 'serial-pending-replay'), milestone = 'M-20261109000000-pending';
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
    state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
    const input = { cwd, milestone, workflow_id: 'serial-pending', owner_token: 'pending-owner', idempotency_key: 'pending-begin',
      inventory: { roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [] }] } };
    const options = { prefsReader, inventoryReader: () => input.inventory };
    assert.throws(() => adapter.invoke('codex', 'auto', 'next', input, undefined, { ...options, failpoint: point => point === 'after-intent' }), error => error.code === 'CONTROLLER_FAILPOINT');
    const pending = controller.lookupRecord(cwd, 'transaction', 'pending-begin'); assert.equal(pending.phase, 'intent');
    const result = adapter.invoke('codex', 'auto', 'next', input, undefined, options).result;
    assert.equal(result.outcome, 'dispatch_required');
    const replayed = controller.lookupRecord(cwd, 'transaction', 'pending-begin'); assert.equal(replayed.phase, 'committed');
    assert.equal(replayed.lease_generation, pending.lease_generation); assert.equal(replayed.owner_digest, pending.owner_digest);
    assert.equal(controller.readEvents(controller.eventsFile(cwd, milestone)).filter(row => row.action === 'begin').length, 1);
    console.log('PASS serial crash-after-intent replay keeps the exact durable lease generation and publishes one begin');
  }
  for (const host of ['codex', 'claude']) {
    const f = fixture(host), selected = f.current, result = await partial(f, selected), bytes = fs.readFileSync(f.receipt);
    f.input.inventory.slices[0].checked = true; // A completer prematurely checked ROADMAP.
    const fresh = f.call('next'); assert.equal(fresh.reason_code, 'unit-incomplete');
    assert.equal(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).filter(row => row.action === 'begin').length, 1);
    assert.equal(f.call('complete', selected.snapshot, { result }, { processProbe: () => 'unknown' }).reason_code, 'process-not-stopped');
    assert(lease.observe(f.cwd, selected.unit.key).lease, 'unproved writer keeps its lease');
    const paused = host === 'codex' ? f.call('complete', selected.snapshot, { result }) : f.call('pause', undefined, {
      result, pause_current: { unit: selected.unit, transaction: selected.controller_result.details.transaction } });
    assert.equal(paused.lifecycle, 'paused'); assert.equal(paused.unit.key, selected.unit.key);
    assert.equal(lease.observe(f.cwd, selected.unit.key).lease, null);
    assert.equal(f.call('next').reason_code, 'unit-incomplete', 'paused partial cannot be skipped after losing loop snapshot');
    assert.equal(f.call('resume', paused.snapshot, { response: { choice: 'continue' } }).reason_code, 'execution-resume-intent-required');
    const resumed = f.call('resume', paused.snapshot, { resume_intent: 'execute' });
    assert.equal(resumed.outcome, 'dispatch_required'); assert.equal(resumed.unit.key, 'complete-slice/S01');
    const again = f.call('resume', paused.snapshot, { resume_intent: 'execute' });
    assert.equal(again.controller_result.details.transaction.generation, resumed.controller_result.details.transaction.generation);
    assert(fs.readFileSync(f.receipt).equals(bytes), 'original canonical partial receipt is immutable');
    assert.notEqual(resumed.controller_result.details.transaction.generation, selected.controller_result.details.transaction.generation);
    assert.notEqual(f.call('complete', resumed.snapshot, { result: { status: 'done' } }).outcome, 'completed', 'old partial is no successful completer delivery');
    const newResult = await partial(f, resumed);
    assert.equal(f.call('complete', resumed.snapshot, { result: newResult }).lifecycle, 'paused');
    assert.equal(lease.observe(f.cwd, resumed.unit.key).lease, null);
    assert.equal(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).filter(row => row.unit === 'plan-slice/S02').length, 0);
    console.log('PASS ' + host + ': complete-slice partial settles and resumes same generation-linked unit; no successor or lease leak');
  }
  {
    const f = fixture('codex'), result = await partial(f, f.current, [{ id: 'decision-1', question: 'Synthetic decision?' }]);
    const paused = f.call('complete', f.current.snapshot, { result });
    const before = controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).length;
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute', approved: true }).reason_code, 'pending-questions');
    assert.equal(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)).length, before);
    assert.equal(lease.observe(f.cwd, paused.unit.key).lease, null);
    const resumed = f.call('resume', paused.snapshot, { resume_intent: 'execute' }, { questionStateAdapter: () => ({ answers: [{ id: 'decision-1', answer: 'Observed fixture answer' }] }) });
    assert.equal(resumed.outcome, 'dispatch_required');
    assert.equal(resumed.snapshot.pending_questions[0].status, 'resolved');
    console.log('PASS partial pending decisions require explicit actual callback answers before new lease');
  }
  {
    const previous = process.env.CODEX_THREAD_ID;
    process.env.CODEX_THREAD_ID = 'synthetic-observed-owner';
    try {
      const f = fixture('codex');
      const git = require('child_process').spawnSync('git', ['init', '-q', f.cwd], { encoding: 'utf8', windowsHide: true });
      assert.equal(git.status, 0, git.stderr);
      f.claim = require('./forge-write-claim').normalizeClaim({ unit: f.current.unit.key, source: 'manual', code_dir: f.cwd, paths: ['src/result.js'] });
      runs.add(f.cwd, { id: f.milestone, kind: 'milestone', session_id: process.env.CODEX_THREAD_ID,
        host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID', write_claim: f.claim, pending_decisions: ['preserve-me'] });
      const result = await partial(f, f.current), receiptBytes = fs.readFileSync(f.receipt);
      const paused = f.call('complete', f.current.snapshot, { result }); assert.equal(paused.lifecycle, 'paused');
      runs.update(f.cwd, f.milestone, { active: false });
      const recordFile = runs.runFile(f.cwd, f.milestone), inactive = fs.readFileSync(recordFile);
      const options = () => ({ ...f.options, hostRuntime: 'codex', expectedRecordSha256: digest(fs.readFileSync(recordFile)), confirmWorkspaceQuiescent: true });
      assert.throws(() => runs.resumeOwner(f.cwd, f.milestone, { ...options(), inspectAttempt: undefined }), { code: 'owner-resume-claim-held' });
      assert.throws(() => runs.resumeOwner(f.cwd, f.milestone, { ...options(), processProbe: () => 'unknown' }), { code: 'process-not-stopped' });
      assert.throws(() => runs.resumeOwner(f.cwd, f.milestone, { ...options(), reconcileRoots: () => ({ reconciled: false }) }), { code: 'roots-unreconciled' });
      assert(fs.readFileSync(recordFile).equals(inactive), 'refused same-owner activation preserves claim and inactive record');
      process.env.CODEX_THREAD_ID = 'different-observed-owner';
      assert.throws(() => runs.resumeOwner(f.cwd, f.milestone, { ...options(), confirmOwnerStopped: true }), { code: 'owner-resume-claim-held' });
      assert(fs.readFileSync(recordFile).equals(inactive), 'a partial boundary cannot transfer a held claim to another owner');
      process.env.CODEX_THREAD_ID = 'synthetic-observed-owner';
      const resumed = runs.resumeOwner(f.cwd, f.milestone, options());
      assert.equal(resumed.status, 'reactivated'); assert.deepEqual(resumed.record.write_claim, f.claim);
      assert.deepEqual(resumed.record.pending_decisions, ['preserve-me']); assert(fs.readFileSync(f.receipt).equals(receiptBytes));
      assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute' }).unit.key, 'complete-slice/S01');
      console.log('PASS observed same inactive owner retains exact claim only with actual stopped receipt/root proof; foreign owner and unknown writer refuse');
    } finally { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; }
  }
  {
    const historical = require('./fixtures/incomplete-resume/legacy-two-begins.json');
    const cwd = path.join(root, 'genuine-baseline-two-begins'); fs.mkdirSync(cwd);
    for (const [relative, row] of Object.entries(historical.files)) {
      assert.equal(digest(row.content), row.sha256); const file = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.content);
    }
    const milestone = historical.milestone, input = { cwd, milestone, workflow_id: 'historical-partial-resume', owner_token: historical.owner_token,
      idempotency_key: 'old-complete-slice', inventory: { roadmap_exists: true, context_exists: true, research_exists: true,
        slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [] }] } };
    const f = { cwd, milestone, input, host: 'codex', options: { prefsReader, inventoryReader: () => input.inventory } };
    f.call = (command, snapshot, extra = {}, changes = {}) => adapter.invoke('codex', 'auto', command, { ...input, ...extra }, snapshot, { ...f.options, ...changes }).result;
    const current = f.call('next'); assert.equal(current.outcome, 'blocked'); assert.equal(current.reason_code, 'unit-incomplete');
    input.inventory.slices[0].checked = true;
    input.inventory.slices.push({ id: 'S02', checked: false, plan_exists: false, tasks: [] });
    input.idempotency_key = 'new-successor';
    assert.equal(f.call('next').reason_code, 'unit-incomplete', 'existing S02 begin replay cannot authorize a second dispatch while S01 is open');
    input.inventory.slices.pop(); input.inventory.slices[0].checked = false; input.idempotency_key = 'old-complete-slice';
    const result = await partial(f, current), inspectOriginal = f.options.inspectAttempt;
    const begin = controller.lookupRecord(cwd, 'transaction', 'old-complete-slice');
    const successor = controller.lookupRecord(cwd, 'transaction', 'new-successor');
    const originalBytes = [begin, successor].map(row => fs.readFileSync(controller.transactionFile(cwd, row.idempotency_key)));
    const successorRequest = { cwd, contextRoot: cwd, milestoneId: milestone, sliceId: 'S02', scope: 'milestone', phase: 'plan', unitType: 'plan-slice',
      route: { host_runtime: 'codex', resolved_worker_engine: 'codex' } };
    let observation = 'not-invoked';
    f.options.inspectAttempt = query => query.begin.idempotency_key === successor.idempotency_key ? {
      begin_key: successor.idempotency_key, begin_checksum: require('./forge-orchestrate').checksum(successor), request: successorRequest,
      invocation_status: observation, observation_reference: 'synthetic-host-observed-no-tool-invocation',
      roots: [{ root_id: 'primary', path: cwd }], receipt_path: null } : inspectOriginal(query);
    const operation = { milestone, unit: begin.unit, begin_key: begin.idempotency_key, begin_checksum: require('./forge-orchestrate').checksum(begin),
      owner_token: input.owner_token, host_runtime: 'codex', successors: [{ key: successor.idempotency_key, checksum: require('./forge-orchestrate').checksum(successor) }] };
    const previous = process.env.CODEX_THREAD_ID; process.env.CODEX_THREAD_ID = 'synthetic-historical-owner';
    try {
      runs.add(cwd, { id: milestone, kind: 'milestone', session_id: process.env.CODEX_THREAD_ID, host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID' });
      const events = () => controller.readEvents(controller.eventsFile(cwd, milestone)).length;
      const initialEvents = events();
      assert.throws(() => controller.reconcilePartialSuccessors(cwd, { ...operation, successors: [] }, f.options), { code: 'successor-inventory-mismatch' });
      observation = 'invoked'; assert.throws(() => controller.reconcilePartialSuccessors(cwd, operation, f.options), { code: 'successor-not-proved-uninvoked' });
      observation = 'not-invoked'; assert.throws(() => controller.reconcilePartialSuccessors(cwd, operation, { ...f.options, processProbe: () => 'unknown' }), { code: 'process-not-stopped' });
      process.env.CODEX_THREAD_ID = 'foreign-session'; assert.throws(() => controller.reconcilePartialSuccessors(cwd, operation, f.options), { code: 'successor-owner-mismatch' });
      process.env.CODEX_THREAD_ID = 'synthetic-historical-owner'; assert.equal(events(), initialEvents);
      assert.throws(() => controller.reconcilePartialSuccessors(cwd, operation, { ...f.options, failpoint: name => name === 'after-intent' }), error => error.code === 'CONTROLLER_FAILPOINT');
      const repaired = controller.reconcilePartialSuccessors(cwd, operation, f.options); assert.equal(repaired.reason, 'successors-abandoned-before-dispatch');
      const after = events(); controller.reconcilePartialSuccessors(cwd, operation, f.options); assert.equal(events(), after);
      assert.equal(lease.observe(cwd, successor.unit.key).lease, null);
      for (const [index, row] of [begin, successor].entries()) assert(fs.readFileSync(controller.transactionFile(cwd, row.idempotency_key)).equals(originalBytes[index]));
      const paused = f.call('pause', undefined, { result, pause_current: { unit: begin.unit, transaction: {
        idempotency_key: begin.idempotency_key, begin_checksum: require('./forge-orchestrate').checksum(begin), generation: begin.lease_generation,
        milestone: begin.milestone, host_runtime: begin.host_runtime, owner_digest: begin.owner_digest, unit: begin.unit.key } } });
      assert.equal(paused.lifecycle, 'paused');
      assert.equal(lease.observe(cwd, begin.unit.key).lease, null);
      const resumed = f.call('resume', paused.snapshot, { resume_intent: 'execute' }); assert.equal(resumed.unit.key, 'complete-slice/S01'); assert.equal(resumed.outcome, 'dispatch_required');
      assert.equal(resumed.controller_result.state.active_slice, 'S01');
      const nextPartial = await partial(f, resumed); assert.equal(f.call('complete', resumed.snapshot, { result: nextPartial }).lifecycle, 'paused');
      assert.equal(lease.observe(cwd, begin.unit.key).lease, null);
      assert.equal(controller.readEvents(controller.eventsFile(cwd, milestone)).filter(row => /S03/.test(row.unit)).length, 0);
      console.log('PASS genuine baseline S01+S02 history: exact uninvoked compensation, crash replay/idempotence, same-unit retry; unknown/invoked/foreign/omitted successor refuse');
    } finally { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; }
  }
  await reviewCases();
}

async function reviewCases() {
  for (const host of ['codex', 'claude']) {
    const f = fixture(host, 'plan-slice'), selected = f.current;
    const result = await partial(f, selected), originalPath = f.receipt, original = fs.readFileSync(originalPath);
    const paused = f.call('complete', selected.snapshot, { result }); assert.equal(paused.lifecycle, 'paused');
    const before = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
    assert.equal(f.call('resume', paused.snapshot, { response: { choice: 'done' } }).reason_code, 'execution-resume-intent-required');
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute' }, { processProbe: () => 'unknown' }).reason_code, 'process-not-stopped');
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute' }, { reconcileRoots: () => ({ root_id: 'foreign', process_stopped: true, reconciled: true }) }).reason_code, 'roots-unreconciled');
    assert.deepEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)), before);
    assert.equal(lease.observe(f.cwd, selected.unit.key).lease, null);
    const forged = structuredClone(paused.snapshot); forged.boundary.milestone = 'M999';
    assert.notEqual(f.call('resume', forged, { resume_intent: 'execute' }).outcome, 'dispatch_required');
    const resumed = f.call('resume', paused.snapshot, { resume_intent: 'execute' });
    assert.equal(resumed.outcome, 'dispatch_required', JSON.stringify(resumed)); assert.equal(resumed.unit.key, selected.unit.key);
    const begin = controller.lookupRecord(f.cwd, 'transaction', resumed.controller_result.details.transaction.idempotency_key);
    assert.equal(begin.resumed_pause.key, paused.boundary.idempotency_key);
    assert.notEqual(f.call('complete', resumed.snapshot, { result: { status: 'done' } }).outcome, 'completed', 'old partial cannot prove new done');
    const done = await partial(f, resumed, [], 'done');
    const completed = f.call('complete', resumed.snapshot, { result: done }); assert.equal(completed.outcome, 'completed', JSON.stringify(completed));
    assert.equal(controller.incompleteUnits(f.cwd, f.milestone).length, 0);
    assert(original.equals(fs.readFileSync(originalPath)), 'original partial receipt remains immutable');
    console.log('PASS ' + host + ': real partial plan-slice -> same-unit execution -> current captured done; response/unknown/foreign/old partial refuse');
  }
  {
    const f = fixture('codex', 'plan-slice');
    const paused = f.call('pause', f.current.snapshot); assert.equal(paused.lifecycle, 'paused');
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute' }).reason_code, 'execution-resume-boundary-invalid');
    const resumed = f.call('resume', paused.snapshot, { response: { choice: 'observed input' } });
    assert.equal(resumed.outcome, 'resumed', JSON.stringify(resumed));
    console.log('PASS input-only planning pause retains response-only completion contract');
  }
  {
    const f = fixture('codex', 'complete-milestone'), selected = f.current;
    const result = await partial(f, selected, [{ id: 'milestone-question', question: 'Synthetic final decision?' }]);
    const paused = f.call('complete', selected.snapshot, { result }); assert.equal(paused.lifecycle, 'paused');
    f.input.inventory.milestone_complete = true; // A real producer may publish ledger before returning partial.
    const events = controller.readEvents(controller.eventsFile(f.cwd, f.milestone));
    const fresh = f.call('next'); assert.equal(fresh.reason_code, 'unit-incomplete'); assert.equal(fresh.lifecycle, 'blocked');
    assert.equal(fresh.controller_result.details.incomplete_units[0].idempotency_key, paused.boundary.idempotency_key);
    assert.equal(fresh.snapshot.pending_questions[0].id, 'milestone-question');
    const oldCompleted = structuredClone(paused.snapshot); oldCompleted.lifecycle = 'completed'; oldCompleted.boundary = null;
    const checked = f.call('next', oldCompleted); assert.equal(checked.reason_code, 'unit-incomplete'); assert.equal(checked.lifecycle, 'blocked');
    assert.equal(checked.controller_result.details.incomplete_units[0].begin_checksum, require('./forge-orchestrate').checksum(controller.lookupRecord(f.cwd, 'transaction', paused.boundary.idempotency_key)));
    assert.equal(checked.snapshot.pending_questions[0].status, 'pending');
    assert.deepEqual(controller.readEvents(controller.eventsFile(f.cwd, f.milestone)), events, 'terminal checks are read-only');
    assert.equal(lease.observe(f.cwd, selected.unit.key).lease, null);
    assert.equal(f.call('resume', paused.snapshot, { resume_intent: 'execute', approved: true }).reason_code, 'pending-questions');
    assert.equal(f.call('resume', paused.snapshot, { response: { choice: 'done' } }).reason_code, 'execution-resume-intent-required');
    const resumed = f.call('resume', paused.snapshot, { resume_intent: 'execute' }, { questionStateAdapter: () => ({ answers: [{ id: 'milestone-question', answer: 'Actual fixture answer' }] }) });
    assert.equal(resumed.outcome, 'dispatch_required', JSON.stringify(resumed)); assert.equal(resumed.unit.key, selected.unit.key);
    console.log('PASS partial complete-milestone ledger cannot terminalize fresh/historical completed loop; pending questions/locators survive, explicit same-unit execution only');
  }
  {
    const f = fixture('codex');
    const tx = f.current.controller_result.details.transaction;
    controller.complete(f.cwd, { milestone: f.milestone, unit: f.current.unit, host_runtime: f.host, owner_token: f.input.owner_token,
      generation: tx.generation, idempotency_key: tx.idempotency_key + ':complete', result: { status: 'succeeded' } }, f.options);
    f.input.inventory.slices.forEach(row => { row.checked = true; }); f.input.inventory.milestone_complete = true;
    const normal = f.call('next'); assert.equal(normal.lifecycle, 'completed'); assert.equal(normal.reason_code, 'no-next-unit');
    assert.equal(f.call('next', normal.snapshot).reason_code, 'workflow-terminal');
    console.log('PASS zero-incomplete fresh and existing completed snapshots preserve ordinary terminal behavior');
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  // This one test owns every path beneath its freshly created private root.
  fs.rmSync(root, { recursive: true, force: true });
});
