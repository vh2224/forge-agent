'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const roots = require('./forge-code-roots');
const verify = require('./forge-verify');
const permissions = require('./forge-claude-permissions');
const session = require('./forge-claude-session');
const lab = require('./forge-code-roots.test').fixture();
const contract = roots.singleContract(lab.owner, lab.a);
const identity = { dispatch_id: 'fixture-226', fingerprint: 'a'.repeat(64), recovery_identity_sha256: 'b'.repeat(64) };
const commands = ['node --check scripts/main.js', 'node --check scripts/main.test.js',
  'node scripts/main.test.js', 'node scripts/publish.test.js', 'node scripts/gate.test.js'];
function make(list = commands) {
  const seal = verify.normalizeExecutionVerification(contract, '', { preferenceCommands: list }, {}, identity);
  return permissions.createPolicy({ seal, contract, identity, cwd: lab.a });
}
const clone = value => JSON.parse(JSON.stringify(value));
test('canonical discovery seal yields exact individual rules and bound request/root identity', () => {
  const policy = make();
  assert.deepStrictEqual(policy.rules, commands.map(c => `Bash(${c})`));
  assert.strictEqual(permissions.validatePolicy(policy, { cwd: lab.a, identity }).sha256, policy.sha256);
  for (const mutate of [p => p.rules.push('Bash'), p => p.seal.roots[0].commands[0] += ' --extra',
    p => p.identity.dispatch_id = 'foreign', p => p.contract.code_roots[0].path = lab.b]) {
    const changed = clone(policy); mutate(changed);
    assert.throws(() => permissions.validatePolicy(changed, { cwd: lab.a, identity }), /claude-permission/);
  }
  assert.throws(() => permissions.validatePolicy(policy, { cwd: lab.b, identity }), /claude-permission/);
  assert.throws(() => permissions.validatePolicy(policy, { cwd: lab.a, identity, readOnly: true }), /claude-permission/);
  assert.strictEqual(permissions.validatePolicy(null, { cwd: lab.a }), null);
});
test('operators, glob/prefix rules, quoted/absolute/Windows paths, traversal and unsupported commands fail closed', () => {
  for (const command of ['node scripts/a.js && node scripts/b.js', 'node scripts/a.js;echo x',
    'node scripts/*.js', 'node scripts/a.js:*', 'node "scripts/a b.js"', 'node C:/repo/a.js',
    'node scripts\\a.js', 'node ../a.js', 'node .gsd/a.js', 'node scripts/../a.js',
    'node scripts/a.js\nnode scripts/b.js', 'node scripts/a.js > out', 'node $(echo a.js)',
    'node --eval code', 'npm test', 'bash script.sh', 'node  scripts/a.js', 'node scripts/a.js --flag']) {
    assert.throws(() => make([command]), undefined, command);
  }
});
test('link ancestors are refused, including Windows junctions', () => {
  const link = path.join(lab.a, 'linked');
  fs.symlinkSync(lab.b, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => make(['node linked/test.js']), /claude-permission/); }
  finally { fs.unlinkSync(link); }
});
test('session refs retain legacy shape and validate optional permission digest', () => {
  const legacy = session.createSessionRef({ id: session.newSessionId(), accountName: 'fixture', configDir: lab.dir, cwd: lab.a });
  assert.strictEqual(Object.hasOwn(legacy, 'permission_policy_sha256'), false);
  assert(session.validateSessionRef(legacy).ok);
  const bound = session.createSessionRef({ id: legacy.id, accountName: 'fixture', configDir: lab.dir,
    cwd: lab.a, permissionPolicySha256: make().sha256 });
  assert(session.validateSessionRef(bound).ok);
  assert(!session.validateSessionRef({ ...bound, permission_policy_sha256: '*' }).ok);
});

