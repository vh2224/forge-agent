'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const h = require('./fixtures/forge-native-execution').createFixtureHarness();
const sidecar = require('./forge-unit-sidecar'), api = require('./forge-execution-continuation');
const recovery = require('./forge-attempt-recovery');
let completed = false;
(async () => {
  const f = h.nativeFixture();
  f.r.verification = { preferenceCommands: ['node -e "process.exit(require(\'fs\').readFileSync(\'src.js\',\'utf8\').includes(\'bounded\')?0:1)"'] };
  const invoke = f.runtime.invokeNative;
  const partialRuntime = { ...f.runtime, invokeNative: async args => ({ ...await invoke(args), status: 'partial' }) };
  const captureFailure = recovery.captureFailure;
  recovery.captureFailure = () => { throw Object.assign(new Error('fixture recovery capture refused'), { code: 'fixture-capture-refused' }); };
  try { await assert.rejects(sidecar.runUnitSidecar(f.r, partialRuntime), e => e.code === 'execution-verification-failed'); }
  finally { recovery.captureFailure = captureFailure; }
  const parentFile = f.r.resultFile + '.receipt.json', original = fs.readFileSync(parentFile);
  const receipt = JSON.parse(original);
  assert.equal(receipt.phase, 'executed');
  assert.equal(receipt.result.status, 'partial');
  const inspect = recovery.inspectReceipt(parentFile, { request: f.r, processProbe: () => 'stopped' });
  assert.equal(inspect.incomplete_execution, true); assert.equal(inspect.valid_saved_response, false);
  const recover = recovery.createRecovery({ unit: 'execute-task/'+f.r.taskId, roots_sha256: require('./forge-code-roots').digest(f.r.execution_contract) });
  assert.equal((await recover.next({ inspection: inspect })).action, 'partial-continuation-required');
  assert.equal((await recover.resumeReservation({ inspection: inspect })).action, 'partial-continuation-required');
  const stateFile = f.r.resultFile + '.recovery.json';fs.writeFileSync(stateFile,JSON.stringify(recover.snapshot()));
  let resets = 0;
  const direct = await recovery.recoverAttempt({ stateFile, receiptFile: parentFile, request: f.r, executionContract: f.r.execution_contract,
    processProbe: () => 'stopped', reconcile: () => { resets++; throw new Error('must never reset retained partial'); } });
  assert.equal(direct.action, 'partial-continuation-required');assert.equal(resets,0);assert(fs.readFileSync(parentFile).equals(original));
  const create = options => api.create({ request: f.r, paths: ['app::src.js'], processProbe: () => 'stopped', ...options });
  assert.throws(() => create({ processProbe: () => 'alive' }), /continuation-process-not-joined/);
  assert.throws(() => create({ paths: ['app::other.js'] }), /continuation-path-outside-plan/);
  assert.throws(() => create({ paths: ['app::*'] }), /continuation-path-outside-plan/);
  const continuation = create();
  await assert.rejects(sidecar.runUnitSidecar(continuation.request, f.runtime), /continuation-capability-required/);
  const source = path.join(f.cwd, 'src.js'), preserved = fs.readFileSync(source);
  fs.appendFileSync(source, 'unreconciled\n');
  assert.throws(() => create(), /execution-replay-code-changed|execution-replay-baseline-changed/);
  fs.writeFileSync(source, preserved);
  let calls = 0;
  const runtime = { ...f.runtime, partialContinuation: continuation.capability, invokeNative: async () => {
    calls++; fs.writeFileSync(source, 'bounded continuation\n');
    return { status: 'done', summary: 'Residual implementation', must_haves_status: [], files_changed: ['src.js'] };
  } };
  const result = await sidecar.runUnitSidecar(continuation.request, runtime);
  assert.equal(result.status, 'done'); assert.equal(calls, 1);
  assert(fs.readFileSync(parentFile).equals(original));
  const child = JSON.parse(fs.readFileSync(continuation.request.resultFile + '.receipt.json'));
  assert.equal(child.partial_continuation.parent_receipt_sha256, require('./forge-code-roots').digest(original));
  const repeated = create();
  await sidecar.runUnitSidecar(repeated.request, { ...runtime, partialContinuation: repeated.capability });
  assert.equal(calls, 1); assert(fs.readFileSync(parentFile).equals(original));
  // Use an absent planned leaf: a child under the existing src.js file is
  // already refused by lstat with ENOTDIR on POSIX, before the residual guard.
  // A missing leaf reaches the exactness check on every supported platform.
  const only = { execution_contract: f.r.execution_contract, claims: [{root_id:'app',path:'pending.js'}], continuation_paths:['app::pending.js'], snapshots:[] };
  assert.throws(()=>require('./forge-task-execution').verifyResult(f.cwd,only,{files_changed:['app::pending.js/extra.js']}),e=>e.code==='execution-outside-claim','exact residual must never cover descendant');
  completed = true;
  console.log('PASS retained partial, joined writer, immutable parent, narrowed continuation and idempotent replay');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => h.close(completed));
