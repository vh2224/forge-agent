#!/usr/bin/env node
'use strict';

// Hermetic owner/home fixtures with stub providers. They prove the adapter,
// supervision journal, owner completion and persistence behavior, not an actual
// provider, host UI, CPU time or billing.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const flow = require('./forge-milestone-time-flow.test');
const workers = require('./forge-milestone-worker-observations');
const clock = require('./forge-milestone-time-clock');
const time = require('./forge-milestone-time');
const orchestrate = require('./forge-orchestrate');
const controller = require('./forge-unit-controller');
const recovery = require('./forge-attempt-recovery');
const native = require('./forge-native-invocation');
const diagnostic = require('./forge-sidecar-diagnostic');
const { artifactFingerprint } = require('./forge-unit-sidecar');
const { digest } = require('./forge-code-roots');
const BASE = Date.parse('2026-11-01T12:00:00.000Z'), M = 'M001';
const iso = n => new Date(BASE + n).toISOString();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cleanup = [];
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; }
function routeOf(host) {
  const model = host === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5', effort = host === 'codex' ? 'high' : 'medium';
  return { model, model_requested: model, model_resolved: model, alias: host === 'codex' ? null : 'sonnet', effort, dispatch_engine: host,
    host_runtime: host, resolved_worker_engine: host, worker_mode: 'native', dispatch_allowed: true, config_ok: true };
}
function setup(host) {
  const f = flow.fixture(host); cleanup.push(f.cwd);
  f.owner = fs.realpathSync.native(f.cwd); f.evidence = path.join(f.owner, 'native-evidence'); fs.mkdirSync(f.evidence);
  f.at = 1; f.selected = flow.invoke(f, 'next');
  assert.equal(f.selected.outcome, 'dispatch_required', JSON.stringify(f.selected));
  f.unit = f.selected.unit; f.beginKey = f.selected.controller_result.details.transaction.idempotency_key;
  f.request = { scope: 'milestone', contextRoot: f.cwd, cwd: f.cwd, milestoneId: M, unitType: f.unit.type, sliceId: f.unit.id, dispatchId: 'dispatch-' + host };
  return f;
}
function agent(f) {
  const file = write(path.join(f.owner, 'agents', 'forge-memory.md'), '---\nname: forge-memory\nmodel: claude-sonnet-5\neffort: medium\n---\nfixture\n');
  return { transport: 'agent-frontmatter', agentPath: file, sourceFingerprint: 'sha256:' + hash(fs.readFileSync(file)) };
}
// Real invokeNative + native supervision with an external journal and a stub
// provider callback. The wall clock is the fixture clock; nothing is spawned.
function nativeOptions(f, name, request = f.request) {
  const codex = f.host === 'codex';
  return { hostRuntime: f.host, resolvedDispatch: routeOf(f.host), prompt: 'private prompt ' + name,
    activeCapabilities: codex ? { available: true, tool: 'spawn_agent', source: 'test-active-tool', models: ['gpt-6-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] }
      : { available: true, tool: 'Agent', source: 'test-active-tool', model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] },
    agentType: codex ? 'forge-executor' : 'forge-memory', ...(codex ? {} : { effortBinding: f.binding || (f.binding = agent(f)) }),
    telemetryIdentity: request, now: () => BASE + f.at, terminalResult: value => value?.status === 'done',
    lifecycle: { journal: { root: f.evidence, file: path.join(f.evidence, name + '.json'), authorize: () => true },
      clock: { wall: () => BASE + f.at, monotonic: () => performance.now(), setTimeout, clearTimeout } } };
}
function nativeSource(options, outcome) {
  return { kind: 'native-supervision', file: options.lifecycle.journal.file, invocation: native.buildNativeInvocation(options),
    telemetry_identity: options.telemetryIdentity, lifecycle: outcome.lifecycle, final_evidence: outcome.final_evidence };
}
// Two overlapping native invocations inside one controller unit: A [2,6], B [3,5].
async function overlapping(f) {
  const a = nativeOptions(f, 'invocation-a'), b = nativeOptions(f, 'invocation-b');
  f.at = 2; let inner;
  const outer = await native.invokeNative(a, async () => {
    f.at = 3; inner = await native.invokeNative(b, async () => { f.at = 5; return { status: 'done' }; });
    f.at = 6; return { status: 'done' };
  });
  assert.equal(outer.ok, true, JSON.stringify(outer)); assert.equal(inner.ok, true, JSON.stringify(inner));
  return [nativeSource(a, outer), nativeSource(b, inner)];
}
function sidecarReceipt(f, name, extra = {}) {
  const request = { ...f.request, dispatchId: 'sidecar-' + name, resultFile: path.join(f.evidence, name + '.result.json') };
  // Receipt lifetime [2,7] includes preparation/verification; transport is 3.
  const receipt = { phase: 'ready', fingerprint: artifactFingerprint(request), dispatch_id: request.dispatchId, started_at: iso(2),
    provider_called: true, telemetry: { observation: diagnostic.observation({ phase: 'closed', process_exit_observed: true,
      transport_ms: 3, elapsed_ms: 4, verification_ms: 1 }) }, final_evidence: { duration_ms: 5 }, ...extra };
  return { request, file: write(path.join(f.evidence, name + '.receipt.json'), receipt), receipt };
}
function reader(f, sources, inventory = 'complete') {
  return workers.createObservationReader(ctx => { f.contexts = (f.contexts || []).concat(ctx); return { inventory, sources: typeof sources === 'function' ? sources(ctx) : sources }; },
    { roots: [f.evidence] });
}
function complete(f, handle, at = 8) {
  f.at = at;
  return flow.invoke(f, 'complete', f.selected.snapshot, { result: { status: 'done' } },
    { ...f.options, ...(handle ? { workerObservationReader: handle } : {}) });
}
function records(f) {
  const directory = time.timePaths({ cwd: f.cwd, milestone: M }).directory;
  return ['observations', 'coverage'].flatMap(kind => fs.existsSync(path.join(directory, kind))
    ? fs.readdirSync(path.join(directory, kind)).map(name => [kind + '/' + name, fs.readFileSync(path.join(directory, kind, name), 'utf8')]) : []);
}
function fileHashes(files) { return files.map(file => hash(fs.readFileSync(file))); }
function liveFailedReceipt(f) {
  const begin = controller.lookupRecord(f.cwd, 'transaction', f.beginKey), context = f.options.inspectAttempt({ begin });
  write(path.join(f.cwd, 'receipt.json'), { phase: 'failed', recovery_identity_sha256: digest(recovery.requestIdentity(context.request)),
    failure: { reason_code: 'fixture-failure', provider_called: false } });
}

async function main() {
  await test('declared-artifacts-substantive-and-key-links-real', () => {
    for (const [file, lines] of [['forge-milestone-worker-observations.js', 40], ['forge-milestone-worker-observations.test.js', 40],
      ['forge-milestone-time-clock.js', 40], ['forge-milestone-time-clock.test.js', 40]]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert(source.split('\n').length >= lines, file); if (!file.endsWith('.test.js')) assert(!/\b(?:TODO|TBD|FIXME)\b/.test(source), file);
    }
    assert(fs.readFileSync(path.join(__dirname, 'forge-milestone-time-clock.js'), 'utf8').includes("require('./forge-milestone-worker-observations')"));
    assert(fs.readFileSync(path.join(__dirname, 'forge-orchestrate.js'), 'utf8').includes("require('./forge-milestone-worker-observations')"));
    assert(fs.readFileSync(path.join(__dirname, 'forge-loop-controller.js'), 'utf8').includes("'workerObservationReader'"));
  });
  for (const host of ['claude', 'codex']) {
    await test(host + ': native-supervision-overlap-owner-completion-persisted-fresh-process-and-no-writer-mutation', async () => {
      const f = setup(host), sources = await overlapping(f), journals = sources.map(s => s.file), before = fileHashes(journals);
      const persisted = journals.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
      assert.deepEqual(persisted.map(j => [j.phase, j.start_wall_ms - BASE, j.last_wall_ms - BASE]), [['terminal', 2, 6], ['terminal', 3, 5]]);
      const done = complete(f, reader(f, sources));
      assert.equal(done.outcome, 'completed', JSON.stringify(done));
      const observed = done.controller_result.details.time.worker_observations;
      assert.deepEqual({ ...observed, published: undefined }, { status: 'recorded', coverage: 'complete', observations: 2, observed_ms: 6,
        not_invoked: 0, successors: 0, refused: [], published: undefined, unchanged: 0 });
      assert.equal(observed.published, 3);
      assert.deepEqual(fileHashes(journals), before, 'owner observation never rewrites worker journals');
      assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].unit, f.unit.key); assert.equal(f.contexts[0].begin_at, BASE + 1);
      const read = clock.readClock({ cwd: f.cwd, milestone: M, now: BASE + 8 });
      assert.equal(read.status, 'measured');
      // One controller unit [1,8]; two overlapping invocations sum to 4 + 2.
      assert.equal(read.effort.unit_interval_sum_ms, 7); assert.equal(read.effort.basis, 'controller-unit-intervals');
      assert.equal(read.effort.worker.status, 'complete'); assert.equal(read.effort.worker.worker_ms, 6);
      assert.equal(read.effort.worker.observed_worker_ms, 6); assert.equal(read.effort.worker.invocations, 2);
      assert.equal(read.consumption.consumed_ms, 8); assert.equal(read.consumption.by_class['unit-work'], 7);
      const child = spawnSync(process.execPath, ['-e', 'const c=require(process.argv[1]);process.stdout.write(JSON.stringify(c.readClock(JSON.parse(process.argv[2]))));',
        require.resolve('./forge-milestone-time-clock'), JSON.stringify({ cwd: f.cwd, milestone: M, now: BASE + 8 })], { encoding: 'utf8', timeout: 20000 });
      assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), read);
      const stored = records(f), text = JSON.stringify(stored);
      assert.equal(stored.length, 3);
      for (const secret of ['private prompt', 'dispatch-' + host, f.cwd, f.owner, 'native-evidence']) assert(!text.includes(secret), secret);
      // Repeated owner completion replays the committed transaction and the same evidence.
      const again = orchestrate.run('complete', { ...f.input, host_runtime: host, unit: f.unit, begin_key: f.beginKey, result: { status: 'done' } },
        { ...f.options, workerObservationReader: reader(f, sources) });
      assert.equal(again.outcome, 'completed'); assert.equal(again.details.time.worker_observations.published, 0);
      assert.equal(again.details.time.worker_observations.unchanged, 3); assert.deepEqual(records(f), stored);
      // A fresh process without a live reader keeps evidence, writes nothing and never reinvokes.
      const restart = spawnSync(process.execPath, ['-e', `const o=require(process.argv[1]),i=JSON.parse(process.argv[2]);
        process.stdout.write(JSON.stringify(o.run('complete', i, { now: ${BASE + 9}, prefsReader: () => ({ ok: true, prefs: {} }) })));`,
      require.resolve('./forge-orchestrate'), JSON.stringify({ ...f.input, host_runtime: host, unit: f.unit, begin_key: f.beginKey, result: { status: 'done' } })],
      { encoding: 'utf8', timeout: 20000 });
      assert.equal(restart.status, 0, restart.stderr);
      const restarted = JSON.parse(restart.stdout);
      assert.equal(restarted.outcome, 'completed', restart.stdout);
      assert.equal(restarted.details.time.worker_observations.reason, 'observation-reader-unavailable');
      assert.deepEqual(records(f), stored); assert.deepEqual(fileHashes(journals), before);
    });
    await test(host + ': sidecar-transport-and-verification-only-successor-dedup-owner-time-excluded', async () => {
      const f = setup(host), parent = sidecarReceipt(f, 'parent');
      const parentBytes = fs.readFileSync(parent.file);
      const successorFile = write(path.join(f.evidence, 'successor.receipt.json'), { ...parent.receipt, final_evidence: { duration_ms: 30 },
        verification_successor: { schema_version: 1, kind: 'verification-timeout-successor', parent_receipt_sha256: hash(parentBytes), provider_called: false, worker_budget_unchanged: true } });
      const sources = [{ kind: 'sidecar-transport', file: parent.file, request: parent.request },
        { kind: 'sidecar-transport', file: successorFile, request: parent.request, parent_file: parent.file }];
      const done = complete(f, reader(f, sources));
      const observed = done.controller_result.details.time.worker_observations;
      assert.equal(observed.coverage, 'complete', JSON.stringify(observed)); assert.equal(observed.observations, 1);
      assert.equal(observed.successors, 1); assert.equal(observed.observed_ms, 3, 'transport only; receipt lifetimes 5 and 30 excluded');
      const read = clock.readClock({ cwd: f.cwd, milestone: M, now: BASE + 8 });
      assert.equal(read.effort.worker.worker_ms, 3); assert.equal(read.effort.unit_interval_sum_ms, 7);
      const [row] = time.readObservations({ cwd: f.cwd, milestone: M }).records;
      assert.equal(row.placement, 'contained'); assert.equal(row.boundary, 'sidecar-transport-process-including-startup');
      assert.equal(row.started_at, iso(2)); assert.equal(row.finished_at, iso(7)); assert.equal(row.source.sha256, hash(parentBytes));
    });
    await test(host + ': absent-reader-unknown-not-zero-and-no-files', async () => {
      const f = setup(host); await overlapping(f);
      const done = complete(f, null);
      assert.equal(done.outcome, 'completed');
      assert.deepEqual(done.controller_result.details.time.worker_observations, { status: 'unknown', reason: 'observation-reader-unavailable',
        limitation: 'host-supplied-no-trusted-live-reader' });
      assert.deepEqual(records(f), []);
      // A forged/imported handle is not a registered live reader.
      const forged = complete(f, Object.freeze({ read: () => ({ inventory: 'complete', sources: [] }), approved: true }), 9);
      assert.equal(forged.outcome, 'completed'); assert.deepEqual(records(f), []);
      assert.equal(forged.controller_result.details.time.worker_observations.reason, 'observation-reader-unavailable');
      const read = clock.readClock({ cwd: f.cwd, milestone: M, now: BASE + 8 });
      assert.equal(read.status, 'measured'); assert.equal(read.consumption.consumed_ms, 8);
      assert.equal(read.effort.worker.worker_ms, null); assert.equal(read.effort.worker.observed_worker_ms, null);
      assert.equal(read.effort.worker.status, 'unknown'); assert.equal(read.effort.unit_interval_sum_ms, 7);
    });
    await test(host + ': consume-failure-boundary-witnessed-refusal-zero-interval-interrupted-lower-bound', async () => {
      const f = setup(host), interrupted = nativeOptions(f, 'interrupted');
      f.at = 2;
      const failed = await native.invokeNative(interrupted, async () => { f.at = 4; throw Object.assign(Error('private failure text'), { code: 'fixture-host-failure' }); });
      assert.equal(failed.ok, false); assert.equal(failed.lifecycle.phase, 'interrupted');
      f.at = 101; const refused = await native.invokeNative(nativeOptions(f, 'refused'), async () => assert.fail('refused before provider'));
      assert(native.notInvokedWitness(refused));
      liveFailedReceipt(f);
      const witness = { kind: 'native-not-invoked', outcome: refused, telemetry_identity: f.request };
      const options = { ...f.options, processProbe: () => 'stopped',
        reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
        workerObservationReader: reader(f, [witness, nativeSource(interrupted, failed)]) };
      f.at = 150;
      const consumed = flow.invoke(f, 'consume-failure', f.selected.snapshot, {}, options);
      assert.equal(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed));
      const observed = consumed.controller_result.details.time.worker_observations;
      assert.equal(observed.not_invoked, 1); assert.equal(observed.observations, 1); assert.equal(observed.observed_ms, 2);
      assert.equal(observed.coverage, 'partial', 'interrupted supervision is only a lower bound');
      const [row] = time.readObservations({ cwd: f.cwd, milestone: M }).records;
      assert.equal(row.bound, 'lower'); assert.equal(row.terminal, 'interrupted'); assert.equal(row.provider_called, 'unknown');
      const read = clock.readClock({ cwd: f.cwd, milestone: M, now: BASE + 150 });
      assert.equal(read.effort.worker.status, 'partial'); assert.equal(read.effort.worker.worker_ms, null);
      assert.equal(read.effort.worker.observed_worker_ms, 2); assert(!JSON.stringify(records(f)).includes('private failure text'));
    });
  }
  await test('refusals-foreign-link-oversized-malformed-changed-nonterminal-future-work-duplicate-imported', async () => {
    const f = setup('codex'), [a, b] = await overlapping(f), foreignRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(f.owner, '..', 'forge-foreign-')));
    cleanup.push(foreignRoot);
    const copy = (name, mutate) => { const file = path.join(f.evidence, name + '.json'), value = JSON.parse(fs.readFileSync(a.file, 'utf8')); mutate?.(value); write(file, value); return { ...a, file }; };
    const foreign = { ...a, file: write(path.join(foreignRoot, 'a.json'), fs.readFileSync(a.file, 'utf8')) };
    const linked = path.join(f.evidence, 'linked'); fs.symlinkSync(foreignRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = { ...a, file: path.join(linked, 'a.json') };
    const oversized = { ...a, file: write(path.join(f.evidence, 'big.json'), ' '.repeat(40000)) };
    const malformed = { ...a, file: write(path.join(f.evidence, 'bad.json'), '{') };
    const changed = copy('changed', value => { value.last_wall_ms += 1; });
    const nonterminal = copy('started', value => { value.phase = 'started'; });
    const future = { ...copy('future', value => { value.last_wall_ms = BASE + 50; }), lifecycle: { ...a.lifecycle, last_wall_ms: BASE + 50 } };
    const otherWork = { ...a, telemetry_identity: { ...f.request, milestoneId: 'M002' } };
    const otherRoot = { ...a, telemetry_identity: { ...f.request, contextRoot: foreignRoot, cwd: foreignRoot } };
    const conflicting = { ...copy('dup', value => { value.last_wall_ms = BASE + 7; }), lifecycle: { ...a.lifecycle, last_wall_ms: BASE + 7 } };
    const imported = { ...b, approved: true };
    const json = { kind: 'native-not-invoked', outcome: JSON.parse(JSON.stringify(b)), telemetry_identity: f.request };
    const noTransport = sidecarReceipt(f, 'no-transport', { telemetry: {} }), inconsistent = sidecarReceipt(f, 'inconsistent', {
      telemetry: { observation: diagnostic.observation({ phase: 'closed', process_exit_observed: true, transport_ms: 9, elapsed_ms: 4 }) } });
    const open = sidecarReceipt(f, 'open', { telemetry: { observation: diagnostic.observation({ phase: 'remote-activity', transport_ms: 1, elapsed_ms: 1 }) } });
    const orphan = sidecarReceipt(f, 'orphan', { verification_successor: { provider_called: false, parent_receipt_sha256: 'e'.repeat(64) } });
    const sources = [foreign, viaLink, oversized, malformed, changed, nonterminal, future, otherWork, otherRoot, a, conflicting, imported, json,
      ...[noTransport, inconsistent, open, orphan].map(r => ({ kind: 'sidecar-transport', file: r.file, request: r.request })), { kind: 'cpu-sample' }];
    const done = complete(f, reader(f, sources));
    const observed = done.controller_result.details.time.worker_observations;
    assert.equal(done.outcome, 'completed'); assert.equal(observed.coverage, 'partial'); assert.equal(observed.observations, 0, JSON.stringify(observed));
    assert.deepEqual(observed.refused, ['observation-boundary-unavailable', 'observation-descriptor-invalid', 'observation-duplicate-conflict',
      'observation-duration-inconsistent', 'observation-kind-unsupported', 'observation-nonterminal', 'observation-not-invoked-unwitnessed',
      'observation-root-mismatch', 'observation-source-changed', 'observation-source-foreign-root', 'observation-source-link', 'observation-source-malformed',
      'observation-source-oversized', 'observation-successor-parent-unavailable', 'observation-time-future', 'observation-work-mismatch']);
    const read = clock.readClock({ cwd: f.cwd, milestone: M, now: BASE + 8 });
    assert.equal(read.effort.worker.worker_ms, null); assert.equal(read.effort.worker.coverage.partial, 1);
  });
  await test('source-mutation-after-validation-and-protected-window-and-non-milestone-scope', async () => {
    const f = setup('claude'), sources = await overlapping(f);
    const mutating = reader(f, () => sources.map(s => ({ ...s })));
    const saved = fs.readFileSync(sources[0].file); let reads = 0;
    const original = require('./forge-autonomy-sources').readBoundedStableFile;
    require('./forge-autonomy-sources').readBoundedStableFile = function(file, ...rest) {
      const result = original.call(this, file, ...rest);
      if (path.resolve(file) === path.resolve(sources[0].file) && ++reads === 1) fs.writeFileSync(file, Buffer.concat([saved, Buffer.from(' ')]));
      return result;
    };
    const pending = controller.pendingTransactions; let done;
    try {
      controller.pendingTransactions = () => [{ phase: 'intent' }];
      f.at = 8;
      assert.deepEqual(workers.observeCompletion({ cwd: f.cwd, milestone: M, unit: f.unit.key, begin_key: f.beginKey, completion_key: f.beginKey + ':complete',
        completion: 'complete', reader: mutating, now: BASE + 8 }), { status: 'deferred', reason: 'observation-protected-writer-window' });
      controller.pendingTransactions = pending;
      done = complete(f, mutating);
    } finally { require('./forge-autonomy-sources').readBoundedStableFile = original; controller.pendingTransactions = pending; }
    const observed = done.controller_result.details.time.worker_observations;
    assert.equal(observed.observations, 0, JSON.stringify(observed)); assert.deepEqual(observed.refused, ['observation-source-mutated']);
    assert.equal(observed.coverage, 'partial');
    const standalone = workers.observeCompletion({ cwd: f.cwd, milestone: 'T-20261101000000-standalone', unit: f.unit.key, begin_key: f.beginKey,
      completion_key: f.beginKey + ':complete', completion: 'complete', reader: mutating, now: BASE + 8 });
    assert.equal(standalone.status, 'unknown');
    assert(!fs.existsSync(path.join(f.cwd, '.gsd/forge/time/T-20261101000000-standalone')));
  });
  await test('no-contract-milestone-byte-identical-completion-and-no-observation-files', async () => {
    const lease = require('./forge-unit-lease'), acquire = lease.acquire;
    // Same deterministic lease token as the T05 no-contract baseline.
    lease.acquire = (cwd, unit, options) => acquire(cwd, unit, { ...options, tokenFactory: () => 'baseline-generation' });
    try {
      for (const host of ['claude', 'codex']) {
        const f = flow.fixture(host, false); cleanup.push(f.cwd);
        f.at = 1; const selected = flow.invoke(f, 'next');
        // New plan_validation binds the physical owner and its generation. Compare
        // two fresh completions of this SAME private begin, not hashes of foreign owners.
        const gsd = path.join(f.cwd, '.gsd');
        const checkpoint = fs.mkdtempSync(path.join(path.dirname(f.cwd), 'forge-observation-comparison-')); cleanup.push(checkpoint);
        fs.cpSync(gsd, path.join(checkpoint, 'gsd'), { recursive: true });
        const run = handle => {
          f.at = 2;
          const result = flow.invoke(f, 'complete', selected.snapshot, { result: { status: 'done' } }, { ...f.options, ...(handle ? { workerObservationReader: handle(f) } : {}) });
          const text = JSON.stringify(result).split(JSON.stringify(f.cwd).slice(1, -1)).join('<root>');
          return { f, text, completionKey: result.boundary.idempotency_key, events: fs.readFileSync(path.join(f.cwd, '.gsd/milestones', M, M + '-events.jsonl'), 'utf8') };
        };
        let called = 0;
        const plain = run(null);
        // Restore only a synthetic fixture's pre-completion input; no real attempt,
        // worker history or producer receipt is reset by this counterfactual control.
        assert.equal(path.dirname(gsd), f.cwd); assert.equal(path.basename(gsd), '.gsd');
        assert(path.basename(f.cwd).startsWith('forge-time-flow-'));
        fs.rmSync(gsd, { recursive: true, force: true });
        fs.cpSync(path.join(checkpoint, 'gsd'), gsd, { recursive: true });
        assert.equal(controller.lookupRecord(f.cwd, 'transaction', plain.completionKey), null, 'the observed completion must be fresh, not an idempotent cached response');
        const observed = run(f => workers.createObservationReader(() => { called++; return { inventory: 'complete', sources: [] }; },
          { roots: [fs.realpathSync.native(f.cwd)] }));
        assert.equal(observed.text, plain.text); assert.equal(observed.events, plain.events); assert.equal(called, 0);
        assert(!JSON.parse(plain.text).controller_result.details?.time);
        for (const r of [plain, observed]) assert(!fs.existsSync(path.join(r.f.cwd, '.gsd/forge/time')));
      }
    } finally { lease.acquire = acquire; }
  });
}

main().then(() => console.log(`PASS milestone-worker-observations: ${count} named checks; hermetic stub providers, no network`))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });
