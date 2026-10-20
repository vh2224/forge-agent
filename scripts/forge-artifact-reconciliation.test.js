'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('./forge-artifact-reconciliation');
const unit = require('./forge-unit-sidecar');
const { laboratory } = require('./forge-code-roots.test');
async function main() {
  const lab = laboratory('broker'), owner = path.join(lab.dir, 'owner'), code = path.join(lab.dir, 'code');
  fs.mkdirSync(owner); fs.mkdirSync(code);
  const events = path.join(owner, '.gsd/forge/events.jsonl'), prefix = '{"event":"baseline"}\n';
  fs.mkdirSync(path.dirname(events), { recursive: true }); fs.writeFileSync(events, prefix);
  const request = { scope: 'standalone-task', phase: 'brainstorm', unitType: 'plan-slice',
    taskId: 'T-20261015172849-broker', cwd: code, contextRoot: owner, dispatchId: 'broker-attempt', workflowId: 'broker-workflow',
    resultFile: path.join(lab.dir, 'result.json'), route: { worker_mode: 'native', host_runtime: 'codex' } };
  const fingerprint = unit.artifactFingerprint(request);
  const broker = await api.startBroker({ owner, manifestFile: path.join(lab.dir, 'manifest.json'),
    dispatchId: request.dispatchId, request_sha256: fingerprint, plan_sha256: require('./forge-code-roots').digest('original plan') });
  request.ownerBroker = broker;
  try {
    const manifest = broker.manifest, trust = { manifest_sha256: broker.manifest_sha256, request_sha256: fingerprint };
    assert(!JSON.stringify(manifest).includes('PRIVATE KEY'));
    assert.throws(() => api.assertBroker(JSON.parse(JSON.stringify(broker))), /caller-handle/);
    unit.beginArtifactAttempt(request);
    await broker.append('.gsd/forge/events.jsonl', '{"event":"owner-progress"}\n');
    const proofs = broker.proofs();
    assert(broker.verify().passed);
    const artifact = unit.locations(request).required[0];
    const result = { status: 'done', summary: 'Prepared', questions: [], artifacts: [{ path: artifact,
      content: '# Brainstorm\n## Recommended Approach\nUse roots.\n## Alternatives Considered\nSingle root.\n## Top Risks\nDrift.\n## Out of Scope\nProviders.\n' }] };
    // A restarted caller has the bound manifest but no live IPC capability.
    // It saves the candidate and refuses drift; durable proofs permit recovery.
    const responseAnchor = await broker.bindResponse(result);
    await assert.rejects(broker.bindResponse({ ...result, summary: 'replacement' }), /response-already-bound/);
    const withoutLiveBroker = { ...request }; delete withoutLiveBroker.ownerBroker;
    await assert.rejects(unit.acceptArtifactResult(withoutLiveBroker, result, { providerCalled: true, enforceReadOnlySurface: true, responseAnchor }), /artifact-direct-write/);
    unit.failArtifactAttempt(request, 'artifact-direct-write-detected', 'owner append', true);
    const original = fs.readFileSync(request.resultFile + '.receipt.json');
    assert(JSON.parse(original).saved_candidate);
    await broker.close(); // Existing proofs remain valid with no live signer.
    const options = { manifest, proofs, trust };
    const rename = fs.renameSync;
    let interrupted = false;
    fs.renameSync = (from, to) => {
      const value = rename(from, to);
      if (!interrupted && path.basename(to) === path.basename(artifact)) {
        interrupted = true; throw new Error('publication-interrupted-after-rename');
      }
      return value;
    };
    try { await assert.rejects(unit.reconcileArtifactAttempt(request, options), /publication-interrupted/); }
    finally { fs.renameSync = rename; }
    assert(interrupted);
    assert.deepStrictEqual(fs.readFileSync(request.resultFile + '.receipt.json'), original);
    const replay = await unit.reconcileArtifactAttempt(request, options);
    assert.strictEqual(replay.provider_called, false);
    assert.strictEqual(fs.readFileSync(path.join(owner, artifact), 'utf8'), result.artifacts[0].content);
    const again = await unit.reconcileArtifactAttempt(request, options);
    assert.strictEqual(again.child_receipt, replay.child_receipt);
    assert.deepStrictEqual(fs.readFileSync(request.resultFile + '.receipt.json'), original);
    const forged = JSON.parse(JSON.stringify(proofs)); forged[0].end++;
    assert.throws(() => api.verifySurface(manifest, forged, { ...trust, canonicalArtifacts: result.artifacts }), /signature/);
    const validEvents = fs.readFileSync(events);
    const modifiedManifest = { ...manifest, request_sha256: 'foreign' };
    assert.throws(() => api.verifySurface(modifiedManifest, proofs, trust), /trust-anchor/);
    assert.throws(() => api.verifyProof({ ...manifest, dispatch_id: 'old-attempt' }, proofs[0]), /proof-identity/);
    fs.writeFileSync(events, 'X' + validEvents.toString().slice(1));
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /prefix-changed/);
    fs.writeFileSync(events, validEvents.subarray(0, validEvents.length - 2));
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /span-invalid/);
    fs.writeFileSync(events, validEvents);
    const receiptFile = request.resultFile + '.receipt.json', changed = JSON.parse(original);
    changed.saved_candidate.result.summary = 'tampered';
    fs.writeFileSync(receiptFile, JSON.stringify(changed));
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /response-changed/);
    // Coordinated receipt result + adjacent hash replacement still cannot
    // replace the response independently bound by the broker before refusal.
    changed.saved_candidate.sha256 = require('./forge-code-roots').digest(changed.saved_candidate.result);
    fs.writeFileSync(receiptFile, JSON.stringify(changed));
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /response-anchor-invalid/);
    const anchorFile = `${receiptFile}.response-anchor.json`, validAnchor = fs.readFileSync(anchorFile);
    const forgedAnchor = JSON.parse(validAnchor);
    forgedAnchor.response_sha256 = changed.saved_candidate.sha256;
    fs.writeFileSync(anchorFile, JSON.stringify(forgedAnchor));
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /response-anchor-invalid/);
    fs.unlinkSync(anchorFile);
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /response-anchor-required/);
    fs.writeFileSync(anchorFile, validAnchor);
    fs.writeFileSync(receiptFile, original);
    const untouched = await unit.reconcileArtifactAttempt(request, options);
    assert.strictEqual(untouched.provider_called, false);
    assert.strictEqual(untouched.replayed, true);
    const restartedRequest = { ...request }; delete restartedRequest.ownerBroker;
    const restarted = require('child_process').spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(require.resolve('./forge-unit-sidecar'))}).reconcileArtifactAttempt(JSON.parse(process.argv[1]),JSON.parse(process.argv[2])).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;})`,
      JSON.stringify(restartedRequest), JSON.stringify(options)], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(restarted.status, 0, restarted.stderr);
    assert.strictEqual(JSON.parse(restarted.stdout).provider_called, false);
    assert.strictEqual(JSON.parse(restarted.stdout).replayed, true);
    await assert.rejects(unit.reconcileArtifactAttempt({ ...request, prompt: 'changed input' }, options), /dispatch-identity/);
    fs.appendFileSync(events, '{"event":"unsigned"}\n');
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /unsigned-append/);
    fs.writeFileSync(events, validEvents);
    fs.writeFileSync(path.join(owner, '.gsd', 'unexpected'), 'worker');
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /unproved-drift/);
    fs.unlinkSync(path.join(owner, '.gsd', 'unexpected'));
    fs.writeFileSync(path.join(owner, artifact), 'concurrent edit');
    await assert.rejects(unit.reconcileArtifactAttempt(request, options), /unproved-drift/);
    fs.writeFileSync(path.join(owner, artifact), result.artifacts[0].content);
    await assert.rejects(unit.reconcileArtifactAttempt(request, { ...options, beforePublish() { fs.appendFileSync(events, 'raced\n'); } }), /unsigned-append/);
  } finally { await broker.close(); }
  lab.cleanup(); console.log('PASS broker IPC, failed saved receipt, restart proofs, canonical idempotent replay and negative drift/CAS');

  const liveLab = laboratory('broker-live'), liveOwner = path.join(liveLab.dir, 'owner'), liveCode = path.join(liveLab.dir, 'code');
  fs.mkdirSync(liveOwner); fs.mkdirSync(liveCode);
  const liveRequest = { ...request, cwd: liveCode, contextRoot: liveOwner, resultFile: path.join(liveLab.dir, 'result.json'), dispatchId: 'live' };
  delete liveRequest.ownerBroker;
  const liveBroker = await api.startBroker({ owner: liveOwner, manifestFile: path.join(liveLab.dir, 'manifest.json'),
    dispatchId: liveRequest.dispatchId, request_sha256: unit.artifactFingerprint(liveRequest) });
  liveRequest.ownerBroker = liveBroker;
  try {
    unit.beginArtifactAttempt(liveRequest);
    await liveBroker.append('.gsd/forge/events.jsonl', '{"event":"live"}\n');
    // A broker crash before the proof is durably received cannot authorize the append.
    assert.throws(() => api.verifySurface(liveBroker.manifest, [], { manifest_sha256: liveBroker.manifest_sha256 }), /unproved-drift/);
    const result = { status: 'done', summary: 'live', questions: [], artifacts: [{ path: unit.locations(liveRequest).required[0],
      content: '# Brainstorm\n## Recommended Approach\nUse roots.\n## Alternatives Considered\nSingle root.\n## Top Risks\nDrift.\n## Out of Scope\nProviders.\n' }] };
    const accepted = await unit.acceptArtifactResult(liveRequest, result, { providerCalled: true, enforceReadOnlySurface: true });
    assert.strictEqual(accepted.record.phase, 'ready');
    assert.strictEqual(fs.readFileSync(path.join(liveOwner, result.artifacts[0].path), 'utf8'), result.artifacts[0].content);
    assert.throws(() => api.withOwnerLock(liveOwner, () => {}, {}), /lock-handle/);
  } finally { await liveBroker.close(); }
  liveLab.cleanup(); console.log('PASS live broker acceptance, lost proof refusal and interrupted canonical publication replay');

  const executionLab = require('./forge-code-roots.test').fixture('git');
  try {
    fs.mkdirSync(path.join(executionLab.owner, '.gsd'), { recursive: true });
    const execution = require('./forge-task-execution');
    const request = { cwd: executionLab.a, contextRoot: executionLab.owner };
    const artifact = { path: '.gsd/review-publication.md', content: 'canonical', before: null };
    const record = { result: { status: 'done' }, artifacts: [artifact], execution: {
      inputs: {}, verified_files: {}, code_state: execution.replayState(executionLab.a),
      protected_owner: execution.protectedSnapshot(executionLab.owner),
    } };
    const drift = path.join(executionLab.owner, '.gsd/DECISIONS.md');
    fs.mkdirSync(path.dirname(drift), { recursive: true }); fs.writeFileSync(drift, 'verification command drift');
    assert.throws(() => unit.materialize(request, record), /execution-protected-metadata/);
    assert(!fs.existsSync(path.join(executionLab.owner, artifact.path)));
    fs.unlinkSync(drift);
    // The baseline includes the pre-existing control directory in this fixture.
    unit.materialize(request, record);
    unit.materialize(request, record);
    fs.writeFileSync(drift, 'concurrent replay drift');
    assert.throws(() => unit.materialize(request, record), /execution-protected-metadata/);
    assert.strictEqual(fs.readFileSync(path.join(executionLab.owner, artifact.path), 'utf8'), artifact.content);
    console.log('PASS execution publication and replay reject protected-owner drift under owner lock');
  } finally { executionLab.cleanup(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
