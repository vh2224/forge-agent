'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
function createFixtureHarness() {
function stageProcedures(destination) {
  const source = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
  fs.mkdirSync(path.join(destination, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(source, 'shared/forge-procedures.json'), path.join(destination, 'shared/forge-procedures.json'));
  for (const module of manifest.modules.filter(item => item.status === 'ready')) fs.copyFileSync(path.join(source, module.path), path.join(destination, module.path));
}

const cp = require('child_process');
const crypto = require('crypto');
const base = path.join(require('os').tmpdir(), 'forge-standalone-execute-labs');
fs.mkdirSync(base, { recursive: true });
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'test-')));
const fixtureMarker = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(root, '.fixture-owner'), fixtureMarker);
const saved = { ...process.env };
process.env.TEMP = root; process.env.TMP = root; process.env.TMPDIR = root;
process.env.GIT_CEILING_DIRECTORIES = root;
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
process.env.FORGE_HOME = path.join(root, 'home');
write(path.join(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc'), {});
stageProcedures(process.env.FORGE_HOME);
const accounts = require('../forge-accounts');
const originalLookup = accounts.resolveLaunch;
accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-only' });
const { resolveDispatch } = require('../forge-dispatch-resolve');
const provider = path.join(root, 'provider.js');
write(provider, `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), control = JSON.parse(fs.readFileSync(path.join(process.cwd(), '../control.json')));
fs.appendFileSync(control.calls, 'spawn\\n');
fs.writeFileSync(control.args, JSON.stringify(args));
const instruction = args.find(a => a.startsWith('Read the complete task prompt'));
fs.writeFileSync(control.prompt, fs.readFileSync(JSON.parse(instruction.match(/file: (".*")\\. Follow/)[1]), 'utf8'));
for (const [file, content] of Object.entries(control.writes || {})) fs.writeFileSync(file, content);
for (const file of control.deletes || []) fs.unlinkSync(file);
if (control.failure) { process.stderr.write('simulated transport failure after writes'); process.exit(9); }
const result = { status: control.status || 'done', summary: 'Fixture execution', must_haves_status: [], files_changed: [] };
if (control.extraArtifact) result.artifacts = [{ path: '../outside.md', content: 'invalid' }];
const model = args[args.indexOf('--model') + 1];
// Like the real CLI (S05/T01 measurement): system/init confirms a persisted --session-id.
const sessionAt = args.indexOf('--session-id');
if (sessionAt >= 0) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: args[sessionAt + 1] }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: result,
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
  return setupFixture(vcsName, true);
}
function setupFixture(vcsName, resolveInitialRoute) {
  const dir = path.join(root, String(++sequence)), cwd = path.join(dir, 'code'), owner = path.join(dir, 'owner');
  fs.mkdirSync(cwd, { recursive: true });
  const task = path.join(owner, '.gsd/tasks', id), planFile = path.join(task, `${id}-PLAN.md`);
  write(path.join(owner, '.gsd/forge-prefs.jsonc'), { routing: { frontend: { executor: { heavy: ['claude-opus-5-5', 'gpt-6.1-sol'] } } }, effort: { 'execute-task': 'high' }, token_budget: { coding_standards: 32 } });
  write(planFile, `---\ntier: heavy\ndomain: frontend\ncapability: workspace\ndepends: []\nwrites:\n  - 'src.js'\nmust_haves:\n  truths:\n    - "fixture stays observable"\n  artifacts: []\n  key_links: []\nexpected_output: [src.js]\n---\n# Task\nImplement fixture.\n`);
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
    // Copy a private baseline, never share writable Git objects between cases.
    const template = path.join(root, 'git-template');
    if (!fs.existsSync(template)) {
      fs.mkdirSync(template);
      write(path.join(template, 'src.js'), 'before\n'); write(path.join(template, 'dirty.txt'), 'before\n');
      git(template, ['init', '-q']); git(template, ['config', 'core.autocrlf', 'false']); git(template, ['add', '.']);
      git(template, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
    }
    // Use Node's per-entry traversal for this tiny private tree. The native bulk
    // copy has failed with ENOENT on macOS (#264); include every entry and let
    // real filesystem errors propagate without a retry or partial-success path.
    fs.cpSync(template, cwd, { recursive: true, filter: () => true });
    git(cwd, ['update-index', '-q', '--refresh']);
  }
  write(path.join(cwd, 'dirty.txt'), 'user dirty\n');
  const route = resolveInitialRoute ? resolveDispatch({ cwd: owner, unitType: 'execute-task', scope: 'standalone-task', phase: 'execute', planPath: planFile, hostRuntime: 'codex', unitId: id }) : null;
  const r = { cwd, contextRoot: owner, scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: id,
    planFile, route, workflowId: id, dispatchId: `attempt-${sequence}`, resultFile: path.join(dir, 'result.json'),
    gates: { plan: 'approved', security: 'passed', claim: 'proceed' }, constraints: { auto_commit: false, deploy: false } };
  const control = { calls: path.join(dir, 'calls.txt'), args: path.join(dir, 'args.json'), prompt: path.join(dir, 'prompt.txt'), writes: { [path.join(cwd, 'src.js')]: 'after\n' } };
  const controlFile = path.join(dir, 'control.json'); write(controlFile, control);
  return { r, task, dir, control, controlFile, owner, cwd };
}

function close(completed) {
  accounts.resolveLaunch = originalLookup;
  for (const key of ['FORGE_HOME', 'FORGE_XLLM_CLAUDE_BIN', 'TEMP', 'TMP', 'TMPDIR', 'GIT_CEILING_DIRECTORIES']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  // Preserve failures for diagnosis; cleanup only this physical, owned fixture.
  if (!completed) { console.error(`Preserved failed fixture: ${root}`); return; }
  assert(!fs.lstatSync(root).isSymbolicLink());
  assert.strictEqual(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(base));
  assert.strictEqual(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8'), fixtureMarker);
  fs.rmSync(root, { recursive: true, force: true });

}
let latestNative;
function nativeFixture(options = {}) {
  // Native setup replaces the plan and preferences before resolving its route.
  const f = setupFixture('git', false);
  const roots = require('../forge-code-roots');
  const contract = roots.validateContract({ schema_version: 2, owner: f.owner, primary_root_id: 'app', code_roots: [{ id: 'app', path: f.cwd }] });
  let plan = require('../forge-code-roots.test').plan(contract).replaceAll('same.txt', 'src.js')
    .replace('tier: standard', 'tier: heavy\ndomain: frontend').replace('effort: medium', 'effort: high');
  if (options.verify) plan = plan.replace('depends: []', `verify: '${options.verify}'\ndepends: []`);
  write(f.r.planFile, plan);
  write(path.join(f.owner, '.gsd/forge-prefs.jsonc'), { routing: { frontend: { executor: { heavy: options.models || ['gpt-6.1-sol'] } } }, effort: { 'execute-task': 'high' }, token_budget: { coding_standards: 32 } });
  const route = resolveDispatch({ cwd: f.owner, unitType: 'execute-task', scope: 'standalone-task', phase: 'execute', planPath: f.r.planFile, hostRuntime: 'codex', unitId: id });
  assert.strictEqual(route.worker_mode, 'native');
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract, paths: [{ root_id: 'app', path: 'src.js' }] };
  require('../forge-runs').add(f.owner, { id: 'native-run', kind: 'task', session_id: 'fixture', write_claim: claim });
  const caps = { available: true, tool: 'spawn_agent', source: 'portable-host-fixture', models: options.models || ['gpt-6.1-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] };
  Object.assign(f.r, { route, runId: 'native-run', claim, execution_contract: contract,
    ...(options.defaultVerification === false ? {} : { verification: { preferenceCommands: ['node -e "process.exit(0)"'] } }),
    nativePromptFile: path.join(f.dir, 'native-prompt.txt') });
  f.r.nativeInvocation = require('../forge-native-invocation').buildNativeInvocation({ hostRuntime: 'codex', resolvedDispatch: route,
    activeCapabilities: caps, agentType: 'forge-executor', taskName: `native_${sequence}`, forkTurns: 'none', prompt: 'binding preflight' });
  assert(f.r.nativeInvocation.ok);
  let calls = 0;
  const metrics = { readback_calls: 0, reconciliation_calls: 0 };
  const result = () => ({ status: 'done', summary: 'Portable native fixture', must_haves_status: [], files_changed: ['src.js'] });
  const runtime = { activeCapabilities: caps, readback: async () => { metrics.readback_calls++; return {}; }, invokeNative: async args => {
    calls++;
    assert.strictEqual(args.model, route.model_resolved); assert.strictEqual(args.reasoning_effort, 'high'); assert.strictEqual(args.fork_turns, 'none');
    const receipt = JSON.parse(fs.readFileSync(f.r.resultFile + '.receipt.json'));
    assert(receipt.recovery_baseline && receipt.verification_seal); assert.strictEqual(receipt.phase, 'started');
    const prompt = fs.readFileSync(f.r.nativePromptFile, 'utf8');
    assert(prompt.includes('RESEARCH_END') && prompt.includes('Mandatory security checklist'));
    write(path.join(f.cwd, 'src.js'), 'native after\n'); return result();
  } };
  latestNative = { ...f, caps, runtime, result, metrics, calls: () => calls };
  return latestNative;
}
return { nativeFixture, latestNative: () => latestNative, root, base, fixtureMarker, saved, accounts, originalLookup, provider, setup, stageProcedures, write, git, id, close };
}
module.exports = { createFixtureHarness };
