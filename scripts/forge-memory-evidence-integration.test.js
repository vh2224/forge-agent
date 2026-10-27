#!/usr/bin/env node
'use strict';

// Offline integration: every writer below targets this suite's temporary root.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory');
const extraction = require('./forge-memory-extraction');
const evidence = require('./forge-memory-evidence');
const projection = require('./forge-projection');
const sidecar = require('./forge-unit-sidecar');
const fixtureDir = path.join(__dirname, 'fixtures/memory-evidence');
const fixtures = Object.fromEntries(['v1', 'v2', 'mixed', 'invalid'].map(name =>
  [name, JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'))]));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const snapshots = Object.fromEntries(Object.keys(fixtures).map(name =>
  [name, sha(fs.readFileSync(path.join(fixtureDir, `${name}.json`)))]));
const now = fixtures.v2.now;
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-integration-')));
const route = { host_runtime: 'codex', worker_engine: 'native', resolved_worker_engine: 'native',
  worker_mode: 'native', model: 'gpt-6-luna', model_resolved: 'gpt-6-luna', effort: 'medium' };
const telemetry = { model_requested: null, model_resolved: 'gpt-6-luna', model_argument: 'gpt-6-luna',
  model_observed: null, model_observed_source: null, effort_requested: 'medium', effort_resolved: 'medium',
  effort_argument: 'medium', effort_transport: 'native-argument', effort_transport_value: 'medium',
  effort_transport_source: 'fixture-native-argument', effort_binding_observed: null,
  effort_binding_observed_source: null, effort_binding_observed_fingerprint: null,
  effort_applied: null, effort_applied_source: null, capabilities_source: 'fixture' };
const joined = { ownerJoined: true, checkedAt: now, protectedSnapshots: [] };
const request = (cwd, name, extra) => ({ cwd, contextRoot: cwd, unitType: 'memory-extract',
  sourceUnitType: 'execute-task', sourceUnitId: 'T01', milestoneId: 'M001', workflowId: 'fixture',
  dispatchId: `dispatch-${name}`, extractionId: `extraction-${name}`, extractedAt: now,
  sourceFingerprint: 'sha256:fixture-source', summaryContent: 'Synthetic public integration summary',
  sourceResult: 'status: done', keyDecisions: [], existingMemory: { facts: [], stats: [] },
  route, hostRuntime: 'codex', resultFile: path.join(work, `${name}.json`),
  publicationSafe: true, publicationBoundary: joined, invocationTelemetry: telemetry, ...(extra || {}) });
const newRoot = name => {
  const cwd = path.join(work, name);
  fs.mkdirSync(cwd);
  return cwd;
};
const fragmentBytes = cwd => fs.readFileSync(memory.fragmentPath(cwd, 'T01', { milestoneId: 'M001' }));
const readFragment = cwd => memory.readFragment(cwd, 'T01', { milestoneId: 'M001' });
const cli = (cwd, args, input) => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory.js'), ...args, '--cwd', cwd],
    { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

async function main() {
  try {
    const legacy = evidence.foldMemoryEvidence(fixtures.v1.fragment);
    const entry = legacy.entries.find(row => row.mem_id === 'MEM001');
    assert.strictEqual(entry.legacyProjection.hits, 5);
    assert.strictEqual(entry.legacyProjection.confidence, 0.7);
    assert.strictEqual(entry.v2.independent_confirmation_count, 0);
    assert.strictEqual(entry.legacy_ambiguous.hit, 3);
    assert.strictEqual(entry.legacyProjection.promoted, true);
    assert(legacy.entries.find(row => row.mem_id === 'MEM002').superseded);
    assert(legacy.entries.find(row => row.mem_id === 'MEM003').pruned);
    // The first hit precedes seed: sorting or retroactive dedup would alter this baseline.
    const mixed = fixtures.mixed;
    const before = evidence.foldMemoryEvidence(mixed.fragments);
    const reordered = structuredClone(mixed.fragments);
    reordered[0].stats = [...fixtures.v1.fragment.stats,
      ...mixed.arrival_order.map(index => mixed.replay_rows[index]), ...mixed.replay_rows];
    const after = evidence.foldMemoryEvidence(reordered);
    assert.deepStrictEqual(after.entries, before.entries);
    assert.strictEqual(after.replayed.length, 4);
    assert.strictEqual(before.entries.find(row => row.identity === 'M002/T01/MEM001').legacyProjection.hits, 0);
    assert.strictEqual(before.entries.find(row => row.identity === 'M001/T01/MEM001').v2.independent_confirmation_count, 1);
    const collision = structuredClone(mixed.fragments);
    collision[0].stats.push({ ...mixed.replay_rows[0], observation_id: 'conflicting-observation' });
    assert.throws(() => evidence.foldMemoryEvidence(collision), /conflicting/);
    console.log('PASS mixed fixture: legacy order/duplicates/controls remain ambiguous; v2 reorder/replay is stable and namespaces/collisions are isolated');

    assert.strictEqual(sha(fs.readFileSync(path.join(__dirname, '../shared/schemas/memory-extraction.schema.json'))),
      '81ed10b9e2fab982af5b14f60614b578715899e3a2adf8986448460c7bd8b7a0');
    const cwd = newRoot('owner');
    // Use a clean active target to distinguish new evidence from historical controls.
    memory.writeFragment(cwd, { ...fixtures.v1.fragment, facts: [fixtures.v1.fragment.facts[0]], stats: [] });
    const unchanged = fragmentBytes(cwd);
    for (const invalid of fixtures.invalid.cases) {
      assert.throws(() => extraction.publishExtraction({ cwd, extraction: invalid.result,
        sourceContext: { unitId: 'T01', milestoneId: 'M001', extractionId: 'invalid', extractedAt: now,
          source: { sourceUnit: 'execute-task/T01', sourceFingerprint: 'sha256:fixture-source', dispatchId: 'invalid' } } }),
      undefined, invalid.name);
      assert(fragmentBytes(cwd).equals(unchanged), invalid.name);
    }
    console.log('PASS closed schemas: frozen v1 bytes and invalid versions/hybrids/extra fields/identities rejected without partial writes');

    let providerCalls = 0;
    const provider = async () => { providerCalls++; throw new Error('unexpected new inference on receipt replay'); };
    const firstRequest = request(cwd, 'first', { memoryEvidence: fixtures.v2.memoryEvidence });
    const first = await sidecar.acceptNativeMemoryResult({ ...firstRequest, rawResult: fixtures.v2.extraction });
    assert.strictEqual(first.publication.status, 'written');
    assert.strictEqual(first.publication.state[0].independent_confirmation_count, 1);
    const receiptFile = `${firstRequest.resultFile}.receipt.json`;
    const receiptHash = sha(fs.readFileSync(receiptFile));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(receiptFile)).extraction, fixtures.v2.ready.extraction);
    const stored = readFragment(cwd);
    const fullOwnerFold = extraction._private.foldPublication(stored.facts, stored.stats,
      { milestoneId: 'M001', unitId: 'T01' }).folded;
    const reconstruction = projection.projectMemoryState(cwd, { nowMs: Date.parse(now) });
    assert.deepStrictEqual(evidence.foldMemoryEvidence({ ...stored, milestoneId: 'M001', unitId: 'T01' }), fullOwnerFold);
    assert.deepStrictEqual(extraction._private.semanticState(fullOwnerFold), first.publication.state);
    assert.strictEqual(reconstruction.model_version, fullOwnerFold.model_version);
    const projected = reconstruction.entries.find(row => row.identity === 'M001/T01/MEM001');
    assert.deepStrictEqual([projected.hits, projected.base_confidence, projected.confidence], [1, 0.92, 0.92]);
    assert.deepStrictEqual([projected.evidence.counters.exposure.count, projected.evidence.counters.reobserve.count,
      projected.evidence.counters.independent_confirmation.count, projected.evidence.counters.utility.count], [1, 1, 1, 1]);
    const queryOptions = { unitType: 'execute-task', query: '', nowMs: Date.parse(now) };
    const queried = memory.queryRelevant({ cwd, ...queryOptions });
    assert.deepStrictEqual(queried, projection.queryMemoryEntries(cwd, queryOptions));
    assert.strictEqual(queried.evidence_model_version, fullOwnerFold.model_version);
    const queriedEntry = queried.entries.find(row => row.identity === projected.identity);
    assert.deepStrictEqual([queriedEntry.hits, queriedEntry.base_confidence, queriedEntry.confidence], [1, 0.92, 0.92]);
    assert.strictEqual(queriedEntry.score, 10.92);
    console.log('PASS fixed-clock query: public memory query and projection share model_version, active state and unchanged additive score=10.92');
    let settled = fragmentBytes(cwd);
    const secondRequest = request(cwd, 'second', { memoryEvidence: fixtures.v2.memoryEvidence });
    const second = await sidecar.acceptNativeMemoryResult({ ...secondRequest, rawResult: fixtures.v2.extraction });
    assert.strictEqual(second.publication.status, 'written');
    assert(!fragmentBytes(cwd).equals(settled), 'new delivery IDs are durable');
    settled = fragmentBytes(cwd);
    assert.deepStrictEqual(second.publication.state, first.publication.state);
    const replay = await sidecar.runNativeMemory(firstRequest, provider);
    assert.strictEqual(replay.publication.status, 'noop');
    fs.writeFileSync(path.join(work, 'request.json'), JSON.stringify(firstRequest));
    const child = spawnSync(process.execPath, ['-e', `
      const fs=require('fs'),assert=require('assert'),s=require(process.argv[1]);
      const req=JSON.parse(fs.readFileSync(process.argv[2]));let calls=0;
      s.runNativeMemory(req,async()=>{calls++;throw Error('replay called provider')}).then(r=>{
        assert.strictEqual(r.publication.reason,'replay');assert.strictEqual(calls,0);
        console.log('restarted receipt replay: provider_calls=0, publication=noop');
      }).catch(e=>{console.error(e);process.exitCode=1});
    `, path.join(__dirname, 'forge-unit-sidecar.js'), path.join(work, 'request.json')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.strictEqual(child.status, 0, child.stderr);
    assert(child.stdout.includes('provider_calls=0'));
    // Also exercise the public CLI in a fresh runtime.
    const restarted = spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-sidecar.js'),
      '--accept-native-memory', path.join(work, 'request.json')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.strictEqual(restarted.status, 0, restarted.stderr);
    assert.strictEqual(JSON.parse(restarted.stdout).publication.reason, 'replay');
    assert.strictEqual(providerCalls, 0);
    assert(fragmentBytes(cwd).equals(settled));
    assert.strictEqual(sha(fs.readFileSync(receiptFile)), receiptHash);
    console.log('PASS owner parity: two publications and restarted ready replay preserve full fold, bytes, receipt hash and one independent reinforcement; provider_calls=0');

    const changed = await sidecar.runNativeMemory({ ...firstRequest, summaryContent: 'Changed bound source' }, provider);
    assert.strictEqual(changed.reason_code, 'dispatch-identity-conflict');
    const conflicting = await sidecar.acceptNativeMemoryResult({ ...request(cwd, 'collision', {
      extractionId: firstRequest.extractionId, memoryEvidence: fixtures.v2.memoryEvidence }),
      rawResult: { ...fixtures.v2.extraction, events: [{ ...fixtures.v2.extraction.events[1], local_event_id: 'e0' }] } });
    assert.strictEqual(conflicting.publication.status, 'conflict');
    for (const record of fixtures.invalid.binding_conflicts) {
      const bad = request(cwd, record.name, { memoryEvidence: fixtures.v2.memoryEvidence });
      if (record.source_unit) bad.memoryEvidence = { ...fixtures.v2.memoryEvidence,
        records: fixtures.v2.memoryEvidence.records.map(row => ({ ...row, source_unit: record.source_unit })) };
      const rawResult = record.evidence_ref ? { ...fixtures.v2.extraction,
        events: [{ kind: 'confirm', local_event_id: 'missing', existing_id: 'MEM001', evidence_ref: record.evidence_ref }] }
        : fixtures.v2.extraction;
      await assert.rejects(sidecar.acceptNativeMemoryResult({ ...bad, rawResult }));
      if (fs.existsSync(`${bad.resultFile}.receipt.json`)) {
        assert.notStrictEqual(JSON.parse(fs.readFileSync(`${bad.resultFile}.receipt.json`)).phase, 'ready');
      }
    }
    assert(fragmentBytes(cwd).equals(settled));
    console.log('PASS source and identity boundaries: modified source, conflicting event ID and missing/foreign bindings preserve canonical bytes');

    const legacyRoot = newRoot('legacy-ready');
    memory.writeFragment(legacyRoot, { ...fixtures.v1.fragment, facts: [fixtures.v1.fragment.facts[0]],
      stats: [{ kind: 'seed', mem_id: 'MEM001', ts: now, confidence_base: 0.9, hits: 2 }] });
    const oldRequest = request(legacyRoot, 'legacy', { policy: { decision: 'extract' } });
    const fingerprint = sha(JSON.stringify({ ...oldRequest, unitType: 'memory-extract', rawResult: undefined,
      invocationTelemetry: undefined, resultFile: undefined, publicationSafe: undefined,
      publicationBoundary: undefined, waitForPublicationBoundary: undefined }));
    const legacyReceipt = { ...fixtures.v1.ready, fingerprint, dispatch_id: oldRequest.dispatchId,
      extraction_id: oldRequest.extractionId, telemetry };
    fs.writeFileSync(`${oldRequest.resultFile}.receipt.json`, JSON.stringify(legacyReceipt));
    const oldHash = sha(fs.readFileSync(`${oldRequest.resultFile}.receipt.json`));
    const resumed = await sidecar.runNativeMemory(oldRequest, provider);
    assert.strictEqual(resumed.publication.promotion_policy, 'v1');
    assert.strictEqual(resumed.publication.state[0].promoted, true);
    assert.strictEqual(resumed.publication.state[0].independent_confirmation_count, 0);
    assert.deepStrictEqual(readFragment(legacyRoot).stats.filter(row => row.event_id).map(row => row.event_id),
      [`${oldRequest.extractionId}:event:000`, `${oldRequest.extractionId}:event:001`]);
    assert.strictEqual(sha(fs.readFileSync(`${oldRequest.resultFile}.receipt.json`)), oldHash);
    console.log('PASS historical ready: pending v1 promotion and indexed IDs/fingerprint preserved, zero independent evidence and zero provider calls');

    const stressRoot = newRoot('no-self-reinforcement');
    memory.writeFragment(stressRoot, { ...fixtures.v1.fragment, facts: [fixtures.v1.fragment.facts[0]], stats: [] });
    const source = { sourceUnit: 'execute-task/T01', sourceFingerprint: 'sha256:fixture-source', dispatchId: 'stress' };
    const publish = (name, events, records, outcomes) => extraction.publishExtraction({ cwd: stressRoot,
      extraction: { ...fixtures.v2.extraction, events }, sourceContext: { unitId: 'T01', milestoneId: 'M001',
        extractionId: name, extractedAt: now, source,
        evidence: extraction.normalizeEvidenceRegistry({ records: records.map(r => ({ ...r, source_unit: source.sourceUnit, source_fingerprint: source.sourceFingerprint })), outcomes: outcomes || [] }, source) } });
    for (let i = 0; i < 50; i++) {
      const records = ['exposure', 'reobserve'].map(kind => ({ evidence_ref: kind,
        observation_id: `stress-${kind}-${i}`, observed_kind: kind }));
      assert.strictEqual(publish(`stress-${i}`, records.map((r, j) => ({ kind: r.observed_kind,
        local_event_id: `e${j}`, existing_id: 'MEM001', evidence_ref: r.evidence_ref })), records).status, 'written');
    }
    const promoteEvent = { kind: 'promote', local_event_id: 'p', existing_id: 'MEM001', threshold_met: true };
    const denied = publish('stress-promote', [promoteEvent], []);
    assert.strictEqual(denied.reason_code, 'promotion-threshold-not-met');
    const stressEntry = projection.projectMemoryState(stressRoot, { nowMs: Date.parse(now) }).entries[0];
    assert.deepStrictEqual([stressEntry.hits, stressEntry.base_confidence, stressEntry.promoted,
      stressEntry.evidence.counters.exposure.count, stressEntry.evidence.counters.reobserve.count], [0, 0.9, false, 50, 50]);
    for (let i = 0; i < 3; i++) {
      const record = { evidence_ref: 'verified', observation_id: `distinct-${i}`, observed_kind: 'confirm',
        independent_ref: `fixture:independent-check-${i}` };
      assert.strictEqual(publish(`confirm-${i}`, [{ kind: 'confirm', local_event_id: 'c', existing_id: 'MEM001',
        evidence_ref: 'verified' }], [record]).status, 'written');
    }
    const promoted = publish('eligible-promotion', [promoteEvent], []);
    assert.strictEqual(promoted.status, 'written');
    assert.strictEqual(promoted.state[0].independent_confirmation_count, 3);
    assert.strictEqual(promoted.state[0].v2_promoted, true);
    const withoutOutcome = fragmentBytes(stressRoot);
    assert.strictEqual(publish('no-outcome', [fixtures.v2.extraction.events[3]],
      [fixtures.v2.memoryEvidence.records[3]]).status, 'conflict');
    assert(fragmentBytes(stressRoot).equals(withoutOutcome));
    console.log('PASS evidence matrix: 100 exposures/reobservations never reinforce/promote; three distinct verified occurrences promote; utility without outcome writes nothing');

    const readHash = sha(fragmentBytes(cwd));
    assert.strictEqual(cli(cwd, ['--read', 'T01', '--milestone', 'M001']).facts.length, 1);
    const query = cli(cwd, ['--query', '--text', 'architecture']);
    const select = cli(cwd, ['--select', '--text', 'architecture']);
    assert.deepStrictEqual(select.entries, query.entries);
    assert(select.entries.length > 0);
    assert.strictEqual(sha(fragmentBytes(cwd)), readHash);
    const target = { unit_id: 'T01', milestone_id: 'M001', mem_id: 'MEM001' };
    assert.strictEqual(cli(cwd, ['--hit', '--event-id', 'delivery-fixture'], [target, target]).recorded, 1);
    assert.strictEqual(cli(cwd, ['--expose', '--event-id', 'delivery-fixture'], { entries: [target] }).recorded, 0);
    assert.strictEqual(cli(cwd, ['--hit'], { entries: [target, target] }).recorded, 1);
    const exposed = projection.projectMemoryState(cwd, { nowMs: Date.parse(now) }).entries[0];
    assert.strictEqual(exposed.hits, projected.hits);
    assert.strictEqual(exposed.base_confidence, projected.base_confidence);
    assert.strictEqual(exposed.evidence.v2.independent_confirmation_count, 1);
    console.log('PASS real CLI: read/query/select are read-only; hit/expose array/envelope deduplicate, delivery replay recorded=0 and unidentified calls remain exposure-only');

    for (const [name, hash] of Object.entries(snapshots)) {
      assert.strictEqual(sha(fs.readFileSync(path.join(fixtureDir, `${name}.json`))), hash);
      console.log(`PASS artifact scripts/fixtures/memory-evidence/${name}.json: consumed, immutable sha256=${hash}`);
    }
    const readme = fs.readFileSync(path.join(fixtureDir, 'README.md'), 'utf8');
    for (const hash of Object.values(snapshots)) assert(readme.includes(hash), 'README pins exact fixture bytes');
    for (const text of ['synthetic', 'historical', 'templates', 'no personal data', 'v1.json', 'v2.json', 'mixed.json', 'invalid.json']) {
      assert(readme.includes(text), text);
    }
    console.log('PASS artifact scripts/fixtures/memory-evidence/README.md: synthetic provenance, receipt recipes, exact hashes and expected observations verified');
    const contract = fs.readFileSync(path.join(__dirname, '../shared/forge-memory-evidence.md'), 'utf8');
    for (const text of ['S03 compatibility acceptance matrix', 'S05 and S06', 'model_version: 2',
      'S07 receives separate extraction', 'S08 receives the matrix', 'S09 receives v1.json',
      'observational', 'matched_terms*100 + category_preference*10 + confidence*max(1,hits)',
      'forge-memory-evidence-distribution.test.js', 'temporary installation only',
      'Hosted CI, Node 22', 'not established by local suite success']) assert(contract.includes(text), text);
    console.log('PASS artifact shared/forge-memory-evidence.md: before/after compatibility matrix, named distribution check/limits and S05/S06/S07/S08/S09 handoff preserve formula and observational case');
    console.log('PASS integration artifact: real store, publisher, projection and unit-sidecar exercised in isolated roots without network or credentials');
  } finally {
    assert.strictEqual(path.dirname(work), fs.realpathSync(os.tmpdir()));
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
