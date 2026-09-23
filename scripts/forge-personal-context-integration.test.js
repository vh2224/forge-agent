'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { fixture } = require('./forge-personal-context.test');
const personal = require('./forge-personal-context');
const helpers = require('./forge-cli-helpers');
const status = require('./forge-status');
const runs = require('./forge-runs');
const instructions = require('./forge-instructions');
const renderer = require('./forge-codex-renderer');
const boundary = require('./forge-context-boundary');

const f = fixture();
function command(binary, args, extra = {}) {
  return spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, env: f.env(), cwd: f.project, ...extra });
}
function cli(script, args, userHome = f.home) {
  const result = command(process.execPath, [path.join(__dirname, script), ...args], { env: { ...f.env(userHome), CLAUDE_SESSION_ID: `new-session-${Math.random()}`, FORGE_ACCOUNT: 'different-llm-account' } });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
try {
  const own = f.work('TASK-001'); f.work('TASK-002'); f.work('M001', 'milestone');
  fs.writeFileSync(path.join(f.project, 'KNOWLEDGE.md'), 'Shared technical convention: use canonical projections.');
  fs.writeFileSync(path.join(f.project, '.gsd', 'STATE.md'), 'Historical team pointer: TASK-002');
  f.bind('TASK-001'); f.bind('TASK-002', { userHome: f.otherHome });
  const runFile = path.join(f.project, '.gsd', 'forge', 'runs', 'TASK-002.json');
  const originalRead = fs.readFileSync;
  const forbiddenReads = [];
  fs.readFileSync = function (file) {
    const value = String(file);
    if (value.includes('TASK-002') || value.endsWith(`${path.sep}STATE.md`) || value.startsWith(f.otherHome)) {
      forbiddenReads.push(value);
      throw new Error(`peer read forbidden: ${value}`);
    }
    return originalRead.apply(this, arguments);
  };
  try {
    assert.deepStrictEqual(personal.readPersonalSnapshot(f.options).works.map(w => w.id), ['TASK-001']);
    assert.strictEqual(status.collect(f.project, f.options).works[0].id, 'TASK-001');
    assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).run_id, 'TASK-001');
    assert.strictEqual(personal.selectPersonalWork(f.options).selected.id, 'TASK-001');
    assert(fs.readFileSync(path.join(f.project, 'KNOWLEDGE.md'), 'utf8').includes('Shared technical'));
    const emptyHome = path.join(f.root, 'empty');
    assert.strictEqual(status.collect(f.project, { userHome: emptyHome }).reason, 'no-bindings');
    assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', { userHome: emptyHome }).status, 'none');
    assert(!fs.existsSync(emptyHome));
    assert.deepStrictEqual(forbiddenReads, [], 'even caught peer reads violate isolation');
  } finally { fs.readFileSync = originalRead; }
  assert.strictEqual(runs.listAllDetailed(f.project).parsed.length, 3, 'global census still includes all records');
  assert(status.collect(f.project, { scope: 'workspace' }).autonomous_tasks.some(w => w.id === 'TASK-002'));
  assert.strictEqual(cli('forge-personal-context.js', ['--snapshot', '--cwd', f.project]).works[0].id, 'TASK-001');
  assert.strictEqual(cli('forge-status.js', ['--json', '--cwd', f.project], f.otherHome).works[0].id, 'TASK-002');
  assert.strictEqual(cli('forge-cli-helpers.js', ['--resolve-args', '--cwd', f.project]).run_id, 'TASK-001');
  const bytes = fs.readFileSync(path.join(f.home, '.forge-personal', 'context.json'));
  assert.strictEqual(cli('forge-status.js', ['TASK-002', '--json', '--cwd', f.project]).scope, 'inspection');
  assert.deepStrictEqual(fs.readFileSync(path.join(f.home, '.forge-personal', 'context.json')), bytes);
  // A milestone is bindable before any runtime registration.
  fs.unlinkSync(path.join(f.project, '.gsd', 'forge', 'runs', 'M001.json'));
  f.bind('M001');
  assert.strictEqual(personal.readPersonalSnapshot(f.options).works.find(w => w.id === 'M001').nextAction.text, 'Plan slice');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).status, 'refuse');
  const handoff = path.join(own.dir, 'continue.md'); fs.writeFileSync(handoff, 'UAT environment pending; plan already accepted.');
  personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
    pending: [{ text: 'UAT waiting', source: handoff }], nextAction: [{ text: 'Wait for environment', source: handoff }],
    acceptances: [{ text: 'Plan accepted', source: handoff, resolved: true }],
  } });
  const measured = { appserver: { context_health: { version: 2, host_runtime: 'codex', source: 'codex-app-server', capability: true,
    timestamp: Date.now(), remaining_percentage: 0.38, scope: 'sidecar-thread', measurement: 'measured', session_id: 'fixture', epoch: '2' },
    context_boundary: { indicator: 'ctx checkpoint', severity: 'checkpoint', checkpoint: true } } };
  const result = boundary.consume(measured, f.project, own.source, { userHome: f.home, run: 'TASK-001', task: 'TASK-001' });
  assert.strictEqual(result.personal_checkpoint.status, 'ok');
  const after = cli('forge-personal-context.js', ['--snapshot', '--cwd', f.project]).works.find(w => w.id === 'TASK-001');
  assert.strictEqual(after.nextAction.text, 'Wait for environment');
  assert.strictEqual(after.checkpoint.acceptances[0].text, 'Plan accepted');
  const rendered = status.renderTree(status.collect(f.project, f.options));
  assert(rendered.includes('Aceite registrado'));
  assert.strictEqual(rendered.split('Wait for environment').length - 1, 1, 'next action is not duplicated');
  assert(!rendered.includes(after.checkpoint.acceptances[0].hash), 'full hash remains in JSON, not the human view');
  assert.strictEqual(fs.readFileSync(handoff, 'utf8'), 'UAT environment pending; plan already accepted.');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).status, 'activate-new', 'sole personal milestone without registry must register');
  // Execute each skill's actual bootstrap/bind block against a fresh milestone.
  for (const [index, name] of ['forge-auto', 'forge-next'].entries()) {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const firstBlock = skill.match(/```bash\n([\s\S]*?)```/)[1];
    const block = firstBlock.slice(firstBlock.indexOf('# Route task IDs'));
    const id = `M00${index + 7}`;
    const bootstrap = command(process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash', ['-c', block], { env: { ...f.env(), RUN_KIND: 'milestone', STATUS: 'activate-new', RUN_ID: id,
      WORKING_DIR: f.project.replace(/\\/g, '/'), FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), PERSONAL_ARG: id } });
    assert.strictEqual(bootstrap.status, 0, bootstrap.stdout + bootstrap.stderr);
    assert(fs.existsSync(path.join(f.project, '.gsd', 'milestones', id, `${id}-STATE.md`)));
    assert(personal.readPersonalSnapshot(f.options).works.some(w => w.id === id));
    assert(firstBlock.indexOf('--create') < firstBlock.indexOf('--bind'), 'bootstrap precedes binding');
    assert(firstBlock.includes('exit 1'), 'failed bootstrap cannot dispatch');
    const failedId = `M01${index + 7}`;
    const fail = command(process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash', ['-c', block + '\necho UNREACHABLE'], {
      env: { ...f.env(), RUN_KIND: 'milestone', STATUS: 'activate-new', RUN_ID: failedId, WORKING_DIR: f.project.replace(/\\/g, '/'),
        FORGE_SCRIPTS_DIR: f.root.replace(/\\/g, '/'), PERSONAL_ARG: failedId },
    });
    assert.strictEqual(fail.status, 1, fail.stdout + fail.stderr);
    assert(!fail.stdout.includes('UNREACHABLE'), 'bootstrap error terminates executable block');
    assert(!personal.readPersonalSnapshot(f.options).works.some(w => w.id === failedId));
    if (name === 'forge-auto') {
      const update = skill.split('\n').find(line => line.includes('forge-runs.js" --update') && line.includes('SESSION_ID'));
      const missing = command(process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe') : 'bash', ['-c', update + '\necho UNREACHABLE'], {
        env: { ...f.env(), RUN_ID: 'M999', SESSION_ID: 'fixture', WORKING_DIR: f.project.replace(/\\/g, '/'),
          FORGE_SCRIPTS_DIR: __dirname.replace(/\\/g, '/'), ISOLATION_MODE: 'shared', WORKTREES_JSON: '[]', RUN_BRANCH: '' },
      });
      assert.strictEqual(missing.status, 1, missing.stdout + missing.stderr);
      assert(!missing.stdout.includes('UNREACHABLE'), 'missing registry update stops dispatch');
    }

  }
  // Partial creation exposes the failed second write, preserving the run.
  f.work('TASK-003');
  const corruptHome = path.join(f.root, 'corrupt-home'); fs.mkdirSync(path.join(corruptHome, '.forge-personal'), { recursive: true });
  fs.writeFileSync(path.join(corruptHome, '.forge-personal', 'context.json'), '{broken');
  const partial = helpers.activateRun(f.project, { userHome: corruptHome, id: 'TASK-003', kind: 'task', session_id: 'fixture', intent: 'create' });
  assert.strictEqual(partial.status, 'partial'); assert(partial.message.includes('explicit-resume'));
  assert(runs.get(f.project, 'TASK-003'));
  // Real Git checkout/nested/worktree alias, all entirely in the fixture root.
  for (const args of [['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const git = command('git', args); assert.strictEqual(git.status, 0, git.stderr);
  }
  const wt = path.join(f.root, 'worktree');
  assert.strictEqual(command('git', ['worktree', 'add', '-b', 'fixture-personal', wt]).status, 0);
  const ownRecord = path.join(f.project, '.gsd', 'forge', 'runs', 'TASK-001.json');
  const record = JSON.parse(fs.readFileSync(ownRecord, 'utf8'));
  Object.assign(record, { branch: 'fixture-personal', worktrees: [{ repo: f.project, path: wt }] });
  fs.writeFileSync(ownRecord, JSON.stringify(record)); f.bind('TASK-001', { intent: 'explicit-resume' });
  fs.mkdirSync(path.join(wt, 'nested')); fs.mkdirSync(path.join(f.project, 'nested'));
  for (const cwd of [f.project, path.join(f.project, 'nested'), wt, path.join(wt, 'nested')]) {
    const snapshot = cli('forge-personal-context.js', ['--snapshot', '--cwd', cwd]);
    assert.strictEqual(snapshot.project.toLowerCase(), fs.realpathSync(f.project).toLowerCase());
    assert(snapshot.works.some(w => w.id === 'TASK-001'));
  }
  // Same URL, separate real SVN working copies: identity must stay path-based.
  const probe = command('svnadmin', ['--version', '--quiet']);
  if (probe.status === 0 && command('svn', ['--version', '--quiet']).status === 0) {
    const repository = path.join(f.root, 'svn-repository');
    assert.strictEqual(command('svnadmin', ['create', repository]).status, 0);
    const copies = ['svn-a', 'svn-b'].map(name => path.join(f.root, name));
    for (const copy of copies) {
      assert.strictEqual(command('svn', ['checkout', pathToFileURL(repository).href, copy]).status, 0);
      const dir = path.join(copy, '.gsd', 'tasks', 'TASK-010'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'TASK-010-PLAN.md'), '---\nstatus: RUNNING\n---\n');
    }
    assert.strictEqual(personal.bindWork({ ...f.options, project: copies[0], id: 'TASK-010', intent: 'create' }).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot({ ...f.options, project: copies[1] }).reason, 'no-bindings');
    console.log('PASS real SVN: isolated working copies of same repository remain distinct');
  } else console.log('SKIP real SVN addressing: svn/svnadmin unavailable; static SVN layout covered');
  // Distribution: actual managed sync preserves external CRLF bytes for both hosts.
  const target = path.join(f.root, 'consumer'); fs.mkdirSync(target);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) fs.writeFileSync(path.join(target, name), 'External instructions\r\n');
  instructions.syncInstructions(target, { host: 'both' });
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const content = fs.readFileSync(path.join(target, name), 'utf8');
    assert(content.startsWith('External instructions\r\n'));
    assert(content.includes('forge-personal-context.js')); assert(content.includes('--snapshot'));
  }
  const projection = renderer.render({ ...renderer.PRODUCTION_DISPATCH_DIALECT, repo: path.resolve(__dirname, '..'), userHome: f.home, forgeHome: f.options.env.FORGE_HOME, codexHome: path.join(f.home, '.codex'), projectRoot: target });
  assert(projection.artifacts.find(a => a.kind === 'instructions').content.includes(instructions.renderPersonalContract()));
  for (const name of ['forge-task', 'forge-new-milestone', 'forge-auto', 'forge-next', 'forge-status']) {
    assert(projection.artifacts.find(a => a.source === `skills/${name}/SKILL.md`).content.includes('forge-personal-context'));
  }
  assert(fs.existsSync(runFile));
  console.log('PASS public flow: no peer reads, two profiles, new processes, explicit inspection, inactive UAT, partial binding, Git aliases, distribution');
} finally { f.cleanup(); }
