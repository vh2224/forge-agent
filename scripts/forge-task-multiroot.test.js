'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-only' });
const lab = require('./forge-code-roots.test');
const roots = require('./forge-code-roots');
const prep = require('./forge-task-preparation');
const unit = require('./forge-unit-sidecar');
const gate = require('./forge-claim-gate');
const runs = require('./forge-runs');
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
async function scenario(vcs, moduleDir = __dirname) {
  const prep = require(path.join(moduleDir, 'forge-task-preparation'));
  const unit = require(path.join(moduleDir, 'forge-unit-sidecar'));
  const gate = require(path.join(moduleDir, 'forge-claim-gate'));
  const runs = require(path.join(moduleDir, 'forge-runs'));
  const roots = require(path.join(moduleDir, 'forge-code-roots'));
  const accounts = require(path.join(moduleDir, 'forge-accounts'));
  const priorLookup = accounts.resolveLaunch;
  const f = lab.fixture(vcs), id = 'T-20261015120000-multiroot', task = `.gsd/tasks/${id}/${id}`;
  f.contract = roots.validateContract({ ...f.contract, primary_root_id: 'x-alpha', code_roots: f.contract.code_roots.map((root, i) => ({ ...root, id: i ? 'alpha' : 'x-alpha' })) });
  const saved = { ...process.env };
  try {
    process.env.FORGE_HOME = path.join(f.dir, 'home');
    write(path.join(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc'), {});
    write(path.join(f.owner, '.gsd/forge-prefs.jsonc'), { tier_models: { standard: ['claude-sonnet-5'] }, effort: { 'execute-task': 'medium' } });
    const plan = lab.plan(f.contract).replace('id: T-roots', `id: ${id}`).replace('## Description\nChange both files.\n', '');
    const request = { schema_version: 1, scope: 'standalone-task', phase: 'plan', taskId: id, cwd: f.a, contextRoot: f.owner,
      hostRuntime: 'codex', workflowId: id, dispatchId: `${vcs}-plan`, resultFile: path.join(f.dir, 'plan-result.json'),
      execution_contract: f.contract, constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Edit both physical checkouts.' } };
    const prepared = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => ({ status: 'done', summary: 'Full plan', questions: [], artifacts: [{ path: `${task}-PLAN.md`, content: plan }] }) });
    assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
    const planFile = path.join(f.owner, `${task}-PLAN.md`);
    write(path.join(f.owner, `${task}-PLAN-GATE.md`), `---\nstatus: approved\nplan_sha256: ${roots.digest(plan)}\n---\n`);
    runs.add(f.owner, { id, kind: 'task', session_id: `fixture-${vcs}`, cwd: f.owner });
    const derived = gate.deriveClaimFromPlan(f.owner, planFile, f.contract);
    const held = gate.recordAndEvaluate({ cwd: f.owner, runId: id, codeDir: f.a, unit: `execute-task/${id}`,
      executionContract: f.contract, paths: derived.paths, derived, source: 'plan-writes', emitEvent: false });
    assert.strictEqual(held.decision, 'proceed', JSON.stringify(held));
    const claim = runs.get(f.owner, id).write_claim;
    assert.strictEqual(claim.paths.length, 2); assert.strictEqual(Object.keys(claim.root_baselines).length, 2);
    const preDirty = path.join(f.b, 'user.txt'); write(preDirty, 'user-owned\n');
    const provider = path.join(f.dir, 'fake-provider.js'), calls = path.join(f.dir, 'calls');
    write(provider, `const fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
      for(const dir of ${JSON.stringify([f.a, f.b])}) fs.writeFileSync(require('path').join(dir,'same.txt'),'after\\n');
      const result={status:'done',summary:'Both checkouts updated',must_haves_status:[],files_changed:[]};
      process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,modelUsage:{'claude-sonnet-5':{inputTokens:1}},
      result:['---GSD-WORKER-RESULT---','status: done','result_json: '+JSON.stringify(result),'---END-RESULT---'].join('\\n')}));`);
    process.env.FORGE_XLLM_CLAUDE_BIN = provider;
    accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-only' });
    const route = require(path.join(moduleDir, 'forge-dispatch-resolve')).resolveDispatch({ cwd: f.owner, unitType: 'execute-task', hostRuntime: 'codex', planPath: planFile, unitId: id });
    const command = `node -e "require('assert').strictEqual(require('fs').readFileSync('same.txt','utf8'),'after\\n')"`;
    const bindings = f.contract.code_roots.flatMap((root, index) => [
      { root_id: root.id, criterion: { kind: 'truth', index: 0 }, coverage: 'behavioral', source: { kind: 'verification', check_index: 0 } },
      { root_id: root.id, criterion: { kind: 'artifact', index }, coverage: 'structural', source: { kind: 'verification', check_index: 0 } },
    ]);
    const execute = { ...request, phase: 'execute', unitType: 'execute-task', dispatchId: `${vcs}-execute`, resultFile: path.join(f.dir, 'execute-result.json'),
      planFile, route, claim, runId: id, gates: { plan: 'approved', security: 'not-applicable', claim: 'proceed' },
      verification: { commandsByRoot: { 'x-alpha': [command], alpha: [command] }, bindings } };
    for (const [label, invalid] of [['missing', undefined], ['empty', { ...claim, paths: [] }], ['stale', { ...claim, generation: 'stale' }]]) {
      await assert.rejects(unit.runUnitSidecar({ ...execute, claim: invalid, dispatchId: `${vcs}-${label}`,
        resultFile: path.join(f.dir, `${label}.json`) }), /held-claim|generation-stale/);
      assert.strictEqual(fs.existsSync(calls), false, 'invalid claim refuses before provider');
    }
    for (const suffix of ['', '.receipt.json', '.reset-state.json']) {
      const inside = path.join(f.b, `result${suffix}`);
      await assert.rejects(unit.runUnitSidecar({ ...execute, resultFile: inside }), /result.*(?:root|inside|outside)|inside.*root/i);
      assert.strictEqual(fs.existsSync(inside), false);
      assert.strictEqual(fs.existsSync(calls), false);
    }
    // The verification command, rather than the worker, mutates protected
    // owner state after the writing response has already been accepted.
    const decisions = path.join(f.owner, '.gsd/DECISIONS.md'), once = path.join(f.dir, 'verification-once');
    const driftCommand = 'node -e ' + JSON.stringify(`const fs=require('fs');if(!fs.existsSync(${JSON.stringify(once)})){fs.writeFileSync(${JSON.stringify(once)},'once');fs.writeFileSync(${JSON.stringify(decisions)},'unproved verification drift');}`);
    execute.verification.commandsByRoot['x-alpha'] = [command + ' && ' + driftCommand];
    await assert.rejects(unit.runUnitSidecar(execute), /execution-protected-metadata/);
    assert.strictEqual(fs.existsSync(path.join(f.owner, `${task}-SUMMARY.md`)), false, 'verification drift blocks publication');
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'call\n');
    fs.unlinkSync(decisions);
    const events = path.join(f.owner, '.gsd/forge/events.jsonl'), validEvents = fs.readFileSync(events);
    const eventIdentity = fs.realpathSync.native(events);
    const read = fs.readFileSync;
    let raced = false;
    fs.readFileSync = function(file, ...args) {
      if (!raced && new Error().stack.includes('appendOwnedEvent') && typeof file === 'string' && fs.realpathSync.native(file) === eventIdentity) {
        raced = true; fs.appendFileSync(events, '{"event":"unsigned-race"}\n');
      }
      return read.call(this, file, ...args);
    };
    try { await assert.rejects(unit.runUnitSidecar(execute), /execution-owner-event-raced/); }
    finally { fs.readFileSync = read; }
    assert(raced, 'race occurs between owner validation and caller append');
    fs.writeFileSync(events, validEvents);
    const result = await unit.runUnitSidecar(execute);
    assert.strictEqual(result.status, 'done');
    assert.deepStrictEqual(result.files_changed.map(row => row.root_id).sort(), ['alpha', 'x-alpha']);
    assert.strictEqual(fs.readFileSync(preDirty, 'utf8'), 'user-owned\n');
    const delivery = JSON.parse(fs.readFileSync(path.join(f.owner, `${task}-DELIVERY.json`)));
    assert(delivery.criteria.every(row => row.status === 'verificado'), JSON.stringify(delivery.criteria));
    for (const root of f.contract.code_roots) {
      assert.strictEqual(fs.existsSync(path.join(root.path, '.gsd')), false, 'artifacts belong to external owner');
      const envelope = JSON.parse(fs.readFileSync(path.join(f.owner, `${task}-VERIFICATION-${root.id}-ENVELOPE.json`)));
      assert.strictEqual(envelope.root_identity_sha256, root.identity_sha256);
      assert.strictEqual(envelope.code_dir, root.path); assert.strictEqual(envelope.result.checks[0].exitCode, 0);
    }
    await unit.runUnitSidecar(execute);
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'call\n');
    write(decisions, 'unproved replay drift');
    await assert.rejects(unit.runUnitSidecar(execute), /execution-protected-metadata/);
    fs.unlinkSync(decisions);
    await unit.runUnitSidecar(execute);
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'call\n');
    write(path.join(f.b, 'same.txt'), 'concurrent\n');
    await assert.rejects(unit.runUnitSidecar(execute), /execution-replay-code-changed/);
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'call\n');
    console.log(`PASS ${vcs}: external owner, two same-basename physical roots, preparation/plan/claims/real fake process/verification/delivery/idempotent replay/drift`);
    f.cleanup();
  } finally {
    accounts.resolveLaunch = priorLookup;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
async function main() { try { await scenario('git'); await scenario('svn'); } finally { accounts.resolveLaunch = originalLookup; } }
module.exports = { scenario };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