// Only the provider executable/account are fixtures. Actual adapter packaging,
// stream parser and schema remain in use; argv is not a CLI authorization proof.
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const records = [];
const accounts = require('./forge-accounts');
const originalLaunch = accounts.resolveLaunch;
accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-token' });
childProcess.spawn = (cmd, args, options) => { records.push({ cmd, args, options }); return realSpawn(cmd, args, options); };
delete require.cache[require.resolve('./forge-claude-sidecar')];
const adapter = require('./forge-claude-sidecar');
accounts.resolveLaunch = originalLaunch;
childProcess.spawn = realSpawn;
const executable = path.join(lab.dir, 'fixture-cli.js');
fs.writeFileSync(executable, `const args=process.argv.slice(2);const get=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
const id=get('--session-id')||get('--resume');
if(args.includes('--session-id')||args.includes('--resume'))console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,
structured_output:{status:'done',summary:'fixture',must_haves_status:[],files_changed:[]},
modelUsage:{[get('--model')]:{inputTokens:1,outputTokens:1}},usage:{input_tokens:1,output_tokens:1}}));`);
function options(extra = {}) {
  return { cwd: lab.a, prompt: 'fixture', model: 'claude-sonnet-5', effort: 'medium', timeoutMs: 10000,
    sourceEnv: { ...process.env, FORGE_XLLM_CLAUDE_BIN: executable },
    probeRunner: () => ({ status: 0, stdout: '2.1.310 (Claude Code)' }),
    calibrationOptions: { disabled: true }, permissionPolicy: make(), permissionIdentity: identity,
    sessionRemover: () => ({ ok: true }), ...extra };
}
test('final argv preserves acceptEdits/settings and uses each exact rule as one argument', async () => {
  records.length = 0;
  const output = await adapter.invokeClaudeSidecar(options());
  assert.strictEqual(records.length, 1);
  const { args, options: spawnOptions } = records[0];
  assert.strictEqual(spawnOptions.shell, false);
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.deepStrictEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('-p')), commands.map(c => `Bash(${c})`));
  assert(!args.includes('--dangerously-skip-permissions'));
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '');
  assert.deepStrictEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, switchModelsOnFlag: false });
  assert.strictEqual(output.telemetry.permission_policy_sha256, make().sha256);
  assert.strictEqual(output.telemetry.managed_permission_policy, 'unknown');
});
test('invalid policy, foreign identity and unverified CLI refuse without inference spawn', async () => {
  for (const change of [{ permissionPolicy: {} }, { permissionIdentity: { ...identity, dispatch_id: 'other' } },
    { readOnly: true }, { probeRunner: () => ({ status: 1 }) }]) {
    records.length = 0;
    await assert.rejects(adapter.invokeClaudeSidecar(options(change)), error => error.provider_called === false && /^claude-permission-/.test(error.code));
    assert.strictEqual(records.length, 0);
  }
});
test('resume uses the identical policy; legacy/new/different policies cannot be substituted', async () => {
  const base = options();
  const env = adapter.buildClaudeSidecarEnv({ name: 'fixture', token: 'fixture-token' }, base.sourceEnv, process.platform);
  const legacy = session.createSessionRef({ id: session.newSessionId(), accountName: 'fixture',
    configDir: session.configDir(env, process.platform), cwd: lab.a });
  const bound = { ...legacy, permission_policy_sha256: base.permissionPolicy.session_sha256 };
  records.length = 0;
  await adapter.invokeClaudeSidecar(options({ session: { resume: bound } }));
  assert(records[0].args.includes('--resume'));
  assert.deepStrictEqual(records[0].args.slice(records[0].args.indexOf('--allowedTools') + 1, records[0].args.indexOf('-p')), base.permissionPolicy.rules);
  const nextIdentity = { ...identity, dispatch_id: 'next-dispatch', fingerprint: 'c'.repeat(64) };
  const nextSeal = verify.normalizeExecutionVerification(contract, '', { preferenceCommands: commands }, {}, nextIdentity);
  const nextPolicy = permissions.createPolicy({ seal: nextSeal, contract, identity: nextIdentity, cwd: lab.a });
  assert.notStrictEqual(nextPolicy.sha256, base.permissionPolicy.sha256);
  assert.strictEqual(nextPolicy.session_sha256, base.permissionPolicy.session_sha256);
  await adapter.invokeClaudeSidecar(options({ session: { resume: bound }, permissionPolicy: nextPolicy, permissionIdentity: nextIdentity }));
  for (const alter of [s => s.plan_sha256 = 'd'.repeat(64),
    s => s.roots[0].origins[0] = 'other-origin', s => s.command_timeout_ms += 1000]) {
    const seal = clone(nextSeal); alter(seal);
    delete seal.sha256; seal.sha256 = roots.digest(seal);
    const changed = permissions.createPolicy({ seal, contract, identity: nextIdentity, cwd: lab.a });
    records.length = 0;
    await assert.rejects(adapter.invokeClaudeSidecar(options({ session: { resume: bound }, permissionPolicy: changed, permissionIdentity: nextIdentity })),
      error => error.code === 'claude-permission-resume-mismatch' && error.provider_called === false);
    assert.strictEqual(records.length, 0);
  }
  for (const extra of [{ session: { resume: legacy } }, { session: { resume: bound }, permissionPolicy: null },
    { session: { resume: bound }, permissionPolicy: make(['node scripts/other.js']) }]) {
    records.length = 0;
    await assert.rejects(adapter.invokeClaudeSidecar(options(extra)), error => error.code === 'claude-permission-resume-mismatch' && error.provider_called === false);
    assert.strictEqual(records.length, 0);
  }
});
test('canonical unit owner seals opt-in commands through xllm to final argv; unsupported input never spawns', async () => {
  const fixtures = require('./forge-code-roots.test'), runs = require('./forge-runs');
  const unitLab = fixtures.fixture(), unitContract = roots.singleContract(unitLab.owner, unitLab.a);
  const realInvoke = adapter.invokeClaudeSidecar, previousBin = process.env.FORGE_XLLM_CLAUDE_BIN;
  const previousEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FORGE_HOME'].map(k => [k, process.env[k]]));
  process.env.HOME = process.env.USERPROFILE = unitLab.dir;
  process.env.CODEX_HOME = path.join(unitLab.dir, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(unitLab.dir, '.claude');
  process.env.FORGE_HOME = path.resolve(__dirname, '..');
  const handed = [];
  adapter.invokeClaudeSidecar = opts => {
    handed.push(opts);
    return realInvoke({ ...opts, probeRunner: () => ({ status: 0, stdout: '2.1.310 (Claude Code)' }),
      sessionRemover: () => ({ ok: true }) });
  };
  const unit = require('./forge-unit-sidecar');
  const base = path.join(unitLab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  const planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  fs.writeFileSync(planFile, fixtures.plan(unitContract));
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** fixture\n');
  fs.writeFileSync(path.join(unitLab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models:
    Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])) }));
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: unitLab.a, contextRoot: unitLab.owner, execution_contract: unitContract, planFile,
    workflowId: 'permissions-fixture', dispatchId: 'permissions-fixture', resultFile: path.join(unitLab.dir, 'result.json'),
    prompt: 'Fixture only.', verification: { preferenceCommands: commands }, claudePermissions: 'verification' };
  try {
    process.env.FORGE_XLLM_CLAUDE_BIN = executable;
    request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot,
      unitType: request.unitType, milestoneId: request.milestoneId, unitId: request.taskId,
      planPath: request.planFile, hostRuntime: 'codex' });
    request.runId = 'permissions-fixture';
    request.claim = { schema_version: 2, generation: require('crypto').randomUUID(), execution_contract: unitContract,
      paths: [{ root_id: 'primary', path: 'same.txt' }] };
    request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
    runs.add(unitLab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
    records.length = 0;
    // The fixture deliberately does not satisfy the task outputs. It proves
    // packaging, not publication or provider tool authorization.
    try { await unit.runUnitSidecar(request); } catch (error) {
      assert(handed.length > 0, error.stack);
    }
    assert.strictEqual(handed.length, 1);
    assert.deepStrictEqual(handed[0].permissionPolicy.rules, commands.map(c => `Bash(${c})`));
    assert.strictEqual(handed[0].permissionPolicy.seal.identity.fingerprint, handed[0].permissionIdentity.fingerprint);
    assert.strictEqual(records.length, 1);
    const args = records[0].args;
    assert.deepStrictEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('-p')), commands.map(c => `Bash(${c})`));
    const bad = { ...request, dispatchId: 'unsupported', resultFile: path.join(unitLab.dir, 'unsupported.json'),
      verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
    records.length = 0;
    await assert.rejects(unit.runUnitSidecar(bad), error => error.code === 'claude-permission-command-unsupported');
    assert.strictEqual(records.length, 0);
  } finally {
    adapter.invokeClaudeSidecar = realInvoke;
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (previousBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = previousBin;
    fs.rmSync(unitLab.dir, { recursive: true, force: true });
  }
});
after(() => fs.rmSync(lab.dir, { recursive: true, force: true }));
