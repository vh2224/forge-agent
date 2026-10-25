'use strict';
// Strict consumers (calibration store, xllm-state, recovery, receipt readers)
// must accept the progress payload with and without the additive liveness block.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const calibration = require('./forge-sidecar-calibration');
const stateApi = require('./forge-xllm-state');
const recovery = require('./forge-attempt-recovery');
const diagnostic = require('./forge-recovery-diagnostic');
const { observation } = require('./forge-sidecar-diagnostic');

const SENTINEL = 'sentinel-liveness-secret-xyz';
const beat = { version: 1, state: 'slow-suspect', since_ms: 120025, reason: 'silence' };
const withBlock = () => observation({ liveness: beat });
const withoutBlock = () => observation({});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-liveness-heartbeat-'));
const route = { unit_type: 'research-milestone', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_mode: 'sidecar',
  model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard', dispatch_allowed: true };
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

try {
  check('calibration store stays valid and gains no liveness key', () => {
    const userHome = fs.realpathSync(fs.mkdtempSync(path.join(root, 'home-')));
    const options = { userHome };
    const id = { model: 'claude-fixture', effort: 'high', phase: 'execute' };
    const binding = { receipt: 'r', fingerprint: 'f' };
    const keys = ['version', 'key', 'identity', 'attempt_sha256', 'initial_ms', 'gap_ms', 'source'];
    for (const snapshot of [{ initial_sample_ms: 100, gap_sample_ms: 200, liveness: beat, observation: withBlock() },
      { initial_sample_ms: 110, gap_sample_ms: 210 }]) {
      const proposal = calibration.propose(id, snapshot);
      assert.deepStrictEqual(Object.keys(proposal), keys);
      assert(calibration.commit(proposal, binding, options).committed);
    }
    const record = calibration.read(id, options);
    assert.strictEqual(record.diagnostic, null);
    assert.strictEqual(record.initial.count, 2);
    const file = path.join(calibration.directory(options), 'calibration.json');
    assert(!fs.readFileSync(file, 'utf8').includes('liveness'));
  });

  const stateBase = () => recovery.createRecovery({ unit: 'research-milestone/M001', roots_sha256: 'roots', clock: () => 1000 });
  const attempt = observation => ({ reason_code: 'quota', layer: 'provider', request_sha256: 'q', context_sha256: 'c',
    request_bytes: 1, context_bytes: 1, duration_ms: 1, budgets: { total: 1 }, route, failure_class: 'service',
    service_failure_proven: true, ...(observation === undefined ? {} : { observation }) });

  check('xllm-state saveRecovery/loadRecovery accept attempts with and without the block', () => {
    for (const obs of [withBlock(), withoutBlock()]) {
      const r = stateBase(); r.record(attempt(obs));
      const file = path.join(root, `state-${Math.random().toString(36).slice(2)}.json`);
      stateApi.saveRecovery(file, r.snapshot());
      const loaded = stateApi.loadRecovery(file);
      assert.strictEqual(loaded.schema_version, 2);
      assert.strictEqual(loaded.attempts.length, 1);
    }
  });

  check('recovery.record preserves the normalized block and never invents it', () => {
    const a = stateBase(); a.record(attempt({ liveness: { ...beat, note: SENTINEL, extra: SENTINEL } }));
    const kept = a.inspect().attempts.at(-1).observation;
    assert.deepStrictEqual(kept.liveness, beat);
    assert(!JSON.stringify(kept).includes(SENTINEL));
    const b = stateBase(); b.record(attempt(withoutBlock()));
    assert(!Object.hasOwn(b.inspect().attempts.at(-1).observation, 'liveness'));
    const c = stateBase(); c.record(attempt({ liveness: { version: 1, state: 'bogus' } }));
    assert(!Object.hasOwn(c.inspect().attempts.at(-1).observation, 'liveness'));
  });

  check('captureFailure keeps error.diagnostic.observation.liveness only when present', () => {
    const cwd = path.join(root, 'code'); fs.mkdirSync(cwd, { recursive: true });
    const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
      milestoneId: 'M001', route, prompt: 'p', resultFile: path.join(root, 'result.json') };
    const run = (name, obs) => recovery.captureFailure({ stateFile: path.join(root, name), request, unit: 'research-milestone/M001', route,
      finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: 'p' }),
      error: { code: 'budget-exceeded-while-active', provider_called: true, diagnostic: { observation: obs } },
      budgets: { coding_standards: 3000 } }).attempts.at(-1);
    const on = run('on.json', { liveness: { ...beat, state: 'working', termination: 'budget-exceeded-while-active', extra: SENTINEL } });
    assert.strictEqual(on.observation.liveness.termination, 'budget-exceeded-while-active');
    assert(!JSON.stringify(on).includes(SENTINEL));
    const off = run('off.json', undefined);
    assert(!off.observation || !Object.hasOwn(off.observation, 'liveness'));
    assert.strictEqual(on.failure_class, off.failure_class);
  });

  check('inspectReceipt and inspectAttemptRecovery give the same verdict with and without the block', () => {
    const verdicts = [];
    for (const [name, obs] of [['on', withBlock()], ['off', withoutBlock()]]) {
      const receiptFile = path.join(root, `receipt-${name}.json`), stateFile = path.join(root, `attempt-${name}.json`);
      fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', failure: { provider_called: 'unknown' }, telemetry: { observation: obs } }));
      const r = stateBase(); r.record(attempt(obs));
      fs.writeFileSync(stateFile, JSON.stringify(r.snapshot()));
      const before = fs.readFileSync(stateFile);
      const receipt = recovery.inspectReceipt(receiptFile);
      const shown = diagnostic.inspectAttemptRecovery(stateFile, receiptFile);
      assert.deepStrictEqual(fs.readFileSync(stateFile), before);
      assert(!JSON.stringify(shown).includes(SENTINEL));
      verdicts.push({ stopped: receipt.process_stopped, valid: receipt.valid_saved_response, writer: receipt.writer_possible,
        shown: shown.inspection.process_stopped, next: shown.next_action, attempts: shown.attempts.length, phase: shown.phase });
    }
    assert.deepStrictEqual(verdicts[0], verdicts[1]);
  });

  check('the block does not leak a sentinel through any strict consumer output', () => {
    const r = stateBase(); r.record(attempt({ liveness: { ...beat, session: SENTINEL, argv: [SENTINEL] } }));
    assert(!JSON.stringify(r.snapshot()).includes(SENTINEL));
  });
  check('observation without the block stays byte-identical and strict readers round-trip it', () => {
    const plain = withoutBlock();
    assert(!Object.hasOwn(plain, 'liveness'));
    assert.strictEqual(JSON.stringify(observation(plain)), JSON.stringify(plain));
    const full = withBlock();
    assert.deepStrictEqual(observation(full), full);
    assert.deepStrictEqual(Object.keys(full).filter(key => key !== 'liveness'), Object.keys(plain));
    const r = stateBase(); r.record(attempt(full));
    assert.deepStrictEqual(r.inspect().attempts.at(-1).observation, full);
  });

  console.log(`${passed} liveness heartbeat compatibility tests passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
