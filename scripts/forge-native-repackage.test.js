'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fixtures = require('./forge-recovery-transition.test');
const { fixture } = require('./forge-native-recovery-delivery.test');
const side = require('./forge-unit-sidecar');
const roots = require('./forge-code-roots');
const stateApi = require('./forge-xllm-state');
async function main() {
  const f = await fixture({ standalone: true, corrected: true });
  try {
    const ipcFile = path.join(f.dir, 'ipc.json'), oldJournal = path.join(f.dir, 'old-journal.json');
    const journal = file => ({ journal: { root: f.dir, file, authorize: () => true } });
    f.runtime.nativeLifecycle = journal(oldJournal);
    f.runtime.invokeNative = async (request, binding) => {
      fs.writeFileSync(ipcFile, JSON.stringify({ request, args: binding.args, manifest_file: request.resultFile + '.manifest.json' }));
      // Caller stopped before invoking the actual executor tool.
      throw Object.assign(new Error('fixture-caller-uninvoked'), { code: 'fixture-caller-uninvoked', provider_called: false });
    };
    await side.recoverUnitSidecar(f.request, f.recovery, f.runtime);
    const original = stateApi.loadRecovery(f.stateFile), ipc = JSON.parse(fs.readFileSync(ipcFile));
    assert.equal(original.continuation.status, 'dispatch-possible');
    const input = { ...f.recovery, transitions: [{ type: 'uninvoked-native-repackage', reference: 'fixture:actual-census' }],
      nativeRepackage: { invocationFile: ipcFile, journalFile: oldJournal } };
    const proof = challenge => ({ binding_sha256: roots.digest(challenge), actual_native_calls: 0,
      wrapper_stopped: true, status: 'uninvoked', evidence_reference: 'fixture:actual-tool-census' });
    const adapter = attestRepackage => fixtures.adapter(f, {
      attestUninvoked: challenge => ({ ...challenge, binding_sha256: roots.digest(challenge), status: 'uninvoked', native_calls: 0, evidence_reference: 'fixture:census' }),
      ...(attestRepackage ? { attestRepackage } : {}) });
    f.runtime.nativeLifecycle = journal(path.join(f.dir, 'fresh-journal.json'));
    for (const change of [null, c => ({ ...proof(c), actual_native_calls: 1 }),
      c => ({ ...proof(c), actual_native_calls: 'unknown' }), c => ({ ...proof(c), wrapper_stopped: false }),
      c => ({ ...proof(c), binding_sha256: 'wrong' })]) {
      f.runtime.transitionAdapter = adapter(change);
      await assert.rejects(() => side.recoverUnitSidecar(f.request, input, f.runtime), /transition-repackage/);
      assert.deepEqual(stateApi.loadRecovery(f.stateFile), original);
    }
    f.runtime.transitionAdapter = adapter(proof);
    const journalBytes = fs.readFileSync(oldJournal);
    for (const mutation of [{ handle_sha256: 'a'.repeat(64) }, { sequence: 0 }, { first_remote_ms: 1 }, { phase: 'terminal' }, { open_tools: true }]) {
      fs.writeFileSync(oldJournal, JSON.stringify({ ...JSON.parse(journalBytes), ...mutation }));
      await assert.rejects(() => side.recoverUnitSidecar(f.request, input, f.runtime), /native-repackage-evidence-invalid/);
      fs.writeFileSync(oldJournal, journalBytes);
    }
    fs.writeFileSync(ipc.request.resultFile, '{}');
    await assert.rejects(() => side.recoverUnitSidecar(f.request, input, f.runtime), /native-repackage-evidence-invalid/);
    fs.unlinkSync(ipc.request.resultFile);
    f.runtime.nativeLifecycle = journal(oldJournal);
    await assert.rejects(() => side.recoverUnitSidecar(f.request, input, f.runtime), /native-repackage-evidence-invalid/);
    assert.deepEqual(stateApi.loadRecovery(f.stateFile), original, 'old journal must refuse before state mutation');
    f.runtime.nativeLifecycle = journal(path.join(f.dir, 'fresh-journal.json'));
    delete f.runtime.invokeNative;
    const prepared = await side.recoverUnitSidecar(f.request, input, f.runtime);
    assert.equal(prepared.result.action, 'invoke-native');
    const retained = stateApi.loadRecovery(f.stateFile);
    assert.equal(retained.continuation.status, 'prepared');
    assert.deepEqual(retained.continuation_history, [original.continuation]);
    await assert.rejects(() => side.recoverUnitSidecar(f.request, input, f.runtime), /native-repackage-evidence-invalid/);
    fs.writeFileSync(oldJournal, JSON.stringify({ ...JSON.parse(journalBytes), handle_sha256: 'a'.repeat(64) }));
    await assert.rejects(() => side.recoverUnitSidecar(f.request, f.recovery, f.runtime), /native-repackage-evidence-invalid/);
    fs.writeFileSync(oldJournal, journalBytes);
    fs.writeFileSync(ipc.request.resultFile, '{}');
    await assert.rejects(() => side.recoverUnitSidecar(f.request, f.recovery, f.runtime), /native-repackage-evidence-invalid/);
    fs.unlinkSync(ipc.request.resultFile);
    let calls = 0, measured;
    f.runtime.onPackagedContext = value => { measured = value; };
    f.runtime.invokeNative = async (request, binding, session) => {
      calls++;
      assert(binding.args.message.length < 1500);
      assert.equal(fs.readFileSync(request.resultFile + '.native-prompt.txt', 'utf8'), ipc.args.message);
      const current = stateApi.loadRecovery(f.stateFile);
      assert.deepEqual(current.continuation_history, [original.continuation]);
      assert.deepEqual(current.attempts, original.attempts);
      assert.deepEqual(current.reservations, original.reservations);
      assert.equal(measured.sha256, roots.digest(ipc.args.message));
      assert.equal(measured.final_evidence.request.sha256, roots.digest(binding.args));
      for (const root of f.contract.code_roots) fs.writeFileSync(path.join(root.path, 'same.txt'), 'after\n');
      session.verify = () => { throw Error('fixture-returned-interruption'); };
      return f.result();
    };
    // Resume the already prepared binding with the original ordinary request.
    await assert.rejects(() => side.recoverUnitSidecar(f.request, f.recovery, f.runtime), /fixture-returned-interruption/);
    assert.equal(calls, 1);
    f.runtime.writerObservationAdapter = require('./forge-recovery-transition').createWriterObservationAdapter(challenge => ({ ...challenge,
      binding_sha256: roots.digest(challenge), status: 'stopped', writer_identity: 'fixture-native', evidence_reference: 'fixture:awaited-return' }));
    const replay = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime);
    assert.equal(replay.action, 'replay'); assert.equal(replay.result.published.result.status, 'done');
    assert.equal((await side.recoverUnitSidecar(f.request, f.recovery, f.runtime)).action, 'replay');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(oldJournal), journalBytes);
    console.log('PASS canonical uninvoked repackage: live census, immutable history, pre-consumption restart, exact payload, short binding and returned/publication replay');
  } finally { f.cleanup(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
