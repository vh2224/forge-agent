'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fixtures = require('./forge-recovery-transition.test');
const { fixture } = require('./forge-native-recovery-delivery.test');
const side = require('./forge-unit-sidecar');
const roots = require('./forge-code-roots');
const stateApi = require('./forge-xllm-state');
async function scenario(linked = false, fileBacked = false) {
  const f = await fixture({ standalone: !linked, corrected: true, linked });
  try {
    if (fileBacked) {
      const recovery = require('./forge-attempt-recovery'), previous = f.history;
      const identity = roots.digest(recovery.requestIdentity(recovery.canonicalRequest(f.request)));
      f.request.nativePromptFile = path.join(f.dir, 'unused-caller-file-hint.txt');
      // Observe this transport projection before the first invocation; it does
      // not change the unit, original attempts or reserved destination.
      f.history = require('./forge-recovery-transition').observeHistory({ request: f.request,
        state: stateApi.loadRecovery(f.stateFile), receiptFile: f.receiptFile,
        contract: f.contract, claim: f.request.claim, resolverOptions: f.originalOptions });
      assert.equal(roots.digest(recovery.requestIdentity(recovery.canonicalRequest(f.request))), identity);
      assert.deepEqual(f.history.attempts, previous.attempts);
      assert.deepEqual(f.history.reservations, previous.reservations);
    }
    const ipcFile = path.join(f.dir, 'ipc.json'), oldJournal = path.join(f.dir, 'old-journal.json');
    let originalPrompt;
    const journal = file => ({ journal: { root: f.dir, file, authorize: () => true } });
    f.runtime.nativeLifecycle = journal(oldJournal);
    f.runtime.invokeNative = async (request, binding) => {
      fs.writeFileSync(ipcFile, JSON.stringify({ request, args: binding.args, manifest_file: request.resultFile + '.manifest.json' }));
      originalPrompt = fileBacked
        ? fs.readFileSync(request.resultFile + '.native-prompt.txt', 'utf8') : binding.args.message;
      // Caller stopped before invoking the actual executor tool.
      throw Object.assign(new Error('fixture-caller-uninvoked'), { code: 'fixture-caller-uninvoked', provider_called: false });
    };
    const interrupted = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime);
    const original = stateApi.loadRecovery(f.stateFile), ipc = JSON.parse(fs.readFileSync(ipcFile));
    assert.equal(original.continuation.status, 'dispatch-possible');
    if (fileBacked) {
      const promptFile = ipc.request.resultFile + '.native-prompt.txt', bytes = fs.readFileSync(promptFile);
      const inspectOriginal = () => require('./forge-native-repackage').inspect({
        request: f.request, executionContract: f.contract,
        nativeRepackage: { invocationFile: ipcFile, journalFile: oldJournal,
          nextJournalFile: path.join(f.dir, 'data-only-probe-journal.json') },
      }, original, require('./forge-attempt-recovery').canonicalRequest(f.request));
      inspectOriginal().validateInvocation(interrupted.invocation);
      assert.deepEqual(fs.readFileSync(promptFile), bytes, 'valid retained file must never be overwritten');
      for (const mutate of [() => fs.appendFileSync(promptFile, 'tampered'),
        () => fs.truncateSync(promptFile, 16 * 1024 * 1024 + 1)]) {
        try {
          mutate();
          const size = fs.statSync(promptFile).size;
          assert.throws(() => inspectOriginal().validateInvocation(interrupted.invocation),
            /native-repackage-evidence-invalid|native-prompt-file-conflict/);
          assert.equal(fs.statSync(promptFile).size, size, 'refusal must not replace damaged input');
          assert.deepEqual(stateApi.loadRecovery(f.stateFile), original);
        } finally { fs.writeFileSync(promptFile, bytes); }
      }
      fs.renameSync(promptFile, promptFile + '.retained');
      try {
        assert.throws(() => inspectOriginal().validateInvocation(interrupted.invocation), /native-repackage-evidence-invalid/);
        assert(!fs.existsSync(promptFile), 'missing input must never be recreated');
        fs.mkdirSync(promptFile);
        assert.throws(() => inspectOriginal().validateInvocation(interrupted.invocation), /native-repackage-evidence-invalid/);
        assert(fs.statSync(promptFile).isDirectory(), 'unsafe input must never be replaced');
        assert.deepEqual(stateApi.loadRecovery(f.stateFile), original);
      } finally {
        if (fs.existsSync(promptFile)) fs.rmdirSync(promptFile);
        fs.renameSync(promptFile + '.retained', promptFile);
      }
      const sources = require('./forge-autonomy-sources'), read = sources.readBoundedStableFile;
      const target = fs.realpathSync.native(promptFile);
      let removed = false;
      sources.readBoundedStableFile = (...args) => {
        const observed = read(...args);
        if (!observed.error && roots.key(args[0]) === roots.key(target)) {
          fs.unlinkSync(promptFile);
          removed = true;
        }
        return observed;
      };
      try {
        assert.throws(() => inspectOriginal().validateInvocation(interrupted.invocation), /native-prompt-file-missing/);
        assert(removed, 'race must follow the genuine successful bounded read');
        assert(!fs.existsSync(promptFile), 'retained input removed after reading must never be recreated');
        assert.deepEqual(stateApi.loadRecovery(f.stateFile), original);
      } finally {
        sources.readBoundedStableFile = read;
        fs.writeFileSync(promptFile, bytes);
      }
    }
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
      assert.equal(fs.readFileSync(request.resultFile + '.native-prompt.txt', 'utf8'), originalPrompt);
      const current = stateApi.loadRecovery(f.stateFile);
      assert.deepEqual(current.continuation_history, [original.continuation]);
      assert.deepEqual(current.attempts, original.attempts);
      assert.deepEqual(current.reservations, original.reservations);
      assert.equal(measured.sha256, roots.digest(originalPrompt));
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
    const promptFile = ipc.request.resultFile + '.native-prompt.txt', promptBytes = fs.readFileSync(promptFile);
    fs.renameSync(promptFile, promptFile + '.preserved');
    await assert.rejects(() => side.recoverUnitSidecar(f.request, f.recovery, f.runtime), /native-prompt-file-missing/);
    assert(!fs.existsSync(promptFile), 'replay must never recreate the prompt');
    fs.renameSync(promptFile + '.preserved', promptFile);
    fs.appendFileSync(promptFile, 'changed');
    await assert.rejects(() => side.recoverUnitSidecar(f.request, f.recovery, f.runtime), /native-prompt-file-conflict/);
    fs.writeFileSync(promptFile, promptBytes);
    const replay = await side.recoverUnitSidecar(f.request, f.recovery, f.runtime);
    assert.equal(replay.action, 'replay'); assert.equal(replay.result.published.result.status, 'done');
    assert.equal((await side.recoverUnitSidecar(f.request, f.recovery, f.runtime)).action, 'replay');
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(oldJournal), journalBytes);
    console.log('PASS '+(fileBacked?'already-file ':'')+(linked?'linked ':'')+'canonical uninvoked repackage: live census, immutable history, pre-consumption restart, exact payload, short binding and returned/publication replay');
  } finally { f.cleanup(); }
}
async function main(){await scenario();await scenario(true);await scenario(false,true);await scenario(true,true);}
if (require.main === module) (process.argv.includes('--linked')?scenario(true):main()).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, scenario };
