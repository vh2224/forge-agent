#!/usr/bin/env node
'use strict';
// Only the external Claude process/account are simulated. Resolver, CLI adapter,
// VCS safety, delivery validation, publication and replay run production code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const base = path.resolve(__dirname, '../Temp/codex/standalone-execute/labs');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'test-'));
const saved = { ...process.env };
process.env.TEMP = root; process.env.TMP = root; process.env.TMPDIR = root;
process.env.GIT_CEILING_DIRECTORIES = root;
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
process.env.FORGE_HOME = path.join(root, 'home');
write(path.join(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc'), {});
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-only' });
const unit = require('./forge-unit-sidecar');
const execution = require('./forge-task-execution');
const delivery = require('./forge-delivery');
const { capability } = require('./forge-transport-capabilities');
const { resolveDispatch } = require('./forge-dispatch-resolve');
const provider = path.join(root, 'provider.js');
write(provider, `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), control = JSON.parse(fs.readFileSync(path.join(process.cwd(), '../control.json')));
fs.appendFileSync(control.calls, 'spawn\\n');
fs.writeFileSync(control.args, JSON.stringify(args));
const instruction = args.find(a => a.startsWith('Read the complete task prompt'));
fs.writeFileSync(control.prompt, fs.readFileSync(JSON.parse(instruction.match(/file: (".*")\\. Follow/)[1]), 'utf8'));
for (const [file, content] of Object.entries(control.writes || {})) fs.writeFileSync(file, content);
if (control.failure) { process.stderr.write('simulated transport failure after writes'); process.exit(9); }
const result = { status: control.status || 'done', summary: 'Fixture execution', must_haves_status: [], files_changed: [] };
if (control.extraArtifact) result.artifacts = [{ path: '../outside.md', content: 'invalid' }];
const model = args[args.indexOf('--model') + 1];
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
 result: ['---GSD-WORKER-RESULT---','status: '+result.status,'result_json: '+JSON.stringify(result),'---END-RESULT---'].join('\\n'),
 modelUsage: { [model]: { inputTokens: 123 } } }));
`);
process.env.FORGE_XLLM_CLAUDE_BIN = provider;
let sequence = 0;
const id = 'T-20261008120000-fixture';
function git(cwd, args) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim();
}
function setup(vcsName = 'git') {
  const dir = path.join(root, String(++sequence)), cwd = path.join(dir, 'code'), owner = path.join(dir, 'owner');
  fs.mkdirSync(cwd, { recursive: true });
  const task = path.join(owner, '.gsd/tasks', id), planFile = path.join(task, `${id}-PLAN.md`);
  write(path.join(owner, '.gsd/forge-prefs.jsonc'), { routing: { frontend: { executor: { heavy: ['claude-opus-5-5', 'gpt-6.1-sol'] } } }, effort: { 'execute-task': 'high' }, token_budget: { coding_standards: 32 } });
  write(planFile, `---\ntier: heavy\ndomain: frontend\ncapability: workspace\nwrites:\n  - '${path.join(cwd, 'src.js').replace(/\\/g, '/')}'\nmust_haves:\n  truths:\n    - "fixture stays observable"\n  artifacts: []\n  key_links: []\nexpected_output: []\n---\n# Task\nImplement fixture.\n`);
  write(path.join(task, `${id}-PLAN-GATE.md`), '---\nstatus: approved\n---\n');
  write(path.join(task, `${id}-RESEARCH.md`), 'Research retained\n' + 'evidence '.repeat(2400) + '\nRESEARCH_END');
  write(path.join(task, `${id}-SECURITY.md`), 'Mandatory security checklist');
  write(path.join(owner, '.gsd/CODING-STANDARDS.md'), 'standards '.repeat(1000));
  write(path.join(cwd, 'src.js'), 'before\n'); write(path.join(cwd, 'dirty.txt'), 'before\n');
  if (vcsName === 'svn') {
    const repository = path.join(dir, 'svn-repository');
    function svn(cmd, args) { const out = cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }); assert.strictEqual(out.status, 0, out.stderr); }
    svn('svnadmin', ['create', repository]);
    svn('svn', ['checkout', require('url').pathToFileURL(repository).href, '.']);
    svn('svn', ['add', 'src.js', 'dirty.txt']); svn('svn', ['commit', '-m', 'fixture baseline']); svn('svn', ['update']);
  } else {
    git(cwd, ['init', '-q']); git(cwd, ['add', '.']);
    git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  }
  write(path.join(cwd, 'dirty.txt'), 'user dirty\n');
  const route = resolveDispatch({ cwd: owner, unitType: 'execute-task', scope: 'standalone-task', phase: 'execute', planPath: planFile, hostRuntime: 'codex', unitId: id });
  const r = { cwd, contextRoot: owner, scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: id,
    planFile, route, workflowId: id, dispatchId: `attempt-${sequence}`, resultFile: path.join(dir, 'result.json'),
    gates: { plan: 'approved', security: 'passed', claim: 'proceed' }, constraints: { auto_commit: false, deploy: false } };
  const control = { calls: path.join(dir, 'calls.txt'), args: path.join(dir, 'args.json'), prompt: path.join(dir, 'prompt.txt'), writes: { [path.join(cwd, 'src.js')]: 'after\n' } };
  const controlFile = path.join(dir, 'control.json'); write(controlFile, control);
  return { r, task, dir, control, controlFile, owner, cwd };
}
async function rejects(r, code) { await assert.rejects(() => unit.runUnitSidecar(r), e => { assert.strictEqual(e.code, code, e.stack); return true; }); }
async function main() {
  assert(capability('claude', 'execute-task', { scope: 'standalone-task', phase: 'execute' }).supported);
  assert(!capability('claude', 'execute-task', { scope: 'standalone-task', phase: 'plan' }).supported);
  for (const change of [{ phase: 'plan' }, { phase: undefined }, { milestoneId: 'M001' }, { sliceId: 'S01' }, { taskId: '../bad' }]) {
    assert.throws(() => unit.locations({ scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: id, ...change }));
  }
  assert.throws(() => unit.locations({ unitType: 'execute-task', taskId: id }), /invalid-milestone/);
  const f = setup();
  assert.strictEqual(f.r.route.model, 'claude-opus-5-5'); assert.strictEqual(f.r.route.effort, 'high');
  assert.strictEqual(f.r.route.resolved_worker_engine, 'claude');
  const result = await unit.runUnitSidecar(f.r);
  assert.strictEqual(result.status, 'done');
  assert.deepStrictEqual(result.files_changed.map(x => x.path), ['src.js']);
  assert.strictEqual(fs.readFileSync(path.join(f.cwd, 'dirty.txt'), 'utf8'), 'user dirty\n');
  const loc = unit.locations(f.r);
  for (const file of loc.required) assert(fs.existsSync(path.join(f.owner, file)), file);
  assert(!fs.existsSync(path.join(f.owner, '.gsd/milestones')));
  const output = JSON.parse(fs.readFileSync(path.join(f.owner, loc.delivery.output)));
  assert.deepStrictEqual(output.unit, { type: 'task', id });
  assert(output.criteria.every(c => c.status !== 'verificado'), 'no fabricated verification');
  const args = JSON.parse(fs.readFileSync(f.control.args));
  const prompt = fs.readFileSync(f.control.prompt, 'utf8');
  assert(prompt.includes('RESEARCH_END')); assert(prompt.includes('Mandatory security checklist'));
  assert(prompt.includes('auto_commit')); assert(prompt.includes('deploy')); assert(prompt.includes(f.cwd));
  assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  assert(result.appserver.packaged_context.bytes > 16000);
  assert.strictEqual(result.appserver.packaged_context.budgets.coding_standards, 32);
  await unit.runUnitSidecar(f.r);
  assert.strictEqual(fs.readFileSync(f.control.calls, 'utf8'), 'spawn\n');
  write(path.join(f.cwd, 'src.js'), 'later change');
  await rejects(f.r, 'execution-replay-code-changed');
  assert.strictEqual(fs.readFileSync(f.control.calls, 'utf8'), 'spawn\n');
  for (const [change, code] of [
    [{ planFile: path.join(f.owner, 'elsewhere.md') }, 'execution-plan-path-mismatch'],
    [{ gates: { plan: 'approved', security: 'passed', claim: 'blocked' } }, 'execution-gates-required'],
    [{ constraints: { auto_commit: false, deploy: true } }, 'execution-constraints-required'],
    [{ contextFile: path.join(f.owner, '.gsd/CODING-STANDARDS.md') }, 'execution-path-outside-scope'],
  ]) {
    const q = setup(); await rejects({ ...q.r, ...change }, code); assert(!fs.existsSync(q.control.calls));
  }
  const bad = setup(); write(bad.r.planFile, fs.readFileSync(bad.r.planFile, 'utf8').replace(/src.js/g, '../outside.js'));
  await rejects(bad.r, 'execution-claim-invalid'); assert(!fs.existsSync(bad.control.calls));
  const failed = setup(); failed.control.failure = true; write(failed.controlFile, failed.control);
  await assert.rejects(() => unit.runUnitSidecar(failed.r));
  const failure = JSON.parse(fs.readFileSync(failed.r.resultFile));
  assert.strictEqual(failure.reconciliation_required, true); assert(fs.existsSync(failure.reset_state_file));
  assert.strictEqual(fs.readFileSync(path.join(failed.cwd, 'src.js'), 'utf8'), 'after\n');
  await assert.rejects(() => unit.runUnitSidecar(failed.r));
  assert.strictEqual(fs.readFileSync(failed.control.calls, 'utf8'), 'spawn\n');
  const outside = setup(); outside.control.writes[path.join(outside.cwd, 'dirty.txt')] = 'invalid edit'; write(outside.controlFile, outside.control);
  await rejects(outside.r, 'execution-outside-claim');
  const protectedCase = setup(); protectedCase.control.writes[path.join(protectedCase.task, `${id}-RESEARCH.md`)] = 'tampered'; write(protectedCase.controlFile, protectedCase.control);
  await rejects(protectedCase.r, 'execution-protected-metadata');
  const noModel = setup(); noModel.r.route.model = null; noModel.r.route.model_resolved = null;
  await rejects(noModel.r, 'route-model-identity-mismatch'); assert(!fs.existsSync(noModel.control.calls));
  const noGate = setup(); write(path.join(noGate.task, `${id}-PLAN-GATE.md`), 'status: rejected');
  await rejects(noGate.r, 'execution-plan-gate-required'); assert(!fs.existsSync(noGate.control.calls));
  const staleGate = setup(); write(path.join(staleGate.task, `${id}-PLAN-GATE.md`), 'status: approved\nplan_sha256: ' + '0'.repeat(64));
  await rejects(staleGate.r, 'execution-plan-gate-stale');
  const artifact = setup(); artifact.control.extraArtifact = true; write(artifact.controlFile, artifact.control);
  await rejects(artifact.r, 'claude-invalid-result');
  const pub = setup(), build = delivery.buildDelivery;
  delivery.buildDelivery = () => { throw Object.assign(new Error('simulated delivery failure'), { code: 'fixture-publication' }); };
  try { await rejects(pub.r, 'fixture-publication'); } finally { delivery.buildDelivery = build; }
  assert.strictEqual(JSON.parse(fs.readFileSync(pub.r.resultFile + '.receipt.json')).phase, 'executed');
  await unit.runUnitSidecar(pub.r); await unit.runUnitSidecar(pub.r);
  assert.strictEqual(fs.readFileSync(pub.control.calls, 'utf8'), 'spawn\n');
  const conflict = setup();
  await unit.runUnitSidecar(conflict.r);
  const summary = path.join(conflict.task, `${id}-SUMMARY.md`);
  write(summary, 'concurrent owner edit');
  await rejects(conflict.r, 'artifact-conflict');
  assert.strictEqual(fs.readFileSync(summary, 'utf8'), 'concurrent owner edit');
  assert.strictEqual(fs.readFileSync(conflict.control.calls, 'utf8'), 'spawn\n');
  const partial = setup(); partial.control.status = 'partial'; write(partial.controlFile, partial.control);
  assert.strictEqual((await unit.runUnitSidecar(partial.r)).status, 'partial');
  assert(!fs.existsSync(path.join(partial.task, `${id}-SUMMARY.md`)));
  // Exercise the distribution procedure in owned temporary homes, never the
  // operator installation. The same request then runs through installed code.
  const installedRoot = path.join(root, 'installed');
  const forgeHome = path.join(installedRoot, 'forge'), codexHome = path.join(installedRoot, 'codex');
  const report = require('./forge-installer').install({ repo: path.resolve(__dirname, '..'), runtime: 'both',
    forgeHome, codexHome, claudeHome: path.join(installedRoot, 'claude'), projectRoot: path.join(installedRoot, 'project'),
    userHome: installedRoot, noModelProbe: true, skipCapabilityCheck: true,
    env: { ...process.env, HOME: installedRoot, USERPROFILE: installedRoot } });
  assert.strictEqual(report.ok, true);
  const installedSkill = fs.readFileSync(path.join(codexHome, 'skills/forge-task/SKILL.md'), 'utf8');
  assert(installedSkill.includes('--scope standalone-task --phase execute'));
  assert(installedSkill.includes('**Branch Claude — sidecar'));
  assert(installedSkill.includes('--host-runtime codex'));
  assert(fs.existsSync(path.join(forgeHome, 'scripts/forge-task-execution.js')));
  require(path.join(forgeHome, 'scripts/forge-accounts.js')).resolveLaunch = accounts.resolveLaunch;
  const installedUnit = require(path.join(forgeHome, 'scripts/forge-unit-sidecar.js'));
  const installedCase = setup();
  assert.strictEqual((await installedUnit.runUnitSidecar(installedCase.r)).status, 'done');
  await installedUnit.runUnitSidecar(installedCase.r);
  assert.strictEqual(fs.readFileSync(installedCase.control.calls, 'utf8'), 'spawn\n');
  if (cp.spawnSync('svnadmin', ['--version', '--quiet'], { windowsHide: true }).status === 0) {
    const svnCase = setup('svn');
    const svnResult = await unit.runUnitSidecar(svnCase.r);
    assert.strictEqual(svnResult.vcs, 'svn'); assert.strictEqual(svnResult.status, 'done');
    assert.deepStrictEqual(svnResult.files_changed.map(x => x.path), ['src.js']);
    await unit.runUnitSidecar(svnCase.r);
    assert.strictEqual(fs.readFileSync(svnCase.control.calls, 'utf8'), 'spawn\n');
    console.log('standalone execute: local SVN external CODE_DIR and replay passed');
  } else console.log('standalone execute: SVN fixture skipped (svnadmin unavailable)');
  console.log('standalone execute: resolver, simulated Claude CLI, external CODE_DIR, guards, delivery and replay passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  accounts.resolveLaunch = originalLookup;
  for (const key of ['FORGE_HOME', 'FORGE_XLLM_CLAUDE_BIN', 'TEMP', 'TMP', 'TMPDIR', 'GIT_CEILING_DIRECTORIES']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  // Only this test's own validated child directory is removed.
  assert(path.dirname(root) === base); fs.rmSync(root, { recursive: true, force: true });
});
