'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
// Install the fixture account lookup before consumers capture it at module load.
const harness = require('./fixtures/forge-native-execution').createFixtureHarness();
const unit = require('./forge-unit-sidecar');
const prep = require('./forge-task-preparation');
const verify = require('./forge-verify');
const roots = require('./forge-code-roots');
const { nativeFixture, write } = harness;
const wire = value => JSON.parse(JSON.stringify(value));
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
function pristine(f) {
  assert.strictEqual(f.calls(), 0);
  assert(!fs.existsSync(f.r.resultFile + '.receipt.json'));
  assert(!fs.existsSync(f.r.resultFile + '.reset-state.json'));
  assert(!fs.existsSync(f.r.nativePromptFile));
  assert(!fs.existsSync(f.control.calls));
  assert.strictEqual(fs.readFileSync(path.join(f.cwd, 'src.js'), 'utf8'), 'before\n');
}
async function main() {
  await test('producer accepted prose-only plan refuses after final roundtrip before claim or provider', async () => {
    const f = nativeFixture({ defaultVerification: false });
    const plan = fs.readFileSync(f.r.planFile, 'utf8').replace('## Description\nChange both files.\n', '');
    write(f.r.planFile, plan);
    assert.strictEqual(prep.validatePhaseContent('plan', f.r.taskId, plan), true);
    const request = wire(f.r);
    assert.throws(() => unit.validateRecoveryRequest(request, { nativeInvocation: request.nativeInvocation }),
      { code: 'verification-root-unverified', provider_called: false });
    delete request.claim;
    assert.throws(() => unit.validateRecoveryRequest(request, { nativeInvocation: request.nativeInvocation }),
      { code: 'verification-root-unverified', provider_called: false });
    await assert.rejects(unit.runUnitSidecar(request, f.runtime), { code: 'verification-root-unverified', provider_called: false });
    pristine(f);
  });
  await test('serialized malformed commands roots timeout and bindings fail in actual consumer', async () => {
    const f = nativeFixture({ defaultVerification: false });
    for (const [verification, code] of [
      [null, 'verification-options-invalid'], [{ preferenceCommands: 'node --version' }, 'verification-commands-invalid'],
      [{ preferenceCommands: [''] }, 'verification-commands-invalid'],
      [{ preferenceCommands: ['node --version; echo unsafe'] }, 'verification-commands-invalid'],
      [{ commandsByRoot: { foreign: ['node --version'] } }, 'verification-root-unknown'],
      [{ commandTimeoutMs: 0 }, 'verification-timeout-invalid'], [{ bindings: {} }, 'verification-bindings-invalid'],
    ]) {
      const r = wire({ ...f.r, verification });
      assert.throws(() => unit.preflightExecutionVerification(r), { code, provider_called: false });
      await assert.rejects(unit.runUnitSidecar(r, f.runtime), { code, provider_called: false });
    }
    pristine(f);
  });
  await test('encoding scalar and list forms use real parser; unsupported blocks do not become commands', () => {
    const f = nativeFixture({ defaultVerification: false });
    const plan = fs.readFileSync(f.r.planFile, 'utf8');
    for (const field of ['verify: node --version', 'verify: [node --version, npm test]', 'verify:\n  - node --version\n  - npm test']) {
      for (const encoding of ['lf', 'bom-crlf']) {
        let text = plan.replace('depends: []', field + '\ndepends: []');
        if (encoding === 'bom-crlf') text = '\uFEFF' + text.replace(/\n/g, '\r\n');
        write(f.r.planFile, text);
        const policy = unit.preflightExecutionVerification(wire(f.r));
        const expected = verify.normalizeExecutionVerification(f.r.execution_contract, text);
        assert.deepStrictEqual(policy, expected);
        assert(policy.roots[0].commands.includes('node --version'));
      }
    }
    write(f.r.planFile, plan.replace('depends: []', 'verify: |\n  node --version\ndepends: []'));
    assert.throws(() => unit.preflightExecutionVerification(wire(f.r)), { code: 'verification-root-unverified' });
    pristine(f);
  });
  await test('runtime supplements remain separate across serialization and preserve provenance', () => {
    const f = nativeFixture({ defaultVerification: false });
    const request = wire({ ...f.r, verification: { preferenceCommands: ['node --version'], commandTimeoutMs: 9000, bindings: [] } });
    const runtime = wire({ preferenceCommands: ['node --version', 'npm test'], commandTimeoutMs: 9000 });
    const identity = { dispatch_id: request.dispatchId };
    const policy = unit.preflightExecutionVerification(request, { verification: runtime, identity });
    assert.deepStrictEqual(policy.roots[0].configuration_sources, ['request.preferenceCommands', 'runtime.preferenceCommands']);
    assert.strictEqual(policy.timeout_origin, 'request');
    assert.deepStrictEqual(policy, unit.preflightExecutionVerification(wire(request), wire({ verification: runtime, identity })));
    assert.notStrictEqual(policy.sha256, unit.preflightExecutionVerification(request, { identity }).sha256);
    assert.throws(() => unit.preflightExecutionVerification(request, { verification: { preferenceCommands: ['npm test'] } }), { code: 'verification-command-replacement' });
    assert.throws(() => unit.preflightExecutionVerification(request, { verification: { commandTimeoutMs: 8000 } }), { code: 'verification-timeout-replacement' });
    assert.throws(() => unit.preflightExecutionVerification(request, { verification: { bindings: [] } }), { code: 'verification-options-invalid' });
    const supplemented = wire(f.r);
    const checked = unit.validateRecoveryRequest(supplemented, { nativeInvocation: supplemented.nativeInvocation, verification: runtime });
    assert(checked.contract);
    pristine(f);
  });
  await test('discovery and legacy shell command grammar remain valid without permissions opt-in', () => {
    const f = nativeFixture({ defaultVerification: false });
    write(path.join(f.cwd, 'package.json'), { scripts: { test: 'node check.js' } });
    const policy = unit.preflightExecutionVerification(wire(f.r));
    assert.deepStrictEqual(policy.roots[0].commands, ['npm run test']);
    assert.deepStrictEqual(policy.roots[0].configuration_sources, ['package-json']);
    const alias = path.join(f.dir, 'owner-alias');
    fs.symlinkSync(f.owner, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliased = wire({ ...f.r, planFile: path.join(alias, '.gsd/tasks', f.r.taskId, `${f.r.taskId}-PLAN.md`) });
    assert.deepStrictEqual(unit.preflightExecutionVerification(aliased), policy);
    const declared = unit.preflightExecutionVerification(wire({ ...f.r, verification: { preferenceCommands: ['npm test && node --version'] } }));
    assert.deepStrictEqual(declared.roots[0].commands, ['npm test && node --version']);
    pristine(f);
  });
  await test('every physical root needs discovery or an explicit supplement', () => {
    const f = nativeFixture({ defaultVerification: false }), second = harness.setup();
    const contract = roots.validateContract({ schema_version: 2, owner: f.owner, primary_root_id: 'app',
      code_roots: [{ id: 'app', path: f.cwd }, { id: 'other', path: second.cwd }] });
    const r = wire({ ...f.r, execution_contract: contract, verification: { commandsByRoot: { app: ['node --version'] } } });
    assert.throws(() => unit.preflightExecutionVerification(r), { code: 'verification-root-unverified' });
    const policy = unit.preflightExecutionVerification(r, { verification: { commandsByRoot: { other: ['npm test'] } } });
    assert.deepStrictEqual(policy.roots.map(row => row.commands), [['node --version'], ['npm test']]);
    pristine(f);
  });
  await test('milestone canonical and legacy plan paths use same preflight before claim', async () => {
    const f = nativeFixture({ defaultVerification: false });
    const r = wire({ ...f.r, scope: 'milestone', milestoneId: 'M-20261025000000-fixture', sliceId: 'S01', taskId: 'T01' });
    const dir = path.join(f.owner, '.gsd/milestones', r.milestoneId, 'slices', r.sliceId, 'tasks');
    const plan = fs.readFileSync(f.r.planFile, 'utf8');
    for (const file of [path.join(dir, 'T01-PLAN.md'), path.join(dir, 'T01/T01-PLAN.md')]) {
      r.planFile = file; write(file, plan);
      assert.throws(() => unit.validateRecoveryRequest(wire(r)), { code: 'verification-root-unverified', provider_called: false });
      const route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: r.unitType,
        milestoneId: r.milestoneId, unitId: r.taskId, planPath: file, hostRuntime: 'claude' });
      assert.strictEqual(route.worker_mode, 'sidecar');
      await assert.rejects(unit.runUnitSidecar(wire({ ...r, route })), { code: 'verification-root-unverified', provider_called: false });
      write(file, plan.replace('depends: []', 'verify: node --version\ndepends: []'));
      assert.deepStrictEqual(unit.preflightExecutionVerification(wire(r)).roots[0].commands, ['node --version']);
      fs.unlinkSync(file);
    }
    pristine(f);
  });
  await test('sidecar new contracted requests refuse empty policy without opt-in before provider', async () => {
    const f = nativeFixture({ defaultVerification: false });
    const sidecar = harness.setup();
    const r = wire({ ...f.r, route: sidecar.r.route });
    await assert.rejects(unit.runUnitSidecar(r, {}), { code: 'verification-root-unverified', provider_called: false });
    pristine(f);
  });
  await test('valid final requests dispatch native and sidecar with plan-derived seals', async () => {
    for (const mode of ['native', 'sidecar']) {
      const f = nativeFixture({ defaultVerification: false, verify: 'node --version' });
      if (mode === 'sidecar') f.r.route = harness.setup().r.route;
      const result = await unit.runUnitSidecar(wire(f.r), mode === 'native' ? f.runtime : {});
      assert.strictEqual(result.status, 'done');
      const record = JSON.parse(fs.readFileSync(f.r.resultFile + '.receipt.json', 'utf8'));
      assert.strictEqual(record.phase, 'ready');
      assert.deepStrictEqual(record.verification_seal.roots[0].commands, ['node --version']);
      assert.deepStrictEqual(record.verification_seal.roots[0].configuration_sources, ['task-plan']);
      assert.strictEqual(record.verification_seal.identity.dispatch_id, f.r.dispatchId);
      assert.strictEqual(f.calls(), mode === 'native' ? 1 : 0);
      if (mode === 'sidecar') assert(fs.existsSync(f.control.calls));
    }
  });
}
main().then(() => { harness.close(failed === 0); console.log(`${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; });
