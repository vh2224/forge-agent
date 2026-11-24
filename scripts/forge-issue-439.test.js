'use strict';
// #439: the retained response of a failed sidecar attempt is the transport-assembled
// result (VCS-derived files_changed objects + files_changed_declared). The verification
// repair must accept that real shape. The response is built with the real assembler
// and VCS derivation, never hand-shaped.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const roots = require('./forge-code-roots'), side = require('./forge-unit-sidecar'), xllm = require('./forge-xllm');
const repair = require('./forge-sidecar-verification-repair');
const base = require('./forge-issues-434-436.test');

const CAP = { capability: 'workspace', declared: 'workspace' };
function assembled(f, request, mutate = value => value) {
  const root = request.execution_contract.code_roots.find(row => roots.key(row.path) === roots.key(fs.realpathSync.native(f.a)));
  assert(root, 'fixture code root');
  const derived = xllm.deriveFilesChanged(root.path, []).map(entry => ({ ...entry, root_id: root.id, repo: root.id }));
  assert(derived.some(entry => entry.path === 'same.txt'), JSON.stringify(derived));
  const parsed = { status: 'done', summary: 'Retained assembled writer', files_changed: ['same.txt'],
    must_haves_status: [{ item: 'same.txt updated', status: 'met', note: 'fixture', scope: 'task', reason: '' }] };
  const now = new Date().toISOString();
  return mutate(xllm.assembleExecuteResult(parsed, { derived, preDirty: [], multiRepo: {}, startSha: null, headSha: null, vcsField: {},
    startedAt: now, finishedAt: now, durationSecs: 1, dispatchId: request.dispatchId, inputTokens: 1, outputTokens: 1,
    parsePath: 'final-message', appserver: { mode: 'fixture' } }, CAP));
}
function anchor(h, result) {
  const responseFile = h.request.resultFile + '.returned.json', envelope = JSON.parse(fs.readFileSync(responseFile));
  const bytes = Buffer.from(JSON.stringify({ ...envelope, result }));
  fs.writeFileSync(responseFile, bytes);
  const parent = { ...h.parent, returned_response: { ...h.parent.returned_response, sha256: roots.digest(bytes), bytes: bytes.length } };
  fs.writeFileSync(h.parentFile, JSON.stringify(parent));
}

async function shapeContract() { return base.fixture(async f => {
  const h = base.historical(f, { result: (fx, request) => assembled(fx, request) });
  const result = JSON.parse(fs.readFileSync(h.request.resultFile + '.returned.json')).result;
  assert.equal(xllm.validateExecuteResult(result), false, 'raw gate rejects the assembled shape (the #439 defect)');
  assert.equal(xllm.validateAssembledExecuteResult(result), true);
  assert.equal(xllm.validateAssembledExecuteResult({ status: 'done', summary: 's', must_haves_status: [], files_changed: ['a'] }), true, 'historical raw shape');
  for (const mutate of [r => { r.files_changed_declared = [1]; }, r => { r.files_changed = [{ status: 'X', path: 'same.txt' }]; },
    r => { r.files_changed = [{ status: 'M', path: '' }]; }, r => { r.files_changed = 'same.txt'; }, r => { r.must_haves_status = [{ item: 'x' }]; }]) {
    const copy = structuredClone(result); mutate(copy); assert.equal(xllm.validateAssembledExecuteResult(copy), false, JSON.stringify(copy).slice(0, 200));
  }
}); }

async function assembledPipeline() { return base.fixture(async f => {
  const h = base.historical(f, { result: (fx, request) => assembled(fx, request) });
  const cap = repair.create(base.repairOptions(h)), originalRun = xllm.runExecute;
  let providerCalls = 0; xllm.runExecute = async () => { providerCalls++; throw Error('unexpected provider'); };
  try {
    const result = await side.runUnitSidecar(h.request, { verificationSuccessor: cap });
    assert.equal(result.status, 'done'); assert.equal(providerCalls, 0); base.unchanged(f, h);
    const delivery = require('./forge-milestone-time-clock').readCurrentTaskDelivery({ cwd: f.owner, milestone: 'M001', slice: 'S01', task: 'T01', begunAt: 0, completedAt: Date.now() + 1000 });
    assert.equal(delivery.status, 'proven', JSON.stringify(delivery));
  } finally { xllm.runExecute = originalRun; }
}); }

async function assembledNegatives() { return base.fixture(async f => {
  const h = base.historical(f, { result: (fx, request) => assembled(fx, request) });
  const original = JSON.parse(fs.readFileSync(h.request.resultFile + '.returned.json')).result;
  anchor(h, { ...structuredClone(original), files_changed_declared: [42] });
  assert.throws(() => repair.create(base.repairOptions(h)), /verification-repair-result-invalid/);
  anchor(h, { ...structuredClone(original), files_changed: [] });
  assert.throws(() => repair.create(base.repairOptions(h)), /execution-result-omitted-delta/);
  anchor(h, { ...structuredClone(original), status: 'partial' });
  assert.throws(() => repair.create(base.repairOptions(h)), /verification-repair-result-invalid/);
}); }

const cases = [{ name: 'assembled-shape-contract', fn: shapeContract },
  { name: 'assembled-retained-repair-pipeline', fn: assembledPipeline },
  { name: 'assembled-retained-negatives', fn: assembledNegatives }];
async function main() { for (const row of require('./forge-ci-units').selectCases(cases)) { await row.fn(); console.log('PASS ' + row.name); } }
module.exports = { cases, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
