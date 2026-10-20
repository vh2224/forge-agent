#!/usr/bin/env node
'use strict';
// Only the external Claude process/account are simulated. Resolver, CLI adapter,
// VCS safety, delivery validation, publication and replay run production code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const base = path.join(require('os').tmpdir(), 'forge-standalone-execute-labs');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'test-'));
const fixtureMarker = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(root, '.fixture-owner'), fixtureMarker);
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
for (const file of control.deletes || []) fs.unlinkSync(file);
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
    git(cwd, ['init', '-q']); git(cwd, ['config', 'core.autocrlf', 'false']); git(cwd, ['add', '.']);
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
function withFs(overrides, run) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]));
  Object.assign(fs, overrides);
  try { return run(); } finally { Object.assign(fs, originals); }
}
function snapshotRegressions() {
  const lab = path.join(root, 'protected-snapshots');
  fs.mkdirSync(lab);
  function owner(name) { const dir = path.join(lab, name); fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true }); return dir; }
  function payload(file, size) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buffer = Buffer.alloc(1024 * 1024, 0x61), digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'w');
    try {
      while (size > 0) {
        const bytes = buffer.subarray(0, Math.min(buffer.length, size));
        assert.strictEqual(fs.writeSync(fd, bytes), bytes.length);
        digest.update(bytes); size -= bytes.length;
      }
    } finally { fs.closeSync(fd); }
    return digest.digest('hex');
  }
  const large = owner('large'), archive = path.join(large, '.gsd/archive/large.bin');
  const expected = payload(archive, 64 * 1024 * 1024 + 17);
  const originalRead = fs.readSync;
  let largestRead = 0, reads = 0;
  const snapshot = withFs({
    readFileSync() { assert.fail('protected census must never buffer an entire file'); },
    readSync(fd, buffer, offset, length, position) {
      assert(buffer.length <= 64 * 1024); assert(length <= buffer.length);
      largestRead = Math.max(largestRead, length); reads++;
      return originalRead(fd, buffer, offset, length, position);
    },
  }, () => execution.protectedSnapshot(large));
  assert.deepStrictEqual(snapshot, { '.gsd/': 'directory', '.gsd/archive/': 'directory', '.gsd/archive/large.bin': expected });
  assert.strictEqual(largestRead, 64 * 1024); assert(reads > 1024);
  // Mutate beyond the old 64 MiB cutoff: archives are still fully protected.
  const fd = fs.openSync(archive, 'r+');
  try { fs.writeSync(fd, Buffer.from('!'), 0, 1, 64 * 1024 * 1024 + 16); }
  finally { fs.closeSync(fd); }
  assert.throws(() => execution.assertProtected(large, snapshot), /execution-protected-metadata/);
  const aggregate = owner('aggregate'), expectedFiles = { '.gsd/': 'directory', '.gsd/archive/': 'directory' };
  for (const name of ['a.bin', 'b.bin', 'c.bin']) {
    expectedFiles[`.gsd/archive/${name}`] = payload(path.join(aggregate, '.gsd/archive', name), 24 * 1024 * 1024);
  }
  assert.deepStrictEqual(execution.protectedSnapshot(aggregate), expectedFiles);
  const small = owner('changes'), file = path.join(small, '.gsd/file.md');
  write(file, 'before'); const before = execution.protectedSnapshot(small);
  write(file, 'after'); assert.throws(() => execution.assertProtected(small, before), /execution-protected-metadata/);
  write(file, 'before'); write(path.join(small, '.gsd/added.md'), 'added');
  assert.throws(() => execution.assertProtected(small, before), /execution-protected-metadata/);
  fs.unlinkSync(path.join(small, '.gsd/added.md')); fs.unlinkSync(file);
  assert.throws(() => execution.assertProtected(small, before), /execution-protected-metadata/);
  write(file, 'before');
  const events = path.join(small, '.gsd/forge/events.jsonl');
  write(events, 'first\n'); assert.throws(() => execution.assertProtected(small, before), /protected-metadata/);
  const eventsBefore = execution.protectedSnapshot(small);
  fs.appendFileSync(events, 'second\n'); assert.throws(() => execution.assertProtected(small, eventsBefore), /protected-metadata/);
  fs.unlinkSync(events); assert.throws(() => execution.assertProtected(small, eventsBefore), /protected-metadata/);
  // Event content/creation/removal are protected during the census;
  // replacement with a link or directory must still fail closed.
  for (const mode of ['create', 'remove', 'directory', 'link', 'create-directory', 'create-link']) {
    const dir = owner(`concurrent-event-${mode}`), eventFile = path.join(dir, '.gsd/forge/events.jsonl');
    fs.mkdirSync(path.dirname(eventFile));
    if (!mode.startsWith('create')) write(eventFile, 'old event');
    write(path.join(dir, '.gsd/z.md'), 'trigger');
    let changed = false;
    withFs({ readSync(...args) {
      const count = originalRead(...args);
      if (!changed) {
        changed = true;
        if (mode === 'create') write(eventFile, 'new event');
        else {
          if (!mode.startsWith('create')) fs.unlinkSync(eventFile);
          if (mode.endsWith('directory')) fs.mkdirSync(eventFile);
          if (mode.endsWith('link')) fs.symlinkSync(dir, eventFile, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }
      return count;
    } }, () => {
      if (mode.endsWith('link')) assert.throws(() => execution.protectedSnapshot(dir), /execution-path-link|execution-protected-snapshot-unstable/);
      else if (mode.endsWith('directory')) assert.throws(() => execution.protectedSnapshot(dir), /execution-protected-snapshot-unstable/);
      else assert.throws(() => execution.protectedSnapshot(dir), /execution-protected-snapshot-unstable/);
    });
    assert(changed);
  }
  assert.deepStrictEqual(execution.protectedSnapshot(path.join(lab, 'no-gsd')), {});
  const cases = [
    ['same-size-rewrite', ({ first }) => {
      const stat = fs.statSync(first); fs.writeFileSync(first, 'changed'); fs.utimesSync(first, stat.atime, stat.mtime);
    }],
    ['append', ({ first }) => fs.appendFileSync(first, 'growth')],
    ['truncate', ({ first }) => fs.truncateSync(first, 0)],
    ['replace-during-read', ({ first, dir }) => { fs.renameSync(first, path.join(dir, 'saved')); write(first, 'initial'); }],
    ['delete-during-read', ({ first }) => fs.unlinkSync(first)],
    ['late-rewrite', ({ first }) => write(first, 'changed'), true],
    ['late-rewrite-coarse-timestamps', ({ first }) => write(first, 'changed'), true],
    ['late-addition', ({ first }) => write(path.join(path.dirname(first), 'added.md'), 'new'), true],
    ['late-deletion', ({ first }) => fs.unlinkSync(first), true],
    ['late-directory-replacement', ({ first, dir }) => {
      fs.renameSync(path.dirname(first), path.join(dir, 'saved-dir')); write(first, 'initial');
    }, true],
  ];
  for (const [name, mutate, late] of cases) {
    const dir = owner(name), first = path.join(dir, '.gsd/a/first.md'), last = path.join(dir, '.gsd/z.md');
    write(first, 'initial'); write(last, 'last');
    const opened = new Map(), open = fs.openSync, close = fs.closeSync;
    const lstat = fs.lstatSync, fstat = fs.fstatSync;
    const coarse = stat => name === 'late-rewrite-coarse-timestamps'
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mtimeNs: 0n, ctimeNs: 0n }) : stat;
    let changed = false;
    withFs({
      lstatSync(...args) { return coarse(lstat(...args)); },
      fstatSync(...args) { return coarse(fstat(...args)); },
      openSync(...args) { const descriptor = open(...args); opened.set(descriptor, args[0]); return descriptor; },
      closeSync(descriptor) { try { return close(descriptor); } finally { opened.delete(descriptor); } },
      readSync(...args) {
        const count = originalRead(...args);
        if (!changed && opened.get(args[0]) === (late ? last : first)) { changed = true; mutate({ first, dir }); }
        return count;
      },
    }, () => assert.throws(() => execution.protectedSnapshot(dir), /execution-protected-snapshot-unstable/, name));
    assert(changed, name); assert.strictEqual(opened.size, 0, `${name}: leaked descriptor`);
  }
  for (const name of ['replace-before-open', 'read-error', 'early-eof']) {
    const dir = owner(name), target = path.join(dir, '.gsd/target'); write(target, 'initial');
    const open = fs.openSync, close = fs.closeSync;
    const opened = new Set();
    let replaced = false, attemptedReads = 0;
    withFs({
      openSync(...args) {
        if (name === 'replace-before-open' && !replaced && args[0] === target) {
          replaced = true; fs.renameSync(target, path.join(dir, 'saved')); write(target, 'initial');
        }
        const descriptor = open(...args); opened.add(descriptor); return descriptor;
      },
      closeSync(value) { try { return close(value); } finally { opened.delete(value); } },
      readSync() { attemptedReads++; if (name === 'read-error') throw new Error('fixture-read-error'); return 0; },
    }, () => assert.throws(() => execution.protectedSnapshot(dir), name === 'read-error' ? /fixture-read-error/ : /execution-protected-snapshot-unstable/));
    assert.strictEqual(opened.size, 0, `${name}: leaked descriptor`);
    if (name === 'replace-before-open') assert.strictEqual(attemptedReads, 0, 'reject replacement before reading it');
  }
  for (const name of ['directory-link', 'dangling-link', 'root-link']) {
    const dir = owner(name), outside = path.join(dir, 'outside');
    if (name !== 'dangling-link') fs.mkdirSync(outside);
    const link = name === 'root-link' ? path.join(dir, '.gsd') : path.join(dir, '.gsd/linked');
    if (name === 'root-link') fs.rmdirSync(link);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => execution.protectedSnapshot(dir), /execution-path-link/, name);
  }
  const unsafe = owner('unsafe-type'), unsafeFile = path.join(unsafe, '.gsd/file'); write(unsafeFile, 'data');
  const lstat = fs.lstatSync;
  withFs({ lstatSync(...args) {
    const stat = lstat(...args);
    if (args[0] === unsafeFile) { stat.isFile = () => false; stat.isDirectory = () => false; }
    return stat;
  } }, () => assert.throws(() => execution.protectedSnapshot(unsafe), /execution-protected-file-type/));
  const limit = owner('entry-limit');
  // Real empty files keep this boundary test independent of census internals.
  for (let i = 0; i < 19999; i++) fs.writeFileSync(path.join(limit, '.gsd', String(i)), '');
  assert.strictEqual(Object.keys(execution.protectedSnapshot(limit)).length, 20000);
  write(path.join(limit, '.gsd/overflow'), '');
  assert.throws(() => execution.protectedSnapshot(limit), /execution-protected-snapshot-limit/);
  console.log('protected snapshot: >64 MiB file, 72 MiB aggregate, bounded reads, mutations, races, descriptor cleanup, links/types and 20000-entry limit passed');
}
async function main() {
  // Production milestone -> xllm -> Claude adapter contract, with only inference
  // substituted by the local process fixture above.
  const multi = setup(), second = path.join(multi.dir, 'second');
  fs.mkdirSync(second);
  git(second, ['init', '-q']);
  for (const cwd of [multi.cwd, second]) {
    write(path.join(cwd, 'same.txt'), 'before\n');
    git(cwd, ['add', 'same.txt']);
    git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'multi baseline']);
  }
  const contract = require('./forge-code-roots').validateContract({ schema_version: 2, owner: multi.owner,
    primary_root_id: 'alpha', code_roots: [{ id: 'alpha', path: multi.cwd }, { id: 'beta', path: second }] });
  const planFile = path.join(multi.owner, '.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md');
  write(planFile, require('./forge-code-roots.test').plan(contract));
  write(path.join(path.dirname(path.dirname(path.dirname(planFile))), 'S01-PLAN.md'), '# Slice fixture\n');
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract,
    paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
  require('./forge-runs').add(multi.owner, { id: 'multi-run', kind: 'milestone', session_id: 'fixture', write_claim: claim });
  const request = { ...multi.r, scope: 'milestone', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    runId: 'multi-run', claim, execution_contract: contract, planFile,
    gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' },
    verification: { preferenceCommands: ['node -e "require(\'fs\').accessSync(\'same.txt\')"'] } };
  multi.control.writes = { [path.join(multi.cwd, 'same.txt')]: 'alpha after\n', [path.join(second, 'same.txt')]: 'beta after\n' };
  write(multi.controlFile, multi.control);
  const multiResult = await unit.runUnitSidecar(request);
  assert.deepStrictEqual(multiResult.files_changed.map(row => row.root_id).sort(), ['alpha', 'beta']);
  const multiReceipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
  assert.strictEqual(multiReceipt.final_evidence.stage, 'returned');
  assert.strictEqual(multiReceipt.final_evidence.provider_called, true);
  assert(Number.isFinite(multiReceipt.final_evidence.duration_ms));
  assert.strictEqual(multiReceipt.final_evidence.model_observed, 'claude-opus-5-5');
  assert.strictEqual(fs.readFileSync(multi.control.calls, 'utf8'), 'spawn\n');
  snapshotRegressions();
  assert(capability('claude', 'execute-task', { scope: 'standalone-task', phase: 'execute' }).supported);
  assert(!capability('claude', 'execute-task', { scope: 'standalone-task', phase: 'plan' }).supported);
  for (const change of [{ phase: 'plan' }, { phase: undefined }, { milestoneId: 'M001' }, { sliceId: 'S01' }, { taskId: '../bad' }]) {
    assert.throws(() => unit.locations({ scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: id, ...change }));
  }
  assert.throws(() => unit.locations({ unitType: 'execute-task', taskId: id }), /invalid-milestone/);
  const aliasFixture = setup(), alias = path.join(aliasFixture.dir, 'owner-alias');
  fs.symlinkSync(aliasFixture.owner, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedPlan = path.join(alias, '.gsd/tasks', id, id + '-PLAN.md');
  const preparedAlias = execution.prepare({ ...aliasFixture.r, planFile: aliasedPlan }, fs.realpathSync.native(aliasFixture.owner), aliasFixture.cwd);
  assert(preparedAlias.plan_hash, 'owner aliases preserve plan identity');
  assert.throws(() => execution.prepare({ ...aliasFixture.r, planFile: path.join(alias, 'elsewhere.md') }, aliasFixture.owner, aliasFixture.cwd), /execution-plan-path-mismatch/);
  const taskAlias = path.join(aliasFixture.owner, '.gsd/tasks', id + '-alias');
  fs.symlinkSync(aliasFixture.task, taskAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => execution.prepare({ ...aliasFixture.r, planFile: path.join(taskAlias, id + '-PLAN.md') }, aliasFixture.owner, aliasFixture.cwd), /execution-plan-path-mismatch/);
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
  await rejects(bad.r, 'root-path-invalid'); assert(!fs.existsSync(bad.control.calls));
  const failed = setup(); failed.control.failure = true; write(failed.controlFile, failed.control);
  await assert.rejects(() => unit.runUnitSidecar(failed.r));
  const failure = JSON.parse(fs.readFileSync(failed.r.resultFile));
  assert.strictEqual(failure.reconciliation_required, true); assert(fs.existsSync(failure.reset_state_file));
  assert.strictEqual(fs.readFileSync(path.join(failed.cwd, 'src.js'), 'utf8'), 'after\n');
  await assert.rejects(() => unit.runUnitSidecar(failed.r));
  assert.strictEqual(fs.readFileSync(failed.control.calls, 'utf8'), 'spawn\n');
  assert.strictEqual(require('./forge-surgical-reset').resetFromState(failure.reset_state_file).result.abort, 'reset-provenance-required');
  const reset = require('./forge-surgical-reset').reconcileFailedAttempt(failure.reset_state_file, { failed: true, processStopped: true, verifyOwnership: row => row.path === 'src.js' });
  assert.strictEqual(reset.ok, true, JSON.stringify(reset));
  assert.strictEqual(fs.readFileSync(path.join(failed.cwd, 'src.js'), 'utf8'), 'before\n');
  assert.strictEqual(fs.readFileSync(path.join(failed.cwd, 'dirty.txt'), 'utf8'), 'user dirty\n');
  const outside = setup(); outside.control.writes[path.join(outside.cwd, 'dirty.txt')] = 'invalid edit'; write(outside.controlFile, outside.control);
  await rejects(outside.r, 'execution-outside-claim');
  const overlap = require('./forge-surgical-reset').resetFromState(outside.r.resultFile + '.reset-state.json');
  assert.strictEqual(overlap.result.abort, 'reset-provenance-required', 'unproved ownership must abort reset');
  assert.strictEqual(fs.readFileSync(path.join(outside.cwd, 'src.js'), 'utf8'), 'after\n', 'abort resets nothing');
  const restored = setup(); restored.control.writes[path.join(restored.cwd, 'dirty.txt')] = 'before\n'; write(restored.controlFile, restored.control);
  await rejects(restored.r, 'execution-outside-claim');
  assert(!fs.existsSync(path.join(restored.task, `${id}-SUMMARY.md`)), 'restoring pre-dirty to HEAD must not publish');
  const deletedDirty = setup(); write(path.join(deletedDirty.cwd, 'user-new.txt'), 'user work');
  deletedDirty.control.deletes = [path.join(deletedDirty.cwd, 'user-new.txt')]; write(deletedDirty.controlFile, deletedDirty.control);
  await rejects(deletedDirty.r, 'execution-outside-claim');
  const expectedOutput = setup();
  write(expectedOutput.r.planFile, fs.readFileSync(expectedOutput.r.planFile, 'utf8').replace('expected_output: [src.js]', 'expected_output: [generated.js]'));
  expectedOutput.control.writes[path.join(expectedOutput.cwd, 'generated.js')] = 'generated'; write(expectedOutput.controlFile, expectedOutput.control);
  await rejects(expectedOutput.r, 'execution-output-outside-writes');
  assert(!fs.existsSync(expectedOutput.control.calls));
  const protectedCase = setup(); protectedCase.control.writes[path.join(protectedCase.task, `${id}-RESEARCH.md`)] = 'tampered'; write(protectedCase.controlFile, protectedCase.control);
  await rejects(protectedCase.r, 'execution-protected-metadata');
  const noModel = setup(); noModel.r.route.model = null; noModel.r.route.model_resolved = null;
  await rejects(noModel.r, 'route-model-identity-mismatch'); assert(!fs.existsSync(noModel.control.calls));
  const noGate = setup(); write(path.join(noGate.task, `${id}-PLAN-GATE.md`), 'status: rejected');
  await rejects(noGate.r, 'execution-plan-gate-required'); assert(!fs.existsSync(noGate.control.calls));
  const staleGate = setup(); write(path.join(staleGate.task, `${id}-PLAN-GATE.md`), 'status: approved\nplan_sha256: ' + '0'.repeat(64));
  await rejects(staleGate.r, 'execution-plan-gate-stale');
  const linked = setup();
  fs.mkdirSync(path.join(linked.dir, 'outside'));
  fs.symlinkSync(path.join(linked.dir, 'outside'), path.join(linked.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  write(linked.r.planFile, fs.readFileSync(linked.r.planFile, 'utf8').replace(/src.js/g, 'linked/outside.js'));
  await rejects(linked.r, 'root-path-link'); assert(!fs.existsSync(linked.control.calls));
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
  await rejects(conflict.r, 'execution-protected-metadata');
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
let completed = false;
main().then(() => { completed = true; }).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  accounts.resolveLaunch = originalLookup;
  for (const key of ['FORGE_HOME', 'FORGE_XLLM_CLAUDE_BIN', 'TEMP', 'TMP', 'TMPDIR', 'GIT_CEILING_DIRECTORIES']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  // Preserve failures for diagnosis; cleanup only this physical, owned fixture.
  if (!completed) { console.error(`Preserved failed fixture: ${root}`); return; }
  assert(!fs.lstatSync(root).isSymbolicLink());
  assert.strictEqual(path.dirname(fs.realpathSync(root)), fs.realpathSync(base));
  assert.strictEqual(fs.readFileSync(path.join(root, '.fixture-owner'), 'utf8'), fixtureMarker);
  fs.rmSync(root, { recursive: true, force: true });
});
