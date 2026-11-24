'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), vm = require('vm'), crypto = require('crypto');
const parent = fs.realpathSync.native(os.tmpdir()), lab = fs.mkdtempSync(path.join(parent, 'forge-331-budget-fixture-'));
const token = crypto.randomUUID(), worker = path.join(lab, 'valid-phases.cjs');
fs.writeFileSync(worker, `const fs=require('fs'),crypto=require('crypto'),assert=require('assert/strict');
const [operation,file,hang]=process.argv.slice(2),owner=process.env.FORGE_BUDGET_FIXTURE_AUTH;
assert(owner); const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function step(phase) {
  if(phase==='exhaustion') { const prior=JSON.parse(fs.readFileSync(file+'.native')); assert.equal(prior.owner_sha256,sha(owner));assert.equal(prior.native_calls,1); }
  if(phase===hang) { fs.writeFileSync(file+'.hang-entered',phase); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
  if(phase==='native') fs.writeFileSync(file+'.native',JSON.stringify({owner_sha256:sha(owner),native_calls:1}));
  else fs.writeFileSync(file+'.exhaustion',JSON.stringify({native_sha256:sha(fs.readFileSync(file+'.native')),native_calls:0,owner_sha256:sha(owner)}));
}
if(operation==='--transition-restart') {step('native');step('exhaustion');}
else if(operation==='--context-native-restart') step('native');
else if(operation==='--context-exhaustion-restart') step('exhaustion');
else throw Error('unknown-phase');
`);
function exercise(source, label, hang = '') {
  const from = source.indexOf('function child(args, env) {'), to = source.indexOf('async function restart(file)', from);
  assert(from >= 0 && to > from);
  const calls = [], file = path.join(lab, label);
  const child = vm.runInNewContext(source.slice(from, to) + '\nchild;', { assert, process, spawnSync(executable, args, options) {
    assert.equal(options.timeout, 120000, 'the actual repository caller retains its production operation watchdog');
    const operation = args[1], phase = operation.includes('exhaustion') ? 'exhaustion' : 'native', timeout = phase === hang ? 1000 : 2500;
    const start = Date.now(), result = cp.spawnSync(process.execPath, [worker, operation, file, hang], { ...options, timeout,
      env: { ...options.env, FORGE_BUDGET_FIXTURE_AUTH: token }, windowsHide: true });
    calls.push({ operation, requested_ms: options.timeout, fixture_budget_ms: timeout, duration_ms: Date.now() - start, status: result.status, error: result.error?.code || null });
    return result;
  } });
  const context = source.slice(source.indexOf("const saved = path.join(f.dir, 'context-transition-restart.json')"));
  const operations = [...context.slice(0, context.indexOf('const state = h.assertHistoryPreserved')).matchAll(/child\(\[__filename, '([^']+)', saved\]/g)].map(match => match[1]);
  assert(operations.length);
  let failed = false;
  try { for (const operation of operations) child(['fixture-test.js', operation, file], process.env); }
  catch { failed = true; }
  const hangEntered = fs.existsSync(file + '.hang-entered');
  if (hang) {
    assert(hangEntered, 'the actual OS child must attest entering its blocked phase before a timeout is claimed');
    assert.equal(fs.readFileSync(file + '.hang-entered', 'utf8'), hang);
  }
  const complete = fs.existsSync(file + '.exhaustion');
  if (complete) {
    const final = JSON.parse(fs.readFileSync(file + '.exhaustion'));
    assert.equal(final.native_calls, 0); assert.equal(final.owner_sha256, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(final.native_sha256, crypto.createHash('sha256').update(fs.readFileSync(file + '.native')).digest('hex'));
  }
  return { failed, complete, hang_entered: hangEntered, calls };
}
try {
  const after = fs.readFileSync(path.join(__dirname, 'forge-recovery-workflow.test.js'), 'utf8');
  const helperStart = after.indexOf('function child(args, env) {'), helperEnd = after.indexOf('async function restart(file)', helperStart);
  // Controlled witness of the previous one-process envelope. Actual current
  // callers are extracted independently below; real recovery is exercised by
  // the integration suite, while this regression isolates harness budgeting.
  const before = after.slice(helperStart, helperEnd) + "\nasync function restart(file) {}\nconst saved = path.join(f.dir, 'context-transition-restart.json');\nchild([__filename, '--transition-restart', saved], process.env);\nconst state = h.assertHistoryPreserved";
  assert(after.includes("name, args: [__filename, '--transition-case', name], timeout: 300000"), 'the global group watchdog remains explicit');
  const baseline = exercise(before, 'monolithic'), candidate = exercise(after, 'split');
  assert(baseline.failed && !baseline.complete && baseline.calls.at(-1).error === 'ETIMEDOUT', 'one envelope refuses valid work that exceeds its accumulated budget');
  assert(!candidate.failed && candidate.complete && candidate.calls.length === 2);
  const negatives = Object.fromEntries(['native', 'exhaustion'].map(phase => [phase, exercise(after, 'hang-' + phase, phase)]));
  for (const result of Object.values(negatives)) assert(result.failed && !result.complete && result.calls.at(-1).error === 'ETIMEDOUT');
  const report = { baseline, candidate, negatives, scope: 'Actual child() source and actual context caller sequence; hermetic OS worker with two valid1500ms phases and sealed lineage. Timers are scaled only in this regression (2500ms success envelope,1000ms witnessed hang); full recovery execution retains120000ms.' };
  console.log('PASS context budget: valid monolithic witness times out; both actual phases finish with preserved lineage; a real hang in either phase fails closed');
} finally { assert.equal(path.dirname(lab), parent); fs.rmSync(lab, { recursive: true }); }
